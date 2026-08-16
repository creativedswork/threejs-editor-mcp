#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import * as THREE from 'three'
import { z } from 'zod'
import {
  assetMediaTypeSchema,
  assetSummarySchema,
  cameraViewSchema,
  diagnosticsSchema,
  editorLayoutSchema,
  MAX_ASSET_BYTES,
  ProjectStore,
  RevisionConflictError,
  projectSchema,
  type ProjectSummary,
} from './projects.js'

const RESOURCE_URI = 'ui://threejs-editor/app'
const CSP = {
  connectDomains: [] as string[],
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
  baseUriDomains: [] as string[],
}
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const assetDataSchema = z.string()
  .min(4)
  .max(Math.ceil(MAX_ASSET_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const summarySchema = z.object({
  projectId: projectIdSchema,
  title: z.string(),
  revision: revisionSchema,
})
const sceneObjectSchema = z.object({
  name: z.string(),
  type: z.string(),
  visible: z.boolean(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  color: z.string().optional(),
})
const vector3Schema = z.tuple([z.number(), z.number(), z.number()])
const sceneOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('update_object'),
    target: z.string().min(1).max(120),
    name: z.string().min(1).max(120).optional(),
    visible: z.boolean().optional(),
    position: vector3Schema.optional(),
    rotationDegrees: vector3Schema.optional(),
    scale: vector3Schema.optional(),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),
  }),
  z.object({
    type: z.literal('add_primitive'),
    primitive: z.enum(['box', 'sphere']),
    name: z.string().min(1).max(120),
    position: vector3Schema.default([0, 0, 0]),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#cccccc'),
  }),
  z.object({
    type: z.literal('remove_object'),
    target: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('replace_script'),
    source: z.string().max(250_000),
  }),
  z.object({
    type: z.literal('update_project'),
    title: z.string().trim().min(1).max(120).optional(),
    layout: editorLayoutSchema.optional(),
    cameraView: cameraViewSchema.optional(),
  }),
])
type SceneOperation = z.infer<typeof sceneOperationSchema>

function decodeBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('asset data is not canonical base64')
  return bytes
}

function textResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  }
}

function summaryResult(message: string, summary: ProjectSummary): CallToolResult {
  return textResult(
    `${message}: ${summary.projectId} at revision ${summary.revision}`,
    {
      projectId: summary.projectId,
      title: summary.title,
      revision: summary.revision,
    },
  )
}

function syntaxError(source: string): string | undefined {
  try {
    Function('THREE', source)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function materialColor(object: THREE.Object3D): THREE.Color | undefined {
  if (!(object instanceof THREE.Mesh)) return undefined
  const material = Array.isArray(object.material) ? object.material[0] : object.material
  if (material === undefined || !('color' in material) || !(material.color instanceof THREE.Color)) {
    return undefined
  }
  return material.color
}

function withoutTextureImages(scene: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(scene)
  const textureIds = new Set(
    Array.isArray(copy.textures)
      ? copy.textures.flatMap(texture => {
          const uuid = texture !== null && typeof texture === 'object'
            ? (texture as Record<string, unknown>).uuid
            : undefined
          return typeof uuid === 'string' ? [uuid] : []
        })
      : [],
  )
  delete copy.images
  delete copy.textures
  if (Array.isArray(copy.materials)) {
    for (const material of copy.materials) {
      if (material === null || typeof material !== 'object') continue
      for (const [key, value] of Object.entries(material as Record<string, unknown>)) {
        if (typeof value === 'string' && textureIds.has(value)) {
          delete (material as Record<string, unknown>)[key]
        }
      }
    }
  }
  return copy
}

function restoreTextureImages(
  serialized: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(serialized)
  if (original.images !== undefined) result.images = structuredClone(original.images)
  if (original.textures !== undefined) result.textures = structuredClone(original.textures)
  if (!Array.isArray(original.materials) || !Array.isArray(result.materials)
    || !Array.isArray(original.textures)) return result

  const textureIds = new Set(original.textures.flatMap(texture => {
    const uuid = texture !== null && typeof texture === 'object'
      ? (texture as Record<string, unknown>).uuid
      : undefined
    return typeof uuid === 'string' ? [uuid] : []
  }))
  const originalByUuid = new Map(original.materials.flatMap(material => {
    if (material === null || typeof material !== 'object') return []
    const record = material as Record<string, unknown>
    return typeof record.uuid === 'string' ? [[record.uuid, record] as const] : []
  }))
  for (const material of result.materials) {
    if (material === null || typeof material !== 'object') continue
    const target = material as Record<string, unknown>
    const source = typeof target.uuid === 'string' ? originalByUuid.get(target.uuid) : undefined
    if (source === undefined) continue
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'string' && textureIds.has(value)) {
        target[key] = value
      }
    }
  }
  return result
}

function sceneSummary(scene: THREE.Object3D): Array<{
  name: string
  type: string
  visible: boolean
  position: [number, number, number]
  color?: string
}> {
  const objects: Array<{
    name: string
    type: string
    visible: boolean
    position: [number, number, number]
    color?: string
  }> = []
  scene.traverse(object => {
    if (object === scene) return
    const color = materialColor(object)
    objects.push({
      name: object.name || object.type,
      type: object.type,
      visible: object.visible,
      position: object.position.toArray(),
      ...color === undefined ? {} : { color: `#${color.getHexString()}` },
    })
  })
  return objects
}

function applyOperations(
  project: z.infer<typeof projectSchema>,
  operations: SceneOperation[],
): { project: z.infer<typeof projectSchema>; changes: string[] } {
  const scene = new THREE.ObjectLoader().parse(withoutTextureImages(project.scene))
  if (!(scene instanceof THREE.Scene)) throw new Error('project scene is not a Three.js Scene')
  const camera = new THREE.ObjectLoader().parse(project.camera)
  if (!(camera instanceof THREE.Camera)) throw new Error('project camera is not a Three.js Camera')
  const next = structuredClone(project)
  const changes: string[] = []

  for (const operation of operations) {
    if (operation.type === 'replace_script') {
      const error = syntaxError(operation.source)
      if (error !== undefined) throw new Error(`script syntax error: ${error}`)
      next.script.source = operation.source
      changes.push('Replaced game script')
      continue
    }
    if (operation.type === 'update_project') {
      if (operation.title !== undefined) {
        next.title = operation.title
        scene.name = operation.title
        changes.push(`Renamed project to ${operation.title}`)
      }
      const editor = next.editor ?? {
        layout: 'classic' as const,
        cameraView: 'broadcast' as const,
        operations: [],
      }
      if (operation.layout !== undefined) {
        editor.layout = operation.layout
        changes.push(`Changed layout to ${operation.layout}`)
      }
      if (operation.cameraView !== undefined) {
        editor.cameraView = operation.cameraView
        changes.push(`Changed camera view to ${operation.cameraView}`)
      }
      next.editor = editor
      continue
    }
    if (operation.type === 'add_primitive') {
      if (scene.getObjectByName(operation.name) !== undefined) {
        throw new Error(`object already exists: ${operation.name}`)
      }
      const geometry = operation.primitive === 'box'
        ? new THREE.BoxGeometry(1, 1, 1)
        : new THREE.SphereGeometry(0.5, 24, 16)
      const object = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: operation.color }),
      )
      object.name = operation.name
      object.position.fromArray(operation.position)
      scene.add(object)
      changes.push(`Added ${operation.primitive} ${operation.name}`)
      continue
    }

    const object = scene.getObjectByName(operation.target)
    if (object === undefined) throw new Error(`object not found: ${operation.target}`)
    if (operation.type === 'remove_object') {
      if (object.parent === null) throw new Error(`object has no parent: ${operation.target}`)
      object.removeFromParent()
      changes.push(`Removed ${operation.target}`)
      continue
    }

    if (operation.name !== undefined) object.name = operation.name
    if (operation.visible !== undefined) object.visible = operation.visible
    if (operation.position !== undefined) object.position.fromArray(operation.position)
    if (operation.rotationDegrees !== undefined) {
      object.rotation.set(...operation.rotationDegrees.map(THREE.MathUtils.degToRad) as [
        number,
        number,
        number,
      ])
    }
    if (operation.scale !== undefined) object.scale.fromArray(operation.scale)
    if (operation.color !== undefined) {
      const color = materialColor(object)
      if (color === undefined) throw new Error(`object has no editable color: ${operation.target}`)
      color.set(operation.color)
    }
    changes.push(`Updated ${operation.target}`)
  }

  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  next.scene = restoreTextureImages(
    scene.toJSON() as unknown as Record<string, unknown>,
    project.scene,
  )
  next.camera = camera.toJSON() as unknown as Record<string, unknown>
  return { project: projectSchema.parse(next), changes }
}

function viewHtml(script: string): string {
  return `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Three.js Editor MCP</title>
  <style>
    :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#171717;background:#fff}
    :root[data-theme=dark]{color:#f5f5f5;background:#171717}
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    body{margin:0;padding:8px}
    main{display:grid;grid-template-rows:48px auto minmax(0,1fr);height:620px;border:1px solid #d4d4d4;border-radius:6px;overflow:hidden;background:#0b0d10}
    :root[data-theme=dark] main{border-color:#404040}
    header{display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid #292c31;background:#15181d;color:#f5f5f5}
    .mark{flex:0 0 auto;width:10px;height:10px;background:#3ddc84}
    .phase{font:11px/1 ui-monospace,SFMono-Regular,monospace;color:#a3a3a3}
    .title{min-width:80px;max-width:250px;width:34%;height:30px;padding:0 8px;border:1px solid #4b5058;border-radius:4px;background:#0f1216;color:#f5f5f5;font:600 13px/1 system-ui}
    .title:focus{outline:2px solid #56a8ff;outline-offset:-2px}
    .spacer{flex:1}
    .revision{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:10px/1 ui-monospace,SFMono-Regular,monospace;color:#a3a3a3}
    button{height:30px;padding:0 10px;border:1px solid #4b5058;border-radius:4px;background:#22262c;color:#f5f5f5;font:600 12px/1 system-ui;cursor:pointer}
    button:hover{background:#30353d}
    button:disabled{cursor:not-allowed;opacity:.45}
    button[aria-pressed=true]{border-color:#56a8ff;background:#17334c;color:#fff}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,canvas:focus-visible{outline:2px solid #56a8ff;outline-offset:-2px}
    .icon{width:30px;padding:0;font-size:15px}
    .asset-input{display:none}
    .conflict{grid-row:2;display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid #7a5c16;background:#33270d;color:#ffe6a3;font-size:12px}
    .conflict span{min-width:0;flex:1}
    .workspace{grid-row:3;display:grid;grid-template-columns:150px minmax(280px,1fr) 200px;min-width:0;min-height:0}
    .panel{min-width:0;min-height:0;overflow:auto;background:#111419;color:#d4d4d4}
    .hierarchy{border-right:1px solid #292c31}
    .inspector{border-left:1px solid #292c31}
    .panel h2{position:sticky;top:0;z-index:1;margin:0;padding:9px 10px;border-bottom:1px solid #292c31;background:#15181d;color:#f5f5f5;font-size:11px;line-height:1;text-transform:uppercase}
    .panel-tabs{position:sticky;top:0;z-index:1;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #292c31;background:#15181d}
    .panel-tabs button{height:29px;border:0;border-radius:0;background:transparent;color:#a3a3a3;font-size:10px;text-transform:uppercase}
    .panel-tabs button[aria-selected=true]{box-shadow:inset 0 -2px #56a8ff;color:#fff}
    .tree{margin:0;padding:5px 0;list-style:none}
    .tree button{display:block;width:100%;height:27px;padding:0 8px;border:0;border-radius:0;background:transparent;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .tree button:hover{background:#22262c}
    .tree button[aria-selected=true]{background:#1d3a53;color:#fff}
    .viewport{position:relative;min-width:0;min-height:0}
    canvas{display:block;width:100%;height:100%;cursor:crosshair;touch-action:none}
    .transform-tools{position:absolute;z-index:2;top:8px;left:8px;display:flex;gap:4px;padding:4px;border:1px solid #343941;border-radius:5px;background:#11151acc}
    .scene-settings{position:absolute;z-index:2;right:8px;bottom:8px;display:flex;gap:6px}
    .scene-settings select{height:28px;border:1px solid #4b5058;border-radius:4px;background:#171b20;color:#f5f5f5;font-size:11px}
    .status{position:absolute;left:10px;bottom:8px;margin:0;padding:4px 6px;border:1px solid #343941;border-radius:3px;background:#11151acc;color:#c8ccd2;font:10px/1 ui-monospace,SFMono-Regular,monospace;pointer-events:none}
    .inspector-body{padding:8px}
    .empty{margin:8px;color:#8b8f96;font-size:12px}
    .field{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:6px;margin-bottom:8px;font-size:11px}
    .field input[type=text],.field input[type=number]{width:100%;height:27px;padding:0 6px;border:1px solid #424750;border-radius:3px;background:#0f1216;color:#f5f5f5}
    .field input[type=color]{width:38px;height:27px;padding:2px;border:1px solid #424750;border-radius:3px;background:#0f1216}
    .vectors{width:100%;border-collapse:collapse;font-size:10px}
    .vectors th{padding:5px 2px;text-align:left;color:#9ca3ad;font-weight:600}
    .vectors td{padding:2px}
    .vectors input{width:100%;min-width:0;height:26px;padding:0 4px;border:1px solid #424750;border-radius:3px;background:#0f1216;color:#f5f5f5;font:10px/1 ui-monospace,SFMono-Regular,monospace}
    .script-pane{display:grid;grid-template-rows:minmax(120px,1fr) auto;height:calc(100% - 30px);padding:8px;gap:7px}
    .script-source{width:100%;min-height:120px;resize:none;padding:7px;border:1px solid #424750;border-radius:3px;background:#0b0d10;color:#d8e5ef;font:10px/1.45 ui-monospace,SFMono-Regular,monospace;tab-size:2}
    .runtime-output{max-height:62px;margin:0;overflow:auto;white-space:pre-wrap;color:#aab1bb;font:10px/1.35 ui-monospace,SFMono-Regular,monospace}
    [data-play-state=playing] .mark{background:#ffd166}
    @media (max-width:760px){
      .phase,.revision{display:none}
      .title{width:45%}
      .workspace{grid-template-columns:1fr 1fr;grid-template-rows:minmax(340px,1fr) 210px}
      .viewport{grid-column:1/-1;grid-row:1}
      .hierarchy{grid-column:1;grid-row:2;border-top:1px solid #292c31;border-right:1px solid #292c31}
      .inspector{grid-column:2;grid-row:2;border-top:1px solid #292c31;border-left:0}
    }
  </style>
</head>
<body>
  <main data-three-editor data-phase="M4" data-sync="loading" data-play-state="stopped" data-webgl="pending">
    <header>
      <span class="mark" aria-hidden="true"></span>
      <span class="phase">M4</span>
      <input class="title" data-title aria-label="Project title" maxlength="120" disabled>
      <span class="spacer"></span>
      <output class="revision" data-revision aria-label="Project revision">not loaded</output>
      <button class="icon" type="button" data-undo aria-label="Undo" title="Undo" disabled>↶</button>
      <button class="icon" type="button" data-redo aria-label="Redo" title="Redo" disabled>↷</button>
      <button class="icon" type="button" data-import aria-label="Import asset" title="Import GLB or texture" disabled>+</button>
      <input class="asset-input" type="file" data-asset-input accept=".glb,.png,.jpg,.jpeg,model/gltf-binary,image/png,image/jpeg">
      <button class="icon" type="button" data-export aria-label="Export project" title="Export project" disabled>↓</button>
      <button class="icon" type="button" data-play aria-label="Play" title="Play" disabled>▶</button>
      <button class="icon" type="button" data-stop aria-label="Stop" title="Stop" disabled>■</button>
      <button type="button" data-save disabled>Save</button>
    </header>
    <aside class="conflict" data-conflict hidden>
      <span>External revision available</span>
      <button type="button" data-load-external>Load external</button>
      <button type="button" data-save-copy>Save local copy</button>
    </aside>
    <section class="workspace">
      <aside class="panel hierarchy">
        <h2>Scene</h2>
        <ul class="tree" data-hierarchy></ul>
      </aside>
      <section class="viewport" data-viewport>
        <nav class="transform-tools" aria-label="Transform mode">
          <button class="icon" type="button" data-mode="translate" aria-label="Move" title="Move" aria-pressed="true">M</button>
          <button class="icon" type="button" data-mode="rotate" aria-label="Rotate" title="Rotate" aria-pressed="false">R</button>
          <button class="icon" type="button" data-mode="scale" aria-label="Scale" title="Scale" aria-pressed="false">S</button>
        </nav>
        <canvas data-three-canvas tabindex="0" aria-label="Three.js project viewport"></canvas>
        <p class="status" data-status role="status">Connecting</p>
        <div class="scene-settings">
          <select data-layout aria-label="Layout" disabled>
            <option value="classic">Classic</option>
            <option value="wide">Wide</option>
            <option value="compact">Compact</option>
          </select>
          <select data-camera-view aria-label="Camera view" disabled>
            <option value="broadcast">Broadcast</option>
            <option value="overhead">Overhead</option>
            <option value="courtside">Courtside</option>
          </select>
        </div>
      </section>
      <aside class="panel inspector">
        <nav class="panel-tabs" role="tablist" aria-label="Editor detail">
          <button type="button" role="tab" data-detail-tab="inspector" aria-selected="true">Inspector</button>
          <button type="button" role="tab" data-detail-tab="script" aria-selected="false">Script</button>
        </nav>
        <section data-inspector-pane>
          <p class="empty" data-inspector-empty>Select an object</p>
          <fieldset class="inspector-body" data-inspector-fields hidden>
            <label class="field"><span>Name</span><input type="text" data-object-name></label>
            <label class="field"><span>Visible</span><input type="checkbox" data-object-visible></label>
            <table class="vectors">
              <thead><tr><th></th><th>X</th><th>Y</th><th>Z</th></tr></thead>
              <tbody>
                <tr><th>Position</th><td><input type="number" step="0.01" data-vector="position" data-axis="x" aria-label="Position X"></td><td><input type="number" step="0.01" data-vector="position" data-axis="y" aria-label="Position Y"></td><td><input type="number" step="0.01" data-vector="position" data-axis="z" aria-label="Position Z"></td></tr>
                <tr><th>Rotation</th><td><input type="number" step="1" data-vector="rotation" data-axis="x" aria-label="Rotation X"></td><td><input type="number" step="1" data-vector="rotation" data-axis="y" aria-label="Rotation Y"></td><td><input type="number" step="1" data-vector="rotation" data-axis="z" aria-label="Rotation Z"></td></tr>
                <tr><th>Scale</th><td><input type="number" step="0.01" data-vector="scale" data-axis="x" aria-label="Scale X"></td><td><input type="number" step="0.01" data-vector="scale" data-axis="y" aria-label="Scale Y"></td><td><input type="number" step="0.01" data-vector="scale" data-axis="z" aria-label="Scale Z"></td></tr>
              </tbody>
            </table>
            <label class="field" data-material-row hidden><span>Color</span><input type="color" data-material-color aria-label="Material color"></label>
          </fieldset>
        </section>
        <section class="script-pane" data-script-pane hidden>
          <textarea class="script-source" data-script-source aria-label="Game script" spellcheck="false" disabled></textarea>
          <pre class="runtime-output" data-runtime-output>No Play diagnostics</pre>
        </section>
      </aside>
    </section>
  </main>
  <script>${script.replaceAll('</script', '<\\/script')}</script>
</body>
</html>`
}

function createServer(store: ProjectStore): McpServer {
  const server = new McpServer({
    name: 'threejs-editor-mcp',
    version: '0.1.0',
  })

  registerAppTool(server, 'list_projects', {
    title: 'List Three.js projects',
    description: 'Lists projects available in the configured Three.js project root.',
    inputSchema: {},
    outputSchema: z.object({ projects: z.array(summarySchema) }),
    _meta: { ui: { visibility: ['model'] } },
  }, async () => {
    const projects = await store.list()
    return textResult(
      projects.length === 0
        ? 'No Three.js projects exist.'
        : `Three.js projects: ${projects.map(project => `${project.projectId} (${project.title})`).join(', ')}`,
      { projects },
    )
  })

  registerAppTool(server, 'create_project', {
    title: 'Create Three.js project',
    description: 'Creates an empty or Pong Three.js project and opens its editor.',
    inputSchema: {
      projectId: projectIdSchema,
      title: z.string().trim().min(1).max(120).optional(),
      template: z.enum(['empty', 'pong']).default('pong'),
    },
    outputSchema: summarySchema,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model'],
      },
    },
  }, async ({ projectId, title, template }) => {
    const summary = await store.create(projectId, title ?? projectId, template)
    return summaryResult('Created Three.js project', summary)
  })

  registerAppTool(server, 'open_editor', {
    title: 'Open Three.js editor',
    description: 'Opens the editor for an existing Three.js project.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: summarySchema,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model'],
      },
    },
  }, async ({ projectId }) => summaryResult(
    'Opened Three.js project',
    await store.load(projectId),
  ))

  registerAppTool(server, 'inspect_project', {
    title: 'Inspect Three.js project',
    description: 'Reads the current scene, script, diagnostics, and recent human edit operations.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string(),
      revision: revisionSchema,
      layout: editorLayoutSchema,
      cameraView: cameraViewSchema,
      operations: z.array(z.string()),
      objects: z.array(sceneObjectSchema),
      assets: z.array(assetSummarySchema),
      script: z.object({
        source: z.string(),
        syntaxError: z.string().optional(),
      }),
      diagnostics: diagnosticsSchema.optional(),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId }) => {
    const snapshot = await store.load(projectId)
    const parsedScene = new THREE.ObjectLoader().parse(withoutTextureImages(snapshot.project.scene))
    if (!(parsedScene instanceof THREE.Scene)) {
      throw new Error('project scene is not a Three.js Scene')
    }
    const editor = snapshot.project.editor ?? {
      layout: 'classic' as const,
      cameraView: 'broadcast' as const,
      operations: [],
    }
    const objects = sceneSummary(parsedScene)
    const scriptError = syntaxError(snapshot.project.script.source)
    const [diagnostics, assets] = await Promise.all([
      store.readDiagnostics(projectId),
      store.listAssets(projectId),
    ])
    const detail = {
      projectId: snapshot.projectId,
      title: snapshot.title,
      revision: snapshot.revision,
      ...editor,
      objects,
      assets,
      script: {
        source: snapshot.project.script.source,
        ...scriptError === undefined ? {} : { syntaxError: scriptError },
      },
      ...diagnostics === undefined ? {} : { diagnostics },
    }
    return textResult(
      `Three.js project inspection:\n${JSON.stringify(detail)}`,
      detail,
    )
  })

  registerAppTool(server, 'apply_scene_changes', {
    title: 'Apply Three.js scene changes',
    description: 'Applies one revision-checked batch of bounded scene, script, or project changes.',
    inputSchema: {
      projectId: projectIdSchema,
      baseRevision: revisionSchema,
      operations: z.array(sceneOperationSchema).min(1).max(50),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string().optional(),
      revision: revisionSchema.optional(),
      changes: z.array(z.string()).optional(),
      conflict: z.literal(true).optional(),
      currentRevision: revisionSchema.optional(),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId, baseRevision, operations }) => {
    try {
      const snapshot = await store.load(projectId)
      if (snapshot.revision !== baseRevision) {
        throw new RevisionConflictError(snapshot.revision)
      }
      const applied = applyOperations(snapshot.project, operations)
      const summary = await store.push(projectId, baseRevision, applied.project)
      return textResult(
        `Updated Three.js project ${projectId} to revision ${summary.revision}: `
        + applied.changes.join('; '),
        {
          projectId,
          title: summary.title,
          revision: summary.revision,
          changes: applied.changes,
        },
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Revision conflict: current revision is ${error.currentRevision}.`,
        }],
        structuredContent: {
          projectId,
          conflict: true,
          currentRevision: error.currentRevision,
        },
      }
    }
  })

  registerAppTool(server, 'check_project', {
    title: 'Check Three.js project',
    description: 'Checks scene and camera loading, script syntax, and diagnostics for the current revision.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string(),
      revision: revisionSchema,
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      testedRevision: revisionSchema.optional(),
      testedAt: z.string().optional(),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId }) => {
    const snapshot = await store.load(projectId)
    const errors: string[] = []
    const warnings: string[] = []
    try {
      const parsedScene = new THREE.ObjectLoader().parse(withoutTextureImages(snapshot.project.scene))
      if (!(parsedScene instanceof THREE.Scene)) errors.push('project scene is not a Three.js Scene')
    } catch (error) {
      errors.push(`scene load error: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const parsedCamera = new THREE.ObjectLoader().parse(snapshot.project.camera)
      if (!(parsedCamera instanceof THREE.Camera)) errors.push('project camera is not a Three.js Camera')
    } catch (error) {
      errors.push(`camera load error: ${error instanceof Error ? error.message : String(error)}`)
    }
    const scriptError = syntaxError(snapshot.project.script.source)
    if (scriptError !== undefined) errors.push(`script syntax error: ${scriptError}`)
    const diagnostics = await store.readDiagnostics(projectId)
    if (diagnostics === undefined) {
      warnings.push('Play diagnostics have not been reported')
    } else if (diagnostics.testedRevision !== snapshot.revision) {
      warnings.push(`Play diagnostics apply to older revision ${diagnostics.testedRevision}`)
    } else {
      errors.push(...diagnostics.errors)
      warnings.push(...diagnostics.warnings)
    }
    try {
      await store.listAssets(projectId)
    } catch (error) {
      errors.push(`asset validation error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return textResult(
      `Checked ${projectId} at revision ${snapshot.revision}: `
      + `${String(errors.length)} errors, ${String(warnings.length)} warnings.`,
      {
        projectId,
        title: snapshot.title,
        revision: snapshot.revision,
        errors,
        warnings,
        ...diagnostics === undefined ? {} : {
          testedRevision: diagnostics.testedRevision,
          testedAt: diagnostics.updatedAt,
        },
      },
    )
  })

  registerAppTool(server, 'pull_project', {
    title: 'Pull Three.js project',
    description: 'Returns the project when the editor revision is stale.',
    inputSchema: {
      projectId: projectIdSchema,
      currentRevision: revisionSchema.optional(),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      changed: z.boolean(),
      revision: revisionSchema,
      project: projectSchema.optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, currentRevision }) => {
    const snapshot = await store.load(projectId)
    const changed = currentRevision !== snapshot.revision
    return textResult(changed ? 'Project snapshot returned.' : 'Project is current.', {
      projectId,
      changed,
      revision: snapshot.revision,
      ...changed ? { project: snapshot.project } : {},
    })
  })

  registerAppTool(server, 'push_project', {
    title: 'Save Three.js project',
    description: 'Saves one editor snapshot when its base revision is current.',
    inputSchema: {
      projectId: projectIdSchema,
      baseRevision: revisionSchema,
      project: projectSchema,
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string().optional(),
      revision: revisionSchema.optional(),
      conflict: z.literal(true).optional(),
      currentRevision: revisionSchema.optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, baseRevision, project }) => {
    try {
      return summaryResult(
        'Saved Three.js project',
        await store.push(projectId, baseRevision, project),
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Revision conflict: current revision is ${error.currentRevision}.`,
        }],
        structuredContent: {
          projectId,
          conflict: true,
          currentRevision: error.currentRevision,
        },
      }
    }
  })

  registerAppTool(server, 'save_project_copy', {
    title: 'Save Three.js project copy',
    description: 'Persists the editor snapshot under a new project ID.',
    inputSchema: {
      sourceProjectId: projectIdSchema.optional(),
      newProjectId: projectIdSchema,
      project: projectSchema,
    },
    outputSchema: summarySchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ sourceProjectId, newProjectId, project }) => summaryResult(
    'Saved Three.js project copy',
    sourceProjectId === undefined
      ? await store.saveCopy(newProjectId, project)
      : await store.saveCopyWithAssets(sourceProjectId, newProjectId, project),
  ))

  registerAppTool(server, 'report_diagnostics', {
    title: 'Report Three.js Play diagnostics',
    description: 'Records Play errors and warnings for one exact project revision.',
    inputSchema: {
      projectId: projectIdSchema,
      testedRevision: revisionSchema,
      errors: z.array(z.string().min(1).max(2_000)).max(20),
      warnings: z.array(z.string().min(1).max(2_000)).max(20),
    },
    outputSchema: diagnosticsSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, testedRevision, errors, warnings }) => {
    const diagnostics = await store.reportDiagnostics(
      projectId,
      testedRevision,
      errors,
      warnings,
    )
    return textResult(
      `Recorded Play diagnostics for ${projectId} at ${testedRevision.slice(0, 12)}.`,
      diagnostics,
    )
  })

  registerAppTool(server, 'put_asset', {
    title: 'Import Three.js asset',
    description: 'Stores one bounded GLB, PNG, or JPEG asset for the current project revision.',
    inputSchema: {
      projectId: projectIdSchema,
      baseRevision: revisionSchema,
      name: assetSummarySchema.shape.name,
      mediaType: assetMediaTypeSchema,
      data: assetDataSchema,
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      revision: revisionSchema.optional(),
      asset: assetSummarySchema.optional(),
      conflict: z.literal(true).optional(),
      currentRevision: revisionSchema.optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, baseRevision, name, mediaType, data }) => {
    try {
      const saved = await store.putAsset(
        projectId,
        baseRevision,
        name,
        mediaType,
        decodeBase64(data),
      )
      return textResult(`Stored asset ${name}.`, {
        projectId,
        revision: saved.revision,
        asset: {
          name: saved.name,
          mediaType: saved.mediaType,
          size: saved.size,
          sha256: saved.sha256,
        },
      })
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Revision conflict: current revision is ${error.currentRevision}.`,
        }],
        structuredContent: {
          projectId,
          conflict: true,
          currentRevision: error.currentRevision,
        },
      }
    }
  })

  registerAppTool(server, 'export_project', {
    title: 'Export Three.js project',
    description: 'Returns a bounded JSON export containing the saved project and original assets.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      filename: z.string(),
      mediaType: z.literal('application/json'),
      json: z.string(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId }) => {
    const json = `${JSON.stringify(await store.exportProject(projectId), null, 2)}\n`
    return textResult(`Exported Three.js project ${projectId}.`, {
      filename: `${projectId}.threejs-project.json`,
      mediaType: 'application/json',
      json,
    })
  })

  registerAppResource(server, 'threejs-editor-view', RESOURCE_URI, {
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        csp: CSP,
        prefersBorder: false,
      },
    },
  }, async (): Promise<ReadResourceResult> => {
    const script = await readFile(new URL('./view.js', import.meta.url), 'utf8')
    return {
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: viewHtml(script),
        _meta: {
          ui: {
            csp: CSP,
            prefersBorder: false,
          },
        },
      }],
    }
  })

  return server
}

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
  },
  strict: true,
})
const root = values.root ?? process.env.THREEJS_EDITOR_PROJECT_ROOT
if (root === undefined || root === '') {
  throw new Error('project root is required: pass --root or THREEJS_EDITOR_PROJECT_ROOT')
}

await createServer(new ProjectStore(root)).connect(new StdioServerTransport())

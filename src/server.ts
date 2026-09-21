#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import * as THREE from 'three'
import { z } from 'zod'
import type { WorkspaceBuild } from './builder.js'
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
import {
  MATERIAL_BOOLEAN_PROPERTIES,
  MATERIAL_NUMBER_PROPERTIES,
  applyOfficialEditorCommands,
  editorProjectFromSnapshots,
  inspectOfficialEditor,
  officialCommandProof,
  type EditorCommandOperation,
  type EditorObjectSnapshot,
} from './official-editor.js'
import {
  RUNTIME_ISOLATION_COMMAND_PROOF_URI,
  RUNTIME_ISOLATION_FIXTURE_MANIFEST,
  RUNTIME_ISOLATION_FIXTURE_RESOURCE_URI,
} from './runtime-isolation-fixture.js'
import {
  RUNTIME_COMMAND_MIN_TIMEOUT_MS,
  WORKSPACE_EDITOR_STATE_PATH,
  type WorkspaceEditorState,
} from './workspace-runtime.js'
import {
  WorkspaceStore,
  RESOURCE_CHUNK_BYTES,
  workspaceCapabilitiesSchema,
  workspaceChangeSchema,
  workspaceFileSchema,
  workspaceParameterSchema,
  workspacePathSchema,
  type RuntimeOwner,
  type WorkspaceRegistration,
  type WorkspaceSnapshot,
  type WorkspaceSummary,
} from './workspaces.js'

const RESOURCE_URI = 'ui://threejs-editor/app'
const BUILD_RESOURCE_TEMPLATE =
  'threejs-build://runtime/{projectId}/{buildId}/{artifact}'
const ASSET_RESOURCE_TEMPLATE =
  'threejs-asset://runtime/{projectId}/{revision}/{sha256}/{chunk}'
const DSH_WORKSPACE_META_KEY = 'ai.deepseek.dsh/workspace'
const DSH_SESSION_META_KEY = 'ai.deepseek.dsh/session'
const MAX_RUNTIME_EDITOR_OBJECTS = 2_048
const M81_PROMPT_NAME = 'threejs-runtime-validation'
const M81_PROMPT = `分析当前任务。

如果当前 Harness 提供 SubAgent 工具，并且子任务能够独立并行，先并行启动：
1. 测试清单生成 Agent
2. 风险与覆盖分析 Agent

SubAgent 只负责分析，不修改工程。合并结果后，使用当前可用的
Three.js Runtime Harness 工具执行测试并收集证据。

测试完成后，启动未参与修改和测试执行的独立评分 Agent。

按正确性、覆盖率、回归风险控制、可复现性评分。
低于 85 分时修正并重新测试，最多两轮。
第二轮仍低于 85 分时，报告未通过项和残余风险，不得声称验证通过。

仅使用当前实际提供的取证工具。工具不可用时，明确标记未自动验证，
不得伪造截图、日志、玩家操作或测试结论。

执行视觉验证前，先判断当前模型是否支持图像输入。
支持图像输入时，使用 capture_runtime_frame 获取并检查视觉证据。
不支持图像输入时，停止自动视觉判断并进入意图对齐：
向用户说明需要操作和观察的内容，等待用户提供实际结果后继续。
不得自行推断视觉结果或声称自动验证通过。`
const CSP = {
  resourceDomains: [] as string[],
  frameDomains: [] as string[],
  baseUriDomains: [] as string[],
}
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const sessionProjectPathSchema = z.string()
  .min(1)
  .max(512)
  .refine(value => (
    value === '.'
    || (!value.includes('\0')
      && !value.includes('\\')
      && !value.startsWith('/')
      && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
  ), {
    message: 'projectPath must be a relative POSIX path',
  })
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const runIdSchema = z.string().uuid()
const nonceSchema = z.string().uuid()
const runtimeRefSchema = z.string().uuid()
const runtimeOwnerSchema = z.object({
  sessionId: z.string().min(1).max(128),
  connectionGeneration: z.string().uuid(),
})
const runtimeIdentitySchema = z.object({
  execution: z.object({
    projectId: projectIdSchema,
    runId: runIdSchema,
    nonce: nonceSchema,
    owner: runtimeOwnerSchema,
  }),
  projection: z.object({
    workspaceRevision: revisionSchema,
    generation: z.number().int().nonnegative(),
    loadedBuild: z.object({
      buildId: z.string().regex(/^[a-f0-9]{64}$/),
      sourceRevision: revisionSchema,
    }),
  }),
})
const runtimeReferenceSchema = z.object({
  projectId: projectIdSchema,
  runtimeRef: runtimeRefSchema,
})
const registeredRuntimeSchema = runtimeIdentitySchema.extend({
  runtimeRef: runtimeRefSchema,
  evidenceToken: nonceSchema,
})
const preparedRuntimeRunSchema = registeredRuntimeSchema.extend({
  expiresAt: z.string().datetime(),
})
const pendingRuntimeProjectionSchema = z.object({
  transitionId: z.string().uuid(),
  execution: runtimeIdentitySchema.shape.execution,
  baseRevision: revisionSchema,
  targetRevision: revisionSchema,
  expectedGeneration: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
})
const runtimeHarnessAddressShape = {
  projectId: projectIdSchema,
  runtimeRef: runtimeRefSchema.describe(
    'Use the opaque reference from the latest Editor Runtime context.',
  ),
}
const runtimeTargetSchema = z.enum(['active', 'validation'])
const runtimeHarnessTargetSchema = runtimeTargetSchema.default('validation').describe(
  'Omit target for ordinary checks. The default validation Runtime is isolated and requires no Editor grant. Use active only after the user explicitly asks to inspect the current live Runtime.',
)
const activeIntentSchema = z.literal('user-requested').optional().describe(
  'Deprecated compatibility hint. Editor-issued authorization is the sole authority.',
)
const normalizedPointSchema = z.array(z.number().min(0).max(1)).length(2) as unknown as z.ZodType<[number, number]>
const playerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['pointerMove', 'pointerDown', 'pointerUp', 'click']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.number().int().min(0).max(4).default(0),
  }),
  z.object({
    type: z.literal('drag'),
    from: normalizedPointSchema,
    to: normalizedPointSchema,
    button: z.number().int().min(0).max(4).default(0),
    steps: z.number().int().min(1).max(60).default(8),
  }),
  z.object({
    type: z.literal('wheel'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    deltaX: z.number().min(-2_000).max(2_000).default(0),
    deltaY: z.number().min(-2_000).max(2_000),
  }),
  z.object({
    type: z.enum(['keyDown', 'keyUp']),
    key: z.string().min(1).max(32),
    code: z.string().min(1).max(32).optional(),
  }),
  z.object({
    type: z.literal('waitFrames'),
    frames: z.number().int().min(1).max(600),
    frameDurationMs: z.number().positive().max(100).optional(),
  }),
])
const runtimeEvidenceIdentitySchema = runtimeIdentitySchema.extend({
  target: runtimeTargetSchema,
})
const runtimeLogEntrySchema = z.object({
  cursor: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(2_048),
})
const runtimeEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('capture-frame'),
    runtime: runtimeEvidenceIdentitySchema,
    evidenceId: z.string().uuid(),
    evidenceToken: nonceSchema,
    digest: revisionSchema,
    mimeType: z.enum(['image/png', 'image/jpeg']),
    data: z.string().max(512 * 1024),
    width: z.number().int().positive().max(1_024),
    height: z.number().int().positive().max(1_024),
    frame: z.number().int().nonnegative(),
    deterministic: z.boolean().optional(),
    qualityTier: z.string().min(1).max(80).optional(),
    debugMode: z.string().min(1).max(80).optional(),
    capturedAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('runtime-logs'),
    runtime: runtimeEvidenceIdentitySchema,
    evidenceId: z.string().uuid(),
    evidenceToken: nonceSchema,
    entries: z.array(runtimeLogEntrySchema).max(500),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal('action-trace'),
    runtime: runtimeEvidenceIdentitySchema,
    evidenceId: z.string().uuid(),
    evidenceToken: nonceSchema,
    status: z.enum(['completed', 'failed', 'cancelled']),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
    trace: z.array(z.object({
      index: z.number().int().nonnegative(),
      type: z.string(),
      frame: z.number().int().nonnegative(),
      status: z.enum(['completed', 'failed']),
      handled: z.boolean().optional(),
      message: z.string().max(1_024).optional(),
    })).max(32),
  }),
  z.object({
    kind: z.literal('runtime-harness-error'),
    runtime: runtimeEvidenceIdentitySchema,
    evidenceId: z.string().uuid(),
    evidenceToken: nonceSchema,
    status: z.literal('failed'),
    message: z.string().min(1).max(2_048),
  }),
])
const runtimeCommandFailureStageSchema = z.enum(['prepare', 'execute', 'settle'])
const runtimeCommandFailureCodeSchema = z.enum([
  'TARGET_PREPARATION_FAILED',
  'TARGET_EXECUTION_FAILED',
  'EVIDENCE_REJECTED',
])
const runtimeCommandOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('succeeded'),
    evidence: runtimeEvidenceSchema,
  }),
  z.object({
    status: z.literal('failed'),
    stage: runtimeCommandFailureStageSchema,
    code: runtimeCommandFailureCodeSchema,
    message: z.string().min(1).max(2_048),
  }),
  z.object({
    status: z.literal('cancelled'),
    reason: z.string().min(1).max(2_048),
  }),
  z.object({
    status: z.literal('expired'),
    stage: runtimeCommandFailureStageSchema,
  }),
])
const buildIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
const buildDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  length: z.number().int().nonnegative().optional(),
  lineText: z.string().optional(),
})
const buildOutputSchema = z.object({
  schemaVersion: z.literal(1),
  builderVersion: z.string(),
  dependencyProfile: z.string(),
  projectId: projectIdSchema,
  revision: revisionSchema,
  buildId: buildIdSchema,
  entry: workspacePathSchema,
  backend: z.enum(['webgl', 'webgpu', 'raw-webgpu']),
  status: z.enum(['ready', 'failed']),
  diagnostics: z.array(buildDiagnosticSchema),
  bundleBytes: z.number().int().nonnegative().optional(),
  sourceMapBytes: z.number().int().nonnegative().optional(),
  inputs: z.array(z.string()).optional(),
  assets: z.array(z.object({
    path: workspacePathSchema,
    sha256: revisionSchema,
    size: z.number().int().nonnegative(),
    mediaType: z.string(),
    external: z.literal(true).optional(),
    resourceUri: z.string().optional(),
    chunks: z.number().int().positive().optional(),
  })).optional(),
  bundleUri: z.string().optional(),
  sourceMapUri: z.string().optional(),
})
const assetDataSchema = z.string()
  .min(4)
  .max(Math.ceil(MAX_ASSET_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const summarySchema = z.object({
  projectId: projectIdSchema,
  title: z.string(),
  revision: revisionSchema,
  kind: z.enum(['scene-project', 'linked-workspace', 'managed-workspace']).optional(),
})
const workspaceSummarySchema = summarySchema.extend({
  kind: z.enum(['linked-workspace', 'managed-workspace']),
})
const workspaceProjectCandidateSchema = z.object({
  projectPath: sessionProjectPathSchema,
  title: z.string(),
  format: z.literal('example-gallery'),
  entry: workspacePathSchema,
  backend: z.enum(['webgl', 'webgpu', 'raw-webgpu']),
  available: z.boolean(),
  issue: z.string().optional(),
})
const workspaceViewSchema = z.object({
  kind: z.enum(['linked-workspace', 'managed-workspace']),
  entry: workspacePathSchema,
  backend: z.enum(['webgl', 'webgpu', 'raw-webgpu']),
  debugModes: z.array(z.string()),
  qualityTiers: z.array(z.string()),
  parameters: z.array(workspaceParameterSchema),
  capabilities: workspaceCapabilitiesSchema.optional(),
  files: z.array(workspaceFileSchema),
})
const editorSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workspace-entry'),
    entry: workspacePathSchema,
    entryAlias: workspacePathSchema,
    readTool: z.literal('read_project_files'),
    editTool: z.literal('apply_project_files'),
  }),
  z.object({
    kind: z.literal('scene-script'),
    readTool: z.literal('inspect_project'),
    editTool: z.literal('apply_scene_changes'),
    operation: z.literal('replace_script'),
  }),
])
const sceneObjectSchema = z.object({
  name: z.string(),
  type: z.string(),
  visible: z.boolean(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  color: z.string().optional(),
})
const editorMaterialPropertySchema = z.discriminatedUnion('kind', [
  z.object({
    name: z.literal('color'),
    kind: z.literal('color'),
    value: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    command: z.literal('set_material_color'),
  }),
  z.object({
    name: z.enum(MATERIAL_NUMBER_PROPERTIES),
    kind: z.literal('number'),
    value: z.number(),
    min: z.literal(0),
    max: z.literal(1),
    command: z.literal('set_material_value'),
  }),
  z.object({
    name: z.enum(MATERIAL_BOOLEAN_PROPERTIES),
    kind: z.literal('boolean'),
    value: z.boolean(),
    command: z.literal('set_material_boolean'),
  }),
])
const editorMaterialSchema = z.object({
  uuid: z.string().uuid(),
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  properties: z.array(editorMaterialPropertySchema),
})
const editorObjectSchema = z.object({
  uuid: z.string().uuid(),
  parentUuid: z.string().uuid().optional(),
  path: z.string().min(1).max(1_024).optional(),
  name: z.string(),
  type: z.string(),
  visible: z.boolean(),
  position: z.array(z.number()).length(3),
  rotationDegrees: z.array(z.number()).length(3),
  scale: z.array(z.number()).length(3),
  color: z.string().optional(),
  material: editorMaterialSchema.optional(),
  commands: z.array(z.string()),
})
const vector3Schema = z.array(z.number()).length(3) as unknown as z.ZodType<[number, number, number]>
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
const editorCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_position'),
    objectUuid: z.string().uuid(),
    value: vector3Schema,
  }),
  z.object({
    type: z.literal('set_rotation'),
    objectUuid: z.string().uuid(),
    value: vector3Schema,
  }),
  z.object({
    type: z.literal('set_scale'),
    objectUuid: z.string().uuid(),
    value: vector3Schema,
  }),
  z.object({
    type: z.literal('set_name'),
    objectUuid: z.string().uuid(),
    value: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('set_visible'),
    objectUuid: z.string().uuid(),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal('set_material_color'),
    objectUuid: z.string().uuid(),
    value: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  }),
  z.object({
    type: z.literal('set_material_value'),
    objectUuid: z.string().uuid(),
    property: z.enum(MATERIAL_NUMBER_PROPERTIES),
    value: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('set_material_boolean'),
    objectUuid: z.string().uuid(),
    property: z.enum(MATERIAL_BOOLEAN_PROPERTIES),
    value: z.boolean(),
  }),
])
const runtimeEditorObjectSchema = editorObjectSchema.extend({
  path: z.string().min(1).max(1_024),
  position: vector3Schema,
  rotationDegrees: vector3Schema,
  scale: vector3Schema,
})
const runtimeEditorSceneSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  objects: z.array(runtimeEditorObjectSchema).max(MAX_RUNTIME_EDITOR_OBJECTS),
})

function runtimeEditorScene(value: unknown): z.infer<typeof runtimeEditorSceneSchema> | undefined {
  const parsed = runtimeEditorSceneSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const editorChangeSchema = z.object({
  source: z.enum(['human', 'ai', 'unknown']),
  type: z.enum([
    'set_position',
    'set_rotation',
    'set_scale',
    'set_name',
    'set_visible',
    'set_material_color',
    'set_material_value',
    'set_material_boolean',
  ]),
  objectUuid: z.string().uuid(),
  objectName: z.string(),
  objectPath: z.string().optional(),
  value: z.unknown(),
})
const workspaceEditorStateSchema = z.object({
  schemaVersion: z.literal(1),
  operations: z.array(editorCommandSchema).max(4_096),
  qualityTier: z.string().min(1).max(80).optional(),
  recentChanges: z.array(z.object({
    source: z.enum(['human', 'ai', 'unknown']),
    operation: editorCommandSchema,
  })).max(200).optional(),
})
const workspaceReadSchema = z.object({
  path: workspacePathSchema,
  sha256: revisionSchema,
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
  text: z.string().optional(),
  base64: z.string().optional(),
})
const workspaceConflictOutputSchema = z.object({
  projectId: projectIdSchema,
  title: z.string().optional(),
  revision: revisionSchema.optional(),
  kind: z.enum(['linked-workspace', 'managed-workspace']).optional(),
  conflict: z.literal(true).optional(),
  currentRevision: revisionSchema.optional(),
})

function workspaceRegistration(value: string): WorkspaceRegistration {
  const separator = value.indexOf('=')
  if (separator < 1 || separator === value.length - 1) {
    throw new Error('--workspace must use projectId=path')
  }
  return {
    projectId: value.slice(0, separator),
    path: value.slice(separator + 1),
  }
}

function optionalDshWorkspacePath(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const parsed = z.object({ cwd: z.string().min(1) }).safeParse(
    meta?.[DSH_WORKSPACE_META_KEY],
  )
  return parsed.success ? parsed.data.cwd : undefined
}

function dshWorkspacePath(meta: Record<string, unknown> | undefined): string {
  const path = optionalDshWorkspacePath(meta)
  if (path !== undefined) return path
  throw new Error('current DSH workspace is unavailable; select a workspace or pass projectId')
}

function runtimeOwner(meta: Record<string, unknown> | undefined): RuntimeOwner
function runtimeOwner(
  meta: Record<string, unknown> | undefined,
  required: false,
): RuntimeOwner | undefined
function runtimeOwner(
  meta: Record<string, unknown> | undefined,
  required = true,
): RuntimeOwner | undefined {
  const parsed = runtimeOwnerSchema.safeParse(meta?.[DSH_SESSION_META_KEY])
  if (parsed.success) return parsed.data
  if (!required) return undefined
  throw new Error('Harness Session and MCP connection generation are required')
}

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

function summaryResult(
  message: string,
  summary: ProjectSummary | WorkspaceSummary,
): CallToolResult {
  return textResult(
    `${message}: ${summary.projectId} at revision ${summary.revision}`,
    {
      projectId: summary.projectId,
      title: summary.title,
      revision: summary.revision,
      ...'kind' in summary ? { kind: summary.kind } : {},
    },
  )
}

function workspaceView(snapshot: WorkspaceSnapshot): z.infer<typeof workspaceViewSchema> {
  return {
    kind: snapshot.kind,
    entry: snapshot.manifest.entry,
    backend: snapshot.manifest.backend,
    debugModes: snapshot.manifest.runtime.debugModes,
    qualityTiers: snapshot.manifest.runtime.qualityTiers,
    parameters: snapshot.manifest.runtime.parameters,
    ...snapshot.manifest.runtime.capabilities === undefined
      ? {}
      : { capabilities: snapshot.manifest.runtime.capabilities },
    files: Object.entries(snapshot.manifest.files).map(([path, file]) => ({
      path,
      ...file,
    })),
  }
}

function buildResourceUri(
  projectId: string,
  buildId: string,
  artifact: 'bundle.js' | 'bundle.js.map',
): string {
  return `threejs-build://runtime/${projectId}/${buildId}/${artifact}`
}

function assetResourceUri(projectId: string, revision: string, sha256: string): string {
  return `threejs-asset://runtime/${projectId}/${revision}/${sha256}`
}

function buildView(build: WorkspaceBuild): z.infer<typeof buildOutputSchema> {
  if (build.status === 'failed') return build
  const { bundle: _bundle, sourceMap: _sourceMap, ...summary } = build
  return {
    ...summary,
    assets: summary.assets.map(asset => ({
      ...asset,
      ...asset.external
        ? {
            resourceUri: assetResourceUri(build.projectId, build.revision, asset.sha256),
            chunks: Math.ceil(asset.size / RESOURCE_CHUNK_BYTES),
          }
        : {},
    })),
    bundleUri: buildResourceUri(build.projectId, build.buildId, 'bundle.js'),
    sourceMapUri: buildResourceUri(build.projectId, build.buildId, 'bundle.js.map'),
  }
}

function conflictResult(projectId: string, error: RevisionConflictError): CallToolResult {
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

function workspaceProjectChanges(project: z.infer<typeof projectSchema>): unknown[] {
  return [
    {
      type: 'write',
      path: 'src/scene.json',
      text: `${JSON.stringify(project, null, 2)}\n`,
    },
    {
      type: 'write',
      path: 'src/main.js',
      text: project.script.source,
    },
  ]
}

function applyEditorCommands(
  project: z.infer<typeof projectSchema>,
  operations: EditorCommandOperation[],
): ReturnType<typeof applyOfficialEditorCommands> {
  const applied = applyOfficialEditorCommands({
    ...structuredClone(project),
    scene: withoutTextureImages(project.scene),
  }, operations)
  applied.project.scene = restoreTextureImages(applied.project.scene, project.scene)
  return applied
}

function editorOperationKey(operation: EditorCommandOperation): string {
  return `${operation.objectUuid}\0${operation.type}${
    operation.type === 'set_material_value' || operation.type === 'set_material_boolean'
      ? `\0${operation.property}`
      : ''
  }`
}

function compactEditorOperations(
  operations: EditorCommandOperation[],
): EditorCommandOperation[] {
  const compacted = new Map<string, EditorCommandOperation>()
  for (const operation of operations) {
    const key = editorOperationKey(operation)
    compacted.delete(key)
    compacted.set(key, operation)
  }
  return [...compacted.values()]
}

function editorOperationValue(operation: EditorCommandOperation): unknown {
  return operation.type === 'set_material_value' || operation.type === 'set_material_boolean'
    ? { property: operation.property, value: operation.value }
    : operation.value
}

function assertEditorOperationsAdvertised(
  objects: EditorObjectSnapshot[],
  operations: EditorCommandOperation[],
): void {
  const byUuid = new Map(objects.map(object => [object.uuid, object]))
  for (const operation of operations) {
    const object = byUuid.get(operation.objectUuid)
    if (object === undefined) throw new Error(`unknown object ${operation.objectUuid}`)
    if (!object.commands.includes(operation.type)) {
      throw new Error(
        `object ${operation.objectUuid} does not advertise ${operation.type}`,
      )
    }
    if (operation.type === 'set_material_color') {
      const advertised = object.material?.properties.some(property => (
        property.name === 'color' && property.command === operation.type
      )) ?? object.color !== undefined
      if (!advertised) {
        throw new Error(
          `material does not advertise color: ${operation.objectUuid}`,
        )
      }
      continue
    }
    if (operation.type !== 'set_material_value'
      && operation.type !== 'set_material_boolean') continue
    if (!object.material?.properties.some(property => (
      property.name === operation.property && property.command === operation.type
    ))) {
      throw new Error(
        `material does not advertise ${operation.property}: ${operation.objectUuid}`,
      )
    }
  }
}

function editorChanges(
  state: WorkspaceEditorState,
  objects: EditorObjectSnapshot[],
): Array<z.infer<typeof editorChangeSchema>> {
  const byUuid = new Map(objects.map(object => [object.uuid, object]))
  return (state.recentChanges ?? state.operations.map(operation => ({
    source: 'unknown' as const,
    operation,
  }))).map(({ source, operation }) => {
    const object = byUuid.get(operation.objectUuid)
    return {
      source,
      type: operation.type,
      objectUuid: operation.objectUuid,
      objectName: object?.name ?? operation.objectUuid,
      ...object?.path === undefined ? {} : { objectPath: object.path },
      value: editorOperationValue(operation),
    }
  })
}

function editorChangeText(change: z.infer<typeof editorChangeSchema>): string {
  return `${change.source} ${change.type} ${change.objectName}`
    + `${change.objectPath === undefined ? '' : ` (${change.objectPath})`}`
    + ` = ${JSON.stringify(change.value)}`
}

function inspectEditor(project: z.infer<typeof projectSchema>): ReturnType<typeof inspectOfficialEditor> {
  return inspectOfficialEditor({
    ...structuredClone(project),
    scene: withoutTextureImages(project.scene),
  })
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
<html data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Three.js Editor MCP</title>
  <style>
    :root{
      --surface:#05080e;
      --surface-raised:rgb(4 9 16 / .46);
      --surface-control:rgb(232 244 255 / .065);
      --line:rgb(214 235 255 / .1);
      --line-strong:rgb(214 235 255 / .19);
      --text:#f2f7fc;
      --muted:#8495a8;
      --accent:#63b8ff;
      --accent-soft:rgb(99 184 255 / .17);
      --accent-ink:#03101a;
      font-family:"SF Pro Display","Avenir Next",ui-sans-serif,system-ui,sans-serif;
      color:var(--text);
      background:var(--surface);
      color-scheme:dark;
      letter-spacing:0;
    }
    :root[data-display-mode=fullscreen],:root[data-display-mode=fullscreen] body{height:100%}
    *{box-sizing:border-box}
    [hidden]{display:none!important}
    body{margin:0;padding:8px;background:var(--surface)}
    main{
      display:grid;
      grid-template-rows:54px auto minmax(0,1fr);
      height:620px;
      overflow:hidden;
      border:1px solid var(--line-strong);
      border-radius:6px;
      background:var(--surface);
      box-shadow:0 24px 80px rgb(0 2 8 / .58);
    }
    :root[data-display-mode=fullscreen] body{padding:0}
    :root[data-display-mode=fullscreen] main{height:100vh;border:0;border-radius:0}
    .topbar{
      display:flex;
      align-items:center;
      gap:8px;
      min-width:0;
      padding:0 10px 0 14px;
      border-bottom:1px solid var(--line);
      background:rgb(4 8 14 / .78);
      color:var(--text);
      box-shadow:inset 0 1px rgb(255 255 255 / .055),0 12px 42px rgb(0 3 10 / .24);
      backdrop-filter:blur(20px) saturate(125%);
      -webkit-backdrop-filter:blur(20px) saturate(125%);
    }
    .title{
      min-width:90px;
      max-width:270px;
      width:32%;
      height:32px;
      padding:0 10px;
      border:1px solid transparent;
      border-radius:4px;
      background:transparent;
      color:var(--text);
      font:650 13px/1 "SF Pro Display","Avenir Next",ui-sans-serif,system-ui,sans-serif;
    }
    .title:hover:not(:disabled){background:rgb(220 236 255 / .06)}
    .title:focus{border-color:var(--accent);background:rgb(220 236 255 / .08);outline:0}
    .spacer{flex:1}
    .revision{
      max-width:88px;
      overflow:hidden;
      color:var(--muted);
      font:10px/1 "SFMono-Regular",Consolas,monospace;
      font-variant-numeric:tabular-nums;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .toolbar{display:flex;align-items:center;gap:5px;min-width:0}
    .toolbar-divider{width:1px;height:20px;margin:0 2px;background:var(--line)}
    button{
      height:32px;
      padding:0 10px;
      border:1px solid var(--line-strong);
      border-radius:4px;
      background:var(--surface-control);
      color:var(--text);
      box-shadow:inset 0 1px rgb(255 255 255 / .06);
      font:650 12px/1 "SF Pro Display","Avenir Next",ui-sans-serif,system-ui,sans-serif;
      cursor:pointer;
      transition:transform .28s cubic-bezier(.16,1,.3,1),border-color .28s cubic-bezier(.16,1,.3,1),background .28s cubic-bezier(.16,1,.3,1),box-shadow .28s cubic-bezier(.16,1,.3,1),color .28s cubic-bezier(.16,1,.3,1);
    }
    button:hover:not(:disabled){border-color:rgb(99 184 255 / .48);background:rgb(232 244 255 / .12);box-shadow:inset 0 1px rgb(255 255 255 / .1),0 8px 24px rgb(0 4 12 / .22)}
    button:active:not(:disabled){transform:scale(.97)}
    button:disabled{cursor:not-allowed;opacity:.45}
    button[aria-pressed=true]{border-color:rgb(99 184 255 / .48);background:var(--accent-soft);box-shadow:inset 0 0 18px rgb(99 184 255 / .08),0 0 22px rgb(99 184 255 / .09);color:#f4faff}
    button:focus-visible,input:focus-visible,select:focus-visible,canvas:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .icon{width:32px;padding:0;font-size:15px}
    .runtime-debug,.runtime-quality{height:32px;max-width:112px;border:1px solid var(--line-strong);border-radius:4px;background:var(--surface-control);color:var(--text);font:11px/1.2 "SF Pro Display","Avenir Next",ui-sans-serif,system-ui,sans-serif}
    .save{min-width:52px;border-color:rgb(132 202 255 / .9);background:var(--accent);box-shadow:inset 0 1px rgb(255 255 255 / .42),0 7px 22px rgb(38 137 218 / .26);color:var(--accent-ink)}
    .save:hover:not(:disabled){border-color:#8fd0ff;background:#8fd0ff;box-shadow:inset 0 1px rgb(255 255 255 / .5),0 9px 28px rgb(38 137 218 / .36);color:var(--accent-ink)}
    .asset-input{display:none}
    .conflict{
      grid-row:2;
      display:flex;
      align-items:center;
      gap:8px;
      padding:8px 12px;
      border-bottom:1px solid rgb(255 200 87 / .3);
      background:rgb(52 35 7 / .9);
      color:#ffe2a1;
      font-size:12px;
    }
    .conflict span{min-width:0;flex:1}
    .workspace{position:relative;grid-row:3;min-width:0;min-height:0;isolation:isolate;background:#050b13}
    .editor-surface,.viewport{position:absolute;inset:0;min-width:0;min-height:0}
    .editor-surface{z-index:1}
    .viewport{overflow:hidden}
    .viewport::after{
      content:"";
      position:absolute;
      inset:0;
      z-index:1;
      pointer-events:none;
      background-image:
        linear-gradient(rgb(176 219 255 / .018) 1px,transparent 1px),
        linear-gradient(90deg,rgb(176 219 255 / .018) 1px,transparent 1px);
      background-size:32px 32px;
      box-shadow:inset 0 0 140px rgb(0 3 9 / .7),inset 0 1px 0 rgb(160 213 255 / .07);
    }
    .panel{
      position:absolute;
      z-index:4;
      top:12px;
      bottom:auto;
      min-width:0;
      min-height:0;
      max-height:calc(100% - 24px);
      overflow:auto;
      border:1px solid var(--line-strong);
      border-radius:7px;
      background:var(--surface-raised);
      color:#c7d3df;
      box-shadow:0 22px 58px rgb(0 3 10 / .48),inset 0 1px rgb(255 255 255 / .14),inset 0 0 0 1px rgb(255 255 255 / .025);
      backdrop-filter:blur(18px) saturate(125%);
      -webkit-backdrop-filter:blur(18px) saturate(125%);
      contain:paint;
    }
    .panel::after,.transform-tools::after,.status::after{
      content:"";
      position:absolute;
      inset:1px;
      border:1px solid rgb(224 241 255 / .055);
      border-radius:5px;
      pointer-events:none;
    }
    .hierarchy{left:12px;width:clamp(156px,22vw,220px)}
    .inspector{right:12px;width:clamp(210px,27vw,292px)}
    .panel h2{
      position:sticky;
      top:0;
      z-index:1;
      margin:0;
      padding:12px;
      border-bottom:1px solid var(--line);
      background:rgb(5 11 19 / .36);
      color:var(--text);
      font-size:11px;
      font-weight:750;
      line-height:1;
      letter-spacing:.01em;
    }
    .runtime-parameters{border-top:1px solid var(--line);padding:12px}
    .runtime-parameters h3{margin:0 0 10px;color:var(--muted);font-size:10px;font-weight:760;text-transform:uppercase}
    .parameter-list{display:grid;gap:10px}
    .parameter-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;color:#aebdcc;font-size:11px}
    .parameter-field input[type=number]{width:82px}
    .tree-tools{
      position:sticky;
      top:35px;
      z-index:1;
      display:grid;
      grid-template-columns:minmax(0,1fr) 29px;
      gap:4px;
      padding:6px;
      border-bottom:1px solid var(--line);
      background:rgb(5 11 19 / .72);
    }
    .scene-search{min-width:0;height:29px;padding:0 8px}
    .tree-tools .icon{width:29px;height:29px}
    .tree,.tree ul{margin:0;padding:0;list-style:none}
    .tree{padding:5px 0}
    .tree-children{padding-left:13px!important}
    .tree-row{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:center}
    .tree-spacer{width:24px}
    .tree button{
      height:29px;
      overflow:hidden;
      border:0;
      border-radius:0;
      background:transparent;
      color:#bac9d9;
      text-overflow:ellipsis;
      white-space:nowrap;
      font-weight:540;
    }
    .tree-toggle{width:24px;padding:0;text-align:center;color:#8092a5!important}
    .tree-object{width:100%;padding:0 8px;text-align:left}
    .tree button:hover{border-color:transparent;background:rgb(232 244 255 / .07);box-shadow:none}
    .tree button[aria-selected=true]{background:var(--accent-soft);box-shadow:inset 2px 0 var(--accent),inset 0 1px rgb(255 255 255 / .035);color:#f4faff}
    canvas{display:block;width:100%;height:100%;cursor:crosshair;touch-action:none}
    .runtime-sandbox{position:absolute;inset:0;z-index:2;width:100%;height:100%;border:0;background:#050b13}
    .validation-runtime{position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;pointer-events:none}
    .transform-tools{
      position:absolute;
      z-index:3;
      bottom:12px;
      left:50%;
      display:flex;
      gap:4px;
      padding:4px;
      border:1px solid var(--line-strong);
      border-radius:7px;
      background:rgb(4 9 16 / .42);
      box-shadow:0 18px 44px rgb(0 3 10 / .46),inset 0 1px rgb(255 255 255 / .14),inset 0 0 0 1px rgb(255 255 255 / .025);
      transform:translateX(-50%);
      backdrop-filter:blur(16px) saturate(125%);
      -webkit-backdrop-filter:blur(16px) saturate(125%);
      contain:paint;
    }
    .transform-tools .icon{border-color:transparent;background:transparent}
    .status{
      position:absolute;
      z-index:3;
      left:calc(clamp(156px,22vw,220px) + 24px);
      bottom:12px;
      max-width:280px;
      margin:0;
      overflow:hidden;
      padding:7px 9px;
      border:1px solid var(--line);
      border-radius:4px;
      background:rgb(4 9 16 / .46);
      color:#aebdcd;
      box-shadow:0 14px 34px rgb(0 3 10 / .38),inset 0 1px rgb(255 255 255 / .1);
      font:10px/1 "SFMono-Regular",Consolas,monospace;
      font-variant-numeric:tabular-nums;
      text-overflow:ellipsis;
      white-space:nowrap;
      pointer-events:none;
      backdrop-filter:blur(14px) saturate(120%);
      -webkit-backdrop-filter:blur(14px) saturate(120%);
      contain:paint;
    }
    .inspector-body{padding:12px;border:0}
    .empty{margin:12px;color:var(--muted);font-size:12px}
    .field{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:8px;margin-bottom:10px;font-size:11px}
    .field input[type=text],.field input[type=number]{
      width:100%;
      height:29px;
      padding:0 7px;
      border:1px solid var(--line);
      border-radius:3px;
      background:rgb(1 5 10 / .42);
      box-shadow:inset 0 1px 3px rgb(0 0 0 / .22),inset 0 1px rgb(255 255 255 / .035);
      color:var(--text);
    }
    .field input[type=checkbox]{width:15px;height:15px;margin:0;accent-color:var(--accent)}
    .field input[type=color]{width:40px;height:29px;padding:2px;border:1px solid var(--line);border-radius:3px;background:rgb(1 5 10 / .42);box-shadow:inset 0 1px rgb(255 255 255 / .035)}
    .vectors{width:100%;border-collapse:collapse;font-size:10px}
    .vectors th{padding:5px 2px;text-align:left;color:var(--muted);font-weight:650}
    .vectors td{padding:2px}
    .vectors input{
      width:100%;
      min-width:0;
      height:27px;
      padding:0 5px;
      border:1px solid var(--line);
      border-radius:3px;
      background:rgb(1 5 10 / .42);
      box-shadow:inset 0 1px 3px rgb(0 0 0 / .22),inset 0 1px rgb(255 255 255 / .035);
      color:var(--text);
      font:10px/1 "SFMono-Regular",Consolas,monospace;
      font-variant-numeric:tabular-nums;
    }
    [data-play-state=playing] .transform-tools,[data-play-state=playing] .panel{opacity:.38;pointer-events:none}
    [data-sync=dirty] .save{box-shadow:inset 0 1px rgb(255 255 255 / .44),0 0 0 1px rgb(99 184 255 / .28),0 9px 30px rgb(45 148 229 / .34)}
    @media (max-width:760px){
      .revision,.toolbar-divider{display:none}
      .title{width:42%;padding-left:4px}
      .topbar{gap:5px;padding-inline:8px}
      .toolbar{gap:3px}
      .toolbar .icon{width:29px}
      .runtime-debug,.runtime-quality{max-width:84px}
      .hierarchy{left:8px;width:150px}
      .inspector{right:8px;width:210px}
      .status{left:168px;max-width:180px}
    }
    @media (max-width:540px){
      main{grid-template-rows:50px auto minmax(0,1fr)}
      .title{min-width:72px;width:36%}
      .toolbar [data-import],.toolbar [data-export],.toolbar [data-undo],.toolbar [data-redo]{display:none}
      .panel{top:auto;bottom:8px;height:176px}
      .hierarchy{left:8px;width:calc(50% - 12px)}
      .inspector{right:8px;width:calc(50% - 12px)}
      .transform-tools{
        top:auto;
        right:8px;
        bottom:192px;
        left:auto;
        transform:none;
        animation:none;
      }
      .status{left:8px;bottom:192px;max-width:calc(100% - 160px)}
    }
    @media (prefers-reduced-transparency:reduce){
      .topbar,.panel,.panel h2,.transform-tools,.status{background:#09111c;backdrop-filter:none;-webkit-backdrop-filter:none}
    }
    @media (prefers-reduced-motion:no-preference){
      .panel{animation:panel-arrive .46s cubic-bezier(.16,1,.3,1) both}
      .inspector{animation-delay:.06s}
      .transform-tools{animation:toolbar-arrive .42s cubic-bezier(.16,1,.3,1) both}
    }
    @media (prefers-reduced-motion:reduce){
      *,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}
    }
    @keyframes panel-arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes toolbar-arrive{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}
  </style>
</head>
<body>
  <main data-three-editor data-phase="workspace" data-ui-mode="scene-only" data-ui-direction="ethereal-glass" data-visual-style="taste-ethereal-glass" data-sync="loading" data-play-state="stopped" data-webgl="pending">
    <header class="topbar">
      <input class="title" data-title aria-label="Project title" maxlength="120" disabled>
      <span class="spacer"></span>
      <output class="revision" data-revision aria-label="Project revision">not loaded</output>
      <nav class="toolbar" aria-label="Editor actions">
        <button class="icon" type="button" data-undo aria-label="Undo" title="Undo" disabled>↶</button>
        <button class="icon" type="button" data-redo aria-label="Redo" title="Redo" disabled>↷</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button class="icon" type="button" data-import aria-label="Import asset" title="Import GLB or texture" disabled>+</button>
        <input class="asset-input" type="file" data-asset-input accept=".glb,.png,.jpg,.jpeg,model/gltf-binary,image/png,image/jpeg">
        <button class="icon" type="button" data-export aria-label="Export project" title="Export project" disabled>↓</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <select class="runtime-quality" data-runtime-quality aria-label="画质" title="画质" hidden></select>
        <select class="runtime-debug" data-runtime-debug aria-label="画面检查" title="画面检查" hidden></select>
        <button class="icon" type="button" data-play aria-label="Play" title="Play" disabled>▶</button>
        <button class="icon" type="button" data-stop aria-label="Stop" title="Stop" disabled>■</button>
        <button class="icon" type="button" data-active-grant aria-label="Allow one live validation" title="Allow one live validation" disabled>A</button>
        <button class="icon" type="button" data-fullscreen aria-label="Enter fullscreen" title="Enter fullscreen" hidden>⛶</button>
        <button class="save" type="button" data-save disabled>Save</button>
      </nav>
    </header>
    <aside class="conflict" data-conflict hidden>
      <span>External revision available</span>
      <button type="button" data-load-external>Load external</button>
      <button type="button" data-save-copy>Save local revision</button>
      <button type="button" data-defer-external>Review later</button>
    </aside>
    <section class="workspace">
      <aside class="panel hierarchy">
        <h2>Scene graph</h2>
        <div class="tree-tools">
          <input class="scene-search" type="search" data-scene-search aria-label="Search scene objects" placeholder="Find object">
          <button class="icon" type="button" data-reveal-selection aria-label="Reveal selected object" title="Reveal selected object">⌖</button>
        </div>
        <ul class="tree" data-hierarchy data-scene-tree></ul>
      </aside>
      <section class="editor-surface">
        <section class="viewport" data-viewport>
          <nav class="transform-tools" aria-label="Transform mode">
            <button class="icon" type="button" data-mode="translate" aria-label="Move" title="Move" aria-pressed="true">↔</button>
            <button class="icon" type="button" data-mode="rotate" aria-label="Rotate" title="Rotate" aria-pressed="false">↻</button>
            <button class="icon" type="button" data-mode="scale" aria-label="Scale" title="Scale" aria-pressed="false">⤢</button>
          </nav>
          <canvas data-three-canvas tabindex="0" aria-label="Three.js project viewport"></canvas>
          <iframe
            class="runtime-sandbox"
            data-runtime-sandbox
            title="Isolated Three.js runtime"
            sandbox="allow-scripts"
            hidden
          ></iframe>
          <iframe
            class="validation-runtime"
            data-validation-runtime
            title="Three.js validation runtime"
            sandbox="allow-scripts"
            tabindex="-1"
            aria-hidden="true"
          ></iframe>
        </section>
        <p class="status" data-status role="status">Connecting</p>
      </section>
      <aside class="panel inspector">
        <h2>Properties</h2>
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
        <section class="runtime-parameters" data-runtime-parameters hidden>
          <h3>Parameters</h3>
          <div class="parameter-list" data-parameter-list></div>
        </section>
      </aside>
      <section hidden aria-hidden="true">
        <button type="button" data-navigation-tab="scene" aria-selected="true" tabindex="-1">Scene</button>
        <ul data-file-tree></ul>
        <section data-file-workspace>
          <span data-file-path>No file selected</span>
          <textarea data-file-source aria-label="Workspace file" spellcheck="false" disabled></textarea>
        </section>
        <section data-script-pane>
          <textarea data-script-source aria-label="Game script" spellcheck="false" disabled></textarea>
          <pre data-runtime-output>No Play diagnostics</pre>
        </section>
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
      </section>
    </section>
  </main>
  <script>${script.replaceAll('</script', '<\\/script')}</script>
</body>
</html>`
}

function createServer(store: ProjectStore, workspaces: WorkspaceStore): McpServer {
  const server = new McpServer({
    name: 'threejs-editor-mcp',
    version: '0.1.0',
  }, {
    instructions:
      'For ordinary Three.js scene authoring, use inspect_editor first, then read_project_files and apply_project_files with the canonical workspace-relative entry or entryAlias it returns. Do not reinterpret either as a host filesystem path. Use the public tool schemas and Runtime contract. Do not read or search the threejs-editor-mcp or deepseek-harness implementation source unless the user explicitly asks to debug or extend those systems.',
  })
  const loadWorkspace = async (projectId: string): Promise<WorkspaceSnapshot | undefined> => (
    await workspaces.has(projectId) ? workspaces.load(projectId) : undefined
  )

  server.registerPrompt(M81_PROMPT_NAME, {
    description: 'Guides bounded Three.js Runtime validation and independent scoring.',
  }, () => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: M81_PROMPT },
    }],
  }))

  registerAppTool(server, 'list_projects', {
    title: 'List Three.js projects',
    description:
      'Lists registered projects and discovers Three.js examples in the current DSH workspace. Use a returned projectPath with open_editor; do not use a dev server or HTML fallback.',
    inputSchema: {},
    outputSchema: z.object({
      projects: z.array(summarySchema),
      workspaceProjects: z.array(workspaceProjectCandidateSchema),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async (_arguments, extra) => {
    const workspacePath = optionalDshWorkspacePath(extra._meta)
    const [sceneProjects, registeredWorkspaces, workspaceProjects] = await Promise.all([
      store.list(),
      workspaces.list(),
      workspacePath === undefined
        ? Promise.resolve([])
        : workspaces.discoverSessionProjects(workspacePath),
    ])
    const projects = [
      ...sceneProjects,
      ...registeredWorkspaces,
    ].sort((left, right) => left.projectId.localeCompare(right.projectId))
    if (workspacePath === undefined) {
      return textResult(
        projects.length === 0
          ? 'No Three.js projects exist.'
          : `Three.js projects: ${projects.map(project => (
            'kind' in project
              ? `${project.projectId} (${project.title}, ${project.kind})`
              : `${project.projectId} (${project.title})`
          )).join(', ')}`,
        { projects, workspaceProjects },
      )
    }
    const registeredText = projects.length === 0
      ? 'No registered Three.js projects.'
      : `Registered Three.js projects: ${projects.map(project => (
        'kind' in project
          ? `${project.projectId} (${project.title}, ${project.kind})`
          : `${project.projectId} (${project.title})`
      )).join(', ')}.`
    const workspaceText = workspaceProjects.length === 0
      ? ' No Three.js examples were discovered in the current DSH workspace.'
      : ` Current DSH workspace examples: ${workspaceProjects.map(project => (
        `${project.projectPath} (${project.title}, ${project.available ? 'ready' : project.issue})`
      )).join(', ')}. Open one with open_editor({ projectPath }).`
    return textResult(
      `${registeredText}${workspaceText}`,
      { projects, workspaceProjects },
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
    if (await workspaces.has(projectId)) throw new Error(`project ${projectId} already exists`)
    const summary = await store.create(projectId, title ?? projectId, template)
    return summaryResult('Created Three.js project', summary)
  })

  registerAppTool(server, 'create_workspace', {
    title: 'Create managed Three.js workspace',
    description: 'Creates a managed multi-file Three.js workspace and opens its editor.',
    inputSchema: {
      projectId: projectIdSchema,
      title: z.string().trim().min(1).max(120).optional(),
      template: z.enum(['empty', 'pong']).default('pong'),
    },
    outputSchema: workspaceSummarySchema,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model'],
      },
    },
  }, async ({ projectId, title, template }) => {
    if ((await store.list()).some(project => project.projectId === projectId)) {
      throw new Error(`project ${projectId} already exists`)
    }
    return summaryResult(
      'Created managed Three.js workspace',
      await workspaces.createManaged(projectId, title ?? projectId, template),
    )
  })

  registerAppTool(server, 'open_editor', {
    title: 'Open Three.js editor',
    description:
      'Requests an existing project, the current DSH workspace, or a discovered workspace example by relative projectPath in the Editor. A successful tool result only accepts the open request; do not claim the App loaded until its follow-up status arrives. Successful project mutations update the same project-bound Editor automatically; do not call open_editor again unless the user explicitly requests a duplicate view. Never compile or serve project HTML as a fallback.',
    inputSchema: {
      projectId: projectIdSchema.optional(),
      projectPath: sessionProjectPathSchema.optional(),
    },
    outputSchema: summarySchema,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model'],
      },
    },
  }, async ({ projectId, projectPath }, extra) => {
    if (projectId !== undefined && projectPath !== undefined) {
      throw new Error('pass either projectId or projectPath, not both')
    }
    if (projectPath !== undefined) {
      return summaryResult(
        'Open request accepted for current DSH workspace example; App loading is pending',
        await workspaces.importSessionProject(
          dshWorkspacePath(extra._meta),
          projectPath,
        ),
      )
    }
    if (projectId === undefined) {
      const path = dshWorkspacePath(extra._meta)
      const candidates = await workspaces.discoverSessionProjects(path)
      if (candidates.length === 1) {
        return summaryResult(
          'Open request accepted for current DSH workspace example; App loading is pending',
          await workspaces.importSessionProject(path, candidates[0].projectPath),
        )
      }
      if (candidates.length > 1) {
        throw new Error(
          `Current DSH workspace contains ${candidates.length} Three.js examples. Call list_projects, choose one projectPath, then call open_editor with that projectPath. Do not run npm, an external dev server, or an HTML fallback.`,
        )
      }
      return summaryResult(
        'Open request accepted for current DSH workspace; App loading is pending',
        await workspaces.registerSessionWorkspace(path),
      )
    }
    const workspace = await loadWorkspace(projectId)
    return summaryResult(
      workspace === undefined
        ? 'Open request accepted for Three.js project; App loading is pending'
        : 'Open request accepted for Three.js workspace; App loading is pending',
      workspace ?? await store.load(projectId),
    )
  })

  registerAppTool(server, 'inspect_project', {
    title: 'Inspect Three.js project',
    description: 'Reads the current scene, script, diagnostics, and recent human edit operations.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string(),
      revision: revisionSchema,
      kind: z.enum(['scene-project', 'linked-workspace', 'managed-workspace']),
      workspace: workspaceViewSchema.optional(),
      layout: editorLayoutSchema,
      cameraView: cameraViewSchema,
      operations: z.array(z.string()),
      editorChanges: z.array(editorChangeSchema),
      objects: z.array(sceneObjectSchema),
      assets: z.array(assetSummarySchema),
      script: z.object({
        source: z.string(),
        syntaxError: z.string().optional(),
      }),
      diagnostics: diagnosticsSchema.optional(),
      runtime: runtimeReferenceSchema.optional(),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId }, { _meta }) => {
    const workspace = await loadWorkspace(projectId)
    const snapshot = workspace ?? await store.load(projectId)
    const owner = runtimeOwner(_meta, false)
    const parsedScene = new THREE.ObjectLoader().parse(withoutTextureImages(snapshot.project.scene))
    if (!(parsedScene instanceof THREE.Scene)) {
      throw new Error('project scene is not a Three.js Scene')
    }
    const editor = snapshot.project.editor ?? {
      layout: 'classic' as const,
      cameraView: 'broadcast' as const,
      operations: [],
    }
    let objects = sceneSummary(parsedScene)
    let changes: Array<z.infer<typeof editorChangeSchema>> = []
    if (workspace !== undefined) {
      const reportedDocument = await workspaces.readEditorScene(
        projectId,
        snapshot.revision,
        undefined,
        owner,
      )
      const reported = runtimeEditorScene(reportedDocument)
      if (reported !== undefined) {
        objects = reported.objects.map(object => ({
          name: object.name,
          type: object.type,
          visible: object.visible,
          position: object.position,
          ...object.color === undefined ? {} : { color: object.color },
        }))
      }
      if (workspace.manifest.files[WORKSPACE_EDITOR_STATE_PATH] !== undefined) {
        const [file] = await workspaces.readFiles(projectId, [{
          path: WORKSPACE_EDITOR_STATE_PATH,
        }])
        const state = workspaceEditorStateSchema.parse(JSON.parse(file!.text!))
        changes = editorChanges(
          state,
          reported?.objects as EditorObjectSnapshot[] ?? [],
        )
      }
    }
    const scriptError = syntaxError(snapshot.project.script.source)
    const [diagnostics, assets, runtime] = await Promise.all([
      workspace === undefined
        ? store.readDiagnostics(projectId)
        : workspaces.readDiagnostics(projectId, owner),
      workspace === undefined ? store.listAssets(projectId) : [],
      workspace === undefined || owner === undefined
        ? undefined
        : workspaces.runtimeIdentity(projectId, owner),
    ])
    const detail = {
      projectId: snapshot.projectId,
      title: snapshot.title,
      revision: snapshot.revision,
      kind: workspace?.kind ?? 'scene-project' as const,
      ...workspace === undefined ? {} : { workspace: workspaceView(workspace) },
      ...editor,
      operations: changes.length === 0
        ? editor.operations
        : changes.map(editorChangeText),
      editorChanges: changes,
      objects,
      assets,
      script: {
        source: snapshot.project.script.source,
        ...scriptError === undefined ? {} : { syntaxError: scriptError },
      },
      ...diagnostics === undefined ? {} : { diagnostics },
      ...runtime === undefined
        ? {}
        : {
            runtime: {
              projectId: runtime.projectId,
              runtimeRef: runtime.runtimeRef,
            },
          },
    }
    return textResult(
      `Three.js project inspection:\n${JSON.stringify(detail)}`,
      detail,
    )
  })

  registerAppTool(server, 'prepare_runtime_run', {
    title: 'Prepare Three.js Runtime run',
    description: 'Prepares an owner-scoped candidate without changing the active Runtime.',
    inputSchema: {
      projectId: projectIdSchema,
      revision: revisionSchema,
      buildId: buildIdSchema,
      runId: runIdSchema,
      nonce: nonceSchema,
      ttlMs: z.number().int().positive().max(600_000).optional(),
    },
    outputSchema: preparedRuntimeRunSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, revision, buildId, runId, nonce, ttlMs }, { signal, _meta }) => {
    const prepared = await workspaces.prepareRuntimeRun(
      projectId,
      revision,
      buildId,
      runId,
      nonce,
      runtimeOwner(_meta),
      signal,
      ttlMs,
    )
    return textResult(`Prepared Runtime run ${runId}.`, {
      ...prepared,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
    })
  })

  registerAppTool(server, 'commit_runtime_run', {
    title: 'Commit Three.js Runtime run',
    description: 'Promotes a prepared Runtime when the expected active reference still matches.',
    inputSchema: {
      projectId: projectIdSchema,
      runtimeRef: runtimeRefSchema,
      expectedActiveRef: runtimeRefSchema.optional(),
    },
    outputSchema: preparedRuntimeRunSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, runtimeRef, expectedActiveRef }, { signal, _meta }) => {
    const committed = await workspaces.commitRuntimeRun(
      projectId,
      runtimeRef,
      expectedActiveRef,
      runtimeOwner(_meta),
      signal,
    )
    return textResult(`Committed Runtime run ${committed.execution.runId}.`, {
      ...committed,
      expiresAt: new Date(committed.expiresAt).toISOString(),
    })
  })

  registerAppTool(server, 'commit_runtime_projection', {
    title: 'Commit Three.js Runtime projection',
    description: 'CAS-commits one pending revision change after matching iframe acknowledgement.',
    inputSchema: {
      projectId: projectIdSchema,
      transitionId: z.string().uuid(),
      runtimeRef: runtimeRefSchema,
      revision: revisionSchema,
    },
    outputSchema: registeredRuntimeSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({
    projectId,
    transitionId,
    runtimeRef,
    revision,
  }, { signal, _meta }) => {
    const registered = await workspaces.commitRuntimeProjection(
      projectId,
      transitionId,
      runtimeRef,
      revision,
      runtimeOwner(_meta),
      signal,
    )
    return textResult(`Advanced Runtime projection to ${revision}.`, {
      ...registered,
    })
  })

  registerAppTool(server, 'release_runtime_run', {
    title: 'Release Three.js Runtime run',
    description: 'Releases one active Runtime reference during cancellation or teardown.',
    inputSchema: runtimeHarnessAddressShape,
    outputSchema: z.object({
      projectId: projectIdSchema,
      released: z.boolean(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, runtimeRef }, { _meta }) => {
    const released = await workspaces.releaseRuntimeRun(
      projectId,
      runtimeRef,
      runtimeOwner(_meta),
    )
    return textResult(`${released ? 'Released' : 'Ignored stale'} Runtime.`, {
      projectId,
      released,
    })
  })

  registerAppTool(server, 'grant_active_runtime_control', {
    title: 'Grant one active Runtime check',
    description: 'Grants this Harness Session one active Runtime evidence command for 60 seconds.',
    inputSchema: runtimeHarnessAddressShape,
    outputSchema: z.object({
      expiresAt: z.string().datetime(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async (address, { _meta }) => {
    const expiresAt = await workspaces.grantActiveRuntimeControl(
      address,
      runtimeOwner(_meta)!,
    )
    return textResult('Granted one active Runtime evidence command.', { expiresAt })
  })

  registerAppTool(server, 'pull_runtime_command', {
    title: 'Pull Runtime Harness command',
    description: 'Returns the current exact Runtime command for this Editor App.',
    inputSchema: runtimeHarnessAddressShape,
    outputSchema: z.object({
      command: z.object({
        commandId: z.string().uuid(),
        kind: z.enum(['capture-frame', 'read-logs', 'simulate-actions']),
        target: runtimeTargetSchema,
        runtime: runtimeIdentitySchema,
        evidenceToken: nonceSchema,
        payload: z.record(z.string(), z.unknown()),
        timeoutMs: z.number().int().min(RUNTIME_COMMAND_MIN_TIMEOUT_MS).max(20_000),
        expiresAt: z.string().datetime().optional(),
      }).optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async (address, { _meta }) => {
    const command = await workspaces.pullRuntimeCommand(
      address,
      runtimeOwner(_meta)!,
    )
    return textResult(command === undefined
      ? 'No Runtime Harness command is pending.'
      : `Runtime Harness command ${command.commandId} is pending.`, {
      ...command === undefined ? {} : { command },
    })
  })

  registerAppTool(server, 'start_runtime_command', {
    title: 'Start Runtime Harness command',
    description: 'Starts the execution deadline after the target Runtime is ready.',
    inputSchema: {
      ...runtimeHarnessAddressShape,
      commandId: z.string().uuid(),
      targetRuntime: runtimeEvidenceIdentitySchema,
    },
    outputSchema: z.object({
      commandId: z.string().uuid(),
      expiresAt: z.string().datetime(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ commandId, targetRuntime, ...address }, { _meta }) => {
    const expiresAt = await workspaces.startRuntimeCommand(
      address,
      runtimeOwner(_meta)!,
      commandId,
      targetRuntime,
    )
    return textResult(`Started Runtime Harness command ${commandId}.`, {
      commandId,
      expiresAt,
    })
  })

  registerAppTool(server, 'settle_runtime_command', {
    title: 'Settle Runtime Harness command',
    description: 'Idempotently settles one Runtime Harness command with a typed terminal outcome.',
    inputSchema: {
      ...runtimeHarnessAddressShape,
      commandId: z.string().uuid(),
      outcome: runtimeCommandOutcomeSchema,
    },
    outputSchema: z.object({
      commandId: z.string().uuid(),
      accepted: z.literal(true),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ commandId, outcome, ...address }, { _meta }) => {
    await workspaces.settleRuntimeCommand(
      address,
      runtimeOwner(_meta)!,
      commandId,
      outcome,
    )
    return textResult(`Settled Runtime Harness command ${commandId}.`, {
      commandId,
      accepted: true,
    })
  })

  registerAppTool(server, 'capture_runtime_frame', {
    title: 'Capture Three.js Runtime frame',
    description: 'Captures only the Runtime canvas. Use runtimeRef from the latest Editor context. Omit target for ordinary checks; validation is isolated and requires no Editor grant. Active access consumes an Editor-issued one-shot authorization.',
    inputSchema: {
      ...runtimeHarnessAddressShape,
      target: runtimeHarnessTargetSchema,
      activeIntent: activeIntentSchema,
      format: z.enum(['png', 'jpeg']).default('png'),
      maxWidth: z.number().int().min(64).max(1_024).default(768),
      maxHeight: z.number().int().min(64).max(1_024).default(768),
      deterministic: z.boolean().default(true),
      timeoutMs: z.number().int().min(RUNTIME_COMMAND_MIN_TIMEOUT_MS).max(20_000).default(20_000),
    },
    outputSchema: runtimeEvidenceSchema.options[0].omit({
      data: true,
      evidenceToken: true,
    }),
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({
    target,
    activeIntent,
    format,
    maxWidth,
    maxHeight,
    deterministic,
    timeoutMs,
    ...address
  }, { _meta, signal }) => {
    const owner = runtimeOwner(_meta)!
    void activeIntent
    const evidence = runtimeEvidenceSchema.options[0].parse(
      await workspaces.requestRuntimeCommand(
        address,
        owner,
        'capture-frame',
        target,
        { format, maxWidth, maxHeight, deterministic },
        timeoutMs,
        signal,
      ),
    )
    const { data, evidenceToken: _evidenceToken, ...structuredContent } = evidence
    return {
      content: [
        {
          type: 'text',
          text: `Captured ${evidence.runtime.target} Runtime evidence ${evidence.evidenceId} at frame ${String(evidence.frame)}.`,
        },
        { type: 'image', data, mimeType: evidence.mimeType },
      ],
      structuredContent,
    }
  })

  registerAppTool(server, 'read_runtime_logs', {
    title: 'Read Three.js Runtime logs',
    description: 'Reads bounded cursor-based logs. Use runtimeRef from the latest Editor context. Omit target for ordinary checks; validation is isolated and requires no Editor grant. Active access consumes an Editor-issued one-shot authorization.',
    inputSchema: {
      ...runtimeHarnessAddressShape,
      target: runtimeHarnessTargetSchema,
      activeIntent: activeIntentSchema,
      cursor: z.number().int().nonnegative().default(0),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      timeoutMs: z.number().int().min(RUNTIME_COMMAND_MIN_TIMEOUT_MS).max(20_000).default(20_000),
    },
    outputSchema: runtimeEvidenceSchema.options[1].omit({ evidenceToken: true }),
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({
    target,
    activeIntent,
    cursor,
    level,
    limit,
    timeoutMs,
    ...address
  }, { _meta, signal }) => {
    void activeIntent
    const owner = runtimeOwner(_meta)!
    const evidence = runtimeEvidenceSchema.options[1].parse(
      await workspaces.requestRuntimeCommand(
        address,
        owner,
        'read-logs',
        target,
        { cursor, level, limit },
        timeoutMs,
        signal,
      ),
    )
    const { evidenceToken: _evidenceToken, ...structuredContent } = evidence
    return textResult(
      `Read ${String(evidence.entries.length)} Runtime log entries through cursor ${String(evidence.nextCursor)}.`,
      structuredContent,
    )
  })

  registerAppTool(server, 'simulate_player_actions', {
    title: 'Simulate Three.js player actions',
    description: 'Runs bounded normalized actions. Use runtimeRef from the latest Editor context. Omit target for ordinary checks; validation is isolated and requires no Editor grant. Active access consumes an Editor-issued one-shot authorization.',
    inputSchema: {
      ...runtimeHarnessAddressShape,
      target: runtimeHarnessTargetSchema,
      activeIntent: activeIntentSchema,
      actions: z.array(playerActionSchema).min(1).max(32),
      timeoutMs: z.number().int().min(RUNTIME_COMMAND_MIN_TIMEOUT_MS).max(20_000).default(20_000),
    },
    outputSchema: runtimeEvidenceSchema.options[2].omit({ evidenceToken: true }),
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ target, activeIntent, actions, timeoutMs, ...address }, { _meta, signal }) => {
    void activeIntent
    const owner = runtimeOwner(_meta)!
    const evidence = runtimeEvidenceSchema.options[2].parse(
      await workspaces.requestRuntimeCommand(
        address,
        owner,
        'simulate-actions',
        target,
        { actions },
        timeoutMs,
        signal,
      ),
    )
    const { evidenceToken: _evidenceToken, ...structuredContent } = evidence
    return textResult(
      `Runtime action evidence ${evidence.evidenceId}: ${evidence.status} at frame ${String(evidence.endFrame)}.`,
      structuredContent,
    )
  })

  registerAppTool(server, 'report_editor_scene', {
    title: 'Report Three.js Runtime editor scene',
    description: 'Records the editable Runtime object catalog for one exact Workspace revision.',
    inputSchema: {
      projectId: projectIdSchema,
      revision: revisionSchema,
      runId: z.string().uuid(),
      objects: z.array(runtimeEditorObjectSchema).max(MAX_RUNTIME_EDITOR_OBJECTS),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      revision: revisionSchema,
      objects: z.number().int().nonnegative(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, revision, runId, objects }, { _meta }) => {
    const document = runtimeEditorSceneSchema.parse({
      schemaVersion: 1,
      runId,
      objects,
    })
    await workspaces.reportEditorScene(
      projectId,
      revision,
      document,
      runId,
      runtimeOwner(_meta, false),
    )
    return textResult(`Recorded ${objects.length} Runtime editor objects.`, {
      projectId,
      revision,
      objects: objects.length,
    })
  })

  registerAppTool(server, 'inspect_editor', {
    title: 'Inspect Three.js editor objects',
    description:
      'Inspect this first for the canonical scene source route, object UUIDs, current material values, and the official Three.js Editor commands advertised for each object. For ordinary project edits, use only the returned project tools and canonical entry; do not inspect MCP or Harness implementation source.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string(),
      revision: revisionSchema,
      source: editorSourceSchema,
      runtimeContract: z.object({
        setupContext: z.string(),
        inputEvents: z.string(),
      }),
      objects: z.array(editorObjectSchema),
      editorChanges: z.array(editorChangeSchema),
    }),
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ projectId }, { _meta }) => {
    const workspace = await loadWorkspace(projectId)
    const snapshot = workspace ?? await store.load(projectId)
    const reported = workspace === undefined
      ? undefined
      : await workspaces.readEditorScene(
          projectId,
          snapshot.revision,
          undefined,
          runtimeOwner(_meta, false),
        )
    const parsedReported = runtimeEditorScene(reported)
    const objects = parsedReported?.objects ?? inspectEditor(snapshot.project)
    let changes: Array<z.infer<typeof editorChangeSchema>> = []
    if (workspace !== undefined
      && parsedReported !== undefined
      && workspace.manifest.files[WORKSPACE_EDITOR_STATE_PATH] !== undefined) {
      const [file] = await workspaces.readFiles(projectId, [{
        path: WORKSPACE_EDITOR_STATE_PATH,
      }])
      changes = editorChanges(
        workspaceEditorStateSchema.parse(JSON.parse(file!.text!)),
        parsedReported.objects as EditorObjectSnapshot[],
      )
    }
    const detail = {
      projectId,
      title: snapshot.title,
      revision: snapshot.revision,
      source: workspace === undefined
        ? {
            kind: 'scene-script' as const,
            readTool: 'inspect_project' as const,
            editTool: 'apply_scene_changes' as const,
            operation: 'replace_script' as const,
          }
        : {
            kind: 'workspace-entry' as const,
            entry: workspace.manifest.entry,
            entryAlias: posix.basename(workspace.manifest.entry),
            readTool: 'read_project_files' as const,
            editTool: 'apply_project_files' as const,
          },
      runtimeContract: {
        setupContext:
          'setup receives THREE, canvas, renderer, scene, camera, controls, runtime, moduleUrl, and resolveAsset.',
        inputEvents:
          'Use browser input listeners on canvas or window. Harness keyboard events are dispatched on canvas with bubbles enabled.',
      },
      objects,
      editorChanges: changes,
    }
    return textResult(`Three.js editor objects:\n${JSON.stringify(detail)}`, detail)
  })

  registerAppTool(server, 'apply_editor_commands', {
    title: 'Apply Three.js Editor commands',
    description: 'Applies one revision-checked official Three.js Editor MultiCmdsCommand batch.',
    inputSchema: {
      projectId: projectIdSchema,
      baseRevision: revisionSchema,
      runId: z.string().uuid().optional(),
      source: z.enum(['human', 'ai']).default('ai'),
      operations: z.array(editorCommandSchema).min(1).max(50),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string().optional(),
      revision: revisionSchema.optional(),
      kind: z.enum(['linked-workspace', 'managed-workspace']).optional(),
      commandTypes: z.array(z.string()).optional(),
      history: z.unknown().optional(),
      pendingProjection: pendingRuntimeProjectionSchema.optional(),
      conflict: z.literal(true).optional(),
      currentRevision: revisionSchema.optional(),
    }),
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model', 'app'],
      },
    },
  }, async ({ projectId, baseRevision, runId, source, operations }, { signal, _meta }) => {
    try {
      const workspace = await loadWorkspace(projectId)
      const snapshot = workspace ?? await store.load(projectId)
      if (snapshot.revision !== baseRevision) {
        throw new RevisionConflictError(snapshot.revision)
      }
      let applied: ReturnType<typeof applyEditorCommands>
      let summary: ProjectSummary | WorkspaceSummary
      let pendingProjection: z.infer<typeof pendingRuntimeProjectionSchema> | undefined
      if (workspace === undefined) {
        applied = applyEditorCommands(snapshot.project, operations)
        summary = await store.push(projectId, baseRevision, applied.project)
      } else {
        if (source === 'human' && runId === undefined) {
          throw new Error('Human Workspace editor commands require a Runtime runId')
        }
        const owner = runtimeOwner(_meta, false)
        const reported = runtimeEditorScene(await workspaces.readEditorScene(
          projectId,
          baseRevision,
          undefined,
          owner,
        ))
        if (reported === undefined) {
          if (runId !== undefined) {
            throw new Error('Runtime editor scene is unavailable for this run')
          }
          applied = applyEditorCommands(snapshot.project, operations)
          summary = await workspaces.apply(
            projectId,
            baseRevision,
            workspaceProjectChanges(applied.project),
            undefined,
            signal,
          )
          return textResult(
            `Applied official Three.js Editor commands to ${projectId}: `
            + applied.commandTypes.join(', '),
            {
              projectId,
              title: summary.title,
              revision: summary.revision,
              kind: workspace.kind,
              commandTypes: applied.commandTypes,
              history: applied.history,
            },
          )
        }
        if (runId !== undefined && runId !== reported.runId) {
          throw new Error('Runtime editor scene is unavailable for this run')
        }
        assertEditorOperationsAdvertised(
          reported.objects as EditorObjectSnapshot[],
          operations,
        )
        applied = applyEditorCommands(
          editorProjectFromSnapshots(
            snapshot.project,
            reported.objects as EditorObjectSnapshot[],
          ),
          operations,
        )
        let editorState: WorkspaceEditorState = {
          schemaVersion: 1,
          operations: [],
        }
        if (workspace.manifest.files[WORKSPACE_EDITOR_STATE_PATH] !== undefined) {
          const [file] = await workspaces.readFiles(projectId, [{
            path: WORKSPACE_EDITOR_STATE_PATH,
          }])
          editorState = workspaceEditorStateSchema.parse(JSON.parse(file!.text!))
        }
        const nextState = workspaceEditorStateSchema.parse({
          schemaVersion: 1,
          operations: compactEditorOperations([
            ...editorState.operations,
            ...operations,
          ]),
          ...editorState.qualityTier === undefined
            ? {}
            : { qualityTier: editorState.qualityTier },
          recentChanges: [
            ...(editorState.recentChanges ?? editorState.operations.map(operation => ({
              source: 'unknown' as const,
              operation,
            }))),
            ...operations.map(operation => ({ source, operation })),
          ].slice(-200),
        })
        const committed = await workspaces.apply(projectId, baseRevision, [{
          type: 'write',
          path: WORKSPACE_EDITOR_STATE_PATH,
          text: `${JSON.stringify(nextState, null, 2)}\n`,
        }], reported.runId, signal, owner, owner === undefined ? undefined : 600_000)
        summary = committed
        if (committed.pendingProjection !== undefined) {
          pendingProjection = {
            ...committed.pendingProjection,
            expiresAt: new Date(committed.pendingProjection.expiresAt).toISOString(),
          }
        }
      }
      return textResult(
        `Applied official Three.js Editor commands to ${projectId}: `
        + applied.commandTypes.join(', '),
        {
          projectId,
          title: summary.title,
          revision: summary.revision,
          ...'kind' in summary ? { kind: summary.kind } : {},
          commandTypes: applied.commandTypes,
          history: applied.history,
          ...pendingProjection === undefined ? {} : { pendingProjection },
        },
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return conflictResult(projectId, error)
    }
  })

  registerAppTool(server, 'read_project_files', {
    title: 'Read Three.js workspace files',
    description:
      'Reads bounded files from an explicitly registered workspace by projectId. For scene source, use the canonical entry or entryAlias returned by inspect_editor instead of searching first; do not search MCP or Harness implementation repositories for ordinary scene authoring.',
    inputSchema: {
      projectId: projectIdSchema,
      files: z.array(z.object({
        path: workspacePathSchema,
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      })).min(1).max(20),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      revision: revisionSchema,
      files: z.array(workspaceReadSchema),
    }),
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ projectId, files }) => {
    const snapshot = await workspaces.load(projectId)
    const result = await workspaces.readFiles(projectId, files)
    const modelResult = result.map(({ base64, ...file }) => (
      base64 === undefined ? file : { ...file, binary: 'available in structuredContent' }
    ))
    return textResult(`Workspace files:\n${JSON.stringify(modelResult)}`, {
      projectId,
      revision: snapshot.revision,
      files: result,
    })
  })

  registerAppTool(server, 'search_project', {
    title: 'Search Three.js workspace',
    description: 'Searches paths and bounded text content in an explicitly registered workspace.',
    inputSchema: {
      projectId: projectIdSchema,
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(100).default(50),
    },
    outputSchema: z.object({
      projectId: projectIdSchema,
      revision: revisionSchema,
      matches: z.array(z.object({
        path: workspacePathSchema,
        line: z.number().int().positive().optional(),
        text: z.string().optional(),
      })),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId, query, limit }) => {
    const snapshot = await workspaces.load(projectId)
    const matches = await workspaces.search(projectId, query, limit)
    return textResult(`Workspace search results:\n${JSON.stringify(matches)}`, {
      projectId,
      revision: snapshot.revision,
      matches,
    })
  })

  registerAppTool(server, 'apply_project_files', {
    title: 'Apply Three.js workspace file changes',
    description:
      'Atomically writes, moves, or deletes workspace files at one exact revision. Use the canonical workspace-relative entry or entryAlias returned by inspect_editor for scene source changes not represented by apply_editor_commands. The project-bound Editor is created or updated automatically; do not call open_editor again or inspect MCP/Harness implementation source.',
    inputSchema: {
      projectId: projectIdSchema,
      baseRevision: revisionSchema,
      changes: z.array(workspaceChangeSchema).min(1).max(100),
    },
    outputSchema: workspaceConflictOutputSchema,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model', 'app'],
      },
    },
  }, async ({ projectId, baseRevision, changes }, { signal }) => {
    try {
      return summaryResult(
        'Updated Three.js workspace files',
        await workspaces.apply(projectId, baseRevision, changes, undefined, signal),
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return conflictResult(projectId, error)
    }
  })

  registerAppTool(server, 'build_project', {
    title: 'Build Three.js workspace',
    description: 'Builds one exact Workspace revision with the pinned browser dependency profile.',
    inputSchema: {
      projectId: projectIdSchema,
      revision: revisionSchema,
    },
    outputSchema: buildOutputSchema,
    _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ projectId, revision }) => {
    const result = buildView(await workspaces.build(projectId, revision))
    const errors = result.diagnostics.filter(item => item.severity === 'error').length
    return textResult(
      result.status === 'ready'
        ? `Built ${projectId} at ${revision} with buildId ${result.buildId}: ${String(result.bundleBytes)} bundle bytes.`
        : `Build failed for ${projectId} at ${revision} with buildId ${result.buildId}: ${String(errors)} errors.`,
      result,
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
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['model'],
      },
    },
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
    description: 'Checks project sources/build and reports Runtime verification separately.',
    inputSchema: { projectId: projectIdSchema },
    outputSchema: z.object({
      projectId: projectIdSchema,
      title: z.string(),
      revision: revisionSchema,
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      runtimeStatus: z.enum(['not-reported', 'stale', 'current']),
      testedRevision: revisionSchema.optional(),
      testedAt: z.string().optional(),
      runId: z.string().uuid().optional(),
    }),
    _meta: { ui: { visibility: ['model'] } },
  }, async ({ projectId }, { _meta }) => {
    const workspace = await loadWorkspace(projectId)
    const snapshot = workspace ?? await store.load(projectId)
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
    if (workspace === undefined) {
      const scriptError = syntaxError(snapshot.project.script.source)
      if (scriptError !== undefined) errors.push(`script syntax error: ${scriptError}`)
    } else {
      const build = await workspaces.build(projectId, snapshot.revision)
      for (const diagnostic of build.diagnostics) {
        const location = diagnostic.file === undefined
          ? ''
          : `${diagnostic.file}`
            + `${diagnostic.line === undefined ? '' : `:${String(diagnostic.line)}`}`
            + `${diagnostic.column === undefined ? '' : `:${String(diagnostic.column)}`}: `
        const message = `${location}${diagnostic.message}`
        if (diagnostic.severity === 'error') errors.push(message)
        else warnings.push(message)
      }
    }
    const playDiagnostics = workspace === undefined
      ? await store.readDiagnostics(projectId)
      : await workspaces.readDiagnostics(projectId, runtimeOwner(_meta, false))
    let runtimeStatus: 'not-reported' | 'stale' | 'current'
    let diagnosticsProvenance: string
    if (playDiagnostics === undefined) {
      runtimeStatus = 'not-reported'
      warnings.push('Play diagnostics have not been reported')
      diagnosticsProvenance =
        ' Runtime verification is inconclusive because Play diagnostics have not been reported.'
    } else if (playDiagnostics.testedRevision !== snapshot.revision) {
      runtimeStatus = 'stale'
      warnings.push(`Play diagnostics apply to older revision ${playDiagnostics.testedRevision}`)
      diagnosticsProvenance =
        ` Runtime verification is inconclusive because Play diagnostics apply to older revision ${playDiagnostics.testedRevision}.`
    } else {
      runtimeStatus = 'current'
      errors.push(...playDiagnostics.errors)
      warnings.push(...playDiagnostics.warnings)
      diagnosticsProvenance =
        ` Diagnostics tested revision ${playDiagnostics.testedRevision}`
        + `${playDiagnostics.runId === undefined ? '' : ` with run ${playDiagnostics.runId}`}.`
    }
    if (workspace === undefined) {
      try {
        await store.listAssets(projectId)
      } catch (error) {
        errors.push(`asset validation error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return textResult(
      `Checked project sources/build for ${projectId} at revision ${snapshot.revision}: `
      + `${String(errors.length)} errors, ${String(warnings.length)} warnings.`
      + diagnosticsProvenance,
      {
        projectId,
        title: snapshot.title,
        revision: snapshot.revision,
        errors,
        warnings,
        runtimeStatus,
        ...playDiagnostics === undefined ? {} : {
          testedRevision: playDiagnostics.testedRevision,
          testedAt: playDiagnostics.updatedAt,
          ...playDiagnostics.runId === undefined ? {} : { runId: playDiagnostics.runId },
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
      workspace: workspaceViewSchema.optional(),
      editorOperations: z.array(editorCommandSchema).optional(),
      pendingProjection: pendingRuntimeProjectionSchema.optional(),
    }),
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, currentRevision }, { _meta }) => {
    const workspace = await loadWorkspace(projectId)
    const snapshot = workspace ?? await store.load(projectId)
    const changed = currentRevision !== snapshot.revision
    let editorOperations: EditorCommandOperation[] | undefined
    const owner = runtimeOwner(_meta, false)
    const pendingProjection = changed && workspace !== undefined && owner !== undefined
      ? await workspaces.pendingRuntimeProjection(projectId, snapshot.revision, owner)
      : undefined
    if (changed
      && workspace?.manifest.files[WORKSPACE_EDITOR_STATE_PATH] !== undefined) {
      const [file] = await workspaces.readFiles(projectId, [{
        path: WORKSPACE_EDITOR_STATE_PATH,
      }])
      editorOperations = workspaceEditorStateSchema.parse(
        JSON.parse(file!.text!),
      ).operations
    }
    return textResult(changed ? 'Project snapshot returned.' : 'Project is current.', {
      projectId,
      changed,
      revision: snapshot.revision,
      ...changed ? {
        project: snapshot.project,
        ...workspace === undefined ? {} : { workspace: workspaceView(workspace) },
        ...editorOperations === undefined ? {} : { editorOperations },
        ...pendingProjection === undefined ? {} : {
          pendingProjection: {
            ...pendingProjection,
            expiresAt: new Date(pendingProjection.expiresAt).toISOString(),
          },
        },
      } : {},
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
    outputSchema: workspaceConflictOutputSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, baseRevision, project }, { signal }) => {
    try {
      const workspace = await loadWorkspace(projectId)
      return summaryResult(
        'Saved Three.js project',
        workspace === undefined
          ? await store.push(projectId, baseRevision, project)
          : await workspaces.apply(
            projectId,
            baseRevision,
            workspaceProjectChanges(project),
            undefined,
            signal,
          ),
      )
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      return conflictResult(projectId, error)
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
      runId: z.string().uuid().optional(),
      errors: z.array(z.string().min(1).max(2_000)).max(20),
      warnings: z.array(z.string().min(1).max(2_000)).max(20),
    },
    outputSchema: diagnosticsSchema,
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ projectId, testedRevision, runId, errors, warnings }, { _meta }) => {
    const diagnostics = await (
      await loadWorkspace(projectId) === undefined
        ? store.reportDiagnostics(projectId, testedRevision, errors, warnings, runId)
        : workspaces.reportDiagnostics(
            projectId,
            testedRevision,
            errors,
            warnings,
            runId,
            runtimeOwner(_meta, false),
          )
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
    const workspace = await loadWorkspace(projectId)
    const json = `${JSON.stringify(
      workspace === undefined
        ? await store.exportProject(projectId)
        : await workspaces.export(projectId),
      null,
      2,
    )}\n`
    return textResult(`Exported Three.js project ${projectId}.`, {
      filename: workspace === undefined
        ? `${projectId}.threejs-project.json`
        : `${projectId}.threejs-workspace.json`,
      mediaType: 'application/json',
      json,
    })
  })

  server.registerResource(
    'workspace-build-artifact',
    new ResourceTemplate(BUILD_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: 'Three.js Workspace build artifact',
      description: 'A revision-bound browser bundle or source map from the pinned builder.',
    },
    async (uri): Promise<ReadResourceResult> => {
      const [projectIdValue, buildIdValue, artifactValue] =
        uri.pathname.split('/').filter(Boolean)
      const projectId = projectIdSchema.parse(projectIdValue)
      const buildId = buildIdSchema.parse(buildIdValue)
      const artifact = z.enum(['bundle.js', 'bundle.js.map']).parse(artifactValue)
      const text = await workspaces.readBuildArtifact(projectId, buildId, artifact)
      return {
        contents: [{
          uri: uri.href,
          mimeType: artifact === 'bundle.js'
            ? 'text/javascript'
            : 'application/json',
          text,
        }],
      }
    },
  )

  server.registerResource(
    'workspace-revision-asset',
    new ResourceTemplate(ASSET_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: 'Three.js Workspace revision asset',
      description: 'A hash-verified binary chunk bound to one exact project revision.',
    },
    async (uri): Promise<ReadResourceResult> => {
      const [projectIdValue, revisionValue, sha256Value, chunkValue] =
        uri.pathname.split('/').filter(Boolean)
      const projectId = projectIdSchema.parse(projectIdValue)
      const revision = revisionSchema.parse(revisionValue)
      const sha256 = revisionSchema.parse(sha256Value)
      const chunk = z.coerce.number().int().nonnegative().parse(chunkValue)
      const resource = await workspaces.readResourceChunk(
        projectId,
        revision,
        sha256,
        chunk,
      )
      return {
        contents: [{
          uri: uri.href,
          mimeType: resource.mediaType,
          blob: resource.bytes.toString('base64'),
        }],
      }
    },
  )

  server.registerResource('runtime-isolation-module-graph', RUNTIME_ISOLATION_FIXTURE_RESOURCE_URI, {
    title: 'Runtime isolation module graph',
    description: 'A deterministic two-module WebGL2 and WebGPU capability fixture.',
    mimeType: 'application/json',
  }, async (): Promise<ReadResourceResult> => ({
    contents: [{
      uri: RUNTIME_ISOLATION_FIXTURE_RESOURCE_URI,
      mimeType: 'application/json',
      text: JSON.stringify(RUNTIME_ISOLATION_FIXTURE_MANIFEST),
    }],
  }))

  server.registerResource('runtime-isolation-command-proof', RUNTIME_ISOLATION_COMMAND_PROOF_URI, {
    title: 'Runtime isolation Three.js Editor command proof',
    description: 'Round-trip evidence from the pinned Three.js r185 Command and History sources.',
    mimeType: 'application/json',
  }, async (): Promise<ReadResourceResult> => ({
    contents: [{
      uri: RUNTIME_ISOLATION_COMMAND_PROOF_URI,
      mimeType: 'application/json',
      text: JSON.stringify(officialCommandProof()),
    }],
  }))

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
    'workspace-root': { type: 'string', multiple: true },
    workspace: { type: 'string', multiple: true },
    'workspace-max-files': { type: 'string' },
    'workspace-max-file-bytes': { type: 'string' },
    'workspace-max-total-bytes': { type: 'string' },
  },
  strict: true,
})
const root = values.root ?? process.env.THREEJS_EDITOR_PROJECT_ROOT
if (root === undefined || root === '') {
  throw new Error('project root is required: pass --root or THREEJS_EDITOR_PROJECT_ROOT')
}
const positiveInteger = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

class SerializedStdioServerTransport extends StdioServerTransport {
  private sendTail = Promise.resolve()

  override send(
    message: Parameters<StdioServerTransport['send']>[0],
  ): Promise<void> {
    const send = this.sendTail.then(() => this.sendOne(message))
    this.sendTail = send.catch(() => {})
    return send
  }

  private async sendOne(
    message: Parameters<StdioServerTransport['send']>[0],
  ): Promise<void> {
    const before = process.stdout.listenerCount('drain')
    await super.send(message)
  }
}

await createServer(
  new ProjectStore(root),
  new WorkspaceStore(
    root,
    values['workspace-root'] ?? [],
    (values.workspace ?? []).map(workspaceRegistration),
    {
      maxFiles: positiveInteger('workspace-max-files', values['workspace-max-files']),
      maxFileBytes: positiveInteger(
        'workspace-max-file-bytes',
        values['workspace-max-file-bytes'],
      ),
      maxTotalBytes: positiveInteger(
        'workspace-max-total-bytes',
        values['workspace-max-total-bytes'],
      ),
    },
  ),
).connect(new SerializedStdioServerTransport())

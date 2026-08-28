import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l9sAAAAASUVORK5CYII=',
  'base64',
)

function glb(document, binary = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(document))
  const paddedJson = Buffer.concat([
    json,
    Buffer.alloc((4 - json.length % 4) % 4, 0x20),
  ])
  const paddedBinary = Buffer.concat([
    binary,
    Buffer.alloc((4 - binary.length % 4) % 4),
  ])
  const total = 12 + 8 + paddedJson.length + (paddedBinary.length === 0 ? 0 : 8 + paddedBinary.length)
  const result = Buffer.alloc(total)
  result.writeUInt32LE(0x46546c67, 0)
  result.writeUInt32LE(2, 4)
  result.writeUInt32LE(total, 8)
  result.writeUInt32LE(paddedJson.length, 12)
  result.writeUInt32LE(0x4e4f534a, 16)
  paddedJson.copy(result, 20)
  if (paddedBinary.length > 0) {
    const offset = 20 + paddedJson.length
    result.writeUInt32LE(paddedBinary.length, offset)
    result.writeUInt32LE(0x004e4942, offset + 4)
    paddedBinary.copy(result, offset + 8)
  }
  return result
}

const triangleGlb = glb({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
  accessors: [{
    bufferView: 0,
    componentType: 5126,
    count: 3,
    type: 'VEC3',
    min: [-0.5, 0, 0],
    max: [0.5, 1, 0],
  }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ name: 'Imported Triangle', mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
}, Buffer.from(new Float32Array([
  -0.5, 0, 0,
  0.5, 0, 0,
  0, 1, 0,
]).buffer))

test('server persists revisioned projects, copies conflicts, and confines its root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m1-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-outside-'))
  await symlink(outside, join(root, 'escape'), 'dir')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  })
  const client = new Client({
    name: 'threejs-editor-mcp-m1-test',
    version: '0.0.0',
  })

  await client.connect(transport)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), [
      'list_projects',
      'create_project',
      'create_workspace',
      'open_editor',
      'inspect_project',
      'register_runtime_run',
      'release_runtime_run',
      'grant_active_runtime_control',
      'pull_runtime_command',
      'start_runtime_command',
      'fail_runtime_command',
      'report_runtime_evidence',
      'capture_runtime_frame',
      'read_runtime_logs',
      'simulate_player_actions',
      'report_editor_scene',
      'inspect_editor',
      'apply_editor_commands',
      'read_project_files',
      'search_project',
      'apply_project_files',
      'build_project',
      'apply_scene_changes',
      'check_project',
      'pull_project',
      'push_project',
      'save_project_copy',
      'report_diagnostics',
      'put_asset',
      'export_project',
    ])

    const byName = new Map(listed.tools.map(tool => [tool.name, tool]))
    assert.deepEqual(byName.get('list_projects')?._meta?.ui?.visibility, ['model'])
    assert.deepEqual(byName.get('create_project')?._meta?.ui, {
      resourceUri: 'ui://threejs-editor/app',
      visibility: ['model'],
    })
    assert.deepEqual(byName.get('create_workspace')?._meta?.ui, {
      resourceUri: 'ui://threejs-editor/app',
      visibility: ['model'],
    })
    assert.deepEqual(byName.get('open_editor')?._meta?.ui, {
      resourceUri: 'ui://threejs-editor/app',
      visibility: ['model'],
    })
    assert.match(
      byName.get('open_editor')?.description ?? '',
      /project mutations update the same project-bound Editor automatically.*do not call open_editor again/,
    )
    assert.deepEqual(byName.get('inspect_project')?._meta?.ui?.visibility, ['model'])
    assert.deepEqual(byName.get('build_project')?._meta?.ui?.visibility, ['model', 'app'])
    assert.deepEqual(byName.get('register_runtime_run')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('release_runtime_run')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('report_editor_scene')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(
      byName.get('inspect_editor')?._meta?.ui?.visibility,
      ['model', 'app'],
    )
    assert.deepEqual(
      byName.get('apply_editor_commands')?._meta?.ui?.visibility,
      ['model', 'app'],
    )
    assert.deepEqual(byName.get('read_project_files')?._meta?.ui?.visibility, ['model', 'app'])
    assert.deepEqual(byName.get('search_project')?._meta?.ui?.visibility, ['model'])
    assert.deepEqual(byName.get('apply_project_files')?._meta?.ui?.visibility, ['model', 'app'])
    assert.match(
      byName.get('apply_project_files')?.description ?? '',
      /project-bound Editor is created or updated automatically.*do not call open_editor again/,
    )
    assert.deepEqual(byName.get('apply_scene_changes')?._meta?.ui?.visibility, ['model'])
    assert.deepEqual(byName.get('check_project')?._meta?.ui?.visibility, ['model'])
    assert.deepEqual(byName.get('pull_project')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('push_project')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('save_project_copy')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('report_diagnostics')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('put_asset')?._meta?.ui?.visibility, ['app'])
    assert.deepEqual(byName.get('export_project')?._meta?.ui?.visibility, ['app'])

    const created = await client.callTool({
      name: 'create_project',
      arguments: {
        projectId: 'm1-pong',
        title: 'Pong M1',
        template: 'pong',
      },
    })
    assert.equal(created.isError, undefined)
    assert.equal(created.structuredContent.projectId, 'm1-pong')
    assert.equal(created.structuredContent.title, 'Pong M1')
    const createdRevision = created.structuredContent.revision
    assert.match(createdRevision, /^[a-f0-9]{64}$/)

    const storedPng = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'court.png',
        mediaType: 'image/png',
        data: png.toString('base64'),
      },
    })
    assert.equal(storedPng.isError, undefined)
    assert.equal(storedPng.structuredContent.revision, createdRevision)
    assert.deepEqual(storedPng.structuredContent.asset, {
      name: 'court.png',
      mediaType: 'image/png',
      size: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    })

    const storedGlb = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'triangle.glb',
        mediaType: 'model/gltf-binary',
        data: triangleGlb.toString('base64'),
      },
    })
    assert.equal(storedGlb.isError, undefined)
    assert.equal(storedGlb.structuredContent.revision, createdRevision)
    assert.deepEqual(
      (await readdir(join(root, 'm1-pong', 'assets'))).sort(),
      ['court.png', 'triangle.glb'],
    )

    const invalidMagic = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'invalid.png',
        mediaType: 'image/png',
        data: Buffer.from('not a png').toString('base64'),
      },
    })
    assert.equal(invalidMagic.isError, true)

    const externalGlb = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'external.glb',
        mediaType: 'model/gltf-binary',
        data: glb({
          asset: { version: '2.0' },
          buffers: [{ byteLength: 1, uri: 'https://example.com/model.bin' }],
        }).toString('base64'),
      },
    })
    assert.equal(externalGlb.isError, true)

    const mismatchedType = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'wrong.png',
        mediaType: 'image/jpeg',
        data: png.toString('base64'),
      },
    })
    assert.equal(mismatchedType.isError, true)

    const oversized = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'large.png',
        mediaType: 'image/png',
        data: Buffer.alloc(256 * 1024 + 1).toString('base64'),
      },
    })
    assert.equal(oversized.isError, true)

    const projectPath = join(root, 'm1-pong', 'project.json')
    const createdBytes = await readFile(projectPath)
    assert.equal(createHash('sha256').update(createdBytes).digest('hex'), createdRevision)
    const createdProject = JSON.parse(createdBytes)
    assert.equal(createdProject.schemaVersion, 1)
    assert.equal(createdProject.title, 'Pong M1')
    assert.equal(createdProject.scene.object.name, 'Pong M1')
    assert.deepEqual(createdProject.editor, {
      layout: 'classic',
      cameraView: 'broadcast',
      operations: [],
    })
    const leftPaddle = createdProject.scene.object.children
      .find(child => child.name === 'Left Paddle')
    assert.equal(leftPaddle.matrix[12], -4.45)

    const projects = await client.callTool({
      name: 'list_projects',
      arguments: {},
    })
    assert.deepEqual(projects.structuredContent.projects, [{
      projectId: 'm1-pong',
      title: 'Pong M1',
      revision: createdRevision,
    }])

    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm1-pong' },
    })
    assert.equal(opened.structuredContent.revision, createdRevision)

    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.equal(pulled.structuredContent.changed, true)
    assert.equal(pulled.structuredContent.project.title, 'Pong M1')

    const unchanged = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: 'm1-pong',
        currentRevision: createdRevision,
      },
    })
    assert.deepEqual(unchanged.structuredContent, {
      projectId: 'm1-pong',
      changed: false,
      revision: createdRevision,
    })

    const texturedScene = structuredClone(pulled.structuredContent.project.scene)
    const ballObject = texturedScene.object.children.find(child => child.name === 'Ball')
    const ballMaterial = texturedScene.materials.find(material => material.uuid === ballObject.material)
    texturedScene.images = [{
      uuid: '00000000-0000-4000-8000-000000000001',
      url: `data:image/png;base64,${png.toString('base64')}`,
    }]
    texturedScene.textures = [{
      uuid: '00000000-0000-4000-8000-000000000002',
      image: texturedScene.images[0].uuid,
      mapping: 300,
      channel: 0,
      repeat: [1, 1],
      offset: [0, 0],
      center: [0, 0],
      rotation: 0,
      wrap: [1001, 1001],
      format: 1023,
      internalFormat: null,
      type: 1009,
      colorSpace: 'srgb',
      minFilter: 1008,
      magFilter: 1006,
      anisotropy: 1,
      flipY: true,
      generateMipmaps: true,
      premultiplyAlpha: false,
      unpackAlignment: 4,
    }]
    ballMaterial.map = texturedScene.textures[0].uuid
    const updatedProject = {
      ...pulled.structuredContent.project,
      title: 'Pong Human Edit',
      scene: texturedScene,
      editor: {
        layout: 'wide',
        cameraView: 'overhead',
        operations: [
          'Changed table layout from classic to wide',
          'Changed camera view from broadcast to overhead',
        ],
      },
    }
    const pushed = await client.callTool({
      name: 'push_project',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        project: updatedProject,
      },
    })
    assert.equal(pushed.isError, undefined)
    const pushedRevision = pushed.structuredContent.revision
    assert.notEqual(pushedRevision, createdRevision)
    assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).title, 'Pong Human Edit')
    const projectsAfterEdit = await client.callTool({
      name: 'list_projects',
      arguments: {},
    })
    assert.equal(projectsAfterEdit.content[0]?.text, 'Three.js projects: m1-pong (Pong Human Edit)')
    const inspected = await client.callTool({
      name: 'inspect_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.equal(inspected.structuredContent.projectId, 'm1-pong')
    assert.equal(inspected.structuredContent.title, 'Pong Human Edit')
    assert.equal(inspected.structuredContent.revision, pushedRevision)
    assert.equal(inspected.structuredContent.layout, 'wide')
    assert.equal(inspected.structuredContent.cameraView, 'overhead')
    assert.deepEqual(inspected.structuredContent.operations, [
      'Changed table layout from classic to wide',
      'Changed camera view from broadcast to overhead',
    ])
    assert.equal(
      inspected.structuredContent.objects.find(object => object.name === 'Left Paddle')
        ?.position[0],
      -4.45,
    )
    assert.match(inspected.structuredContent.script.source, /update\(\{ scene, input \}, delta\)/)
    assert.equal(inspected.structuredContent.script.syntaxError, undefined)
    assert.equal(inspected.structuredContent.diagnostics, undefined)
    assert.deepEqual(inspected.structuredContent.assets.map(asset => asset.name), [
      'court.png',
      'triangle.glb',
    ])
    assert.match(inspected.content[0]?.text, /"layout":"wide","cameraView":"overhead"/)
    assert.match(inspected.content[0]?.text, /Changed table layout from classic to wide/)
    const editorInspection = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'm1-pong' },
    })
    assert.deepEqual(editorInspection.structuredContent.source, {
      kind: 'scene-script',
      readTool: 'inspect_project',
      editTool: 'apply_scene_changes',
      operation: 'replace_script',
    })
    const fieldMaterial = editorInspection.structuredContent.objects
      .find(object => object.name === 'Field').material
    assert.equal(fieldMaterial.type, 'MeshStandardMaterial')
    assert.deepEqual(
      fieldMaterial.properties.map(property => property.name),
      ['color', 'roughness', 'metalness', 'opacity', 'transparent', 'wireframe'],
    )
    assert.deepEqual(
      (await readdir(join(root, 'm1-pong'))).sort(),
      ['assets', 'project.json'],
    )

    const stale = await client.callTool({
      name: 'push_project',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        project: {
          ...updatedProject,
          title: 'Stale overwrite',
        },
      },
    })
    assert.equal(stale.isError, true)
    assert.deepEqual(stale.structuredContent, {
      projectId: 'm1-pong',
      conflict: true,
      currentRevision: pushedRevision,
    })
    assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).title, 'Pong Human Edit')

    const staleAsset = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: createdRevision,
        name: 'stale.png',
        mediaType: 'image/png',
        data: png.toString('base64'),
      },
    })
    assert.equal(staleAsset.isError, true)
    assert.equal(staleAsset.structuredContent.currentRevision, pushedRevision)

    const checkedBeforePlay = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.deepEqual(checkedBeforePlay.structuredContent.errors, [])
    assert.deepEqual(
      checkedBeforePlay.structuredContent.warnings,
      ['Play diagnostics have not been reported'],
    )

    const invalidScript = await client.callTool({
      name: 'apply_scene_changes',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: pushedRevision,
        operations: [{ type: 'replace_script', source: 'return {' }],
      },
    })
    assert.equal(invalidScript.isError, true)
    assert.equal(
      createHash('sha256').update(await readFile(projectPath)).digest('hex'),
      pushedRevision,
    )

    const changed = await client.callTool({
      name: 'apply_scene_changes',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: pushedRevision,
        operations: [
          {
            type: 'update_object',
            target: 'Left Paddle',
            position: [-3.5, 0.18, 0],
            color: '#ff3366',
          },
          {
            type: 'add_primitive',
            primitive: 'sphere',
            name: 'Bonus',
            position: [0, 0.5, 1],
            color: '#ffffff',
          },
          {
            type: 'update_project',
            layout: 'compact',
            cameraView: 'courtside',
          },
        ],
      },
    })
    assert.equal(changed.isError, undefined)
    assert.deepEqual(changed.structuredContent.changes, [
      'Updated Left Paddle',
      'Added sphere Bonus',
      'Changed layout to compact',
      'Changed camera view to courtside',
    ])
    const changedRevision = changed.structuredContent.revision
    assert.notEqual(changedRevision, pushedRevision)

    const staleModelChange = await client.callTool({
      name: 'apply_scene_changes',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: pushedRevision,
        operations: [{ type: 'remove_object', target: 'Ball' }],
      },
    })
    assert.equal(staleModelChange.isError, true)
    assert.equal(staleModelChange.structuredContent.currentRevision, changedRevision)

    const reported = await client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm1-pong',
        testedRevision: changedRevision,
        errors: ['Ball escaped bounds'],
        warnings: ['Frame time exceeded 20 ms'],
      },
    })
    assert.equal(reported.isError, undefined)
    assert.equal(reported.structuredContent.testedRevision, changedRevision)
    assert.equal(
      createHash('sha256').update(await readFile(projectPath)).digest('hex'),
      changedRevision,
    )

    const checkedWithRuntimeError = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.deepEqual(checkedWithRuntimeError.structuredContent.errors, ['Ball escaped bounds'])
    assert.deepEqual(
      checkedWithRuntimeError.structuredContent.warnings,
      ['Frame time exceeded 20 ms'],
    )

    const fixed = await client.callTool({
      name: 'apply_scene_changes',
      arguments: {
        projectId: 'm1-pong',
        baseRevision: changedRevision,
        operations: [
          { type: 'remove_object', target: 'Bonus' },
          {
            type: 'replace_script',
            source: 'return { start() {}, update() {}, dispose() {} }',
          },
        ],
      },
    })
    assert.equal(fixed.isError, undefined)
    const fixedRevision = fixed.structuredContent.revision
    const fixedProject = JSON.parse(await readFile(projectPath, 'utf8'))
    assert.equal(fixedProject.scene.images[0].url.startsWith('data:image/png;base64,'), true)
    assert.equal(
      fixedProject.scene.materials.some(material => material.map === texturedScene.textures[0].uuid),
      true,
    )
    const checkedAfterFix = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.deepEqual(checkedAfterFix.structuredContent.errors, [])
    assert.deepEqual(checkedAfterFix.structuredContent.warnings, [
      `Play diagnostics apply to older revision ${changedRevision}`,
    ])

    const staleDiagnostics = await client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm1-pong',
        testedRevision: changedRevision,
        errors: [],
        warnings: [],
      },
    })
    assert.equal(staleDiagnostics.isError, true)
    assert.equal(
      createHash('sha256').update(await readFile(projectPath)).digest('hex'),
      fixedRevision,
    )
    assert.deepEqual(
      (await readdir(join(root, 'm1-pong'))).sort(),
      ['assets', 'diagnostics.json', 'project.json'],
    )

    const copied = await client.callTool({
      name: 'save_project_copy',
      arguments: {
        sourceProjectId: 'm1-pong',
        newProjectId: 'm1-pong-copy',
        project: {
          ...updatedProject,
          title: 'Pong Local Copy',
        },
      },
    })
    assert.equal(copied.isError, undefined)
    assert.equal(copied.structuredContent.projectId, 'm1-pong-copy')
    assert.equal(
      JSON.parse(await readFile(join(root, 'm1-pong-copy', 'project.json'), 'utf8')).title,
      'Pong Local Copy',
    )
    assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).title, 'Pong Human Edit')
    assert.deepEqual(
      (await readdir(join(root, 'm1-pong-copy', 'assets'))).sort(),
      ['court.png', 'triangle.glb'],
    )

    const exported = await client.callTool({
      name: 'export_project',
      arguments: { projectId: 'm1-pong' },
    })
    assert.equal(exported.isError, undefined)
    assert.equal(exported.structuredContent.filename, 'm1-pong.threejs-project.json')
    const exportDocument = JSON.parse(exported.structuredContent.json)
    assert.equal(exportDocument.format, 'threejs-editor-mcp')
    assert.equal(exportDocument.formatVersion, 1)
    assert.equal(exportDocument.revision, fixedRevision)
    assert.deepEqual(exportDocument.assets.map(asset => asset.name), [
      'court.png',
      'triangle.glb',
    ])
    assert.equal(exportDocument.assets[0].data, png.toString('base64'))

    const assetEscape = await client.callTool({
      name: 'create_project',
      arguments: { projectId: 'asset-escape', template: 'empty' },
    })
    await rm(join(root, 'asset-escape', 'assets'), { recursive: true })
    await symlink(outside, join(root, 'asset-escape', 'assets'), 'dir')
    const escapedAsset = await client.callTool({
      name: 'put_asset',
      arguments: {
        projectId: 'asset-escape',
        baseRevision: assetEscape.structuredContent.revision,
        name: 'escape.png',
        mediaType: 'image/png',
        data: png.toString('base64'),
      },
    })
    assert.equal(escapedAsset.isError, true)
    assert.deepEqual(await readdir(outside), [])

    const traversal = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: '../outside' },
    })
    assert.equal(traversal.isError, true)

    const escaped = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'escape' },
    })
    assert.equal(escaped.isError, true)

    const duplicate = await client.callTool({
      name: 'create_project',
      arguments: { projectId: 'm1-pong', template: 'empty' },
    })
    assert.equal(duplicate.isError, true)

    const resource = await client.readResource({
      uri: 'ui://threejs-editor/app',
    })
    const content = resource.contents[0]
    assert.equal(content?.mimeType, RESOURCE_MIME_TYPE)
    assert.equal(content?.text?.includes('data-three-editor'), true)
    assert.equal(content?.text?.includes('__THREE_M2__'), true)
    assert.equal(content?.text?.includes('__THREE_M4__'), true)
    assert.equal(content?.text?.includes('__THREE_M5__'), true)
    assert.equal(content?.text?.includes('__THREE_M6__'), true)
    assert.equal(content?.text?.includes('data-file-tree'), true)
    assert.equal(content?.text?.includes('data-file-source'), true)
    assert.equal(content?.text?.includes('data-ui-mode="scene-only"'), true)
    assert.equal(
      content?.text?.includes('data-visual-style="taste-ethereal-glass"'),
      true,
    )
    assert.equal(
      content?.text?.includes('data-ui-direction="ethereal-glass"'),
      true,
    )
    assert.equal(content?.text?.includes('>Files</button>'), false)
    assert.equal(content?.text?.includes('>Script</button>'), false)
    assert.equal(content?.text?.includes('class="brand"'), false)
    assert.equal(content?.text?.includes('class="scene-settings"'), false)
    assert.equal(content?.text?.includes('Scene graph'), true)
    assert.equal(content?.text?.includes('Properties'), true)
    assert.equal(content?.text?.includes('data-fullscreen'), true)
    assert.equal(content?.text?.includes('requestDisplayMode'), true)
    assert.equal(content?.text?.includes('updateModelContext'), true)
    assert.equal(content?.text?.includes('supersedes every earlier Runtime identity'), true)
    assert.equal(content?.text?.includes('data-runtime-sandbox'), true)
    assert.equal(content?.text?.includes('sandbox="allow-scripts"'), true)
    assert.equal(content?.text?.includes('allow-same-origin'), false)
    assert.equal(content?.text?.match(/\.onteardown\s*=/g)?.length, 1)
    assert.equal(content?.text?.includes('<script src='), false)
    assert.equal(content?.text?.includes('<link '), false)
    assert.deepEqual(content?._meta?.ui?.csp, {
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    })

    const resources = await client.listResources()
    assert.deepEqual(
      resources.resources.map(item => item.uri).sort(),
      [
        'threejs-m5://official-editor/command-proof',
        'threejs-m5://runtime/module-graph',
        'ui://threejs-editor/app',
      ],
    )
    const runtimeResource = await client.readResource({
      uri: 'threejs-m5://runtime/module-graph',
    })
    const runtimeManifest = JSON.parse(runtimeResource.contents[0]?.text)
    assert.equal(runtimeManifest.schemaVersion, 1)
    assert.equal(runtimeManifest.entry, 'main.js')
    assert.deepEqual(
      runtimeManifest.modules.map(module => module.path),
      ['color.js', 'main.js'],
    )
    assert.deepEqual(runtimeManifest.modules[1].dependencies, [{
      token: '__M5_COLOR_MODULE__',
      path: 'color.js',
    }])

    const commandResource = await client.readResource({
      uri: 'threejs-m5://official-editor/command-proof',
    })
    const commandProof = JSON.parse(commandResource.contents[0]?.text)
    assert.deepEqual(commandProof, {
      upstream: 'three.js r185',
      commandTypes: [
        'AddObjectCommand',
        'SetPositionCommand',
        'SetMaterialValueCommand',
        'MultiCmdsCommand',
        'History',
      ],
      addObjectRoundTrip: true,
      historyRoundTrip: true,
      humanAiEquivalent: true,
      batchUndoRedo: true,
      finalPosition: [1.25, 2.5, -0.75],
      finalRoughness: 0.35,
    })
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

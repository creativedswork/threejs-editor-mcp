import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import test from 'node:test'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m7-projects-'))
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-m7-workspaces-'))
  const workspace = join(parent, 'builder-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, '.threejs-editor'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'm7-builder-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, '.threejs-editor', 'project.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'linked-workspace',
    title: 'M7 Builder Game',
    entry: 'src/main.ts',
    backend: 'webgpu',
    dependencies: { three: '0.185.1' },
    runtime: {
      debugModes: ['final', 'topology', 'no-livery'],
      qualityTiers: ['default'],
    },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'shader.glsl'), 'void main() { gl_Position = vec4(0.0); }\n')
  await writeFile(join(workspace, 'src', 'value.ts'), 'export const emittedParts: number = 62\n')
  await writeFile(join(workspace, 'src', 'main.ts'), `
import * as THREE from 'three/webgpu'
import { color } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import shader from './shader.glsl?raw'
import { emittedParts } from './value'

export default {
  backend: 'webgpu',
  setup({ scene }) {
    scene.background = new THREE.Color(0x05070b)
    return {
      metrics: () => ({
        emittedParts,
        shaderBytes: shader.length,
        tslColor: String(color(0xff0000)),
        controls: OrbitControls.name,
      }),
    }
  },
}
`.trimStart())

  const client = new Client({
    name: 'threejs-editor-mcp-m7-builder-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      parent,
      '--workspace',
      `m7-builder=${workspace}`,
    ],
  }))
  return {
    client,
    root,
    workspace,
    async close() {
      await client.close()
      await rm(root, { recursive: true, force: true })
      await rm(parent, { recursive: true, force: true })
    },
  }
}

test('M7 builds a revision-bound Three.js VFS and reports source diagnostics', async () => {
  const game = await fixture()
  try {
    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const revision = opened.structuredContent.revision
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm7-builder', revision },
    })
    assert.equal(built.isError, undefined)
    assert.equal(built.structuredContent.status, 'ready')
    assert.equal(built.structuredContent.backend, 'webgpu')
    assert.equal(built.structuredContent.entry, 'src/main.ts')
    assert.match(built.structuredContent.buildId, /^[a-f0-9]{64}$/)
    assert.match(
      built.content[0].text,
      new RegExp(`buildId ${built.structuredContent.buildId}`),
    )
    assert.ok(built.structuredContent.bundleBytes > 500_000)
    assert.ok(built.structuredContent.sourceMapBytes > 500_000)
    assert.ok(built.structuredContent.inputs.includes('src/main.ts'))
    assert.ok(built.structuredContent.inputs.includes('src/value.ts'))
    assert.equal(built.structuredContent.diagnostics.length, 0)

    const bundle = await game.client.readResource({
      uri: built.structuredContent.bundleUri,
    })
    assert.match(bundle.contents[0].text, /M7 Builder Game|emittedParts|shaderBytes/)
    assert.doesNotMatch(bundle.contents[0].text, /\/Users\//)

    const sourceMapResource = await game.client.readResource({
      uri: built.structuredContent.sourceMapUri,
    })
    const sourceMap = JSON.parse(sourceMapResource.contents[0].text)
    assert.ok(sourceMap.sources.includes('workspace:///src/main.ts'))
    assert.ok(sourceMap.sources.includes('workspace:///src/value.ts'))
    assert.equal(sourceMap.sources.some(source => source.startsWith('/Users/')), false)

    const buildDirectory = join(
      game.workspace,
      '.threejs-editor',
      'builds',
      built.structuredContent.buildId,
    )
    const before = await stat(join(buildDirectory, 'bundle.js'))
    const cached = await game.client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm7-builder', revision },
    })
    const after = await stat(join(buildDirectory, 'bundle.js'))
    assert.equal(cached.structuredContent.buildId, built.structuredContent.buildId)
    assert.equal(after.mtimeMs, before.mtimeMs)

    const changed = await game.client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'm7-builder',
        baseRevision: revision,
        changes: [{
          type: 'write',
          path: 'src/main.ts',
          text: 'export default {\\n  setup( {\\n}\\n',
        }],
      },
    })
    const brokenRevision = changed.structuredContent.revision
    const failed = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: brokenRevision,
      },
    })
    assert.equal(failed.structuredContent.status, 'failed')
    assert.equal(failed.structuredContent.bundleUri, undefined)
    assert.match(
      failed.content[0].text,
      new RegExp(`buildId ${failed.structuredContent.buildId}`),
    )
    const error = failed.structuredContent.diagnostics.find(item => item.severity === 'error')
    assert.equal(error.file, 'src/main.ts')
    assert.ok(error.line >= 1)
    assert.ok(error.column >= 1)

    const checked = await game.client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm7-builder' },
    })
    assert.ok(checked.structuredContent.errors.some(message => message.includes('src/main.ts:')))
    await assert.rejects(readFile(join(
      game.workspace,
      '.threejs-editor',
      'builds',
      failed.structuredContent.buildId,
      'bundle.js',
    )))
  } finally {
    await game.close()
  }
})

test('M7 discovers gallery projects and opens one through the MCP App contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m7-gallery-projects-'))
  const repository = await mkdtemp(join(tmpdir(), 'threejs-editor-m7-gallery-repository-'))
  const examples = join(repository, 'dev', 'example-gallery', 'examples')
  const projectPath = 'threejs-procedural-geometry/formula-one-race-car'
  const sourceProjectPath = `dev/example-gallery/examples/${projectPath}`
  const project = join(examples, projectPath)
  await mkdir(project, { recursive: true })
  await mkdir(join(repository, 'dev', 'example-gallery', 'support'), { recursive: true })
  await mkdir(join(repository, 'skills', 'threejs-procedural-geometry'), { recursive: true })
  await mkdir(join(examples, 'unrelated-large-example'), { recursive: true })
  await mkdir(join(examples, 'second-example'), { recursive: true })
  await writeFile(join(project, 'example.json'), JSON.stringify({
    title: 'Formula One Race Car',
    backend: 'WebGPU / TSL node materials',
    debugModes: [{ value: 'final' }, { value: 'topology' }],
  }))
  await writeFile(join(project, 'scene.js'), `
import { createCar } from './race-car-scene.js'
export default {
  backend: 'webgpu',
  setup({ scene }) {
    scene.add(createCar())
    return { metrics: () => ({ emittedParts: 62 }) }
  },
}
`.trimStart())
  await writeFile(join(project, 'race-car-scene.js'), `
import { createStage } from '/dev/example-gallery/support/studio-stage.js'
import { createModel } from '/skills/threejs-procedural-geometry/race-car-model.js'
export function createCar() {
  createStage()
  return createModel()
}
`.trimStart())
  await writeFile(
    join(repository, 'dev', 'example-gallery', 'support', 'studio-stage.js'),
    'export function createStage() { return true }\n',
  )
  await writeFile(
    join(repository, 'skills', 'threejs-procedural-geometry', 'race-car-model.js'),
    "import * as THREE from 'three/webgpu'\nexport function createModel() { return new THREE.Group() }\n",
  )
  await writeFile(
    join(examples, 'unrelated-large-example', 'texture.bin'),
    Buffer.alloc(1024 * 1024 + 1),
  )
  await writeFile(
    join(examples, 'second-example', 'example.json'),
    JSON.stringify({ title: 'Second Example', backend: 'WebGL' }),
  )
  await writeFile(
    join(examples, 'second-example', 'scene.js'),
    "import '/private.js'\nexport default { setup() { return {} } }\n",
  )
  await writeFile(join(repository, 'private.js'), 'export const privateValue = true\n')
  const sourceFiles = [
    join(project, 'scene.js'),
    join(project, 'race-car-scene.js'),
    join(repository, 'dev', 'example-gallery', 'support', 'studio-stage.js'),
    join(repository, 'skills', 'threejs-procedural-geometry', 'race-car-model.js'),
  ]
  const originalSources = await Promise.all(sourceFiles.map(path => readFile(path)))

  const client = new Client({
    name: 'threejs-editor-mcp-m7-gallery-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))
  try {
    const narrowMeta = {
      'ai.deepseek.dsh/workspace': { cwd: examples },
    }
    const narrowList = await client.callTool({
      name: 'list_projects',
      arguments: {},
      _meta: narrowMeta,
    })
    const narrowCar = narrowList.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath.endsWith('formula-one-race-car'),
    )
    assert.equal(narrowList.structuredContent.workspaceProjects.length, 2)
    assert.equal(narrowCar.projectPath, projectPath)
    assert.equal(narrowCar.available, true)
    assert.equal(narrowCar.issue, undefined)
    assert.equal(narrowCar.backend, 'webgpu')
    assert.equal(narrowCar.title, 'Formula One Race Car')
    const restricted = narrowList.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath === 'second-example',
    )
    assert.equal(restricted.available, false)
    assert.match(restricted.issue, /outside the selected DSH workspace/)
    assert.equal(JSON.stringify(narrowList.structuredContent).includes(repository), false)

    const ambiguous = await client.callTool({
      name: 'open_editor',
      arguments: {},
      _meta: narrowMeta,
    })
    assert.equal(ambiguous.isError, true)
    assert.match(ambiguous.content[0].text, /contains 2 Three\.js examples/)
    assert.match(ambiguous.content[0].text, /Do not run npm/)

    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: narrowCar.projectPath },
      _meta: narrowMeta,
    })
    assert.equal(opened.isError, undefined)
    assert.match(opened.structuredContent.projectId, /^example-[a-f0-9]{56}$/)
    assert.equal(opened.structuredContent.title, 'Formula One Race Car')
    assert.equal(opened.structuredContent.kind, 'managed-workspace')
    assert.equal(JSON.stringify(opened.structuredContent).includes(repository), false)

    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready')
    assert.equal(built.structuredContent.backend, 'webgpu')
    assert.deepEqual(built.structuredContent.diagnostics, [])
    assert.ok(built.structuredContent.inputs.includes(`${sourceProjectPath}/scene.js`))
    assert.ok(built.structuredContent.inputs.includes(
      'skills/threejs-procedural-geometry/race-car-model.js',
    ))
    assert.ok(built.structuredContent.inputs.includes('threejs.editor.json'))

    const carUuid = '11111111-1111-4111-8111-111111111111'
    const reported = await client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
        objects: [{
          uuid: carUuid,
          path: 'scene/VF-26#0',
          name: 'VF-26',
          type: 'Group',
          visible: true,
          position: [0, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          commands: [
            'set_position',
            'set_rotation',
            'set_scale',
            'set_name',
            'set_visible',
          ],
        }],
      },
    })
    assert.equal(reported.structuredContent.objects, 1)

    const inspected = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(inspected.structuredContent.objects[0].name, 'VF-26')
    assert.equal(inspected.structuredContent.objects[0].uuid, carUuid)

    const edited = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: opened.structuredContent.projectId,
        baseRevision: opened.structuredContent.revision,
        source: 'human',
        operations: [{
          type: 'set_position',
          objectUuid: carUuid,
          value: [0.25, 0, 0],
        }],
      },
    })
    assert.deepEqual(edited.structuredContent.commandTypes, ['SetPositionCommand'])
    assert.notEqual(edited.structuredContent.revision, opened.structuredContent.revision)
    assert.deepEqual(
      JSON.parse(await readFile(join(
        root,
        '.managed-workspaces',
        opened.structuredContent.projectId,
        'threejs.editor.json',
      ), 'utf8')),
      {
        schemaVersion: 1,
        operations: [{
          type: 'set_position',
          objectUuid: carUuid,
          value: [0.25, 0, 0],
        }],
        recentChanges: [{
          source: 'human',
          operation: {
            type: 'set_position',
            objectUuid: carUuid,
            value: [0.25, 0, 0],
          },
        }],
      },
    )
    const pulledEditorRevision = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        currentRevision: opened.structuredContent.revision,
      },
    })
    assert.equal(pulledEditorRevision.structuredContent.changed, true)
    assert.equal(
      pulledEditorRevision.structuredContent.revision,
      edited.structuredContent.revision,
    )
    assert.deepEqual(pulledEditorRevision.structuredContent.editorOperations, [{
      type: 'set_position',
      objectUuid: carUuid,
      value: [0.25, 0, 0],
    }])
    const inspectedAfterEdit = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(inspectedAfterEdit.structuredContent.revision, edited.structuredContent.revision)
    assert.deepEqual(inspectedAfterEdit.structuredContent.objects[0].position, [0.25, 0, 0])
    const projectAfterEdit = await client.callTool({
      name: 'inspect_project',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(projectAfterEdit.structuredContent.objects[0].name, 'VF-26')
    assert.deepEqual(projectAfterEdit.structuredContent.editorChanges, [{
      source: 'human',
      type: 'set_position',
      objectUuid: carUuid,
      objectName: 'VF-26',
      objectPath: 'scene/VF-26#0',
      value: [0.25, 0, 0],
    }])
    const rebuilt = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: edited.structuredContent.revision,
      },
    })
    assert.equal(rebuilt.structuredContent.status, 'ready')
    assert.ok(rebuilt.structuredContent.inputs.includes('threejs.editor.json'))

    const repositoryMeta = {
      'ai.deepseek.dsh/workspace': { cwd: repository },
    }
    const listed = await client.callTool({
      name: 'list_projects',
      arguments: {},
      _meta: repositoryMeta,
    })
    const car = listed.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath === sourceProjectPath,
    )
    assert.equal(car.available, true)
    assert.equal(car.backend, 'webgpu')
    assert.equal(car.title, 'Formula One Race Car')
    for (const [index, path] of sourceFiles.entries()) {
      assert.deepEqual(await readFile(path), originalSources[index])
    }
    await assert.rejects(stat(join(repository, '.threejs-editor')))
    await assert.rejects(stat(join(examples, '.threejs-editor')))
    await assert.rejects(stat(join(repository, 'node_modules')))
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(repository, { recursive: true, force: true })
  }
})

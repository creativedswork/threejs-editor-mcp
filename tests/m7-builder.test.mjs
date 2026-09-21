import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { SourceMap } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import test from 'node:test'

const serverPath = resolve(
  process.env.THREEJS_EDITOR_MCP_SERVER
    ?? fileURLToPath(new URL('../dist/server.js', import.meta.url)),
)
const runtimeMeta = {
  'ai.deepseek.dsh/session': {
    sessionId: 'm7-builder-tests',
    connectionGeneration: '11111111-2222-4333-8444-555555555555',
  },
}

async function activateRuntime(client, { projectId, revision, runId, buildId }) {
  const build = buildId === undefined
    ? await client.callTool({
        name: 'build_project',
        arguments: { projectId, revision },
      })
    : { structuredContent: { status: 'ready', buildId } }
  assert.equal(build.structuredContent.status, 'ready')
  const prepared = await client.callTool({
    name: 'prepare_runtime_run',
    arguments: {
      projectId,
      revision,
      buildId: build.structuredContent.buildId,
      runId,
      nonce: randomUUID(),
    },
    _meta: runtimeMeta,
  })
  assert.equal(prepared.isError, undefined)
  const committed = await client.callTool({
    name: 'commit_runtime_run',
    arguments: {
      projectId,
      runtimeRef: prepared.structuredContent.runtimeRef,
    },
    _meta: runtimeMeta,
  })
  assert.equal(committed.isError, undefined)
  return committed.structuredContent
}

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
  await writeFile(
    join(workspace, 'src', 'shader.glsl'),
    '// "./missing-shader.png"\nvoid main() { gl_Position = vec4(0.0); }\n',
  )
  await writeFile(join(workspace, 'src', 'value.ts'), 'export const emittedParts: number = 62\n')
  await writeFile(join(workspace, 'src', 'main.ts'), `
import * as THREE from 'three/webgpu'
import { color } from 'three/tsl'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import shader from './shader.glsl?raw'
import { emittedParts } from './value'
const shaderComment = \`// "./missing-template.png"
void main() {}\`

export default {
  backend: 'webgpu',
  setup({ scene }) {
    scene.background = new THREE.Color(0x05070b)
    return {
      metrics: () => ({
        emittedParts,
        shaderBytes: shader.length,
        templateBytes: shaderComment.length,
        tslColor: String(color(0xff0000)),
        controls: OrbitControls.name,
        ktx2: KTX2Loader.name,
      }),
    }
  },
}
`.trimStart())

  const connect = async () => {
    const next = new Client({
      name: 'threejs-editor-mcp-m7-builder-test',
      version: '0.0.0',
    })
    await next.connect(new StdioClientTransport({
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
    return next
  }
  let client = await connect()
  return {
    get client() {
      return client
    },
    root,
    workspace,
    connect,
    async restart() {
      await client.close()
      client = await connect()
    },
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
    assert.match(
      bundle.contents[0].text,
      /https:\/\/threejs-editor\.invalid\/runtime\/entry\.js/,
    )
    assert.doesNotMatch(bundle.contents[0].text, /import\.meta\.url/)
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

    const bundlePath = join(buildDirectory, 'bundle.js')
    const sourceMapPath = join(buildDirectory, 'bundle.js.map')
    const originalBundle = await readFile(bundlePath)
    const originalSourceMap = await readFile(sourceMapPath)
    const corrupt = bytes => {
      const copy = Buffer.from(bytes)
      copy[0] ^= 1
      return copy
    }
    await writeFile(bundlePath, corrupt(originalBundle))
    await writeFile(sourceMapPath, corrupt(originalSourceMap))
    await assert.rejects(
      game.client.readResource({ uri: built.structuredContent.bundleUri }),
      /build artifacts do not match/,
    )
    const corruptRuntime = await game.client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        revision,
        buildId: built.structuredContent.buildId,
        runId: 'aaaaaaaa-1111-4111-8111-111111111111',
        nonce: 'bbbbbbbb-2222-4222-8222-222222222222',
      },
      _meta: runtimeMeta,
    })
    assert.equal(corruptRuntime.isError, true)
    assert.match(corruptRuntime.content[0].text, /build artifacts do not match/)
    const repaired = await game.client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm7-builder', revision },
    })
    assert.equal(repaired.structuredContent.status, 'ready')
    assert.deepEqual(await readFile(bundlePath), originalBundle)
    assert.deepEqual(await readFile(sourceMapPath), originalSourceMap)

    const buildMetadataPath = join(buildDirectory, 'build.json')
    const forgedBundle = corrupt(originalBundle)
    const forgedMetadata = JSON.parse(await readFile(buildMetadataPath, 'utf8'))
    forgedMetadata.bundleSha256 = createHash('sha256').update(forgedBundle).digest('hex')
    await writeFile(bundlePath, forgedBundle)
    await writeFile(buildMetadataPath, `${JSON.stringify(forgedMetadata, null, 2)}\n`)
    await assert.rejects(
      game.client.readResource({ uri: built.structuredContent.bundleUri }),
      /build artifacts do not match/,
    )
    const repairedForgery = await game.client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm7-builder', revision },
    })
    assert.equal(repairedForgery.structuredContent.status, 'ready')
    assert.deepEqual(await readFile(bundlePath), originalBundle)

    const runId = '11111111-2222-4333-8444-555555555555'
    const registered = await activateRuntime(game.client, {
      projectId: 'm7-builder',
      revision,
      buildId: built.structuredContent.buildId,
      runId,
    })
    const staleObject = {
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      path: 'scene/Stale#0',
      name: 'Stale Runtime object',
      type: 'Mesh',
      visible: true,
      position: [0, 0, 0],
      rotationDegrees: [0, 0, 0],
      scale: [1, 1, 1],
      commands: ['set_position'],
    }
    await game.client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: 'm7-builder',
        revision,
        runId,
        objects: [staleObject],
      },
      _meta: runtimeMeta,
    })
    const reported = await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        runId,
        errors: [],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(reported.structuredContent.testedRevision, revision)
    assert.equal(reported.structuredContent.runId, runId)
    const checkedReady = await game.client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(checkedReady.structuredContent.testedRevision, revision)
    assert.equal(checkedReady.structuredContent.runId, runId)
    assert.match(
      checkedReady.content[0].text,
      new RegExp(`Diagnostics tested revision ${revision} with run ${runId}\\.$`),
    )

    const newerRunId = '22222222-3333-4444-8555-666666666666'
    const newerRuntime = await activateRuntime(game.client, {
      projectId: 'm7-builder',
      revision,
      buildId: built.structuredContent.buildId,
      runId: newerRunId,
    })
    const staleRelease = await game.client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        runtimeRef: registered.runtimeRef,
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleRelease.isError, true)
    assert.match(staleRelease.content[0].text, /Runtime reference is stale/)
    const inspectedAfterNewRun = await game.client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(inspectedAfterNewRun.structuredContent.objects.some(
      object => object.uuid === staleObject.uuid,
    ), false)
    const staleScene = await game.client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: 'm7-builder',
        revision,
        runId,
        objects: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleScene.isError, true)
    assert.match(staleScene.content[0].text, /runtime run changed/)
    await game.client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: 'm7-builder',
        revision,
        runId: newerRunId,
        objects: [],
      },
      _meta: runtimeMeta,
    })
    const staleSave = await game.client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: 'm7-builder',
        baseRevision: revision,
        runId,
        source: 'human',
        operations: [{
          type: 'set_position',
          objectUuid: staleObject.uuid,
          value: [1, 0, 0],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleSave.isError, true)
    assert.match(staleSave.content[0].text, /unavailable for this run/)
    const missingRun = await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        errors: [],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(missingRun.isError, true)
    assert.match(missingRun.content[0].text, /require a Runtime runId/)
    const staleRun = await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        runId,
        errors: ['stale run'],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleRun.isError, true)
    assert.match(staleRun.content[0].text, /runtime run changed/)
    const currentRun = await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        runId: newerRunId,
        errors: [],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(currentRun.structuredContent.runId, newerRunId)

    const invalidSyntax = await game.client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'm7-builder',
        baseRevision: revision,
        changes: [{
          type: 'write',
          path: 'src/main.ts',
          text: 'export default { setup() { return -00002 } }\n',
        }],
      },
    })
    assert.equal(invalidSyntax.isError, true)
    assert.match(invalidSyntax.content[0].text, /Legacy octal literals/)
    const afterInvalidSyntax = await game.client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: 'm7-builder',
        currentRevision: revision,
      },
    })
    assert.equal(afterInvalidSyntax.structuredContent.changed, false)

    const changed = await game.client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'm7-builder',
        baseRevision: revision,
        changes: [{
          type: 'write',
          path: 'src/main.ts',
          text: "import './missing.js'\nexport default {}\n",
        }],
      },
    })
    const brokenRevision = changed.structuredContent.revision
    const released = await game.client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        runtimeRef: newerRuntime.runtimeRef,
      },
      _meta: runtimeMeta,
    })
    assert.equal(released.structuredContent.released, true)
    const releasedAgain = await game.client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        runtimeRef: newerRuntime.runtimeRef,
      },
      _meta: runtimeMeta,
    })
    assert.equal(releasedAgain.isError, true)
    assert.match(releasedAgain.content[0].text, /Runtime reference is stale/)
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
    assert.equal(checked.structuredContent.runId, undefined)
    assert.equal(checked.structuredContent.warnings.includes(
      `Play diagnostics apply to older revision ${revision}`,
    ), false)
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

test('M8 stores repeated asset aliases and CSS payloads once', async () => {
  const game = await fixture()
  try {
    const asset = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKGQAAAABJRU5ErkJggg==',
      'base64',
    )
    await mkdir(join(game.workspace, 'src', 'assets'), { recursive: true })
    await writeFile(join(game.workspace, 'src', 'assets', 'shared.png'), asset)
    await writeFile(
      join(game.workspace, 'src', 'style.css'),
      Array.from(
        { length: 64 },
        (_, index) => `.asset-${String(index)}{background:url("./assets/shared.png?v=${String(index)}")}`,
      ).join('\n'),
    )
    await writeFile(
      join(game.workspace, 'src', 'assets.json'),
      JSON.stringify({
        './assets/shared.png?v=key': 'metadata',
        texture: './assets/shared.png?v=json',
      }),
    )
    await writeFile(
      join(game.workspace, 'src', 'main.ts'),
      `import config from './assets.json'
import styles from './style.css'
const configKeyValue = config['./assets/shared.png?v=key']
const computed = { ['./assets/shared.png?v=computed']: 'metadata' }
const computedKeyValue = computed['./assets/shared.png?v=computed']
const assets = [
${Array.from(
    { length: 64 },
    (_, index) => `  './assets/shared.png?v=${String(index)}',`,
  ).join('\n')}
]
export default {
  setup() {
    return { metrics: () => ({ assets, computedKeyValue, config, configKeyValue, styles }) }
  },
}
`,
    )

    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready')
    const bundle = await game.client.readResource({
      uri: built.structuredContent.bundleUri,
    })
    assert.equal(
      bundle.contents[0].text.split(asset.toString('base64')).length - 1,
      1,
    )
    assert.doesNotMatch(bundle.contents[0].text, /data:image\/png;base64/)
    assert.match(bundle.contents[0].text, /__THREEJS_EDITOR_REGISTER_INLINE_ASSET__/)
    assert.doesNotMatch(bundle.contents[0].text, /\.\/assets\/shared\.png\?v=json/)
    const jsonAssetHash = createHash('sha256')
      .update('src/assets.json\0./assets/shared.png?v=json')
      .digest('base64url')
    const jsonAssetAlias =
      `~${jsonAssetHash.slice(0, './assets/shared.png?v=json'.length - 1)}`
    assert.equal(
      bundle.contents[0].text.match(new RegExp(jsonAssetAlias, 'g'))?.length,
      2,
    )
    assert.match(bundle.contents[0].text, /\.\/assets\/shared\.png\?v=key/)
    assert.match(bundle.contents[0].text, /\.\/assets\/shared\.png\?v=computed/)
    assert.match(bundle.contents[0].text, /document\.documentElement\.style\.setProperty/)
    assert.match(bundle.contents[0].text, /--threejs-editor-asset-/)
  } finally {
    await game.close()
  }
})

test('M8 rejects generated build input above the bounded expansion limit', async () => {
  const game = await fixture()
  try {
    const imports = []
    const shaders = []
    for (let index = 0; index < 5; index += 1) {
      const name = `shader${String(index)}`
      imports.push(`import ${name} from './${name}.glsl?raw'`)
      shaders.push(name)
      await writeFile(
        join(game.workspace, 'src', `${name}.glsl`),
        Buffer.alloc(14 * 1024 * 1024, 97),
      )
    }
    await writeFile(
      join(game.workspace, 'src', 'main.ts'),
      `${imports.join('\n')}
const shaders = [${shaders.join(',')}]
export default {
  setup() {
    return { metrics: () => ({ shaders }) }
  },
}
`,
    )

    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'failed')
    assert.match(
      built.structuredContent.diagnostics[0].message,
      /generated build input exceeds 64 MiB/,
    )
  } finally {
    await game.close()
  }
})

test('M8 invalidates a Runtime run when its server process exits', async () => {
  const game = await fixture()
  try {
    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const revision = opened.structuredContent.revision
    const runId = '55555555-6666-4777-8888-999999999999'
    await activateRuntime(game.client, {
      projectId: 'm7-builder',
      revision,
      runId,
    })
    const reportedScene = await game.client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: 'm7-builder',
        revision,
        runId,
        objects: [{
          uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          path: 'scene/Stale#0',
          name: 'Stale Runtime object',
          type: 'Mesh',
          visible: true,
          position: [0, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          commands: ['set_position'],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(reportedScene.isError, undefined)
    const reportedDiagnostics = await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        runId,
        errors: ['dead runtime error'],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(reportedDiagnostics.isError, undefined)
    const activeScene = await game.client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(activeScene.structuredContent.objects.some(
      object => object.name === 'Stale Runtime object',
    ), true)
    const activeDiagnostics = await game.client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(activeDiagnostics.structuredContent.runId, runId)
    assert.equal(activeDiagnostics.structuredContent.errors.includes('dead runtime error'), true)

    await game.restart()

    const overlapping = await game.client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(overlapping.structuredContent.objects.some(
      object => object.name === 'Stale Runtime object',
    ), false)
    const overlappingCheck = await game.client.callTool({
      name: 'check_project',
      arguments: { projectId: 'm7-builder' },
      _meta: runtimeMeta,
    })
    assert.equal(overlappingCheck.structuredContent.runId, undefined)
    assert.equal(overlappingCheck.structuredContent.errors.includes('dead runtime error'), false)
    const replacementRunId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    await activateRuntime(game.client, {
      projectId: 'm7-builder',
      revision,
      runId: replacementRunId,
    })
    const staleSave = await game.client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: 'm7-builder',
        baseRevision: revision,
        runId,
        source: 'human',
        operations: [{
          type: 'set_position',
          objectUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          value: [1, 0, 0],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleSave.isError, true)
    assert.match(staleSave.content[0].text, /unavailable for this run/)
  } finally {
    await game.close()
  }
})

test('M8 rejects symlinked build cache directories', async () => {
  const game = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-build-outside-'))
  try {
    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready')
    const directory = join(
      game.workspace,
      '.threejs-editor',
      'builds',
      built.structuredContent.buildId,
    )
    await rm(directory, { recursive: true })
    await symlink(outside, directory)
    const rebuilt = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(rebuilt.isError, true)
    assert.match(rebuilt.content[0].text, /workspace parent is not a real directory/)
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await game.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 rejects symlinked build cache files', async () => {
  const game = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-build-files-outside-'))
  try {
    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'm7-builder',
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready')
    const directory = join(
      game.workspace,
      '.threejs-editor',
      'builds',
      built.structuredContent.buildId,
    )
    const files = [
      { name: 'build.json' },
      { name: 'bundle.js', uri: built.structuredContent.bundleUri },
      { name: 'bundle.js.map', uri: built.structuredContent.sourceMapUri },
    ]
    for (const file of files) {
      const target = join(directory, file.name)
      const original = await readFile(target)
      const external = join(outside, file.name)
      await writeFile(external, original)
      await rm(target)
      await symlink(external, target)

      const cached = await game.client.callTool({
        name: 'build_project',
        arguments: {
          projectId: 'm7-builder',
          revision: opened.structuredContent.revision,
        },
      })
      assert.equal(cached.isError, true)
      assert.match(cached.content[0].text, /workspace metadata is not a regular file/)
      if (file.uri !== undefined) {
        await assert.rejects(
          game.client.readResource({ uri: file.uri }),
          /workspace metadata is not a regular file/,
        )
      }

      await rm(target)
      await writeFile(target, original)
    }
  } finally {
    await game.close()
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 rejects symlinked Runtime metadata files', async () => {
  const game = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-files-outside-'))
  try {
    const opened = await game.client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm7-builder' },
    })
    const revision = opened.structuredContent.revision
    const runId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    const ownerMeta = {
      'ai.deepseek.dsh/session': {
        sessionId: 'm8-runtime-metadata',
        connectionGeneration: '11111111-2222-4333-8444-555555555555',
      },
    }
    const built = await game.client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm7-builder', revision },
    })
    const prepared = await game.client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        revision,
        buildId: built.structuredContent.buildId,
        runId,
        nonce: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      },
      _meta: ownerMeta,
    })
    await game.client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        projectId: 'm7-builder',
        runtimeRef: prepared.structuredContent.runtimeRef,
      },
      _meta: ownerMeta,
    })
    await game.client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: 'm7-builder',
        revision,
        runId,
        objects: [],
      },
      _meta: ownerMeta,
    })
    await game.client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'm7-builder',
        testedRevision: revision,
        runId,
        errors: [],
        warnings: [],
      },
      _meta: ownerMeta,
    })

    const metadata = join(game.workspace, '.threejs-editor')
    const owner = ownerMeta['ai.deepseek.dsh/session']
    const ownerKey = createHash('sha256')
      .update(`${owner.sessionId}\0${owner.connectionGeneration}`)
      .digest('hex')
    const files = [
      {
        path: join(metadata, 'diagnostics', 'active-run.json'),
        check: () => game.client.callTool({
          name: 'report_diagnostics',
          arguments: {
            projectId: 'm7-builder',
            testedRevision: revision,
            runId,
            errors: [],
            warnings: [],
          },
        }),
      },
      {
        path: join(metadata, 'editor-scenes', ownerKey, `${revision}.json`),
        check: () => game.client.callTool({
          name: 'inspect_editor',
          arguments: { projectId: 'm7-builder' },
          _meta: ownerMeta,
        }),
      },
      {
        path: join(metadata, 'diagnostics', ownerKey, 'runtime.json'),
        check: () => game.client.callTool({
          name: 'check_project',
          arguments: { projectId: 'm7-builder' },
          _meta: ownerMeta,
        }),
      },
    ]
    for (const [index, file] of files.entries()) {
      const original = await readFile(file.path)
      const external = join(outside, `${String(index)}.json`)
      await writeFile(external, original)
      await rm(file.path)
      await symlink(external, file.path)

      const result = await file.check()
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /workspace metadata is not a regular file/)

      await rm(file.path)
      await writeFile(file.path, original)
    }
  } finally {
    await game.close()
    await rm(outside, { recursive: true, force: true })
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
  await mkdir(join(project, 'assets'), { recursive: true })
  await mkdir(join(project, 'assets', 'dynamic'), { recursive: true })
  await mkdir(join(repository, 'dev', 'example-gallery', 'support'), { recursive: true })
  await mkdir(join(repository, 'skills', 'threejs-procedural-geometry'), { recursive: true })
  await mkdir(join(examples, 'unrelated-large-example'), { recursive: true })
  await mkdir(join(examples, 'second-example'), { recursive: true })
  await mkdir(join(examples, 'syntax-error-example'), { recursive: true })
  await writeFile(join(project, 'example.json'), JSON.stringify({
    title: 'Formula One Race Car',
    backend: 'WebGPU / TSL node materials',
    debugModes: [{ value: 'final' }, { value: 'topology' }],
  }))
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKGQAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(join(project, 'scene.js'), `
import { createCar } from './race-car-scene.js'
import { importEqualsPoster, importEqualsValue } from './asset-import.ts'
import posterData from './assets/poster.png'
import styles from './style.css'
const posterModule = import(/* runtime asset */ './assets/poster.png')
const requiredPoster = require('./assets/poster.png')
const requiredHelper = require('./common-helper.cjs')
const topLevelTexture = new THREE.TextureLoader().load('./assets/poster.png')
const dynamicAsset = name => \`assets/dynamic/\${name}\`
const model = './assets/model.glb'
const poster = \`/${sourceProjectPath}/assets/poster.png?v=1#hero\`
const relativePoster = './assets/poster.png?v=2'
const slashEscapedPoster = '.\\/assets/poster.png'
const hexEscapedPoster = './assets/poster\\x2epng'
const unicodeEscapedPoster = './assets/poster\\u002epng'
const spacedPoster = './assets/spaced image.png'
const conditionalPoster = \`\${true ? './assets/template-a.png' : './assets/template-b.png'}\`
const regexPoster = \`\${/[}]/.test('}') ? 'assets/regex-a.png' : './assets/regex-b.png'}\`
const assetPattern = /"\\.\\/assets\\/poster\\.png"/
const rawPoster = String.raw\`./assets/poster.png\`
const escapedPoster = './assets/poster\\
.png'
const sourceMapMarker = 37
const markup = '<img src="./assets/missing.png">'
// Documentation example only: "./assets/missing.png"
export default {
  backend: 'webgpu',
  setup({ scene }) {
    scene.add(createCar())
    return {
      metrics: () => ({
        emittedParts: 62,
        poster,
        posterData,
        posterModule,
        requiredPoster,
        importEqualsPoster,
        importEqualsValue,
        requiredValue: requiredHelper.value,
        topLevelTextureName: topLevelTexture.name,
        dynamicAsset: dynamicAsset('a.png'),
        model,
        relativePoster,
        slashEscapedPoster,
        hexEscapedPoster,
        unicodeEscapedPoster,
        spacedPoster,
        conditionalPoster,
        regexPoster,
        assetPattern: assetPattern.source,
        rawPoster,
        escapedPoster,
        sourceMapMarker,
        markup,
        styles,
      }),
    }
  },
}
`.trimStart())
  await writeFile(
    join(project, 'asset-import.ts'),
    "import helper = require('./import-equals-helper.js')\n"
      + "import poster = require('./assets/poster.png')\n"
      + 'export const importEqualsValue = helper.importEqualsValue\n'
      + 'export { poster as importEqualsPoster }\n',
  )
  await writeFile(
    join(project, 'import-equals-helper.js'),
    'export const importEqualsValue = 11\n',
  )
  await writeFile(
    join(project, 'common-helper.cjs'),
    'module.exports = { value: 13 }\n',
  )
  await writeFile(join(project, 'style.css'), `
/* Documentation only: url("./assets/missing.png") */
.hero { background: url(./assets/css.png?v=1#hero); }
.thumb { background: url("./assets/css image.png"); }
.pressed { background: url("./assets/button)pressed.png"); }
.escaped { background: url(./assets/button\\)pressed.png); }
.commented { background: url/* before */(/* value */ "./assets/css.png" /* after */); }
`.trimStart())
  await writeFile(join(project, 'assets', 'button)pressed.png'), pixel)
  await writeFile(join(project, 'assets', 'css image.png'), pixel)
  await writeFile(join(project, 'assets', 'css.png'), pixel)
  await writeFile(join(project, 'assets', 'dynamic', 'a.png'), pixel)
  await writeFile(join(project, 'assets', 'dynamic', 'b.png'), pixel)
  await writeFile(join(project, 'assets', 'model.glb'), Buffer.from('glTF'))
  await writeFile(join(project, 'assets', 'poster.png'), pixel)
  await writeFile(join(project, 'assets', 'regex-a.png'), pixel)
  await writeFile(join(project, 'assets', 'regex-b.png'), pixel)
  await writeFile(join(project, 'assets', 'spaced image.png'), pixel)
  await writeFile(join(project, 'assets', 'template-a.png'), pixel)
  await writeFile(join(project, 'assets', 'template-b.png'), pixel)
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
  await writeFile(
    join(examples, 'syntax-error-example', 'example.json'),
    JSON.stringify({ title: 'Syntax Error Example', backend: 'WebGL' }),
  )
  await writeFile(
    join(examples, 'syntax-error-example', 'scene.js'),
    '// Documentation only: "./missing.png"\nexport default { setup( }\n',
  )
  await writeFile(join(repository, 'private.js'), 'export const privateValue = true\n')
  const sourceFiles = [
    join(project, 'scene.js'),
    join(project, 'asset-import.ts'),
    join(project, 'common-helper.cjs'),
    join(project, 'import-equals-helper.js'),
    join(project, 'style.css'),
    join(project, 'assets', 'button)pressed.png'),
    join(project, 'assets', 'css image.png'),
    join(project, 'assets', 'css.png'),
    join(project, 'assets', 'model.glb'),
    join(project, 'assets', 'poster.png'),
    join(project, 'assets', 'regex-a.png'),
    join(project, 'assets', 'regex-b.png'),
    join(project, 'assets', 'spaced image.png'),
    join(project, 'assets', 'template-a.png'),
    join(project, 'assets', 'template-b.png'),
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
    assert.equal(narrowList.structuredContent.workspaceProjects.length, 3)
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
    const invalid = narrowList.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath === 'syntax-error-example',
    )
    assert.equal(invalid.available, true)
    assert.equal(invalid.issue, undefined)
    assert.equal(JSON.stringify(narrowList.structuredContent).includes(repository), false)

    const invalidOpened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: invalid.projectPath },
      _meta: narrowMeta,
    })
    assert.equal(invalidOpened.isError, undefined)
    const invalidBuild = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: invalidOpened.structuredContent.projectId,
        revision: invalidOpened.structuredContent.revision,
      },
    })
    assert.equal(invalidBuild.structuredContent.status, 'failed')
    assert.ok(invalidBuild.structuredContent.diagnostics.some(
      diagnostic => diagnostic.file?.includes('scene.js'),
    ))
    assert.equal(
      invalidBuild.structuredContent.diagnostics.some(
        diagnostic => diagnostic.message.includes('missing.png'),
      ),
      false,
    )

    const ambiguous = await client.callTool({
      name: 'open_editor',
      arguments: {},
      _meta: narrowMeta,
    })
    assert.equal(ambiguous.isError, true)
    assert.match(ambiguous.content[0].text, /contains 3 Three\.js examples/)
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
    assert.ok(built.structuredContent.inputs.includes(`${sourceProjectPath}/asset-import.ts`))
    assert.ok(built.structuredContent.inputs.includes(`${sourceProjectPath}/common-helper.cjs`))
    assert.ok(built.structuredContent.inputs.includes(
      `${sourceProjectPath}/import-equals-helper.js`,
    ))
    assert.ok(built.structuredContent.inputs.includes(`${sourceProjectPath}/style.css`))
    assert.ok(built.structuredContent.inputs.includes(
      'skills/threejs-procedural-geometry/race-car-model.js',
    ))
    assert.ok(built.structuredContent.inputs.includes('threejs.editor.json'))
    assert.deepEqual(built.structuredContent.assets, [
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/button)pressed.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/css image.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/css.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/dynamic/a.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/dynamic/b.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'model/gltf-binary',
        path: `${sourceProjectPath}/assets/model.glb`,
        sha256: 'c74f919439792582aa4f0b188ec2a928675cdb3ba72797781ceb6dfaa86b313f',
        size: 4,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/poster.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/regex-a.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/regex-b.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/spaced image.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/template-a.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
      {
        mediaType: 'image/png',
        path: `${sourceProjectPath}/assets/template-b.png`,
        sha256: '2a0abc53b30336645d8b8093cf1b59eb83ab541b10e7936b97501fedcc08b849',
        size: 70,
      },
    ])
    const galleryBundle = await client.readResource({
      uri: built.structuredContent.bundleUri,
    })
    assert.doesNotMatch(galleryBundle.contents[0].text, /data:(?:image\/png|model\/gltf-binary);base64,/)
    assert.match(galleryBundle.contents[0].text, /__THREEJS_EDITOR_REGISTER_INLINE_ASSET__/)
    assert.match(galleryBundle.contents[0].text, /DefaultLoadingManager\.setURLModifier/)
    assert.match(galleryBundle.contents[0].text, /\.hero \{ background: var\(/)
    assert.match(galleryBundle.contents[0].text, /\.commented \{ background: var\(/)
    const modifierOffset = galleryBundle.contents[0].text.indexOf(
      'DefaultLoadingManager.setURLModifier',
    )
    const topLevelLoadOffset = galleryBundle.contents[0].text.indexOf(
      'new THREE.TextureLoader().load',
    )
    const adapterEvaluationOffset = galleryBundle.contents[0].text.indexOf(
      'await Promise.resolve().then',
    )
    assert.notEqual(topLevelLoadOffset, -1)
    assert.notEqual(adapterEvaluationOffset, -1)
    assert.ok(modifierOffset < adapterEvaluationOffset)
    assert.doesNotMatch(galleryBundle.contents[0].text, /url\(\.\/assets\/css\.png/)
    assert.doesNotMatch(galleryBundle.contents[0].text, /import\(["']data:image\//)
    assert.doesNotMatch(galleryBundle.contents[0].text, /\.\/assets\/poster\.png\?v=2/)
    assert.doesNotMatch(galleryBundle.contents[0].text, /\.\/assets\/spaced image\.png/)
    assert.doesNotMatch(galleryBundle.contents[0].text, /\.\/assets\/template-[ab]\.png/)
    assert.doesNotMatch(galleryBundle.contents[0].text, /["'](?:\.\/)?assets\/regex-[ab]\.png/)
    assert.doesNotMatch(galleryBundle.contents[0].text, /\.\/assets\/button\)pressed\.png/)
    assert.match(galleryBundle.contents[0].text, /assets\/dynamic\/a\.png/)
    assert.match(galleryBundle.contents[0].text, /assets\/dynamic\/b\.png/)
    assert.match(galleryBundle.contents[0].text, /String\.raw`\.\/assets\/poster\.png`/)
    assert.match(galleryBundle.contents[0].text, /assets\\\/poster\\\.png/)
    assert.match(galleryBundle.contents[0].text, /\.\/assets\/missing\.png/)
    assert.match(galleryBundle.contents[0].text, /["']~[A-Za-z0-9_-]+["']/)
    const assetHash = createHash('sha256')
      .update(`${sourceProjectPath}/scene.js\0./assets/poster.png`)
      .digest('base64url')
    for (const length of [20, 22, 24]) {
      const alias = `~${assetHash.repeat(Math.ceil(length / assetHash.length)).slice(0, length - 1)}`
      assert.equal(
        galleryBundle.contents[0].text.match(new RegExp(`["']${alias}["']`, 'g'))?.length,
        2,
      )
    }
    const gallerySourceMapResource = await client.readResource({
      uri: built.structuredContent.sourceMapUri,
    })
    const gallerySourceMap = JSON.parse(gallerySourceMapResource.contents[0].text)
    const sceneSourceIndex = gallerySourceMap.sources.indexOf(
      `workspace:///${sourceProjectPath}/scene.js`,
    )
    assert.notEqual(sceneSourceIndex, -1)
    assert.equal(
      gallerySourceMap.sourcesContent[sceneSourceIndex],
      originalSources[0].toString('utf8'),
    )
    assert.doesNotMatch(gallerySourceMap.sourcesContent[sceneSourceIndex], /data:image/)
    const sourceMap = new SourceMap(gallerySourceMap)
    const originalScene = originalSources[0].toString('utf8')
    const originalOffset = originalScene.indexOf("'./assets/poster.png?v=2'")
    const originalPosition = originalScene.slice(0, originalOffset).split('\n')
    const aliasEntry = [...galleryBundle.contents[0].text.matchAll(/(["'])(~[A-Za-z0-9_-]+)\1/g)]
      .map(match => {
        const generated = galleryBundle.contents[0].text.slice(0, match.index + 1).split('\n')
        return sourceMap.findEntry(generated.length - 1, generated.at(-1).length)
      })
      .find(entry => (
        entry.originalSource === `workspace:///${sourceProjectPath}/scene.js`
          && entry.originalLine === originalPosition.length - 1
      ))
    assert.notEqual(aliasEntry, undefined)
    assert.equal(aliasEntry.originalLine, originalPosition.length - 1)
    assert.equal(aliasEntry.originalColumn, originalPosition.at(-1).length)
    const markerOffset = galleryBundle.contents[0].text.indexOf('sourceMapMarker = 37')
    assert.notEqual(markerOffset, -1)
    const markerPosition = galleryBundle.contents[0].text.slice(0, markerOffset).split('\n')
    const markerEntry = sourceMap.findEntry(
      markerPosition.length - 1,
      markerPosition.at(-1).length,
    )
    const originalMarkerOffset = originalScene.indexOf('sourceMapMarker = 37')
    const originalMarkerPosition = originalScene.slice(0, originalMarkerOffset).split('\n')
    assert.equal(markerEntry.originalSource, `workspace:///${sourceProjectPath}/scene.js`)
    assert.equal(markerEntry.originalLine, originalMarkerPosition.length - 1)
    assert.equal(markerEntry.originalColumn, originalMarkerPosition.at(-1).length)

    const carUuid = '11111111-1111-4111-8111-111111111111'
    const carMaterialUuid = '22222222-2222-4222-8222-222222222222'
    const carMaterial = (metalness, wireframe) => ({
      uuid: carMaterialUuid,
      type: 'MeshStandardMaterial',
      properties: [
        {
          name: 'color',
          kind: 'color',
          value: '#e10600',
          command: 'set_material_color',
        },
        {
          name: 'roughness',
          kind: 'number',
          value: 0.4,
          min: 0,
          max: 1,
          command: 'set_material_value',
        },
        {
          name: 'metalness',
          kind: 'number',
          value: metalness,
          min: 0,
          max: 1,
          command: 'set_material_value',
        },
        {
          name: 'opacity',
          kind: 'number',
          value: 1,
          min: 0,
          max: 1,
          command: 'set_material_value',
        },
        {
          name: 'transparent',
          kind: 'boolean',
          value: false,
          command: 'set_material_boolean',
        },
        {
          name: 'wireframe',
          kind: 'boolean',
          value: wireframe,
          command: 'set_material_boolean',
        },
      ],
    })
    const galleryRunId = '33333333-4444-4555-8666-777777777777'
    const galleryRuntime = await activateRuntime(client, {
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      runId: galleryRunId,
    })
    const reported = await client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
        runId: galleryRunId,
        objects: [{
          uuid: carUuid,
          path: 'scene/VF-26#0',
          name: 'VF-26',
          type: 'Mesh',
          visible: true,
          position: [0, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          color: '#e10600',
          material: carMaterial(0.2, false),
          commands: [
            'set_position',
            'set_rotation',
            'set_scale',
            'set_name',
            'set_visible',
            'set_material_color',
            'set_material_value',
            'set_material_boolean',
          ],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(reported.structuredContent.objects, 1)

    const inspected = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
      _meta: runtimeMeta,
    })
    assert.equal(inspected.structuredContent.objects[0].name, 'VF-26')
    assert.equal(inspected.structuredContent.objects[0].uuid, carUuid)
    assert.deepEqual(inspected.structuredContent.source, {
      kind: 'workspace-entry',
      entry: `${sourceProjectPath}/scene.js`,
      entryAlias: 'scene.js',
      readTool: 'read_project_files',
      editTool: 'apply_project_files',
    })
    assert.deepEqual(
      inspected.structuredContent.objects[0].material,
      carMaterial(0.2, false),
    )
    const unsupportedMaterial = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: opened.structuredContent.projectId,
        baseRevision: opened.structuredContent.revision,
        operations: [{
          type: 'set_material_value',
          objectUuid: carUuid,
          property: 'clearcoat',
          value: 0.5,
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(unsupportedMaterial.isError, true)
    assert.equal(
      (await client.callTool({
        name: 'inspect_editor',
        arguments: { projectId: opened.structuredContent.projectId },
        _meta: runtimeMeta,
      })).structuredContent.revision,
      opened.structuredContent.revision,
    )

    const edited = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: opened.structuredContent.projectId,
        baseRevision: opened.structuredContent.revision,
        runId: galleryRunId,
        source: 'human',
        operations: [{
          type: 'set_position',
          objectUuid: carUuid,
          value: [0.25, 0, 0],
        }, {
          type: 'set_material_value',
          objectUuid: carUuid,
          property: 'metalness',
          value: 0.65,
        }, {
          type: 'set_material_boolean',
          objectUuid: carUuid,
          property: 'wireframe',
          value: true,
        }],
      },
      _meta: runtimeMeta,
    })
    assert.deepEqual(edited.structuredContent.commandTypes, [
      'SetPositionCommand',
      'SetMaterialValueCommand',
      'SetMaterialValueCommand',
    ])
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
        }, {
          type: 'set_material_value',
          objectUuid: carUuid,
          property: 'metalness',
          value: 0.65,
        }, {
          type: 'set_material_boolean',
          objectUuid: carUuid,
          property: 'wireframe',
          value: true,
        }],
        recentChanges: [{
          source: 'human',
          operation: {
            type: 'set_position',
            objectUuid: carUuid,
            value: [0.25, 0, 0],
          },
        }, {
          source: 'human',
          operation: {
            type: 'set_material_value',
            objectUuid: carUuid,
            property: 'metalness',
            value: 0.65,
          },
        }, {
          source: 'human',
          operation: {
            type: 'set_material_boolean',
            objectUuid: carUuid,
            property: 'wireframe',
            value: true,
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
    }, {
      type: 'set_material_value',
      objectUuid: carUuid,
      property: 'metalness',
      value: 0.65,
    }, {
      type: 'set_material_boolean',
      objectUuid: carUuid,
      property: 'wireframe',
      value: true,
    }])
    const inspectedAfterEdit = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(inspectedAfterEdit.structuredContent.revision, edited.structuredContent.revision)
    assert.equal(inspectedAfterEdit.structuredContent.objects.some(
      object => object.uuid === carUuid,
    ), false)
    const reloaded = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: opened.structuredContent.projectId,
        transitionId: edited.structuredContent.pendingProjection.transitionId,
        runtimeRef: galleryRuntime.runtimeRef,
        revision: edited.structuredContent.revision,
      },
      _meta: runtimeMeta,
    })
    assert.equal(reloaded.isError, undefined)
    await client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: edited.structuredContent.revision,
        runId: galleryRunId,
        objects: [{
          uuid: carUuid,
          path: 'scene/VF-26#0',
          name: 'VF-26',
          type: 'Mesh',
          visible: true,
          position: [0.25, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          color: '#e10600',
          material: carMaterial(0.65, true),
          commands: [
            'set_position',
            'set_rotation',
            'set_scale',
            'set_name',
            'set_visible',
            'set_material_color',
            'set_material_value',
            'set_material_boolean',
          ],
        }],
      },
      _meta: runtimeMeta,
    })
    const inspectedAfterReload = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
      _meta: runtimeMeta,
    })
    assert.deepEqual(inspectedAfterReload.structuredContent.objects[0].position, [0.25, 0, 0])
    const oldDiagnostics = await client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: opened.structuredContent.projectId,
        testedRevision: edited.structuredContent.revision,
        runId: galleryRunId,
        errors: ['old revision error'],
        warnings: [],
      },
      _meta: runtimeMeta,
    })
    assert.equal(oldDiagnostics.isError, undefined)
    const aiEdited = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: opened.structuredContent.projectId,
        baseRevision: edited.structuredContent.revision,
        source: 'ai',
        operations: [{
          type: 'set_position',
          objectUuid: carUuid,
          value: [0.5, 0, 0],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(aiEdited.isError, undefined)
    const advanced = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: opened.structuredContent.projectId,
        transitionId: aiEdited.structuredContent.pendingProjection.transitionId,
        runtimeRef: reloaded.structuredContent.runtimeRef,
        revision: aiEdited.structuredContent.revision,
      },
      _meta: runtimeMeta,
    })
    assert.equal(advanced.isError, undefined)
    const staleRelease = await client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: opened.structuredContent.projectId,
        runtimeRef: reloaded.structuredContent.runtimeRef,
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleRelease.isError, true)
    assert.match(staleRelease.content[0].text, /Runtime reference is stale/)
    const diagnosticsAfterAdvance = await client.callTool({
      name: 'check_project',
      arguments: { projectId: opened.structuredContent.projectId },
      _meta: runtimeMeta,
    })
    assert.equal(diagnosticsAfterAdvance.structuredContent.testedRevision, undefined)
    assert.equal(diagnosticsAfterAdvance.structuredContent.runId, undefined)
    assert.equal(
      diagnosticsAfterAdvance.structuredContent.errors.includes('old revision error'),
      false,
    )
    const staleAdvance = await client.callTool({
      name: 'commit_runtime_projection',
      arguments: {
        projectId: opened.structuredContent.projectId,
        transitionId: aiEdited.structuredContent.pendingProjection.transitionId,
        runtimeRef: reloaded.structuredContent.runtimeRef,
        revision: aiEdited.structuredContent.revision,
      },
      _meta: runtimeMeta,
    })
    assert.equal(staleAdvance.isError, true)
    assert.match(staleAdvance.content[0].text, /missing, expired, or stale/)
    const advancedScene = await client.callTool({
      name: 'report_editor_scene',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: aiEdited.structuredContent.revision,
        runId: galleryRunId,
        objects: [{
          uuid: carUuid,
          path: 'scene/VF-26#0',
          name: 'VF-26',
          type: 'Mesh',
          visible: true,
          position: [0.5, 0, 0],
          rotationDegrees: [0, 0, 0],
          scale: [1, 1, 1],
          color: '#e10600',
          material: carMaterial(0.65, true),
          commands: [
            'set_position',
            'set_rotation',
            'set_scale',
            'set_name',
            'set_visible',
            'set_material_color',
            'set_material_value',
            'set_material_boolean',
          ],
        }],
      },
      _meta: runtimeMeta,
    })
    assert.equal(advancedScene.isError, undefined)
    const inspectedAfterAdvance = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
      _meta: runtimeMeta,
    })
    assert.deepEqual(inspectedAfterAdvance.structuredContent.objects[0].position, [0.5, 0, 0])
    assert.deepEqual(
      inspectedAfterAdvance.structuredContent.objects[0].material,
      carMaterial(0.65, true),
    )
    const projectAfterEdit = await client.callTool({
      name: 'inspect_project',
      arguments: { projectId: opened.structuredContent.projectId },
      _meta: runtimeMeta,
    })
    assert.equal(projectAfterEdit.structuredContent.objects[0].name, 'VF-26')
    assert.deepEqual(projectAfterEdit.structuredContent.editorChanges, [
      {
        source: 'human',
        type: 'set_position',
        objectUuid: carUuid,
        objectName: 'VF-26',
        objectPath: 'scene/VF-26#0',
        value: [0.25, 0, 0],
      },
      {
        source: 'human',
        type: 'set_material_value',
        objectUuid: carUuid,
        objectName: 'VF-26',
        objectPath: 'scene/VF-26#0',
        value: {
          property: 'metalness',
          value: 0.65,
        },
      },
      {
        source: 'human',
        type: 'set_material_boolean',
        objectUuid: carUuid,
        objectName: 'VF-26',
        objectPath: 'scene/VF-26#0',
        value: {
          property: 'wireframe',
          value: true,
        },
      },
      {
        source: 'ai',
        type: 'set_position',
        objectUuid: carUuid,
        objectName: 'VF-26',
        objectPath: 'scene/VF-26#0',
        value: [0.5, 0, 0],
      },
    ])
    const rebuilt = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: aiEdited.structuredContent.revision,
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
    const largeDynamicAsset = Buffer.concat([
      pixel,
      Buffer.alloc(1024 * 1024),
    ])
    await writeFile(
      join(project, 'assets', 'dynamic', 'large.png'),
      largeDynamicAsset,
    )
    const reopened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: narrowCar.projectPath },
      _meta: narrowMeta,
    })
    assert.equal(reopened.isError, undefined)
    const refreshed = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: reopened.structuredContent.projectId,
        revision: reopened.structuredContent.revision,
      },
    })
    assert.equal(refreshed.structuredContent.status, 'ready')
    assert.equal(
      refreshed.structuredContent.assets.find(
        asset => asset.path.endsWith('/assets/dynamic/large.png'),
      )?.size,
      largeDynamicAsset.length,
    )
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

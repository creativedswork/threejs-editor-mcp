import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import test from 'node:test'
import { RuntimeAssetCache } from '../src/runtime-asset-cache.ts'

const RESOURCE_CHUNK_BYTES = 256 * 1024
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m9-root-'))
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-m9-workspace-'))
  const workspace = join(parent, 'large-assets')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'assets'), { recursive: true })
  await mkdir(join(workspace, '.threejs-editor'), { recursive: true })
  const asset = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a)
  await writeFile(join(workspace, 'assets', 'volume.bin'), asset)
  await writeFile(join(workspace, 'src', 'main.js'), `
import { EffectComposer } from 'postprocessing'
import volumeUrl from '../assets/volume.bin'
export default {
  setup() {
    return {
      metrics: () => ({ composer: EffectComposer.name, volumeUrl }),
    }
  },
}
`.trimStart())
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'm9-large-assets',
    private: true,
    type: 'module',
    dependencies: {
      postprocessing: '6.37.4',
      three: '0.185.1',
    },
  }))
  await writeFile(join(workspace, '.threejs-editor', 'project.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'linked-workspace',
    title: 'M9 Large Assets',
    entry: 'src/main.js',
    backend: 'webgl',
    dependencies: {
      postprocessing: '6.37.4',
      three: '0.185.1',
    },
    runtime: {
      debugModes: ['final', 'no-post'],
      qualityTiers: ['low', 'high'],
    },
  }))
  return { root, parent, workspace, asset }
}

test('M9 keeps large revision assets out of tool text and serves verified chunks', async () => {
  const game = await fixture()
  const connect = async (extraArgs = []) => {
    const client = new Client({ name: 'm9-resources-test', version: '0.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [
        serverPath,
        '--root',
        game.root,
        '--workspace-root',
        game.parent,
        '--workspace',
        `m9-assets=${game.workspace}`,
        ...extraArgs,
      ],
    }))
    return client
  }
  let client
  let limited
  const ownerMeta = {
    'ai.deepseek.dsh/session': {
      sessionId: 'm9-resources',
      connectionGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  }
  try {
    client = await connect()
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm9-assets' },
    })
    assert.equal(opened.isError, undefined)
    const initialRevision = opened.structuredContent.revision
    const quality = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'm9-assets',
        baseRevision: initialRevision,
        changes: [{
          type: 'write',
          path: 'threejs.editor.json',
          text: '{\n  "schemaVersion": 1,\n  "operations": [],\n  "qualityTier": "high"\n}\n',
        }],
      },
    })
    assert.equal(quality.isError, undefined)
    const revision = quality.structuredContent.revision
    const built = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'm9-assets', revision },
    })
    assert.equal(built.structuredContent.status, 'ready')
    assert.equal(built.structuredContent.assets.length, 1)
    assert.match(built.structuredContent.dependencyProfile, /postprocessing@6\.37\.4/)
    const bundleResult = await client.readResource({
      uri: built.structuredContent.bundleUri,
    })
    const bundle = bundleResult.contents[0].text
    assert.match(bundle, /EffectComposer/)
    assert.match(bundle, /__THREEJS_EDITOR_ASSETS__/)
    assert.match(bundle, /qualityTier:\s*"high"/)
    assert.doesNotMatch(bundle, /data:application\/octet-stream;base64/)
    const forgedRegistration = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'm9-assets',
        revision,
        buildId: '0'.repeat(64),
        runId: '11111111-2222-4333-8444-555555555555',
        nonce: '22222222-3333-4444-8555-666666666666',
      },
      _meta: ownerMeta,
    })
    assert.equal(forgedRegistration.isError, true)
    assert.match(forgedRegistration.content[0].text, /missing, stale, or not a ready build/)
    const prepared = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'm9-assets',
        revision,
        buildId: built.structuredContent.buildId,
        runId: '11111111-2222-4333-8444-555555555555',
        nonce: '22222222-3333-4444-8555-666666666666',
      },
      _meta: ownerMeta,
    })
    assert.equal(prepared.isError, undefined)
    const registered = await client.callTool({
      name: 'commit_runtime_run',
      arguments: {
        projectId: 'm9-assets',
        runtimeRef: prepared.structuredContent.runtimeRef,
      },
      _meta: ownerMeta,
    })
    assert.equal(registered.isError, undefined)
    assert.equal(
      registered.structuredContent.projection.loadedBuild.buildId,
      built.structuredContent.buildId,
    )

    const metadata = built.structuredContent.assets[0]
    const chunks = []
    for (let index = 0; index < Math.ceil(metadata.size / RESOURCE_CHUNK_BYTES); index += 1) {
      const result = await client.readResource({
        uri: `${metadata.resourceUri}/${index}`,
      })
      chunks.push(Buffer.from(result.contents[0].blob, 'base64'))
    }
    const restored = Buffer.concat(chunks)
    assert.deepEqual(restored, game.asset)
    assert.equal(createHash('sha256').update(restored).digest('hex'), metadata.sha256)

    const assetUrl = URL.createObjectURL(new Blob([restored], { type: metadata.mediaType }))
    const bundlePath = join(game.root, 'runtime-bundle.mjs')
    globalThis.__THREEJS_EDITOR_ASSETS__ = new Map([[metadata.sha256, assetUrl]])
    globalThis.document = {
      documentElement: { style: { setProperty() {} } },
    }
    try {
      await writeFile(bundlePath, bundle)
      const runtime = await import(`${pathToFileURL(bundlePath).href}?revision=${revision}`)
      const metrics = runtime.adapter.setup().metrics()
      assert.equal(metrics.volumeUrl, assetUrl)
      assert.equal(new URL(metrics.volumeUrl).protocol, 'blob:')
      assert.deepEqual(Buffer.from(await (await fetch(metrics.volumeUrl)).arrayBuffer()), game.asset)
    } finally {
      URL.revokeObjectURL(assetUrl)
      delete globalThis.__THREEJS_EDITOR_ASSETS__
      delete globalThis.document
    }

    const nextAsset = Buffer.alloc(game.asset.length, 0x33)
    await writeFile(join(game.workspace, 'assets', 'volume.bin'), nextAsset)
    const advanced = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm9-assets' },
    })
    assert.notEqual(advanced.structuredContent.revision, revision)
    const staleRegistration = await client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'm9-assets',
        revision: advanced.structuredContent.revision,
        buildId: built.structuredContent.buildId,
        runId: '22222222-3333-4444-8555-666666666666',
        nonce: '33333333-4444-4555-8666-777777777777',
      },
      _meta: ownerMeta,
    })
    assert.equal(staleRegistration.isError, true)
    assert.match(staleRegistration.content[0].text, /missing, stale, or not a ready build/)
    await unlink(join(game.workspace, 'assets', 'volume.bin'))
    await symlink(join(game.workspace, 'package.json'), join(game.workspace, 'assets', 'volume.bin'))
    const oldRevision = await client.readResource({ uri: `${metadata.resourceUri}/0` })
    assert.deepEqual(
      Buffer.from(oldRevision.contents[0].blob, 'base64'),
      game.asset.subarray(0, RESOURCE_CHUNK_BYTES),
    )

    const manifestPath = join(
      game.workspace,
      '.threejs-editor',
      'revisions',
      `${revision}.json`,
    )
    const manifest = await readFile(manifestPath)
    const tamperedManifest = JSON.parse(manifest)
    tamperedManifest.title = 'Tampered'
    await writeFile(manifestPath, JSON.stringify(tamperedManifest))
    await assert.rejects(
      client.readResource({ uri: `${metadata.resourceUri}/0` }),
      /stored Workspace revision is corrupt/,
    )
    await writeFile(manifestPath, manifest)

    await writeFile(
      join(game.workspace, '.threejs-editor', 'objects', metadata.sha256),
      Buffer.alloc(game.asset.length, 0x44),
    )
    await assert.rejects(
      client.readResource({ uri: `${metadata.resourceUri}/0` }),
      /revision resource failed hash verification/,
    )
    await unlink(join(game.workspace, 'assets', 'volume.bin'))
    await writeFile(join(game.workspace, 'assets', 'volume.bin'), nextAsset)

    limited = await connect([
      '--workspace-max-file-bytes',
      String(1024 * 1024),
    ])
    const rejected = await limited.callTool({
      name: 'open_editor',
      arguments: { projectId: 'm9-assets' },
    })
    assert.equal(rejected.isError, true)
    assert.match(rejected.content[0].text, /maxFileBytes/)
  } finally {
    await client?.close()
    await limited?.close()
    await rm(game.root, { recursive: true, force: true })
    await rm(game.parent, { recursive: true, force: true })
  }
})

test('M9 Runtime asset cache is bounded and releasable', async () => {
  const cache = new RuntimeAssetCache(2)
  let loads = 0
  const load = async value => {
    loads += 1
    return Uint8Array.of(value).buffer
  }
  await cache.get('a', () => load(1))
  await cache.get('b', () => load(2))
  await cache.get('a', () => load(3))
  await cache.get('c', () => load(4))
  assert.equal(cache.size, 2)
  assert.equal(loads, 3)
  await cache.get('b', () => load(5))
  assert.equal(loads, 4)
  assert.equal(cache.size, 2)

  await assert.rejects(cache.get('failed', async () => {
    throw new Error('load failed')
  }), /load failed/)
  assert.equal(cache.size, 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const corpus = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (corpus === undefined) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')

const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m10-p6-'))
const workspace = join(root, 'workspace')
const store = join(root, 'store')
const prepare = fileURLToPath(new URL('../scripts/prepare-m10-p6.mjs', import.meta.url))
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url))

try {
  execFileSync(process.execPath, [prepare, corpus, workspace], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'pipe',
  })
  const manifest = JSON.parse(await readFile(
    join(workspace, '.threejs-editor/project.json'),
    'utf8',
  ))
  assert.equal(manifest.backend, 'webgpu')
  assert.deepEqual(manifest.runtime.debugModes, [
    'final',
    'no-bloom',
    'density',
    'temperature',
    'velocity',
    'colliders',
  ])
  assert.deepEqual(
    manifest.runtime.parameters.map(parameter => parameter.id),
    [
      'primaryEmitter',
      'teapotEmitter',
      'pressureIterations',
      'simulationSpeed',
      'temperature',
      'fireDensity',
      'turbulence',
    ],
  )

  const source = await readFile(
    join(
      workspace,
      'dev/example-gallery/examples/threejs-procedural-vfx/volumetric-fluid-fire/scene.js',
    ),
    'utf8',
  )
  assert.match(source, /createCompressedGltfProfile/)
  assert.match(source, /runtime\.ownGpuResource\(fire/)
  assert.match(source, /disposeFluidFire\(fire, renderPipeline\)/)
  assert.match(source, /\.\.\.parameters/)

  const client = new Client({ name: 'm10-corpus-build', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server, '--root', store],
  }))
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: {},
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    assert.equal(opened.isError, undefined, JSON.stringify(opened))
    assert.equal(opened.structuredContent.title, 'P6 Volumetric Fluid Fire')

    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
    assert.deepEqual(built.structuredContent.diagnostics, [])
    assert.equal(built.structuredContent.backend, 'webgpu')
    assert.equal(built.structuredContent.assets.length, 5)
    assert.ok(built.structuredContent.assets.some(asset => (
      asset.path.endsWith('demo-scene.glb') && asset.size === 29_448
    )))
    assert.ok(built.structuredContent.assets.some(asset => (
      asset.path.endsWith('draco-decoder.bin')
    )))
    assert.ok(built.structuredContent.assets.some(asset => (
      asset.path.endsWith('basis-transcoder-wasm.bin')
    )))

    const bundle = (await client.readResource({
      uri: built.structuredContent.bundleUri,
    })).contents[0].text
    assert.match(bundle, /VolumetricFluidFire/)
    assert.match(bundle, /KTX2Loader/)
    assert.match(bundle, /disposeFluidFire/)
    assert.match(bundle, /runtime\.ownGpuResource/)
    process.stdout.write(`${JSON.stringify({
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      bundleBytes: built.structuredContent.bundleBytes,
      assets: built.structuredContent.assets.length,
    }, null, 2)}\n`)
  } finally {
    await client.close()
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

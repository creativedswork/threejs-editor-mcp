import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m10-g1-'))
const workspace = join(root, 'workspace')
const store = join(root, 'store')
const prepare = fileURLToPath(new URL('../scripts/prepare-m10-g1.mjs', import.meta.url))
const server = fileURLToPath(new URL('../dist/server.js', import.meta.url))

try {
  execFileSync(process.execPath, [prepare, workspace], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'pipe',
  })
  const glb = await readFile(join(workspace, 'assets/avatar.glb'))
  assert.equal(glb.readUInt32LE(0), 0x46546c67)
  assert.equal(glb.readUInt32LE(4), 2)
  assert.equal(glb.readUInt32LE(8), glb.length)
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString())
  assert.equal(gltf.skins.length, 1)
  assert.equal(gltf.animations.length, 1)
  assert.equal(gltf.meshes[0].primitives[0].targets.length, 1)
  assert.deepEqual(
    gltf.animations[0].channels.map(channel => channel.target.path),
    ['rotation', 'weights'],
  )

  const client = new Client({ name: 'm10-g1-build', version: '0.0.0' })
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
    assert.equal(opened.structuredContent.title, 'G1 Gameplay Systems')

    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
    assert.deepEqual(built.structuredContent.diagnostics, [])
    assert.equal(built.structuredContent.backend, 'webgl')
    assert.equal(built.structuredContent.assets.length, 1)
    assert.equal(built.structuredContent.assets[0].mediaType, 'model/gltf-binary')

    const bundle = (await client.readResource({
      uri: built.structuredContent.bundleUri,
    })).contents[0].text
    for (const marker of [
      'AnimationMixer',
      'isSkinnedMesh',
      'morphTargetInfluences',
      'audioUnlocked',
      'player.position.addScaledVector',
      'state.timeScale === 0',
    ]) {
      assert.ok(bundle.includes(marker), `missing G1 marker ${marker}`)
    }
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

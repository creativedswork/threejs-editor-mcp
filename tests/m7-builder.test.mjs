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

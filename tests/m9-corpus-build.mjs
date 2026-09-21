import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const workspace = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (workspace === undefined) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const corpus = JSON.parse(await readFile(new URL('../corpus/m5.json', import.meta.url), 'utf8'))
const corpusRoot = execFileSync(
  'git',
  ['-C', workspace, 'rev-parse', '--show-toplevel'],
  { encoding: 'utf8' },
).trim()
const corpusCommit = execFileSync(
  'git',
  ['-C', corpusRoot, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim()
assert.equal(corpusCommit, corpus.graphicsCorpus.commit)
execFileSync('git', [
  '-C',
  corpusRoot,
  'diff',
  '--exit-code',
  'HEAD',
  '--',
  'dev/example-gallery/examples/threejs-spectral-ocean/spectral-cascade-ocean',
  'dev/example-gallery/examples/threejs-volumetric-clouds/weather-volume-clouds',
  'skills/threejs-spectral-ocean/examples/spectral-cascade-ocean',
  'skills/threejs-volumetric-clouds/examples/weather-volume-clouds',
])

const cases = {
  'threejs-spectral-ocean/spectral-cascade-ocean': {
    title: 'Spectral Cascade Ocean',
    assets: 0,
    marker: /validateFragmentIFFT/,
    debugModes: ['final', 'cascade-bands', 'normals', 'jacobian', 'spectrum-0', 'spectrum-1', 'spectrum-2'],
    qualityTiers: ['default'],
  },
  'threejs-volumetric-clouds/weather-volume-clouds': {
    title: 'Weather Volume Clouds',
    assets: 8,
    marker: /EffectComposer/,
    debugModes: [
      'final',
      'atmosphere-only',
      'clouds-only',
      'no-detail',
      'no-turbulence',
      'native-resolution',
      'no-post',
    ],
    qualityTiers: ['balanced', 'performance', 'quality'],
  },
}
const pinnedRuntimeDependencies = {
  '@petamoriken/float16': '3.9.2',
  'astronomy-engine': '2.1.19',
  'postprocessing': '6.39.5',
  'three': '0.185.1',
  'three-stdlib': '2.36.0',
}
assert.deepEqual([...corpus.graphicsCorpus.m9Cases].sort(), Object.keys(cases).sort())

const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m9-corpus-'))
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const client = new Client({ name: 'm9-corpus-build', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--root', root],
}))

try {
  const results = []
  for (const projectPath of corpus.graphicsCorpus.m9Cases) {
    const expected = cases[projectPath]
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    assert.equal(opened.isError, undefined, JSON.stringify(opened))
    assert.equal(opened.structuredContent.title, expected.title)
    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.deepEqual(pulled.structuredContent.workspace.debugModes, expected.debugModes)
    assert.deepEqual(pulled.structuredContent.workspace.qualityTiers, expected.qualityTiers)
    const generatedManifest = JSON.parse(await readFile(join(
      root,
      '.managed-workspaces',
      opened.structuredContent.projectId,
      '.threejs-editor',
      'project.json',
    ), 'utf8'))
    assert.deepEqual(generatedManifest.dependencies, pinnedRuntimeDependencies)
    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
    assert.deepEqual(built.structuredContent.diagnostics, [])
    assert.equal(built.structuredContent.assets.length, expected.assets)
    const bundle = (await client.readResource({
      uri: built.structuredContent.bundleUri,
    })).contents[0].text
    assert.match(bundle, expected.marker)
    for (const asset of built.structuredContent.assets) {
      const bytes = await readFile(join(
        root,
        '.managed-workspaces',
        opened.structuredContent.projectId,
        asset.path,
      ))
      assert.equal(
        bundle.includes(`data:${asset.mediaType};base64,${bytes.toString('base64')}`),
        false,
      )
    }

    let transferredBytes = 0
    let transferredChunks = 0
    for (const asset of built.structuredContent.assets.filter(asset => asset.resourceUri)) {
      const chunks = []
      for (let index = 0; index < asset.chunks; index += 1) {
        const uri = `${asset.resourceUri}/${index}`
        const result = await client.readResource({ uri })
        chunks.push(Buffer.from(result.contents[0].blob, 'base64'))
        transferredChunks += 1
      }
      const bytes = Buffer.concat(chunks)
      assert.equal(bytes.length, asset.size)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
      transferredBytes += bytes.length
    }
    results.push({
      projectPath,
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      bundleBytes: built.structuredContent.bundleBytes,
      sourceMapBytes: built.structuredContent.sourceMapBytes,
      inputs: built.structuredContent.inputs.length,
      assets: built.structuredContent.assets.length,
      transferredBytes,
      transferredChunks,
      corpusCommit,
    })
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
} finally {
  await client.close()
  await rm(root, { recursive: true, force: true })
}

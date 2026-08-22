import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const workspace = process.env.THREEJS_EDITOR_MCP_WORKSPACE
if (workspace === undefined) throw new Error('THREEJS_EDITOR_MCP_WORKSPACE is required')
const corpus = JSON.parse(await readFile(
  new URL('../corpus/m5.json', import.meta.url),
  'utf8',
))
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
assert.equal(execFileSync(
  'git',
  ['-C', corpusRoot, 'status', '--porcelain=v1'],
  { encoding: 'utf8' },
).trim(), '')

const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const client = new Client({
  name: 'threejs-editor-mcp-m8-corpus-build',
  version: '0.0.0',
})

await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--root', root],
}))

const caseMetadata = {
  'threejs-temporal-surfaces/touch-history-frost': {
    title: 'Touch-History Frost',
    helper: 'skills/threejs-temporal-surfaces/examples/touch-history-frost/frost-surface-effect.js',
    assets: 4,
  },
  'threejs-water-optics/interactive-pool-volume': {
    title: 'Interactive Pool Volume',
    helper: 'skills/threejs-water-optics/examples/interactive-pool-volume/water-volume-system.js',
    assets: 6,
  },
}
assert.ok(Array.isArray(corpus.graphicsCorpus.m8Cases))
assert.deepEqual(
  [...corpus.graphicsCorpus.m8Cases].sort(),
  Object.keys(caseMetadata).sort(),
)
assert.ok(corpus.graphicsCorpus.m8Cases.every(projectPath => (
  corpus.graphicsCorpus.cases.includes(projectPath)
)))
const cases = corpus.graphicsCorpus.m8Cases.map(projectPath => ({
  projectPath,
  ...caseMetadata[projectPath],
}))
assert.ok(cases.every(item => (
  typeof item.title === 'string'
    && typeof item.helper === 'string'
    && Number.isInteger(item.assets)
)))

try {
  const results = []
  for (const item of cases) {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: item.projectPath },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    assert.equal(opened.isError, undefined, JSON.stringify(opened))
    assert.equal(opened.structuredContent.title, item.title)

    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        revision: opened.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'ready')
    assert.equal(built.structuredContent.backend, 'webgl')
    assert.deepEqual(built.structuredContent.diagnostics, [])
    assert.ok(built.structuredContent.inputs.includes(item.helper))
    assert.equal(built.structuredContent.assets.length, item.assets)
    assert.ok(built.structuredContent.assets.every(asset => asset.mediaType.startsWith('image/')))

    const bundle = await client.readResource({
      uri: built.structuredContent.bundleUri,
    })
    assert.match(bundle.contents[0].text, /data:image\/(?:jpeg|webp);base64,/)
    assert.match(bundle.contents[0].text, /DefaultLoadingManager\.setURLModifier/)
    results.push({
      title: item.title,
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      bundleBytes: built.structuredContent.bundleBytes,
      inputs: built.structuredContent.inputs.length,
      assets: built.structuredContent.assets.length,
      corpusCommit,
    })
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
} finally {
  await client.close()
  await rm(root, { recursive: true, force: true })
}

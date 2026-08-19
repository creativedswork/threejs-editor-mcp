import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectRoot = resolve(new URL('..', import.meta.url).pathname)
const workspace = resolve(process.argv[2] ?? '.tmp/m7-p1-workspace')
const root = resolve(process.argv[3] ?? '.tmp/m7-p1-projects')
await mkdir(root, { recursive: true })

const client = new Client({
  name: 'threejs-editor-m7-p1-build',
  version: '0.0.0',
})
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [
    resolve(projectRoot, 'dist/server.js'),
    '--root',
    root,
    '--workspace-root',
    dirname(workspace),
    '--workspace',
    `m7-p1=${workspace}`,
  ],
}))

try {
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: { projectId: 'm7-p1' },
  })
  assert.equal(opened.isError, undefined)
  const revision = opened.structuredContent.revision
  const built = await client.callTool({
    name: 'build_project',
    arguments: { projectId: 'm7-p1', revision },
  })
  assert.equal(built.isError, undefined)
  assert.equal(built.structuredContent.status, 'ready')
  assert.equal(built.structuredContent.backend, 'webgpu')
  assert.equal(
    built.structuredContent.diagnostics.length,
    0,
    JSON.stringify(built.structuredContent.diagnostics, null, 2),
  )
  assert.ok(built.structuredContent.inputs.includes(
    'skills/threejs-procedural-geometry/examples/formula-one-race-car/source/race-car-model.js',
  ))
  const bundle = await client.readResource({
    uri: built.structuredContent.bundleUri,
  })
  const sourceMap = await client.readResource({
    uri: built.structuredContent.sourceMapUri,
  })
  assert.equal(
    Buffer.byteLength(bundle.contents[0].text),
    built.structuredContent.bundleBytes,
  )
  assert.equal(
    Buffer.byteLength(sourceMap.contents[0].text),
    built.structuredContent.sourceMapBytes,
  )
  assert.doesNotMatch(sourceMap.contents[0].text, /\/Users\//)

  const checked = await client.callTool({
    name: 'check_project',
    arguments: { projectId: 'm7-p1' },
  })
  assert.deepEqual(checked.structuredContent.errors, [])
  assert.deepEqual(checked.structuredContent.warnings, [])

  const source = JSON.parse(await readFile(
    resolve(workspace, 'M7-P1-SOURCE.json'),
    'utf8',
  ))
  process.stdout.write(`${JSON.stringify({
    projectId: 'm7-p1',
    revision,
    buildId: built.structuredContent.buildId,
    backend: built.structuredContent.backend,
    bundleBytes: built.structuredContent.bundleBytes,
    sourceMapBytes: built.structuredContent.sourceMapBytes,
    inputs: built.structuredContent.inputs.length,
    sourceCommit: source.commit,
    sourceFiles: source.files.length,
    errors: checked.structuredContent.errors,
    warnings: checked.structuredContent.warnings,
  }, null, 2)}\n`)
} finally {
  await client.close()
}

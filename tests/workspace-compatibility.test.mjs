import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = resolve(
  process.env.THREEJS_EDITOR_MCP_SERVER
    ?? fileURLToPath(new URL('../dist/server.js', import.meta.url)),
)

test('isolates an invalid example manifest during workspace discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-compat-projects-'))
  const examples = await mkdtemp(join(tmpdir(), 'threejs-editor-compat-examples-'))
  const valid = join(examples, 'valid-example')
  const invalid = join(examples, 'invalid-example')
  await mkdir(valid)
  await mkdir(invalid)
  await writeFile(
    join(valid, 'example.json'),
    JSON.stringify({ title: 'Valid Example', backend: 'WebGL' }),
  )
  await writeFile(join(valid, 'scene.js'), 'export default { setup() { return {} } }\n')
  await writeFile(join(invalid, 'example.json'), '{\n')
  await writeFile(join(invalid, 'scene.js'), 'export default { setup() { return {} } }\n')

  const client = new Client({
    name: 'threejs-editor-workspace-compatibility-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))
  const meta = { 'ai.deepseek.dsh/workspace': { cwd: examples } }

  try {
    const listed = await client.callTool({
      name: 'list_projects',
      arguments: {},
      _meta: meta,
    })
    assert.equal(listed.isError, undefined)
    assert.equal(listed.structuredContent.workspaceProjects.length, 2)
    const validCandidate = listed.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath === 'valid-example',
    )
    const invalidCandidate = listed.structuredContent.workspaceProjects.find(
      candidate => candidate.projectPath === 'invalid-example',
    )
    assert.equal(validCandidate.available, true)
    assert.equal(invalidCandidate.available, false)
    assert.match(invalidCandidate.issue, /Invalid example\.json/)

    const rejected = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: invalidCandidate.projectPath },
      _meta: meta,
    })
    assert.equal(rejected.isError, true)
    assert.match(rejected.content[0].text, /Invalid example\.json/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(examples, { recursive: true, force: true })
  }
})

test('treats incompatible scene diagnostics as unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-compat-diagnostics-'))
  const client = new Client({
    name: 'threejs-editor-diagnostics-compatibility-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))

  try {
    const created = await client.callTool({
      name: 'create_project',
      arguments: { projectId: 'legacy-diagnostics', template: 'empty' },
    })
    assert.equal(created.isError, undefined)
    await writeFile(
      join(root, 'legacy-diagnostics', 'diagnostics.json'),
      '{"schemaVersion":0}\n',
    )
    const checked = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'legacy-diagnostics' },
    })
    assert.equal(checked.isError, undefined)
    assert.deepEqual(checked.structuredContent.errors, [])
    assert.deepEqual(
      checked.structuredContent.warnings,
      ['Play diagnostics have not been reported'],
    )
    assert.equal(checked.structuredContent.runtimeStatus, 'not-reported')
    assert.match(checked.content[0].text, /Runtime verification is inconclusive/)

    const reported = await client.callTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: 'legacy-diagnostics',
        testedRevision: created.structuredContent.revision,
        errors: [],
        warnings: [],
      },
    })
    assert.equal(reported.isError, undefined)
    const current = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'legacy-diagnostics' },
    })
    assert.equal(current.structuredContent.runtimeStatus, 'current')

    const changed = await client.callTool({
      name: 'apply_scene_changes',
      arguments: {
        projectId: 'legacy-diagnostics',
        baseRevision: created.structuredContent.revision,
        operations: [{ type: 'update_project', title: 'Changed' }],
      },
    })
    assert.equal(changed.isError, undefined)
    const stale = await client.callTool({
      name: 'check_project',
      arguments: { projectId: 'legacy-diagnostics' },
    })
    assert.equal(stale.structuredContent.runtimeStatus, 'stale')
    assert.match(stale.content[0].text, /Runtime verification is inconclusive/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
  }
})

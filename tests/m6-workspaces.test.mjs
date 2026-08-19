import assert from 'node:assert/strict'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function connect(root, allowlistedRoot, workspace) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      allowlistedRoot,
      '--workspace',
      `linked-game=${workspace}`,
    ],
  })
  const client = new Client({
    name: 'threejs-editor-mcp-m6-test',
    version: '0.0.0',
  })
  await client.connect(transport)
  return client
}

test('M6.1 opens the current DSH workspace without a model-visible path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m61-projects-'))
  const workspace = await mkdtemp(join(tmpdir(), 'threejs-editor-m61-workspace-'))
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'current-game',
    private: true,
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export const current = true\n')

  const client = new Client({
    name: 'threejs-editor-mcp-m61-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))
  try {
    const withoutContext = await client.callTool({
      name: 'open_editor',
      arguments: {},
    })
    assert.equal(withoutContext.isError, true)

    const request = {
      name: 'open_editor',
      arguments: {},
      _meta: {
        'ai.deepseek.dsh/workspace': { cwd: workspace },
      },
    }
    const opened = await client.callTool(request)
    assert.equal(opened.isError, undefined)
    assert.equal(opened.structuredContent.kind, 'linked-workspace')
    assert.match(opened.structuredContent.projectId, /^workspace-[a-f0-9]{54}$/)
    assert.equal(opened.structuredContent.projectId.includes('current-game'), false)
    assert.equal(Object.values(opened.structuredContent).includes(workspace), false)

    const reopened = await client.callTool(request)
    assert.equal(reopened.structuredContent.projectId, opened.structuredContent.projectId)
    assert.equal(reopened.structuredContent.revision, opened.structuredContent.revision)
    const listed = await client.callTool({
      name: 'list_projects',
      arguments: {},
    })
    assert.equal(
      listed.structuredContent.projects.some(project => (
        project.projectId === opened.structuredContent.projectId
      )),
      false,
    )
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M6 workspaces preserve local files and commit revisioned atomic changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m6-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m6-workspaces-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m6-outside-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  const binary = Buffer.from([0, 255, 19, 128, 42])
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'public'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'const linkedMarker = "initial"\n')
  await writeFile(join(workspace, 'src', 'unknown.custom'), 'unknown text stays exact\n')
  await writeFile(join(workspace, 'public', 'data.bin'), binary)

  let client = await connect(root, allowlistedRoot, workspace)
  try {
    const source = await client.callTool({
      name: 'create_project',
      arguments: {
        projectId: 'scene-source',
        title: 'Linked Pong',
        template: 'pong',
      },
    })
    assert.equal(source.isError, undefined)
    await copyFile(
      join(root, 'scene-source', 'project.json'),
      join(workspace, 'src', 'scene.json'),
    )

    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    assert.equal(opened.isError, undefined)
    assert.equal(opened.structuredContent.kind, 'linked-workspace')
    const initialRevision = opened.structuredContent.revision
    assert.match(initialRevision, /^[a-f0-9]{64}$/)
    assert.equal(
      (await readFile(join(workspace, '.threejs-editor', 'HEAD'), 'utf8')).trim(),
      initialRevision,
    )
    assert.equal(
      JSON.parse(await readFile(
        join(workspace, '.threejs-editor', 'revisions', `${initialRevision}.json`),
        'utf8',
      )).kind,
      'linked-workspace',
    )

    const read = await client.callTool({
      name: 'read_project_files',
      arguments: {
        projectId: 'linked-game',
        files: [
          { path: 'src/main.js', startLine: 1, endLine: 1 },
          { path: 'src/unknown.custom' },
          { path: 'public/data.bin' },
        ],
      },
    })
    assert.equal(read.isError, undefined)
    assert.equal(read.structuredContent.files[0].text, 'const linkedMarker = "initial"')
    assert.equal(read.structuredContent.files[1].text, 'unknown text stays exact\n')
    assert.equal(read.structuredContent.files[2].base64, binary.toString('base64'))

    const searched = await client.callTool({
      name: 'search_project',
      arguments: { projectId: 'linked-game', query: 'linkedMarker' },
    })
    assert.deepEqual(searched.structuredContent.matches, [{
      path: 'src/main.js',
      line: 1,
      text: 'const linkedMarker = "initial"',
    }])

    const inspected = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'linked-game' },
    })
    const ball = inspected.structuredContent.objects.find(object => object.name === 'Ball')
    assert.match(ball.uuid, /^[a-f0-9-]{36}$/)
    assert.ok(ball.commands.includes('set_position'))
    const commanded = await client.callTool({
      name: 'apply_editor_commands',
      arguments: {
        projectId: 'linked-game',
        baseRevision: initialRevision,
        operations: [{
          type: 'set_position',
          objectUuid: ball.uuid,
          value: [1, 2, 3],
        }],
      },
    })
    assert.equal(commanded.isError, undefined)
    assert.deepEqual(commanded.structuredContent.commandTypes, [
      'SetPositionCommand',
    ])
    assert.equal(commanded.structuredContent.kind, 'linked-workspace')
    const commandRevision = commanded.structuredContent.revision
    assert.notEqual(commandRevision, initialRevision)
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, 'src', 'scene.json'), 'utf8'))
        .scene.object.children.find(object => object.name === 'Ball').matrix.slice(12, 15),
      [1, 2, 3],
    )

    const humanEdit = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'linked-game',
        baseRevision: commandRevision,
        changes: [
          {
            type: 'write',
            path: 'src/main.js',
            text: 'const linkedMarker = "human"\n',
          },
          {
            type: 'write',
            path: 'notes/session.txt',
            text: 'human edit\n',
          },
        ],
      },
    })
    assert.equal(humanEdit.isError, undefined)
    const humanRevision = humanEdit.structuredContent.revision
    assert.equal(await readFile(join(workspace, 'src', 'main.js'), 'utf8'), 'const linkedMarker = "human"\n')
    assert.equal(await readFile(join(workspace, 'notes', 'session.txt'), 'utf8'), 'human edit\n')

    const transactionsDirectory = join(workspace, '.threejs-editor', 'transactions')
    const transactions = await Promise.all(
      (await readdir(transactionsDirectory)).map(async name => (
        JSON.parse(await readFile(join(transactionsDirectory, name), 'utf8'))
      )),
    )
    const humanTransaction = transactions.find(item => item.targetRevision === humanRevision)
    assert.equal(humanTransaction.status, 'committed')
    assert.deepEqual(
      humanTransaction.changes.map(change => change.path).sort(),
      ['notes/session.txt', 'src/main.js'],
    )

    const stale = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'linked-game',
        baseRevision: commandRevision,
        changes: [{ type: 'write', path: 'src/main.js', text: 'stale\n' }],
      },
    })
    assert.equal(stale.isError, true)
    assert.equal(stale.structuredContent.currentRevision, humanRevision)
    assert.equal(await readFile(join(workspace, 'src', 'main.js'), 'utf8'), 'const linkedMarker = "human"\n')

    for (const path of ['../escape.js', '/tmp/escape.js', '.threejs-editor/HEAD']) {
      const rejected = await client.callTool({
        name: 'apply_project_files',
        arguments: {
          projectId: 'linked-game',
          baseRevision: humanRevision,
          changes: [{ type: 'write', path, text: 'blocked\n' }],
        },
      })
      assert.equal(rejected.isError, true)
    }

    const oversized = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'linked-game',
        baseRevision: humanRevision,
        changes: [{
          type: 'write',
          path: 'src/oversized.txt',
          text: '界'.repeat(400_000),
        }],
      },
    })
    assert.equal(oversized.isError, true)

    await writeFile(join(outside, 'outside.js'), 'outside\n')
    await symlink(join(outside, 'outside.js'), join(workspace, 'src', 'escape.js'))
    const symlinked = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    assert.equal(symlinked.isError, true)
    await rm(join(workspace, 'src', 'escape.js'))

    const binaryBeforeRevision = (await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })).structuredContent.revision
    const nextBinary = Buffer.from([7, 6, 5, 4, 3, 2, 1])
    const binaryEdit = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'linked-game',
        baseRevision: binaryBeforeRevision,
        changes: [{
          type: 'write',
          path: 'public/data.bin',
          base64: nextBinary.toString('base64'),
        }],
      },
    })
    assert.equal(binaryEdit.isError, undefined)
    const binaryRevision = binaryEdit.structuredContent.revision
    assert.deepEqual(await readFile(join(workspace, 'public', 'data.bin')), nextBinary)

    const exported = await client.callTool({
      name: 'export_project',
      arguments: { projectId: 'linked-game' },
    })
    assert.equal(exported.structuredContent.filename, 'linked-game.threejs-workspace.json')
    const exportDocument = JSON.parse(exported.structuredContent.json)
    assert.equal(exportDocument.revision, binaryRevision)
    assert.equal(
      exportDocument.files.find(file => file.path === 'public/data.bin').base64,
      nextBinary.toString('base64'),
    )

    const managed = await client.callTool({
      name: 'create_workspace',
      arguments: {
        projectId: 'managed-pong',
        title: 'Managed Pong',
        template: 'pong',
      },
    })
    assert.equal(managed.structuredContent.kind, 'managed-workspace')

    const binaryTransactionEntries = await Promise.all(
      (await readdir(transactionsDirectory)).map(async name => ({
        name,
        document: JSON.parse(await readFile(join(transactionsDirectory, name), 'utf8')),
      })),
    )
    const binaryTransaction = binaryTransactionEntries
      .find(entry => entry.document.targetRevision === binaryRevision)
    assert.ok(binaryTransaction)
    binaryTransaction.document.status = 'prepared'
    await writeFile(
      join(transactionsDirectory, binaryTransaction.name),
      `${JSON.stringify(binaryTransaction.document, null, 2)}\n`,
    )
    await writeFile(
      join(workspace, '.threejs-editor', 'HEAD'),
      `${binaryTransaction.document.baseRevision}\n`,
    )
  } finally {
    await client.close()
  }

  client = await connect(root, allowlistedRoot, workspace)
  try {
    const recovered = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    assert.equal(recovered.isError, undefined)
    assert.deepEqual(await readFile(join(workspace, 'public', 'data.bin')), binary)
    const listed = await client.callTool({ name: 'list_projects', arguments: {} })
    assert.equal(
      listed.structuredContent.projects.find(project => project.projectId === 'managed-pong').kind,
      'managed-workspace',
    )
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

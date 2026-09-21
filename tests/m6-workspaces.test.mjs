import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
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
import {
  runtimeLockPathForWorkspace,
  withRuntimeLock,
} from '../src/runtime-lock.ts'
import { replaceFileBound } from '../src/workspace-io.ts'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function connect(root, allowlistedRoot, workspace, projectId = 'linked-game') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      allowlistedRoot,
      '--workspace',
      `${projectId}=${workspace}`,
    ],
  })
  const client = new Client({
    name: 'threejs-editor-mcp-m6-test',
    version: '0.0.0',
  })
  await client.connect(transport)
  return client
}

function runtimeMeta(sessionId) {
  return {
    'ai.deepseek.dsh/session': {
      sessionId,
      connectionGeneration: randomUUID(),
    },
  }
}

async function activateRuntime(client, projectId, revision, runId, meta) {
  const built = await client.callTool({
    name: 'build_project',
    arguments: { projectId, revision },
  })
  assert.equal(built.structuredContent.status, 'ready')
  const prepared = await client.callTool({
    name: 'prepare_runtime_run',
    arguments: {
      projectId,
      revision,
      buildId: built.structuredContent.buildId,
      runId,
      nonce: randomUUID(),
    },
    _meta: meta,
  })
  assert.equal(prepared.isError, undefined)
  const committed = await client.callTool({
    name: 'commit_runtime_run',
    arguments: {
      projectId,
      runtimeRef: prepared.structuredContent.runtimeRef,
    },
    _meta: meta,
  })
  assert.equal(committed.isError, undefined)
  return committed.structuredContent
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

test('M8 rejects symlinked Workspace metadata without writing outside the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-outside-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  await symlink(outside, join(workspace, '.threejs-editor'))
  const client = await connect(root, allowlistedRoot, workspace)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    assert.equal(opened.isError, true)
    assert.match(opened.content[0].text, /workspace parent is not a real directory/)
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 does not release Runtime metadata through a symlinked parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-outside-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connect(root, allowlistedRoot, workspace)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    const runId = '55555555-6666-4777-8888-999999999999'
    const ownerMeta = runtimeMeta('symlink-parent')
    const registered = await activateRuntime(
      client,
      'linked-game',
      opened.structuredContent.revision,
      runId,
      ownerMeta,
    )

    const diagnostics = join(workspace, '.threejs-editor', 'diagnostics')
    const externalDiagnostics = join(outside, 'diagnostics')
    await rename(diagnostics, externalDiagnostics)
    await symlink(externalDiagnostics, diagnostics)
    const activePath = join(externalDiagnostics, 'active-run.json')
    const before = await readFile(activePath)

    const released = await client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'linked-game',
        runtimeRef: registered.runtimeRef,
      },
      _meta: ownerMeta,
    })
    assert.equal(released.isError, true)
    assert.match(released.content[0].text, /workspace metadata is not a regular file/)
    assert.deepEqual(await readFile(activePath), before)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 replaces Runtime tombstones without truncating external hard links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-outside-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connect(root, allowlistedRoot, workspace)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const ownerMeta = runtimeMeta('hardlink-tombstone')
    const registered = await activateRuntime(
      client,
      'linked-game',
      opened.structuredContent.revision,
      runId,
      ownerMeta,
    )
    const activePath = join(
      workspace,
      '.threejs-editor',
      'diagnostics',
      'active-run.json',
    )
    const externalPath = join(outside, 'active-run.json')
    await rename(activePath, externalPath)
    await link(externalPath, activePath)
    const before = await readFile(externalPath)

    const released = await client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'linked-game',
        runtimeRef: registered.runtimeRef,
      },
      _meta: ownerMeta,
    })
    assert.equal(released.structuredContent.released, true)
    assert.equal((await readFile(activePath)).length, 0)
    assert.deepEqual(await readFile(externalPath), before)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 binds atomic replacement before a Workspace parent is swapped', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threejs-editor-m8-bound-root-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'threejs-editor-m8-bound-outside-')))
  const parent = join(root, 'src')
  const movedParent = join(outside, 'moved-src')
  const replacementParent = join(outside, 'replacement-src')
  await mkdir(parent)
  await mkdir(replacementParent)
  await writeFile(join(parent, 'main.js'), 'original\n')
  await writeFile(join(replacementParent, 'main.js'), 'external\n')

  try {
    await replaceFileBound(root, join(parent, 'main.js'), 'updated\n', {
      onBound: async () => {
        await rename(parent, movedParent)
        await symlink(replacementParent, parent)
      },
    })
    assert.equal(await readFile(join(movedParent, 'main.js'), 'utf8'), 'updated\n')
    assert.equal(await readFile(join(replacementParent, 'main.js'), 'utf8'), 'external\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 serializes aliases of one Workspace across Server roots', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-b-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const workspace = join(allowlistedRoot, 'shared-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'shared-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export const winner = "none"\n')
  const clientA = await connect(rootA, allowlistedRoot, workspace, 'alias-a')
  const clientB = await connect(rootB, allowlistedRoot, workspace, 'alias-b')
  try {
    const [openedA, openedB] = await Promise.all([
      clientA.callTool({ name: 'open_editor', arguments: { projectId: 'alias-a' } }),
      clientB.callTool({ name: 'open_editor', arguments: { projectId: 'alias-b' } }),
    ])
    assert.equal(openedA.isError, undefined)
    assert.equal(openedB.isError, undefined)
    assert.equal(openedA.structuredContent.revision, openedB.structuredContent.revision)
    const baseRevision = openedA.structuredContent.revision
    let releaseLock
    let notifyLock
    const lockHeld = new Promise(resolve => {
      notifyLock = resolve
    })
    const lock = withRuntimeLock(
      runtimeLockPathForWorkspace(await realpath(workspace)),
      async () => {
        notifyLock()
        await new Promise(resolve => {
          releaseLock = resolve
        })
      },
    )
    await lockHeld
    let settled = 0
    const edits = [
      clientA.callTool({
        name: 'apply_project_files',
        arguments: {
          projectId: 'alias-a',
          baseRevision,
          changes: [{
            type: 'write',
            path: 'src/main.js',
            text: 'export const winner = "a"\n',
          }],
        },
      }),
      clientB.callTool({
        name: 'apply_project_files',
        arguments: {
          projectId: 'alias-b',
          baseRevision,
          changes: [{
            type: 'write',
            path: 'src/main.js',
            text: 'export const winner = "b"\n',
          }],
        },
      }),
    ].map(promise => promise.finally(() => {
      settled += 1
    }))
    await new Promise(resolve => setTimeout(resolve, 75))
    assert.equal(settled, 0)
    releaseLock()
    const results = await Promise.all(edits)
    await lock
    assert.equal(results.filter(result => result.isError === undefined).length, 1)
    assert.equal(results.filter(result => result.isError === true).length, 1)
  } finally {
    await clientA.close()
    await clientB.close()
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
  }
})

test('M8 does not persist a Runtime registration cancelled while waiting for its lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connect(root, allowlistedRoot, workspace)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    const previousRunId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    const ownerMeta = runtimeMeta('cancelled-registration')
    const previous = await activateRuntime(
      client,
      'linked-game',
      opened.structuredContent.revision,
      previousRunId,
      ownerMeta,
    )
    const runId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
    let releaseLock
    let notifyLock
    const lockHeld = new Promise(resolve => {
      notifyLock = resolve
    })
    const lock = withRuntimeLock(
      runtimeLockPathForWorkspace(await realpath(workspace)),
      async () => {
        notifyLock()
        await new Promise(resolve => {
          releaseLock = resolve
        })
      },
    )
    await lockHeld
    const controller = new AbortController()
    const registration = client.callTool({
      name: 'prepare_runtime_run',
      arguments: {
        projectId: 'linked-game',
        revision: opened.structuredContent.revision,
        buildId: previous.projection.loadedBuild.buildId,
        runId,
        nonce: randomUUID(),
      },
      _meta: ownerMeta,
    }, undefined, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(registration, /abort/i)
    releaseLock()
    await lock
    const released = await client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: 'linked-game',
        runtimeRef: previous.runtimeRef,
      },
      _meta: ownerMeta,
    })
    assert.equal(released.structuredContent.released, true)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
  }
})

test('M8 does not commit Workspace writes cancelled while waiting for its lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-workspaces-'))
  const workspace = join(allowlistedRoot, 'linked-game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'linked-game',
    private: true,
    type: 'module',
    dependencies: { three: '0.185.1' },
  }, null, 2))
  await writeFile(join(workspace, 'src', 'main.js'), 'export const value = "before"\n')
  const client = await connect(root, allowlistedRoot, workspace)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'linked-game' },
    })
    let releaseLock
    let notifyLock
    const lockHeld = new Promise(resolve => {
      notifyLock = resolve
    })
    const lock = withRuntimeLock(
      runtimeLockPathForWorkspace(await realpath(workspace)),
      async () => {
        notifyLock()
        await new Promise(resolve => {
          releaseLock = resolve
        })
      },
    )
    await lockHeld
    const controller = new AbortController()
    const update = client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'linked-game',
        baseRevision: opened.structuredContent.revision,
        changes: [{
          type: 'write',
          path: 'src/main.js',
          text: 'export const value = "after"\n',
        }],
      },
    }, undefined, { signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(update, /abort/i)
    releaseLock()
    await lock

    const file = await client.callTool({
      name: 'read_project_files',
      arguments: {
        projectId: 'linked-game',
        files: [{ path: 'src/main.js' }],
      },
    })
    assert.equal(file.structuredContent.files[0].text, 'export const value = "before"\n')
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
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
    assert.match(read.content[0].text, /unknown text stays exact/)
    assert.doesNotMatch(read.content[0].text, new RegExp(binary.toString('base64')))

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

    let releaseWorkspaceLock
    let notifyWorkspaceLock
    const workspaceLockHeld = new Promise(resolve => {
      notifyWorkspaceLock = resolve
    })
    const workspaceLock = withRuntimeLock(
      runtimeLockPathForWorkspace(await realpath(workspace)),
      async () => {
        notifyWorkspaceLock()
        await new Promise(resolve => {
          releaseWorkspaceLock = resolve
        })
      },
    )
    await workspaceLockHeld
    let humanEditSettled = false
    const humanEditPromise = client.callTool({
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
    }).finally(() => {
      humanEditSettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 75))
    assert.equal(humanEditSettled, false)
    releaseWorkspaceLock()
    const humanEdit = await humanEditPromise
    await workspaceLock
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
    const managedEntry = await readFile(
      join(root, '.managed-workspaces', 'managed-pong', 'src', 'main.js'),
      'utf8',
    )
    assert.match(managedEntry, /export default/)
    assert.match(managedEntry, /setup\s*\(/)
    assert.match(managedEntry, /canvas\.focus\(\)/)
    const managedBuild = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'managed-pong',
        revision: managed.structuredContent.revision,
      },
    })
    assert.equal(managedBuild.structuredContent.status, 'ready')
    assert.deepEqual(managedBuild.structuredContent.diagnostics, [])

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

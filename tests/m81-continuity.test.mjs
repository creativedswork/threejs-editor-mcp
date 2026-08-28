import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  RUNTIME_COMMAND_MIN_TIMEOUT_MS,
  RUNTIME_COMMAND_SETTLEMENT_GRACE_MS,
  rolloverCleanupRevisions,
  runtimeCommandSettlementDeadline,
} from '../src/m7-runtime.ts'

const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))

async function connect(root) {
  const client = new Client({
    name: 'threejs-editor-mcp-m81-continuity-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, '--root', root],
  }))
  return client
}

async function connectWorkspace(root, allowlistedRoot, workspace) {
  const client = new Client({
    name: 'threejs-editor-mcp-m81-runtime-test',
    version: '0.0.0',
  })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      serverPath,
      '--root',
      root,
      '--workspace-root',
      allowlistedRoot,
      '--workspace',
      `game=${workspace}`,
    ],
  }))
  return client
}

async function startRuntimeCommand(client, runtime, meta, command) {
  const started = await client.callTool({
    name: 'start_runtime_command',
    arguments: {
      ...runtime,
      commandId: command.commandId,
    },
    _meta: meta,
  })
  assert.equal(started.isError, undefined)
  assert.ok(Number.isFinite(Date.parse(started.structuredContent.expiresAt)))
  return started.structuredContent.expiresAt
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-projects-'))
  const workspace = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-workspace-'))
  const project = join(workspace, 'pool')
  await mkdir(project)
  await writeFile(join(project, 'example.json'), JSON.stringify({
    title: 'Interactive Pool',
    backend: 'WebGL',
  }))
  await writeFile(
    join(project, 'scene.js'),
    'export default { setup() { return { version: 1 } } }\n',
  )
  return { root, workspace, project }
}

test('M8.1 cleans failed rollover identities at their acknowledged revisions', () => {
  assert.deepEqual(
    rolloverCleanupRevisions('previous', 'next', false),
    { iframeRevision: 'previous', serverRevision: 'next' },
  )
  assert.deepEqual(
    rolloverCleanupRevisions('previous', 'next', true),
    { iframeRevision: 'next', serverRevision: 'next' },
  )
})

test('M8.1 keeps imported project identity stable and reconciles ordinary source edits', async () => {
  const { root, workspace, project } = await fixture()
  const client = await connect(root)
  const meta = { 'ai.deepseek.dsh/workspace': { cwd: workspace } }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: meta,
    })
    assert.equal(opened.isError, undefined)
    const initial = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(initial.structuredContent.workspace.capabilities.command.undoable, true)
    assert.equal(
      initial.structuredContent.workspace.capabilities.extension.path,
      'pool/scene.js',
    )
    assert.deepEqual(
      initial.structuredContent.workspace.capabilities.extension.permissions,
      ['runtime'],
    )

    await writeFile(
      join(project, 'scene.js'),
      'export default { setup() { return { version: 2 } } }\n',
    )
    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        currentRevision: opened.structuredContent.revision,
      },
    })
    assert.equal(pulled.isError, undefined)
    assert.equal(pulled.structuredContent.projectId, opened.structuredContent.projectId)
    assert.equal(pulled.structuredContent.changed, true)
    assert.notEqual(pulled.structuredContent.revision, opened.structuredContent.revision)

    const reopened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: meta,
    })
    assert.equal(reopened.structuredContent.projectId, opened.structuredContent.projectId)
    assert.equal(reopened.structuredContent.revision, pulled.structuredContent.revision)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 accepts the canonical entry basename as its explicit alias', async () => {
  const { root, workspace } = await fixture()
  const client = await connect(root)
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    const inspected = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: opened.structuredContent.projectId },
    })
    assert.equal(inspected.structuredContent.source.entry, 'pool/scene.js')
    assert.equal(inspected.structuredContent.source.entryAlias, 'scene.js')

    const read = await client.callTool({
      name: 'read_project_files',
      arguments: {
        projectId: opened.structuredContent.projectId,
        files: [{ path: 'scene.js' }],
      },
    })
    assert.equal(read.isError, undefined)
    assert.equal(read.structuredContent.files[0].path, 'pool/scene.js')

    const applied = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: opened.structuredContent.projectId,
        baseRevision: opened.structuredContent.revision,
        changes: [{
          type: 'write',
          path: 'scene.js',
          text: 'export default { setup() { return { version: 2 } } }\n',
        }],
      },
    })
    assert.equal(applied.isError, undefined)
    const canonical = await client.callTool({
      name: 'read_project_files',
      arguments: {
        projectId: opened.structuredContent.projectId,
        files: [{ path: 'pool/scene.js' }],
      },
    })
    assert.match(canonical.structuredContent.files[0].text, /version: 2/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 atomically migrates a revision-derived imported project without losing metadata', async () => {
  const { root, workspace } = await fixture()
  try {
    const firstClient = await connect(root)
    const initialResult = await firstClient.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    await firstClient.close()
    const initial = initialResult.structuredContent
    const stablePath = join(root, '.managed-workspaces', initial.projectId)
    const source = JSON.parse(await readFile(
      join(stablePath, '.threejs-editor', 'source.json'),
      'utf8',
    ))
    const legacyProjectId = `example-${
      createHash('sha256')
        .update(`${source.root}\0${source.projectPath}\0${source.revision}`)
        .digest('hex')
        .slice(0, 56)
    }`
    assert.notEqual(legacyProjectId, initial.projectId)
    const marker = join(stablePath, '.threejs-editor', 'diagnostics', 'upgrade-marker.json')
    await writeFile(marker, '{"preserved":true}\n')
    await rename(stablePath, join(root, '.managed-workspaces', legacyProjectId))

    const upgradedClient = await connect(root)
    const reopened = await upgradedClient.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    await upgradedClient.close()
    assert.equal(reopened.structuredContent.projectId, initial.projectId)
    assert.equal(
      await readFile(
        join(
          root,
          '.managed-workspaces',
          initial.projectId,
          '.threejs-editor',
          'diagnostics',
          'upgrade-marker.json',
        ),
        'utf8',
      ),
      '{"preserved":true}\n',
    )
    await assert.rejects(
      readFile(join(root, '.managed-workspaces', legacyProjectId, '.threejs-editor', 'HEAD')),
      error => error.code === 'ENOENT',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 rejects duplicate or corrupt imported project migration metadata', async () => {
  const { root, workspace } = await fixture()
  try {
    const firstClient = await connect(root)
    const initial = await firstClient.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    await firstClient.close()
    const stablePath = join(root, '.managed-workspaces', initial.structuredContent.projectId)
    const duplicatePath = join(root, '.managed-workspaces', 'example-legacy')
    await cp(stablePath, duplicatePath, { recursive: true })
    const conflictedClient = await connect(root)
    const conflicted = await conflictedClient.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    await conflictedClient.close()
    assert.equal(conflicted.isError, true)
    assert.match(conflicted.content[0].text, /conflicting project identities/)
    await rm(duplicatePath, { recursive: true, force: true })
    await writeFile(join(stablePath, '.threejs-editor', 'source.json'), '{')
    const corruptClient = await connect(root)
    const corrupt = await corruptClient.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    await corruptClient.close()
    assert.equal(corrupt.isError, true)
    assert.match(corrupt.content[0].text, /JSON/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 never overwrites a locally changed managed import during source reconciliation', async () => {
  const { root, workspace, project } = await fixture()
  const client = await connect(root)
  const meta = { 'ai.deepseek.dsh/workspace': { cwd: workspace } }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: meta,
    })
    const managedScene = join(
      root,
      '.managed-workspaces',
      opened.structuredContent.projectId,
      'pool',
      'scene.js',
    )
    await writeFile(
      managedScene,
      'export default { setup() { return { version: "managed" } } }\n',
    )
    await writeFile(
      join(project, 'scene.js'),
      'export default { setup() { return { version: "source" } } }\n',
    )

    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        currentRevision: opened.structuredContent.revision,
      },
    })
    assert.equal(pulled.isError, true)
    assert.match(pulled.content[0].text, /edit the managed copy or discard/)
    assert.match(await readFile(managedScene, 'utf8'), /"managed"/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 recovers when source files were applied before import metadata was committed', async () => {
  const { root, workspace, project } = await fixture()
  const client = await connect(root)
  const meta = { 'ai.deepseek.dsh/workspace': { cwd: workspace } }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: meta,
    })
    const nextSource = 'export default { setup() { return { version: 2 } } }\n'
    await writeFile(join(project, 'scene.js'), nextSource)
    await writeFile(
      join(
        root,
        '.managed-workspaces',
        opened.structuredContent.projectId,
        'pool',
        'scene.js',
      ),
      nextSource,
    )

    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: opened.structuredContent.projectId,
        currentRevision: opened.structuredContent.revision,
      },
    })
    assert.equal(pulled.isError, undefined)
    assert.equal(pulled.structuredContent.changed, true)
    assert.notEqual(pulled.structuredContent.revision, opened.structuredContent.revision)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('M8.1 rejects hardlinked files at source and linked Workspace boundaries', async () => {
  const { root, workspace, project } = await fixture()
  const externalRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-external-'))
  const external = join(externalRoot, 'outside.js')
  await writeFile(external, 'export default { outside: true }\n')
  await unlink(join(project, 'scene.js'))
  await link(external, join(project, 'scene.js'))
  const client = await connect(root)
  try {
    const imported = await client.callTool({
      name: 'open_editor',
      arguments: { projectPath: 'pool' },
      _meta: { 'ai.deepseek.dsh/workspace': { cwd: workspace } },
    })
    assert.equal(imported.isError, true)
    assert.match(imported.content[0].text, /hardlinked/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(externalRoot, { recursive: true, force: true })
  }

  const projects = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-hardlink-projects-'))
  const allowed = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-hardlink-workspaces-'))
  const linkedWorkspace = join(allowed, 'game')
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-hardlink-outside-'))
  await mkdir(join(linkedWorkspace, 'src'), { recursive: true })
  await writeFile(join(linkedWorkspace, 'package.json'), JSON.stringify({
    name: 'game',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(outside, 'main.js'), 'export default { outside: true }\n')
  await link(join(outside, 'main.js'), join(linkedWorkspace, 'src', 'main.js'))
  const linkedClient = await connectWorkspace(projects, allowed, linkedWorkspace)
  try {
    const opened = await linkedClient.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    assert.equal(opened.isError, true)
    assert.match(opened.content[0].text, /hardlinked/)
  } finally {
    await linkedClient.close()
    await rm(projects, { recursive: true, force: true })
    await rm(allowed, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8.1 rejects editor-state writes that cannot execute on the remote project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-editor-state-'))
  const client = await connect(root)
  try {
    const created = await client.callTool({
      name: 'create_workspace',
      arguments: { projectId: 'game', title: 'Game', template: 'pong' },
    })
    const pulled = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: 'game' },
    })
    const initial = pulled.structuredContent
    const scene = structuredClone(initial.project.scene)
    const ball = scene.object.children.find(object => object.name === 'Ball')
    assert.ok(ball)
    scene.object.children = scene.object.children.filter(object => object.uuid !== ball.uuid)
    const remote = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'game',
        baseRevision: created.structuredContent.revision,
        changes: [{
          type: 'write',
          path: 'src/scene.json',
          text: `${JSON.stringify({ ...initial.project, scene }, null, 2)}\n`,
        }],
      },
    })

    const invalid = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: 'game',
        baseRevision: remote.structuredContent.revision,
        changes: [{
          type: 'write',
          path: 'threejs.editor.json',
          text: `${JSON.stringify({
            schemaVersion: 1,
            operations: [{
              type: 'set_position',
              objectUuid: ball.uuid,
              value: [1, 2, 3],
            }],
          })}\n`,
        }],
      },
    })
    assert.equal(invalid.isError, true)
    assert.match(invalid.content[0].text, new RegExp(`unknown object ${ball.uuid}`))
    const after = await client.callTool({
      name: 'pull_project',
      arguments: {
        projectId: 'game',
        currentRevision: remote.structuredContent.revision,
      },
    })
    assert.equal(after.structuredContent.changed, false)

    const viewSource = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
    const preflight = viewSource.indexOf(
      'applyOfficialEditorCommands(cloneProject(remote.project), operations)',
    )
    const applyFiles = viewSource.indexOf("name: 'apply_project_files'", preflight)
    assert.ok(preflight >= 0 && applyFiles > preflight)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('M8.1 exposes the Runtime Harness tools and exact server-owned prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-catalog-'))
  const client = await connect(root)
  try {
    const tools = await client.listTools()
    for (const name of [
      'capture_runtime_frame',
      'read_runtime_logs',
      'simulate_player_actions',
    ]) {
      const tool = tools.tools.find(candidate => candidate.name === name)
      assert.ok(tool, `${name} should be listed`)
      assert.ok(tool._meta.ui.visibility.includes('model'))
    }
    const prompts = await client.listPrompts()
    assert.ok(prompts.prompts.some(prompt => prompt.name === 'threejs-runtime-validation'))
    const prompt = await client.getPrompt({ name: 'threejs-runtime-validation' })
    const text = prompt.messages.map(message => message.content.text ?? '').join('\n')
    assert.match(text, /capture_runtime_frame/)
    assert.match(text, /低于 85 分/)
    assert.match(text, /不支持图像输入时/)
    assert.match(client.getInstructions(), /canonical workspace-relative entry/)
    assert.match(client.getInstructions(), /Do not read or search the threejs-editor-mcp or deepseek-harness/)
    await client.callTool({
      name: 'create_workspace',
      arguments: { projectId: 'contract', template: 'empty' },
    })
    const inspected = await client.callTool({
      name: 'inspect_editor',
      arguments: { projectId: 'contract' },
    })
    assert.match(inspected.structuredContent.runtimeContract.setupContext, /controls/)
    assert.match(inspected.structuredContent.runtimeContract.inputEvents, /canvas with bubbles enabled/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('M8.1 marks a claimed Runtime command before execution can fail', async () => {
  const viewSource = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')
  const remember = viewSource.indexOf('runtimeHarnessCommands.add(parsed.commandId)')
  const execute = viewSource.indexOf('await executeRuntimeHarnessCommand(parsed)', remember)
  const prepare = viewSource.indexOf('await ensureValidationRuntime(command.runtime)')
  const start = viewSource.indexOf("name: 'start_runtime_command'", prepare)
  const dispatch = viewSource.indexOf("postM7Run(targetRun, 'harness-command'", start)
  assert.ok(remember >= 0 && execute > remember)
  assert.ok(prepare >= 0 && start > prepare && dispatch > start)
})

test('M8.1 derives settlement grace from the absolute execution deadline', () => {
  const expiresAt = '2026-08-25T00:00:02.000Z'
  assert.equal(
    runtimeCommandSettlementDeadline(expiresAt),
    Date.parse(expiresAt) + RUNTIME_COMMAND_SETTLEMENT_GRACE_MS,
  )
})

test('M8.1 rejects invalid capability references, extension paths, and permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-capability-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-capability-workspaces-'))
  const workspace = join(allowlistedRoot, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'game',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connectWorkspace(root, allowlistedRoot, workspace)
  const configPath = join(workspace, '.threejs-editor', 'project.json')
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    assert.equal(opened.isError, undefined)
    const valid = JSON.parse(await readFile(configPath, 'utf8'))
    const cases = [
      {
        expected: /unknown parameter/,
        update(config) {
          config.runtime.capabilities.parameterPanel.parameters = ['missing']
        },
      },
      {
        expected: /revision entry module/,
        update(config) {
          config.runtime.capabilities.extension.path = 'src/other.js'
        },
      },
      {
        expected: /revision entry module|path/i,
        update(config) {
          config.runtime.capabilities.extension.path = '../outside.js'
        },
      },
      {
        expected: /invalid|array|tuple|too_big/i,
        update(config) {
          config.runtime.capabilities.extension.permissions = ['runtime', 'host']
        },
      },
      {
        expected: /unrecognized|invalid/i,
        update(config) {
          config.runtime.capabilities.extension.hostApi = true
        },
      },
    ]
    for (const item of cases) {
      const invalid = structuredClone(valid)
      item.update(invalid)
      await writeFile(configPath, JSON.stringify(invalid))
      const pulled = await client.callTool({
        name: 'pull_project',
        arguments: { projectId: 'game' },
      })
      assert.equal(pulled.isError, true)
      assert.match(pulled.content[0].text, item.expected)
    }
    await writeFile(configPath, JSON.stringify(valid))
    await writeFile(join(workspace, 'src', 'main.js'), `export default "${'x'.repeat(300 * 1024)}"\n`)
    const oversized = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: 'game' },
    })
    assert.equal(oversized.isError, true)
    assert.match(oversized.content[0].text, /bounded text module/)

    await writeFile(join(workspace, 'src', 'main.js'), 'import lodash from "lodash"\nexport default lodash\n')
    const unsupported = await client.callTool({
      name: 'pull_project',
      arguments: { projectId: 'game' },
    })
    assert.equal(unsupported.isError, undefined)
    const built = await client.callTool({
      name: 'build_project',
      arguments: {
        projectId: 'game',
        revision: unsupported.structuredContent.revision,
      },
    })
    assert.equal(built.structuredContent.status, 'failed')
    assert.ok(built.structuredContent.diagnostics.some(item => /pinned M9 profile/.test(item.message)))
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
  }
})

test('M8.1 isolates Runtime identities and control leases by Harness Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-session-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-session-workspaces-'))
  const workspace = join(allowlistedRoot, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'game',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connectWorkspace(root, allowlistedRoot, workspace)
  const ownerA = {
    sessionId: 'session-a',
    connectionGeneration: '11111111-1111-4111-8111-111111111111',
  }
  const ownerB = {
    sessionId: 'session-b',
    connectionGeneration: '11111111-1111-4111-8111-111111111111',
  }
  const metaA = { 'ai.deepseek.dsh/session': ownerA }
  const metaB = { 'ai.deepseek.dsh/session': ownerB }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    const built = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision: opened.structuredContent.revision },
    })
    assert.equal(built.structuredContent.status, 'ready')
    const runtimeA = {
      projectId: 'game',
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      runId: '22222222-2222-4222-8222-222222222222',
      nonce: '33333333-3333-4333-8333-333333333333',
    }
    const runtimeB = {
      ...runtimeA,
      runId: '44444444-4444-4444-8444-444444444444',
      nonce: '55555555-5555-4555-8555-555555555555',
    }
    const registrationA = await client.callTool({
      name: 'register_runtime_run',
      arguments: runtimeA,
      _meta: metaA,
    })
    const registrationB = await client.callTool({
      name: 'register_runtime_run',
      arguments: runtimeB,
      _meta: metaB,
    })
    for (const [meta, runtime] of [[metaA, runtimeA], [metaB, runtimeB]]) {
      const inspected = await client.callTool({
        name: 'inspect_project',
        arguments: { projectId: 'game' },
        _meta: meta,
      })
      assert.equal(inspected.structuredContent.runtime.runId, runtime.runId)
    }

    const pendingA = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtimeA, target: 'validation', cursor: 0, limit: 1 },
      _meta: metaA,
    })
    const pendingB = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtimeB, target: 'validation', cursor: 0, limit: 1 },
      _meta: metaB,
    })
    await new Promise(resolve => setImmediate(resolve))
    const commandA = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtimeA,
      _meta: metaA,
    })).structuredContent.command
    const commandB = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtimeB,
      _meta: metaB,
    })).structuredContent.command
    assert.notEqual(commandA.commandId, commandB.commandId)
    for (const item of [
      [runtimeA, metaA, commandA, registrationA.structuredContent.evidenceToken],
      [runtimeB, metaB, commandB, registrationB.structuredContent.evidenceToken],
    ]) {
      const [runtime, meta, command, evidenceToken] = item
      await startRuntimeCommand(client, runtime, meta, command)
      const reported = await client.callTool({
        name: 'report_runtime_evidence',
        arguments: {
          ...runtime,
          commandId: command.commandId,
          result: {
            kind: 'runtime-logs',
            runtime: { ...runtime, target: 'validation' },
            evidenceId: crypto.randomUUID(),
            evidenceToken,
            entries: [],
            nextCursor: 0,
            truncated: false,
          },
        },
        _meta: meta,
      })
      assert.equal(reported.isError, undefined)
    }
    assert.equal((await pendingA).isError, undefined)
    assert.equal((await pendingB).isError, undefined)

    const releasedB = await client.callTool({
      name: 'release_runtime_run',
      arguments: runtimeB,
      _meta: metaB,
    })
    assert.equal(releasedB.structuredContent.released, true)
    const stillActiveA = await client.callTool({
      name: 'inspect_project',
      arguments: { projectId: 'game' },
      _meta: metaA,
    })
    assert.equal(stillActiveA.structuredContent.runtime.runId, runtimeA.runId)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
  }
})

test('M8.1 Runtime broker rejects foreign and stale callers and releases its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-broker-projects-'))
  const allowlistedRoot = await mkdtemp(join(tmpdir(), 'threejs-editor-m81-broker-workspaces-'))
  const workspace = join(allowlistedRoot, 'game')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    name: 'game',
    private: true,
    dependencies: { three: '0.185.1' },
  }))
  await writeFile(join(workspace, 'src', 'main.js'), 'export default {}\n')
  const client = await connectWorkspace(root, allowlistedRoot, workspace)
  const owner = {
    sessionId: 'session-a',
    connectionGeneration: '11111111-1111-4111-8111-111111111111',
  }
  const foreign = {
    sessionId: 'session-b',
    connectionGeneration: owner.connectionGeneration,
  }
  const ownerMeta = { 'ai.deepseek.dsh/session': owner }
  const foreignMeta = { 'ai.deepseek.dsh/session': foreign }
  try {
    const opened = await client.callTool({
      name: 'open_editor',
      arguments: { projectId: 'game' },
    })
    const built = await client.callTool({
      name: 'build_project',
      arguments: { projectId: 'game', revision: opened.structuredContent.revision },
    })
    assert.equal(built.structuredContent.status, 'ready')
    let runtime = {
      projectId: 'game',
      revision: opened.structuredContent.revision,
      buildId: built.structuredContent.buildId,
      runId: '22222222-2222-4222-8222-222222222222',
      nonce: '33333333-3333-4333-8333-333333333333',
    }
    const registered = await client.callTool({
      name: 'register_runtime_run',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(registered.isError, undefined)
    const evidenceToken = registered.structuredContent.evidenceToken
    assert.equal(typeof evidenceToken, 'string')
    const undersizedTimeout = await client.callTool({
      name: 'read_runtime_logs',
      arguments: {
        ...runtime,
        target: 'validation',
        cursor: 0,
        limit: 1,
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS - 1,
      },
      _meta: ownerMeta,
    })
    assert.equal(undersizedTimeout.isError, true)
    const ownerlessRelease = await client.callTool({
      name: 'release_runtime_run',
      arguments: {
        projectId: runtime.projectId,
        revision: runtime.revision,
        runId: runtime.runId,
      },
    })
    assert.equal(ownerlessRelease.isError, true)
    assert.match(ownerlessRelease.content[0].text, /owner identity is required/)
    const foreignPull = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: foreignMeta,
    })
    assert.equal(foreignPull.isError, true)
    assert.match(foreignPull.content[0].text, /another Harness Session/)
    const stalePull = await client.callTool({
      name: 'pull_runtime_command',
      arguments: { ...runtime, nonce: crypto.randomUUID() },
      _meta: ownerMeta,
    })
    assert.equal(stalePull.isError, true)
    assert.match(stalePull.content[0].text, /stale or incomplete/)

    const pending = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtime, target: 'validation', cursor: 0, limit: 10 },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const pulled = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })
    const command = pulled.structuredContent.command
    assert.equal(command.kind, 'read-logs')
    const busy = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: { ...runtime, target: 'validation' },
      _meta: ownerMeta,
    })
    assert.equal(busy.isError, true)
    assert.match(busy.content[0].text, /lease is busy/)
    const foreignReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: foreignMeta,
    })
    assert.equal(foreignReport.isError, true)
    assert.match(foreignReport.content[0].text, /another Harness Session/)
    await startRuntimeCommand(client, runtime, ownerMeta, command)
    const staleEvidence = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: {
            ...runtime,
            nonce: crypto.randomUUID(),
            target: 'validation',
          },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(staleEvidence.isError, true)
    assert.match(staleEvidence.content[0].text, /evidence identity is stale or foreign/)
    const forgedEvidence = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken: crypto.randomUUID(),
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(forgedEvidence.isError, true)
    assert.match(forgedEvidence.content[0].text, /evidence identity is stale or foreign/)
    const forgedBuild = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, buildId: '0'.repeat(64), target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(forgedBuild.isError, true)
    assert.match(forgedBuild.content[0].text, /evidence identity is stale or foreign/)
    const { buildId: _buildId, ...runtimeWithoutBuild } = runtime
    const missingBuild = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtimeWithoutBuild, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(missingBuild.isError, true)
    const mismatchedEvidence = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'capture-frame',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          digest: '0'.repeat(64),
          mimeType: 'image/png',
          data: 'AA==',
          width: 1,
          height: 1,
          frame: 0,
          capturedAt: new Date().toISOString(),
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(mismatchedEvidence.isError, true)
    assert.match(mismatchedEvidence.content[0].text, /kind does not match/)
    const accepted = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(accepted.isError, undefined)
    const completed = await pending
    assert.equal(completed.isError, undefined)
    assert.equal(completed.structuredContent.evidenceToken, undefined)
    const duplicate = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: command.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: '44444444-4444-4444-8444-444444444444',
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(duplicate.isError, true)
    assert.match(duplicate.content[0].text, /stale or foreign/)

    const abortController = new AbortController()
    const cancelled = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtime, target: 'validation', cursor: 0, limit: 10 },
      _meta: ownerMeta,
    }, undefined, { signal: abortController.signal })
    await new Promise(resolve => setImmediate(resolve))
    const cancelledCommand = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(cancelledCommand.structuredContent.command.kind, 'read-logs')
    abortController.abort()
    await assert.rejects(cancelled, /abort/i)
    await new Promise(resolve => setTimeout(resolve, 20))
    const afterCancel = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(afterCancel.structuredContent.command, undefined)
    const afterCancelPending = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtime, target: 'validation', cursor: 0, limit: 1 },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const afterCancelCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    assert.equal(afterCancelCommand.kind, 'read-logs')
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    const stillPreparing = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    assert.equal(stillPreparing.commandId, afterCancelCommand.commandId)
    await startRuntimeCommand(client, runtime, ownerMeta, afterCancelCommand)
    const afterCancelReported = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: afterCancelCommand.commandId,
        result: {
          kind: 'runtime-logs',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          entries: [],
          nextCursor: 0,
          truncated: false,
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(afterCancelReported.isError, undefined)
    assert.equal((await afterCancelPending).isError, undefined)

    const preparationFailurePending = client.callTool({
      name: 'read_runtime_logs',
      arguments: { ...runtime, target: 'validation', cursor: 0, limit: 1 },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const preparationFailureCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    const preparationFailure = await client.callTool({
      name: 'fail_runtime_command',
      arguments: {
        ...runtime,
        commandId: preparationFailureCommand.commandId,
        message: 'Validation Runtime failed',
      },
      _meta: ownerMeta,
    })
    assert.equal(preparationFailure.isError, undefined)
    const preparationFailureResult = await preparationFailurePending
    assert.equal(preparationFailureResult.isError, true)
    assert.match(preparationFailureResult.content[0].text, /preparation failed/)

    const activeWithoutIntent = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'active',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    assert.equal(activeWithoutIntent.isError, true)
    assert.match(activeWithoutIntent.content[0].text, /explicit user-requested intent/)
    const activeWithoutGrant = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'active',
        activeIntent: 'user-requested',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    assert.equal(activeWithoutGrant.isError, true)
    assert.match(activeWithoutGrant.content[0].text, /current user grant/)
    const grant = await client.callTool({
      name: 'grant_active_runtime_control',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(grant.isError, undefined)
    assert.ok(Number.isFinite(Date.parse(grant.structuredContent.expiresAt)))
    const activeCapture = client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'active',
        activeIntent: 'user-requested',
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const activeCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    assert.equal(activeCommand.target, 'active')
    await startRuntimeCommand(client, runtime, ownerMeta, activeCommand)
    const oversizedEvidence = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: activeCommand.commandId,
        result: {
          kind: 'capture-frame',
          runtime: { ...runtime, target: 'active' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          digest: '0'.repeat(64),
          mimeType: 'image/png',
          data: 'A'.repeat(512 * 1024 + 1),
          width: 1,
          height: 1,
          frame: 0,
          capturedAt: new Date().toISOString(),
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(oversizedEvidence.isError, true)
    const activeEvidence = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: activeCommand.commandId,
        result: {
          kind: 'capture-frame',
          runtime: { ...runtime, target: 'active' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          digest: '0'.repeat(64),
          mimeType: 'image/png',
          data: 'AA==',
          width: 1,
          height: 1,
          frame: 0,
          capturedAt: new Date().toISOString(),
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(activeEvidence.isError, undefined)
    assert.equal((await activeCapture).isError, undefined)
    const consumedGrant = await client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'active',
        activeIntent: 'user-requested',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    assert.equal(consumedGrant.isError, true)
    assert.match(consumedGrant.content[0].text, /current user grant/)

    const deadlineTracePending = client.callTool({
      name: 'simulate_player_actions',
      arguments: {
        ...runtime,
        target: 'validation',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
        actions: [{ type: 'waitFrames', frames: 600 }],
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const deadlineTraceCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, deadlineTraceCommand)
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    const deadlineTraceReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: deadlineTraceCommand.commandId,
        result: {
          kind: 'action-trace',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          status: 'failed',
          startFrame: 10,
          endFrame: 12,
          trace: [{
            index: 0,
            type: 'waitFrames',
            frame: 12,
            status: 'failed',
            message: 'Runtime Harness command timed out',
          }],
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(deadlineTraceReport.isError, undefined)
    const deadlineTrace = await deadlineTracePending
    assert.equal(deadlineTrace.isError, undefined)
    assert.equal(deadlineTrace.structuredContent.status, 'failed')

    const lateSuccessPending = client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'validation',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const lateSuccessCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, lateSuccessCommand)
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    const lateSuccessReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: lateSuccessCommand.commandId,
        result: {
          kind: 'capture-frame',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          digest: '0'.repeat(64),
          mimeType: 'image/png',
          data: 'AA==',
          width: 1,
          height: 1,
          frame: 0,
          capturedAt: new Date(Date.now() - 50).toISOString(),
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(lateSuccessReport.isError, true)
    assert.match(lateSuccessReport.content[0].text, /missed its execution deadline/)
    const lateSuccess = await lateSuccessPending
    assert.equal(lateSuccess.isError, true)
    assert.match(lateSuccess.content[0].text, /timed out/)

    const lateCancelledPending = client.callTool({
      name: 'simulate_player_actions',
      arguments: {
        ...runtime,
        target: 'validation',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
        actions: [{ type: 'waitFrames', frames: 600 }],
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const lateCancelledCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, lateCancelledCommand)
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    const lateCancelledReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: lateCancelledCommand.commandId,
        result: {
          kind: 'action-trace',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          status: 'cancelled',
          startFrame: 10,
          endFrame: 12,
          trace: [{
            index: 0,
            type: 'waitFrames',
            frame: 12,
            status: 'failed',
            message: 'Runtime Harness command cancelled',
          }],
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(lateCancelledReport.isError, undefined)
    const lateCancelled = await lateCancelledPending
    assert.equal(lateCancelled.isError, undefined)
    assert.equal(lateCancelled.structuredContent.status, 'cancelled')

    const lateHarnessErrorPending = client.callTool({
      name: 'read_runtime_logs',
      arguments: {
        ...runtime,
        target: 'validation',
        cursor: 0,
        limit: 1,
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const lateHarnessErrorCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, lateHarnessErrorCommand)
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    const lateHarnessErrorReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: lateHarnessErrorCommand.commandId,
        result: {
          kind: 'runtime-harness-error',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          status: 'failed',
          message: 'Runtime Harness command timed out',
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(lateHarnessErrorReport.isError, undefined)
    assert.equal((await lateHarnessErrorPending).isError, true)

    const graceAbortController = new AbortController()
    const graceAbortPending = client.callTool({
      name: 'read_runtime_logs',
      arguments: {
        ...runtime,
        target: 'validation',
        cursor: 0,
        limit: 1,
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    }, undefined, { signal: graceAbortController.signal })
    await new Promise(resolve => setImmediate(resolve))
    const graceAbortCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, graceAbortCommand)
    await new Promise(resolve => setTimeout(
      resolve,
      RUNTIME_COMMAND_MIN_TIMEOUT_MS + 25,
    ))
    graceAbortController.abort()
    await assert.rejects(graceAbortPending, /abort/i)
    await new Promise(resolve => setTimeout(resolve, 20))
    const afterGraceAbort = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(afterGraceAbort.structuredContent.command, undefined)

    const timedOutPending = client.callTool({
      name: 'capture_runtime_frame',
      arguments: {
        ...runtime,
        target: 'validation',
        timeoutMs: RUNTIME_COMMAND_MIN_TIMEOUT_MS,
      },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const timedOutCommand = (await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })).structuredContent.command
    await startRuntimeCommand(client, runtime, ownerMeta, timedOutCommand)
    const timedOut = await timedOutPending
    assert.equal(timedOut.isError, true)
    assert.match(timedOut.content[0].text, /timed out/)
    const afterTimeout = await client.callTool({
      name: 'pull_runtime_command',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(afterTimeout.structuredContent.command, undefined)
    const lateReport = await client.callTool({
      name: 'report_runtime_evidence',
      arguments: {
        ...runtime,
        commandId: timedOutCommand.commandId,
        result: {
          kind: 'capture-frame',
          runtime: { ...runtime, target: 'validation' },
          evidenceId: crypto.randomUUID(),
          evidenceToken,
          digest: '0'.repeat(64),
          mimeType: 'image/png',
          data: 'AA==',
          width: 1,
          height: 1,
          frame: 0,
          capturedAt: new Date().toISOString(),
        },
      },
      _meta: ownerMeta,
    })
    assert.equal(lateReport.isError, true)
    assert.match(lateReport.content[0].text, /stale or foreign/)
    assert.equal(RUNTIME_COMMAND_MIN_TIMEOUT_MS, 2_000)
    assert.equal(RUNTIME_COMMAND_SETTLEMENT_GRACE_MS, 2_000)

    const rollover = client.callTool({
      name: 'capture_runtime_frame',
      arguments: { ...runtime, target: 'validation' },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const changed = await client.callTool({
      name: 'apply_project_files',
      arguments: {
        projectId: runtime.projectId,
        baseRevision: runtime.revision,
        changes: [{
          type: 'write',
          path: 'src/main.js',
          text: 'export default { revision: 2 }\n',
        }],
      },
    })
    const previousRevision = runtime.revision
    runtime = { ...runtime, revision: changed.structuredContent.revision, buildId: undefined }
    const advanced = await client.callTool({
      name: 'register_runtime_run',
      arguments: { ...runtime, previousRevision },
      _meta: ownerMeta,
    })
    assert.equal(advanced.isError, undefined)
    assert.equal(advanced.structuredContent.evidenceToken, evidenceToken)
    const rolloverResult = await rollover
    assert.equal(rolloverResult.isError, true)
    assert.match(rolloverResult.content[0].text, /revision changed/)

    const disposed = client.callTool({
      name: 'capture_runtime_frame',
      arguments: { ...runtime, target: 'validation' },
      _meta: ownerMeta,
    })
    await new Promise(resolve => setImmediate(resolve))
    const released = await client.callTool({
      name: 'release_runtime_run',
      arguments: runtime,
      _meta: ownerMeta,
    })
    assert.equal(released.structuredContent.released, true)
    const disposedResult = await disposed
    assert.equal(disposedResult.isError, true)
    assert.match(disposedResult.content[0].text, /disposed/)
  } finally {
    await client.close()
    await rm(root, { recursive: true, force: true })
    await rm(allowlistedRoot, { recursive: true, force: true })
  }
})

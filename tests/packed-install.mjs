import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'threejs-editor-pack-'))
const packed = join(temporary, 'packed')
const installed = join(temporary, 'installed')
const projects = join(temporary, 'projects')
await mkdir(packed)
await mkdir(installed)
await writeFile(join(installed, 'package.json'), '{"private":true}\n')

try {
  execFileSync('pnpm', ['pack', '--pack-destination', packed], {
    cwd: repository,
    stdio: 'inherit',
  })
  const archives = (await readdir(packed)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1)
  const archive = join(packed, archives[0])

  execFileSync('pnpm', [
    '--dir',
    installed,
    'add',
    '--ignore-scripts',
    archive,
  ], { stdio: 'inherit' })

  const packageRoot = join(installed, 'node_modules', 'threejs-editor-mcp')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.bin['threejs-editor-mcp'], './dist/server.js')
  await Promise.all([
    readFile(join(packageRoot, 'dist', 'server.js')),
    readFile(join(packageRoot, 'dist', 'view.js')),
    readFile(join(packageRoot, 'README.md')),
    readFile(join(packageRoot, 'LICENSE')),
  ])

  const command = join(installed, 'node_modules', '.bin', 'threejs-editor-mcp')
  const client = new Client({
    name: 'threejs-editor-packed-install',
    version: '0.1.0',
  })
  await client.connect(new StdioClientTransport({
    command,
    args: ['--root', projects],
  }))
  try {
    const tools = await client.listTools()
    assert.equal(tools.tools.some(tool => tool.name === 'create_project'), true)
    const created = await client.callTool({
      name: 'create_project',
      arguments: {
        projectId: 'packed-pong',
        title: 'Packed Pong',
        template: 'pong',
      },
    })
    assert.equal(created.isError, undefined)
    assert.match(created.structuredContent.revision, /^[a-f0-9]{64}$/)
    const resource = await client.readResource({ uri: 'ui://threejs-editor/app' })
    assert.equal(resource.contents[0]?.text?.includes('__THREE_M4__'), true)
  } finally {
    await client.close()
  }

  process.stdout.write(`${JSON.stringify({
    archive,
    version: manifest.version,
    executable: command,
    project: join(projects, 'packed-pong', 'project.json'),
  }, null, 2)}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

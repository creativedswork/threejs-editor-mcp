import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resetGeneratedWorkspace } from '../scripts/generated-workspace.mjs'

test('generated Workspace reset rejects unowned directories', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'threejs-editor-unowned-'))
  const sentinel = join(destination, 'sentinel.txt')
  await writeFile(sentinel, 'keep\n')
  try {
    await assert.rejects(
      resetGeneratedWorkspace(destination, 'test-generator'),
      /destination is not owned/,
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'keep\n')
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})

test('generated Workspace reset replaces only its own prior output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-owned-'))
  const destination = join(parent, 'workspace')
  try {
    await resetGeneratedWorkspace(destination, 'test-generator')
    await writeFile(join(destination, 'stale.txt'), 'remove\n')
    await resetGeneratedWorkspace(destination, 'test-generator')
    await assert.rejects(readFile(join(destination, 'stale.txt')), { code: 'ENOENT' })
    assert.equal(
      await readFile(join(destination, '.threejs-editor', 'generated-workspace'), 'utf8'),
      'test-generator\n',
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('generated Workspace reset migrates a recognized pre-marker output', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-legacy-'))
  const destination = join(parent, 'workspace')
  await mkdir(join(destination, '.threejs-editor'), { recursive: true })
  await writeFile(join(destination, 'package.json'), JSON.stringify({
    name: 'legacy-generator',
  }))
  await writeFile(
    join(destination, '.threejs-editor', 'project.json'),
    JSON.stringify({
      title: 'Legacy Generator',
      entry: 'src/main.js',
      backend: 'webgl',
    }),
  )
  await writeFile(join(destination, 'sentinel.txt'), 'remove\n')
  try {
    await resetGeneratedWorkspace(destination, 'test-generator', {
      packageName: 'legacy-generator',
      title: 'Legacy Generator',
      entry: 'src/main.js',
      backend: 'webgl',
    })
    await assert.rejects(readFile(join(destination, 'sentinel.txt')), { code: 'ENOENT' })
    assert.equal(
      await readFile(join(destination, '.threejs-editor', 'generated-workspace'), 'utf8'),
      'test-generator\n',
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('generated Workspace reset rejects symlinked ownership metadata', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-marker-link-'))
  const destination = join(parent, 'workspace')
  const external = join(parent, 'external')
  await mkdir(destination)
  await mkdir(external)
  await writeFile(join(destination, 'sentinel.txt'), 'keep\n')
  await writeFile(join(external, 'generated-workspace'), 'test-generator\n')
  await symlink(external, join(destination, '.threejs-editor'))
  try {
    await assert.rejects(
      resetGeneratedWorkspace(destination, 'test-generator'),
      /destination is not owned/,
    )
    assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'keep\n')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test('generated Workspace reset rejects symlinked destination ancestors', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'threejs-editor-parent-link-'))
  const external = join(parent, 'external')
  const linkedParent = join(parent, 'linked-parent')
  const destination = join(linkedParent, 'workspace')
  await mkdir(join(external, 'workspace', '.threejs-editor'), { recursive: true })
  await writeFile(join(external, 'workspace', 'sentinel.txt'), 'keep\n')
  await writeFile(
    join(external, 'workspace', '.threejs-editor', 'generated-workspace'),
    'test-generator\n',
  )
  await symlink(external, linkedParent)
  try {
    await assert.rejects(
      resetGeneratedWorkspace(destination, 'test-generator'),
      /destination path must not contain symbolic links/,
    )
    assert.equal(
      await readFile(join(external, 'workspace', 'sentinel.txt'), 'utf8'),
      'keep\n',
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

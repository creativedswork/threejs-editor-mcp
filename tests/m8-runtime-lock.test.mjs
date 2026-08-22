import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { withRuntimeLock } from '../src/runtime-lock.ts'

const projectRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

async function waitForLine(child, expected) {
  let output = ''
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    for await (const chunk of child.stdout) {
      output += chunk
      if (output.includes(`${expected}\n`)) return
    }
    throw new Error(`lock holder exited before ${JSON.stringify(expected)}: ${output}`)
  } finally {
    clearTimeout(timeout)
  }
}

test('M8 Runtime lock serializes async work in one process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const path = join(root, 'runtime-owner-lock.sqlite')
  let active = 0
  let maximum = 0
  try {
    await Promise.all(Array.from({ length: 4 }, () => withRuntimeLock(path, async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active -= 1
    })))
    assert.equal(maximum, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('M8 Runtime lock times out while queued in one process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const path = join(root, 'runtime-owner-lock.sqlite')
  let release
  let entered
  const started = new Promise(resolve => {
    entered = resolve
  })
  const blocker = withRuntimeLock(path, async () => {
    entered()
    await new Promise(resolve => {
      release = resolve
    })
  })
  try {
    await started
    const before = Date.now()
    await assert.rejects(
      withRuntimeLock(path, async () => {}, 30),
      /runtime ownership lock timed out/,
    )
    assert.ok(Date.now() - before < 250)
  } finally {
    release?.()
    await blocker
    await rm(root, { recursive: true, force: true })
  }
})

test('M8 Runtime lock cannot acquire after its deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const path = join(root, 'runtime-owner-lock.sqlite')
  const owner = new DatabaseSync(path)
  owner.exec('BEGIN IMMEDIATE')
  let entered = false
  const released = new Promise(resolve => {
    setTimeout(() => {
      owner.exec('ROLLBACK')
      resolve()
    }, 27)
  })
  try {
    await assert.rejects(
      withRuntimeLock(path, async () => {
        entered = true
      }, 25),
      /runtime ownership lock timed out/,
    )
    await released
    assert.equal(entered, false)
  } finally {
    owner.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('M8 Runtime lock rejects symlinked lock files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const path = join(root, 'runtime-owner-lock.sqlite')
  const outside = join(root, 'outside.txt')
  try {
    await writeFile(outside, 'preserved')
    await symlink(outside, path)
    await assert.rejects(
      withRuntimeLock(path, async () => {}),
      /runtime ownership lock is not a private regular file/,
    )
    assert.equal(await readFile(outside, 'utf8'), 'preserved')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('M8 Runtime lock rejects symlinked lock ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-outside-'))
  const parent = join(root, 'owner')
  try {
    await symlink(outside, parent)
    await assert.rejects(
      withRuntimeLock(join(parent, 'locks', 'runtime.sqlite'), async () => {}),
      /runtime ownership lock directory is not private/,
    )
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('M8 Runtime lock rejects live owners and recovers after process exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-m8-runtime-lock-'))
  const path = join(root, 'runtime-owner-lock.sqlite')
  const moduleUrl = pathToFileURL(join(projectRoot, 'src', 'runtime-lock.ts')).href
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `
      import { withRuntimeLock } from ${JSON.stringify(moduleUrl)}
      await withRuntimeLock(process.env.RUNTIME_LOCK_PATH, async () => {
        process.stdout.write('locked\\n')
        await new Promise(() => setInterval(() => {}, 1_000))
      })
    `,
  ], {
    env: { ...process.env, RUNTIME_LOCK_PATH: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForLine(child, 'locked')
    await assert.rejects(
      withRuntimeLock(path, async () => {}, 100),
      /runtime ownership lock timed out/,
    )

    child.kill('SIGKILL')
    await once(child, 'exit')

    let acquired = false
    await withRuntimeLock(path, async () => {
      acquired = true
    })
    assert.equal(acquired, true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    await rm(root, { recursive: true, force: true })
  }
})

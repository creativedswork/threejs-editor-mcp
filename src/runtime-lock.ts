import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const processLocks = new Map<string, Promise<void>>()

function isBusy(error: unknown): boolean {
  return (error as { errcode?: unknown }).errcode === 5
}

async function prepareLockPath(path: string): Promise<string> {
  const target = resolve(path)
  const roots = [...new Set([
    resolve(tmpdir()),
    ...(process.platform === 'win32' ? [] : ['/tmp']),
  ])]
  const root = roots.find(candidate => {
    const candidatePath = relative(candidate, target)
    return !candidatePath.startsWith('..') && !isAbsolute(candidatePath)
  })
  if (root === undefined) {
    throw new Error('runtime ownership lock must be inside the temporary directory')
  }
  const resolvedRoot = await realpath(root)
  const directory = dirname(target)
  const relativeDirectory = relative(root, directory)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let current = root
  let resolvedCurrent = resolvedRoot
  for (const part of relativeDirectory === '' ? [] : relativeDirectory.split(sep)) {
    current = join(current, part)
    resolvedCurrent = join(resolvedCurrent, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(current)
    if (!info.isDirectory()
      || info.isSymbolicLink()
      || (uid !== undefined && info.uid !== uid)
      || await realpath(current) !== resolvedCurrent) {
      throw new Error('runtime ownership lock directory is not private')
    }
    if (process.platform !== 'win32') await chmod(current, 0o700)
  }
  try {
    const file = await lstat(target)
    if (!file.isFile()
      || file.isSymbolicLink()
      || file.nlink !== 1
      || (uid !== undefined && file.uid !== uid)) {
      throw new Error('runtime ownership lock is not a private regular file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

export function runtimeLockPathForWorkspace(workspacePath: string): string {
  const owner = typeof process.getuid === 'function' ? String(process.getuid()) : 'default'
  const identity = createHash('sha256').update(workspacePath).digest('hex')
  const root = process.platform === 'win32' ? tmpdir() : '/tmp'
  return join(root, `threejs-editor-mcp-${owner}`, 'locks', `${identity}.sqlite`)
}

async function withProcessLock<T>(
  path: string,
  deadline: number,
  action: () => Promise<T>,
): Promise<T> {
  const previous = processLocks.get(path) ?? Promise.resolve()
  let release = (): void => {}
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(() => current)
  processLocks.set(path, tail)
  try {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('runtime ownership lock timed out')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        previous,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('runtime ownership lock timed out')),
            remaining,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (Date.now() >= deadline) throw new Error('runtime ownership lock timed out')
    return await action()
  } finally {
    release()
    void tail.then(() => {
      if (processLocks.get(path) === tail) processLocks.delete(path)
    })
  }
}

export async function withRuntimeLock<T>(
  path: string,
  action: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  return withProcessLock(path, deadline, async () => {
    const lockPath = await prepareLockPath(path)
    const database = new DatabaseSync(lockPath)
    let acquired = false
    try {
      if (process.platform !== 'win32') await chmod(lockPath, 0o600)
      database.exec('PRAGMA busy_timeout = 0')
      while (!acquired) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error('runtime ownership lock timed out')
        }
        try {
          database.exec('BEGIN IMMEDIATE')
          acquired = true
        } catch (error) {
          if (!isBusy(error)) throw error
          const retryRemaining = deadline - Date.now()
          if (retryRemaining <= 0) {
            throw new Error('runtime ownership lock timed out')
          }
          await delay(Math.min(10, retryRemaining))
        }
      }
      if (Date.now() >= deadline) {
        database.exec('ROLLBACK')
        acquired = false
        throw new Error('runtime ownership lock timed out')
      }
      try {
        const result = await action()
        database.exec('COMMIT')
        acquired = false
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        acquired = false
        throw error
      }
    } finally {
      if (acquired) {
        try {
          database.exec('ROLLBACK')
        } catch {}
      }
      database.close()
    }
  })
}

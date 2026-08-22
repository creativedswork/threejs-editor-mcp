import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute } from 'node:path'

type BoundOperation = 'create' | 'delete' | 'replace'

interface BoundOperationOptions {
  onBound?: () => Promise<void> | void
}

const BOUND_IO_HELPER = String.raw`
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, isAbsolute, relative } from 'node:path'

const [operation, root, expectedParent, name] = process.argv.slice(1)
const within = (parent, candidate) => {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
const fail = message => {
  throw new Error(message)
}

try {
  if (!['create', 'delete', 'replace'].includes(operation)
    || !isAbsolute(root)
    || !isAbsolute(expectedParent)
    || basename(name) !== name
    || name === '.'
    || name === '..') {
    fail('invalid bound Workspace operation')
  }
  const parent = await realpath('.')
  if (parent !== expectedParent || !within(root, parent)) {
    fail('Workspace parent changed before the filesystem operation')
  }

  process.stdout.write('bound\n')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)

  if (operation === 'delete') {
    const target = await lstat(name)
    if (!target.isFile() || target.isSymbolicLink()) {
      fail('Workspace target is not a regular file')
    }
    await unlink(name)
  } else if (operation === 'create') {
    let file
    try {
      file = await open(
        name,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        0o600,
      )
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const target = await lstat(name)
        if (!target.isFile() || target.isSymbolicLink()) {
          fail('Workspace target is not a regular file')
        }
        process.exitCode = 10
      } else {
        throw error
      }
    }
    if (file !== undefined) {
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
    }
  } else {
    const temporary = '.threejs-editor-write-' + process.pid + '-' + randomUUID() + '.tmp'
    let file
    try {
      file = await open(
        temporary,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW,
        0o600,
      )
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      file = undefined
      try {
        const target = await lstat(name)
        if (!target.isFile() || target.isSymbolicLink()) {
          fail('Workspace target is not a regular file')
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await rename(temporary, name)
    } catch (error) {
      await file?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  const directory = await open('.', constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
`

async function boundOperation(
  operation: BoundOperation,
  root: string,
  path: string,
  bytes: Uint8Array | string = '',
  options: BoundOperationOptions = {},
): Promise<boolean> {
  if (!isAbsolute(root) || !isAbsolute(path)) {
    throw new Error('bound Workspace paths must be absolute')
  }
  const parent = dirname(path)
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      BOUND_IO_HELPER,
      '--',
      operation,
      root,
      parent,
      basename(path),
    ],
    {
      cwd: parent,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let errors = ''
  let bound = false
  let resolveBound!: () => void
  const boundPromise = new Promise<void>(resolve => {
    resolveBound = resolve
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += chunk
    if (!bound && output.includes('\n')) {
      bound = true
      resolveBound()
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    if (errors.length < 16_384) errors += chunk.slice(0, 16_384 - errors.length)
  })
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveCompletion, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolveCompletion({ code, signal }))
    },
  )
  const state = await Promise.race([
    boundPromise.then(() => 'bound' as const),
    completion.then(() => 'closed' as const),
  ])
  if (state === 'closed') {
    const result = await completion
    throw new Error(
      errors || `bound Workspace operation exited before binding (${String(result.code)})`,
    )
  }
  try {
    await options.onBound?.()
  } catch (error) {
    child.kill()
    child.stdin.end()
    await completion.catch(() => {})
    throw error
  }
  const input = typeof bytes === 'string' ? Buffer.from(bytes) : bytes
  await new Promise<void>((resolveInput, reject) => {
    child.stdin.once('error', reject)
    child.stdin.end(input, resolveInput)
  })
  const result = await completion
  if (operation === 'create' && result.code === 10) return false
  if (result.code !== 0) {
    throw new Error(
      errors || `bound Workspace operation failed (${String(result.code ?? result.signal)})`,
    )
  }
  return true
}

export function createFileBound(
  root: string,
  path: string,
  bytes: Uint8Array | string,
  options?: BoundOperationOptions,
): Promise<boolean> {
  return boundOperation('create', root, path, bytes, options)
}

export async function removeFileBound(
  root: string,
  path: string,
  options?: BoundOperationOptions,
): Promise<void> {
  await boundOperation('delete', root, path, '', options)
}

export async function replaceFileBound(
  root: string,
  path: string,
  bytes: Uint8Array | string,
  options?: BoundOperationOptions,
): Promise<void> {
  await boundOperation('replace', root, path, bytes, options)
}

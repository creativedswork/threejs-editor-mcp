import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MARKER = join('.threejs-editor', 'generated-workspace')

async function regularJson(path) {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile() || info.isSymbolicLink()) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function matchesLegacyWorkspace(path, legacy) {
  if (legacy === undefined) return false
  const packageJson = await regularJson(join(path, 'package.json'))
  const project = await regularJson(join(path, '.threejs-editor', 'project.json'))
  if (packageJson?.name !== legacy.packageName
    || project?.title !== legacy.title
    || project?.entry !== legacy.entry
    || project?.backend !== legacy.backend) return false
  if (legacy.provenance === undefined) return true
  const provenance = await regularJson(join(path, legacy.provenance.path))
  return provenance?.source === legacy.provenance.source
    && provenance?.commit === legacy.provenance.commit
    && provenance?.example === legacy.provenance.example
}

function childPath(root, path) {
  const child = relative(root, path)
  return child !== ''
    && child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
    ? child
    : undefined
}

async function verifiedDestination(destination) {
  const lexical = resolve(destination)
  const requestedRoots = [resolve(process.cwd()), resolve(tmpdir()), resolve('/tmp')]
  const canonicalRoots = await Promise.all(requestedRoots.map(
    root => realpath(root).catch(() => undefined),
  ))
  const roots = [...new Set([
    ...requestedRoots,
    ...canonicalRoots.filter(root => root !== undefined),
  ])]
    .sort((left, right) => right.length - left.length)
  for (const root of roots) {
    const child = childPath(root, lexical)
    if (child === undefined) continue
    const parts = child.split(sep)
    let current = root
    let canonical = await realpath(root)
    for (const [index, part] of parts.entries()) {
      current = join(current, part)
      let info
      try {
        info = await lstat(current)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return join(canonical, ...parts.slice(index))
      }
      if (info.isSymbolicLink()) {
        throw new Error('destination path must not contain symbolic links')
      }
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error('destination parent must be a directory')
      }
      canonical = join(canonical, part)
    }
    return canonical
  }
  throw new Error('destination must be inside the current or temporary directory')
}

export async function resetGeneratedWorkspace(destination, generator, legacy) {
  const path = await verifiedDestination(destination)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (info !== undefined) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('destination must be a generated Workspace directory')
    }
    const metadata = await lstat(join(path, '.threejs-editor')).catch(() => undefined)
    const markerInfo = await lstat(join(path, MARKER)).catch(() => undefined)
    if (metadata === undefined
      || !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (markerInfo !== undefined
        && (!markerInfo.isFile() || markerInfo.isSymbolicLink()))) {
      throw new Error('destination is not owned by this Workspace generator')
    }
    const owned = markerInfo === undefined
      ? await matchesLegacyWorkspace(path, legacy)
      : await readFile(join(path, MARKER), 'utf8') === `${generator}\n`
    if (!owned) {
      throw new Error('destination is not owned by this Workspace generator')
    }
    await rm(path, { recursive: true })
  }
  await mkdir(join(path, '.threejs-editor'), { recursive: true })
  await writeFile(join(path, MARKER), `${generator}\n`, { flag: 'wx' })
  return path
}

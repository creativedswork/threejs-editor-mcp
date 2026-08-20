import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path'
import { z } from 'zod'
import {
  buildIdFor,
  buildWorkspace,
  type FailedBuild,
  type ReadyBuild,
  type WorkspaceBuild,
} from './builder.js'
import {
  createProject,
  projectSchema,
  RevisionConflictError,
  type Project,
  type ProjectTemplate,
} from './projects.js'
import { WORKSPACE_EDITOR_STATE_PATH } from './m7-runtime.js'

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_FILES = 512
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_TEXT_READ_BYTES = 512 * 1024
const MAX_DISCOVERY_DIRECTORIES = 2048
const MAX_DISCOVERED_PROJECTS = 200
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.threejs-editor',
  'dist',
  'node_modules',
])
const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.json',
  '.glsl',
  '.wgsl',
  '.tsl',
]

export const workspacePathSchema = z.string().min(1).max(512)
export const workspaceFileSchema = z.object({
  path: workspacePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  mediaType: z.string().min(1).max(120),
  text: z.boolean(),
})
export const workspaceParameterSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    type: z.literal('boolean'),
    path: workspacePathSchema,
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  }),
  z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    type: z.literal('number'),
    path: workspacePathSchema,
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
  }).refine(value => value.min < value.max, {
    message: 'parameter min must be less than max',
  }),
])
export const workspaceManifestSchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.enum(['linked-workspace', 'managed-workspace']),
  title: z.string().min(1).max(120),
  entry: workspacePathSchema,
  backend: z.enum(['webgl', 'webgpu', 'raw-webgpu']),
  files: z.record(workspacePathSchema, workspaceFileSchema.omit({ path: true })),
  dependencies: z.record(z.string(), z.string()),
  runtime: z.object({
    debugModes: z.array(z.string()),
    qualityTiers: z.array(z.string()),
    parameters: z.array(workspaceParameterSchema).default([]),
  }),
})
export const workspaceChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('write'),
    path: workspacePathSchema,
    text: z.string().max(MAX_FILE_BYTES).optional(),
    base64: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4).optional(),
  }).refine(value => (value.text === undefined) !== (value.base64 === undefined), {
    message: 'write requires exactly one of text or base64',
  }),
  z.object({
    type: z.literal('delete'),
    path: workspacePathSchema,
  }),
  z.object({
    type: z.literal('move'),
    from: workspacePathSchema,
    path: workspacePathSchema,
  }),
])

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>
export type WorkspaceKind = WorkspaceManifest['kind']

export interface WorkspaceRegistration {
  projectId: string
  path: string
}

export interface WorkspaceSummary {
  projectId: string
  title: string
  revision: string
  kind: WorkspaceKind
}

export interface WorkspaceProjectCandidate {
  projectPath: string
  title: string
  format: 'example-gallery'
  entry: string
  backend: 'webgl' | 'webgpu' | 'raw-webgpu'
  available: boolean
  issue?: string
}

interface ExampleSource {
  root: string
  projectPath: string
  galleryCorpus: boolean
}

export interface WorkspaceSnapshot extends WorkspaceSummary {
  path: string
  manifest: WorkspaceManifest
  project: Project
}

interface RegisteredWorkspace {
  path: string
  kind: WorkspaceKind
}

interface TransactionChange {
  path: string
  before: string | null
  after: string | null
}

interface Transaction {
  schemaVersion: 1
  id: string
  status: 'prepared' | 'committed' | 'rolled-back'
  baseRevision: string
  targetRevision: string
  changes: TransactionChange[]
}

type StoredReadyBuild = Omit<ReadyBuild, 'bundle' | 'sourceMap'>
type StoredBuild = StoredReadyBuild | FailedBuild

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  )
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`)
}

function storedBuild(value: unknown): StoredBuild {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stored build metadata must be an object')
  }
  const build = value as Partial<StoredBuild>
  if (build.schemaVersion !== 1
    || (build.status !== 'ready' && build.status !== 'failed')
    || typeof build.projectId !== 'string'
    || typeof build.revision !== 'string'
    || typeof build.buildId !== 'string'
    || !Array.isArray(build.diagnostics)) {
    throw new Error('stored build metadata is invalid')
  }
  if (build.status === 'ready'
    && (typeof build.bundleBytes !== 'number'
      || typeof build.sourceMapBytes !== 'number'
      || !Array.isArray(build.inputs)
      || !Array.isArray(build.assets))) {
    throw new Error('stored ready build metadata is invalid')
  }
  return build as StoredBuild
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error('projectId must match [a-z0-9][a-z0-9-]{0,63}')
  }
}

function safePath(input: string): string {
  if (input.includes('\0') || input.includes('\\') || isAbsolute(input)) {
    throw new Error('workspace path must be a relative POSIX path')
  }
  const parts = input.split('/')
  if (parts.length === 0 || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('workspace path contains an invalid segment')
  }
  if (parts[0] === '.threejs-editor') {
    throw new Error('.threejs-editor is managed metadata')
  }
  return parts.join('/')
}

function safeProjectPath(input: string): string {
  return input === '.' ? '' : safePath(input)
}

function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  // ponytail: static ESM imports cover the gallery; use a lexer if it adopts computed imports.
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

function isThreeSpecifier(specifier: string): boolean {
  return specifier === 'three' || specifier.startsWith('three/')
}

function projectFilePath(projectPath: string, fileName: string): string {
  return projectPath === '' ? fileName : `${projectPath}/${fileName}`
}

function mediaType(path: string, bytes: Buffer): { mediaType: string; text: boolean } {
  const extension = extname(path).toLowerCase()
  const known = new Map([
    ['.css', 'text/css'],
    ['.glsl', 'text/x-glsl'],
    ['.html', 'text/html'],
    ['.js', 'text/javascript'],
    ['.json', 'application/json'],
    ['.jsx', 'text/jsx'],
    ['.md', 'text/markdown'],
    ['.mjs', 'text/javascript'],
    ['.ts', 'text/typescript'],
    ['.tsx', 'text/tsx'],
    ['.wgsl', 'text/wgsl'],
  ])
  const knownType = known.get(extension)
  if (knownType !== undefined) return { mediaType: knownType, text: true }
  if (isUtf8(bytes) && !bytes.includes(0)) return { mediaType: 'text/plain', text: true }
  return { mediaType: 'application/octet-stream', text: false }
}

function manifestRevision(manifest: WorkspaceManifest): string {
  return digest(canonicalBytes(manifest))
}

function defaultWorkspaceConfig(
  kind: WorkspaceKind,
  projectId: string,
  packageDocument: unknown,
): Omit<WorkspaceManifest, 'files'> {
  const packageRecord = packageDocument !== null && typeof packageDocument === 'object'
    ? packageDocument as Record<string, unknown>
    : {}
  const dependencies = packageRecord.dependencies !== null
    && typeof packageRecord.dependencies === 'object'
    && !Array.isArray(packageRecord.dependencies)
    ? Object.fromEntries(Object.entries(packageRecord.dependencies as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return {
    schemaVersion: 2,
    kind,
    title: typeof packageRecord.name === 'string' && packageRecord.name.trim() !== ''
      ? packageRecord.name.slice(0, 120)
      : projectId,
    entry: 'src/main.js',
    backend: 'webgl',
    dependencies,
    runtime: {
      debugModes: ['final'],
      qualityTiers: ['default'],
      parameters: [],
    },
  }
}

export class WorkspaceStore {
  private readonly managedRoot: Promise<string>
  private readonly ready: Promise<void>
  private readonly workspaces = new Map<string, RegisteredWorkspace>()
  private readonly sessionWorkspaceIds = new Set<string>()
  private readonly locks = new Map<string, Promise<void>>()

  constructor(
    root: string,
    allowlistedRoots: string[],
    registrations: WorkspaceRegistration[],
  ) {
    const managedRoot = resolve(root, '.managed-workspaces')
    this.managedRoot = mkdir(managedRoot, { recursive: true })
      .then(() => realpath(managedRoot))
    this.ready = this.initialize(allowlistedRoots, registrations)
  }

  private async initialize(
    allowlistedRoots: string[],
    registrations: WorkspaceRegistration[],
  ): Promise<void> {
    const managedRoot = await this.managedRoot
    for (const entry of await readdir(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue
      const path = await realpath(join(managedRoot, entry.name))
      const info = await lstat(path)
      if (info.isSymbolicLink() || !isWithin(managedRoot, path)) {
        throw new Error(`managed workspace ${entry.name} has an invalid path`)
      }
      this.workspaces.set(entry.name, { path, kind: 'managed-workspace' })
      try {
        await readFile(join(path, 'THREEJS-EXAMPLE-SOURCE.json'))
        this.sessionWorkspaceIds.add(entry.name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const roots = await Promise.all(allowlistedRoots.map(async root => realpath(resolve(root))))
    for (const registration of registrations) {
      validateProjectId(registration.projectId)
      if (this.workspaces.has(registration.projectId)) {
        throw new Error(`duplicate workspace ${registration.projectId}`)
      }
      const path = await realpath(resolve(registration.path))
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`workspace ${registration.projectId} must be a real directory`)
      }
      if (!roots.some(root => isWithin(root, path))) {
        throw new Error(`workspace ${registration.projectId} is outside allowlisted roots`)
      }
      this.workspaces.set(registration.projectId, { path, kind: 'linked-workspace' })
    }
  }

  async has(projectId: string): Promise<boolean> {
    await this.ready
    return this.workspaces.has(projectId)
  }

  async list(): Promise<WorkspaceSummary[]> {
    await this.ready
    const summaries = await Promise.all([...this.workspaces]
      .filter(([projectId]) => !this.sessionWorkspaceIds.has(projectId))
      .map(async ([projectId]) => this.load(projectId)))
    return summaries.map(({ projectId, title, revision, kind }) => ({
      projectId,
      title,
      revision,
      kind,
    })).sort((left, right) => left.projectId.localeCompare(right.projectId))
  }

  async registerSessionWorkspace(path: string): Promise<WorkspaceSnapshot> {
    await this.ready
    if (!isAbsolute(path)) throw new Error('DSH workspace path must be absolute')
    const resolved = await realpath(path)
    const info = await lstat(resolved)
    if (!info.isDirectory()) throw new Error('DSH workspace must be a real directory')
    const projectId = `workspace-${digest(new TextEncoder().encode(resolved)).slice(0, 54)}`
    const current = this.workspaces.get(projectId)
    if (current !== undefined && current.path !== resolved) {
      throw new Error('DSH workspace identity collision')
    }
    this.workspaces.set(projectId, { path: resolved, kind: 'linked-workspace' })
    this.sessionWorkspaceIds.add(projectId)
    return this.load(projectId)
  }

  async discoverSessionProjects(path: string): Promise<WorkspaceProjectCandidate[]> {
    await this.ready
    const root = await this.sessionRoot(path)
    const projects: WorkspaceProjectCandidate[] = []
    let directories = 0
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      directories += 1
      if (directories > MAX_DISCOVERY_DIRECTORIES) {
        throw new Error('workspace project discovery exceeds 2048 directories')
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const projectPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
            await visit(join(directory, entry.name), projectPath)
          }
          continue
        }
        if (!entry.isFile() || entry.name !== 'example.json') continue
        const scenePath = join(directory, 'scene.js')
        try {
          const sceneInfo = await lstat(scenePath)
          if (!sceneInfo.isFile() || sceneInfo.isSymbolicLink()) continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        const candidate = await this.exampleCandidate(
          root,
          prefix || '.',
        )
        projects.push(candidate)
        if (projects.length > MAX_DISCOVERED_PROJECTS) {
          throw new Error('workspace project discovery exceeds 200 projects')
        }
      }
    }
    await visit(root)
    return projects.sort((left, right) => left.projectPath.localeCompare(right.projectPath))
  }

  async importSessionProject(
    path: string,
    projectPath: string,
  ): Promise<WorkspaceSnapshot> {
    await this.ready
    const root = await this.sessionRoot(path)
    const source = await this.exampleSource(root, projectPath)
    const candidate = await this.exampleCandidate(root, projectPath)
    if (!candidate.available) {
      throw new Error(
        `${candidate.issue} Select a DSH workspace that contains the complete project, then retry open_editor. Do not run npm, an external dev server, or an HTML fallback.`,
      )
    }
    const files = await this.collectExampleFiles(source, candidate.entry)
    const examplePath = projectFilePath(source.projectPath, 'example.json')
    files.set(examplePath, await readFile(await this.realFile(source.root, examplePath)))
    const sourceRevision = digest(canonicalBytes([...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, bytes]) => [filePath, digest(bytes)])))
    const projectId = `example-${
      digest(new TextEncoder().encode(
        `${source.root}\0${source.projectPath}\0${sourceRevision}`,
      )).slice(0, 56)
    }`
    const current = this.workspaces.get(projectId)
    if (current !== undefined) {
      this.sessionWorkspaceIds.add(projectId)
      return this.load(projectId)
    }

    const managedRoot = await this.managedRoot
    const target = join(managedRoot, projectId)
    const temporary = join(managedRoot, `.${projectId}-${randomUUID()}`)
    try {
      for (const [filePath, bytes] of files) {
        const destination = join(temporary, ...filePath.split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
      }
      await writeFile(join(temporary, 'package.json'), canonicalBytes({
        name: projectId,
        private: true,
        type: 'module',
        dependencies: { three: '0.185.1' },
      }), { flag: 'wx', mode: 0o600 })
      await mkdir(join(temporary, '.threejs-editor'), { recursive: true })
      await writeFile(
        join(temporary, '.threejs-editor', 'project.json'),
        canonicalBytes({
          schemaVersion: 2,
          kind: 'managed-workspace',
          title: candidate.title,
          entry: candidate.entry,
          backend: candidate.backend,
          dependencies: { three: '0.185.1' },
          runtime: {
            debugModes: await this.exampleDebugModes(root, projectPath),
            qualityTiers: ['default'],
            parameters: [],
          },
        }),
        { flag: 'wx', mode: 0o600 },
      )
      await writeFile(
        join(temporary, 'THREEJS-EXAMPLE-SOURCE.json'),
        canonicalBytes({
          format: candidate.format,
          projectPath: candidate.projectPath,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      await writeFile(
        join(temporary, WORKSPACE_EDITOR_STATE_PATH),
        canonicalBytes({ schemaVersion: 1, operations: [] }),
        { flag: 'wx', mode: 0o600 },
      )
      await rename(temporary, target)
      this.workspaces.set(projectId, {
        path: target,
        kind: 'managed-workspace',
      })
      this.sessionWorkspaceIds.add(projectId)
      return this.load(projectId)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  async createManaged(
    projectId: string,
    title: string,
    template: ProjectTemplate,
  ): Promise<WorkspaceSummary> {
    await this.ready
    validateProjectId(projectId)
    if (this.workspaces.has(projectId)) throw new Error(`workspace ${projectId} already exists`)
    const root = await this.managedRoot
    const path = join(root, projectId)
    const project = createProject(title, template)
    try {
      await mkdir(join(path, 'src'), { recursive: true })
      await mkdir(join(path, 'public'), { recursive: true })
      await writeFile(join(path, 'package.json'), canonicalBytes({
        name: title,
        private: true,
        type: 'module',
        scripts: { dev: 'vite' },
        dependencies: { three: '0.185.1' },
        devDependencies: { vite: '^7.0.0' },
      }), { flag: 'wx', mode: 0o600 })
      await writeFile(join(path, 'src', 'main.js'), `${project.script.source}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      await writeFile(join(path, 'src', 'scene.json'), canonicalBytes(project), {
        flag: 'wx',
        mode: 0o600,
      })
      await writeFile(
        join(path, WORKSPACE_EDITOR_STATE_PATH),
        canonicalBytes({ schemaVersion: 1, operations: [] }),
        { flag: 'wx', mode: 0o600 },
      )
      this.workspaces.set(projectId, { path, kind: 'managed-workspace' })
      const snapshot = await this.load(projectId)
      return {
        projectId,
        title: snapshot.title,
        revision: snapshot.revision,
        kind: snapshot.kind,
      }
    } catch (error) {
      this.workspaces.delete(projectId)
      await rm(path, { recursive: true, force: true })
      throw error
    }
  }

  async load(projectId: string): Promise<WorkspaceSnapshot> {
    validateProjectId(projectId)
    return this.withLock(projectId, () => this.loadUnlocked(projectId))
  }

  private async loadUnlocked(projectId: string): Promise<WorkspaceSnapshot> {
    await this.ready
    const registration = this.workspaces.get(projectId)
    if (registration === undefined) throw new Error(`unknown workspace ${projectId}`)
    await this.ensureMetadata(registration.path)
    await this.recover(registration.path)
    const manifest = await this.scanManifest(projectId, registration)
    const revision = manifestRevision(manifest)
    await this.persistRevision(registration.path, revision, manifest)
    const head = await this.readHead(registration.path)
    if (head !== revision) await this.writeAtomic(this.metadataPath(registration.path, 'HEAD'), `${revision}\n`)
    return {
      projectId,
      path: registration.path,
      kind: registration.kind,
      title: manifest.title,
      revision,
      manifest,
      project: await this.projectProjection(registration.path, manifest.title),
    }
  }

  async readFiles(
    projectId: string,
    paths: Array<{ path: string; startLine?: number; endLine?: number }>,
  ): Promise<Array<{
    path: string
    sha256: string
    size: number
    mediaType: string
    text?: string
    base64?: string
  }>> {
    const snapshot = await this.load(projectId)
    return Promise.all(paths.map(async request => {
      const path = safePath(request.path)
      const summary = snapshot.manifest.files[path]
      if (summary === undefined) throw new Error(`unknown workspace file ${path}`)
      const bytes = await this.readWorkspaceFile(snapshot.path, path)
      if (!summary.text) {
        return {
          path,
          sha256: summary.sha256,
          size: summary.size,
          mediaType: summary.mediaType,
          base64: bytes.toString('base64'),
        }
      }
      const text = bytes.toString('utf8')
      const lines = text.split('\n')
      const start = Math.max(1, request.startLine ?? 1)
      const end = Math.min(lines.length, request.endLine ?? lines.length)
      return {
        path,
        sha256: summary.sha256,
        size: summary.size,
        mediaType: summary.mediaType,
        text: lines.slice(start - 1, end).join('\n'),
      }
    }))
  }

  async search(
    projectId: string,
    query: string,
    limit = 50,
  ): Promise<Array<{ path: string; line?: number; text?: string }>> {
    if (query === '') throw new Error('search query must not be empty')
    const snapshot = await this.load(projectId)
    const matches: Array<{ path: string; line?: number; text?: string }> = []
    for (const [path, file] of Object.entries(snapshot.manifest.files)) {
      if (path.toLowerCase().includes(query.toLowerCase())) matches.push({ path })
      if (file.text && file.size <= MAX_TEXT_READ_BYTES) {
        const lines = (await this.readWorkspaceFile(snapshot.path, path)).toString('utf8').split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index]?.toLowerCase().includes(query.toLowerCase())) continue
          matches.push({ path, line: index + 1, text: lines[index]?.slice(0, 500) })
          if (matches.length >= limit) return matches
        }
      }
      if (matches.length >= limit) return matches
    }
    return matches
  }

  async build(projectId: string, expectedRevision: string): Promise<WorkspaceBuild> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('invalid build revision')
    return this.withLock(projectId, async () => {
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== expectedRevision) {
        throw new RevisionConflictError(snapshot.revision)
      }
      const input: Parameters<typeof buildWorkspace>[0] = {
        projectId,
        revision: snapshot.revision,
        entry: snapshot.manifest.entry,
        backend: snapshot.manifest.backend,
        files: [],
      }
      const buildId = buildIdFor(input)
      const cached = await this.readStoredBuild(snapshot.path, buildId)
      if (cached?.status === 'ready') {
        const directory = this.metadataPath(snapshot.path, 'builds', buildId)
        return {
          ...cached,
          bundle: await readFile(join(directory, 'bundle.js'), 'utf8'),
          sourceMap: await readFile(join(directory, 'bundle.js.map'), 'utf8'),
        }
      }
      if (cached?.status === 'failed') return cached

      input.files = await Promise.all(Object.entries(snapshot.manifest.files).map(
        async ([path, file]) => ({
          path,
          bytes: await this.readWorkspaceFile(snapshot.path, path),
          sha256: file.sha256,
          mediaType: file.mediaType,
          text: file.text,
        }),
      ))
      const result = await buildWorkspace(input)
      const directory = this.metadataPath(snapshot.path, 'builds', result.buildId)
      let metadata: StoredBuild
      if (result.status === 'ready') {
        const { bundle, sourceMap, ...stored } = result
        metadata = stored
        await this.writeAtomic(join(directory, 'bundle.js'), bundle)
        await this.writeAtomic(join(directory, 'bundle.js.map'), sourceMap)
      } else {
        metadata = result
      }
      await this.writeAtomic(join(directory, 'build.json'), canonicalBytes(metadata))
      await this.writeAtomic(
        this.metadataPath(snapshot.path, 'diagnostics', `${result.buildId}.json`),
        canonicalBytes({
          projectId,
          revision: result.revision,
          buildId: result.buildId,
          diagnostics: result.diagnostics,
        }),
      )
      return result
    })
  }

  async readBuildArtifact(
    projectId: string,
    buildId: string,
    artifact: 'bundle.js' | 'bundle.js.map',
  ): Promise<string> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(buildId)) throw new Error('invalid buildId')
    await this.ready
    const registration = this.workspaces.get(projectId)
    if (registration === undefined) throw new Error(`unknown workspace ${projectId}`)
    const metadata = await this.readStoredBuild(registration.path, buildId)
    if (metadata?.status !== 'ready'
      || metadata.projectId !== projectId
      || metadata.buildId !== buildId) {
      throw new Error('ready build artifact is unavailable')
    }
    return readFile(
      this.metadataPath(registration.path, 'builds', buildId, artifact),
      'utf8',
    )
  }

  async reportEditorScene(
    projectId: string,
    revision: string,
    document: unknown,
  ): Promise<void> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid editor scene revision')
    await this.withLock(projectId, async () => {
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== revision) throw new RevisionConflictError(snapshot.revision)
      await this.writeAtomic(
        this.metadataPath(snapshot.path, 'editor-scenes', `${revision}.json`),
        canonicalBytes(document),
      )
    })
  }

  async readEditorScene(projectId: string, revision: string): Promise<unknown | undefined> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid editor scene revision')
    const snapshot = await this.load(projectId)
    if (snapshot.revision !== revision) throw new RevisionConflictError(snapshot.revision)
    try {
      return JSON.parse(await readFile(
        this.metadataPath(snapshot.path, 'editor-scenes', `${revision}.json`),
        'utf8',
      ))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async apply(
    projectId: string,
    baseRevision: string,
    candidates: unknown[],
  ): Promise<WorkspaceSnapshot> {
    validateProjectId(projectId)
    const changes = candidates.map(candidate => workspaceChangeSchema.parse(candidate))
    if (changes.length === 0 || changes.length > 100) {
      throw new Error('workspace change batch must contain 1 to 100 operations')
    }
    return this.withLock(projectId, async () => {
      const current = await this.loadUnlocked(projectId)
      if (current.revision !== baseRevision) {
        throw new RevisionConflictError(current.revision)
      }
      const registration = this.workspaces.get(projectId)
      if (registration === undefined) throw new Error(`unknown workspace ${projectId}`)
      const normalized = await this.normalizeChanges(current, changes)
      if (normalized.length === 0) throw new Error('workspace change batch has no effect')
      const targetManifest = structuredClone(current.manifest)
      for (const change of normalized) {
        if (change.after === null) delete targetManifest.files[change.path]
        else {
          const bytes = await this.readObject(registration.path, change.after)
          const type = mediaType(change.path, bytes)
          targetManifest.files[change.path] = {
            sha256: change.after,
            size: bytes.length,
            ...type,
          }
        }
      }
      this.validateManifestLimits(targetManifest)
      const targetRevision = manifestRevision(targetManifest)
      const transaction: Transaction = {
        schemaVersion: 1,
        id: randomUUID(),
        status: 'prepared',
        baseRevision,
        targetRevision,
        changes: normalized,
      }
      const transactionPath = this.metadataPath(
        registration.path,
        'transactions',
        `${transaction.id}.json`,
      )
      await this.writeAtomic(transactionPath, canonicalBytes(transaction))
      const applied: TransactionChange[] = []
      try {
        const verified = await this.scanManifest(projectId, registration)
        if (manifestRevision(verified) !== baseRevision) {
          throw new RevisionConflictError(manifestRevision(verified))
        }
        for (const change of normalized) {
          const currentHash = await this.workspaceFileHash(registration.path, change.path)
          if (currentHash !== change.before) {
            throw new Error(`workspace file changed while committing: ${change.path}`)
          }
          if (change.after === null) {
            await unlink(join(registration.path, ...change.path.split('/')))
          } else {
            await this.writeWorkspaceFile(
              registration.path,
              change.path,
              await this.readObject(registration.path, change.after),
            )
          }
          applied.push(change)
        }
        const committed = await this.scanManifest(projectId, registration)
        if (manifestRevision(committed) !== targetRevision) {
          throw new Error('workspace changed while committing')
        }
        await this.persistRevision(registration.path, targetRevision, targetManifest)
        await this.writeAtomic(this.metadataPath(registration.path, 'HEAD'), `${targetRevision}\n`)
        transaction.status = 'committed'
        await this.writeAtomic(transactionPath, canonicalBytes(transaction))
      } catch (error) {
        await this.restoreChanges(registration.path, applied)
        await this.writeAtomic(this.metadataPath(registration.path, 'HEAD'), `${baseRevision}\n`)
        transaction.status = 'rolled-back'
        await this.writeAtomic(transactionPath, canonicalBytes(transaction))
        throw error
      }
      return this.loadUnlocked(projectId)
    })
  }

  async export(projectId: string): Promise<{
    format: 'threejs-editor-workspace'
    formatVersion: 2
    projectId: string
    revision: string
    manifest: WorkspaceManifest
    files: Array<{ path: string; base64: string }>
  }> {
    const snapshot = await this.load(projectId)
    const files = await Promise.all(Object.keys(snapshot.manifest.files).map(async path => ({
      path,
      base64: (await this.readWorkspaceFile(snapshot.path, path)).toString('base64'),
    })))
    return {
      format: 'threejs-editor-workspace',
      formatVersion: 2,
      projectId,
      revision: snapshot.revision,
      manifest: snapshot.manifest,
      files,
    }
  }

  private async normalizeChanges(
    snapshot: WorkspaceSnapshot,
    changes: WorkspaceChange[],
  ): Promise<TransactionChange[]> {
    const state = new Map(Object.entries(snapshot.manifest.files)
      .map(([path, file]) => [path, file.sha256]))
    const before = new Map<string, string | null>()
    const remember = (path: string): void => {
      if (!before.has(path)) before.set(path, state.get(path) ?? null)
    }
    for (const candidate of changes) {
      if (candidate.type === 'write') {
        const path = safePath(candidate.path)
        remember(path)
        const bytes = candidate.text === undefined
          ? Buffer.from(candidate.base64 ?? '', 'base64')
          : Buffer.from(candidate.text)
        if (candidate.base64 !== undefined && bytes.toString('base64') !== candidate.base64) {
          throw new Error(`file ${path} is not canonical base64`)
        }
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`file ${path} exceeds 1 MiB`)
        const hash = await this.writeObject(snapshot.path, bytes)
        state.set(path, hash)
      } else if (candidate.type === 'delete') {
        const path = safePath(candidate.path)
        if (!state.has(path)) throw new Error(`unknown workspace file ${path}`)
        remember(path)
        state.delete(path)
      } else {
        const from = safePath(candidate.from)
        const path = safePath(candidate.path)
        if (!state.has(from)) throw new Error(`unknown workspace file ${from}`)
        if (state.has(path)) throw new Error(`workspace file ${path} already exists`)
        remember(from)
        remember(path)
        const hash = state.get(from)
        state.delete(from)
        if (hash !== undefined) state.set(path, hash)
      }
    }
    for (const [path, hash] of before) {
      if (hash === null) continue
      const stored = await this.writeObject(
        snapshot.path,
        await this.readWorkspaceFile(snapshot.path, path),
      )
      if (stored !== hash) throw new Error(`workspace file changed while preparing: ${path}`)
    }
    return [...before].map(([path, oldHash]) => ({
      path,
      before: oldHash,
      after: state.get(path) ?? null,
    })).filter(change => change.before !== change.after)
  }

  private async restoreChanges(path: string, changes: TransactionChange[]): Promise<void> {
    for (const change of [...changes].reverse()) {
      if (change.before === null) {
        await unlink(join(path, ...change.path.split('/'))).catch(() => {})
      } else {
        await this.writeWorkspaceFile(path, change.path, await this.readObject(path, change.before))
      }
    }
  }

  private async scanManifest(
    projectId: string,
    registration: RegisteredWorkspace,
  ): Promise<WorkspaceManifest> {
    const files: WorkspaceManifest['files'] = {}
    let total = 0
    const visit = async (directory: string, prefix = ''): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
        const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const fullPath = join(directory, entry.name)
        const info = await lstat(fullPath)
        if (info.isSymbolicLink()) throw new Error(`workspace path is a symlink: ${relativePath}`)
        if (info.isDirectory()) {
          await visit(fullPath, relativePath)
          continue
        }
        if (!info.isFile()) throw new Error(`workspace path is not a regular file: ${relativePath}`)
        if (info.size > MAX_FILE_BYTES) throw new Error(`file ${relativePath} exceeds 1 MiB`)
        const bytes = await readFile(fullPath)
        total += bytes.length
        const type = mediaType(relativePath, bytes)
        files[relativePath] = {
          sha256: digest(bytes),
          size: bytes.length,
          ...type,
        }
        if (Object.keys(files).length > MAX_FILES) throw new Error('workspace exceeds 512 files')
        if (total > MAX_TOTAL_BYTES) throw new Error('workspace exceeds 16 MiB')
      }
    }
    await visit(registration.path)
    let packageDocument: unknown = {}
    try {
      packageDocument = JSON.parse(await readFile(join(registration.path, 'package.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const configPath = this.metadataPath(registration.path, 'project.json')
    let config: Omit<WorkspaceManifest, 'files'>
    try {
      const stored = workspaceManifestSchema.omit({ files: true })
        .parse(JSON.parse(await readFile(configPath, 'utf8')))
      config = stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      config = defaultWorkspaceConfig(registration.kind, projectId, packageDocument)
      await this.writeAtomic(configPath, canonicalBytes(config))
    }
    return workspaceManifestSchema.parse({ ...config, kind: registration.kind, files })
  }

  private async sessionRoot(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('DSH workspace path must be absolute')
    const root = await realpath(path)
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('DSH workspace must be a real directory')
    }
    return root
  }

  private async exampleCandidate(
    root: string,
    projectPath: string,
  ): Promise<WorkspaceProjectCandidate> {
    const source = await this.exampleSource(root, projectPath)
    const manifestPath = await this.realFile(
      source.root,
      projectFilePath(source.projectPath, 'example.json'),
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const title = typeof manifest.title === 'string' && manifest.title.trim() !== ''
      ? manifest.title.slice(0, 120)
      : projectPath.split('/').at(-1) ?? 'Three.js example'
    const backendText = typeof manifest.backend === 'string' ? manifest.backend.toLowerCase() : ''
    const backend = backendText.includes('raw webgpu')
      ? 'raw-webgpu'
      : backendText.includes('webgpu')
        ? 'webgpu'
        : 'webgl'
    const entry = projectFilePath(source.projectPath, 'scene.js')
    const issue = await this.exampleAvailabilityIssue(source, entry)
    return {
      projectPath: projectPath === '' ? '.' : projectPath,
      title,
      format: 'example-gallery',
      entry,
      backend,
      available: issue === undefined,
      ...(issue === undefined ? {} : { issue }),
    }
  }

  private async exampleDebugModes(root: string, projectPath: string): Promise<string[]> {
    const source = await this.exampleSource(root, projectPath)
    const manifestPath = await this.realFile(
      source.root,
      projectFilePath(source.projectPath, 'example.json'),
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    if (!Array.isArray(manifest.debugModes)) return ['final']
    const modes = manifest.debugModes.flatMap(value => {
      if (typeof value === 'string') return [value]
      if (value !== null
        && typeof value === 'object'
        && typeof (value as Record<string, unknown>).value === 'string') {
        return [(value as Record<string, string>).value]
      }
      return []
    })
    return modes.length === 0 ? ['final'] : modes
  }

  private async exampleSource(root: string, projectPath: string): Promise<ExampleSource> {
    const selectedPath = safeProjectPath(projectPath)
    if (selectedPath !== '') await this.realFile(root, selectedPath, true)
    const gallerySuffix = join('dev', 'example-gallery', 'examples')
    if (root.endsWith(`${sep}${gallerySuffix}`)) {
      return {
        root: resolve(root, '..', '..', '..'),
        projectPath: posix.join('dev/example-gallery/examples', selectedPath),
        galleryCorpus: true,
      }
    }
    return {
      root,
      projectPath: selectedPath,
      galleryCorpus: false,
    }
  }

  private async exampleAvailabilityIssue(
    source: ExampleSource,
    entry: string,
  ): Promise<string | undefined> {
    const queue = [entry]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const filePath = queue.shift()!
      if (visited.has(filePath)) continue
      visited.add(filePath)
      let bytes: Buffer
      try {
        bytes = await readFile(await this.realFile(source.root, filePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return `Project module is missing inside the selected DSH workspace: ${filePath}.`
        }
        throw error
      }
      if (!mediaType(filePath, bytes).text) continue
      for (const specifier of moduleSpecifiers(bytes.toString('utf8'))) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
          if (!isThreeSpecifier(specifier)) {
            return `Project dependency is outside the pinned runtime profile: ${specifier}.`
          }
          continue
        }
        const resolved = await this.resolveModule(source, specifier, filePath)
        if (resolved === undefined) {
          return specifier.startsWith('/')
            ? `Project import ${specifier} is outside the selected DSH workspace.`
            : `Project module cannot be resolved inside the selected DSH workspace: ${specifier}.`
        }
        queue.push(resolved)
      }
    }
    return undefined
  }

  private async collectExampleFiles(
    source: ExampleSource,
    entry: string,
  ): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>()
    const queue = [entry]
    let total = 0
    while (queue.length > 0) {
      const filePath = queue.shift()!
      if (files.has(filePath)) continue
      const bytes = await readFile(await this.realFile(source.root, filePath))
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`file ${filePath} exceeds 1 MiB`)
      total += bytes.length
      if (total > MAX_TOTAL_BYTES) throw new Error('selected project exceeds 16 MiB')
      files.set(filePath, bytes)
      if (files.size > MAX_FILES) throw new Error('selected project exceeds 512 files')
      if (!mediaType(filePath, bytes).text) continue
      for (const specifier of moduleSpecifiers(bytes.toString('utf8'))) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
          if (!isThreeSpecifier(specifier)) {
            throw new Error(`dependency ${JSON.stringify(specifier)} is not in the pinned M7 profile`)
          }
          continue
        }
        const resolved = await this.resolveModule(source, specifier, filePath)
        if (resolved === undefined) {
          throw new Error(`workspace module not found: ${specifier}`)
        }
        queue.push(resolved)
      }
    }
    return files
  }

  private async resolveModule(
    source: ExampleSource,
    request: string,
    importer: string,
  ): Promise<string | undefined> {
    const clean = request.split('?')[0]
    const candidate = clean.startsWith('/')
      ? posix.normalize(clean.slice(1))
      : posix.normalize(posix.join(posix.dirname(importer), clean))
    if (candidate === '' || candidate === '..' || candidate.startsWith('../')) return undefined
    if (source.galleryCorpus
      && !candidate.startsWith('dev/')
      && !candidate.startsWith('skills/')) {
      return undefined
    }
    const attempts = [
      candidate,
      ...extname(candidate) === ''
        ? MODULE_EXTENSIONS.map(extension => `${candidate}${extension}`)
        : [],
      ...MODULE_EXTENSIONS.map(extension => `${candidate}/index${extension}`),
    ]
    for (const attempt of attempts) {
      try {
        await this.realFile(source.root, attempt)
        return attempt
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  private async realFile(
    root: string,
    path: string,
    directory = false,
  ): Promise<string> {
    const safe = safePath(path)
    const candidate = resolve(root, ...safe.split('/'))
    if (!isWithin(root, candidate)) throw new Error(`workspace path escapes root: ${path}`)
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new Error(`workspace path is a symlink: ${path}`)
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`workspace path has the wrong type: ${path}`)
    }
    const resolved = await realpath(candidate)
    if (resolved !== candidate || !isWithin(root, resolved)) {
      throw new Error(`workspace path contains a symlink: ${path}`)
    }
    return resolved
  }

  private validateManifestLimits(manifest: WorkspaceManifest): void {
    const files = Object.entries(manifest.files)
    if (files.length > MAX_FILES) throw new Error('workspace exceeds 512 files')
    let total = 0
    for (const [path, file] of files) {
      safePath(path)
      if (file.size > MAX_FILE_BYTES) throw new Error(`file ${path} exceeds 1 MiB`)
      total += file.size
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('workspace exceeds 16 MiB')
  }

  private async projectProjection(path: string, title: string): Promise<Project> {
    let project: Project
    try {
      project = projectSchema.parse(JSON.parse(await readFile(join(path, 'src', 'scene.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      project = createProject(title, 'empty')
    }
    try {
      project.script.source = await readFile(join(path, 'src', 'main.js'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return project
  }

  private async ensureMetadata(path: string): Promise<void> {
    await Promise.all([
      mkdir(this.metadataPath(path, 'revisions'), { recursive: true }),
      mkdir(this.metadataPath(path, 'objects'), { recursive: true }),
      mkdir(this.metadataPath(path, 'transactions'), { recursive: true }),
      mkdir(this.metadataPath(path, 'builds'), { recursive: true }),
      mkdir(this.metadataPath(path, 'diagnostics'), { recursive: true }),
      mkdir(this.metadataPath(path, 'editor-scenes'), { recursive: true }),
    ])
  }

  private async recover(path: string): Promise<void> {
    const directory = this.metadataPath(path, 'transactions')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const transactionPath = join(directory, entry.name)
      const transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as Transaction
      if (transaction.status !== 'prepared') continue
      const head = await this.readHead(path)
      if (head === transaction.targetRevision) {
        transaction.status = 'committed'
      } else {
        const applied: TransactionChange[] = []
        for (const change of transaction.changes) {
          const current = await this.workspaceFileHash(path, change.path)
          if (current === change.after) applied.push(change)
          else if (current !== change.before) {
            throw new Error(`workspace file changed after interrupted transaction: ${change.path}`)
          }
        }
        await this.restoreChanges(path, applied)
        await this.writeAtomic(this.metadataPath(path, 'HEAD'), `${transaction.baseRevision}\n`)
        transaction.status = 'rolled-back'
      }
      await this.writeAtomic(transactionPath, canonicalBytes(transaction))
    }
  }

  private async persistRevision(
    path: string,
    revision: string,
    manifest: WorkspaceManifest,
  ): Promise<void> {
    const target = this.metadataPath(path, 'revisions', `${revision}.json`)
    try {
      await writeFile(target, canonicalBytes(manifest), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  private async readStoredBuild(path: string, buildId: string): Promise<StoredBuild | undefined> {
    try {
      return storedBuild(JSON.parse(await readFile(
        this.metadataPath(path, 'builds', buildId, 'build.json'),
        'utf8',
      )))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readHead(path: string): Promise<string | undefined> {
    try {
      const value = (await readFile(this.metadataPath(path, 'HEAD'), 'utf8')).trim()
      return /^[a-f0-9]{64}$/.test(value) ? value : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async writeObject(path: string, bytes: Buffer): Promise<string> {
    const hash = digest(bytes)
    const target = this.metadataPath(path, 'objects', hash)
    try {
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return hash
  }

  private readObject(path: string, hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid object hash')
    return readFile(this.metadataPath(path, 'objects', hash))
  }

  private async readWorkspaceFile(root: string, path: string): Promise<Buffer> {
    const file = join(root, ...safePath(path).split('/'))
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`workspace file is not regular: ${path}`)
    }
    const resolved = await realpath(file)
    if (!isWithin(root, resolved)) throw new Error(`workspace file escapes root: ${path}`)
    return readFile(resolved)
  }

  private async workspaceFileHash(root: string, path: string): Promise<string | null> {
    try {
      return digest(await this.readWorkspaceFile(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeWorkspaceFile(root: string, path: string, bytes: Buffer): Promise<void> {
    const safe = safePath(path)
    const target = join(root, ...safe.split('/'))
    const parent = dirname(target)
    await this.ensureSafeDirectory(root, parent)
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`workspace target is not a regular file: ${safe}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.writeAtomic(target, bytes)
  }

  private async ensureSafeDirectory(root: string, directory: string): Promise<void> {
    if (!isWithin(root, directory)) throw new Error('workspace target escapes root')
    const path = relative(root, directory)
    let current = root
    for (const part of path === '' ? [] : path.split(sep)) {
      current = join(current, part)
      try {
        const info = await lstat(current)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`workspace parent is not a real directory: ${relative(root, current)}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(current)
      }
      const resolved = await realpath(current)
      if (!isWithin(root, resolved)) throw new Error('workspace parent escapes root')
    }
  }

  private async writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  private metadataPath(path: string, ...parts: string[]): string {
    return join(path, '.threejs-editor', ...parts)
  }

  private async withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve()
    const run = previous.then(action, action)
    const tail = run.then(() => {}, () => {})
    this.locks.set(projectId, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId)
    }
  }
}

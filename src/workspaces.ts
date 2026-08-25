import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
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
import { transform, type Loader } from 'esbuild'
import { z } from 'zod'
import {
  assetCssUrls,
  assetStringLiterals,
  buildIdFor,
  buildWorkspace,
  moduleSpecifiers,
  type FailedBuild,
  type ReadyBuild,
  type WorkspaceBuild,
} from './builder.js'
import {
  createProject,
  diagnosticsSchema,
  projectSchema,
  RevisionConflictError,
  type Diagnostics,
  type Project,
  type ProjectTemplate,
} from './projects.js'
import {
  applyOfficialEditorCommands,
  type EditorCommandOperation,
} from './official-editor.js'
import {
  WORKSPACE_EDITOR_STATE_PATH,
  runtimeCommandSettlementDeadline,
  type WorkspaceEditorState,
} from './m7-runtime.js'
import {
  runtimeLockPathForWorkspace,
  withRuntimeLock as withCrossProcessRuntimeLock,
} from './runtime-lock.js'
import {
  createFileBound,
  removeFileBound,
  replaceFileBound,
} from './workspace-io.js'

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
export const workspaceCapabilitiesSchema = z.object({
  parameterPanel: z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    parameters: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(64),
  }).strict(),
  command: z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    type: z.enum([
      'set_position',
      'set_rotation',
      'set_scale',
      'set_name',
      'set_visible',
      'set_material_color',
    ]),
    undoable: z.literal(true),
  }).strict(),
  debugSurface: z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(80),
    mode: z.string().min(1).max(80),
  }).strict(),
  extension: z.object({
    path: workspacePathSchema,
    permissions: z.tuple([z.literal('runtime')]),
  }).strict(),
}).strict()
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
    capabilities: workspaceCapabilitiesSchema.optional(),
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
const activeRuntimeSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().uuid(),
  nonce: z.string().uuid().optional(),
  evidenceToken: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(128).optional(),
  connectionGeneration: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  ownerPid: z.number().int().positive().optional(),
})
type ActiveRuntime = z.infer<typeof activeRuntimeSchema>
const importedSourceSchema = z.object({
  schemaVersion: z.literal(1),
  root: z.string().min(1),
  projectPath: z.string(),
  entry: workspacePathSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(workspacePathSchema, z.string().regex(/^[a-f0-9]{64}$/)),
})
const editorCommandSchema: z.ZodType<EditorCommandOperation> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_position'),
    objectUuid: z.string().uuid(),
    value: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({
    type: z.literal('set_rotation'),
    objectUuid: z.string().uuid(),
    value: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({
    type: z.literal('set_scale'),
    objectUuid: z.string().uuid(),
    value: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({
    type: z.literal('set_name'),
    objectUuid: z.string().uuid(),
    value: z.string().max(120),
  }),
  z.object({
    type: z.literal('set_visible'),
    objectUuid: z.string().uuid(),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal('set_material_color'),
    objectUuid: z.string().uuid(),
    value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  z.object({
    type: z.literal('set_material_value'),
    objectUuid: z.string().uuid(),
    property: z.literal('roughness'),
    value: z.number().min(0).max(1),
  }),
])
const workspaceEditorStateSchema: z.ZodType<WorkspaceEditorState> = z.object({
  schemaVersion: z.literal(1),
  operations: z.array(editorCommandSchema).max(4_096),
  recentChanges: z.array(z.object({
    source: z.enum(['human', 'ai', 'unknown']),
    operation: editorCommandSchema,
  })).max(200).optional(),
})

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

export interface RuntimeIdentity {
  projectId: string
  revision: string
  runId: string
  nonce: string
}

export interface RuntimeOwner {
  sessionId: string
  connectionGeneration: string
}

export interface RuntimeHarnessCommand {
  commandId: string
  kind: 'capture-frame' | 'read-logs' | 'simulate-actions'
  target: 'active' | 'validation'
  runtime: RuntimeIdentity
  payload: Record<string, unknown>
  expiresAt: string
}

const RUNTIME_EVIDENCE_KIND = {
  'capture-frame': 'capture-frame',
  'read-logs': 'runtime-logs',
  'simulate-actions': 'action-trace',
} as const satisfies Record<RuntimeHarnessCommand['kind'], string>

interface ExampleSource {
  root: string
  projectPath: string
  galleryCorpus: boolean
}

type ImportedSource = z.infer<typeof importedSourceSchema>

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

interface PendingRuntimeCommand {
  command: RuntimeHarnessCommand
  owner: RuntimeOwner
  resolve(value: unknown): void
  reject(error: Error): void
  settlementDeadline: number
  timer: ReturnType<typeof setTimeout>
  abort?: () => void
}

interface ActiveRuntimeGrant {
  runtime: RuntimeIdentity
  expiresAt: number
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

function assetSpecifiers(filePath: string, source: string): string[] {
  const specifiers = new Set<string>()
  const add = (specifier: string | undefined): void => {
    if (specifier !== undefined) specifiers.add(specifier.replace(/[?#].*$/, ''))
  }
  if (extname(filePath).toLowerCase() === '.css') {
    for (const asset of assetCssUrls(source)) add(asset.request)
    return [...specifiers]
  }
  for (const literal of assetStringLiterals(source, filePath)) add(literal.request)
  return [...specifiers]
}

async function dependencySource(path: string, source: string): Promise<string | undefined> {
  const loader = new Map<string, Loader>([
    ['.cjs', 'js'],
    ['.css', 'css'],
    ['.js', 'js'],
    ['.json', 'json'],
    ['.jsx', 'jsx'],
    ['.mjs', 'js'],
    ['.ts', 'ts'],
    ['.tsx', 'tsx'],
  ]).get(extname(path).toLowerCase())
  if (loader === undefined) return undefined
  if (loader === 'css') return source.replace(/\/\*[\s\S]*?\*\//g, '')
  try {
    return (await transform(source, { loader, legalComments: 'none' })).code
  } catch {
    return undefined
  }
}

function isThreeSpecifier(specifier: string): boolean {
  return specifier === 'three' || specifier.startsWith('three/')
}

function projectFilePath(projectPath: string, fileName: string): string {
  return projectPath === '' ? fileName : `${projectPath}/${fileName}`
}

function mediaType(path: string, bytes: Buffer): { mediaType: string; text: boolean } {
  const extension = extname(path).toLowerCase()
  const binary = new Map([
    ['.gif', 'image/gif'],
    ['.glb', 'model/gltf-binary'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
  ])
  const binaryType = binary.get(extension)
  if (binaryType !== undefined) return { mediaType: binaryType, text: false }
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

function sameRuntimeIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.projectId === right.projectId
    && left.revision === right.revision
    && left.runId === right.runId
    && left.nonce === right.nonce
}

function sameRuntimeOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
  return left.sessionId === right.sessionId
    && left.connectionGeneration === right.connectionGeneration
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
      capabilities: {
        parameterPanel: {
          id: 'runtime-parameters',
          label: 'Runtime parameters',
          parameters: [],
        },
        command: {
          id: 'move-object',
          label: 'Move selected object',
          type: 'set_position',
          undoable: true,
        },
        debugSurface: {
          id: 'runtime-diagnostics',
          label: 'Runtime diagnostics',
          mode: 'final',
        },
        extension: {
          path: 'src/main.js',
          permissions: ['runtime'],
        },
      },
    },
  }
}

export class WorkspaceStore {
  private readonly runtimeOwnerId = randomUUID()
  private readonly managedRoot: Promise<string>
  private readonly ready: Promise<void>
  private readonly workspaces = new Map<string, RegisteredWorkspace>()
  private readonly sessionWorkspaceIds = new Set<string>()
  private readonly activeRuntimes = new Map<string, ActiveRuntime>()
  private readonly activeRuntimeGrants = new Map<string, ActiveRuntimeGrant>()
  private readonly runtimeCommands = new Map<string, PendingRuntimeCommand>()

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
    const stableProjectId = `example-${
      digest(new TextEncoder().encode(
        `${source.root}\0${source.projectPath}`,
      )).slice(0, 56)
    }`
    await this.migrateImportedProject(stableProjectId, source)
    const projectId = stableProjectId
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
        join(temporary, '.threejs-editor', 'source.json'),
        canonicalBytes({
          schemaVersion: 1,
          root: source.root,
          projectPath: source.projectPath,
          entry: candidate.entry,
          revision: sourceRevision,
          files: Object.fromEntries([...files]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([filePath, bytes]) => [filePath, digest(bytes)])),
        } satisfies ImportedSource),
        { flag: 'wx', mode: 0o600 },
      )
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
            capabilities: {
              parameterPanel: {
                id: 'runtime-parameters',
                label: 'Runtime parameters',
                parameters: [],
              },
              command: {
                id: 'move-object',
                label: 'Move selected object',
                type: 'set_position',
                undoable: true,
              },
              debugSurface: {
                id: 'runtime-diagnostics',
                label: 'Runtime diagnostics',
                mode: 'final',
              },
              extension: {
                path: candidate.entry,
                permissions: ['runtime'],
              },
            },
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
    await this.reconcileImportedSource(projectId)
    return this.withLock(projectId, () => this.loadUnlocked(projectId))
  }

  private async reconcileImportedSource(projectId: string): Promise<void> {
    await this.ready
    const registration = this.workspaces.get(projectId)
    if (registration?.kind !== 'managed-workspace') return
    let imported: ImportedSource
    try {
      imported = importedSourceSchema.parse(JSON.parse((await this.readMetadataFile(
        registration.path,
        this.metadataPath(registration.path, 'source.json'),
      )).toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const source = await this.exampleSource(imported.root, imported.projectPath)
    if (source.root !== imported.root || source.projectPath !== imported.projectPath) {
      throw new Error('managed import source identity changed')
    }
    const files = await this.collectExampleFiles(source, imported.entry)
    const examplePath = projectFilePath(source.projectPath, 'example.json')
    files.set(examplePath, await readFile(await this.realFile(source.root, examplePath)))
    const nextFiles = Object.fromEntries([...files]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, bytes]) => [path, digest(bytes)]))
    const nextRevision = digest(canonicalBytes(Object.entries(nextFiles)))
    if (nextRevision === imported.revision) return

    const current = await this.withLock(projectId, () => this.loadUnlocked(projectId))
    const changedPaths = new Set([
      ...Object.keys(imported.files),
      ...Object.keys(nextFiles),
    ])
    const changes: WorkspaceChange[] = []
    for (const path of [...changedPaths].sort()) {
      const previousHash = imported.files[path]
      const nextHash = nextFiles[path]
      if (previousHash === nextHash) continue
      const managedHash = current.manifest.files[path]?.sha256
      if (managedHash === nextHash) continue
      if (managedHash !== previousHash) {
        throw new Error(
          `Managed import ${projectId} has local changes at ${path}; edit the managed copy or discard those changes before synchronizing its source.`,
        )
      }
      if (nextHash === undefined) {
        changes.push({ type: 'delete', path })
        continue
      }
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`managed import source is missing ${path}`)
      const type = mediaType(path, bytes)
      changes.push(type.text
        ? { type: 'write', path, text: bytes.toString('utf8') }
        : { type: 'write', path, base64: bytes.toString('base64') })
    }
    if (changes.length > 100) {
      throw new Error('managed import source update exceeds 100 changed files')
    }
    if (changes.length > 0) {
      await this.apply(projectId, current.revision, changes)
    }
    await this.writeAtomic(
      registration.path,
      this.metadataPath(registration.path, 'source.json'),
      canonicalBytes({
        ...imported,
        revision: nextRevision,
        files: nextFiles,
      } satisfies ImportedSource),
    )
  }

  private async migrateImportedProject(
    stableProjectId: string,
    source: ExampleSource,
  ): Promise<void> {
    const matches: Array<[string, RegisteredWorkspace]> = []
    for (const entry of this.workspaces) {
      const [projectId, registration] = entry
      if (registration.kind !== 'managed-workspace') continue
      let imported: ImportedSource
      try {
        imported = importedSourceSchema.parse(JSON.parse((await this.readMetadataFile(
          registration.path,
          this.metadataPath(registration.path, 'source.json'),
        )).toString('utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (imported.root === source.root && imported.projectPath === source.projectPath) {
        matches.push([projectId, registration])
      }
    }
    if (matches.length === 0) return
    if (matches.length > 1
      || (this.workspaces.has(stableProjectId) && matches[0]?.[0] !== stableProjectId)) {
      throw new Error(
        `managed import source ${source.root}:${source.projectPath} has conflicting project identities`,
      )
    }
    const [legacyProjectId, registration] = matches[0]!
    if (legacyProjectId === stableProjectId) return
    const target = join(await this.managedRoot, stableProjectId)
    await rename(registration.path, target)
    this.workspaces.delete(legacyProjectId)
    this.workspaces.set(stableProjectId, {
      path: target,
      kind: 'managed-workspace',
    })
    if (this.sessionWorkspaceIds.delete(legacyProjectId)) {
      this.sessionWorkspaceIds.add(stableProjectId)
    }
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
    if (head !== revision) {
      await this.writeAtomic(
        registration.path,
        this.metadataPath(registration.path, 'HEAD'),
        `${revision}\n`,
      )
    }
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
      const directory = this.metadataPath(snapshot.path, 'builds', buildId)
      await this.ensureSafeDirectory(snapshot.path, directory)
      const cached = await this.readStoredBuild(snapshot.path, buildId)
      if (cached?.status === 'ready') {
        return {
          ...cached,
          bundle: (await this.readMetadataFile(
            snapshot.path,
            join(directory, 'bundle.js'),
          )).toString('utf8'),
          sourceMap: (await this.readMetadataFile(
            snapshot.path,
            join(directory, 'bundle.js.map'),
          )).toString('utf8'),
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
      let metadata: StoredBuild
      if (result.status === 'ready') {
        const { bundle, sourceMap, ...stored } = result
        metadata = stored
        await this.writeAtomic(snapshot.path, join(directory, 'bundle.js'), bundle)
        await this.writeAtomic(snapshot.path, join(directory, 'bundle.js.map'), sourceMap)
      } else {
        metadata = result
      }
      await this.writeAtomic(
        snapshot.path,
        join(directory, 'build.json'),
        canonicalBytes(metadata),
      )
      await this.writeAtomic(
        snapshot.path,
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
    await this.ensureSafeDirectory(
      registration.path,
      this.metadataPath(registration.path, 'builds', buildId),
    )
    const metadata = await this.readStoredBuild(registration.path, buildId)
    if (metadata?.status !== 'ready'
      || metadata.projectId !== projectId
      || metadata.buildId !== buildId) {
      throw new Error('ready build artifact is unavailable')
    }
    return (await this.readMetadataFile(
      registration.path,
      this.metadataPath(registration.path, 'builds', buildId, artifact),
    )).toString('utf8')
  }

  async reportEditorScene(
    projectId: string,
    revision: string,
    document: unknown,
    runId: string,
    owner?: RuntimeOwner,
  ): Promise<void> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid editor scene revision')
    return this.withLock(projectId, async () => {
      const workspace = this.workspaces.get(projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== revision) throw new RevisionConflictError(snapshot.revision)
      const activeRuntime = owner === undefined
        ? await this.readActiveRuntime(snapshot.path)
        : this.activeRuntimes.get(this.runtimeKey(projectId, owner))
      if (activeRuntime?.revision !== revision || activeRuntime.runId !== runId) {
        throw new Error('runtime run changed before editor scene was reported')
      }
      await this.writeAtomic(
        snapshot.path,
        this.metadataPath(snapshot.path, 'editor-scenes', `${revision}.json`),
        canonicalBytes(document),
      )
    })
  }

  async registerRuntimeRun(
    projectId: string,
    revision: string,
    runId: string,
    nonce?: string,
    owner?: RuntimeOwner,
    previousRevision?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    validateProjectId(projectId)
    if ((nonce === undefined) !== (owner === undefined)) {
      throw new Error('Runtime nonce and owner identity must be provided together')
    }
    return this.withLock(projectId, async () => {
      signal?.throwIfAborted()
      const workspace = this.workspaces.get(projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== revision) throw new RevisionConflictError(snapshot.revision)
      const activePath = this.metadataPath(
        snapshot.path,
        'diagnostics',
        'active-run.json',
      )
      const ownerKey = owner === undefined ? undefined : this.runtimeKey(projectId, owner)
      if (ownerKey !== undefined && owner !== undefined) {
        for (const [key, active] of this.activeRuntimes) {
          if (key === ownerKey
            || !key.startsWith(`${projectId}\0`)
            || active.sessionId !== owner.sessionId) continue
          this.activeRuntimes.delete(key)
          this.activeRuntimeGrants.delete(key)
          this.rejectRuntimeCommand(key, 'MCP connection generation changed')
        }
      }
      const previousStoredRuntime = await this.readActiveRuntimeRecord(snapshot.path)
      const previousRuntime = ownerKey === undefined
        ? previousStoredRuntime
        : this.activeRuntimes.get(ownerKey)
      const evidenceToken = previousRevision === undefined
        ? randomUUID()
        : previousRuntime?.evidenceToken
      if (evidenceToken === undefined) {
        throw new Error('runtime evidence token is unavailable for revision rollover')
      }
      if (previousRevision !== undefined) {
        const activeRuntime = previousRuntime
        if (activeRuntime?.revision !== previousRevision
          || activeRuntime.runId !== runId) {
          throw new Error('runtime run changed before its revision was advanced')
        }
        if (nonce !== undefined && owner !== undefined) {
          if (activeRuntime.nonce !== nonce
            || activeRuntime.sessionId !== owner.sessionId
            || activeRuntime.connectionGeneration !== owner.connectionGeneration) {
            throw new Error('runtime run changed before its revision was advanced')
          }
        } else if (activeRuntime.nonce !== undefined
          || activeRuntime.sessionId !== undefined
          || activeRuntime.connectionGeneration !== undefined) {
          throw new Error('Runtime revision rollover requires exact owner identity')
        }
      }
      const runtimeKey = ownerKey ?? projectId
      this.rejectRuntimeCommand(runtimeKey, 'Runtime revision changed')
      this.activeRuntimeGrants.delete(runtimeKey)
      const activeRuntime = activeRuntimeSchema.parse({
        revision,
        runId,
        nonce,
        evidenceToken,
        sessionId: owner?.sessionId,
        connectionGeneration: owner?.connectionGeneration,
        ownerId: this.runtimeOwnerId,
        ownerPid: process.pid,
      })
      if (ownerKey !== undefined) this.activeRuntimes.set(ownerKey, activeRuntime)
      await this.writeAtomic(
        snapshot.path,
        activePath,
        canonicalBytes(activeRuntime),
      )
      if (signal?.aborted) {
        if (ownerKey !== undefined) {
          if (previousRuntime === undefined) this.activeRuntimes.delete(ownerKey)
          else this.activeRuntimes.set(ownerKey, previousRuntime)
        }
        const currentStoredRuntime = await this.readActiveRuntimeRecord(snapshot.path)
        if (currentStoredRuntime?.revision === revision
          && currentStoredRuntime.runId === runId
          && currentStoredRuntime.ownerId === this.runtimeOwnerId
          && currentStoredRuntime.ownerPid === process.pid) {
          if (previousStoredRuntime === undefined) {
            await this.clearActiveRuntime(snapshot.path, revision, runId)
          } else {
            await this.writeAtomic(
              snapshot.path,
              activePath,
              canonicalBytes(previousStoredRuntime),
            )
          }
        }
        signal.throwIfAborted()
      }
      return evidenceToken
    })
  }

  async releaseRuntimeRun(
    projectId: string,
    revision: string,
    runId: string,
    nonce?: string,
    owner?: RuntimeOwner,
  ): Promise<boolean> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid Runtime revision')
    return this.withLock(projectId, async () => {
      const workspace = this.workspaces.get(projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
      if ((nonce === undefined) !== (owner === undefined)) {
        throw new Error('Runtime nonce and owner identity must be provided together')
      }
      if (nonce !== undefined && owner !== undefined) {
        await this.assertRuntimeIdentity({
          projectId,
          revision,
          runId,
          nonce,
        }, owner)
      } else {
        const active = await this.readActiveRuntime(workspace.path, true)
        if (active?.nonce !== undefined
          || active?.sessionId !== undefined
          || active?.connectionGeneration !== undefined) {
          throw new Error('Exact Runtime owner identity is required')
        }
      }
      const key = owner === undefined ? projectId : this.runtimeKey(projectId, owner)
      const released = owner === undefined
        ? await this.clearActiveRuntime(workspace.path, revision, runId)
        : this.activeRuntimes.delete(key)
      if (owner !== undefined) {
        this.activeRuntimeGrants.delete(key)
        await this.clearActiveRuntime(workspace.path, revision, runId)
      }
      if (released) this.rejectRuntimeCommand(key, 'Runtime was disposed')
      return released
    })
  }

  async runtimeIdentity(
    projectId: string,
    owner: RuntimeOwner,
  ): Promise<RuntimeIdentity | undefined> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const workspace = this.workspaces.get(projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
      const active = this.activeRuntimes.get(this.runtimeKey(projectId, owner))
      if (active === undefined
        || active.nonce === undefined
        || active.sessionId !== owner.sessionId
        || active.connectionGeneration !== owner.connectionGeneration) return undefined
      return {
        projectId,
        revision: active.revision,
        runId: active.runId,
        nonce: active.nonce,
      }
    })
  }

  async grantActiveRuntimeControl(
    runtime: RuntimeIdentity,
    owner: RuntimeOwner,
  ): Promise<string> {
    validateProjectId(runtime.projectId)
    return this.withLock(runtime.projectId, async () => {
      await this.assertRuntimeIdentity(runtime, owner)
      const expiresAt = Date.now() + 60_000
      this.activeRuntimeGrants.set(this.runtimeKey(runtime.projectId, owner), {
        runtime,
        expiresAt,
      })
      return new Date(expiresAt).toISOString()
    })
  }

  async requestRuntimeCommand(
    runtime: RuntimeIdentity,
    owner: RuntimeOwner,
    kind: RuntimeHarnessCommand['kind'],
    target: RuntimeHarnessCommand['target'],
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    validateProjectId(runtime.projectId)
    signal?.throwIfAborted()
    let resolvePending!: (value: unknown) => void
    let rejectPending!: (error: Error) => void
    const promise = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve
      rejectPending = reject
    })
    let pending: PendingRuntimeCommand | undefined
    await this.withLock(runtime.projectId, async () => {
      signal?.throwIfAborted()
      const workspace = this.workspaces.get(runtime.projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${runtime.projectId}`)
      await this.assertRuntimeIdentity(runtime, owner)
      const key = this.runtimeKey(runtime.projectId, owner)
      if (this.runtimeCommands.has(key)) {
        throw new Error('Runtime control lease is busy')
      }
      if (target === 'active') {
        const grant = this.activeRuntimeGrants.get(key)
        this.activeRuntimeGrants.delete(key)
        if (grant === undefined
          || grant.expiresAt <= Date.now()
          || !sameRuntimeIdentity(grant.runtime, runtime)) {
          throw new Error('Active Runtime access requires a current user grant from the Editor')
        }
      }
      const expiresAt = Date.now() + timeoutMs
      const command: RuntimeHarnessCommand = {
        commandId: randomUUID(),
        kind,
        target,
        runtime,
        payload,
        expiresAt: new Date(expiresAt).toISOString(),
      }
      const settlementDeadline = runtimeCommandSettlementDeadline(command.expiresAt)
      const expireSettlement = () => {
        if (this.runtimeCommands.get(key) !== pending) return
        this.runtimeCommands.delete(key)
        rejectPending(new Error('Runtime Harness command timed out'))
      }
      const timer = setTimeout(() => {
        if (this.runtimeCommands.get(key) !== pending) return
        const remainingGraceMs = settlementDeadline - Date.now()
        if (remainingGraceMs <= 0) expireSettlement()
        else pending!.timer = setTimeout(expireSettlement, remainingGraceMs)
      }, timeoutMs)
      pending = {
        command,
        owner,
        resolve: resolvePending,
        reject: rejectPending,
        settlementDeadline,
        timer,
      }
      this.runtimeCommands.set(key, pending)
      if (signal !== undefined) {
        const activePending = pending
        activePending.abort = () => {
          if (this.runtimeCommands.get(key) !== activePending) return
          this.runtimeCommands.delete(key)
          clearTimeout(activePending.timer)
          activePending.reject(new Error('Runtime Harness command cancelled'))
        }
        signal.addEventListener('abort', activePending.abort, { once: true })
        if (signal.aborted) activePending.abort()
      }
    })
    return promise.finally(() => {
      if (pending === undefined) return
      clearTimeout(pending.timer)
      if (pending.abort !== undefined) signal?.removeEventListener('abort', pending.abort)
    })
  }

  async pullRuntimeCommand(
    runtime: RuntimeIdentity,
    owner: RuntimeOwner,
  ): Promise<RuntimeHarnessCommand | undefined> {
    validateProjectId(runtime.projectId)
    return this.withLock(runtime.projectId, async () => {
      const workspace = this.workspaces.get(runtime.projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${runtime.projectId}`)
      await this.assertRuntimeIdentity(runtime, owner)
      const pending = this.runtimeCommands.get(this.runtimeKey(runtime.projectId, owner))
      if (pending === undefined) return undefined
      if (!sameRuntimeOwner(pending.owner, owner)
        || !sameRuntimeIdentity(pending.command.runtime, runtime)) {
        throw new Error('Runtime control lease belongs to another owner or run')
      }
      return pending.command
    })
  }

  async reportRuntimeEvidence(
    runtime: RuntimeIdentity,
    owner: RuntimeOwner,
    commandId: string,
    result: unknown,
  ): Promise<void> {
    validateProjectId(runtime.projectId)
    await this.withLock(runtime.projectId, async () => {
      const workspace = this.workspaces.get(runtime.projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${runtime.projectId}`)
      const active = await this.assertRuntimeIdentity(runtime, owner)
      const key = this.runtimeKey(runtime.projectId, owner)
      const pending = this.runtimeCommands.get(key)
      if (pending === undefined
        || pending.command.commandId !== commandId
        || !sameRuntimeOwner(pending.owner, owner)
        || !sameRuntimeIdentity(pending.command.runtime, runtime)) {
        throw new Error('Runtime Harness result is stale or foreign')
      }
      const evidenceRuntime = result !== null
        && typeof result === 'object'
        && 'runtime' in result
        && result.runtime !== null
        && typeof result.runtime === 'object'
        ? result.runtime as Partial<RuntimeIdentity> & { target?: string }
        : undefined
      const evidenceToken = result !== null
        && typeof result === 'object'
        && 'evidenceToken' in result
        ? result.evidenceToken
        : undefined
      const evidenceKind = result !== null
        && typeof result === 'object'
        && 'kind' in result
        ? result.kind
        : undefined
      if (evidenceToken !== active.evidenceToken
        || evidenceRuntime === undefined
        || typeof evidenceRuntime.projectId !== 'string'
        || typeof evidenceRuntime.revision !== 'string'
        || typeof evidenceRuntime.runId !== 'string'
        || typeof evidenceRuntime.nonce !== 'string'
        || !sameRuntimeIdentity(evidenceRuntime as RuntimeIdentity, pending.command.runtime)
        || evidenceRuntime.target !== pending.command.target) {
        throw new Error('Runtime Harness evidence identity is stale or foreign')
      }
      if (evidenceKind !== RUNTIME_EVIDENCE_KIND[pending.command.kind]
        && evidenceKind !== 'runtime-harness-error') {
        throw new Error('Runtime Harness evidence kind does not match the pending command')
      }
      const evidenceStatus = result !== null
        && typeof result === 'object'
        && 'status' in result
        ? result.status
        : undefined
      if (Date.now() > pending.settlementDeadline) {
        this.runtimeCommands.delete(key)
        clearTimeout(pending.timer)
        pending.reject(new Error('Runtime Harness command timed out'))
        throw new Error('Runtime Harness result missed its settlement deadline')
      }
      // Settlement grace preserves terminal diagnostics, not successful evidence.
      if (Date.now() > Date.parse(pending.command.expiresAt)
        && !(evidenceKind === 'runtime-harness-error'
          || (evidenceKind === 'action-trace'
            && (evidenceStatus === 'failed' || evidenceStatus === 'cancelled')))) {
        throw new Error('Runtime Harness result missed its execution deadline')
      }
      this.runtimeCommands.delete(key)
      pending.resolve(result)
    })
  }

  async readEditorScene(
    projectId: string,
    revision: string,
    expectedRunId?: string,
    owner?: RuntimeOwner,
  ): Promise<unknown | undefined> {
    validateProjectId(projectId)
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('invalid editor scene revision')
    return this.withLock(projectId, async () => {
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== revision) throw new RevisionConflictError(snapshot.revision)
      try {
        const document = JSON.parse((await this.readMetadataFile(
          snapshot.path,
          this.metadataPath(snapshot.path, 'editor-scenes', `${revision}.json`),
        )).toString('utf8'))
        const runId = typeof document === 'object' && document !== null
          && 'runId' in document && typeof document.runId === 'string'
          ? document.runId
          : undefined
        const activeRuntime = owner === undefined
          ? await this.readActiveRuntime(snapshot.path)
          : this.activeRuntimes.get(this.runtimeKey(projectId, owner))
        return runId !== undefined
          && activeRuntime?.revision === revision
          && activeRuntime.runId === runId
          && (expectedRunId === undefined || runId === expectedRunId)
          ? document
          : undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    })
  }

  async reportDiagnostics(
    projectId: string,
    testedRevision: string,
    errors: string[],
    warnings: string[],
    runId?: string,
    owner?: RuntimeOwner,
  ): Promise<Diagnostics> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const workspace = this.workspaces.get(projectId)
      if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
      const snapshot = await this.loadUnlocked(projectId)
      if (snapshot.revision !== testedRevision) {
        throw new RevisionConflictError(snapshot.revision)
      }
      if (runId === undefined) {
        throw new Error('Workspace diagnostics require a Runtime runId')
      }
      const activeRuntime = owner === undefined
        ? await this.readActiveRuntime(snapshot.path)
        : this.activeRuntimes.get(this.runtimeKey(projectId, owner))
      if (activeRuntime?.revision !== testedRevision || activeRuntime.runId !== runId) {
        throw new Error('runtime run changed before diagnostics were reported')
      }
      const diagnostics = diagnosticsSchema.parse({
        testedRevision,
        runId,
        updatedAt: new Date().toISOString(),
        errors,
        warnings,
      })
      await this.writeAtomic(
        snapshot.path,
        this.metadataPath(snapshot.path, 'diagnostics', 'runtime.json'),
        canonicalBytes(diagnostics),
      )
      return diagnostics
    })
  }

  async readDiagnostics(
    projectId: string,
    owner?: RuntimeOwner,
  ): Promise<Diagnostics | undefined> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const snapshot = await this.loadUnlocked(projectId)
      try {
        const diagnostics = diagnosticsSchema.parse(JSON.parse((await this.readMetadataFile(
          snapshot.path,
          this.metadataPath(snapshot.path, 'diagnostics', 'runtime.json'),
        )).toString('utf8')))
        const activeRuntime = owner === undefined
          ? await this.readActiveRuntime(snapshot.path)
          : this.activeRuntimes.get(this.runtimeKey(projectId, owner))
        return activeRuntime?.revision === snapshot.revision
          && diagnostics.testedRevision === snapshot.revision
          && diagnostics.runId === activeRuntime.runId
          ? diagnostics
          : undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    })
  }

  async apply(
    projectId: string,
    baseRevision: string,
    candidates: unknown[],
    expectedRunId?: string,
    signal?: AbortSignal,
    owner?: RuntimeOwner,
  ): Promise<WorkspaceSnapshot> {
    validateProjectId(projectId)
    const changes = candidates.map(candidate => workspaceChangeSchema.parse(candidate))
    if (changes.length === 0 || changes.length > 100) {
      throw new Error('workspace change batch must contain 1 to 100 operations')
    }
    return this.withLock(projectId, async () => {
      signal?.throwIfAborted()
      const registration = this.workspaces.get(projectId)
      if (registration === undefined) throw new Error(`unknown workspace ${projectId}`)
      const commit = async (): Promise<WorkspaceSnapshot> => {
      const current = await this.loadUnlocked(projectId)
      if (current.revision !== baseRevision) {
        throw new RevisionConflictError(current.revision)
      }
      if (expectedRunId !== undefined) {
        const activeRuntime = owner === undefined
          ? await this.readActiveRuntime(current.path)
          : this.activeRuntimes.get(this.runtimeKey(projectId, owner))
        if (activeRuntime?.revision !== baseRevision
          || activeRuntime.runId !== expectedRunId) {
          throw new Error('runtime run changed before editor commands were applied')
        }
      }
      const normalized = await this.normalizeChanges(current, changes)
      if (normalized.length === 0) throw new Error('workspace change batch has no effect')
      const editorState = expectedRunId === undefined
        ? normalized.find(change => change.path === WORKSPACE_EDITOR_STATE_PATH)
        : undefined
      if (editorState?.after !== null && editorState?.after !== undefined) {
        const state = workspaceEditorStateSchema.parse(JSON.parse(
          (await this.readObject(registration.path, editorState.after)).toString('utf8'),
        ))
        applyOfficialEditorCommands(structuredClone(current.project), state.operations)
      }
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
      signal?.throwIfAborted()
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
      await this.writeAtomic(
        registration.path,
        transactionPath,
        canonicalBytes(transaction),
      )
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
            await removeFileBound(
              registration.path,
              join(registration.path, ...change.path.split('/')),
            )
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
        await this.writeAtomic(
          registration.path,
          this.metadataPath(registration.path, 'HEAD'),
          `${targetRevision}\n`,
        )
        transaction.status = 'committed'
        await this.writeAtomic(
          registration.path,
          transactionPath,
          canonicalBytes(transaction),
        )
      } catch (error) {
        await this.restoreChanges(registration.path, applied)
        await this.writeAtomic(
          registration.path,
          this.metadataPath(registration.path, 'HEAD'),
          `${baseRevision}\n`,
        )
        transaction.status = 'rolled-back'
        await this.writeAtomic(
          registration.path,
          transactionPath,
          canonicalBytes(transaction),
        )
        throw error
      }
      return this.loadUnlocked(projectId)
      }
      return commit()
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
        await removeFileBound(
          path,
          join(path, ...change.path.split('/')),
        ).catch(() => {})
      } else {
        await this.writeWorkspaceFile(path, change.path, await this.readObject(path, change.before))
      }
    }
  }

  private async readActiveRuntime(
    workspace: string,
    allowHardlinks = false,
  ): Promise<z.infer<typeof activeRuntimeSchema> | undefined> {
    const activeRuntime = await this.readActiveRuntimeRecord(workspace, allowHardlinks)
    return activeRuntime !== undefined && this.ownsActiveRuntime(activeRuntime)
      ? activeRuntime
      : undefined
  }

  private async assertRuntimeIdentity(
    runtime: RuntimeIdentity,
    owner: RuntimeOwner,
  ): Promise<ActiveRuntime> {
    const active = this.activeRuntimes.get(this.runtimeKey(runtime.projectId, owner))
    if (active === undefined) {
      const foreign = [...this.activeRuntimes.entries()].some(([key, candidate]) => (
        key.startsWith(`${runtime.projectId}\0`)
        && candidate.revision === runtime.revision
        && candidate.runId === runtime.runId
        && candidate.nonce === runtime.nonce
      ))
      if (foreign) {
        throw new Error('Runtime belongs to another Harness Session or connection generation')
      }
    }
    if (active === undefined
      || active.revision !== runtime.revision
      || active.runId !== runtime.runId
      || active.nonce !== runtime.nonce) {
      throw new Error('Runtime identity is stale or incomplete')
    }
    if (active.sessionId !== owner.sessionId
      || active.connectionGeneration !== owner.connectionGeneration) {
      throw new Error('Runtime belongs to another Harness Session or connection generation')
    }
    return active
  }

  private runtimeKey(projectId: string, owner: RuntimeOwner): string {
    return `${projectId}\0${owner.sessionId}\0${owner.connectionGeneration}`
  }

  private rejectRuntimeCommand(key: string, reason: string): void {
    const pending = this.runtimeCommands.get(key)
    if (pending === undefined) return
    this.runtimeCommands.delete(key)
    clearTimeout(pending.timer)
    pending.reject(new Error(reason))
  }

  private ownsActiveRuntime(activeRuntime: z.infer<typeof activeRuntimeSchema>): boolean {
    if (activeRuntime.ownerId !== this.runtimeOwnerId
      || activeRuntime.ownerPid === undefined) return false
    try {
      process.kill(activeRuntime.ownerPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
    return true
  }

  private async readActiveRuntimeRecord(
    workspace: string,
    allowHardlinks = false,
  ): Promise<z.infer<typeof activeRuntimeSchema> | undefined> {
    try {
      const bytes = await this.readMetadataFile(
        workspace,
        this.metadataPath(workspace, 'diagnostics', 'active-run.json'),
        allowHardlinks,
      )
      if (bytes.length === 0) return undefined
      return activeRuntimeSchema.parse(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
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
        if (info.nlink !== 1) throw new Error(`workspace path is hardlinked: ${relativePath}`)
        if (info.size > MAX_FILE_BYTES) throw new Error(`file ${relativePath} exceeds 1 MiB`)
        const bytes = await this.readWorkspaceFile(registration.path, relativePath)
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
          .parse(JSON.parse((await this.readMetadataFile(
            registration.path,
            configPath,
          )).toString('utf8')))
      config = stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      config = defaultWorkspaceConfig(registration.kind, projectId, packageDocument)
      await this.writeAtomic(registration.path, configPath, canonicalBytes(config))
    }
    const manifest = workspaceManifestSchema.parse({ ...config, kind: registration.kind, files })
    const capabilities = manifest.runtime.capabilities
    if (capabilities !== undefined) {
      const parameterIds = new Set(manifest.runtime.parameters.map(parameter => parameter.id))
      if (capabilities.parameterPanel.parameters.some(id => !parameterIds.has(id))) {
        throw new Error('capability parameter panel references an unknown parameter')
      }
      if (!manifest.runtime.debugModes.includes(capabilities.debugSurface.mode)) {
        throw new Error('capability debug surface references an unknown debug mode')
      }
      if (capabilities.extension.path !== manifest.entry) {
        throw new Error('capability extension must use the revision entry module')
      }
      const extension = manifest.files[capabilities.extension.path]
      if (extension === undefined || !extension.text || extension.size > 256 * 1024) {
        throw new Error('capability extension must be a bounded text module in the revision')
      }
    }
    return manifest
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
      const sourceText = await dependencySource(filePath, bytes.toString('utf8'))
      if (sourceText === undefined) continue
      for (const specifier of moduleSpecifiers(sourceText, filePath)) {
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
      for (const specifier of assetSpecifiers(filePath, sourceText)) {
        const resolved = await this.resolveModule(source, specifier, filePath)
        if (resolved === undefined) {
          return `Project asset is outside the selected DSH workspace: ${specifier}.`
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
      const sourceText = await dependencySource(filePath, bytes.toString('utf8'))
      if (sourceText === undefined) continue
      for (const specifier of moduleSpecifiers(sourceText, filePath)) {
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
      for (const specifier of assetSpecifiers(filePath, sourceText)) {
        const resolved = await this.resolveModule(source, specifier, filePath)
        if (resolved === undefined) {
          throw new Error(`workspace asset not found: ${specifier}`)
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
    if (!directory && info.nlink !== 1) throw new Error(`workspace path is hardlinked: ${path}`)
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
      project = projectSchema.parse(JSON.parse(
        (await this.readWorkspaceFile(path, 'src/scene.json')).toString('utf8'),
      ))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      project = createProject(title, 'empty')
    }
    try {
      project.script.source = (await this.readWorkspaceFile(path, 'src/main.js')).toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return project
  }

  private async ensureMetadata(path: string): Promise<void> {
    await this.ensureSafeDirectory(path, this.metadataPath(path))
    await Promise.all([
      'revisions',
      'objects',
      'transactions',
      'builds',
      'diagnostics',
      'editor-scenes',
    ].map(directory => this.ensureSafeDirectory(
      path,
      this.metadataPath(path, directory),
    )))
  }

  private async recover(path: string): Promise<void> {
    const directory = this.metadataPath(path, 'transactions')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const transactionPath = join(directory, entry.name)
      const transaction = JSON.parse((await this.readMetadataFile(
        path,
        transactionPath,
      )).toString('utf8')) as Transaction
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
        await this.writeAtomic(
          path,
          this.metadataPath(path, 'HEAD'),
          `${transaction.baseRevision}\n`,
        )
        transaction.status = 'rolled-back'
      }
      await this.writeAtomic(path, transactionPath, canonicalBytes(transaction))
    }
  }

  private async persistRevision(
    path: string,
    revision: string,
    manifest: WorkspaceManifest,
  ): Promise<void> {
    const target = this.metadataPath(path, 'revisions', `${revision}.json`)
    const bytes = canonicalBytes(manifest)
    try {
      const stored = await this.readMetadataFile(path, target)
      if (!stored.equals(bytes)) throw new Error('stored Workspace revision is corrupt')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!await createFileBound(path, target, bytes)) {
      const stored = await this.readMetadataFile(path, target)
      if (!stored.equals(bytes)) throw new Error('stored Workspace revision is corrupt')
    }
  }

  private async readStoredBuild(path: string, buildId: string): Promise<StoredBuild | undefined> {
    try {
      return storedBuild(JSON.parse((await this.readMetadataFile(
        path,
        this.metadataPath(path, 'builds', buildId, 'build.json'),
      )).toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readHead(path: string): Promise<string | undefined> {
    try {
      const value = (await this.readMetadataFile(
        path,
        this.metadataPath(path, 'HEAD'),
      )).toString('utf8').trim()
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
      const stored = await this.readMetadataFile(path, target)
      if (digest(stored) !== hash) throw new Error('stored Workspace object is corrupt')
      return hash
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!await createFileBound(path, target, bytes)) {
      const stored = await this.readMetadataFile(path, target)
      if (digest(stored) !== hash) throw new Error('stored Workspace object is corrupt')
    }
    return hash
  }

  private readObject(path: string, hash: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid object hash')
    return this.readMetadataFile(path, this.metadataPath(path, 'objects', hash))
  }

  private async readWorkspaceFile(root: string, path: string): Promise<Buffer> {
    const file = join(root, ...safePath(path).split('/'))
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
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
    await this.writeAtomic(root, target, bytes)
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

  private async readMetadataFile(
    root: string,
    path: string,
    allowHardlinks = false,
  ): Promise<Buffer> {
    const file = await this.openMetadataFile(root, path, constants.O_RDONLY, allowHardlinks)
    try {
      return await file.readFile()
    } finally {
      await file.close()
    }
  }

  private async openMetadataFile(
    root: string,
    path: string,
    flags: number,
    allowHardlinks = false,
  ): Promise<FileHandle> {
    if (!isWithin(root, path)) throw new Error('workspace metadata escapes root')
    const name = relative(root, path)
    const invalid = (): Error => new Error(`workspace metadata is not a regular file: ${name}`)
    const info = await lstat(path)
    if (!info.isFile()
      || info.isSymbolicLink()
      || (!allowHardlinks && info.nlink !== 1)) throw invalid()
    let file
    try {
      file = await open(path, flags | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw invalid()
      throw error
    }
    try {
      const [opened, current, resolved] = await Promise.all([
        file.stat(),
        lstat(path),
        realpath(path),
      ])
      if (!opened.isFile()
        || (!allowHardlinks && opened.nlink !== 1)
        || !current.isFile()
        || current.isSymbolicLink()
        || (!allowHardlinks && current.nlink !== 1)
        || opened.dev !== current.dev
        || opened.ino !== current.ino
        || resolved !== path
        || !isWithin(root, resolved)) {
        throw invalid()
      }
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }

  private async clearActiveRuntime(
    workspace: string,
    revision: string,
    runId: string,
  ): Promise<boolean> {
    const path = this.metadataPath(workspace, 'diagnostics', 'active-run.json')
    let file: FileHandle
    try {
      file = await this.openMetadataFile(
        workspace,
        path,
        constants.O_RDONLY,
        true,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    try {
      const bytes = await file.readFile()
      if (bytes.length === 0) return false
      const activeRuntime = activeRuntimeSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (!this.ownsActiveRuntime(activeRuntime)
        || activeRuntime.revision !== revision
        || activeRuntime.runId !== runId) return false
    } finally {
      await file.close()
    }
    await this.ensureSafeDirectory(workspace, dirname(path))
    await this.writeAtomic(workspace, path, Buffer.alloc(0))
    return true
  }

  private async writeAtomic(
    root: string,
    path: string,
    bytes: Uint8Array | string,
  ): Promise<void> {
    await this.ensureSafeDirectory(root, dirname(path))
    await replaceFileBound(root, path, bytes)
  }

  private metadataPath(path: string, ...parts: string[]): string {
    return join(path, '.threejs-editor', ...parts)
  }

  private async withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    await this.ready
    const workspace = this.workspaces.get(projectId)
    if (workspace === undefined) throw new Error(`unknown workspace ${projectId}`)
    return withCrossProcessRuntimeLock(
      runtimeLockPathForWorkspace(workspace.path),
      action,
    )
  }
}

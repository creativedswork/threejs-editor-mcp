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
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import * as THREE from 'three'
import { z } from 'zod'

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ASSET_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_PROJECT_BYTES = 2 * 1024 * 1024
export const MAX_ASSET_BYTES = 256 * 1024
const MAX_ASSET_TOTAL_BYTES = 512 * 1024
const MAX_ASSET_COUNT = 8

export const editorLayoutSchema = z.enum(['classic', 'wide', 'compact'])
export const cameraViewSchema = z.enum(['broadcast', 'overhead', 'courtside'])
export const assetMediaTypeSchema = z.enum([
  'model/gltf-binary',
  'image/png',
  'image/jpeg',
])
export const assetSummarySchema = z.object({
  name: z.string().regex(ASSET_NAME),
  mediaType: assetMediaTypeSchema,
  size: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const editorStateSchema = z.object({
  layout: editorLayoutSchema,
  cameraView: cameraViewSchema,
  operations: z.array(z.string().min(1).max(240)).max(50),
})
export const diagnosticsSchema = z.object({
  testedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string(),
  errors: z.array(z.string().min(1).max(2_000)).max(20),
  warnings: z.array(z.string().min(1).max(2_000)).max(20),
})

export const projectSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(120),
  scene: z.record(z.string(), z.unknown()),
  camera: z.record(z.string(), z.unknown()),
  renderer: z.object({
    antialias: z.boolean(),
    shadows: z.boolean(),
  }),
  script: z.object({
    source: z.string().max(250_000),
  }),
  editor: editorStateSchema.optional(),
})

export type Project = z.infer<typeof projectSchema>
export type ProjectTemplate = 'empty' | 'pong'
export type Diagnostics = z.infer<typeof diagnosticsSchema>
export type AssetMediaType = z.infer<typeof assetMediaTypeSchema>
export type AssetSummary = z.infer<typeof assetSummarySchema>

export interface StoredAsset extends AssetSummary {
  data: string
}

export interface ProjectSummary {
  projectId: string
  title: string
  revision: string
}

export interface ProjectSnapshot extends ProjectSummary {
  project: Project
}

export class RevisionConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super('project revision changed')
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  )
}

function projectBytes(project: Project): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(canonicalValue(project), null, 2)}\n`)
  if (bytes.byteLength > MAX_PROJECT_BYTES) throw new Error('project exceeds 2 MiB')
  return bytes
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validateAssetName(name: string, mediaType: AssetMediaType): void {
  if (!ASSET_NAME.test(name)) {
    throw new Error('asset name must contain only lowercase letters, numbers, dot, dash, or underscore')
  }
  const extension = extname(name)
  const expected = extension === '.glb'
    ? 'model/gltf-binary'
    : extension === '.png'
      ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : undefined
  if (expected !== mediaType) throw new Error('asset extension does not match media type')
}

function validateGlb(bytes: Buffer): void {
  if (bytes.length < 20
    || bytes.readUInt32LE(0) !== 0x46546c67
    || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length
    || bytes.readUInt32LE(16) !== 0x4e4f534a) {
    throw new Error('invalid GLB 2.0 header')
  }
  const jsonLength = bytes.readUInt32LE(12)
  if (jsonLength === 0 || 20 + jsonLength > bytes.length) throw new Error('invalid GLB JSON chunk')
  let document: unknown
  try {
    document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim())
  } catch {
    throw new Error('invalid GLB JSON chunk')
  }
  const root = document !== null && typeof document === 'object'
    ? document as Record<string, unknown>
    : {}
  for (const collection of [root.buffers, root.images]) {
    if (!Array.isArray(collection)) continue
    for (const entry of collection) {
      const uri = entry !== null && typeof entry === 'object'
        ? (entry as Record<string, unknown>).uri
        : undefined
      if (typeof uri === 'string' && !uri.startsWith('data:')) {
        throw new Error('GLB external resource URIs are not supported')
      }
    }
  }
}

function validateAssetBytes(data: Uint8Array, mediaType: AssetMediaType): Buffer {
  const bytes = Buffer.from(data)
  if (bytes.length === 0) throw new Error('asset is empty')
  if (bytes.length > MAX_ASSET_BYTES) throw new Error('asset exceeds 256 KiB')
  if (mediaType === 'model/gltf-binary') validateGlb(bytes)
  if (mediaType === 'image/png'
    && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('invalid PNG signature')
  }
  if (mediaType === 'image/jpeg'
    && (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)) {
    throw new Error('invalid JPEG signature')
  }
  return bytes
}

const EMPTY_SCRIPT = `return {
  start() {},
  update() {},
  dispose() {},
}`

const PONG_SCRIPT = `const velocity = new THREE.Vector2(3.25, 1.65)
const clamp = value => THREE.MathUtils.clamp(value, -2.3, 2.3)
return {
  start({ scene }) {
    scene.getObjectByName('Ball').position.set(0, 0.26, 0)
  },
  update({ scene, input }, delta) {
    const ball = scene.getObjectByName('Ball')
    const left = scene.getObjectByName('Left Paddle')
    const right = scene.getObjectByName('Right Paddle')
    const direction = Number(input.keys.has('s') || input.keys.has('arrowdown'))
      - Number(input.keys.has('w') || input.keys.has('arrowup'))
    left.position.z = clamp(left.position.z + direction * delta * 5.1)
    right.position.z = clamp(THREE.MathUtils.damp(right.position.z, ball.position.z, 4.5, delta))
    ball.position.x += velocity.x * delta
    ball.position.z += velocity.y * delta
    if (Math.abs(ball.position.z) >= 2.68) {
      ball.position.z = Math.sign(ball.position.z) * 2.68
      velocity.y *= -1
    }
    const paddle = velocity.x < 0 ? left : right
    const face = velocity.x < 0 ? -4.23 : 4.23
    const crossed = velocity.x < 0 ? ball.position.x <= face : ball.position.x >= face
    if (crossed && Math.abs(ball.position.x - face) < 0.35
      && Math.abs(ball.position.z - paddle.position.z) < 0.8) {
      ball.position.x = face
      velocity.x *= -1.035
      velocity.y += (ball.position.z - paddle.position.z) * 1.7
    }
    if (Math.abs(ball.position.x) > 5.2) {
      const nextX = ball.position.x < 0 ? 3.25 : -3.25
      ball.position.set(0, 0.26, 0)
      velocity.set(nextX, 1.2)
    }
  },
  dispose() {},
}`

function createProject(title: string, template: ProjectTemplate): Project {
  const scene = new THREE.Scene()
  scene.name = title
  scene.background = new THREE.Color(0x0b0d10)

  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 100)
  camera.name = 'Camera'
  camera.position.set(0, 8.2, 9.4)
  camera.lookAt(0, 0, 0)

  scene.add(new THREE.HemisphereLight(0xa8c7ff, 0x171d28, 1.8))
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2)
  keyLight.name = 'Key Light'
  keyLight.position.set(-3, 8, 5)
  scene.add(keyLight)

  if (template === 'pong') {
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 6),
      new THREE.MeshStandardMaterial({ color: 0x18202a, roughness: 0.82 }),
    )
    field.name = 'Field'
    field.rotation.x = -Math.PI / 2
    scene.add(field)

    const paddleGeometry = new THREE.BoxGeometry(0.22, 0.28, 1.2)
    const left = new THREE.Mesh(
      paddleGeometry,
      new THREE.MeshStandardMaterial({ color: 0x3ddc84 }),
    )
    left.name = 'Left Paddle'
    left.position.set(-4.45, 0.18, 0)
    scene.add(left)

    const right = new THREE.Mesh(
      paddleGeometry,
      new THREE.MeshStandardMaterial({ color: 0x56a8ff }),
    )
    right.name = 'Right Paddle'
    right.position.set(4.45, 0.18, 0)
    scene.add(right)

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0xffd166 }),
    )
    ball.name = 'Ball'
    ball.position.set(0, 0.26, 0)
    scene.add(ball)
  }

  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  return projectSchema.parse({
    schemaVersion: 1,
    title,
    scene: scene.toJSON(),
    camera: camera.toJSON(),
    renderer: {
      antialias: true,
      shadows: true,
    },
    script: {
      source: template === 'pong' ? PONG_SCRIPT : EMPTY_SCRIPT,
    },
    editor: {
      layout: 'classic',
      cameraView: 'broadcast',
      operations: [],
    },
  })
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error('projectId must match [a-z0-9][a-z0-9-]{0,63}')
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export class ProjectStore {
  private readonly root: Promise<string>
  private readonly locks = new Map<string, Promise<void>>()

  constructor(root: string) {
    const absolute = resolve(root)
    this.root = mkdir(absolute, { recursive: true }).then(() => realpath(absolute))
  }

  async list(): Promise<ProjectSummary[]> {
    const root = await this.root
    const entries = await readdir(root, { withFileTypes: true })
    const projects: ProjectSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue
      const snapshot = await this.load(entry.name)
      projects.push({
        projectId: snapshot.projectId,
        title: snapshot.title,
        revision: snapshot.revision,
      })
    }
    return projects.sort((left, right) => left.projectId.localeCompare(right.projectId))
  }

  async create(
    projectId: string,
    title: string,
    template: ProjectTemplate,
  ): Promise<ProjectSummary> {
    return this.createStored(projectId, createProject(title, template))
  }

  async saveCopy(projectId: string, candidate: unknown): Promise<ProjectSummary> {
    return this.createStored(projectId, projectSchema.parse(candidate))
  }

  async saveCopyWithAssets(
    sourceProjectId: string,
    projectId: string,
    candidate: unknown,
  ): Promise<ProjectSummary> {
    return this.createStored(
      projectId,
      projectSchema.parse(candidate),
      await this.readAssets(sourceProjectId),
    )
  }

  private async createStored(
    projectId: string,
    project: Project,
    assets: StoredAsset[] = [],
  ): Promise<ProjectSummary> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const root = await this.root
      const directory = join(root, projectId)
      let created = false
      try {
        await mkdir(directory)
        created = true
        const assetDirectory = join(directory, 'assets')
        await mkdir(assetDirectory)
        const bytes = projectBytes(project)
        await writeFile(join(directory, 'project.json'), bytes, { flag: 'wx', mode: 0o600 })
        for (const asset of assets) {
          validateAssetName(asset.name, asset.mediaType)
          const assetBytes = validateAssetBytes(Buffer.from(asset.data, 'base64'), asset.mediaType)
          await writeFile(join(assetDirectory, asset.name), assetBytes, {
            flag: 'wx',
            mode: 0o600,
          })
        }
        return { projectId, title: project.title, revision: digest(bytes) }
      } catch (error) {
        if (created) await rm(directory, { recursive: true, force: true })
        throw error
      }
    })
  }

  async load(projectId: string): Promise<ProjectSnapshot> {
    validateProjectId(projectId)
    const root = await this.root
    const directory = join(root, projectId)
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('project path must be a real directory')
    }
    const resolvedDirectory = await realpath(directory)
    if (!isWithin(root, resolvedDirectory)) throw new Error('project path escapes root')

    const file = join(resolvedDirectory, 'project.json')
    const fileInfo = await lstat(file)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error('project.json must be a regular file')
    }
    if ((await stat(file)).size > MAX_PROJECT_BYTES) throw new Error('project exceeds 2 MiB')

    const project = projectSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    const bytes = projectBytes(project)
    return {
      projectId,
      title: project.title,
      revision: digest(bytes),
      project,
    }
  }

  async push(
    projectId: string,
    baseRevision: string,
    candidate: unknown,
  ): Promise<ProjectSummary> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const current = await this.load(projectId)
      if (current.revision !== baseRevision) {
        throw new RevisionConflictError(current.revision)
      }
      const project = projectSchema.parse(candidate)
      const bytes = projectBytes(project)
      const directory = join(await this.root, projectId)
      const temporary = join(directory, `.project.${String(process.pid)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(directory, 'project.json'))
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      return { projectId, title: project.title, revision: digest(bytes) }
    })
  }

  async reportDiagnostics(
    projectId: string,
    testedRevision: string,
    errors: string[],
    warnings: string[],
  ): Promise<Diagnostics> {
    validateProjectId(projectId)
    return this.withLock(projectId, async () => {
      const current = await this.load(projectId)
      if (current.revision !== testedRevision) {
        throw new RevisionConflictError(current.revision)
      }
      const diagnostics = diagnosticsSchema.parse({
        testedRevision,
        updatedAt: new Date().toISOString(),
        errors,
        warnings,
      })
      const directory = join(await this.root, projectId)
      const temporary = join(directory, `.diagnostics.${String(process.pid)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(diagnostics, null, 2)}\n`, {
          flag: 'wx',
          mode: 0o600,
        })
        await rename(temporary, join(directory, 'diagnostics.json'))
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      return diagnostics
    })
  }

  async readDiagnostics(projectId: string): Promise<Diagnostics | undefined> {
    validateProjectId(projectId)
    const snapshot = await this.load(projectId)
    const file = join(await this.root, snapshot.projectId, 'diagnostics.json')
    try {
      return diagnosticsSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async listAssets(projectId: string): Promise<AssetSummary[]> {
    await this.load(projectId)
    const directory = await this.assetDirectory(projectId)
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length > MAX_ASSET_COUNT) throw new Error('project exceeds 8 assets')
    const assets: AssetSummary[] = []
    let total = 0
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('assets must be regular files')
      }
      const mediaType = this.assetMediaType(entry.name)
      const bytes = validateAssetBytes(await readFile(join(directory, entry.name)), mediaType)
      validateAssetName(entry.name, mediaType)
      total += bytes.length
      assets.push({
        name: entry.name,
        mediaType,
        size: bytes.length,
        sha256: digest(bytes),
      })
    }
    if (total > MAX_ASSET_TOTAL_BYTES) throw new Error('project assets exceed 512 KiB')
    return assets.sort((left, right) => left.name.localeCompare(right.name))
  }

  async putAsset(
    projectId: string,
    baseRevision: string,
    name: string,
    mediaType: AssetMediaType,
    data: Uint8Array,
  ): Promise<AssetSummary & { revision: string }> {
    validateProjectId(projectId)
    validateAssetName(name, mediaType)
    const bytes = validateAssetBytes(data, mediaType)
    return this.withLock(projectId, async () => {
      const snapshot = await this.load(projectId)
      if (snapshot.revision !== baseRevision) {
        throw new RevisionConflictError(snapshot.revision)
      }
      const assets = await this.listAssets(projectId)
      const previous = assets.find(asset => asset.name === name)
      if (previous === undefined && assets.length >= MAX_ASSET_COUNT) {
        throw new Error('project exceeds 8 assets')
      }
      const total = assets.reduce((sum, asset) => sum + asset.size, 0)
        - (previous?.size ?? 0) + bytes.length
      if (total > MAX_ASSET_TOTAL_BYTES) throw new Error('project assets exceed 512 KiB')

      const directory = await this.assetDirectory(projectId)
      const temporary = join(directory, `.asset.${String(process.pid)}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(directory, name))
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
      return {
        name,
        mediaType,
        size: bytes.length,
        sha256: digest(bytes),
        revision: snapshot.revision,
      }
    })
  }

  async exportProject(projectId: string): Promise<{
    format: 'threejs-editor-mcp'
    formatVersion: 1
    projectId: string
    revision: string
    project: Project
    assets: StoredAsset[]
  }> {
    const snapshot = await this.load(projectId)
    return {
      format: 'threejs-editor-mcp',
      formatVersion: 1,
      projectId,
      revision: snapshot.revision,
      project: snapshot.project,
      assets: await this.readAssets(projectId),
    }
  }

  private async readAssets(projectId: string): Promise<StoredAsset[]> {
    const directory = await this.assetDirectory(projectId)
    return Promise.all((await this.listAssets(projectId)).map(async asset => ({
      ...asset,
      data: (await readFile(join(directory, asset.name))).toString('base64'),
    })))
  }

  private assetMediaType(name: string): AssetMediaType {
    const extension = extname(name)
    if (extension === '.glb') return 'model/gltf-binary'
    if (extension === '.png') return 'image/png'
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
    throw new Error(`unsupported asset extension: ${extension || '(none)'}`)
  }

  private async assetDirectory(projectId: string): Promise<string> {
    validateProjectId(projectId)
    const root = await this.root
    const projectDirectory = await realpath(join(root, projectId))
    if (!isWithin(root, projectDirectory)) throw new Error('project path escapes root')
    const directory = join(projectDirectory, 'assets')
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('assets path must be a real directory')
    }
    const resolved = await realpath(directory)
    if (!isWithin(projectDirectory, resolved)) throw new Error('assets path escapes project')
    return resolved
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

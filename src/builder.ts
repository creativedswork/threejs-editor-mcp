import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
} from 'node:path'
import {
  build,
  version as esbuildVersion,
  type BuildFailure,
  type Loader,
  type Message,
  type Plugin,
} from 'esbuild'

export const BUILDER_VERSION = 'm7-esbuild-v1'
export const DEPENDENCY_PROFILE = `three@0.185.1+esbuild@${esbuildVersion}`

const require = createRequire(import.meta.url)
const threeRoot = dirname(dirname(require.resolve('three/webgpu')))
const runtimeEntry = 'threejs-editor:runtime'
const workspaceNamespace = 'threejs-editor-workspace'
const runtimeNamespace = 'threejs-editor-runtime'
const resolveExtensions = [
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

export interface BuildFile {
  path: string
  bytes: Uint8Array
  sha256: string
  mediaType: string
  text: boolean
}

export interface BuildDiagnostic {
  severity: 'error' | 'warning'
  message: string
  file?: string
  line?: number
  column?: number
  length?: number
  lineText?: string
}

export interface BuildAsset {
  path: string
  sha256: string
  size: number
  mediaType: string
}

interface BuildBase {
  schemaVersion: 1
  builderVersion: string
  dependencyProfile: string
  projectId: string
  revision: string
  buildId: string
  entry: string
  backend: 'webgl' | 'webgpu' | 'raw-webgpu'
  diagnostics: BuildDiagnostic[]
}

export interface ReadyBuild extends BuildBase {
  status: 'ready'
  bundle: string
  sourceMap: string
  bundleBytes: number
  sourceMapBytes: number
  inputs: string[]
  assets: BuildAsset[]
}

export interface FailedBuild extends BuildBase {
  status: 'failed'
}

export type WorkspaceBuild = ReadyBuild | FailedBuild

export interface BuildWorkspaceInput {
  projectId: string
  revision: string
  entry: string
  backend: 'webgl' | 'webgpu' | 'raw-webgpu'
  files: BuildFile[]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function buildIdFor(input: BuildWorkspaceInput): string {
  return digest([
    BUILDER_VERSION,
    DEPENDENCY_PROFILE,
    input.projectId,
    input.revision,
    input.entry,
    input.backend,
  ].join('\0'))
}

function dependencyPath(specifier: string): string | undefined {
  if (specifier === 'three') return join(threeRoot, 'build', 'three.module.js')
  if (specifier === 'three/webgpu') return join(threeRoot, 'build', 'three.webgpu.js')
  if (specifier === 'three/tsl') return join(threeRoot, 'build', 'three.tsl.js')
  const prefix = 'three/addons/'
  if (!specifier.startsWith(prefix)) return undefined
  const suffix = specifier.slice(prefix.length)
  if (suffix === '' || suffix.split('/').some(part => part === '' || part === '.' || part === '..')) {
    return undefined
  }
  return join(threeRoot, 'examples', 'jsm', ...suffix.split('/'))
}

function requestPath(request: string): string {
  const query = request.indexOf('?')
  if (query === -1) return request
  const suffix = request.slice(query + 1)
  if (suffix !== 'raw' && suffix !== 'inline') {
    throw new Error(`unsupported import query ?${suffix}`)
  }
  return request.slice(0, query)
}

function workspacePath(
  request: string,
  importer: string,
  files: Map<string, BuildFile>,
): string | undefined {
  const clean = requestPath(request)
  const candidate = clean.startsWith('/')
    ? posix.normalize(clean.slice(1))
    : posix.normalize(posix.join(posix.dirname(importer), clean))
  if (candidate === '' || candidate === '..' || candidate.startsWith('../')) return undefined
  const attempts = [
    candidate,
    ...extname(candidate) === '' ? resolveExtensions.map(extension => `${candidate}${extension}`) : [],
    ...resolveExtensions.map(extension => `${candidate}/index${extension}`),
  ]
  return attempts.find(path => files.has(path))
}

function loaderFor(file: BuildFile): Loader {
  const extension = extname(file.path).toLowerCase()
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'js'
  if (extension === '.jsx') return 'jsx'
  if (extension === '.ts') return 'ts'
  if (extension === '.tsx') return 'tsx'
  if (extension === '.json') return 'json'
  if (extension === '.glsl'
    || extension === '.vert'
    || extension === '.frag'
    || extension === '.wgsl'
    || extension === '.tsl') return 'text'
  if (!file.text) return 'dataurl'
  return 'text'
}

function runtimeSource(input: BuildWorkspaceInput): string {
  const threeSpecifier = input.backend === 'webgpu' ? 'three/webgpu' : 'three'
  return [
    `import adapter from ${JSON.stringify(`/${input.entry}`)}`,
    `import * as THREE from ${JSON.stringify(threeSpecifier)}`,
    'import { OrbitControls } from "three/addons/controls/OrbitControls.js"',
    'export { adapter, THREE, OrbitControls }',
  ].join('\n')
}

function vfsPlugin(input: BuildWorkspaceInput, files: Map<string, BuildFile>): Plugin {
  return {
    name: 'threejs-editor-vfs',
    setup(builder) {
      builder.onResolve({ filter: /^three(?:\/|$)/ }, args => {
        if (args.namespace !== workspaceNamespace && args.namespace !== runtimeNamespace) {
          return undefined
        }
        const path = dependencyPath(args.path)
        if (path === undefined) {
          return { errors: [{ text: `unsupported Three.js import ${JSON.stringify(args.path)}` }] }
        }
        return { path }
      })
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point' && args.path === runtimeEntry) {
          return { path: runtimeEntry, namespace: runtimeNamespace }
        }
        if (args.namespace !== workspaceNamespace && args.namespace !== runtimeNamespace) {
          return undefined
        }
        if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
          return {
            errors: [{
              text: `dependency ${JSON.stringify(args.path)} is not in the pinned M7 profile`,
            }],
          }
        }
        try {
          const path = workspacePath(
            args.path,
            args.namespace === runtimeNamespace ? input.entry : args.importer,
            files,
          )
          if (path === undefined) {
            return { errors: [{ text: `workspace module not found: ${args.path}` }] }
          }
          return { path, namespace: workspaceNamespace }
        } catch (error) {
          return { errors: [{ text: error instanceof Error ? error.message : String(error) }] }
        }
      })
      builder.onLoad({ filter: /.*/, namespace: runtimeNamespace }, () => ({
        contents: runtimeSource(input),
        loader: 'js',
        resolveDir: '/',
      }))
      builder.onLoad({ filter: /.*/, namespace: workspaceNamespace }, args => {
        const file = files.get(args.path)
        if (file === undefined) return { errors: [{ text: `workspace module not found: ${args.path}` }] }
        return {
          contents: file.bytes,
          loader: loaderFor(file),
          resolveDir: `/${posix.dirname(file.path)}`,
        }
      })
    },
  }
}

function safeDiagnosticFile(file: string): string {
  if (file.startsWith(`${workspaceNamespace}:`)) {
    return file.slice(workspaceNamespace.length + 1).replace(/^\/+/, '')
  }
  if (file.startsWith(`${runtimeNamespace}:`)) return 'runtime://entry.js'
  const normalized = file.replaceAll('\\', '/')
  const marker = '/node_modules/three/'
  const index = normalized.lastIndexOf(marker)
  if (index !== -1) return `dependency://three/${normalized.slice(index + marker.length)}`
  if (isAbsolute(file)) return `dependency://three/${basename(file)}`
  return normalized.replace(/^(\.\.\/)+/, '')
}

function diagnostic(message: Message, severity: BuildDiagnostic['severity']): BuildDiagnostic {
  if (message.location === null) return { severity, message: message.text }
  return {
    severity,
    message: message.text,
    file: safeDiagnosticFile(message.location.file),
    line: message.location.line,
    column: message.location.column + 1,
    length: message.location.length,
    lineText: message.location.lineText,
  }
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return error instanceof Error
    && Array.isArray((error as Partial<BuildFailure>).errors)
    && Array.isArray((error as Partial<BuildFailure>).warnings)
}

function safeSource(source: string): string {
  if (source.startsWith(`${workspaceNamespace}:`)) {
    return `workspace:///${source.slice(workspaceNamespace.length + 1).replace(/^\/+/, '')}`
  }
  if (source.startsWith(`${runtimeNamespace}:`)) return 'runtime://entry.js'
  const normalized = source.replaceAll('\\', '/')
  const marker = '/node_modules/three/'
  const index = normalized.lastIndexOf(marker)
  if (index !== -1) return `dependency://three/${normalized.slice(index + marker.length)}`
  if (normalized.includes('/.pnpm/three@')) {
    const nested = normalized.lastIndexOf('/node_modules/three/')
    if (nested !== -1) return `dependency://three/${normalized.slice(nested + 20)}`
  }
  return isAbsolute(source)
    ? `dependency://three/${basename(source)}`
    : normalized.replace(/^(\.\.\/)+/, '')
}

function sanitizeSourceMap(sourceMap: string): string {
  const parsed = JSON.parse(sourceMap) as {
    sourceRoot?: string
    sources?: string[]
  }
  parsed.sourceRoot = ''
  if (Array.isArray(parsed.sources)) parsed.sources = parsed.sources.map(safeSource)
  return JSON.stringify(parsed)
}

function safeInput(path: string): string {
  if (path.startsWith(`${workspaceNamespace}:`)) {
    return path.slice(workspaceNamespace.length + 1).replace(/^\/+/, '')
  }
  if (path.startsWith(`${runtimeNamespace}:`)) return 'runtime://entry.js'
  return safeSource(path)
}

export async function buildWorkspace(input: BuildWorkspaceInput): Promise<WorkspaceBuild> {
  const buildId = buildIdFor(input)
  const base: BuildBase = {
    schemaVersion: 1,
    builderVersion: BUILDER_VERSION,
    dependencyProfile: DEPENDENCY_PROFILE,
    projectId: input.projectId,
    revision: input.revision,
    buildId,
    entry: input.entry,
    backend: input.backend,
    diagnostics: [],
  }
  const files = new Map(input.files.map(file => [file.path, file]))
  if (!files.has(input.entry)) {
    return {
      ...base,
      status: 'failed',
      diagnostics: [{
        severity: 'error',
        message: `workspace entry does not exist: ${input.entry}`,
        file: input.entry,
      }],
    }
  }
  try {
    const result = await build({
      absWorkingDir: '/',
      entryPoints: [runtimeEntry],
      outfile: '/bundle.js',
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      treeShaking: true,
      sourcemap: 'external',
      sourcesContent: true,
      metafile: true,
      legalComments: 'none',
      logLevel: 'silent',
      logOverride: {
        'import-is-undefined': 'silent',
      },
      plugins: [vfsPlugin(input, files)],
    })
    const bundle = result.outputFiles?.find(file => file.path.endsWith('/bundle.js'))?.text
    const rawSourceMap = result.outputFiles?.find(file => file.path.endsWith('/bundle.js.map'))?.text
    if (bundle === undefined || rawSourceMap === undefined || result.metafile === undefined) {
      throw new Error('esbuild did not return the expected bundle artifacts')
    }
    const sourceMap = sanitizeSourceMap(rawSourceMap)
    return {
      ...base,
      status: 'ready',
      diagnostics: result.warnings.map(message => diagnostic(message, 'warning')),
      bundle,
      sourceMap,
      bundleBytes: Buffer.byteLength(bundle),
      sourceMapBytes: Buffer.byteLength(sourceMap),
      inputs: Object.keys(result.metafile.inputs).map(safeInput).sort(),
      assets: input.files
        .filter(file => !file.text)
        .map(file => ({
          path: file.path,
          sha256: file.sha256,
          size: file.bytes.byteLength,
          mediaType: file.mediaType,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }
  } catch (error) {
    if (!isBuildFailure(error)) throw error
    return {
      ...base,
      status: 'failed',
      diagnostics: [
        ...error.errors.map(message => diagnostic(message, 'error')),
        ...error.warnings.map(message => diagnostic(message, 'warning')),
      ],
    }
  }
}

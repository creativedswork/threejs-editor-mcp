import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
import ts from 'typescript'
import { WORKSPACE_EDITOR_STATE_PATH } from './m7-runtime.js'

export const BUILDER_VERSION = 'm10-loader-profile-v1'
export const PINNED_RUNTIME_DEPENDENCIES = {
  three: '0.185.1',
  postprocessing: '6.37.4',
  'three-stdlib': '2.36.0',
  'astronomy-engine': '2.1.19',
  '@petamoriken/float16': '3.9.2',
} as const
export const DEPENDENCY_PROFILE = [
  ...Object.entries(PINNED_RUNTIME_DEPENDENCIES).map(([name, version]) => `${name}@${version}`),
  `esbuild@${esbuildVersion}`,
].join('+')

const require = createRequire(import.meta.url)
const threeRoot = dirname(dirname(require.resolve('three/webgpu')))
const dependencyEntries = new Map(
  Object.keys(PINNED_RUNTIME_DEPENDENCIES)
    .filter(name => name !== 'three')
    .map(name => [name, require.resolve(name)]),
)
const runtimeEntry = 'threejs-editor:runtime'
const workspaceNamespace = 'threejs-editor-workspace'
const runtimeNamespace = 'threejs-editor-runtime'
const MAX_GENERATED_SOURCE_BYTES = 64 * 1024 * 1024
export const MAX_INLINE_ASSET_BYTES = 256 * 1024
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
  external?: true
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
  const dependency = dependencyEntries.get(specifier)
  if (dependency !== undefined) return dependency
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
  if (!file.text) return 'js'
  return 'text'
}

function rewritesAssetLiterals(path: string): boolean {
  return ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css']
    .includes(extname(path).toLowerCase())
}

interface AssetStringLiteral {
  start: number
  end: number
  quote: string
  request: string
}

interface AssetCssUrl {
  start: number
  end: number
  request: string
}

interface ModuleSpecifier {
  start: number
  end: number
  request: string
}

const ASSET_REQUEST =
  /^(?:(?:\/(?:dev|skills)\/|\.\.?\/|assets\/)[^"'`$?#]+\.(?:avif|basis|bin|exr|gif|glb|gltf|hdr|jpe?g|ktx2|png|webp)|\/(?:dev|skills)\/[^"'`$?#]+\/assets\/[^"'`$?#]+)(?:[?#][^"'`\s]*)?$/i
const PINNED_THREE_RUNTIME_ASSET_DIRECTORIES = new Map<string, readonly string[]>([
  [
    '/node_modules/three/examples/jsm/libs/draco/',
    ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'],
  ],
  [
    '/node_modules/three/examples/jsm/libs/draco/gltf/',
    ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'],
  ],
  [
    '/node_modules/three/examples/jsm/libs/basis/',
    ['basis_transcoder.js', 'basis_transcoder.wasm'],
  ],
])
const allPinnedThreeRuntimeAssetPaths = [...new Set(
  [...PINNED_THREE_RUNTIME_ASSET_DIRECTORIES].flatMap(([directory, files]) => (
    files.map(file => `${directory.slice(1)}${file}`)
  )),
)]
const pinnedThreeRuntimeAssets = new Map<string, Promise<BuildFile>>()

export function pinnedThreeRuntimeAssetPaths(request: string): string[] {
  const clean = request.replace(/[?#].*$/, '')
  const files = PINNED_THREE_RUNTIME_ASSET_DIRECTORIES.get(clean)
  return files === undefined ? [] : files.map(file => `${clean.slice(1)}${file}`)
}

async function loadPinnedThreeRuntimeAsset(path: string): Promise<BuildFile> {
  const pending = pinnedThreeRuntimeAssets.get(path) ?? (async () => {
    const suffix = path.slice('node_modules/three/'.length)
    const bytes = await readFile(join(threeRoot, ...suffix.split('/')))
    return {
      path,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: extname(path).toLowerCase() === '.wasm'
        ? 'application/wasm'
        : 'text/javascript',
      text: false,
    }
  })()
  pinnedThreeRuntimeAssets.set(path, pending)
  return pending
}

export async function pinnedThreeRuntimeAsset(
  sha256: string,
): Promise<BuildFile | undefined> {
  const assets = await Promise.all(
    allPinnedThreeRuntimeAssetPaths.map(loadPinnedThreeRuntimeAsset),
  )
  return assets.find(asset => asset.sha256 === sha256)
}

function scriptKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase()
  if (extension === '.json') return ts.ScriptKind.JSON
  if (extension === '.ts') return ts.ScriptKind.TS
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

function isDataKeyLiteral(node: ts.StringLiteralLike): boolean {
  let current: ts.Node = node
  while (current.parent !== undefined) {
    const parent = current.parent
    if ((parent as ts.Node & { name?: ts.Node }).name === current
      || ts.isComputedPropertyName(parent)
      || (ts.isElementAccessExpression(parent)
        && parent.argumentExpression === current)) return true
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false
    current = parent
  }
  return false
}

export function assetStringLiterals(
  source: string,
  path = 'workspace.js',
): AssetStringLiteral[] {
  const literals: AssetStringLiteral[] = []
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  )
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)
      && !isDataKeyLiteral(node)
      && !(ts.isNoSubstitutionTemplateLiteral(node)
        && ts.isTaggedTemplateExpression(node.parent))
      && (ASSET_REQUEST.test(node.text)
        || pinnedThreeRuntimeAssetPaths(node.text).length > 0)) {
      const start = node.getStart(file)
      literals.push({
        start,
        end: node.getEnd(),
        quote: source[start] ?? '"',
        request: node.text,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return literals
}

export function assetCssUrls(source: string): AssetCssUrl[] {
  const urls: AssetCssUrl[] = []
  const skipWhitespace = (start: number): number => {
    let next = start
    while (next < source.length) {
      while (/\s/.test(source[next] ?? '')) next += 1
      if (!source.startsWith('/*', next)) break
      const end = source.indexOf('*/', next + 2)
      if (end === -1) return source.length
      next = end + 2
    }
    return next
  }
  const readEscape = (start: number): { next: number; value: string } => {
    const tail = source.slice(start + 1)
    const hex = tail.match(/^[0-9a-f]{1,6}/i)?.[0]
    if (hex !== undefined) {
      let next = start + 1 + hex.length
      if (/\s/.test(source[next] ?? '')) next += 1
      const codePoint = Number.parseInt(hex, 16)
      return {
        next,
        value: codePoint === 0 || codePoint > 0x10ffff
          ? '\uFFFD'
          : String.fromCodePoint(codePoint),
      }
    }
    const escaped = source[start + 1]
    return escaped === undefined
      ? { next: source.length, value: '' }
      : { next: start + 2, value: escaped === '\n' ? '' : escaped }
  }
  let index = 0
  while (index < source.length) {
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) break
      index = end + 2
      continue
    }
    const quote = source[index]
    if (quote === '"' || quote === "'") {
      index += 1
      while (index < source.length && source[index] !== quote) {
        index = source[index] === '\\' ? readEscape(index).next : index + 1
      }
      index += 1
      continue
    }
    if (source.slice(index, index + 3).toLowerCase() !== 'url'
      || /[\w-]/.test(source[index - 1] ?? '')
      || /[\w-]/.test(source[index + 3] ?? '')) {
      index += 1
      continue
    }
    const start = index
    index = skipWhitespace(index + 3)
    if (source[index] !== '(') continue
    index = skipWhitespace(index + 1)
    let request = ''
    const valueQuote = source[index]
    if (valueQuote === '"' || valueQuote === "'") {
      index += 1
      while (index < source.length && source[index] !== valueQuote) {
        if (source[index] === '\\') {
          const escaped = readEscape(index)
          request += escaped.value
          index = escaped.next
        } else {
          request += source[index]
          index += 1
        }
      }
      if (source[index] !== valueQuote) break
      index = skipWhitespace(index + 1)
    } else {
      while (index < source.length && source[index] !== ')') {
        if (source.startsWith('/*', index)) {
          const end = source.indexOf('*/', index + 2)
          if (end === -1) {
            index = source.length
            break
          }
          request += ' '
          index = end + 2
        } else if (source[index] === '\\') {
          const escaped = readEscape(index)
          request += escaped.value
          index = escaped.next
        } else {
          request += source[index]
          index += 1
        }
      }
      request = request.trim()
    }
    if (source[index] !== ')') continue
    index += 1
    if (ASSET_REQUEST.test(request)) urls.push({ start, end: index, request })
  }
  return urls
}

function moduleSpecifierLiterals(source: string, path: string): ModuleSpecifier[] {
  const specifiers: ModuleSpecifier[] = []
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  )
  const add = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      specifiers.push({
        start: node.getStart(file),
        end: node.getEnd(),
        request: node.text,
      })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

export function moduleSpecifiers(source: string, path = 'workspace.js'): string[] {
  return [...new Set(
    moduleSpecifierLiterals(source, path).map(specifier => specifier.request),
  )]
}

function moduleSpecifierRanges(source: string, path: string): Array<[number, number]> {
  return moduleSpecifierLiterals(source, path)
    .map(specifier => [specifier.start, specifier.end])
}

class GeneratedSourceLimitError extends Error {}

function assetAlias(importer: string, request: string, length = request.length): string {
  const hash = createHash('sha256')
    .update(`${importer}\0${request}`)
    .digest('base64url')
  return `~${hash.repeat(Math.ceil(length / hash.length)).slice(0, length - 1)}`
}

function assetLiteralAlias(
  importer: string,
  request: string,
  raw: string,
): { source: string; value: string } {
  const continuations = new Map<number, string>()
  let valueLength = raw.length
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\\') continue
    const next = raw[index + 1]
    const length = next === '\r' && raw[index + 2] === '\n'
      ? 3
      : next === '\n' || next === '\r' || next === '\u2028' || next === '\u2029'
        ? 2
        : 0
    if (length === 0) continue
    continuations.set(index, raw.slice(index, index + length))
    valueLength -= length
    index += length - 1
  }
  const value = assetAlias(importer, request, valueLength)
  let source = ''
  let valueOffset = 0
  for (let index = 0; index < raw.length;) {
    const continuation = continuations.get(index)
    if (continuation !== undefined) {
      source += continuation
      index += continuation.length
    } else {
      source += value[valueOffset]
      valueOffset += 1
      index += 1
    }
  }
  return { source, value }
}

interface RuntimeAssets {
  aliases: Array<[string, string]>
  css: Array<[string, string]>
  inline: Array<[string, string, string]>
}

function runtimeAssets(files: Map<string, BuildFile>): RuntimeAssets {
  const aliases = new Map<string, string>()
  const css = new Map<string, string>()
  const inline = new Map<string, [string, string]>()
  for (const file of files.values()) {
    if (file.text) continue
    const path = `/${file.path}`
    aliases.set(path, file.sha256)
    css.set(cssAssetVariable(file.path), file.sha256)
    if (file.bytes.byteLength <= MAX_INLINE_ASSET_BYTES) {
      inline.set(
        file.sha256,
        [file.mediaType, Buffer.from(file.bytes).toString('base64')],
      )
    }
  }
  for (const file of files.values()) {
    if (!file.text
      || !rewritesAssetLiterals(file.path)
      || extname(file.path).toLowerCase() === '.css') continue
    const source = new TextDecoder().decode(file.bytes)
    const ranges = moduleSpecifierRanges(source, file.path)
    for (const literal of assetStringLiterals(source, file.path)) {
      if (ranges.some(([start, end]) => literal.start >= start && literal.start < end)) continue
      const request = literal.request
      const path = workspacePath(request.split(/[?#]/, 1)[0]!, file.path, files)
      const asset = path === undefined ? undefined : files.get(path)
      if (asset !== undefined && !asset.text) {
        const alias = assetLiteralAlias(
          file.path,
          request,
          source.slice(literal.start + 1, literal.end - 1),
        )
        aliases.set(alias.value, asset.sha256)
      }
    }
  }
  return {
    aliases: [...aliases],
    css: [...css],
    inline: [...inline].map(([hash, [mediaType, base64]]) => [hash, mediaType, base64]),
  }
}

async function addPinnedThreeRuntimeAssets(files: Map<string, BuildFile>): Promise<void> {
  const paths = new Set<string>()
  for (const file of files.values()) {
    if (!file.text || !rewritesAssetLiterals(file.path)) continue
    const source = new TextDecoder().decode(file.bytes)
    for (const literal of assetStringLiterals(source, file.path)) {
      for (const path of pinnedThreeRuntimeAssetPaths(literal.request)) paths.add(path)
    }
  }
  for (const path of paths) {
    if (files.has(path)) continue
    files.set(path, await loadPinnedThreeRuntimeAsset(path))
  }
}

function cssAssetVariable(path: string): string {
  return `--threejs-editor-asset-${createHash('sha256').update(path).digest('hex')}`
}

function rewriteAssetUrls(
  source: string,
  importer: string,
  files: Map<string, BuildFile>,
): string {
  const css = extname(importer).toLowerCase() === '.css'
  if (css) {
    let rewritten = ''
    let offset = 0
    for (const asset of assetCssUrls(source)) {
      const path = workspacePath(asset.request.split(/[?#]/, 1)[0]!, importer, files)
      const file = path === undefined ? undefined : files.get(path)
      if (file === undefined || file.text) continue
      const variable = cssAssetVariable(file.path)
      rewritten += source.slice(offset, asset.start)
        + `var(${variable})`
      offset = asset.end
    }
    rewritten += source.slice(offset)
    return rewritten
  }
  const ranges = moduleSpecifierRanges(source, importer)
  let rewritten = ''
  let offset = 0
  for (const literal of assetStringLiterals(source, importer)) {
    if (ranges.some(([start, end]) => literal.start >= start && literal.start < end)) continue
    const path = workspacePath(
      literal.request.split(/[?#]/, 1)[0]!,
      importer,
      files,
    )
    const file = path === undefined ? undefined : files.get(path)
    if (file === undefined || file.text) continue
    const alias = assetLiteralAlias(
      importer,
      literal.request,
      source.slice(literal.start + 1, literal.end - 1),
    )
    rewritten += source.slice(offset, literal.start)
      + literal.quote
      + alias.source
      + literal.quote
    offset = literal.end
  }
  return rewritten + source.slice(offset)
}

function runtimeSource(input: BuildWorkspaceInput, files: Map<string, BuildFile>): string {
  const threeSpecifier = input.backend === 'webgpu' ? 'three/webgpu' : 'three'
  const assets = runtimeAssets(files)
  return [
    `import * as THREE from ${JSON.stringify(threeSpecifier)}`,
    'import { OrbitControls } from "three/addons/controls/OrbitControls.js"',
    'import { TransformControls } from "three/addons/controls/TransformControls.js"',
    files.has(WORKSPACE_EDITOR_STATE_PATH)
      ? `import editorState from ${JSON.stringify(`/${WORKSPACE_EDITOR_STATE_PATH}`)}`
      : 'const editorState = { schemaVersion: 1, operations: [] }',
    `const assetAliases = new Map(${JSON.stringify(assets.aliases)})`,
    `const assetCss = new Map(${JSON.stringify(assets.css)})`,
    'const assetData = globalThis.__THREEJS_EDITOR_ASSETS__',
    'if (!(assetData instanceof Map)) throw new Error("Runtime assets are unavailable")',
    ...assets.inline.length === 0
      ? []
      : [
          'const registerInlineAsset = globalThis.__THREEJS_EDITOR_REGISTER_INLINE_ASSET__',
          'if (typeof registerInlineAsset !== "function") throw new Error("Runtime asset registration is unavailable")',
          `for (const [hash, mediaType, base64] of ${JSON.stringify(assets.inline)}) registerInlineAsset(hash, mediaType, base64)`,
        ],
    'for (const [name, hash] of assetCss) {',
    '  const value = assetData.get(hash)',
    '  if (value !== undefined) document.documentElement.style.setProperty(name, `url(${JSON.stringify(value)})`)',
    '}',
    'const resolveAsset = path => {',
    '  const value = String(path)',
    '  const suffix = value.search(/[?#]/)',
    '  const key = suffix === -1 ? value : value.slice(0, suffix)',
    '  return assetData.get(assetAliases.get(key) ?? key) ?? value',
    '}',
    'THREE.DefaultLoadingManager.setURLModifier(resolveAsset)',
    `const { default: adapter } = await import(${JSON.stringify(`/${input.entry}`)})`,
    'export { adapter, THREE, OrbitControls, TransformControls, editorState, resolveAsset }',
  ].join('\n')
}

function vfsPlugin(input: BuildWorkspaceInput, files: Map<string, BuildFile>): Plugin {
  const runtime = runtimeSource(input, files)
  const contents = new Map<string, string | Uint8Array>()
  let generatedBytes = Buffer.byteLength(runtime)
  if (generatedBytes > MAX_GENERATED_SOURCE_BYTES) {
    throw new GeneratedSourceLimitError('generated build input exceeds 64 MiB')
  }
  for (const file of files.values()) {
    const content = file.text
      ? rewritesAssetLiterals(file.path)
        ? rewriteAssetUrls(new TextDecoder().decode(file.bytes), file.path, files)
        : file.bytes
      : `export default globalThis.__THREEJS_EDITOR_ASSETS__.get(${JSON.stringify(file.sha256)})`
    contents.set(file.path, content)
    generatedBytes += typeof content === 'string'
      ? Buffer.byteLength(content)
      : file.bytes.byteLength
    if (generatedBytes > MAX_GENERATED_SOURCE_BYTES) {
      throw new GeneratedSourceLimitError('generated build input exceeds 64 MiB')
    }
  }
  return {
    name: 'threejs-editor-vfs',
    setup(builder) {
      builder.onResolve({ filter: /^three(?:\/|$)/ }, args => {
        const path = dependencyPath(args.path)
        if (path === undefined) {
          return { errors: [{ text: `unsupported Three.js import ${JSON.stringify(args.path)}` }] }
        }
        return { path }
      })
      builder.onResolve({
        filter: /^(?:@petamoriken\/float16|astronomy-engine|postprocessing|three-stdlib)$/,
      }, args => {
        if (args.namespace !== workspaceNamespace && args.namespace !== runtimeNamespace) {
          return undefined
        }
        return { path: dependencyEntries.get(args.path) }
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
              text: `dependency ${JSON.stringify(args.path)} is not in the pinned M9 profile`,
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
        contents: runtime,
        loader: 'js',
        resolveDir: '/',
      }))
      builder.onLoad({ filter: /.*/, namespace: workspaceNamespace }, args => {
        const file = files.get(args.path)
        if (file === undefined) return { errors: [{ text: `workspace module not found: ${args.path}` }] }
        return {
          contents: contents.get(args.path),
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
  const dependencyIndex = normalized.lastIndexOf('/node_modules/')
  if (dependencyIndex !== -1) {
    return `dependency://${normalized.slice(dependencyIndex + '/node_modules/'.length)}`
  }
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
  const dependencyIndex = normalized.lastIndexOf('/node_modules/')
  if (dependencyIndex !== -1) {
    return `dependency://${normalized.slice(dependencyIndex + '/node_modules/'.length)}`
  }
  if (normalized.includes('/.pnpm/three@')) {
    const nested = normalized.lastIndexOf('/node_modules/three/')
    if (nested !== -1) return `dependency://three/${normalized.slice(nested + 20)}`
  }
  return isAbsolute(source)
    ? `dependency://three/${basename(source)}`
    : normalized.replace(/^(\.\.\/)+/, '')
}

function sanitizeSourceMap(sourceMap: string, files: Map<string, BuildFile>): string {
  const parsed = JSON.parse(sourceMap) as {
    sourceRoot?: string
    sources?: string[]
    sourcesContent?: Array<string | null>
  }
  parsed.sourceRoot = ''
  if (Array.isArray(parsed.sources)) {
    parsed.sources = parsed.sources.map((source, index) => {
      const safe = safeSource(source)
      if (safe.startsWith('workspace:///') && Array.isArray(parsed.sourcesContent)) {
        const file = files.get(safe.slice('workspace:///'.length))
        if (file?.text) parsed.sourcesContent[index] = new TextDecoder().decode(file.bytes)
      }
      return safe
    })
  }
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
  await addPinnedThreeRuntimeAssets(files)
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
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
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
    const sourceMap = sanitizeSourceMap(rawSourceMap, files)
    return {
      ...base,
      status: 'ready',
      diagnostics: result.warnings.map(message => diagnostic(message, 'warning')),
      bundle,
      sourceMap,
      bundleBytes: Buffer.byteLength(bundle),
      sourceMapBytes: Buffer.byteLength(sourceMap),
      inputs: Object.keys(result.metafile.inputs).map(safeInput).sort(),
      assets: [...files.values()]
        .filter(file => !file.text)
        .map(file => ({
          path: file.path,
          sha256: file.sha256,
          size: file.bytes.byteLength,
          mediaType: file.mediaType,
          ...file.bytes.byteLength > MAX_INLINE_ASSET_BYTES ? { external: true as const } : {},
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }
  } catch (error) {
    if (error instanceof GeneratedSourceLimitError) {
      return {
        ...base,
        status: 'failed',
        diagnostics: [{
          severity: 'error',
          message: error.message,
        }],
      }
    }
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

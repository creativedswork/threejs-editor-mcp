import { App } from '@modelcontextprotocol/ext-apps'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  TransformControls,
  type TransformControlsMode,
} from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {
  applyOfficialEditorCommands,
  editorProjectFromSnapshots,
  officialCommandProof,
  type EditorCommandOperation,
  type EditorObjectSnapshot,
  type OfficialCommandProof,
} from './official-editor.js'
import {
  M5_COMMAND_PROOF_RESOURCE_URI,
  M5_RUNTIME_RESOURCE_URI,
  type M5RuntimeManifest,
} from './m5-runtime.js'
import {
  M7_RUNTIME_CHANNEL,
  WORKSPACE_EDITOR_STATE_PATH,
  m7BootstrapHtml,
  type M7RuntimeEvent,
  type PointerPickGesture,
  shouldPickAfterPointerGesture,
} from './m7-runtime.js'

type LayoutPreset = 'classic' | 'wide' | 'compact'
type CameraView = 'broadcast' | 'overhead' | 'courtside'
type Axis = 'x' | 'y' | 'z'
type VectorProperty = 'position' | 'rotation' | 'scale'
type AssetMediaType = 'model/gltf-binary' | 'image/png' | 'image/jpeg'
type NavigationTab = 'scene' | 'files'

interface WorkspaceFile {
  path: string
  sha256: string
  size: number
  mediaType: string
  text: boolean
}

type WorkspaceParameter =
  | {
      id: string
      label: string
      type: 'boolean'
      path: string
      key: string
    }
  | {
      id: string
      label: string
      type: 'number'
      path: string
      key: string
      min: number
      max: number
      step: number
    }

interface WorkspaceView {
  kind: 'linked-workspace' | 'managed-workspace'
  entry: string
  backend: 'webgl' | 'webgpu' | 'raw-webgpu'
  debugModes: string[]
  parameters: WorkspaceParameter[]
  files: WorkspaceFile[]
}

interface EditorState {
  layout: LayoutPreset
  cameraView: CameraView
  operations: string[]
}

interface Project {
  schemaVersion: 1
  title: string
  scene: Record<string, unknown>
  camera: Record<string, unknown>
  renderer: {
    antialias: boolean
    shadows: boolean
  }
  script: {
    source: string
  }
  editor?: EditorState
}

interface RemoteSnapshot {
  project: Project
  revision: string
  workspace?: WorkspaceView
  editorOperations?: EditorCommandOperation[]
}

interface HistoryEntry {
  project: Project
  pendingOperations: string[]
  editorOperations: EditorCommandOperation[]
}

interface RuntimeInput {
  keys: Set<string>
  pointer: {
    x: number
    y: number
    buttons: Set<number>
  }
}

interface RuntimeContext {
  THREE: typeof THREE
  scene: THREE.Scene
  camera: THREE.Camera
  renderer: THREE.WebGLRenderer
  input: RuntimeInput
}

interface GameLifecycle {
  start?: (context: RuntimeContext) => void
  update?: (context: RuntimeContext, delta: number) => void
  dispose?: (context: RuntimeContext) => void
}

interface M5RuntimeEvent {
  channel: 'threejs-editor-m5-runtime'
  runId: string
  nonce: string
  type: string
  data?: Record<string, unknown>
}

interface M7Run {
  projectId: string
  revision: string
  runId: string
  nonce: string
}

interface M7StartingRun {
  run: M7Run
  controller: AbortController
  runSent: boolean
}

interface M7EditorSceneReport {
  run: M7Run
  promise: Promise<void>
  error?: string
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) throw new Error(`threejs editor M4 view is missing ${selector}`)
  return element
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function vector3(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    ? value as [number, number, number]
    : undefined
}

function editorObjectSnapshot(value: unknown): EditorObjectSnapshot | undefined {
  const object = record(value)
  const position = vector3(object?.position)
  const rotationDegrees = vector3(object?.rotationDegrees)
  const scale = vector3(object?.scale)
  if (object === undefined
    || typeof object.uuid !== 'string'
    || typeof object.path !== 'string'
    || typeof object.name !== 'string'
    || typeof object.type !== 'string'
    || typeof object.visible !== 'boolean'
    || position === undefined
    || rotationDegrees === undefined
    || scale === undefined
    || !Array.isArray(object.commands)
    || !object.commands.every(command => typeof command === 'string')) {
    return undefined
  }
  return {
    uuid: object.uuid,
    ...typeof object.parentUuid === 'string' ? { parentUuid: object.parentUuid } : {},
    path: object.path,
    name: object.name,
    type: object.type,
    visible: object.visible,
    position,
    rotationDegrees,
    scale,
    ...typeof object.color === 'string' ? { color: object.color } : {},
    commands: object.commands as EditorCommandOperation['type'][],
  }
}

function editorCommandOperation(value: unknown): EditorCommandOperation | undefined {
  const operation = record(value)
  if (operation === undefined || typeof operation.objectUuid !== 'string') return undefined
  if (operation.type === 'set_position'
    || operation.type === 'set_rotation'
    || operation.type === 'set_scale') {
    const value = vector3(operation.value)
    return value === undefined
      ? undefined
      : { type: operation.type, objectUuid: operation.objectUuid, value }
  }
  if (operation.type === 'set_name' && typeof operation.value === 'string') {
    return { type: operation.type, objectUuid: operation.objectUuid, value: operation.value }
  }
  if (operation.type === 'set_visible' && typeof operation.value === 'boolean') {
    return { type: operation.type, objectUuid: operation.objectUuid, value: operation.value }
  }
  if (operation.type === 'set_material_color' && typeof operation.value === 'string') {
    return { type: operation.type, objectUuid: operation.objectUuid, value: operation.value }
  }
  if (operation.type === 'set_material_value'
    && operation.property === 'roughness'
    && typeof operation.value === 'number') {
    return {
      type: operation.type,
      objectUuid: operation.objectUuid,
      property: operation.property,
      value: operation.value,
    }
  }
  return undefined
}

function cloneProject(project: Project): Project {
  return structuredClone(project)
}

function resultError(result: CallToolResult): string {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n') || 'MCP tool failed'
}

function defaultEditor(): EditorState {
  return {
    layout: 'classic',
    cameraView: 'broadcast',
    operations: [],
  }
}

function runtimeMessage(error: unknown): string {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 2_000)
}

function assetMediaType(file: File): AssetMediaType {
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0]
  if (extension === '.glb') return 'model/gltf-binary'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  throw new Error('Only GLB, PNG, and JPEG assets are supported')
}

function safeAssetName(file: File): string {
  const lower = file.name.toLowerCase()
  const extension = lower.match(/\.(?:glb|png|jpe?g)$/)?.[0]
  if (extension === undefined) throw new Error('Asset file extension is required')
  const base = lower.slice(0, -extension.length)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 128 - extension.length) || 'asset'
  return `${base}${extension}`
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

function runtimeContext(): RuntimeContext {
  return {
    THREE,
    scene,
    camera,
    renderer,
    input: runtimeInput,
  }
}

function compileLifecycle(source: string): GameLifecycle {
  const candidate = Function('THREE', `"use strict";\n${source}`)(THREE) as unknown
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('game script must return a lifecycle object')
  }
  const lifecycle = candidate as GameLifecycle
  for (const method of ['start', 'update', 'dispose'] as const) {
    if (lifecycle[method] !== undefined && typeof lifecycle[method] !== 'function') {
      throw new Error(`${method} must be a function`)
    }
  }
  return lifecycle
}

const root = required<HTMLElement>('[data-three-editor]')
const viewport = required<HTMLElement>('[data-viewport]')
const canvas = required<HTMLCanvasElement>('[data-three-canvas]')
const runtimeFrame = required<HTMLIFrameElement>('[data-runtime-sandbox]')
const title = required<HTMLInputElement>('[data-title]')
const revisionOutput = required<HTMLOutputElement>('[data-revision]')
const undo = required<HTMLButtonElement>('[data-undo]')
const redo = required<HTMLButtonElement>('[data-redo]')
const importAssetButton = required<HTMLButtonElement>('[data-import]')
const assetInput = required<HTMLInputElement>('[data-asset-input]')
const exportProjectButton = required<HTMLButtonElement>('[data-export]')
const play = required<HTMLButtonElement>('[data-play]')
const stop = required<HTMLButtonElement>('[data-stop]')
const runtimeDebug = required<HTMLSelectElement>('[data-runtime-debug]')
const fullscreen = required<HTMLButtonElement>('[data-fullscreen]')
const save = required<HTMLButtonElement>('[data-save]')
const hierarchy = required<HTMLUListElement>('[data-hierarchy]')
const sceneSearch = required<HTMLInputElement>('[data-scene-search]')
const revealSelection = required<HTMLButtonElement>('[data-reveal-selection]')
const fileTree = required<HTMLUListElement>('[data-file-tree]')
const fileWorkspace = required<HTMLElement>('[data-file-workspace]')
const filePath = required<HTMLElement>('[data-file-path]')
const fileSource = required<HTMLTextAreaElement>('[data-file-source]')
const status = required<HTMLElement>('[data-status]')
const conflict = required<HTMLElement>('[data-conflict]')
const loadExternal = required<HTMLButtonElement>('[data-load-external]')
const saveCopy = required<HTMLButtonElement>('[data-save-copy]')
const layout = required<HTMLSelectElement>('[data-layout]')
const cameraViewSelect = required<HTMLSelectElement>('[data-camera-view]')
const inspectorEmpty = required<HTMLElement>('[data-inspector-empty]')
const inspectorFields = required<HTMLFieldSetElement>('[data-inspector-fields]')
const objectName = required<HTMLInputElement>('[data-object-name]')
const objectVisible = required<HTMLInputElement>('[data-object-visible]')
const materialRow = required<HTMLElement>('[data-material-row]')
const materialColor = required<HTMLInputElement>('[data-material-color]')
const inspectorPane = required<HTMLElement>('[data-inspector-pane]')
const scriptPane = required<HTMLElement>('[data-script-pane]')
const scriptSource = required<HTMLTextAreaElement>('[data-script-source]')
const runtimeOutput = required<HTMLElement>('[data-runtime-output]')
const runtimeParameters = required<HTMLElement>('[data-runtime-parameters]')
const parameterList = required<HTMLElement>('[data-parameter-list]')
const vectorInputs = [...document.querySelectorAll<HTMLInputElement>('[data-vector][data-axis]')]
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')]
const detailTabs = [...document.querySelectorAll<HTMLButtonElement>('[data-detail-tab]')]
const navigationTabs = [...document.querySelectorAll<HTMLButtonElement>('[data-navigation-tab]')]

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.shadowMap.type = THREE.PCFShadowMap
root.dataset.webgl = renderer.getContext().isContextLost() ? 'false' : 'true'

let scene = new THREE.Scene()
let camera: THREE.Camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
let orbit: OrbitControls | undefined
let transform: TransformControls | undefined
let transformHelper: THREE.Object3D | undefined
let selected: THREE.Object3D | undefined
let projectId: string | undefined
let project: Project | undefined
let revision: string | undefined
let loadingId: string | undefined
let loadToken = 0
let remoteSnapshot: RemoteSnapshot | undefined
let workspace: WorkspaceView | undefined
let navigationTab: NavigationTab = 'scene'
let activeFile: string | undefined
let fileHistory: string[] = []
let fileHistoryIndex = -1
let fileLoading = false
let fileLoadToken = 0
let layoutPreset: LayoutPreset = 'classic'
let cameraView: CameraView = 'broadcast'
let transformMode: TransformControlsMode = 'translate'
let baseOperations: string[] = []
let pendingOperations: string[] = []
let pendingEditorOperations: EditorCommandOperation[] = []
let history: HistoryEntry[] = []
let historyIndex = -1
let frame = 0
let animation = 0
let pollTimer: number | undefined
let pulling = false
let tearingDown = false
let pointerGesture: PointerPickGesture | undefined
let lifecycle: GameLifecycle | undefined
let playingProject: Project | undefined
let playingRevision: string | undefined
let runtimeErrors: string[] = []
let runtimeWarnings: string[] = []
let restoreConsoleWarn: (() => void) | undefined
let editorDisabled = true
let importedAssets: string[] = []
let m5ActiveRun: { runId: string; nonce: string } | undefined
let m5Manifest: M5RuntimeManifest | undefined
let m5ResourceReads = 0
let m5Events: M5RuntimeEvent[] = []
let m5Errors: string[] = []
let m5Ready: Record<string, unknown> | undefined
let m5ServerCommandProof: OfficialCommandProof | undefined
let m5MessagesAfterStop = 0
let m5FrameAtStop: number | undefined
let m7ActiveRun: M7Run | undefined
let m7StartingRun: M7StartingRun | undefined
let m7PendingStartController: AbortController | undefined
let m7StartToken = 0
let m7StartQueue = Promise.resolve()
let m7StartCompletion = Promise.resolve()
let m7Build: Record<string, unknown> | undefined
let m7Events: M7RuntimeEvent[] = []
let m7Errors: string[] = []
let m7Ready: Record<string, unknown> | undefined
let m7Metrics: Record<string, unknown> | undefined
let m7LastDispose: Record<string, unknown> | undefined
let m7MessagesAfterStop = 0
const m7DisposedRuns = new Set<string>()
const m7LifecycleControllers = new Set<AbortController>()
const m7LifecycleTasks = new Set<Promise<unknown>>()
const m7CleanupFailures: unknown[] = []
let m7EditorSceneAccepted = false
let m7EditorSceneReport: M7EditorSceneReport | undefined
let runtimeDebugMode = 'final'
let parameterDocuments = new Map<string, Record<string, unknown>>()
let parameterLoadToken = 0
const expandedObjects = new Set<string>()
const M7_REQUEST_TIMEOUT = 120_000
const M7_LIFECYCLE_TIMEOUT = 10_000

const loader = new THREE.ObjectLoader()
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
const runtimeTimer = new THREE.Timer()
runtimeTimer.connect(document)
const runtimeInput: RuntimeInput = {
  keys: new Set(),
  pointer: {
    x: 0,
    y: 0,
    buttons: new Set(),
  },
}

function isHelper(object: THREE.Object3D): boolean {
  return object === transformHelper || object.userData.editorHelper === true
}

function disposeScene(target: THREE.Scene): void {
  target.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) material.dispose()
  })
}

function disposeControls(): void {
  orbit?.dispose()
  orbit = undefined
  if (transform !== undefined) {
    transform.detach()
    transform.dispose()
  }
  if (transformHelper?.parent !== null) transformHelper?.removeFromParent()
  transform = undefined
  transformHelper = undefined
}

function editableMaterial(object: THREE.Object3D | undefined): (THREE.Material & {
  color: THREE.Color
  map?: THREE.Texture | null
}) | undefined {
  if (!(object instanceof THREE.Mesh)) return undefined
  const material = Array.isArray(object.material) ? object.material[0] : object.material
  if (material === undefined || !('color' in material) || !(material.color instanceof THREE.Color)) {
    return undefined
  }
  return material as THREE.Material & { color: THREE.Color }
}

function applyLayout(preset: LayoutPreset): void {
  scene.scale.x = preset === 'wide' ? 1.25 : preset === 'compact' ? 0.75 : 1
  scene.updateMatrixWorld(true)
}

function applyCameraView(view: CameraView): void {
  if (!(camera instanceof THREE.PerspectiveCamera)) return
  camera.up.set(0, 1, 0)
  if (view === 'overhead') {
    camera.up.set(0, 0, -1)
    camera.position.set(0, 13, 0.01)
    camera.fov = 42
  } else if (view === 'courtside') {
    camera.position.set(9.5, 4.5, 0)
    camera.fov = 50
  } else {
    camera.position.set(0, 8.2, 9.4)
    camera.fov = 45
  }
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  orbit?.target.set(0, 0, 0)
  orbit?.update()
}

function refreshModeButtons(): void {
  for (const button of modeButtons) {
    button.ariaPressed = String(button.dataset.mode === transformMode)
  }
}

function refreshHistoryButtons(): void {
  if (navigationTab === 'files') {
    undo.disabled = fileHistoryIndex <= 0
    redo.disabled = fileHistoryIndex < 0 || fileHistoryIndex >= fileHistory.length - 1
    return
  }
  undo.disabled = historyIndex <= 0
  redo.disabled = historyIndex < 0 || historyIndex >= history.length - 1
}

function refreshPlayButtons(): void {
  const playState = root.dataset.playState
  const active = playState === 'starting' || playState === 'playing' || playState === 'stopping'
  play.disabled = editorDisabled
    || active
    || navigationTab !== 'scene'
    || root.dataset.sync !== 'clean'
  stop.disabled = playState !== 'starting' && playState !== 'playing'
  runtimeDebug.disabled = workspace === undefined
    || playState === 'starting'
    || playState === 'stopping'
  importAssetButton.disabled = editorDisabled
    || active
    || navigationTab !== 'scene'
    || project === undefined
    || root.dataset.sync === 'loading'
    || root.dataset.sync === 'saving'
    || root.dataset.sync === 'conflict'
  exportProjectButton.disabled = editorDisabled
    || active
    || project === undefined
    || root.dataset.sync !== 'clean'
}

function refreshRuntimeDebugModes(): void {
  const modes = workspace?.debugModes ?? []
  runtimeDebug.replaceChildren(...modes.map(mode => {
    const option = document.createElement('option')
    option.value = mode
    option.textContent = mode
    return option
  }))
  runtimeDebug.hidden = workspace === undefined || modes.length === 0
  runtimeDebugMode = modes.includes(runtimeDebugMode) ? runtimeDebugMode : modes[0] ?? 'final'
  runtimeDebug.value = runtimeDebugMode
  runtimeDebug.disabled = workspace === undefined
  root.dataset.runtimeDebug = runtimeDebugMode
}

async function saveWorkspaceParameter(
  parameter: WorkspaceParameter,
  value: boolean | number,
): Promise<void> {
  if (projectId === undefined || revision === undefined || workspace === undefined) return
  const parameterDocument = parameterDocuments.get(parameter.path)
  if (parameterDocument === undefined) {
    throw new Error(`parameter document is unavailable: ${parameter.path}`)
  }
  const savedProjectId = projectId
  const savedRevision = revision
  const nextDocument = { ...parameterDocument, [parameter.key]: value }
  root.dataset.sync = 'saving'
  setEditorDisabled(true)
  status.textContent = `Saving ${parameter.label}`
  try {
    const result = await app.callServerTool({
      name: 'apply_project_files',
      arguments: {
        projectId: savedProjectId,
        baseRevision: savedRevision,
        changes: [{
          type: 'write',
          path: parameter.path,
          text: `${JSON.stringify(nextDocument, null, 2)}\n`,
        }],
      },
    })
    if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
    if (result.isError) throw new Error(resultError(result))
    const pulled = await app.callServerTool({
      name: 'pull_project',
      arguments: { projectId: savedProjectId },
    })
    if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
    const snapshot = snapshotFromResult(pulled)
    if (snapshot === undefined) throw new Error('saved parameter snapshot was not returned')
    parameterDocuments.set(parameter.path, nextDocument)
    setEditorDisabled(false)
    acceptSnapshot(
      snapshot.project,
      snapshot.revision,
      `Saved ${parameter.label}`,
      snapshot.workspace,
    )
  } catch (error) {
    if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
    root.dataset.sync = 'error'
    setEditorDisabled(false)
    throw error
  }
}

function renderWorkspaceParameters(): void {
  parameterList.replaceChildren()
  for (const parameter of workspace?.parameters ?? []) {
    const parameterDocument = parameterDocuments.get(parameter.path)
    const value = parameterDocument?.[parameter.key]
    const label = document.createElement('label')
    label.className = 'parameter-field'
    const caption = document.createElement('span')
    caption.textContent = parameter.label
    label.append(caption)
    if (parameter.type === 'boolean') {
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = value === true
      input.ariaLabel = parameter.label
      input.addEventListener('change', () => {
        input.disabled = true
        void saveWorkspaceParameter(parameter, input.checked).catch(error => {
          status.textContent = error instanceof Error ? error.message : String(error)
          input.disabled = false
        })
      })
      label.append(input)
    } else {
      const input = document.createElement('input')
      input.type = 'number'
      input.min = String(parameter.min)
      input.max = String(parameter.max)
      input.step = String(parameter.step)
      input.value = typeof value === 'number' ? String(value) : String(parameter.min)
      input.ariaLabel = parameter.label
      input.addEventListener('change', () => {
        const next = Number(input.value)
        if (!Number.isFinite(next) || next < parameter.min || next > parameter.max) {
          status.textContent = `${parameter.label} must be ${parameter.min} to ${parameter.max}`
          return
        }
        input.disabled = true
        void saveWorkspaceParameter(parameter, next).catch(error => {
          status.textContent = error instanceof Error ? error.message : String(error)
          input.disabled = false
        })
      })
      label.append(input)
    }
    parameterList.append(label)
  }
  runtimeParameters.hidden = workspace === undefined || workspace.parameters.length === 0
}

async function loadWorkspaceParameters(): Promise<void> {
  if (tearingDown) return
  const token = ++parameterLoadToken
  parameterDocuments = new Map()
  const parameters = workspace?.parameters ?? []
  const paths = [...new Set(parameters.map(parameter => parameter.path))]
  if (projectId === undefined || paths.length === 0) {
    renderWorkspaceParameters()
    return
  }
  const result = await app.callServerTool({
    name: 'read_project_files',
    arguments: {
      projectId,
      files: paths.map(path => ({ path })),
    },
  })
  if (tearingDown || token !== parameterLoadToken) return
  if (result.isError) throw new Error(resultError(result))
  const structured = record(result.structuredContent)
  const files = Array.isArray(structured?.files) ? structured.files.map(record) : []
  for (const file of files) {
    if (typeof file?.path !== 'string' || typeof file.text !== 'string') continue
    const parsed = JSON.parse(file.text) as unknown
    const document = record(parsed)
    if (document === undefined) throw new Error(`parameter file must be a JSON object: ${file.path}`)
    parameterDocuments.set(file.path, document)
  }
  renderWorkspaceParameters()
}

function refreshRuntimeOutput(): void {
  const lines = [
    ...runtimeErrors.map(error => `Error: ${error}`),
    ...runtimeWarnings.map(warning => `Warning: ${warning}`),
  ]
  runtimeOutput.textContent = lines.join('\n') || 'No Play diagnostics'
}

function setDetailTab(tab: 'inspector' | 'script'): void {
  inspectorPane.hidden = tab !== 'inspector'
  scriptPane.hidden = tab !== 'script'
  for (const button of detailTabs) {
    button.ariaSelected = String(button.dataset.detailTab === tab)
  }
}

function fileSummary(path: string | undefined): WorkspaceFile | undefined {
  return workspace?.files.find(file => file.path === path)
}

function renderFileTree(): void {
  fileTree.replaceChildren()
  for (const file of workspace?.files ?? []) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = file.path
    button.title = `${file.mediaType}, ${String(file.size)} bytes`
    button.ariaSelected = String(file.path === activeFile)
    button.addEventListener('click', () => {
      void selectWorkspaceFile(file.path)
    })
    item.append(button)
    fileTree.append(item)
  }
}

async function selectWorkspaceFile(path: string): Promise<void> {
  if (tearingDown
    || projectId === undefined
    || revision === undefined
    || workspace === undefined
    || fileLoading) return
  if (root.dataset.sync !== 'clean' && path !== activeFile) {
    status.textContent = 'Save or undo file changes before switching files'
    return
  }
  const summary = fileSummary(path)
  if (summary === undefined) return
  activeFile = path
  root.dataset.activeFile = path
  filePath.textContent = path
  renderFileTree()
  if (!summary.text) {
    fileSource.value = `Binary file: ${summary.mediaType}, ${String(summary.size)} bytes`
    fileSource.disabled = true
    fileHistory = []
    fileHistoryIndex = -1
    refreshHistoryButtons()
    status.textContent = 'Binary file is preserved but not editable'
    return
  }
  const selectedProjectId = projectId
  const selectedRevision = revision
  const token = ++fileLoadToken
  fileLoading = true
  fileSource.disabled = true
  status.textContent = `Loading ${path}`
  try {
    const result = await app.callServerTool({
      name: 'read_project_files',
      arguments: { projectId: selectedProjectId, files: [{ path }] },
    })
    if (token !== fileLoadToken
      || !savedStateIsCurrent(selectedProjectId, selectedRevision)
      || activeFile !== path) return
    if (result.isError) throw new Error(resultError(result))
    const structured = record(result.structuredContent)
    const files = Array.isArray(structured?.files) ? structured.files : []
    const first = record(files[0])
    if (typeof first?.text !== 'string') throw new Error('read_project_files returned invalid text')
    fileSource.value = first.text
    fileHistory = [first.text]
    fileHistoryIndex = 0
    fileSource.disabled = editorDisabled
    refreshHistoryButtons()
    status.textContent = `Editing ${path}`
  } finally {
    if (token === fileLoadToken) fileLoading = false
  }
}

function setNavigationTab(tab: NavigationTab, force = false): void {
  if (tab === 'files' && workspace === undefined) return
  if (!force && tab !== navigationTab && root.dataset.sync !== 'clean') {
    status.textContent = 'Save or undo changes before switching views'
    return
  }
  navigationTab = tab
  root.dataset.navigation = tab
  viewport.hidden = tab !== 'scene'
  fileWorkspace.hidden = tab !== 'files'
  hierarchy.hidden = tab !== 'scene'
  fileTree.hidden = tab !== 'files'
  for (const button of navigationTabs) {
    button.ariaSelected = String(button.dataset.navigationTab === tab)
  }
  if (tab === 'scene') {
    resizeRenderer()
  } else if (activeFile === undefined) {
    const first = workspace?.files.find(file => file.path === workspace?.entry && file.text)
      ?? workspace?.files.find(file => file.text)
      ?? workspace?.files[0]
    if (first !== undefined) void selectWorkspaceFile(first.path)
  }
  refreshHistoryButtons()
  refreshPlayButtons()
}

function setEditorDisabled(disabled: boolean): void {
  editorDisabled = disabled
  title.disabled = disabled
  layout.disabled = disabled
  cameraViewSelect.disabled = disabled
  inspectorFields.disabled = disabled
  scriptSource.disabled = disabled
  fileSource.disabled = disabled || fileSummary(activeFile)?.text !== true
  for (const input of parameterList.querySelectorAll<HTMLInputElement>('input')) {
    input.disabled = disabled
  }
  for (const button of modeButtons) button.disabled = disabled
  if (disabled) {
    undo.disabled = true
    redo.disabled = true
  } else {
    refreshHistoryButtons()
  }
  refreshPlayButtons()
}

function setClean(nextRevision: string): void {
  revision = nextRevision
  root.dataset.sync = 'clean'
  root.dataset.revision = nextRevision
  revisionOutput.textContent = nextRevision.slice(0, 12)
  save.disabled = true
  conflict.hidden = true
  remoteSnapshot = undefined
  refreshPlayButtons()
}

function markDirty(message = 'Unsaved changes'): void {
  if (root.dataset.sync !== 'conflict') root.dataset.sync = 'dirty'
  save.disabled = navigationTab === 'files'
    ? activeFile === undefined || fileSummary(activeFile)?.text !== true
    : title.value.trim() === ''
  refreshPlayButtons()
  status.textContent = message
}

function serializeProject(): Project {
  if (project === undefined) throw new Error('project is not loaded')
  const parent = transformHelper?.parent
  transformHelper?.removeFromParent()
  scene.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  const next: Project = {
    ...project,
    title: title.value.trim() || project.title,
    scene: scene.toJSON() as unknown as Record<string, unknown>,
    camera: camera.toJSON() as unknown as Record<string, unknown>,
    renderer: {
      ...project.renderer,
      shadows: renderer.shadowMap.enabled,
    },
    script: {
      source: scriptSource.value,
    },
    editor: {
      layout: layoutPreset,
      cameraView,
      operations: [...baseOperations, ...pendingOperations].slice(-50),
    },
  }
  if (parent !== null && parent !== undefined && transformHelper !== undefined) {
    parent.add(transformHelper)
  }
  return next
}

function commitHistory(operation: string): void {
  pendingOperations.push(operation)
  const nextProject = serializeProject()
  const current = history[historyIndex]
  if (current !== undefined
    && JSON.stringify(current.project) === JSON.stringify(nextProject)) {
    pendingOperations.pop()
    return
  }
  history = history.slice(0, historyIndex + 1)
  history.push({
    project: cloneProject(nextProject),
    pendingOperations: [...pendingOperations],
    editorOperations: [...pendingEditorOperations],
  })
  if (history.length > 50) history.shift()
  historyIndex = history.length - 1
  refreshHistoryButtons()
  markDirty(operation)
}

function commitOfficialOperation(
  operation: EditorCommandOperation,
  label: string,
): void {
  const baseline = history[historyIndex]
  if (baseline === undefined) return
  pendingOperations.push(label)
  if (workspace !== undefined) pendingEditorOperations.push(operation)
  const applied = applyOfficialEditorCommands(
    cloneProject(baseline.project),
    [operation],
  )
  root.dataset.lastOfficialCommands = applied.commandTypes.join(',')
  replaceRuntime(applied.project as Project)
  selectObject(scene.getObjectByProperty('uuid', operation.objectUuid))
  const nextProject = serializeProject()
  history = history.slice(0, historyIndex + 1)
  history.push({
    project: cloneProject(nextProject),
    pendingOperations: [...pendingOperations],
    editorOperations: [...pendingEditorOperations],
  })
  if (history.length > 50) history.shift()
  historyIndex = history.length - 1
  refreshHistoryButtons()
  markDirty(label)
}

function renderHierarchy(): void {
  hierarchy.replaceChildren()
  const query = sceneSearch.value.trim().toLowerCase()
  const matches = (object: THREE.Object3D): boolean => {
    if (query === '') return true
    return `${object.name} ${object.type}`.toLowerCase().includes(query)
      || object.children.some(child => !isHelper(child) && matches(child))
  }
  const add = (object: THREE.Object3D, parent: HTMLUListElement): void => {
    if (isHelper(object)) return
    if (!matches(object)) return
    const item = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'tree-row'
    const children = object.children.filter(child => !isHelper(child))
    if (children.length > 0) {
      const toggle = document.createElement('button')
      const expanded = query !== '' || expandedObjects.has(object.uuid)
      toggle.type = 'button'
      toggle.className = 'tree-toggle'
      toggle.textContent = expanded ? '⌄' : '›'
      toggle.ariaLabel = `${expanded ? 'Collapse' : 'Expand'} ${object.name || object.type}`
      toggle.addEventListener('click', () => {
        if (expandedObjects.has(object.uuid)) expandedObjects.delete(object.uuid)
        else expandedObjects.add(object.uuid)
        renderHierarchy()
      })
      row.append(toggle)
    } else {
      const spacer = document.createElement('span')
      spacer.className = 'tree-spacer'
      row.append(spacer)
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'tree-object'
    button.textContent = object.name || object.type
    button.title = `${object.type}: ${button.textContent}`
    button.ariaSelected = String(object === selected)
    button.dataset.objectUuid = object.uuid
    button.addEventListener('click', () => selectObject(object))
    row.append(button)
    item.append(row)
    if (children.length > 0 && (query !== '' || expandedObjects.has(object.uuid))) {
      const childList = document.createElement('ul')
      childList.className = 'tree-children'
      for (const child of children) add(child, childList)
      item.append(childList)
    }
    parent.append(item)
  }
  for (const child of scene.children) add(child, hierarchy)
  hierarchy.querySelector<HTMLButtonElement>('[aria-selected=true]')
    ?.scrollIntoView({ block: 'nearest' })
}

function refreshInspector(): void {
  const object = selected
  inspectorEmpty.hidden = object !== undefined
  inspectorFields.hidden = object === undefined
  if (object === undefined) return

  objectName.value = object.name
  objectVisible.checked = object.visible
  for (const input of vectorInputs) {
    const property = input.dataset.vector as VectorProperty
    const axis = input.dataset.axis as Axis
    const value = property === 'rotation'
      ? THREE.MathUtils.radToDeg(object.rotation[axis])
      : object[property][axis]
    input.value = value.toFixed(property === 'rotation' ? 1 : 2)
  }
  const material = editableMaterial(object)
  materialRow.hidden = material === undefined
  if (material !== undefined) materialColor.value = `#${material.color.getHexString()}`
}

function selectObject(object: THREE.Object3D | undefined, notifyRuntime = true): void {
  selected = object
  for (
    let parent = object?.parent;
    parent != null && parent !== scene;
    parent = parent.parent
  ) {
    expandedObjects.add(parent.uuid)
  }
  transform?.detach()
  if (object !== undefined && object !== scene && !isHelper(object)) transform?.attach(object)
  if (notifyRuntime && workspace !== undefined && m7ActiveRun !== undefined) {
    postM7('select-object', { objectUuid: object?.uuid })
  }
  renderHierarchy()
  refreshInspector()
  root.dataset.selected = object?.name ?? ''
}

function setupControls(): void {
  if (workspace !== undefined) return
  orbit = new OrbitControls(camera, canvas)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.target.set(0, 0, 0)
  orbit.update()

  transform = new TransformControls(camera, canvas)
  transform.setMode(transformMode)
  transform.setSize(0.78)
  transformHelper = transform.getHelper()
  transformHelper.userData.editorHelper = true
  scene.add(transformHelper)
  transform.addEventListener('dragging-changed', event => {
    if (orbit !== undefined) orbit.enabled = event.value !== true
  })
  transform.addEventListener('objectChange', () => {
    refreshInspector()
    markDirty('Transforming object')
  })
  transform.addEventListener('mouseUp', () => {
    if (selected === undefined) return
    const name = selected.name || selected.type
    if (transformMode === 'rotate') {
      commitOfficialOperation({
        type: 'set_rotation',
        objectUuid: selected.uuid,
        value: [
          THREE.MathUtils.radToDeg(selected.rotation.x),
          THREE.MathUtils.radToDeg(selected.rotation.y),
          THREE.MathUtils.radToDeg(selected.rotation.z),
        ],
      }, `Transformed ${name}`)
    } else {
      commitOfficialOperation({
        type: transformMode === 'scale' ? 'set_scale' : 'set_position',
        objectUuid: selected.uuid,
        value: (transformMode === 'scale'
          ? selected.scale.toArray()
          : selected.position.toArray()) as [number, number, number],
      }, `Transformed ${name}`)
    }
  })
}

function replaceRuntime(nextProject: Project): void {
  disposeControls()
  disposeScene(scene)

  const parsedScene = loader.parse(nextProject.scene)
  if (!(parsedScene instanceof THREE.Scene)) throw new Error('project scene is not a Three.js Scene')
  const parsedCamera = loader.parse(nextProject.camera)
  if (!(parsedCamera instanceof THREE.Camera)) throw new Error('project camera is not a Three.js Camera')

  scene = parsedScene
  camera = parsedCamera
  project = cloneProject(nextProject)
  title.value = nextProject.title
  scriptSource.value = nextProject.script.source
  const editor = nextProject.editor ?? defaultEditor()
  layoutPreset = editor.layout
  cameraView = editor.cameraView
  layout.value = layoutPreset
  cameraViewSelect.value = cameraView
  renderer.shadowMap.enabled = nextProject.renderer.shadows
  applyLayout(layoutPreset)
  applyCameraView(cameraView)
  setupControls()
  selectObject(undefined)
  resizeRenderer()
}

function updateRuntimeMirror(
  snapshot: EditorObjectSnapshot,
  refresh = true,
): void {
  const object = scene.getObjectByProperty('uuid', snapshot.uuid)
  if (object === undefined) return
  object.name = snapshot.name
  object.visible = snapshot.visible
  object.position.fromArray(snapshot.position)
  object.rotation.set(...snapshot.rotationDegrees.map(THREE.MathUtils.degToRad) as [
    number,
    number,
    number,
  ])
  object.scale.fromArray(snapshot.scale)
  const material = editableMaterial(object)
  if (material !== undefined && snapshot.color !== undefined) {
    material.color.set(snapshot.color)
  }
  object.updateMatrix()
  scene.updateMatrixWorld(true)
  if (selected?.uuid === object.uuid) {
    selected = object
    refreshInspector()
  }
  if (refresh) renderHierarchy()
}

function acceptRuntimeEditorScene(objects: EditorObjectSnapshot[], run: M7Run): void {
  if (tearingDown
    || project === undefined
    || revision === undefined
    || projectId !== run.projectId
    || revision !== run.revision) return
  const projected = editorProjectFromSnapshots(project as never, objects) as Project
  replaceRuntime(projected)
  pendingOperations = []
  pendingEditorOperations = []
  const baseline = serializeProject()
  history = [{
    project: cloneProject(baseline),
    pendingOperations: [],
    editorOperations: [],
  }]
  historyIndex = 0
  refreshHistoryButtons()
  const report: M7EditorSceneReport = {
    run,
    promise: Promise.resolve(),
  }
  m7EditorSceneReport = report
  report.promise = trackM7Lifecycle(app.callServerTool({
    name: 'report_editor_scene',
    arguments: {
      projectId: run.projectId,
      revision: run.revision,
      runId: run.runId,
      objects,
    },
  }, {
    timeout: M7_LIFECYCLE_TIMEOUT,
    maxTotalTimeout: M7_LIFECYCLE_TIMEOUT,
  }).then(result => {
    if (result.isError) throw new Error(resultError(result))
  }).catch(error => {
    report.error = runtimeMessage(error)
    if (!tearingDown && m7EditorSceneReport === report && m7RunIsCurrent(run)) {
      status.textContent = `Editor scene report failed: ${report.error}`
    }
    throw error
  }))
}

function previewRuntimeOperation(operation: EditorCommandOperation): void {
  if (workspace === undefined || m7ActiveRun === undefined) return
  postM7('apply-operation', { operation })
}

function syncRuntimeMirror(): void {
  if (workspace === undefined || m7ActiveRun === undefined) return
  const operations: EditorCommandOperation[] = []
  scene.traverse(object => {
    if (object === scene || isHelper(object)) return
    operations.push(
      {
        type: 'set_name',
        objectUuid: object.uuid,
        value: object.name || object.type,
      },
      {
        type: 'set_visible',
        objectUuid: object.uuid,
        value: object.visible,
      },
      {
        type: 'set_position',
        objectUuid: object.uuid,
        value: object.position.toArray(),
      },
      {
        type: 'set_rotation',
        objectUuid: object.uuid,
        value: [
          THREE.MathUtils.radToDeg(object.rotation.x),
          THREE.MathUtils.radToDeg(object.rotation.y),
          THREE.MathUtils.radToDeg(object.rotation.z),
        ],
      },
      {
        type: 'set_scale',
        objectUuid: object.uuid,
        value: object.scale.toArray(),
      },
    )
    const material = editableMaterial(object)
    if (material !== undefined) {
      operations.push({
        type: 'set_material_color',
        objectUuid: object.uuid,
        value: `#${material.color.getHexString()}`,
      })
    }
  })
  postM7('apply-operations', { operations })
}

function stopLocalRuntimeForSnapshot(): void {
  if (workspace !== undefined
    || (lifecycle === undefined && playingProject === undefined)) return
  try {
    lifecycle?.dispose?.(runtimeContext())
  } catch (error) {
    recordRuntimeError(error)
  }
  restoreConsoleWarn?.()
  restoreConsoleWarn = undefined
  lifecycle = undefined
  playingProject = undefined
  playingRevision = undefined
  runtimeInput.keys.clear()
  runtimeInput.pointer.buttons.clear()
  root.dataset.playState = 'stopped'
}

function acceptSnapshot(
  nextProject: Project,
  nextRevision: string,
  message: string,
  nextWorkspace?: WorkspaceView,
): void {
  if (tearingDown) return
  fileLoadToken += 1
  fileLoading = false
  stopLocalRuntimeForSnapshot()
  if (workspace !== undefined && nextWorkspace === undefined) {
    const token = ++m7StartToken
    cancelM7Start()
    root.dataset.playState = 'stopping'
    runtimeFrame.hidden = true
    refreshPlayButtons()
    const cleanup = m7StartQueue.then(async () => {
      if (token !== m7StartToken) return
      await stopM7Runtime(false)
      if (token === m7StartToken && workspace === undefined) {
        root.dataset.playState = 'stopped'
        refreshPlayButtons()
      }
    })
    m7StartCompletion = cleanup
    m7StartQueue = cleanup.catch(() => {})
    void cleanup.catch(error => {
      m7CleanupFailures.push(error)
      if (token === m7StartToken) {
        root.dataset.playState = 'error'
        refreshPlayButtons()
        status.textContent = `Runtime cleanup failed: ${runtimeMessage(error).split('\n')[0]}`
      }
    })
  }
  const previousFile = activeFile
  workspace = nextWorkspace
  refreshRuntimeDebugModes()
  const filesTab = navigationTabs.find(button => button.dataset.navigationTab === 'files')
  if (filesTab !== undefined) filesTab.hidden = workspace === undefined
  if (workspace === undefined) {
    activeFile = undefined
    fileHistory = []
    fileHistoryIndex = -1
    setNavigationTab('scene', true)
  } else {
    activeFile = workspace.files.some(file => file.path === previousFile)
      ? previousFile
      : undefined
    renderFileTree()
  }
  const editor = nextProject.editor ?? defaultEditor()
  baseOperations = [...editor.operations]
  pendingOperations = []
  pendingEditorOperations = []
  replaceRuntime(nextProject)
  const baseline = serializeProject()
  history = [{
    project: cloneProject(baseline),
    pendingOperations: [],
    editorOperations: [],
  }]
  historyIndex = 0
  refreshHistoryButtons()
  setEditorDisabled(false)
  setClean(nextRevision)
  status.textContent = message
  void loadWorkspaceParameters().catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error)
  })
  if (workspace !== undefined && navigationTab === 'files') {
    if (activeFile === undefined) setNavigationTab('files', true)
    else void selectWorkspaceFile(activeFile)
  }
  if (workspace !== undefined) {
    root.dataset.playState = 'starting'
    setEditorDisabled(true)
    const token = ++m7StartToken
    cancelM7Start()
    refreshPlayButtons()
    status.textContent = 'Preparing editable Workspace'
    void queueM7RuntimeStart(token, 'edit').catch(error => {
      if (token !== m7StartToken) return
      recordRuntimeError(error)
      root.dataset.playState = 'error'
      setEditorDisabled(false)
      refreshPlayButtons()
      status.textContent = `Editor Runtime error: ${runtimeMessage(error).split('\n')[0]}`
    })
  }
}

function showConflict(snapshot: RemoteSnapshot): void {
  remoteSnapshot = snapshot
  root.dataset.sync = 'conflict'
  conflict.hidden = false
  save.disabled = false
  saveCopy.hidden = snapshot.workspace !== undefined
  refreshPlayButtons()
  status.textContent = 'External revision conflicts with local edits'
}

function workspaceFromResult(value: unknown): WorkspaceView | undefined {
  const candidate = record(value)
  if (candidate === undefined
    || (candidate.kind !== 'linked-workspace' && candidate.kind !== 'managed-workspace')
    || typeof candidate.entry !== 'string'
    || (candidate.backend !== 'webgl'
      && candidate.backend !== 'webgpu'
      && candidate.backend !== 'raw-webgpu')
    || !Array.isArray(candidate.files)) return undefined
  const debugModes = Array.isArray(candidate.debugModes)
    && candidate.debugModes.every(mode => typeof mode === 'string' && mode !== '')
    ? [...new Set(candidate.debugModes as string[])]
    : ['final']
  const parameters = Array.isArray(candidate.parameters)
    ? candidate.parameters.map(record)
    : []
  if (parameters.some(parameter => parameter === undefined
    || typeof parameter.id !== 'string'
    || typeof parameter.label !== 'string'
    || (parameter.type !== 'boolean' && parameter.type !== 'number')
    || typeof parameter.path !== 'string'
    || typeof parameter.key !== 'string'
    || (parameter.type === 'number'
      && (typeof parameter.min !== 'number'
        || typeof parameter.max !== 'number'
        || typeof parameter.step !== 'number')))) {
    throw new Error('pull_project returned invalid Workspace parameters')
  }
  const files = candidate.files.map(record)
  if (files.some(file => file === undefined
    || typeof file.path !== 'string'
    || typeof file.sha256 !== 'string'
    || typeof file.size !== 'number'
    || typeof file.mediaType !== 'string'
    || typeof file.text !== 'boolean')) {
    throw new Error('pull_project returned an invalid workspace')
  }
  return {
    kind: candidate.kind,
    entry: candidate.entry,
    backend: candidate.backend,
    debugModes,
    parameters: parameters.map(parameter => (
      parameter?.type === 'number'
        ? {
            id: parameter.id as string,
            label: parameter.label as string,
            type: 'number',
            path: parameter.path as string,
            key: parameter.key as string,
            min: parameter.min as number,
            max: parameter.max as number,
            step: parameter.step as number,
          }
        : {
            id: parameter?.id as string,
            label: parameter?.label as string,
            type: 'boolean',
            path: parameter?.path as string,
            key: parameter?.key as string,
          }
    )),
    files: files.map(file => ({
      path: file?.path as string,
      sha256: file?.sha256 as string,
      size: file?.size as number,
      mediaType: file?.mediaType as string,
      text: file?.text as boolean,
    })),
  }
}

function snapshotFromResult(result: CallToolResult): RemoteSnapshot | undefined {
  if (result.isError) throw new Error(resultError(result))
  const structured = record(result.structuredContent)
  if (structured?.changed !== true) return undefined
  const candidate = record(structured.project)
  const nextRevision = structured.revision
  if (candidate === undefined || typeof nextRevision !== 'string') {
    throw new Error('pull_project returned an invalid snapshot')
  }
  const editorOperations = Array.isArray(structured.editorOperations)
    ? structured.editorOperations.map(editorCommandOperation)
    : undefined
  if (editorOperations?.some(operation => operation === undefined)) {
    throw new Error('pull_project returned invalid Editor operations')
  }
  return {
    project: candidate as unknown as Project,
    revision: nextRevision,
    workspace: workspaceFromResult(structured.workspace),
    ...editorOperations === undefined
      ? {}
      : { editorOperations: editorOperations as EditorCommandOperation[] },
  }
}

const app = new App(
  { name: 'Three.js Editor MCP', version: '0.1.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true, strict: true },
)

function setDisplayMode(mode: 'inline' | 'fullscreen'): void {
  document.documentElement.dataset.displayMode = mode
  root.dataset.displayMode = mode
  fullscreen.ariaLabel = mode === 'fullscreen' ? 'Exit fullscreen' : 'Enter fullscreen'
  fullscreen.title = fullscreen.ariaLabel
  fullscreen.textContent = mode === 'fullscreen' ? '×' : '⛶'
  window.setTimeout(resizeRenderer, 0)
}

async function requestDisplayMode(mode: 'inline' | 'fullscreen'): Promise<void> {
  const result = await app.requestDisplayMode({ mode })
  setDisplayMode(result.mode === 'fullscreen' ? 'fullscreen' : 'inline')
}

function m5BootstrapHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111a}
    canvas{display:block;width:100%;height:100%}
  </style>
</head>
<body>
  <canvas width="720" height="420" aria-label="M5 isolated runtime canvas"></canvas>
  <script>
  (() => {
    const channel = 'threejs-editor-m5-runtime'
    const canvas = document.querySelector('canvas')
    let active
    let urls = []

    const emit = (runId, nonce, type, data = {}) => {
      window.parent.postMessage({ channel, runId, nonce, type, data }, '*')
    }
    const message = error => error instanceof Error
      ? error.stack || error.message
      : String(error)
    const revoke = () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls = []
    }
    const stop = async (runId, nonce) => {
      let result = {}
      if (active && typeof active.dispose === 'function') {
        result = await active.dispose()
      }
      active = undefined
      revoke()
      emit(runId, nonce, 'disposed', result)
    }
    const link = manifest => {
      if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules)) {
        throw new Error('invalid M5 module manifest')
      }
      const byPath = new Map()
      for (const module of manifest.modules) {
        let source = module.source
        for (const dependency of module.dependencies) {
          const url = byPath.get(dependency.path)
          if (!url) throw new Error('unresolved module ' + dependency.path)
          source = source.split(dependency.token).join(url)
        }
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        urls.push(url)
        byPath.set(module.path, url)
      }
      const entry = byPath.get(manifest.entry)
      if (!entry) throw new Error('missing M5 entry module')
      return entry
    }

    window.addEventListener('error', event => {
      if (!active) return
      event.preventDefault()
      emit(active.runId, active.nonce, 'runtime-error', { message: event.message })
    })
    window.addEventListener('unhandledrejection', event => {
      if (!active) return
      event.preventDefault()
      emit(active.runId, active.nonce, 'unhandled-rejection', {
        message: message(event.reason),
      })
    })
    window.addEventListener('message', async event => {
      if (event.source !== window.parent) return
      const request = event.data
      if (!request || request.channel !== channel) return
      const { action, runId, nonce } = request
      if (action === 'run') {
        try {
          await stop(runId, nonce)
          const entry = link(request.manifest)
          const module = await import(entry)
          if (typeof module.start !== 'function') throw new Error('M5 entry must export start')
          active = { runId, nonce }
          const api = await module.start(canvas, (type, data) => emit(runId, nonce, type, data))
          active = { ...active, ...api }
          emit(runId, nonce, 'ready', api.ready)
        } catch (error) {
          revoke()
          emit(runId, nonce, 'build-error', { message: message(error) })
        }
        return
      }
      if (action === 'stop') {
        await stop(runId, nonce)
        return
      }
      if (!active || active.runId !== runId || active.nonce !== nonce) return
      if (action === 'trigger-unhandled') {
        active.triggerUnhandled?.()
      }
    })
  })()
  </script>
</body>
</html>`
}

function resourceText(result: ReadResourceResult, uri: string): string {
  const content = result.contents.find(item => item.uri === uri) ?? result.contents[0]
  if (content === undefined || !('text' in content) || typeof content.text !== 'string') {
    throw new Error(`resource ${uri} did not return text`)
  }
  return content.text
}

function waitForM5Event(type: string, runId: string, timeout = 8_000): Promise<M5RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', listener)
      reject(new Error(`timed out waiting for M5 ${type}`))
    }, timeout)
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== runtimeFrame.contentWindow) return
      const candidate = record(event.data)
      if (candidate?.channel !== 'threejs-editor-m5-runtime'
        || candidate.runId !== runId
        || candidate.type !== type) return
      window.clearTimeout(timer)
      window.removeEventListener('message', listener)
      resolve(event.data as M5RuntimeEvent)
    }
    window.addEventListener('message', listener)
  })
}

function postM5(action: string, payload: Record<string, unknown> = {}): void {
  if (m5ActiveRun === undefined || runtimeFrame.contentWindow === null) {
    throw new Error('M5 runtime is not active')
  }
  runtimeFrame.contentWindow.postMessage({
    channel: 'threejs-editor-m5-runtime',
    action,
    ...m5ActiveRun,
    ...payload,
  }, '*')
}

function loadM5Frame(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('M5 runtime frame load timed out')), 5_000)
    runtimeFrame.addEventListener('load', () => {
      window.clearTimeout(timer)
      resolve()
    }, { once: true })
    runtimeFrame.hidden = false
    runtimeFrame.srcdoc = m5BootstrapHtml()
  })
}

async function readM5Resources(): Promise<M5RuntimeManifest> {
  const [runtimeResource, proofResource] = await Promise.all([
    app.readServerResource({ uri: M5_RUNTIME_RESOURCE_URI }),
    app.readServerResource({ uri: M5_COMMAND_PROOF_RESOURCE_URI }),
  ])
  m5ResourceReads += 2
  const manifest = JSON.parse(resourceText(runtimeResource, M5_RUNTIME_RESOURCE_URI)) as unknown
  const candidate = record(manifest)
  if (candidate?.schemaVersion !== 1
    || typeof candidate.entry !== 'string'
    || !Array.isArray(candidate.modules)) {
    throw new Error('M5 runtime resource returned an invalid manifest')
  }
  m5ServerCommandProof = JSON.parse(
    resourceText(proofResource, M5_COMMAND_PROOF_RESOURCE_URI),
  ) as OfficialCommandProof
  const localProof = officialCommandProof()
  if (JSON.stringify(m5ServerCommandProof) !== JSON.stringify(localProof)) {
    throw new Error('Node and App official Command proofs differ')
  }
  return manifest as M5RuntimeManifest
}

async function stopIsolatedRuntime(): Promise<Record<string, unknown> | undefined> {
  if (m5ActiveRun === undefined) {
    runtimeFrame.hidden = true
    return undefined
  }
  const run = m5ActiveRun
  const disposed = waitForM5Event('disposed', run.runId)
  postM5('stop')
  const event = await disposed
  const frameValue = event.data?.frame
  m5FrameAtStop = typeof frameValue === 'number' ? frameValue : undefined
  m5ActiveRun = undefined
  runtimeFrame.hidden = true
  runtimeFrame.srcdoc = '<!doctype html><title>Stopped</title>'
  status.textContent = 'M5 Runtime stopped'
  return event.data
}

async function startIsolatedRuntime(
  transform?: (manifest: M5RuntimeManifest) => M5RuntimeManifest,
): Promise<Record<string, unknown>> {
  if (m5ActiveRun !== undefined) await stopIsolatedRuntime()
  m5Events = []
  m5Errors = []
  m5Ready = undefined
  m5MessagesAfterStop = 0
  m5FrameAtStop = undefined
  const manifest = structuredClone(await readM5Resources())
  m5Manifest = manifest
  const runId = crypto.randomUUID()
  m5ActiveRun = { runId, nonce: crypto.randomUUID() }
  await loadM5Frame()
  const result = waitForM5Event(transform === undefined ? 'ready' : 'build-error', runId)
  postM5('run', { manifest: transform?.(manifest) ?? manifest })
  const event = await result
  if (event.type === 'build-error') {
    const error = typeof event.data?.message === 'string' ? event.data.message : 'build error'
    m5Errors.push(error)
    status.textContent = 'M5 build error observed'
  } else {
    m5Ready = event.data ?? {}
    status.textContent = 'M5 isolated WebGL2 Runtime'
  }
  return event.data ?? {}
}

window.addEventListener('message', event => {
  if (event.source !== runtimeFrame.contentWindow) return
  const candidate = record(event.data)
  if (candidate?.channel !== 'threejs-editor-m5-runtime'
    || typeof candidate.runId !== 'string'
    || typeof candidate.nonce !== 'string'
    || typeof candidate.type !== 'string') return
  const runtimeEvent = event.data as M5RuntimeEvent
  if (m5ActiveRun === undefined) {
    m5MessagesAfterStop += 1
    return
  }
  if (runtimeEvent.runId !== m5ActiveRun.runId
    || runtimeEvent.nonce !== m5ActiveRun.nonce) return
  m5Events.push(runtimeEvent)
  if (runtimeEvent.type === 'frame' && typeof runtimeEvent.data?.frame === 'number') {
    root.dataset.m5Frame = String(runtimeEvent.data.frame)
  }
  if (runtimeEvent.type === 'runtime-error'
    || runtimeEvent.type === 'unhandled-rejection'
    || runtimeEvent.type === 'build-error') {
    const message = runtimeEvent.data?.message
    m5Errors.push(typeof message === 'string' ? message : runtimeEvent.type)
  }
})

function waitForM7Event(
  types: string[],
  run: M7Run,
  timeout = 120_000,
  signal?: AbortSignal,
  accept?: (event: M7RuntimeEvent) => boolean,
): Promise<M7RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer)
      window.removeEventListener('message', listener)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(new Error('M7 Runtime start cancelled'))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for M7 ${types.join(' or ')}`))
    }, timeout)
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== runtimeFrame.contentWindow) return
      const candidate = record(event.data)
      if (candidate?.channel !== M7_RUNTIME_CHANNEL
        || candidate.projectId !== run.projectId
        || candidate.runId !== run.runId
        || candidate.nonce !== run.nonce
        || candidate.revision !== run.revision
        || typeof candidate.type !== 'string'
        || !types.includes(candidate.type)) return
      const runtimeEvent = event.data as M7RuntimeEvent
      if (accept !== undefined && !accept(runtimeEvent)) return
      cleanup()
      resolve(runtimeEvent)
    }
    window.addEventListener('message', listener)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function sameM7Runtime(left: M7Run, right: M7Run): boolean {
  return left.projectId === right.projectId
    && left.runId === right.runId
    && left.nonce === right.nonce
}

function sameM7Run(left: M7Run, right: M7Run): boolean {
  return left.revision === right.revision && sameM7Runtime(left, right)
}

function m7RunIsCurrent(run: M7Run): boolean {
  return projectId === run.projectId && revision === run.revision
}

function savedStateIsCurrent(
  savedProjectId: string,
  savedRevision: string,
): boolean {
  return !tearingDown
    && projectId === savedProjectId
    && revision === savedRevision
}

async function setM7Mode(run: M7Run, mode: 'edit' | 'run'): Promise<void> {
  const changed = waitForM7Event(
    ['mode', 'runtime-error'],
    run,
    10_000,
    undefined,
    event => event.type === 'runtime-error' || event.data?.mode === mode,
  )
  postM7Run(run, 'set-mode', { mode })
  const event = await changed
  if (event.type === 'runtime-error') {
    throw new Error(typeof event.data?.message === 'string'
      ? event.data.message
      : 'Workspace Runtime mode change failed')
  }
}

function postM7Run(
  run: M7Run,
  action: string,
  payload: Record<string, unknown> = {},
): void {
  if (runtimeFrame.contentWindow === null) {
    throw new Error('M7 runtime is not active')
  }
  runtimeFrame.contentWindow.postMessage({
    channel: M7_RUNTIME_CHANNEL,
    action,
    ...run,
    ...payload,
  }, '*')
}

function postM7(action: string, payload: Record<string, unknown> = {}): void {
  if (m7ActiveRun === undefined) throw new Error('M7 runtime is not active')
  postM7Run(m7ActiveRun, action, payload)
}

function loadM7Frame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timer)
      runtimeFrame.removeEventListener('load', loaded)
      signal.removeEventListener('abort', aborted)
    }
    const loaded = (): void => {
      cleanup()
      resolve()
    }
    const aborted = (): void => {
      cleanup()
      reject(new Error('M7 Runtime start cancelled'))
    }
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('M7 runtime frame load timed out'))
    }, 5_000)
    runtimeFrame.addEventListener('load', loaded, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    runtimeFrame.hidden = false
    runtimeFrame.srcdoc = m7BootstrapHtml()
  })
}

function cancelM7Start(): void {
  const starting = m7StartingRun
  const pending = m7PendingStartController
  if (starting === undefined && pending === undefined) return
  m7StartingRun = undefined
  m7PendingStartController = undefined
  pending?.abort()
  starting?.controller.abort()
}

async function releaseM7Run(run: M7Run): Promise<void> {
  const result = await app.callServerTool({
    name: 'release_runtime_run',
    arguments: {
      projectId: run.projectId,
      revision: run.revision,
      runId: run.runId,
    },
  }, {
    timeout: M7_LIFECYCLE_TIMEOUT,
    maxTotalTimeout: M7_LIFECYCLE_TIMEOUT,
  })
  if (result.isError) throw new Error(resultError(result))
}

async function waitForM7EditorScene(run: M7Run): Promise<void> {
  const report = m7EditorSceneReport
  if (report === undefined || !sameM7Run(report.run, run)) {
    throw new Error('Runtime editor scene was not reported for this run')
  }
  await report.promise
  if (report.error !== undefined) throw new Error(report.error)
}

async function disposeM7Runtime(run: M7Run): Promise<Record<string, unknown> | undefined> {
  const disposed = waitForM7Event(['disposed'], run, 10_000)
  postM7Run(run, 'stop')
  const event = await disposed
  m7LastDispose = event.data
  if (typeof event.data?.disposeError === 'string') {
    throw new Error(`M7 Runtime teardown failed: ${event.data.disposeError}`)
  }
  return event.data
}

async function stopM7Runtime(
  invalidate = true,
): Promise<Record<string, unknown> | undefined> {
  if (invalidate) {
    m7StartToken += 1
    cancelM7Start()
  }
  if (m7ActiveRun === undefined) {
    runtimeFrame.hidden = true
    return undefined
  }
  const run = m7ActiveRun
  try {
    return await disposeM7Runtime(run)
  } finally {
    m7DisposedRuns.add(run.runId)
    if (m7ActiveRun === run) {
      m7ActiveRun = undefined
      runtimeFrame.hidden = true
      runtimeFrame.srcdoc = '<!doctype html><title>Stopped</title>'
    }
    await releaseM7Run(run)
  }
}

async function startM7Runtime(
  token: number,
  controller: AbortController,
  mode: 'edit' | 'run' = 'edit',
): Promise<void> {
  if (tearingDown || controller.signal.aborted) return
  if (projectId === undefined || revision === undefined || workspace === undefined) {
    throw new Error('Workspace is not ready')
  }
  const startProjectId = projectId
  const startRevision = revision
  const startWorkspace = workspace
  if (token !== m7StartToken) return
  if (m7ActiveRun !== undefined && !m7RunIsCurrent(m7ActiveRun)) {
    await stopM7Runtime(false)
  }
  if (token !== m7StartToken) return
  status.textContent = `Building ${startWorkspace.entry}`
  let buildResult
  try {
    buildResult = await app.callServerTool({
      name: 'build_project',
      arguments: { projectId: startProjectId, revision: startRevision },
    }, {
      signal: controller.signal,
      timeout: M7_REQUEST_TIMEOUT,
      maxTotalTimeout: M7_REQUEST_TIMEOUT,
    })
  } catch (error) {
    if (tearingDown || token !== m7StartToken || controller.signal.aborted) return
    throw error
  }
  if (tearingDown || token !== m7StartToken) return
  if (buildResult.isError) throw new Error(resultError(buildResult))
  const build = record(buildResult.structuredContent)
  m7Build = build
  const diagnostics = Array.isArray(build?.diagnostics)
    ? build.diagnostics.map(record).filter(item => item !== undefined)
    : []
  if (build?.status !== 'ready') {
    const first = diagnostics.find(item => item?.severity === 'error')
    const location = typeof first?.file === 'string'
      ? `${first.file}`
        + `${typeof first.line === 'number' ? `:${String(first.line)}` : ''}`
        + `${typeof first.column === 'number' ? `:${String(first.column)}` : ''}: `
      : ''
    throw new Error(`${location}${String(first?.message ?? 'Workspace build failed')}`)
  }
  if (typeof build.bundleUri !== 'string'
    || (build.backend !== 'webgl' && build.backend !== 'webgpu' && build.backend !== 'raw-webgpu')) {
    throw new Error('build_project returned invalid Runtime metadata')
  }
  let bundleResource
  try {
    bundleResource = await app.readServerResource({
      uri: build.bundleUri,
    }, {
      signal: controller.signal,
      timeout: M7_REQUEST_TIMEOUT,
      maxTotalTimeout: M7_REQUEST_TIMEOUT,
    })
  } catch (error) {
    if (tearingDown || token !== m7StartToken || controller.signal.aborted) return
    throw error
  }
  const bundle = resourceText(bundleResource, build.bundleUri)
  if (tearingDown || token !== m7StartToken) return
  await stopIsolatedRuntime()
  await stopM7Runtime(false)
  if (tearingDown || token !== m7StartToken) return

  m7Events = []
  m7Errors = []
  m7Ready = undefined
  m7Metrics = undefined
  m7MessagesAfterStop = 0
  m7EditorSceneAccepted = false
  const run: M7Run = {
    projectId: startProjectId,
    runId: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    revision: startRevision,
  }
  m7EditorSceneReport = undefined
  const starting: M7StartingRun = {
    run,
    controller,
    runSent: false,
  }
  m7StartingRun = starting
  let registrationStarted = false
  try {
    registrationStarted = true
    const registered = await app.callServerTool({
      name: 'register_runtime_run',
      arguments: {
        projectId: startProjectId,
        revision: startRevision,
        runId: run.runId,
      },
    }, {
      signal: controller.signal,
      timeout: M7_LIFECYCLE_TIMEOUT,
      maxTotalTimeout: M7_LIFECYCLE_TIMEOUT,
    })
    if (registered.isError) throw new Error(resultError(registered))
    if (token !== m7StartToken
      || starting.controller.signal.aborted
      || m7StartingRun !== starting) {
      throw new Error('M7 Runtime start cancelled')
    }
    await loadM7Frame(starting.controller.signal)
    const started = waitForM7Event(
      ['ready', 'runtime-error'],
      run,
      120_000,
      starting.controller.signal,
    )
    postM7Run(run, 'run', {
      bundle,
      backend: build.backend,
      debugMode: runtimeDebugMode,
      mode,
    })
    starting.runSent = true
    const event = await started
    if (token !== m7StartToken
      || starting.controller.signal.aborted
      || m7StartingRun !== starting) {
      throw new Error('M7 Runtime start cancelled')
    }
    if (event.type === 'runtime-error') {
      throw new Error(typeof event.data?.message === 'string'
        ? event.data.message
        : 'Workspace Runtime failed')
    }
    m7StartingRun = undefined
    m7ActiveRun = run
    m7Ready = event.data ?? {}
    m7Metrics = event.data ?? {}
    root.dataset.playState = mode === 'run' ? 'playing' : 'editing'
    setEditorDisabled(mode === 'run')
    refreshPlayButtons()
    status.textContent = mode === 'run'
      ? `${String(build.backend).toUpperCase()} Runtime`
      : `${String(build.backend).toUpperCase()} Edit`
  } catch (error) {
    const cancelled = token !== m7StartToken
      || starting.controller.signal.aborted
      || m7StartingRun !== starting
    if (m7StartingRun === starting) m7StartingRun = undefined
    starting.controller.abort()
    const cleanupErrors: unknown[] = []
    if (starting.runSent) {
      try {
        await disposeM7Runtime(run)
      } catch (disposeError) {
        cleanupErrors.push(disposeError)
      }
    }
    m7DisposedRuns.add(run.runId)
    runtimeFrame.hidden = true
    runtimeFrame.srcdoc = '<!doctype html><title>Stopped</title>'
    if (registrationStarted) {
      try {
        await releaseM7Run(run)
      } catch (releaseError) {
        cleanupErrors.push(releaseError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'M7 Runtime start cleanup failed',
      )
    }
    if (!cancelled) throw error
  }
}

function queueM7RuntimeStart(token: number, mode: 'edit' | 'run' = 'edit'): Promise<void> {
  if (tearingDown) return Promise.resolve()
  m7PendingStartController?.abort()
  const controller = new AbortController()
  m7PendingStartController = controller
  const scheduled = m7StartQueue.then(() => {
    if (m7CleanupFailures.length > 0) {
      throw new AggregateError(
        [...m7CleanupFailures],
        'Previous Runtime cleanup failed',
      )
    }
    return startM7Runtime(token, controller, mode)
  })
  const settled = scheduled.finally(() => {
    if (m7PendingStartController === controller) m7PendingStartController = undefined
  })
  m7StartCompletion = settled
  m7StartQueue = settled.catch(() => {})
  return settled
}

function waitForM7StartQueue(timeout = 10_000): Promise<void> {
  const completion = m7StartCompletion
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('M7 Runtime start cancellation timed out'))
    }, timeout)
    completion.then(() => {
      window.clearTimeout(timer)
      resolve()
    }, error => {
      window.clearTimeout(timer)
      reject(error)
    })
  })
}

async function failM7Runtime(run: M7Run, message: string): Promise<void> {
  if (tearingDown || m7ActiveRun === undefined || !sameM7Run(m7ActiveRun, run)) return
  const token = ++m7StartToken
  cancelM7Start()
  recordRuntimeError(message)
  playingProject = undefined
  playingRevision = undefined
  root.dataset.playState = 'stopping'
  setEditorDisabled(true)
  refreshPlayButtons()
  const teardown = m7StartQueue.then(async () => {
    if (m7ActiveRun !== undefined && sameM7Runtime(m7ActiveRun, run)) {
      await stopM7Runtime(false)
    }
  })
  m7StartCompletion = teardown
  m7StartQueue = teardown.catch(() => {})
  try {
    await teardown
  } catch (error) {
    recordRuntimeError(error)
  }
  if (token !== m7StartToken
    || projectId !== run.projectId
    || revision !== run.revision
    || m7ActiveRun !== undefined
    || m7StartingRun !== undefined) return
  root.dataset.playState = 'error'
  setEditorDisabled(false)
  refreshPlayButtons()
  status.textContent = `Runtime error: ${message.split('\n')[0]}`
}

window.addEventListener('message', event => {
  if (event.source !== runtimeFrame.contentWindow) return
  if (tearingDown) return
  const candidate = record(event.data)
  if (candidate?.channel !== M7_RUNTIME_CHANNEL
    || typeof candidate.projectId !== 'string'
    || typeof candidate.runId !== 'string'
    || typeof candidate.nonce !== 'string'
    || typeof candidate.revision !== 'string'
    || typeof candidate.type !== 'string') return
  const runtimeEvent = event.data as M7RuntimeEvent
  if (m7DisposedRuns.has(runtimeEvent.runId)) {
    m7MessagesAfterStop += 1
    return
  }
  const run = m7ActiveRun ?? m7StartingRun?.run
  if (run === undefined) {
    m7MessagesAfterStop += 1
    return
  }
  if (runtimeEvent.runId !== run.runId
    || runtimeEvent.projectId !== run.projectId
    || runtimeEvent.nonce !== run.nonce
    || runtimeEvent.revision !== run.revision
    || !m7RunIsCurrent(run)) return
  m7Events.push(runtimeEvent)
  if (runtimeEvent.type === 'ready') {
    m7Ready = runtimeEvent.data ?? {}
    m7Metrics = runtimeEvent.data ?? {}
  } else if (runtimeEvent.type === 'metrics' || runtimeEvent.type === 'frame') {
    m7Metrics = runtimeEvent.data ?? {}
  } else if (runtimeEvent.type === 'editor-scene') {
    const objects = Array.isArray(runtimeEvent.data?.objects)
      ? runtimeEvent.data.objects.map(editorObjectSnapshot)
      : []
    if (objects.every(object => object !== undefined)) {
      if (!m7EditorSceneAccepted) {
        m7EditorSceneAccepted = true
        acceptRuntimeEditorScene(objects as EditorObjectSnapshot[], run)
      } else {
        for (const object of objects as EditorObjectSnapshot[]) {
          updateRuntimeMirror(object, false)
        }
        renderHierarchy()
        refreshInspector()
      }
    }
  } else if (runtimeEvent.type === 'editor-object') {
    const object = editorObjectSnapshot(runtimeEvent.data?.object)
    if (object !== undefined) updateRuntimeMirror(object)
  } else if (runtimeEvent.type === 'editor-selection') {
    const uuid = runtimeEvent.data?.selectedUuid
    selectObject(
      typeof uuid === 'string'
        ? scene.getObjectByProperty('uuid', uuid)
        : undefined,
      false,
    )
  } else if (runtimeEvent.type === 'editor-commit') {
    const operation = editorCommandOperation(runtimeEvent.data?.operation)
    if (operation !== undefined) {
      const object = scene.getObjectByProperty('uuid', operation.objectUuid)
      commitOfficialOperation(
        operation,
        `Transformed ${object?.name || object?.type || 'Runtime object'}`,
      )
    }
  } else if (runtimeEvent.type === 'mode') {
    const mode = runtimeEvent.data?.mode
    if (mode === 'edit' || mode === 'run') {
      root.dataset.runtimeMode = mode
    }
  } else if (runtimeEvent.type === 'runtime-error') {
    const message = typeof runtimeEvent.data?.message === 'string'
      ? runtimeEvent.data.message
      : 'Workspace Runtime error'
    m7Errors.push(message)
    if (runtimeEvent.data?.fatal === true) {
      void failM7Runtime(run, message)
    } else if (root.dataset.playState === 'playing') {
      recordRuntimeError(message)
      void stopGame('Play failed').catch(handleStopFailure)
    }
  }
})

function recordRuntimeError(error: unknown): void {
  runtimeErrors = [...runtimeErrors, runtimeMessage(error)].slice(-20)
  refreshRuntimeOutput()
}

function recordRuntimeWarning(values: unknown[]): void {
  const message = values.map(value => typeof value === 'string' ? value : String(value))
    .join(' ')
    .slice(0, 2_000) || 'Runtime warning'
  runtimeWarnings = [
    ...runtimeWarnings,
    message,
  ].slice(-20)
  refreshRuntimeOutput()
}

function startGame(): void {
  if (project === undefined || revision === undefined || root.dataset.sync !== 'clean') {
    status.textContent = 'Save the project before Play'
    return
  }
  runtimeErrors = []
  runtimeWarnings = []
  refreshRuntimeOutput()
  if (workspace !== undefined) {
    playingProject = serializeProject()
    playingRevision = revision
    root.dataset.playState = 'starting'
    setEditorDisabled(true)
    save.disabled = true
    refreshPlayButtons()
    status.textContent = `Starting ${workspace.backend.toUpperCase()} Runtime`
    const token = ++m7StartToken
    void (async () => {
      if (m7ActiveRun !== undefined && !m7RunIsCurrent(m7ActiveRun)) {
        await stopM7Runtime(false)
      }
      if (token !== m7StartToken) return
      if (m7ActiveRun === undefined) {
        await queueM7RuntimeStart(token, 'run')
      } else {
        const run = m7ActiveRun
        await setM7Mode(run, 'run')
        if (token !== m7StartToken
          || m7ActiveRun === undefined
          || !sameM7Run(m7ActiveRun, run)
          || !m7RunIsCurrent(run)) return
        root.dataset.playState = 'playing'
        setEditorDisabled(true)
        refreshPlayButtons()
        status.textContent = `${workspace.backend.toUpperCase()} Runtime`
      }
    })().catch(async error => {
        if (token !== m7StartToken) return
        recordRuntimeError(error)
        await stopGame('Play failed', false)
      }).catch(handleStopFailure)
    return
  }
  playingProject = serializeProject()
  playingRevision = revision
  root.dataset.playState = 'playing'
  setEditorDisabled(true)
  save.disabled = true
  disposeControls()
  selected = undefined
  renderHierarchy()
  runtimeInput.keys.clear()
  runtimeInput.pointer.buttons.clear()
  const previousWarn = console.warn
  console.warn = (...values: unknown[]) => {
    recordRuntimeWarning(values)
    previousWarn(...values)
  }
  restoreConsoleWarn = () => {
    console.warn = previousWarn
  }
  runtimeTimer.reset()
  status.textContent = 'Playing'
  try {
    lifecycle = compileLifecycle(scriptSource.value)
    lifecycle.start?.(runtimeContext())
  } catch (error) {
    recordRuntimeError(error)
    void stopGame('Play failed').catch(handleStopFailure)
  }
}

async function stopGame(reason = 'Stopped', report = true): Promise<void> {
  if (root.dataset.playState !== 'starting' && root.dataset.playState !== 'playing') return
  const stopLoadToken = loadToken
  const stopProjectId = projectId
  const stopWorkspace = workspace
  const stopIsCurrent = (): boolean => (
    !tearingDown
      && loadToken === stopLoadToken
      && projectId === stopProjectId
  )
  const cancellingStart = root.dataset.playState === 'starting'
  if (cancellingStart) {
    m7StartToken += 1
    cancelM7Start()
  }
  root.dataset.playState = 'stopping'
  let startCleanupError: unknown
  if (cancellingStart) {
    try {
      await waitForM7StartQueue()
    } catch (error) {
      startCleanupError = error
      if (stopIsCurrent()) recordRuntimeError(error)
      else m7CleanupFailures.push(error)
    }
  }
  if (!stopIsCurrent()) return
  const testedRevision = playingRevision
  const diagnosticsRun = stopWorkspace !== undefined
    && m7ActiveRun !== undefined
    && m7RunIsCurrent(m7ActiveRun)
    ? m7ActiveRun
    : undefined
  const runId = diagnosticsRun?.runId
  if (stopWorkspace !== undefined) {
    try {
      if (m7ActiveRun !== undefined && !m7RunIsCurrent(m7ActiveRun)) {
        await stopM7Runtime(false)
      } else if (m7ActiveRun !== undefined) {
        await setM7Mode(m7ActiveRun, 'edit')
      }
    } catch (error) {
      if (!stopIsCurrent()) return
      recordRuntimeError(error)
      try {
        await stopM7Runtime(false)
      } catch (teardownError) {
        if (!stopIsCurrent()) {
          m7CleanupFailures.push(teardownError)
          return
        }
        recordRuntimeError(teardownError)
      }
    }
    if (!stopIsCurrent()) return
    playingProject = undefined
    playingRevision = undefined
    refreshRuntimeOutput()
  } else {
    try {
      lifecycle?.dispose?.(runtimeContext())
    } catch (error) {
      recordRuntimeError(error)
    }
    restoreConsoleWarn?.()
    restoreConsoleWarn = undefined
    lifecycle = undefined
    runtimeInput.keys.clear()
    runtimeInput.pointer.buttons.clear()

    const baseline = playingProject
    playingProject = undefined
    playingRevision = undefined
    if (baseline !== undefined) replaceRuntime(baseline)
    refreshRuntimeOutput()
  }

  let finalStatus = runtimeErrors.length === 0
    ? stopWorkspace === undefined ? reason : `${stopWorkspace.backend.toUpperCase()} Edit`
    : `Runtime error: ${runtimeErrors[0]?.split('\n')[0] ?? 'unknown error'}`
  const finishStop = async (pull: boolean): Promise<void> => {
    if (!stopIsCurrent()) return
    root.dataset.playState = runtimeErrors.length === 0
      ? stopWorkspace === undefined
        ? 'stopped'
        : m7ActiveRun !== undefined && m7RunIsCurrent(m7ActiveRun)
          ? 'editing'
          : 'stopped'
      : 'error'
    try {
      if (pull) await pullLatest(M7_LIFECYCLE_TIMEOUT)
    } catch (error) {
      finalStatus = `Refresh failed: ${runtimeMessage(error).split('\n')[0]}`
    }
    if (!stopIsCurrent()) return
    if (root.dataset.playState === 'starting') return
    setEditorDisabled(false)
    refreshPlayButtons()
    if (root.dataset.sync !== 'conflict') status.textContent = finalStatus
  }
  if (!report
    || stopProjectId === undefined
    || testedRevision === undefined
    || (stopWorkspace !== undefined && runId === undefined)) {
    await finishStop(false)
    if (startCleanupError !== undefined) throw startCleanupError
    return
  }

  if (!stopIsCurrent()) return
  status.textContent = 'Recording diagnostics'
  try {
    if (stopWorkspace !== undefined) {
      if (diagnosticsRun === undefined) throw new Error('Runtime run is not active')
      await waitForM7EditorScene(diagnosticsRun)
      if (!stopIsCurrent()) return
    }
    const result = await app.callServerTool({
      name: 'report_diagnostics',
      arguments: {
        projectId: stopProjectId,
        testedRevision,
        ...runId === undefined ? {} : { runId },
        errors: runtimeErrors,
        warnings: runtimeWarnings,
      },
    }, {
      timeout: M7_LIFECYCLE_TIMEOUT,
      maxTotalTimeout: M7_LIFECYCLE_TIMEOUT,
    })
    if (!stopIsCurrent()) return
    if (result.isError) throw new Error(resultError(result))
    if (runtimeErrors.length === 0 && runtimeWarnings.length === 0) {
      finalStatus = `${reason}; diagnostics recorded`
    }
  } catch (error) {
    finalStatus = `Diagnostics not recorded: ${runtimeMessage(error).split('\n')[0]}`
  }
  await finishStop(true)
  if (startCleanupError !== undefined) throw startCleanupError
}

function handleStopFailure(error: unknown): void {
  if (tearingDown) return
  root.dataset.playState = 'error'
  setEditorDisabled(false)
  refreshPlayButtons()
  status.textContent = `Runtime cleanup failed: ${runtimeMessage(error).split('\n')[0]}`
}

function canApplyEditorRevision(snapshot: RemoteSnapshot): boolean {
  if (navigationTab !== 'scene'
    || workspace === undefined
    || snapshot.workspace === undefined
    || snapshot.editorOperations === undefined
    || project === undefined
    || m7ActiveRun === undefined
    || !m7RunIsCurrent(m7ActiveRun)
    || workspace.kind !== snapshot.workspace.kind
    || workspace.entry !== snapshot.workspace.entry
    || workspace.backend !== snapshot.workspace.backend) return false

  const currentFiles = new Map(workspace.files.map(file => [file.path, file.sha256]))
  const nextFiles = new Map(snapshot.workspace.files.map(file => [file.path, file.sha256]))
  const paths = new Set([...currentFiles.keys(), ...nextFiles.keys()])
  const changedPaths = [...paths].filter(path => currentFiles.get(path) !== nextFiles.get(path))
  if (changedPaths.length !== 1 || changedPaths[0] !== WORKSPACE_EDITOR_STATE_PATH) return false

  return snapshot.editorOperations.every(operation => {
    const object = scene.getObjectByProperty('uuid', operation.objectUuid)
    if (object === undefined) return false
    const material = editableMaterial(object)
    if (operation.type === 'set_material_color') return material !== undefined
    if (operation.type === 'set_material_value') {
      return material !== undefined
        && operation.property === 'roughness'
        && 'roughness' in material
    }
    return true
  })
}

function trackM7Lifecycle<T>(task: Promise<T>): Promise<T> {
  m7LifecycleTasks.add(task)
  void task.then(
    () => m7LifecycleTasks.delete(task),
    () => m7LifecycleTasks.delete(task),
  )
  return task
}

async function applyEditorRevision(snapshot: RemoteSnapshot): Promise<boolean> {
  if (!canApplyEditorRevision(snapshot)
    || m7ActiveRun === undefined
    || snapshot.workspace === undefined
    || snapshot.editorOperations === undefined) return false

  const run = m7ActiveRun
  const nextRun = { ...run, revision: snapshot.revision }
  const token = m7StartToken
  const controller = new AbortController()
  m7LifecycleControllers.add(controller)
  let registrationStarted = false
  let advanced = false
  try {
    status.textContent = 'Applying external Editor changes'
    setEditorDisabled(true)
    registrationStarted = true
    const registered = await app.callServerTool({
      name: 'register_runtime_run',
      arguments: {
        projectId: run.projectId,
        revision: nextRun.revision,
        runId: run.runId,
        previousRevision: run.revision,
      },
    }, {
      signal: controller.signal,
      timeout: M7_LIFECYCLE_TIMEOUT,
      maxTotalTimeout: M7_LIFECYCLE_TIMEOUT,
    })
    if (registered.isError) throw new Error(resultError(registered))
    advanced = true
    if (m7ActiveRun === undefined
      || !sameM7Run(m7ActiveRun, run)
      || !m7RunIsCurrent(run)
      || token !== m7StartToken
      || root.dataset.playState !== 'editing'
      || root.dataset.sync !== 'clean') {
      throw new Error('Editor state changed during Runtime revision rollover')
    }

    const applied = waitForM7Event(
      ['editor-scene', 'runtime-error'],
      nextRun,
      10_000,
      controller.signal,
    )
    postM7Run(run, 'apply-operations', {
      operations: snapshot.editorOperations,
      previousRevision: run.revision,
      revision: snapshot.revision,
    })
    const event = await applied
    if (event.type === 'runtime-error') {
      throw new Error(typeof event.data?.message === 'string'
        ? event.data.message
        : 'Workspace Runtime Editor update failed')
    }
    const objects = Array.isArray(event.data?.objects)
      ? event.data.objects.map(editorObjectSnapshot)
      : []
    if (objects.some(object => object === undefined)) {
      throw new Error('Workspace Runtime returned invalid editor objects')
    }
    if (m7ActiveRun === undefined
      || !sameM7Run(m7ActiveRun, run)
      || !m7RunIsCurrent(run)
      || token !== m7StartToken
      || root.dataset.playState !== 'editing'
      || root.dataset.sync !== 'clean') {
      throw new Error('Editor state changed during Runtime revision rollover')
    }

    workspace = snapshot.workspace
    renderFileTree()
    m7ActiveRun = nextRun
    m7EditorSceneAccepted = true
    setClean(snapshot.revision)
    acceptRuntimeEditorScene(objects as EditorObjectSnapshot[], nextRun)
    await waitForM7EditorScene(nextRun)
    if (token !== m7StartToken
      || m7ActiveRun === undefined
      || !sameM7Run(m7ActiveRun, nextRun)
      || !m7RunIsCurrent(nextRun)) {
      throw new Error('Runtime lifecycle changed during revision rollover')
    }
    setEditorDisabled(false)
    if (root.dataset.sync === 'clean') {
      status.textContent = 'Updated Editor changes from server'
    }
    return true
  } catch (error) {
    let cleanupError: unknown
    if (registrationStarted) {
      try {
        if (m7ActiveRun !== undefined && sameM7Runtime(m7ActiveRun, run)) {
          if (advanced) {
            m7ActiveRun = nextRun
            await stopM7Runtime(false)
          } else {
            await releaseM7Run(nextRun)
          }
        } else {
          await releaseM7Run(nextRun)
        }
      } catch (failure) {
        cleanupError = failure
      }
    }
    if (token === m7StartToken
      && projectId === run.projectId
      && revision === nextRun.revision) {
      setClean(run.revision)
    }
    if (projectId === run.projectId && revision === run.revision) {
      setEditorDisabled(false)
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        'Runtime revision rollover cleanup failed',
      )
    }
    return false
  } finally {
    m7LifecycleControllers.delete(controller)
  }
}

async function pullLatest(timeout = 60_000): Promise<void> {
  if (tearingDown
    || pulling
    || root.dataset.playState === 'starting'
    || root.dataset.playState === 'playing'
    || root.dataset.playState === 'stopping'
    || projectId === undefined || revision === undefined) return
  pulling = true
  const pullProjectId = projectId
  const pullRevision = revision
  try {
    const result = await app.callServerTool({
      name: 'pull_project',
      arguments: {
        projectId: pullProjectId,
        currentRevision: pullRevision,
      },
    }, {
      timeout,
      maxTotalTimeout: timeout,
    })
    if (tearingDown || projectId !== pullProjectId || revision !== pullRevision) return
    const snapshot = snapshotFromResult(result)
    if (snapshot === undefined) return
    if (root.dataset.sync === 'saving' || snapshot.revision === revision) return
    if (root.dataset.sync === 'clean') {
      if (!await trackM7Lifecycle(applyEditorRevision(snapshot))) {
        if (tearingDown || projectId !== pullProjectId || revision !== pullRevision) return
        if (root.dataset.sync === 'clean') {
          acceptSnapshot(
            snapshot.project,
            snapshot.revision,
            'Updated from server',
            snapshot.workspace,
          )
        } else {
          showConflict(snapshot)
        }
      }
    } else {
      showConflict(snapshot)
    }
  } finally {
    pulling = false
  }
}

async function loadProject(nextProjectId: string): Promise<void> {
  if (tearingDown || loadingId === nextProjectId) return
  const token = ++loadToken
  loadingId = nextProjectId
  root.dataset.sync = 'loading'
  refreshPlayButtons()
  status.textContent = 'Loading project'
  try {
    const result = await app.callServerTool({
      name: 'pull_project',
      arguments: { projectId: nextProjectId },
    })
    if (tearingDown || token !== loadToken) return
    const snapshot = snapshotFromResult(result)
    if (snapshot === undefined) throw new Error('project snapshot was not returned')
    projectId = nextProjectId
    root.dataset.projectId = projectId
    acceptSnapshot(snapshot.project, snapshot.revision, 'Project loaded', snapshot.workspace)
  } finally {
    if (token === loadToken) loadingId = undefined
  }
}

app.ontoolresult = result => {
  if (tearingDown) return
  const structured = record(result.structuredContent)
  const nextProjectId = structured?.projectId
  // #region debug-point H4:tool-result
  void fetch('http://127.0.0.1:7778/event', { method: 'POST', body: JSON.stringify({ sessionId: 'pool-float-ui-refresh', runId: 'post-fix', hypothesisId: 'H4', location: 'threejs-editor-mcp/src/view.ts:ontoolresult', msg: '[DEBUG] Three.js MCP App received tool result', data: { projectId: nextProjectId, revision: structured?.revision, hasStructuredContent: structured !== undefined, isError: result.isError === true }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  if (typeof nextProjectId !== 'string') {
    status.textContent = 'Tool result did not identify a project'
    return
  }
  void loadProject(nextProjectId).catch(error => {
    if (tearingDown) return
    root.dataset.sync = 'error'
    status.textContent = error instanceof Error ? error.message : String(error)
  })
}
app.onhostcontextchanged = context => {
  if (tearingDown) return
  if (context.theme !== undefined) document.documentElement.dataset.theme = context.theme
  if (context.availableDisplayModes !== undefined) {
    fullscreen.hidden = !context.availableDisplayModes.includes('fullscreen')
  }
  if (context.displayMode === 'inline' || context.displayMode === 'fullscreen') {
    setDisplayMode(context.displayMode)
  }
}
app.onteardown = async () => {
  if (tearingDown) return {}
  tearingDown = true
  loadToken += 1
  parameterLoadToken += 1
  m7StartToken += 1
  cancelM7Start()
  for (const controller of m7LifecycleControllers) controller.abort()
  m7LifecycleControllers.clear()
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
  const failures: unknown[] = []
  const cleanup = async (action: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }
  let queueFailure: unknown
  try {
    await m7StartCompletion
  } catch (error) {
    queueFailure = error
  }
  while (m7LifecycleTasks.size > 0) {
    const settled = await Promise.allSettled([...m7LifecycleTasks])
    failures.push(...settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason))
  }
  await cleanup(() => stopLocalRuntimeForSnapshot())
  await cleanup(async () => {
    if (m7ActiveRun !== undefined) await stopM7Runtime()
  })
  await cleanup(() => stopIsolatedRuntime())
  await cleanup(() => cancelAnimationFrame(animation))
  await cleanup(() => resizeObserver.disconnect())
  await cleanup(() => disposeControls())
  await cleanup(() => disposeScene(scene))
  await cleanup(() => renderer.dispose())
  await cleanup(() => runtimeTimer.dispose())
  const cleanupFailures = m7CleanupFailures.splice(0)
  const queueFailureIsRecorded = queueFailure !== undefined && (
    cleanupFailures.includes(queueFailure)
      || (queueFailure instanceof AggregateError
        && queueFailure.message === 'Previous Runtime cleanup failed'
        && queueFailure.errors.length > 0
        && queueFailure.errors.every(error => cleanupFailures.includes(error)))
  )
  if (queueFailure !== undefined && !queueFailureIsRecorded) failures.push(queueFailure)
  failures.push(...cleanupFailures)
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Three.js Editor teardown failed')
  }
  return {}
}

title.addEventListener('input', () => {
  if (project === undefined) return
  scene.name = title.value.trim()
  markDirty()
})
title.addEventListener('change', () => {
  if (project !== undefined) commitHistory('Renamed project')
})
scriptSource.addEventListener('input', () => {
  if (project !== undefined) markDirty('Unsaved script changes')
})
scriptSource.addEventListener('change', () => {
  if (project !== undefined) commitHistory('Updated game script')
})
for (const button of detailTabs) {
  button.addEventListener('click', () => {
    setDetailTab(button.dataset.detailTab as 'inspector' | 'script')
  })
}
for (const button of navigationTabs) {
  button.addEventListener('click', () => {
    setNavigationTab(button.dataset.navigationTab as NavigationTab)
  })
}
fullscreen.addEventListener('click', () => {
  const next = document.documentElement.dataset.displayMode === 'fullscreen'
    ? 'inline'
    : 'fullscreen'
  void requestDisplayMode(next).catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error)
  })
})
play.addEventListener('click', startGame)
stop.addEventListener('click', () => {
  void stopGame().catch(handleStopFailure)
})
runtimeDebug.addEventListener('change', () => {
  runtimeDebugMode = runtimeDebug.value
  root.dataset.runtimeDebug = runtimeDebugMode
  if (m7ActiveRun !== undefined) postM7('set-debug', { debugMode: runtimeDebugMode })
})
importAssetButton.addEventListener('click', () => assetInput.click())
assetInput.addEventListener('change', () => {
  const file = assetInput.files?.[0]
  if (file === undefined || projectId === undefined || revision === undefined) return
  const selectedMaterial = editableMaterial(selected)
  setEditorDisabled(true)
  status.textContent = 'Importing asset'
  void (async () => {
    if (file.size > 256 * 1024) throw new Error('Asset exceeds 256 KiB')
    const mediaType = assetMediaType(file)
    if (mediaType !== 'model/gltf-binary' && selectedMaterial === undefined) {
      throw new Error('Select a mesh before importing a texture')
    }
    const name = safeAssetName(file)
    const buffer = await file.arrayBuffer()
    const data = encodeBase64(buffer)
    const result = await app.callServerTool({
      name: 'put_asset',
      arguments: {
        projectId,
        baseRevision: revision,
        name,
        mediaType,
        data,
      },
    })
    if (result.isError) {
      await pullLatest()
      throw new Error(resultError(result))
    }

    if (mediaType === 'model/gltf-binary') {
      const imported = (await new GLTFLoader().parseAsync(buffer, '')).scene
      if (imported.children.length === 0) throw new Error('GLB scene is empty')
      if (imported.name === '') imported.name = name.replace(/\.glb$/, '')
      scene.add(imported)
      selectObject(imported)
      commitHistory(`Imported GLB ${name}`)
    } else {
      const material = selectedMaterial
      if (material === undefined) throw new Error('Selected mesh has no texture material')
      const texture = await new THREE.TextureLoader()
        .loadAsync(`data:${mediaType};base64,${data}`)
      texture.colorSpace = THREE.SRGBColorSpace
      material.map = texture
      material.needsUpdate = true
      commitHistory(`Applied texture ${name} to ${selected?.name || 'mesh'}`)
    }
    importedAssets = [...new Set([...importedAssets, name])].sort()
    status.textContent = `Imported ${name}; save project`
  })().catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    assetInput.value = ''
    setEditorDisabled(false)
  })
})
exportProjectButton.addEventListener('click', () => {
  if (projectId === undefined || root.dataset.sync !== 'clean') return
  setEditorDisabled(true)
  status.textContent = 'Exporting project'
  void app.callServerTool({
    name: 'export_project',
    arguments: { projectId },
  }).then(async result => {
    if (result.isError) throw new Error(resultError(result))
    const exported = record(result.structuredContent)
    if (typeof exported?.filename !== 'string'
      || exported.mediaType !== 'application/json'
      || typeof exported.json !== 'string') {
      throw new Error('export_project returned invalid content')
    }
    const download = await app.downloadFile({
      contents: [{
        type: 'resource',
        resource: {
          uri: `file:///${exported.filename}`,
          mimeType: exported.mediaType,
          text: exported.json,
        },
      }],
    })
    if (download.isError) throw new Error('Host rejected project export')
    root.dataset.lastExport = exported.filename
    status.textContent = `Exported ${exported.filename}`
  }).catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    setEditorDisabled(false)
  })
})
layout.addEventListener('change', () => {
  if (project === undefined) return
  const next = layout.value as LayoutPreset
  if (next === layoutPreset) return
  const previous = layoutPreset
  layoutPreset = next
  applyLayout(next)
  commitHistory(`Changed layout from ${previous} to ${next}`)
})
cameraViewSelect.addEventListener('change', () => {
  if (project === undefined) return
  const next = cameraViewSelect.value as CameraView
  if (next === cameraView) return
  const previous = cameraView
  cameraView = next
  applyCameraView(next)
  commitHistory(`Changed camera view from ${previous} to ${next}`)
})
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    transformMode = button.dataset.mode as TransformControlsMode
    transform?.setMode(transformMode)
    if (workspace !== undefined && m7ActiveRun !== undefined) {
      postM7('set-transform-mode', { mode: transformMode })
    }
    refreshModeButtons()
  })
}

objectName.addEventListener('input', () => {
  if (selected === undefined) return
  selected.name = objectName.value
  previewRuntimeOperation({
    type: 'set_name',
    objectUuid: selected.uuid,
    value: selected.name,
  })
  renderHierarchy()
  markDirty()
})
objectName.addEventListener('change', () => {
  if (selected === undefined) return
  commitOfficialOperation({
    type: 'set_name',
    objectUuid: selected.uuid,
    value: selected.name,
  }, `Renamed object to ${selected.name || selected.type}`)
})
objectVisible.addEventListener('change', () => {
  if (selected === undefined) return
  selected.visible = objectVisible.checked
  previewRuntimeOperation({
    type: 'set_visible',
    objectUuid: selected.uuid,
    value: selected.visible,
  })
  commitOfficialOperation({
    type: 'set_visible',
    objectUuid: selected.uuid,
    value: selected.visible,
  }, `${selected.visible ? 'Showed' : 'Hid'} ${selected.name || selected.type}`)
})
for (const input of vectorInputs) {
  input.addEventListener('input', () => {
    if (selected === undefined) return
    const value = Number(input.value)
    if (!Number.isFinite(value)) return
    const property = input.dataset.vector as VectorProperty
    const axis = input.dataset.axis as Axis
    if (property === 'rotation') selected.rotation[axis] = THREE.MathUtils.degToRad(value)
    else selected[property][axis] = value
    selected.updateMatrix()
    scene.updateMatrixWorld(true)
    const operationType = property === 'rotation'
      ? 'set_rotation'
      : property === 'scale'
        ? 'set_scale'
        : 'set_position'
    previewRuntimeOperation({
      type: operationType,
      objectUuid: selected.uuid,
      value: property === 'rotation'
        ? [
            THREE.MathUtils.radToDeg(selected.rotation.x),
            THREE.MathUtils.radToDeg(selected.rotation.y),
            THREE.MathUtils.radToDeg(selected.rotation.z),
          ]
        : selected[property].toArray() as [number, number, number],
    })
    markDirty()
  })
  input.addEventListener('change', () => {
    if (selected === undefined) return
    const property = input.dataset.vector as VectorProperty
    const value = property === 'rotation'
      ? [
          THREE.MathUtils.radToDeg(selected.rotation.x),
          THREE.MathUtils.radToDeg(selected.rotation.y),
          THREE.MathUtils.radToDeg(selected.rotation.z),
        ] as [number, number, number]
      : selected[property].toArray() as [number, number, number]
    commitOfficialOperation({
      type: property === 'rotation'
        ? 'set_rotation'
        : property === 'scale'
          ? 'set_scale'
          : 'set_position',
      objectUuid: selected.uuid,
      value,
    }, `Updated ${selected.name || selected.type} ${property}`)
  })
}
materialColor.addEventListener('input', () => {
  const material = editableMaterial(selected)
  if (material === undefined) return
  material.color.set(materialColor.value)
  if (selected !== undefined) {
    previewRuntimeOperation({
      type: 'set_material_color',
      objectUuid: selected.uuid,
      value: materialColor.value,
    })
  }
  markDirty()
})
materialColor.addEventListener('change', () => {
  if (selected === undefined) return
  commitOfficialOperation({
    type: 'set_material_color',
    objectUuid: selected.uuid,
    value: materialColor.value,
  }, `Changed ${selected.name || selected.type} color`)
})

fileSource.addEventListener('input', () => {
  if (fileLoading || fileSource.disabled || activeFile === undefined) return
  if (fileHistory[fileHistoryIndex] === fileSource.value) return
  fileHistory = fileHistory.slice(0, fileHistoryIndex + 1)
  fileHistory.push(fileSource.value)
  if (fileHistory.length > 50) fileHistory.shift()
  fileHistoryIndex = fileHistory.length - 1
  refreshHistoryButtons()
  markDirty(`Editing ${activeFile}`)
})

undo.addEventListener('click', () => {
  if (navigationTab === 'files') {
    if (fileHistoryIndex <= 0) return
    fileHistoryIndex -= 1
    fileSource.value = fileHistory[fileHistoryIndex] ?? ''
    refreshHistoryButtons()
    if (fileHistoryIndex === 0 && remoteSnapshot === undefined) {
      root.dataset.sync = 'clean'
      save.disabled = true
      refreshPlayButtons()
      status.textContent = 'Reverted file edits'
    } else {
      markDirty('Undo file edit')
    }
    return
  }
  if (historyIndex <= 0) return
  historyIndex -= 1
  const entry = history[historyIndex]
  if (entry === undefined) return
  pendingOperations = [...entry.pendingOperations]
  pendingEditorOperations = [...entry.editorOperations]
  replaceRuntime(entry.project)
  syncRuntimeMirror()
  refreshHistoryButtons()
  if (historyIndex === 0 && remoteSnapshot === undefined) {
    root.dataset.sync = 'clean'
    save.disabled = true
    refreshPlayButtons()
    status.textContent = 'Reverted local edits'
  } else {
    markDirty('Undo')
  }
})
redo.addEventListener('click', () => {
  if (navigationTab === 'files') {
    if (fileHistoryIndex >= fileHistory.length - 1) return
    fileHistoryIndex += 1
    fileSource.value = fileHistory[fileHistoryIndex] ?? ''
    refreshHistoryButtons()
    markDirty('Redo file edit')
    return
  }
  if (historyIndex >= history.length - 1) return
  historyIndex += 1
  const entry = history[historyIndex]
  if (entry === undefined) return
  pendingOperations = [...entry.pendingOperations]
  pendingEditorOperations = [...entry.editorOperations]
  replaceRuntime(entry.project)
  syncRuntimeMirror()
  refreshHistoryButtons()
  markDirty('Redo')
})

sceneSearch.addEventListener('input', renderHierarchy)
revealSelection.addEventListener('click', () => {
  if (selected === undefined) return
  sceneSearch.value = ''
  selectObject(selected)
})

save.addEventListener('click', () => {
  if (projectId === undefined || project === undefined || revision === undefined) return
  if (navigationTab === 'files') {
    if (activeFile === undefined || fileSummary(activeFile)?.text !== true) return
    const savedProjectId = projectId
    const savedRevision = revision
    const savedPath = activeFile
    save.disabled = true
    root.dataset.sync = 'saving'
    setEditorDisabled(true)
    status.textContent = `Saving ${savedPath}`
    void app.callServerTool({
      name: 'apply_project_files',
      arguments: {
        projectId: savedProjectId,
        baseRevision: savedRevision,
        changes: [{
          type: 'write',
          path: savedPath,
          text: fileSource.value,
        }],
      },
    }).then(async result => {
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      if (result.isError) {
        root.dataset.sync = 'dirty'
        setEditorDisabled(false)
        await pullLatest()
        return
      }
      const pulled = await app.callServerTool({
        name: 'pull_project',
        arguments: { projectId: savedProjectId },
      })
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      const snapshot = snapshotFromResult(pulled)
      if (snapshot === undefined) throw new Error('saved workspace snapshot was not returned')
      setEditorDisabled(false)
      acceptSnapshot(snapshot.project, snapshot.revision, `Saved ${savedPath}`, snapshot.workspace)
    }).catch(error => {
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      root.dataset.sync = 'error'
      save.disabled = false
      setEditorDisabled(false)
      status.textContent = error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (workspace !== undefined) {
    if (pendingEditorOperations.length === 0) return
    const savedProjectId = projectId
    const savedRevision = revision
    const savedRun = m7ActiveRun
    const operations = [...pendingEditorOperations]
    save.disabled = true
    root.dataset.sync = 'saving'
    setEditorDisabled(true)
    status.textContent = 'Saving Runtime scene edits'
    void (async () => {
      if (savedRun === undefined || !m7RunIsCurrent(savedRun)) {
        throw new Error('Runtime run is not active')
      }
      await waitForM7EditorScene(savedRun)
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) {
        throw new Error('Project changed while saving Runtime scene edits')
      }
      return app.callServerTool({
        name: 'apply_editor_commands',
        arguments: {
          projectId: savedProjectId,
          baseRevision: savedRevision,
          runId: savedRun.runId,
          source: 'human',
          operations,
        },
      })
    })().then(async result => {
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      if (result.isError) {
        root.dataset.sync = 'dirty'
        setEditorDisabled(false)
        await pullLatest()
        return
      }
      const committed = record(result.structuredContent)
      if (typeof committed?.revision !== 'string') {
        throw new Error('saved Workspace revision was not returned')
      }
      const pulled = await app.callServerTool({
        name: 'pull_project',
        arguments: { projectId: savedProjectId },
      })
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      const snapshot = snapshotFromResult(pulled)
      if (snapshot === undefined) throw new Error('saved Workspace snapshot was not returned')
      setEditorDisabled(false)
      acceptSnapshot(
        snapshot.project,
        snapshot.revision,
        'Saved Runtime scene edits',
        snapshot.workspace,
      )
    }).catch(error => {
      if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
      root.dataset.sync = 'error'
      save.disabled = false
      setEditorDisabled(false)
      status.textContent = error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (title.value.trim() === '') return
  const savedProjectId = projectId
  const savedRevision = revision
  const nextProject = serializeProject()
  const saveWorkspace = workspace !== undefined
  save.disabled = true
  root.dataset.sync = 'saving'
  setEditorDisabled(true)
  status.textContent = 'Saving'
  void app.callServerTool({
    name: 'push_project',
    arguments: {
      projectId: savedProjectId,
      baseRevision: savedRevision,
      project: nextProject,
    },
  }).then(async result => {
    if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
    if (result.isError) {
      root.dataset.sync = 'dirty'
      setEditorDisabled(false)
      await pullLatest()
      return
    }
    const structured = record(result.structuredContent)
    if (typeof structured?.revision !== 'string') {
      throw new Error('push_project returned an invalid revision')
    }
    if (saveWorkspace) {
      const pulled = await app.callServerTool({
        name: 'pull_project',
        arguments: { projectId: savedProjectId },
      })
      const snapshot = snapshotFromResult(pulled)
      if (snapshot === undefined) throw new Error('saved workspace snapshot was not returned')
      setEditorDisabled(false)
      acceptSnapshot(snapshot.project, snapshot.revision, 'Saved', snapshot.workspace)
      return
    }
    project = cloneProject(nextProject)
    baseOperations = [...(nextProject.editor?.operations ?? [])]
    pendingOperations = []
    history = [{
      project: cloneProject(nextProject),
      pendingOperations: [],
      editorOperations: [],
    }]
    historyIndex = 0
    refreshHistoryButtons()
    setEditorDisabled(false)
    setClean(structured.revision)
    status.textContent = 'Saved'
  }).catch(error => {
    if (!savedStateIsCurrent(savedProjectId, savedRevision)) return
    root.dataset.sync = 'error'
    save.disabled = false
    setEditorDisabled(false)
    status.textContent = error instanceof Error ? error.message : String(error)
  })
})

loadExternal.addEventListener('click', () => {
  if (remoteSnapshot === undefined) return
  acceptSnapshot(
    remoteSnapshot.project,
    remoteSnapshot.revision,
    'Loaded external revision',
    remoteSnapshot.workspace,
  )
})
saveCopy.addEventListener('click', () => {
  if (projectId === undefined || project === undefined || workspace !== undefined) return
  const nextProject = serializeProject()
  nextProject.title = `${nextProject.title} (Local copy)`.slice(0, 120)
  const nextProjectId = `${projectId.slice(0, 45)}-copy-${Date.now().toString(36)}`.slice(0, 64)
  saveCopy.disabled = true
  status.textContent = 'Saving local copy'
  void app.callServerTool({
    name: 'save_project_copy',
    arguments: {
      sourceProjectId: projectId,
      newProjectId: nextProjectId,
      project: nextProject,
    },
  }).then(result => {
    if (result.isError) throw new Error(resultError(result))
    const structured = record(result.structuredContent)
    if (typeof structured?.revision !== 'string') {
      throw new Error('save_project_copy returned an invalid revision')
    }
    projectId = nextProjectId
    root.dataset.projectId = nextProjectId
    acceptSnapshot(nextProject, structured.revision, `Saved local copy as ${nextProjectId}`)
  }).catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error)
  }).finally(() => {
    saveCopy.disabled = false
  })
})

function updateRuntimePointer(event: PointerEvent): void {
  const rect = canvas.getBoundingClientRect()
  runtimeInput.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  runtimeInput.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  runtimeInput.pointer.buttons.clear()
  const masks = [1, 4, 2, 8, 16]
  for (let button = 0; button < masks.length; button += 1) {
    if ((event.buttons & (masks[button] ?? 0)) !== 0) {
      runtimeInput.pointer.buttons.add(button)
    }
  }
}

window.addEventListener('keydown', event => {
  if (event.key === 'Escape'
    && document.documentElement.dataset.displayMode === 'fullscreen') {
    event.preventDefault()
    void requestDisplayMode('inline')
    return
  }
  if (root.dataset.playState !== 'playing') return
  runtimeInput.keys.add(event.key.toLowerCase())
  if (['w', 's', 'arrowup', 'arrowdown'].includes(event.key.toLowerCase())) {
    event.preventDefault()
  }
})
window.addEventListener('keyup', event => {
  runtimeInput.keys.delete(event.key.toLowerCase())
})
window.addEventListener('blur', () => {
  runtimeInput.keys.clear()
  runtimeInput.pointer.buttons.clear()
})

canvas.addEventListener('pointerdown', event => {
  canvas.focus()
  if (root.dataset.playState === 'playing') {
    updateRuntimePointer(event)
    pointerGesture = undefined
    return
  }
  if (!event.isPrimary || event.button !== 0) {
    pointerGesture = undefined
    return
  }
  const rect = canvas.getBoundingClientRect()
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  )
  raycaster.setFromCamera(pointer, camera)
  const meshes: THREE.Object3D[] = []
  scene.traverse(object => {
    if (object instanceof THREE.Mesh && !isHelper(object)) meshes.push(object)
  })
  pointerGesture = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    blocked: transform?.axis != null || transform?.dragging === true,
    pickIds: raycaster.intersectObjects(meshes, false)
      .slice(0, 1)
      .map(result => result.object.uuid),
  }
})
canvas.addEventListener('pointermove', event => {
  if (root.dataset.playState === 'playing') {
    updateRuntimePointer(event)
    return
  }
  if (pointerGesture?.pointerId !== event.pointerId) return
  if (Math.hypot(event.clientX - pointerGesture.x, event.clientY - pointerGesture.y) > 4) {
    pointerGesture.moved = true
  }
})
canvas.addEventListener('pointerup', event => {
  if (root.dataset.playState === 'playing') {
    updateRuntimePointer(event)
    return
  }
  const gesture = pointerGesture
  pointerGesture = undefined
  if (!shouldPickAfterPointerGesture(
    gesture,
    event.pointerId,
    event.clientX,
    event.clientY,
    transform?.dragging === true,
  )) return
  const pickedUuid = gesture?.pickIds?.[0]
  selectObject(pickedUuid === undefined
    ? undefined
    : scene.getObjectByProperty('uuid', pickedUuid))
})
canvas.addEventListener('pointercancel', event => {
  if (root.dataset.playState === 'playing') updateRuntimePointer(event)
  if (pointerGesture?.pointerId === event.pointerId) pointerGesture = undefined
})
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault()
  root.dataset.webgl = 'false'
  status.textContent = 'WebGL context lost'
})

function resizeRenderer(): void {
  const width = Math.max(1, Math.floor(viewport.clientWidth))
  const height = Math.max(1, Math.floor(viewport.clientHeight))
  renderer.setSize(width, height, false)
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  } else if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(1, (camera.top - camera.bottom) / 2)
    const halfWidth = halfHeight * width / height
    camera.left = -halfWidth
    camera.right = halfWidth
    camera.updateProjectionMatrix()
  }
  root.dataset.viewport = `${String(width)}x${String(height)}`
}

function render(timestamp: number): void {
  if (root.dataset.playState === 'playing' && lifecycle !== undefined) {
    runtimeTimer.update(timestamp)
    try {
      lifecycle.update?.(runtimeContext(), Math.min(runtimeTimer.getDelta(), 0.1))
    } catch (error) {
      recordRuntimeError(error)
      void stopGame('Play failed').catch(handleStopFailure)
    }
  } else {
    orbit?.update()
  }
  renderer.render(scene, camera)
  frame += 1
  root.dataset.frame = String(frame)
  animation = requestAnimationFrame(render)
}

const resizeObserver = new ResizeObserver(resizeRenderer)
resizeObserver.observe(viewport)
resizeRenderer()
refreshModeButtons()
refreshHistoryButtons()
refreshPlayButtons()
setDetailTab('inspector')
setNavigationTab('scene', true)
animation = requestAnimationFrame(render)

const diagnostics = {
  metrics: () => ({
    frame,
    webgl: root.dataset.webgl,
    viewport: root.dataset.viewport,
    projectId,
    revision,
    title: project?.title,
    inputTitle: title.value,
    sync: root.dataset.sync,
    selected: selected?.name,
    selectedUuid: selected?.uuid,
    transformMode,
    historyIndex,
    historyLength: history.length,
    layout: layoutPreset,
    cameraView,
    playState: root.dataset.playState,
    runtimeErrors: [...runtimeErrors],
    runtimeWarnings: [...runtimeWarnings],
    playingRevision,
    inputKeys: [...runtimeInput.keys],
    inputPointer: {
      x: runtimeInput.pointer.x,
      y: runtimeInput.pointer.y,
      buttons: [...runtimeInput.pointer.buttons],
    },
    scriptSource: scriptSource.value,
    operations: [...baseOperations],
    pendingOperations: [...pendingOperations],
    remoteRevision: remoteSnapshot?.revision,
    importedAssets: [...importedAssets],
    lastExport: root.dataset.lastExport,
    navigationTab,
    workspaceKind: workspace?.kind,
    workspaceEntry: workspace?.entry,
    workspaceBackend: workspace?.backend,
    runtimeDebugMode,
    workspaceFiles: workspace?.files.map(file => file.path) ?? [],
    activeFile,
    fileHistoryIndex,
    fileHistoryLength: fileHistory.length,
    fileText: fileSource.value,
    displayMode: document.documentElement.dataset.displayMode,
    lastOfficialCommands: root.dataset.lastOfficialCommands,
    hierarchy: scene.children.filter(object => !isHelper(object)).map(object => object.name || object.type),
    m5: {
      active: m5ActiveRun !== undefined,
      resourceReads: m5ResourceReads,
      modules: m5Manifest?.modules.map(module => module.path) ?? [],
      eventTypes: m5Events.map(event => event.type),
      errors: [...m5Errors],
      ready: m5Ready,
      serverCommandProof: m5ServerCommandProof,
      localCommandProof: officialCommandProof(),
      frame: Number(root.dataset.m5Frame ?? 0),
      frameAtStop: m5FrameAtStop,
      messagesAfterStop: m5MessagesAfterStop,
      runtimeFrameVisible: !runtimeFrame.hidden,
    },
    m7: {
      active: m7ActiveRun !== undefined,
      runId: m7ActiveRun?.runId,
      build: m7Build,
      eventTypes: m7Events.map(event => event.type),
      errors: [...m7Errors],
      ready: m7Ready,
      metrics: m7Metrics,
      lastDispose: m7LastDispose,
      messagesAfterStop: m7MessagesAfterStop,
      runtimeFrameVisible: !runtimeFrame.hidden,
      debugMode: runtimeDebugMode,
    },
  }),
  object: (name: string) => {
    const object = scene.getObjectByName(name)
    return object === undefined
      ? undefined
      : {
          name: object.name,
          visible: object.visible,
          position: object.position.toArray(),
          rotation: object.rotation.toArray(),
          scale: object.scale.toArray(),
          color: editableMaterial(object)?.color.getHexString(),
        }
  },
  pixelStats: () => {
    renderer.render(scene, camera)
    const gl = renderer.getContext()
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const step = Math.max(4, Math.floor(pixels.length / 40_000 / 4) * 4)
    const colors = new Set<number>()
    let sampled = 0
    let lit = 0
    for (let index = 0; index < pixels.length; index += step) {
      const red = pixels[index] ?? 0
      const green = pixels[index + 1] ?? 0
      const blue = pixels[index + 2] ?? 0
      colors.add((red << 16) | (green << 8) | blue)
      if (red + green + blue > 80) lit += 1
      sampled += 1
    }
    return { width, height, sampled, lit, colors: colors.size }
  },
  runM5Fixture: () => startIsolatedRuntime(),
  runM5BrokenFixture: () => startIsolatedRuntime(manifest => {
    const entry = manifest.modules.find(module => module.path === manifest.entry)
    if (entry?.dependencies[0] !== undefined) entry.dependencies[0].path = 'missing.js'
    return manifest
  }),
  triggerM5Unhandled: async () => {
    if (m5ActiveRun === undefined) throw new Error('M5 runtime is not active')
    const event = waitForM5Event('unhandled-rejection', m5ActiveRun.runId)
    postM5('trigger-unhandled')
    return (await event).data
  },
  stopM5Fixture: () => stopIsolatedRuntime(),
  requestM7Metrics: async () => {
    if (m7ActiveRun === undefined) throw new Error('M7 runtime is not active')
    const result = waitForM7Event(['metrics'], m7ActiveRun)
    postM7('metrics')
    return (await result).data
  },
  setM7DebugMode: async (mode: string) => {
    if (m7ActiveRun === undefined) throw new Error('M7 runtime is not active')
    if (!workspace?.debugModes.includes(mode)) throw new Error(`unknown debug mode ${mode}`)
    const result = waitForM7Event(['debug-mode'], m7ActiveRun)
    runtimeDebug.value = mode
    runtimeDebug.dispatchEvent(new Event('change'))
    return (await result).data
  },
  setM7TimeScale: async (timeScale: number) => {
    if (m7ActiveRun === undefined) throw new Error('M7 runtime is not active')
    const result = waitForM7Event(['time-scale'], m7ActiveRun)
    postM7('set-time-scale', { timeScale })
    return (await result).data
  },
  loadProject: (nextProjectId: string) => loadProject(nextProjectId),
  stopM7Fixture: () => stopGame(),
}
Object.assign(window, {
  __THREE_M1__: diagnostics,
  __THREE_M2__: diagnostics,
  __THREE_M3__: diagnostics,
  __THREE_M4__: diagnostics,
  __THREE_M5__: diagnostics,
  __THREE_M6__: diagnostics,
  __THREE_M7__: diagnostics,
})

void app.connect().then(() => {
  if (tearingDown) return
  const context = app.getHostContext()
  const theme = context?.theme
  if (theme !== undefined) document.documentElement.dataset.theme = theme
  fullscreen.hidden = !context?.availableDisplayModes?.includes('fullscreen')
  setDisplayMode(context?.displayMode === 'fullscreen' ? 'fullscreen' : 'inline')
  pollTimer = window.setInterval(() => {
    void pullLatest().catch(error => {
      if (tearingDown) return
      status.textContent = error instanceof Error ? error.message : String(error)
    })
  }, 1_000)
}).catch(error => {
  if (tearingDown) return
  root.dataset.sync = 'error'
  status.textContent = error instanceof Error ? error.message : String(error)
})

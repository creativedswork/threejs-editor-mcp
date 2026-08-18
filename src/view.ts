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
  officialCommandProof,
  type EditorCommandOperation,
  type OfficialCommandProof,
} from './official-editor.js'
import {
  M5_COMMAND_PROOF_RESOURCE_URI,
  M5_RUNTIME_RESOURCE_URI,
  type M5RuntimeManifest,
} from './m5-runtime.js'

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

interface WorkspaceView {
  kind: 'linked-workspace' | 'managed-workspace'
  entry: string
  backend: 'webgl' | 'webgpu' | 'raw-webgpu'
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
}

interface HistoryEntry {
  project: Project
  pendingOperations: string[]
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
const fullscreen = required<HTMLButtonElement>('[data-fullscreen]')
const save = required<HTMLButtonElement>('[data-save]')
const hierarchy = required<HTMLUListElement>('[data-hierarchy]')
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
let remoteSnapshot: RemoteSnapshot | undefined
let workspace: WorkspaceView | undefined
let navigationTab: NavigationTab = 'scene'
let activeFile: string | undefined
let fileHistory: string[] = []
let fileHistoryIndex = -1
let fileLoading = false
let layoutPreset: LayoutPreset = 'classic'
let cameraView: CameraView = 'broadcast'
let transformMode: TransformControlsMode = 'translate'
let baseOperations: string[] = []
let pendingOperations: string[] = []
let history: HistoryEntry[] = []
let historyIndex = -1
let frame = 0
let animation = 0
let pollTimer: number | undefined
let pulling = false
let pointerStart: { x: number; y: number } | undefined
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
  const playing = root.dataset.playState === 'playing'
  play.disabled = playing || navigationTab !== 'scene' || root.dataset.sync !== 'clean'
  stop.disabled = !playing
  importAssetButton.disabled = editorDisabled
    || playing
    || navigationTab !== 'scene'
    || project === undefined
    || root.dataset.sync === 'loading'
    || root.dataset.sync === 'saving'
    || root.dataset.sync === 'conflict'
  exportProjectButton.disabled = editorDisabled
    || playing
    || project === undefined
    || root.dataset.sync !== 'clean'
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
  if (projectId === undefined || workspace === undefined || fileLoading) return
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
  fileLoading = true
  fileSource.disabled = true
  status.textContent = `Loading ${path}`
  try {
    const result = await app.callServerTool({
      name: 'read_project_files',
      arguments: { projectId, files: [{ path }] },
    })
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
    fileLoading = false
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
  })
  if (history.length > 50) history.shift()
  historyIndex = history.length - 1
  refreshHistoryButtons()
  markDirty(label)
}

function renderHierarchy(): void {
  hierarchy.replaceChildren()
  const add = (object: THREE.Object3D, depth: number): void => {
    if (isHelper(object)) return
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = object.name || object.type
    button.title = `${object.type}: ${button.textContent}`
    button.style.paddingLeft = `${String(8 + depth * 12)}px`
    button.ariaSelected = String(object === selected)
    button.dataset.objectUuid = object.uuid
    button.addEventListener('click', () => selectObject(object))
    item.append(button)
    hierarchy.append(item)
    for (const child of object.children) add(child, depth + 1)
  }
  for (const child of scene.children) add(child, 0)
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

function selectObject(object: THREE.Object3D | undefined): void {
  selected = object
  transform?.detach()
  if (object !== undefined && object !== scene && !isHelper(object)) transform?.attach(object)
  renderHierarchy()
  refreshInspector()
  root.dataset.selected = object?.name ?? ''
}

function setupControls(): void {
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

function acceptSnapshot(
  nextProject: Project,
  nextRevision: string,
  message: string,
  nextWorkspace?: WorkspaceView,
): void {
  const previousFile = activeFile
  workspace = nextWorkspace
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
  replaceRuntime(nextProject)
  const baseline = serializeProject()
  history = [{ project: cloneProject(baseline), pendingOperations: [] }]
  historyIndex = 0
  refreshHistoryButtons()
  setEditorDisabled(false)
  setClean(nextRevision)
  status.textContent = message
  if (workspace !== undefined && navigationTab === 'files') {
    if (activeFile === undefined) setNavigationTab('files', true)
    else void selectWorkspaceFile(activeFile)
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
  return {
    project: candidate as unknown as Project,
    revision: nextRevision,
    workspace: workspaceFromResult(structured.workspace),
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
  await stopIsolatedRuntime()
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
    void stopGame('Play failed')
  }
}

async function stopGame(reason = 'Stopped', report = true): Promise<void> {
  if (root.dataset.playState !== 'playing') return
  root.dataset.playState = 'stopping'
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
  const testedRevision = playingRevision
  playingProject = undefined
  playingRevision = undefined
  if (baseline !== undefined) replaceRuntime(baseline)
  root.dataset.playState = runtimeErrors.length === 0 ? 'stopped' : 'error'
  setEditorDisabled(false)
  refreshRuntimeOutput()
  status.textContent = runtimeErrors.length === 0
    ? reason
    : `Runtime error: ${runtimeErrors[0]?.split('\n')[0] ?? 'unknown error'}`

  if (!report || projectId === undefined || testedRevision === undefined) return
  try {
    const result = await app.callServerTool({
      name: 'report_diagnostics',
      arguments: {
        projectId,
        testedRevision,
        errors: runtimeErrors,
        warnings: runtimeWarnings,
      },
    })
    if (result.isError) throw new Error(resultError(result))
    if (runtimeErrors.length === 0 && runtimeWarnings.length === 0) {
      status.textContent = `${reason}; diagnostics recorded`
    }
  } catch (error) {
    status.textContent = `Diagnostics not recorded: ${runtimeMessage(error).split('\n')[0]}`
  }
  await pullLatest()
}

async function pullLatest(): Promise<void> {
  if (pulling || root.dataset.playState === 'playing'
    || projectId === undefined || revision === undefined) return
  pulling = true
  try {
    const result = await app.callServerTool({
      name: 'pull_project',
      arguments: { projectId, currentRevision: revision },
    })
    const snapshot = snapshotFromResult(result)
    if (snapshot === undefined) return
    if (root.dataset.sync === 'saving' || snapshot.revision === revision) return
    if (root.dataset.sync === 'clean') {
      acceptSnapshot(snapshot.project, snapshot.revision, 'Updated from server', snapshot.workspace)
    } else {
      showConflict(snapshot)
    }
  } finally {
    pulling = false
  }
}

async function loadProject(nextProjectId: string): Promise<void> {
  if (loadingId === nextProjectId) return
  loadingId = nextProjectId
  root.dataset.sync = 'loading'
  refreshPlayButtons()
  status.textContent = 'Loading project'
  try {
    const result = await app.callServerTool({
      name: 'pull_project',
      arguments: { projectId: nextProjectId },
    })
    const snapshot = snapshotFromResult(result)
    if (snapshot === undefined) throw new Error('project snapshot was not returned')
    projectId = nextProjectId
    root.dataset.projectId = projectId
    acceptSnapshot(snapshot.project, snapshot.revision, 'Project loaded', snapshot.workspace)
  } finally {
    loadingId = undefined
  }
}

app.ontoolresult = result => {
  const structured = record(result.structuredContent)
  const nextProjectId = structured?.projectId
  if (typeof nextProjectId !== 'string') {
    status.textContent = 'Tool result did not identify a project'
    return
  }
  void loadProject(nextProjectId).catch(error => {
    root.dataset.sync = 'error'
    status.textContent = error instanceof Error ? error.message : String(error)
  })
}
app.onhostcontextchanged = context => {
  if (context.theme !== undefined) document.documentElement.dataset.theme = context.theme
  if (context.availableDisplayModes !== undefined) {
    fullscreen.hidden = !context.availableDisplayModes.includes('fullscreen')
  }
  if (context.displayMode === 'inline' || context.displayMode === 'fullscreen') {
    setDisplayMode(context.displayMode)
  }
}
app.onteardown = async () => {
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  await stopIsolatedRuntime()
  await stopGame('Stopped', false)
  cancelAnimationFrame(animation)
  resizeObserver.disconnect()
  disposeControls()
  disposeScene(scene)
  renderer.dispose()
  runtimeTimer.dispose()
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
  void stopGame()
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
    refreshModeButtons()
  })
}

objectName.addEventListener('input', () => {
  if (selected === undefined) return
  selected.name = objectName.value
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
  replaceRuntime(entry.project)
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
  replaceRuntime(entry.project)
  refreshHistoryButtons()
  markDirty('Redo')
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
      const snapshot = snapshotFromResult(pulled)
      if (snapshot === undefined) throw new Error('saved workspace snapshot was not returned')
      setEditorDisabled(false)
      acceptSnapshot(snapshot.project, snapshot.revision, `Saved ${savedPath}`, snapshot.workspace)
    }).catch(error => {
      root.dataset.sync = 'error'
      save.disabled = false
      setEditorDisabled(false)
      status.textContent = error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (title.value.trim() === '') return
  const savedProjectId = projectId
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
      baseRevision: revision,
      project: nextProject,
    },
  }).then(async result => {
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
    history = [{ project: cloneProject(nextProject), pendingOperations: [] }]
    historyIndex = 0
    refreshHistoryButtons()
    setEditorDisabled(false)
    setClean(structured.revision)
    status.textContent = 'Saved'
  }).catch(error => {
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
    pointerStart = undefined
    return
  }
  pointerStart = { x: event.clientX, y: event.clientY }
})
canvas.addEventListener('pointermove', event => {
  if (root.dataset.playState === 'playing') updateRuntimePointer(event)
})
canvas.addEventListener('pointerup', event => {
  if (root.dataset.playState === 'playing') {
    updateRuntimePointer(event)
    return
  }
  if (pointerStart === undefined || transform?.dragging === true) return
  const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y)
  pointerStart = undefined
  if (distance > 4) return
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
  selectObject(raycaster.intersectObjects(meshes, false)[0]?.object)
})
canvas.addEventListener('pointercancel', event => {
  if (root.dataset.playState === 'playing') updateRuntimePointer(event)
  pointerStart = undefined
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
      void stopGame('Play failed')
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
}
Object.assign(window, {
  __THREE_M1__: diagnostics,
  __THREE_M2__: diagnostics,
  __THREE_M3__: diagnostics,
  __THREE_M4__: diagnostics,
  __THREE_M5__: diagnostics,
  __THREE_M6__: diagnostics,
})

void app.connect().then(() => {
  const context = app.getHostContext()
  const theme = context?.theme
  if (theme !== undefined) document.documentElement.dataset.theme = theme
  fullscreen.hidden = !context?.availableDisplayModes?.includes('fullscreen')
  setDisplayMode(context?.displayMode === 'fullscreen' ? 'fullscreen' : 'inline')
  pollTimer = window.setInterval(() => {
    void pullLatest().catch(error => {
      status.textContent = error instanceof Error ? error.message : String(error)
    })
  }, 1_000)
}).catch(error => {
  root.dataset.sync = 'error'
  status.textContent = error instanceof Error ? error.message : String(error)
})

import * as THREE from 'three'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { History } from '../vendor/three-editor/r185/editor/js/History.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { AddObjectCommand } from '../vendor/three-editor/r185/editor/js/commands/AddObjectCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { MultiCmdsCommand } from '../vendor/three-editor/r185/editor/js/commands/MultiCmdsCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetMaterialValueCommand } from '../vendor/three-editor/r185/editor/js/commands/SetMaterialValueCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetMaterialColorCommand } from '../vendor/three-editor/r185/editor/js/commands/SetMaterialColorCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetPositionCommand } from '../vendor/three-editor/r185/editor/js/commands/SetPositionCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetRotationCommand } from '../vendor/three-editor/r185/editor/js/commands/SetRotationCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetScaleCommand } from '../vendor/three-editor/r185/editor/js/commands/SetScaleCommand.js'
// @ts-expect-error Three.js Editor is pinned upstream JavaScript, verified by upstream.json.
import { SetValueCommand } from '../vendor/three-editor/r185/editor/js/commands/SetValueCommand.js'
import type { Project } from './projects.js'

type Listener = (...values: unknown[]) => void

class Signal {
  active = true
  readonly #listeners = new Set<Listener>()

  add(listener: Listener): void {
    this.#listeners.add(listener)
  }

  dispatch(...values: unknown[]): void {
    if (!this.active) return
    for (const listener of this.#listeners) listener(...values)
  }
}

type ProofEditor = {
  scene: THREE.Scene
  selected?: THREE.Object3D
  history: InstanceType<typeof History>
  config: { getKey(key: string): boolean }
  strings: { getKey(key: string): string }
  signals: Record<string, Signal>
  addObject(object: THREE.Object3D): void
  removeObject(object: THREE.Object3D): void
  select(object: THREE.Object3D): void
  deselect(): void
  objectByUuid(uuid: string): THREE.Object3D | undefined
  getObjectMaterial(object: THREE.Object3D, slot?: number): THREE.Material | undefined
}

export type EditorCommandOperation =
  | { type: 'set_position'; objectUuid: string; value: [number, number, number] }
  | { type: 'set_rotation'; objectUuid: string; value: [number, number, number] }
  | { type: 'set_scale'; objectUuid: string; value: [number, number, number] }
  | { type: 'set_name'; objectUuid: string; value: string }
  | { type: 'set_visible'; objectUuid: string; value: boolean }
  | { type: 'set_material_color'; objectUuid: string; value: string }
  | { type: 'set_material_value'; objectUuid: string; property: 'roughness'; value: number }

export interface EditorObjectSnapshot {
  uuid: string
  parentUuid?: string
  path: string
  name: string
  type: string
  visible: boolean
  position: [number, number, number]
  rotationDegrees: [number, number, number]
  scale: [number, number, number]
  color?: string
  commands: EditorCommandOperation['type'][]
}

function createEditor(inputScene?: THREE.Scene): ProofEditor {
  const scene = inputScene ?? new THREE.Scene()
  if (inputScene === undefined) {
    scene.uuid = '00000000-0000-4000-8000-000000000001'
  }
  const signals = Object.fromEntries([
    'historyChanged',
    'materialChanged',
    'objectAdded',
    'objectChanged',
    'objectRemoved',
    'sceneGraphChanged',
    'startPlayer',
    'stopPlayer',
  ].map(name => [name, new Signal()]))
  const editor = {
    scene,
    selected: undefined as THREE.Object3D | undefined,
    config: { getKey: (key: string) => key === 'settings/history' },
    strings: { getKey: (key: string) => key },
    signals,
    addObject(object: THREE.Object3D) {
      scene.add(object)
      signals.objectAdded?.dispatch(object)
      signals.sceneGraphChanged?.dispatch()
    },
    removeObject(object: THREE.Object3D) {
      object.removeFromParent()
      signals.objectRemoved?.dispatch(object)
      signals.sceneGraphChanged?.dispatch()
    },
    select(object: THREE.Object3D) {
      editor.selected = object
    },
    deselect() {
      editor.selected = undefined
    },
    objectByUuid(uuid: string) {
      return scene.getObjectByProperty('uuid', uuid)
    },
    getObjectMaterial(object: THREE.Object3D, slot?: number) {
      if (!(object instanceof THREE.Mesh)) return undefined
      if (!Array.isArray(object.material)) return object.material
      return slot === undefined || slot < 0 ? object.material[0] : object.material[slot]
    },
    history: undefined as unknown as InstanceType<typeof History>,
  } satisfies ProofEditor
  editor.history = new History(editor)
  return editor
}

function proofMesh(): THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial> {
  const geometry = new THREE.BoxGeometry()
  Object.defineProperty(geometry, 'uuid', {
    value: '00000000-0000-4000-8000-000000000002',
  })
  const material = new THREE.MeshStandardMaterial({ color: '#39d98a', roughness: 0.8 })
  Object.defineProperty(material, 'uuid', {
    value: '00000000-0000-4000-8000-000000000003',
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.uuid = '00000000-0000-4000-8000-000000000004'
  mesh.name = 'Proof Cube'
  return mesh
}

function sceneJson(editor: ProofEditor): string {
  editor.scene.updateMatrixWorld(true)
  return JSON.stringify(editor.scene.toJSON())
}

export function editorProjectFromSnapshots(
  project: Project,
  snapshots: EditorObjectSnapshot[],
): Project {
  const scene = new THREE.Scene()
  const objects = new Map<string, THREE.Object3D>()
  for (const snapshot of snapshots) {
    const object = snapshot.type === 'Mesh'
      ? new THREE.Mesh(
          new THREE.BufferGeometry(),
          snapshot.color === undefined
            ? new THREE.Material()
            : new THREE.MeshStandardMaterial({ color: snapshot.color }),
        )
      : new THREE.Group()
    object.uuid = snapshot.uuid
    object.name = snapshot.name
    object.visible = snapshot.visible
    object.position.fromArray(snapshot.position)
    object.rotation.set(...snapshot.rotationDegrees.map(THREE.MathUtils.degToRad) as [
      number,
      number,
      number,
    ])
    object.scale.fromArray(snapshot.scale)
    objects.set(snapshot.uuid, object)
  }
  for (const snapshot of snapshots) {
    const object = objects.get(snapshot.uuid)!
    const parent = snapshot.parentUuid === undefined
      ? scene
      : objects.get(snapshot.parentUuid)
    if (parent === undefined) {
      throw new Error(`unknown editor parent ${snapshot.parentUuid}`)
    }
    parent.add(object)
  }
  scene.updateMatrixWorld(true)
  return {
    ...structuredClone(project),
    scene: scene.toJSON() as unknown as Record<string, unknown>,
  }
}

function commandForOperation(
  editor: ProofEditor,
  operation: EditorCommandOperation,
): InstanceType<typeof SetPositionCommand> {
  const object = editor.objectByUuid(operation.objectUuid)
  if (object === undefined) throw new Error(`unknown object ${operation.objectUuid}`)
  if (operation.type === 'set_position') {
    return new SetPositionCommand(editor, object, new THREE.Vector3(...operation.value))
  }
  if (operation.type === 'set_rotation') {
    return new SetRotationCommand(
      editor,
      object,
      new THREE.Euler(...operation.value.map(THREE.MathUtils.degToRad)),
    )
  }
  if (operation.type === 'set_scale') {
    return new SetScaleCommand(editor, object, new THREE.Vector3(...operation.value))
  }
  if (operation.type === 'set_name') {
    return new SetValueCommand(editor, object, 'name', operation.value)
  }
  if (operation.type === 'set_visible') {
    return new SetValueCommand(editor, object, 'visible', operation.value)
  }
  if (operation.type === 'set_material_color') {
    return new SetMaterialColorCommand(
      editor,
      object,
      'color',
      new THREE.Color(operation.value).getHex(),
    )
  }
  return new SetMaterialValueCommand(
    editor,
    object,
    operation.property,
    operation.value,
  )
}

function applyEditorOperations(editor: ProofEditor, operations: EditorCommandOperation[]): void {
  const commands = operations.map(operation => {
    return commandForOperation(editor, operation)
  })
  editor.history.execute(new MultiCmdsCommand(editor, commands), 'MCP editor command batch')
}

export function inspectOfficialEditor(project: Project): Array<{
  uuid: string
  name: string
  type: string
  visible: boolean
  position: number[]
  rotationDegrees: number[]
  scale: number[]
  color?: string
  commands: string[]
}> {
  const scene = new THREE.ObjectLoader().parse(project.scene)
  if (!(scene instanceof THREE.Scene)) throw new Error('project scene is not a Three.js Scene')
  const objects: ReturnType<typeof inspectOfficialEditor> = []
  scene.traverse(object => {
    if (object === scene) return
    const material = object instanceof THREE.Mesh
      ? Array.isArray(object.material) ? object.material[0] : object.material
      : undefined
    const color = material !== undefined
      && 'color' in material
      && material.color instanceof THREE.Color
      ? `#${material.color.getHexString()}`
      : undefined
    objects.push({
      uuid: object.uuid,
      name: object.name || object.type,
      type: object.type,
      visible: object.visible,
      position: object.position.toArray(),
      rotationDegrees: [
        THREE.MathUtils.radToDeg(object.rotation.x),
        THREE.MathUtils.radToDeg(object.rotation.y),
        THREE.MathUtils.radToDeg(object.rotation.z),
      ],
      scale: object.scale.toArray(),
      ...color === undefined ? {} : { color },
      commands: [
        'set_position',
        'set_rotation',
        'set_scale',
        'set_name',
        'set_visible',
        ...color === undefined ? [] : ['set_material_color'],
      ],
    })
  })
  return objects
}

export function applyOfficialEditorCommands(
  project: Project,
  operations: EditorCommandOperation[],
): {
  project: Project
  commandTypes: string[]
  history: unknown
} {
  const scene = new THREE.ObjectLoader().parse(project.scene)
  if (!(scene instanceof THREE.Scene)) throw new Error('project scene is not a Three.js Scene')
  const editor = createEditor(scene)
  applyEditorOperations(editor, operations)
  scene.updateMatrixWorld(true)
  return {
    project: {
      ...structuredClone(project),
      scene: scene.toJSON() as unknown as Record<string, unknown>,
    },
    commandTypes: operations.map(operation => commandForOperation(editor, operation).type),
    history: editor.history.toJSON(),
  }
}

export interface OfficialCommandProof {
  upstream: 'three.js r185'
  commandTypes: string[]
  addObjectRoundTrip: boolean
  historyRoundTrip: boolean
  humanAiEquivalent: boolean
  batchUndoRedo: boolean
  finalPosition: number[]
  finalRoughness: number
}

export function officialCommandProof(): OfficialCommandProof {
  const addSource = createEditor()
  const add = new AddObjectCommand(addSource, proofMesh())
  const addJson = add.toJSON()
  const addTarget = createEditor()
  const restoredAdd = new AddObjectCommand(addTarget)
  restoredAdd.fromJSON(addJson)
  addTarget.history.execute(restoredAdd)
  const addedScene = sceneJson(addTarget)
  addTarget.history.undo()
  addTarget.history.redo()
  const addObjectRoundTrip = addedScene === sceneJson(addTarget)

  addTarget.history.undo()
  const serializedHistory = addTarget.history.toJSON()
  const historyTarget = createEditor()
  historyTarget.history.fromJSON(serializedHistory)
  historyTarget.history.redo()
  const historyRoundTrip = addedScene === sceneJson(historyTarget)

  const human = createEditor()
  human.addObject(proofMesh())
  const humanObject = human.objectByUuid('00000000-0000-4000-8000-000000000004')
  if (humanObject === undefined) throw new Error('proof object is missing')
  human.history.execute(new SetPositionCommand(
    human,
    humanObject,
    new THREE.Vector3(1.25, 2.5, -0.75),
  ))
  human.history.execute(new SetMaterialValueCommand(
    human,
    humanObject,
    'roughness',
    0.35,
  ))

  const ai = createEditor()
  ai.addObject(proofMesh())
  const baseline = sceneJson(ai)
  applyEditorOperations(ai, [
    {
      type: 'set_position',
      objectUuid: '00000000-0000-4000-8000-000000000004',
      value: [1.25, 2.5, -0.75],
    },
    {
      type: 'set_material_value',
      objectUuid: '00000000-0000-4000-8000-000000000004',
      property: 'roughness',
      value: 0.35,
    },
  ])
  const applied = sceneJson(ai)
  ai.history.undo()
  const undone = sceneJson(ai)
  ai.history.redo()
  const redone = sceneJson(ai)
  const final = ai.objectByUuid('00000000-0000-4000-8000-000000000004')
  if (!(final instanceof THREE.Mesh) || !(final.material instanceof THREE.MeshStandardMaterial)) {
    throw new Error('proof material is missing')
  }

  return {
    upstream: 'three.js r185',
    commandTypes: [
      'AddObjectCommand',
      'SetPositionCommand',
      'SetMaterialValueCommand',
      'MultiCmdsCommand',
      'History',
    ],
    addObjectRoundTrip,
    historyRoundTrip,
    humanAiEquivalent: sceneJson(human) === applied,
    batchUndoRedo: undone === baseline && redone === applied,
    finalPosition: final.position.toArray(),
    finalRoughness: final.material.roughness,
  }
}

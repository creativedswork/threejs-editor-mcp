import type { EditorCommandOperation } from './official-editor.js'

export const M7_RUNTIME_CHANNEL = 'threejs-editor-m7-runtime'
export const WORKSPACE_EDITOR_STATE_PATH = 'threejs.editor.json'

export interface WorkspaceEditorState {
  schemaVersion: 1
  operations: EditorCommandOperation[]
}

export interface M7RuntimeEvent {
  channel: typeof M7_RUNTIME_CHANNEL
  runId: string
  nonce: string
  type: string
  data?: Record<string, unknown>
}

export function stableEditorUuid(value: string): string {
  const hash = (seed: number): number => {
    let result = seed >>> 0
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619) >>> 0
    }
    return result
  }
  const bytes = new Uint8Array(16)
  for (let block = 0; block < 4; block += 1) {
    const value = hash(2166136261 ^ Math.imul(block + 1, 0x9e3779b1))
    bytes[block * 4] = value >>> 24
    bytes[block * 4 + 1] = value >>> 16
    bytes[block * 4 + 2] = value >>> 8
    bytes[block * 4 + 3] = value
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export function m7BootstrapHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html,body,canvas{margin:0;width:100%;height:100%;display:block;overflow:hidden;background:#02050a}
    canvas{touch-action:none}
  </style>
</head>
<body>
  <canvas aria-label="Three.js Workspace editor canvas"></canvas>
  <script>
  (() => {
    const channel = ${JSON.stringify(M7_RUNTIME_CHANNEL)}
    const stableEditorUuid = ${stableEditorUuid.toString()}
    const canvas = document.querySelector('canvas')
    let active
    let bundleUrl

    const emit = (runId, nonce, type, data = {}) => {
      window.parent.postMessage({ channel, runId, nonce, type, data }, '*')
    }
    const message = error => error instanceof Error
      ? error.stack || error.message
      : String(error)
    const editableMaterial = object => {
      if (!object?.isMesh) return
      const material = Array.isArray(object.material) ? object.material[0] : object.material
      return material && material.color?.isColor ? material : undefined
    }
    const snapshotObject = (current, object) => {
      const material = editableMaterial(object)
      return {
        uuid: object.uuid,
        ...(current.parents.get(object.uuid)
          ? { parentUuid: current.parents.get(object.uuid) }
          : {}),
        path: current.paths.get(object.uuid),
        name: object.name || object.type,
        type: object.type,
        visible: object.visible,
        position: object.position.toArray(),
        rotationDegrees: [
          current.THREE.MathUtils.radToDeg(object.rotation.x),
          current.THREE.MathUtils.radToDeg(object.rotation.y),
          current.THREE.MathUtils.radToDeg(object.rotation.z),
        ],
        scale: object.scale.toArray(),
        ...(material ? { color: '#' + material.color.getHexString() } : {}),
        commands: [
          'set_position',
          'set_rotation',
          'set_scale',
          'set_name',
          'set_visible',
          ...(material ? ['set_material_color'] : []),
        ],
      }
    }
    const editorScene = current => ({
      objects: current.objectOrder.map(object => snapshotObject(current, object)),
      selectedUuid: current.selected?.uuid,
    })
    const metrics = current => ({
      frame: current.frame,
      mode: current.mode,
      editorObjectCount: current.objectOrder.length,
      selectedUuid: current.selected?.uuid,
      rendererCount: 1,
      secureContext: isSecureContext,
      webgpuApi: Boolean(navigator.gpu),
      rendererBackend:
        current.renderer.backend?.constructor?.name
        ?? current.renderer.constructor.name,
      draws: current.renderer.info?.render?.calls ?? 0,
      triangles: current.renderer.info?.render?.triangles ?? 0,
      ...(typeof current.example?.metrics === 'function'
        ? current.example.metrics()
        : {}),
    })
    const resize = current => {
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const dpr = Math.min(devicePixelRatio || 1, 2)
      const expectedWidth = Math.round(width * dpr)
      const expectedHeight = Math.round(height * dpr)
      const size = new current.THREE.Vector2()
      current.renderer.getDrawingBufferSize(size)
      if (size.x === expectedWidth && size.y === expectedHeight) return
      current.renderer.setPixelRatio(dpr)
      current.renderer.setSize(width, height, false)
      if (current.camera.isPerspectiveCamera) {
        current.camera.aspect = width / height
        current.camera.updateProjectionMatrix()
      }
      current.example?.resize?.({
        width,
        height,
        bufferWidth: expectedWidth,
        bufferHeight: expectedHeight,
        dpr,
      })
    }
    const indexScene = current => {
      current.objects = new Map()
      current.parents = new Map()
      current.paths = new Map()
      current.objectOrder = []
      const visit = (parent, parentPath, parentUuid) => {
        const occurrences = new Map()
        for (const object of parent.children) {
          if (object.userData?.editorHelper === true) continue
          const base = String(object.userData?.editorId || object.name || object.type)
          const occurrence = occurrences.get(base) ?? 0
          occurrences.set(base, occurrence + 1)
          const path = parentPath + '/' + encodeURIComponent(base) + '#' + occurrence
          object.uuid = stableEditorUuid(path)
          current.objects.set(object.uuid, object)
          current.paths.set(object.uuid, path)
          if (parentUuid) current.parents.set(object.uuid, parentUuid)
          current.objectOrder.push(object)
          visit(object, path, object.uuid)
        }
      }
      visit(current.scene, 'scene', undefined)
    }
    const operationForObject = (current, object, mode) => {
      if (mode === 'rotate') {
        return {
          type: 'set_rotation',
          objectUuid: object.uuid,
          value: [
            current.THREE.MathUtils.radToDeg(object.rotation.x),
            current.THREE.MathUtils.radToDeg(object.rotation.y),
            current.THREE.MathUtils.radToDeg(object.rotation.z),
          ],
        }
      }
      return {
        type: mode === 'scale' ? 'set_scale' : 'set_position',
        objectUuid: object.uuid,
        value: (mode === 'scale' ? object.scale : object.position).toArray(),
      }
    }
    const applyOperation = (current, operation, notify = true) => {
      const object = current.objects.get(operation?.objectUuid)
      if (!object) throw new Error('Unknown Runtime editor object ' + operation?.objectUuid)
      if (operation.type === 'set_position') {
        object.position.fromArray(operation.value)
      } else if (operation.type === 'set_rotation') {
        object.rotation.set(...operation.value.map(current.THREE.MathUtils.degToRad))
      } else if (operation.type === 'set_scale') {
        object.scale.fromArray(operation.value)
      } else if (operation.type === 'set_name') {
        object.name = operation.value
      } else if (operation.type === 'set_visible') {
        object.visible = operation.value
      } else if (operation.type === 'set_material_color') {
        const material = editableMaterial(object)
        if (!material) throw new Error('Runtime editor object has no editable color')
        material.color.set(operation.value)
        material.needsUpdate = true
      } else if (operation.type === 'set_material_value'
        && operation.property === 'roughness') {
        const material = editableMaterial(object)
        if (!material || !('roughness' in material)) {
          throw new Error('Runtime editor object has no editable roughness')
        }
        material.roughness = operation.value
        material.needsUpdate = true
      } else {
        throw new Error('Unsupported Runtime editor operation ' + operation?.type)
      }
      object.updateMatrix()
      current.scene.updateMatrixWorld(true)
      if (notify) {
        emit(current.runId, current.nonce, 'editor-object', {
          object: snapshotObject(current, object),
        })
      }
      return object
    }
    const selectObject = (current, uuid, notify = true) => {
      const object = typeof uuid === 'string' ? current.objects.get(uuid) : undefined
      current.selected = object
      current.transform.detach()
      if (object) current.transform.attach(object)
      if (notify) {
        emit(current.runId, current.nonce, 'editor-selection', {
          selectedUuid: object?.uuid,
        })
      }
    }
    const setMode = (current, mode) => {
      current.mode = mode === 'run' ? 'run' : 'edit'
      current.state.paused = current.mode === 'edit'
      current.previous = performance.now()
      current.transform.enabled = current.mode === 'edit'
      current.transformHelper.visible = current.mode === 'edit'
      if (current.mode === 'run') selectObject(current, undefined)
      emit(current.runId, current.nonce, 'mode', { mode: current.mode })
    }
    const dispose = async (runId, nonce, notify = true) => {
      const current = active
      active = undefined
      if (current) {
        current.stopped = true
        cancelAnimationFrame(current.animation)
        current.renderer.setAnimationLoop?.(null)
        current.transform.detach()
        current.transformHelper.removeFromParent()
        current.transform.dispose()
        await current.example?.dispose?.()
        current.controls?.dispose()
        current.renderer.dispose()
      }
      if (bundleUrl) URL.revokeObjectURL(bundleUrl)
      bundleUrl = undefined
      if (notify) emit(runId, nonce, 'disposed', current ? metrics(current) : {})
    }
    const start = async request => {
      const { runId, nonce } = request
      await dispose(runId, nonce, false)
      let current
      try {
        bundleUrl = URL.createObjectURL(new Blob(
          [request.bundle],
          { type: 'text/javascript' },
        ))
        const module = await import(bundleUrl)
        const {
          adapter,
          THREE,
          OrbitControls,
          TransformControls,
          editorState,
        } = module
        if (!adapter || typeof adapter.setup !== 'function') {
          throw new Error('Workspace entry must default-export an adapter with setup(context)')
        }
        if (adapter.backend === 'raw-webgpu' || request.backend === 'raw-webgpu') {
          throw new Error('raw-webgpu runtime is outside the M7 profile')
        }
        const backend = adapter.backend ?? request.backend
        const options = {
          canvas,
          antialias: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true,
          ...(adapter.renderer?.options ?? {}),
        }
        const renderer = backend === 'webgpu'
          ? new THREE.WebGPURenderer(options)
          : new THREE.WebGLRenderer(options)
        if (typeof renderer.init === 'function') await renderer.init()
        renderer.outputColorSpace =
          adapter.renderer?.outputColorSpace ?? THREE.SRGBColorSpace
        renderer.toneMapping =
          adapter.renderer?.toneMapping ?? THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = adapter.renderer?.exposure ?? 1
        if (adapter.renderer?.clearColor != null) {
          renderer.setClearColor(
            adapter.renderer.clearColor,
            adapter.renderer.clearAlpha ?? 1,
          )
        }

        const scene = new THREE.Scene()
        const cameraConfig = adapter.camera ?? {}
        const camera = cameraConfig.type === 'orthographic'
          ? new THREE.OrthographicCamera(
              cameraConfig.left ?? -1,
              cameraConfig.right ?? 1,
              cameraConfig.top ?? 1,
              cameraConfig.bottom ?? -1,
              cameraConfig.near ?? 0,
              cameraConfig.far ?? 1,
            )
          : new THREE.PerspectiveCamera(
              cameraConfig.fov ?? 50,
              1,
              cameraConfig.near ?? 0.1,
              cameraConfig.far ?? 2000,
            )
        if (cameraConfig.position) camera.position.fromArray(cameraConfig.position)
        if (cameraConfig.up) camera.up.fromArray(cameraConfig.up)

        const controlsConfig = adapter.controls ?? {}
        const controls = controlsConfig.enabled === false
          || cameraConfig.type === 'orthographic'
          ? null
          : new OrbitControls(camera, canvas)
        if (controls) {
          controls.enableDamping = controlsConfig.enableDamping ?? true
          controls.dampingFactor = controlsConfig.dampingFactor ?? 0.08
          controls.enablePan = controlsConfig.enablePan ?? true
          controls.screenSpacePanning = controlsConfig.screenSpacePanning ?? true
          controls.minDistance = controlsConfig.minDistance ?? 0
          controls.maxDistance = controlsConfig.maxDistance ?? Infinity
          controls.minPolarAngle = controlsConfig.minPolarAngle ?? 0
          controls.maxPolarAngle = controlsConfig.maxPolarAngle ?? Math.PI
          controls.minAzimuthAngle = controlsConfig.minAzimuthAngle ?? -Infinity
          controls.maxAzimuthAngle = controlsConfig.maxAzimuthAngle ?? Infinity
          controls.target.fromArray(controlsConfig.target ?? [0, 0, 0])
          controls.update()
        }

        current = {
          runId,
          nonce,
          THREE,
          renderer,
          scene,
          camera,
          controls,
          transform: undefined,
          transformHelper: undefined,
          transformMode: 'translate',
          transformDragging: false,
          selected: undefined,
          objects: new Map(),
          parents: new Map(),
          paths: new Map(),
          objectOrder: [],
          example: undefined,
          mode: request.mode === 'run' ? 'run' : 'edit',
          state: {
            debugMode: request.debugMode ?? 'final',
            paused: request.mode !== 'run',
            dpr: Math.min(devicePixelRatio || 1, 2),
            timeScale: 1,
          },
          frame: 0,
          elapsed: adapter.initialTime ?? 0,
          previous: performance.now(),
          animation: 0,
          stopped: false,
          frameInProgress: false,
        }
        active = current
        current.example = await adapter.setup({
          THREE,
          canvas,
          renderer,
          scene,
          camera,
          controls,
          runtime: {
            get state() { return { ...current.state } },
            reportMetrics(value) { emit(runId, nonce, 'metrics', value) },
            reportStatus(status, detail = {}) {
              emit(runId, nonce, 'status', { status, ...detail })
            },
          },
          moduleUrl: new URL('workspace:///entry'),
          resolveAsset(path) { return path },
        }) ?? {}
        current.example.setDebugMode?.(current.state.debugMode)
        indexScene(current)
        for (const operation of editorState?.operations ?? []) {
          applyOperation(current, operation, false)
        }

        current.transform = new TransformControls(camera, canvas)
        current.transform.setMode(current.transformMode)
        current.transform.setSize(0.78)
        current.transformHelper = current.transform.getHelper()
        current.transformHelper.userData.editorHelper = true
        current.transformHelper.visible = current.mode === 'edit'
        scene.add(current.transformHelper)
        current.transform.addEventListener('dragging-changed', event => {
          current.transformDragging = event.value === true
          if (current.controls) current.controls.enabled = !current.transformDragging
        })
        current.transform.addEventListener('objectChange', () => {
          if (!current.selected) return
          emit(runId, nonce, 'editor-object', {
            object: snapshotObject(current, current.selected),
          })
        })
        current.transform.addEventListener('mouseUp', () => {
          if (!current.selected) return
          emit(runId, nonce, 'editor-commit', {
            operation: operationForObject(
              current,
              current.selected,
              current.transformMode,
            ),
          })
        })
        emit(runId, nonce, 'editor-scene', editorScene(current))

        const render = async now => {
          if (current.stopped || current.frameInProgress) return
          current.frameInProgress = true
          try {
            resize(current)
            const rawDelta = Math.min((now - current.previous) / 1000, 0.1)
            current.previous = now
            const delta = current.mode === 'run'
              ? rawDelta * current.state.timeScale
              : 0
            if (current.mode === 'run') {
              current.elapsed += delta
              await current.example.update?.({
                delta,
                rawDelta,
                elapsed: current.elapsed,
                state: current.state,
                camera: current.camera,
                controls: current.controls,
              })
            }
            current.controls?.update()
            if (current.example.render) {
              await current.example.render({
                renderer: current.renderer,
                scene: current.scene,
                camera: current.camera,
                elapsed: current.elapsed,
                delta,
                rawDelta,
                state: current.state,
              })
            } else if (typeof current.renderer.renderAsync === 'function') {
              await current.renderer.renderAsync(current.scene, current.camera)
            } else {
              current.renderer.render(current.scene, current.camera)
            }
            current.frame += 1
            if (current.pendingDebugMode !== undefined) {
              emit(runId, nonce, 'debug-mode', {
                debugMode: current.pendingDebugMode,
                frame: current.frame,
              })
              current.pendingDebugMode = undefined
            }
            const evidence = metrics(current)
            if (current.frame === 1) {
              emit(runId, nonce, 'ready', { backend, ...evidence })
            } else if (current.frame % 30 === 0) {
              emit(runId, nonce, 'frame', evidence)
              emit(runId, nonce, 'metrics', evidence)
            }
          } catch (error) {
            current.stopped = true
            emit(runId, nonce, 'runtime-error', { message: message(error) })
          } finally {
            current.frameInProgress = false
            if (!current.stopped) current.animation = requestAnimationFrame(render)
          }
        }
        current.animation = requestAnimationFrame(render)
      } catch (error) {
        if (current) await dispose(runId, nonce, false)
        emit(runId, nonce, 'runtime-error', { message: message(error) })
      }
    }

    canvas.addEventListener('pointerdown', event => {
      const current = active
      if (!current || current.mode !== 'edit' || current.transformDragging) return
      const bounds = canvas.getBoundingClientRect()
      const pointer = new current.THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      const raycaster = new current.THREE.Raycaster()
      raycaster.setFromCamera(pointer, current.camera)
      const hit = raycaster.intersectObjects(current.scene.children, true)
        .find(result => current.objects.has(result.object.uuid))
      selectObject(current, hit?.object.uuid)
    })
    window.addEventListener('error', event => {
      if (!active) return
      event.preventDefault()
      emit(active.runId, active.nonce, 'runtime-error', {
        message: event.error?.stack || event.message,
      })
    })
    window.addEventListener('unhandledrejection', event => {
      if (!active) return
      event.preventDefault()
      emit(active.runId, active.nonce, 'runtime-error', {
        message: message(event.reason),
      })
    })
    window.addEventListener('message', async event => {
      if (event.source !== window.parent) return
      const request = event.data
      if (!request || request.channel !== channel) return
      const { action, runId, nonce } = request
      if (action === 'run') {
        await start(request)
        return
      }
      if (!active || active.runId !== runId || active.nonce !== nonce) return
      if (action === 'stop') {
        await dispose(runId, nonce)
      } else if (action === 'set-debug') {
        active.state.debugMode = request.debugMode
        active.example?.setDebugMode?.(request.debugMode)
        active.pendingDebugMode = request.debugMode
      } else if (action === 'set-mode') {
        setMode(active, request.mode)
      } else if (action === 'set-transform-mode') {
        active.transformMode = request.mode
        active.transform.setMode(request.mode)
      } else if (action === 'select-object') {
        selectObject(active, request.objectUuid, false)
      } else if (action === 'apply-operation') {
        applyOperation(active, request.operation)
      } else if (action === 'apply-operations') {
        for (const operation of request.operations ?? []) {
          applyOperation(active, operation, false)
        }
        emit(runId, nonce, 'editor-scene', editorScene(active))
      } else if (action === 'editor-scene') {
        emit(runId, nonce, 'editor-scene', editorScene(active))
      } else if (action === 'metrics') {
        emit(runId, nonce, 'metrics', metrics(active))
      }
    })
    window.addEventListener('pagehide', () => {
      if (active) void dispose(active.runId, active.nonce, false)
    }, { once: true })
  })()
  </script>
</body>
</html>`
}

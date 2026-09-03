import type { EditorCommandOperation } from './official-editor.js'

export const M7_RUNTIME_CHANNEL = 'threejs-editor-m7-runtime'
export const WORKSPACE_EDITOR_STATE_PATH = 'threejs.editor.json'
export const RUNTIME_COMMAND_MIN_TIMEOUT_MS = 2_000
export const RUNTIME_COMMAND_SETTLEMENT_GRACE_MS = 2_000

export function runtimeCommandSettlementDeadline(expiresAt: string): number {
  return Date.parse(expiresAt) + RUNTIME_COMMAND_SETTLEMENT_GRACE_MS
}

export interface WorkspaceEditorState {
  schemaVersion: 1
  operations: EditorCommandOperation[]
  qualityTier?: string
  recentChanges?: Array<{
    source: 'human' | 'ai' | 'unknown'
    operation: EditorCommandOperation
  }>
}

export interface M7RuntimeEvent {
  channel: typeof M7_RUNTIME_CHANNEL
  epoch: number
  projectId: string
  runId: string
  nonce: string
  revision: string
  type: string
  data?: Record<string, unknown>
}

export function rolloverCleanupRevisions(
  previousRevision: string,
  nextRevision: string,
  runtimeAdvanced: boolean,
): { iframeRevision: string; serverRevision: string } {
  return {
    iframeRevision: runtimeAdvanced ? nextRevision : previousRevision,
    serverRevision: nextRevision,
  }
}

export interface PointerPickGesture {
  pointerId: number
  x: number
  y: number
  moved: boolean
  blocked: boolean
  pickIds?: string[]
}

export function shouldPickAfterPointerGesture(
  gesture: PointerPickGesture | undefined,
  pointerId: number,
  clientX: number,
  clientY: number,
  transformDragging: boolean,
): boolean {
  return gesture !== undefined
    && gesture.pointerId === pointerId
    && !gesture.moved
    && !gesture.blocked
    && !transformDragging
    && Math.hypot(clientX - gesture.x, clientY - gesture.y) <= 4
}

export function installOwnedAssetFetch(
  target: { fetch: typeof fetch },
  ownedAssets: Map<string, Blob>,
): () => void {
  const originalFetch = target.fetch
  target.fetch = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const blob = ownedAssets.get(url)
    return blob === undefined
      ? originalFetch.call(target, input, init)
      : Promise.resolve(new Response(blob))
  }
  return () => {
    ownedAssets.clear()
    target.fetch = originalFetch
  }
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
    const shouldPickAfterPointerGesture = ${shouldPickAfterPointerGesture.toString()}
    const installOwnedAssetFetch = ${installOwnedAssetFetch.toString()}
    const canvas = document.querySelector('canvas')
    let active
    let starting
    let lastDisposed
    let bundleUrl
    let assetUrls = new Map()
    let assetBlobs = new Map()
    let restoreAssetFetch
    let eventProjectId
    let eventRevision
    let eventEpoch = 0
    let logCursor = 0
    const logs = []
    const cancelledHarnessCommands = new Set()


    const emit = (
      runId,
      nonce,
      type,
      data = {},
      revision = eventRevision,
      projectId = eventProjectId,
    ) => {
      window.parent.postMessage({
        channel,
        epoch: eventEpoch,
        projectId,
        runId,
        nonce,
        revision,
        type,
        data,
      }, '*')
    }
    const message = error => error instanceof Error
      ? error.stack || error.message
      : String(error)
    const logValue = value => {
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    const appendLog = (level, values) => {
      logs.push({
        cursor: logCursor,
        timestamp: new Date().toISOString(),
        level,
        message: values.map(logValue).join(' ').slice(0, 2048),
      })
      logCursor += 1
      if (logs.length > 2000) logs.splice(0, logs.length - 2000)
    }
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...values) => {
        original(...values)
        if (active) appendLog(level, values)
      }
    }
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      const current = active
      if (!current || current.stopped) return
      current.stopped = true
      appendLog('error', ['WebGL context lost; restart the Runtime to recover'])
      emit(current.runId, current.nonce, 'runtime-error', {
        message: 'WebGL context lost; restart the Runtime to recover',
        code: 'webgl-context-lost',
        recoverable: true,
        fatal: true,
      })
    })
    canvas.addEventListener('webglcontextrestored', () => {
      if (active) appendLog('info', ['WebGL context restored'])
    })
    const runtimeInputEvents = new Set([
      'click',
      'contextmenu',
      'dblclick',
      'gotpointercapture',
      'lostpointercapture',
      'mousedown',
      'mousemove',
      'mouseup',
      'pointercancel',
      'pointerdown',
      'pointerenter',
      'pointerleave',
      'pointermove',
      'pointerout',
      'pointerover',
      'pointerrawupdate',
      'pointerup',
      'touchcancel',
      'touchend',
      'touchmove',
      'touchstart',
      'wheel',
    ])
    const listenerCapture = options => typeof options === 'boolean'
      ? options
      : options?.capture === true
    const callListener = (listener, event, target) => typeof listener === 'function'
      ? listener.call(target, event)
      : listener.handleEvent(event)
    const createRuntimeInputEvent = (current, event) => new Proxy(event, {
      get(target, property) {
        if (property === 'currentTarget') return current.runtimeCanvas
        if (property === 'target' || property === 'srcElement') {
          return Reflect.get(target, property, target) === canvas
            ? current.runtimeCanvas
            : Reflect.get(target, property, target)
        }
        if (property === 'composedPath') {
          return () => target.composedPath().map(item => (
            item === canvas ? current.runtimeCanvas : item
          ))
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const createRuntimeCanvas = current => new Proxy(canvas, {
      get(target, property) {
        if (property === 'addEventListener') {
          return (type, listener, options) => {
            if (!runtimeInputEvents.has(type) || listener == null) {
              target.addEventListener(type, listener, options)
              return
            }
            const capture = listenerCapture(options)
            if (current.runtimeInputListeners.some(record => (
              record.type === type
              && record.listener === listener
              && record.capture === capture
            ))) return
            const once = typeof options === 'object' && options?.once === true
            const signal = typeof options === 'object' ? options?.signal : undefined
            if (signal?.aborted) return
            const targetOptions = typeof options === 'boolean'
              ? options
              : { ...options, once: false, signal: undefined }
            let record
            const remove = () => {
              const index = current.runtimeInputListeners.indexOf(record)
              if (index !== -1) current.runtimeInputListeners.splice(index, 1)
              target.removeEventListener(type, wrapped, capture)
              signal?.removeEventListener('abort', remove)
            }
            const wrapped = event => {
              if (!current.stopped && current.mode === 'run') {
                current.runtimeInputEvents.set(
                  type,
                  (current.runtimeInputEvents.get(type) ?? 0) + 1,
                )
                try {
                  const runtimeEvent = createRuntimeInputEvent(current, event)
                  current.runtimeEventFacade = runtimeEvent.currentTarget === current.runtimeCanvas
                    && runtimeEvent.target === current.runtimeCanvas
                  callListener(listener, runtimeEvent, current.runtimeCanvas)
                } finally {
                  if (once) remove()
                }
              }
            }
            record = {
              type,
              listener,
              capture,
              options: targetOptions,
              wrapped,
              remove,
            }
            current.runtimeInputListeners.push(record)
            target.addEventListener(type, wrapped, targetOptions)
            signal?.addEventListener('abort', remove, { once: true })
          }
        }
        if (property === 'removeEventListener') {
          return (type, listener, options) => {
            const capture = listenerCapture(options)
            const index = current.runtimeInputListeners.findIndex(record => (
              record.type === type
              && record.listener === listener
              && record.capture === capture
            ))
            if (index === -1) {
              target.removeEventListener(type, listener, options)
              return
            }
            current.runtimeInputListeners[index].remove()
          }
        }
        if (property === 'setPointerCapture') {
          return pointerId => {
            if (current.mode !== 'run') return
            target.setPointerCapture(pointerId)
            current.runtimeCapturedPointers.add(pointerId)
          }
        }
        if (property === 'releasePointerCapture') {
          return pointerId => {
            current.runtimeCapturedPointers.delete(pointerId)
            if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
          }
        }
        if (property === 'matches') {
          return selector => selector === ':hover'
            ? current.mode === 'run' && target.matches(selector)
            : target.matches(selector)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const createRuntimeRenderer = (renderer, runtimeCanvas) => new Proxy(renderer, {
      get(target, property) {
        if (property === 'domElement') return runtimeCanvas
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target)
      },
    })
    const cancelRuntimeInput = current => {
      if (current.mode !== 'run') return
      for (const pointerId of [...current.runtimeCapturedPointers]) {
        canvas.dispatchEvent(new PointerEvent('pointercancel', {
          pointerId,
          pointerType: 'touch',
        }))
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
      }
      current.runtimeCapturedPointers.clear()
      canvas.dispatchEvent(new PointerEvent('pointerout', {
        pointerId: -1,
        pointerType: 'mouse',
      }))
    }
    const disposeRuntimeCanvas = current => {
      for (const record of [...current.runtimeInputListeners]) record.remove()
      current.runtimeCapturedPointers.clear()
    }
    const objectMaterial = object => {
      if (!object?.isMesh) return
      return Array.isArray(object.material) ? object.material[0] : object.material
    }
    const editableMaterial = object => {
      const material = objectMaterial(object)
      return material && material.color?.isColor ? material : undefined
    }
    const materialSnapshot = object => {
      const material = objectMaterial(object)
      if (!material) return
      const properties = []
      if (material.color?.isColor) {
        properties.push({
          name: 'color',
          kind: 'color',
          value: '#' + material.color.getHexString(),
          command: 'set_material_color',
        })
      }
      for (const name of ['roughness', 'metalness', 'opacity']) {
        if (typeof material[name] !== 'number' || !Number.isFinite(material[name])) continue
        properties.push({
          name,
          kind: 'number',
          value: material[name],
          min: 0,
          max: 1,
          command: 'set_material_value',
        })
      }
      for (const name of ['transparent', 'wireframe']) {
        if (typeof material[name] !== 'boolean') continue
        properties.push({
          name,
          kind: 'boolean',
          value: material[name],
          command: 'set_material_boolean',
        })
      }
      if (properties.length === 0) return
      return {
        uuid: material.uuid,
        type: material.type,
        ...(material.name ? { name: material.name } : {}),
        properties,
      }
    }
    const snapshotObject = (current, object) => {
      const material = editableMaterial(object)
      const materialDetail = materialSnapshot(object)
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
        ...(materialDetail ? { material: materialDetail } : {}),
        commands: [
          'set_position',
          'set_rotation',
          'set_scale',
          'set_name',
          'set_visible',
          ...(material ? ['set_material_color'] : []),
          ...(materialDetail?.properties.some(property => (
            property.command === 'set_material_value'
          )) ? ['set_material_value'] : []),
          ...(materialDetail?.properties.some(property => (
            property.command === 'set_material_boolean'
          )) ? ['set_material_boolean'] : []),
        ],
      }
    }
    const editorScene = current => ({
      objects: current.objectOrder.map(object => snapshotObject(current, object)),
      selectedUuid: current.selected?.uuid,
    })
    const captureEditState = current => ({
      viewState: {
        cameraPosition: current.camera.position.toArray(),
        cameraQuaternion: current.camera.quaternion.toArray(),
        cameraUp: current.camera.up.toArray(),
        cameraZoom: current.camera.zoom,
        controlsTarget: current.controls?.target.toArray(),
      },
      selectedUuid: current.selected?.uuid,
    })
    const selectedScreenPosition = current => {
      if (!current.selected) return null
      const point = objectCenterWorld(current, current.selected)
      point.project(current.camera)
      return [
        ((point.x + 1) / 2) * canvas.clientWidth,
        ((1 - point.y) / 2) * canvas.clientHeight,
      ]
    }
    const metrics = current => {
      const drawingBufferSize = new current.THREE.Vector2()
      current.renderer.getDrawingBufferSize(drawingBufferSize)
      let gpuRenderer
      let gpuRendererUnmasked = false
      try {
        const context = current.renderer.getContext?.()
        const debug = context?.getExtension?.('WEBGL_debug_renderer_info')
        if (debug) {
          gpuRenderer = context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          gpuRendererUnmasked = true
        }
      } catch {}
      return {
      frame: current.frame,
      mode: current.mode,
      cameraPosition: current.camera.position.toArray(),
      cameraQuaternion: current.camera.quaternion.toArray(),
      cameraUp: current.camera.up.toArray(),
      cameraZoom: current.camera.zoom,
      controlsTarget: current.controls?.target.toArray(),
      editorObjectCount: current.objectOrder.length,
      selectedUuid: current.selected?.uuid,
      selectedScreenPosition: selectedScreenPosition(current),
      selectedBoundsCenter: current.selected
        ? objectCenterWorld(current, current.selected).toArray()
        : null,
      gizmoWorldPosition: current.transformPivot
        ? current.transformPivot.getWorldPosition(new current.THREE.Vector3()).toArray()
        : null,
      transformAxis: current.transform?.axis ?? null,
      transformDragging: current.transformDragging,
      lastPointerPick: current.lastPointerPick,
      inputOwner: current.mode === 'run' ? 'runtime' : 'editor',
      runtimeInputListeners: current.runtimeInputListeners.length,
      runtimeInputEvents: Object.fromEntries(current.runtimeInputEvents),
      runtimeEventFacade: current.runtimeEventFacade,
      capturedPointers: current.runtimeCapturedPointers.size,
      rendererCanvasFacade: current.runtimeRenderer.domElement !== canvas,
      resizeCount: current.resizeCount,
      devicePixelRatio: current.state.dpr,
      clientSize: [canvas.clientWidth, canvas.clientHeight],
      drawingBufferSize: drawingBufferSize.toArray(),
      gpuTextures: current.renderer.info?.memory?.textures ?? 0,
      gpuGeometries: current.renderer.info?.memory?.geometries ?? 0,
      gpuPrograms: current.renderer.info?.programs?.length ?? 0,
      rendererCount: 1,
      secureContext: isSecureContext,
      webgpuApi: Boolean(navigator.gpu),
      rendererBackend:
        current.renderer.backend?.constructor?.name
        ?? current.renderer.constructor.name,
      renderPath: current.state.debugMode === 'no-post'
        ? 'direct-renderer'
        : current.example?.render
          ? 'example-render'
          : 'default-renderer',
      buildId: current.buildId,
      qualityTier: current.state.qualityTier,
      debugMode: current.state.debugMode,
      gpuRenderer,
      gpuRendererUnmasked,
      draws: current.renderer.info?.render?.calls ?? 0,
      triangles: current.renderer.info?.render?.triangles ?? 0,
      ...(typeof current.example?.metrics === 'function'
        ? current.example.metrics()
        : {}),
      }
    }
    const sha256 = async bytes => [...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes),
    )].map(value => value.toString(16).padStart(2, '0')).join('')
    const evidenceRuntime = (current, target) => ({
      projectId: current.projectId,
      revision: current.revision,
      buildId: current.buildId,
      runId: current.runId,
      nonce: current.nonce,
      target,
    })
    const captureFrame = async (current, request) => {
      const deterministic = request.deterministic === true
      const previousTimeScale = current.state.timeScale
      const previousCapturePaused = current.capturePaused
      try {
        if (deterministic) {
          current.state.timeScale = 0
          current.capturePaused = true
          cancelAnimationFrame(current.animation)
          await current.framePromise
        }
        const maxWidth = Math.max(64, Math.min(1024, Number(request.maxWidth) || 768))
        const maxHeight = Math.max(64, Math.min(1024, Number(request.maxHeight) || 768))
        const widthScale = maxWidth / Math.max(1, canvas.width)
        const heightScale = maxHeight / Math.max(1, canvas.height)
        const scale = Math.min(1, widthScale, heightScale)
        const width = Math.max(1, Math.round(canvas.width * scale))
        const height = Math.max(1, Math.round(canvas.height * scale))
        const output = document.createElement('canvas')
        output.width = width
        output.height = height
        output.getContext('2d').drawImage(canvas, 0, 0, width, height)
        const mimeType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png'
        const url = output.toDataURL(mimeType, 0.9)
        const data = url.slice(url.indexOf(',') + 1)
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
        if (data.length > 512 * 1024) throw new Error('Runtime frame exceeds the evidence limit')
        return {
          kind: 'capture-frame',
          runtime: evidenceRuntime(current, request.target),
          evidenceId: crypto.randomUUID(),
          evidenceToken: request.evidenceToken,
          digest: await sha256(bytes),
          mimeType,
          data,
          width,
          height,
          frame: current.frame,
          deterministic,
          qualityTier: current.state.qualityTier,
          debugMode: current.state.debugMode,
          capturedAt: new Date().toISOString(),
        }
      } finally {
        if (deterministic && !current.stopped) {
          current.state.timeScale = previousTimeScale
          current.capturePaused = previousCapturePaused
          current.previous = performance.now()
          if (!current.capturePaused && !current.modeTransitioning) {
            current.animation = requestAnimationFrame(current.renderFrame)
          }
        }
      }
    }
    const readLogs = (current, request) => {
      const cursor = Math.max(0, Number(request.cursor) || 0)
      const limit = Math.max(1, Math.min(500, Number(request.limit) || 100))
      const oldest = logs[0]?.cursor ?? logCursor
      const matching = logs.filter(
        entry => entry.cursor >= cursor && (!request.level || entry.level === request.level),
      )
      const selected = matching.slice(0, limit)
      return {
        kind: 'runtime-logs',
        runtime: evidenceRuntime(current, request.target),
        evidenceId: crypto.randomUUID(),
        evidenceToken: request.evidenceToken,
        entries: selected,
        nextCursor: matching.length > limit
          ? (selected.at(-1)?.cursor ?? cursor) + 1
          : Math.max(cursor, logCursor),
        truncated: cursor < oldest || matching.length > limit,
      }
    }
    const waitFrames = async (
      current,
      frames,
      commandId,
      expiresAt,
      commandTarget,
    ) => {
      const targetFrame = current.frame + frames
      const deadline = Date.parse(expiresAt)
      while (true) {
        if (cancelledHarnessCommands.has(commandId)) {
          throw new Error('Runtime Harness command cancelled')
        }
        if (current.stopped || active !== current) {
          throw new Error('Runtime disposed during player action')
        }
        if (current.frame >= targetFrame) {
          return
        }
        if (!Number.isFinite(deadline) || Date.now() >= deadline) {
          throw new Error('Runtime Harness command timed out')
        }

        if (commandTarget === 'validation') {
          if (!current.frameInProgress && current.renderFrame) {
            cancelAnimationFrame(current.animation)
            current.renderFrame(performance.now())
          }
          if (current.frameInProgress) {
            await Promise.race([
              current.framePromise,
              new Promise(resolve => setTimeout(
                resolve,
                Math.max(1, Math.min(25, deadline - Date.now())),
              )),
            ])
          }
          await new Promise(resolve => setTimeout(resolve, 0))
        } else {
          await new Promise(resolve => setTimeout(
            resolve,
            Math.max(1, Math.min(50, deadline - Date.now())),
          ))
        }
      }
    }
    const pointerOptions = action => {
      const bounds = canvas.getBoundingClientRect()
      return {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: bounds.left + Math.min(1, Math.max(0, action.x)) * bounds.width,
        clientY: bounds.top + Math.min(1, Math.max(0, action.y)) * bounds.height,
        button: action.button ?? 0,
        buttons: action.type === 'pointerUp' ? 0 : 1 << (action.button ?? 0),
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }
    }
    const dispatchAction = async (current, action, commandId, expiresAt, target) => {
      if (action.type === 'waitFrames') {
        await waitFrames(current, action.frames, commandId, expiresAt, target)
        return false
      }
      if (action.type === 'keyDown' || action.type === 'keyUp') {
        return !canvas.dispatchEvent(new KeyboardEvent(
          action.type === 'keyDown' ? 'keydown' : 'keyup',
          { key: action.key, code: action.code ?? action.key, bubbles: true, cancelable: true },
        ))
      }
      if (action.type === 'wheel') {
        return !canvas.dispatchEvent(new WheelEvent('wheel', {
          ...pointerOptions(action),
          deltaX: action.deltaX,
          deltaY: action.deltaY,
        }))
      }
      if (action.type === 'drag') {
        const [fromX, fromY] = action.from
        const [toX, toY] = action.to
        let handled = !canvas.dispatchEvent(new PointerEvent('pointerdown', pointerOptions({
          type: 'pointerDown',
          x: fromX,
          y: fromY,
          button: action.button,
        })))
        for (let step = 1; step <= action.steps; step += 1) {
          handled = !canvas.dispatchEvent(new PointerEvent('pointermove', pointerOptions({
            type: 'pointerMove',
            x: fromX + (toX - fromX) * step / action.steps,
            y: fromY + (toY - fromY) * step / action.steps,
            button: action.button,
          }))) || handled
          await waitFrames(current, 1, commandId, expiresAt, target)
        }
        handled = !canvas.dispatchEvent(new PointerEvent('pointerup', pointerOptions({
          type: 'pointerUp',
          x: toX,
          y: toY,
          button: action.button,
        }))) || handled
        return handled
      }
      const eventType = action.type === 'pointerMove'
        ? 'pointermove'
        : action.type === 'pointerDown'
          ? 'pointerdown'
          : action.type === 'pointerUp'
            ? 'pointerup'
            : action.type
      if (action.type === 'click') {
        let handled = !canvas.dispatchEvent(new PointerEvent('pointerdown', pointerOptions({
          ...action,
          type: 'pointerDown',
        })))
        handled = !canvas.dispatchEvent(new PointerEvent('pointerup', pointerOptions({
          ...action,
          type: 'pointerUp',
        }))) || handled
        handled = !canvas.dispatchEvent(new MouseEvent('click', pointerOptions(action))) || handled
        return handled
      }
      return !canvas.dispatchEvent(new PointerEvent(eventType, pointerOptions(action)))
    }
    const simulateActions = async (current, request) => {
      const startFrame = current.frame
      const trace = []
      for (const [index, action] of (request.actions ?? []).entries()) {
        try {
          if (cancelledHarnessCommands.has(request.commandId)) {
            throw new Error('Runtime Harness command cancelled')
          }
          const handled = await dispatchAction(
            current,
            action,
            request.commandId,
            request.expiresAt,
            request.target,
          )
          appendLog('info', ['Runtime Harness action', String(index), action.type])
          trace.push({
            index,
            type: action.type,
            frame: current.frame,
            status: 'completed',
            handled,
          })
        } catch (error) {
          trace.push({
            index,
            type: action.type,
            frame: current.frame,
            status: 'failed',
            message: message(error).slice(0, 1024),
          })
          return {
            kind: 'action-trace',
            runtime: evidenceRuntime(current, request.target),
            evidenceId: crypto.randomUUID(),
            evidenceToken: request.evidenceToken,
            status: current.stopped || cancelledHarnessCommands.has(request.commandId)
              ? 'cancelled'
              : 'failed',
            startFrame,
            endFrame: current.frame,
            trace,
          }
        }
      }
      return {
        kind: 'action-trace',
        runtime: evidenceRuntime(current, request.target),
        evidenceId: crypto.randomUUID(),
        evidenceToken: request.evidenceToken,
        status: 'completed',
        startFrame,
        endFrame: current.frame,
        trace,
      }
    }
    const resize = current => {
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const qualityScale = current.state.qualityTier === 'performance'
        ? 0.5
        : current.state.qualityTier === 'balanced'
          ? 0.75
          : 1
      const dpr = Math.min(devicePixelRatio || 1, 2) * qualityScale
      current.state.dpr = dpr
      const expectedWidth = Math.floor(width * dpr)
      const expectedHeight = Math.floor(height * dpr)
      const size = new current.THREE.Vector2()
      current.renderer.getDrawingBufferSize(size)
      if (size.x === expectedWidth && size.y === expectedHeight) return false
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
      current.resizeCount += 1
      return true
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
    const objectCenterWorld = (current, object) => {
      current.scene.updateMatrixWorld(true)
      const bounds = new current.THREE.Box3().setFromObject(object)
      return bounds.isEmpty()
        ? object.getWorldPosition(new current.THREE.Vector3())
        : bounds.getCenter(new current.THREE.Vector3())
    }
    const syncTransformPivot = current => {
      if (!current.selected || !current.transformPivot) return
      current.selected.updateWorldMatrix(true, true)
      const world = current.selected.matrixWorld.clone()
      world.setPosition(objectCenterWorld(current, current.selected))
      const local = current.scene.matrixWorld.clone().invert().multiply(world)
      local.decompose(
        current.transformPivot.position,
        current.transformPivot.quaternion,
        current.transformPivot.scale,
      )
      current.transformPivot.updateMatrix()
      current.transformPivot.updateMatrixWorld(true)
      current.transformPivotStart = current.transformPivot.matrixWorld.clone()
      current.transformObjectStart = current.selected.matrixWorld.clone()
    }
    const applyTransformPivot = current => {
      if (!current.selected
        || !current.transformPivotStart
        || !current.transformObjectStart) return
      current.transformPivot.updateMatrixWorld(true)
      const delta = current.transformPivot.matrixWorld.clone()
        .multiply(current.transformPivotStart.clone().invert())
      const world = delta.multiply(current.transformObjectStart)
      const local = current.selected.parent
        ? current.selected.parent.matrixWorld.clone().invert().multiply(world)
        : world
      local.decompose(
        current.selected.position,
        current.selected.quaternion,
        current.selected.scale,
      )
      current.selected.updateMatrix()
      current.selected.updateMatrixWorld(true)
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
      } else if (operation.type === 'set_material_value') {
        const material = objectMaterial(object)
        if (!material || typeof material[operation.property] !== 'number') {
          throw new Error(
            'Runtime editor object has no editable material value ' + operation.property,
          )
        }
        material[operation.property] = operation.value
        material.needsUpdate = true
      } else if (operation.type === 'set_material_boolean') {
        const material = objectMaterial(object)
        if (!material || typeof material[operation.property] !== 'boolean') {
          throw new Error(
            'Runtime editor object has no editable material boolean ' + operation.property,
          )
        }
        material[operation.property] = operation.value
        material.needsUpdate = true
      } else {
        throw new Error('Unsupported Runtime editor operation ' + operation?.type)
      }
      object.updateMatrix()
      current.scene.updateMatrixWorld(true)
      if (current.selected === object && !current.transformDragging) {
        syncTransformPivot(current)
      }
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
      if (object) {
        syncTransformPivot(current)
        current.transform.attach(current.transformPivot)
      }
      if (notify) {
        emit(current.runId, current.nonce, 'editor-selection', {
          selectedUuid: object?.uuid,
        })
      }
    }
    const pickObjects = (current, clientX, clientY, bounds) => {
      const offsets = [
        [0, 0],
        [-6, 0], [6, 0], [0, -6], [0, 6],
        [-4, -4], [4, -4], [-4, 4], [4, 4],
      ]
      const raycaster = new current.THREE.Raycaster()
      const pointer = new current.THREE.Vector2()
      const candidates = new Map()
      const exactCandidates = new Map()
      for (const [offsetX, offsetY] of offsets) {
        const x = clientX + offsetX
        const y = clientY + offsetY
        if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
          continue
        }
        pointer.set(
          ((x - bounds.left) / bounds.width) * 2 - 1,
          -((y - bounds.top) / bounds.height) * 2 + 1,
        )
        raycaster.setFromCamera(pointer, current.camera)
        for (const result of raycaster.intersectObjects(current.scene.children, true)) {
          const object = current.objects.get(result.object.uuid)
          if (!object) continue
          const offset = Math.hypot(offsetX, offsetY)
          const candidate = {
            uuid: object.uuid,
            distance: result.distance,
            offset,
          }
          if (offset === 0 && !exactCandidates.has(object.uuid)) {
            exactCandidates.set(object.uuid, candidate)
          }
          const previous = candidates.get(object.uuid)
          if (!previous
            || result.distance < previous.distance
            || (result.distance === previous.distance && offset < previous.offset)) {
            candidates.set(object.uuid, candidate)
          }
        }
      }
      return [...(exactCandidates.size === 0 ? candidates : exactCandidates).values()]
        .sort((left, right) => left.distance - right.distance
          || left.offset - right.offset)
        .map(candidate => candidate.uuid)
    }
    const mutateBetweenFrames = (current, mutate) => {
      const transition = async () => {
        current.modeTransitioning = true
        cancelAnimationFrame(current.animation)
        try {
          await current.framePromise
          if (current.stopped) throw new Error('Runtime stopped before mutation')
          return mutate()
        } finally {
          current.modeTransitioning = false
          if (!current.stopped && current.renderFrame) {
            current.animation = requestAnimationFrame(current.renderFrame)
          }
        }
      }
      const pending = current.modeTransitionPromise.then(transition, transition)
      current.modeTransitionPromise = pending.catch(() => {})
      return pending
    }
    const setMode = (current, mode) => mutateBetweenFrames(current, () => {
      const nextMode = mode === 'run' ? 'run' : 'edit'
      if (current.mode === 'run' && nextMode === 'edit') cancelRuntimeInput(current)
      if (current.mode === 'edit' && nextMode === 'run') {
        current.editState = captureEditState(current)
      }
      current.mode = nextMode
      current.state.paused = current.mode === 'edit'
      current.previous = performance.now()
      if (current.transform) current.transform.enabled = current.mode === 'edit'
      if (current.transformHelper) current.transformHelper.visible = current.mode === 'edit'
      if (current.mode === 'run') {
        current.transform?.detach()
      } else if (current.selected && current.transform) {
        syncTransformPivot(current)
        current.transform.attach(current.transformPivot)
      }
      emit(current.runId, current.nonce, 'mode', {
        mode: current.mode,
        ...(current.mode === 'run' ? { editState: current.editState } : {}),
      })
    })
    const disposeCurrent = async (current, preserveSurface = false) => {
      let evidence = {}
      const failures = []
      let exampleDisposeError
      const cleanup = callback => {
        try {
          callback()
        } catch (error) {
          failures.push(message(error))
        }
      }
      if (current) {
        cleanup(() => current.layoutObserver?.disconnect())
        cleanup(() => cancelAnimationFrame(current.animation))
        cleanup(() => current.renderer.setAnimationLoop?.(null))
        try {
          cancelRuntimeInput(current)
        } catch (error) {
          failures.push(message(error))
        }
        current.stopped = true
        try {
          await current.framePromise
        } catch (error) {
          failures.push(message(error))
        }
        try {
          await current.modeTransitionPromise
        } catch (error) {
          failures.push(message(error))
        }
        try {
          await current.setupPromise
        } catch {
          // The start path owns setup failures; disposal only waits for settlement.
        }
        try {
          evidence = metrics(current)
        } catch (error) {
          failures.push(message(error))
        }
        try {
          await current.example?.dispose?.()
        } catch (error) {
          exampleDisposeError = message(error)
        } finally {
          const inputListenersAfterExampleDispose = current.runtimeInputListeners.length
          cleanup(() => current.transform?.detach())
          cleanup(() => current.transformHelper?.removeFromParent())
          cleanup(() => current.transformPivot?.removeFromParent())
          cleanup(() => current.transform?.dispose())
          cleanup(() => disposeRuntimeCanvas(current))
          cleanup(() => current.controls?.dispose())
          cleanup(() => current.renderer.dispose())
          if (!preserveSurface && !current.renderer.getContext?.().isContextLost?.()) {
            cleanup(() => current.renderer.forceContextLoss?.())
          }
          evidence = {
            ...evidence,
            runId: current.runId,
            inputListenersAfterExampleDispose,
            runtimeInputListenersAfterDispose: current.runtimeInputListeners.length,
            capturedPointersAfterDispose: current.runtimeCapturedPointers.size,
            rendererDisposed: true,
            ...(exampleDisposeError === undefined ? {} : { exampleDisposeError }),
            ...(failures.length === 0 ? {} : { disposeError: failures.join('\\n') }),
          }
        }
      }
      if (bundleUrl) cleanup(() => URL.revokeObjectURL(bundleUrl))
      bundleUrl = undefined
      cleanup(() => restoreAssetFetch?.())
      restoreAssetFetch = undefined
      for (const url of assetUrls.values()) cleanup(() => URL.revokeObjectURL(url))
      assetUrls = new Map()
      assetBlobs = new Map()
      delete globalThis.__THREEJS_EDITOR_ASSETS__
      delete globalThis.__THREEJS_EDITOR_REGISTER_INLINE_ASSET__
      const disposeError = failures.length === 0 ? undefined : failures.join('\\n')
      return { evidence, disposeError }
    }
    const dispose = async (runId, nonce, notify = true, preserveSurface = false) => {
      const current = active
      active = undefined
      const { evidence, disposeError } = await disposeCurrent(current, preserveSurface)
      if (current) {
        lastDisposed = {
          projectId: current.projectId,
          runId: current.runId,
          nonce: current.nonce,
          revision: current.revision,
          evidence,
        }
      }
      if (disposeError) emit(runId, nonce, 'runtime-error', { message: disposeError })
      if (notify) emit(runId, nonce, 'disposed', evidence)
    }
    const start = async request => {
      const { runId, nonce } = request
      if (Number.isSafeInteger(request.epoch)) eventEpoch = request.epoch
      if (typeof request.evidenceToken !== 'string') {
        emit(runId, nonce, 'runtime-error', { message: 'Runtime evidence token is required' })
        return
      }
      if (typeof request.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(request.buildId)) {
        emit(runId, nonce, 'runtime-error', { message: 'Runtime buildId is required' })
        return
      }
      const pending = {
        projectId: request.projectId,
        runId,
        nonce,
        revision: request.revision,
        buildId: request.buildId,
        stopRequested: false,
      }
      starting = pending
      logs.length = 0
      logCursor = 0
      await dispose(runId, nonce, false)
      eventProjectId = request.projectId
      eventRevision = request.revision
      let current
      let renderer
      try {
        assetUrls = new Map()
        assetBlobs = new Map()
        for (const asset of request.assets ?? []) {
          if (typeof asset.sha256 !== 'string'
            || typeof asset.mediaType !== 'string'
            || !(asset.bytes instanceof ArrayBuffer)) {
            throw new Error('Runtime asset payload is invalid')
          }
          if (!assetUrls.has(asset.sha256)) {
            const blob = new Blob([asset.bytes], { type: asset.mediaType })
            const url = URL.createObjectURL(blob)
            assetUrls.set(asset.sha256, url)
            assetBlobs.set(url, blob)
          }
        }
        restoreAssetFetch = installOwnedAssetFetch(window, assetBlobs)
        globalThis.__THREEJS_EDITOR_ASSETS__ = assetUrls
        globalThis.__THREEJS_EDITOR_REGISTER_INLINE_ASSET__ = (hash, mediaType, base64) => {
          const existing = assetUrls.get(hash)
          if (existing !== undefined) return existing
          if (typeof hash !== 'string'
            || typeof mediaType !== 'string'
            || typeof base64 !== 'string') {
            throw new Error('Inline Runtime asset payload is invalid')
          }
          const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
          const blob = new Blob([bytes], { type: mediaType })
          const url = URL.createObjectURL(blob)
          assetUrls.set(hash, url)
          assetBlobs.set(url, blob)
          return url
        }
        bundleUrl = URL.createObjectURL(new Blob(
          [request.bundle],
          { type: 'text/javascript' },
        ))
        const module = await import(bundleUrl)
        if (pending.stopRequested) throw new Error('Runtime start cancelled')
        const {
          adapter,
          THREE,
          OrbitControls,
          TransformControls,
          editorState,
          resolveAsset,
        } = module
        if (!adapter || typeof adapter.setup !== 'function') {
          throw new Error('Workspace entry must default-export an adapter with setup(context)')
        }
        if (adapter.backend === 'raw-webgpu' || request.backend === 'raw-webgpu') {
          throw new Error('raw-webgpu runtime is outside the M7 profile')
        }
        const backend = adapter.backend ?? request.backend
        if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
          await new Promise(resolve => {
            const observer = new ResizeObserver(() => {
              if (!pending.stopRequested
                && (canvas.clientWidth === 0 || canvas.clientHeight === 0)) return
              observer.disconnect()
              pending.cancelLayoutWait = undefined
              resolve()
            })
            pending.cancelLayoutWait = () => {
              observer.disconnect()
              resolve()
            }
            observer.observe(canvas)
          })
          if (pending.stopRequested) throw new Error('Runtime start cancelled')
        }
        const options = {
          canvas,
          antialias: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: true,
          ...(adapter.renderer?.options ?? {}),
        }
        renderer = backend === 'webgpu'
          ? new THREE.WebGPURenderer(options)
          : new THREE.WebGLRenderer(options)
        if (typeof renderer.init === 'function') await renderer.init()
        if (pending.stopRequested) throw new Error('Runtime start cancelled')
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
          projectId: request.projectId,
          runId,
          nonce,
          evidenceToken: request.evidenceToken,
          revision: request.revision,
          buildId: request.buildId,
          THREE,
          renderer,
          runtimeRenderer: undefined,
          scene,
          camera,
          controls,
          transform: undefined,
          transformHelper: undefined,
          transformPivot: undefined,
          transformPivotStart: undefined,
          transformObjectStart: undefined,
          transformMode: 'translate',
          transformDragging: false,
          pointerGesture: undefined,
          runtimeInputListeners: [],
          runtimeInputEvents: new Map(),
          runtimeEventFacade: undefined,
          runtimeCapturedPointers: new Set(),
          runtimeCanvas: undefined,
          pickCycle: undefined,
          selected: undefined,
          objects: new Map(),
          parents: new Map(),
          paths: new Map(),
          objectOrder: [],
          example: undefined,
          editState: undefined,
          mode: request.mode === 'run' ? 'run' : 'edit',
          state: {
            debugMode: request.debugMode ?? 'final',
            qualityTier: editorState?.qualityTier ?? request.qualityTier ?? 'default',
            paused: request.mode !== 'run',
            dpr: Math.min(devicePixelRatio || 1, 2),
            timeScale: 1,
          },
          frame: 0,
          elapsed: adapter.initialTime ?? 0,
          previous: performance.now(),
          animation: 0,
          capturePaused: false,
          stopped: false,
          frameInProgress: false,
          framePromise: Promise.resolve(),
          modeTransitioning: false,
          modeTransitionPromise: Promise.resolve(),
          revisionTransition: undefined,
          setupPromise: Promise.resolve(),
          renderFrame: undefined,
          layoutObserver: undefined,
          needsInitialUpdate: true,
          resizeCount: 0,
        }
        const runtimeCanvas = createRuntimeCanvas(current)
        current.runtimeCanvas = runtimeCanvas
        current.runtimeRenderer = createRuntimeRenderer(renderer, runtimeCanvas)
        active = current
        current.setupPromise = Promise.resolve(adapter.setup({
          THREE,
          canvas: runtimeCanvas,
          renderer: current.runtimeRenderer,
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
          resolveAsset,
        }))
          .then(example => {
            current.example = example ?? {}
          })
        try {
          await current.setupPromise
        } catch (error) {
          if (current.stopped) return
          throw error
        }
        if (current.stopped || active !== current) return
        current.example.setDebugMode?.(current.state.debugMode)
        current.example.setQualityTier?.(current.state.qualityTier)
        const viewState = request.viewState
        if (viewState && Array.isArray(viewState.cameraPosition)
          && viewState.cameraPosition.length === 3
          && viewState.cameraPosition.every(Number.isFinite)
          && Array.isArray(viewState.cameraQuaternion)
          && viewState.cameraQuaternion.length === 4
          && viewState.cameraQuaternion.every(Number.isFinite)
          && Array.isArray(viewState.cameraUp)
          && viewState.cameraUp.length === 3
          && viewState.cameraUp.every(Number.isFinite)) {
          camera.position.fromArray(viewState.cameraPosition)
          camera.quaternion.fromArray(viewState.cameraQuaternion)
          camera.up.fromArray(viewState.cameraUp)
          if (typeof viewState.cameraZoom === 'number'
            && Number.isFinite(viewState.cameraZoom)) {
            camera.zoom = viewState.cameraZoom
            camera.updateProjectionMatrix()
          }
          if (controls
            && Array.isArray(viewState.controlsTarget)
            && viewState.controlsTarget.length === 3
            && viewState.controlsTarget.every(Number.isFinite)) {
            controls.target.fromArray(viewState.controlsTarget)
            controls.update()
          }
          camera.updateMatrixWorld(true)
        }
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
        current.transformPivot = new THREE.Object3D()
        current.transformPivot.userData.editorHelper = true
        scene.add(current.transformPivot)
        current.transform.addEventListener('mouseDown', () => {
          syncTransformPivot(current)
        })
        current.transform.addEventListener('dragging-changed', event => {
          current.transformDragging = event.value === true
          if (current.controls) current.controls.enabled = !current.transformDragging
        })
        current.transform.addEventListener('objectChange', () => {
          if (!current.selected) return
          applyTransformPivot(current)
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
        if (typeof request.selectedUuid === 'string') {
          selectObject(current, request.selectedUuid, false)
        }
        current.editState = captureEditState(current)
        emit(runId, nonce, 'editor-scene', editorScene(current))

        const render = now => {
          if (current.stopped || current.frameInProgress) return
          current.frameInProgress = true
          current.framePromise = (async () => {
            try {
              if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
                return
              }
              if (resize(current)) current.needsInitialUpdate = true
              const rawDelta = Math.min((now - current.previous) / 1000, 0.1)
              current.previous = now
              const delta = current.mode === 'run'
                ? rawDelta * current.state.timeScale
                : 0
              if (current.mode === 'run' || current.needsInitialUpdate) {
                if (current.mode === 'run') current.elapsed += delta
                await current.example.update?.({
                  delta,
                  rawDelta,
                  elapsed: current.elapsed,
                  state: current.state,
                  camera: current.camera,
                  controls: current.controls,
                })
                current.needsInitialUpdate = false
              }
              current.controls?.update()
              if (current.state.debugMode === 'no-post') {
                current.renderer.render(current.scene, current.camera)
              } else if (current.example.render) {
                await current.example.render({
                  renderer: current.runtimeRenderer,
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
                emit(runId, nonce, 'ready', {
                  backend,
                  ...evidence,
                  editState: current.editState,
                })
              } else if (current.frame % 30 === 0) {
                emit(runId, nonce, 'frame', evidence)
                emit(runId, nonce, 'metrics', evidence)
              }
            } catch (error) {
              current.stopped = true
              emit(runId, nonce, 'runtime-error', {
                message: message(error),
                fatal: true,
              })
            } finally {
              current.frameInProgress = false
              if (!current.stopped && !current.modeTransitioning && !current.capturePaused) {
                current.animation = requestAnimationFrame(render)
              }
            }
          })()
        }
        current.renderFrame = render
        current.layoutObserver = new ResizeObserver(() => {
          if (current.frame !== 0
            || current.stopped
            || current.frameInProgress
            || canvas.clientWidth === 0
            || canvas.clientHeight === 0) return
          cancelAnimationFrame(current.animation)
          current.renderFrame(performance.now())
        })
        current.layoutObserver.observe(canvas)
        render(performance.now())
      } catch (error) {
        if (active === current) active = undefined
        let disposed
        if (current) {
          disposed = await disposeCurrent(current)
        } else {
          renderer?.setAnimationLoop?.(null)
          renderer?.dispose?.()
          renderer?.forceContextLoss?.()
          disposed = await disposeCurrent(undefined)
        }
        lastDisposed = {
          projectId: request.projectId,
          runId,
          nonce,
          revision: request.revision,
          evidence: disposed.evidence,
        }
        if (pending.stopRequested) {
          if (disposed.disposeError) {
            emit(runId, nonce, 'runtime-error', { message: disposed.disposeError })
          }
          emit(runId, nonce, 'disposed', disposed.evidence)
        } else {
          emit(runId, nonce, 'runtime-error', { message: message(error) })
        }
      } finally {
        if (starting === pending) starting = undefined
      }
    }

    canvas.addEventListener('pointerdown', event => {
      const current = active
      if (!current || current.mode !== 'edit' || current.transformDragging) return
      const bounds = canvas.getBoundingClientRect()
      const pickIds = pickObjects(current, event.clientX, event.clientY, bounds)
      current.lastPointerPick = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        isPrimary: event.isPrimary,
        blocked: current.transform.axis !== null,
        pickIds,
      }
      current.pointerGesture = event.isPrimary && event.button === 0
        ? {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            moved: false,
            blocked: current.transform.axis !== null,
            pickIds,
          }
        : undefined
    })
    canvas.addEventListener('pointermove', event => {
      const gesture = active?.pointerGesture
      if (!gesture || gesture.pointerId !== event.pointerId) return
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) {
        gesture.moved = true
      }
    })
    canvas.addEventListener('pointerup', event => {
      const current = active
      const gesture = current?.pointerGesture
      if (current) current.pointerGesture = undefined
      if (!current
        || current.mode !== 'edit'
        || !shouldPickAfterPointerGesture(
          gesture,
          event.pointerId,
          event.clientX,
          event.clientY,
          current.transformDragging,
        )) return
      const uuids = gesture.pickIds ?? []
      const previous = current.pickCycle
      const samePoint = previous
        && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 6
      const sameObjects = samePoint
        && previous.uuids.length === uuids.length
        && previous.uuids.every((uuid, index) => uuid === uuids[index])
      const index = sameObjects ? (previous.index + 1) % Math.max(uuids.length, 1) : 0
      current.pickCycle = {
        x: event.clientX,
        y: event.clientY,
        uuids,
        index,
      }
      selectObject(current, uuids[index])
    })
    canvas.addEventListener('pointercancel', event => {
      const current = active
      if (current?.pointerGesture?.pointerId === event.pointerId) {
        current.pointerGesture = undefined
      }
    })
    canvas.addEventListener('lostpointercapture', event => {
      active?.runtimeCapturedPointers.delete(event.pointerId)
    })
    canvas.addEventListener('gotpointercapture', event => {
      if (active?.mode === 'run') active.runtimeCapturedPointers.add(event.pointerId)
    })
    window.addEventListener('error', event => {
      if (!active) return
      event.preventDefault()
      appendLog('error', [event.error?.stack || event.message])
      emit(active.runId, active.nonce, 'runtime-error', {
        message: event.error?.stack || event.message,
      })
    })
    window.addEventListener('unhandledrejection', event => {
      if (!active) return
      event.preventDefault()
      appendLog('error', [message(event.reason)])
      emit(active.runId, active.nonce, 'runtime-error', {
        message: message(event.reason),
      })
    })
    window.addEventListener('message', async event => {
      if (event.source !== window.parent) return
      const request = event.data
      if (!request || request.channel !== channel) return
      const { action, runId, nonce } = request
      const requestEpoch = Number.isSafeInteger(request.epoch)
        ? request.epoch
        : action === 'run'
          ? 0
          : eventEpoch
      if (requestEpoch < eventEpoch) return
      eventEpoch = requestEpoch
      if (action === 'run') {
        await start(request)
        return
      }
      if (action === 'stop') {
        if (active?.projectId === request.projectId
          && (active.revision === request.revision
            || active.revisionTransition === request.revision)
          && active.runId === runId
          && active.nonce === nonce) {
          active.revision = request.revision
          eventRevision = request.revision
          await dispose(runId, nonce, true, request.preserveSurface === true)
          return
        }
        if (starting?.projectId === request.projectId
          && starting.revision === request.revision
          && starting.runId === runId
          && starting.nonce === nonce) {
          starting.stopRequested = true
          starting.cancelLayoutWait?.()
          return
        }
        if (lastDisposed?.projectId === request.projectId
          && lastDisposed.runId === runId
          && lastDisposed.nonce === nonce
          && lastDisposed.revision === request.revision) {
          emit(
            runId,
            nonce,
            'disposed',
            lastDisposed.evidence,
            lastDisposed.revision,
            lastDisposed.projectId,
          )
        }
        return
      }
      if (!active
        || active.projectId !== request.projectId
        || active.runId !== runId
        || active.nonce !== nonce) return
      if (action === 'apply-draft-operations') {
        const current = active
        if (current.revisionTransition !== undefined
          || current.revision !== request.revision) return
        try {
          await mutateBetweenFrames(current, () => {
            for (const operation of request.operations ?? []) {
              applyOperation(current, operation, false)
            }
            emit(runId, nonce, 'editor-scene', editorScene(current))
          })
        } catch (error) {
          emit(runId, nonce, 'runtime-error', { message: message(error) })
        }
        return
      }
      if (action === 'apply-operations') {
        const current = active
        if (request.previousRevision !== current.revision
          || typeof request.revision !== 'string'
          || current.revisionTransition !== undefined) return
        const previousRevision = current.revision
        const nextRevision = request.revision
        current.revisionTransition = nextRevision
        try {
          await mutateBetweenFrames(current, () => {
            if (current.revision !== previousRevision
              || current.revisionTransition !== nextRevision) {
              throw new Error('Runtime revision changed before mutation')
            }
            for (const operation of request.operations ?? []) {
              applyOperation(current, operation, false)
            }
            current.revision = nextRevision
            eventRevision = nextRevision
            current.revisionTransition = undefined
            emit(runId, nonce, 'editor-scene', {
              ...editorScene(current),
              projectionTransitionId: request.projectionTransitionId,
            })
          })
        } catch (error) {
          emit(
            runId,
            nonce,
            'runtime-error',
            { message: message(error) },
            nextRevision,
            current.projectId,
          )
        } finally {
          if (current.revisionTransition === nextRevision) {
            current.revisionTransition = undefined
          }
        }
        return
      }
      if (active.revisionTransition !== undefined
        || active.revision !== request.revision) return
      if (action === 'harness-cancel') {
        if (typeof request.commandId === 'string') {
          cancelledHarnessCommands.add(request.commandId)
        }
      } else if (action === 'harness-command') {
        try {
          const result = request.kind === 'capture-frame'
            ? await captureFrame(active, request)
            : request.kind === 'read-logs'
              ? readLogs(active, request)
              : await simulateActions(active, request)
          emit(runId, nonce, 'harness-result', {
            commandId: request.commandId,
            result,
          })
        } catch (error) {
          emit(runId, nonce, 'harness-error', {
            commandId: request.commandId,
            message: message(error).slice(0, 2048),
          })
        } finally {
          cancelledHarnessCommands.delete(request.commandId)
        }
      } else if (action === 'set-debug') {
        active.state.debugMode = request.debugMode
        active.example?.setDebugMode?.(request.debugMode)
        active.pendingDebugMode = request.debugMode
      } else if (action === 'set-mode') {
        await setMode(active, request.mode)
      } else if (action === 'set-time-scale') {
        const timeScale = Number(request.timeScale)
        active.state.timeScale = Number.isFinite(timeScale)
          ? Math.min(Math.max(timeScale, 0), 4)
          : 1
        emit(runId, nonce, 'time-scale', { timeScale: active.state.timeScale })
      } else if (action === 'set-transform-mode') {
        active.transformMode = request.mode
        active.transform.setMode(request.mode)
      } else if (action === 'select-object') {
        selectObject(active, request.objectUuid, false)
      } else if (action === 'apply-operation') {
        await mutateBetweenFrames(active, () => {
          applyOperation(active, request.operation)
        })
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

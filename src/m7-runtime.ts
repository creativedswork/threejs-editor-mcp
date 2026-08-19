export const M7_RUNTIME_CHANNEL = 'threejs-editor-m7-runtime'

export interface M7RuntimeEvent {
  channel: typeof M7_RUNTIME_CHANNEL
  runId: string
  nonce: string
  type: string
  data?: Record<string, unknown>
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
  <canvas aria-label="Three.js Workspace runtime canvas"></canvas>
  <script>
  (() => {
    const channel = ${JSON.stringify(M7_RUNTIME_CHANNEL)}
    const canvas = document.querySelector('canvas')
    let active
    let bundleUrl

    const emit = (runId, nonce, type, data = {}) => {
      window.parent.postMessage({ channel, runId, nonce, type, data }, '*')
    }
    const message = error => error instanceof Error
      ? error.stack || error.message
      : String(error)
    const metrics = current => ({
      frame: current.frame,
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
    const dispose = async (runId, nonce, notify = true) => {
      const current = active
      active = undefined
      if (current) {
        current.stopped = true
        cancelAnimationFrame(current.animation)
        current.renderer.setAnimationLoop?.(null)
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
        const { adapter, THREE, OrbitControls } = module
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
          example: undefined,
          state: {
            debugMode: request.debugMode ?? 'final',
            paused: false,
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

        const render = async now => {
          if (current.stopped || current.frameInProgress) return
          current.frameInProgress = true
          try {
            resize(current)
            const rawDelta = Math.min((now - current.previous) / 1000, 0.1)
            current.previous = now
            const delta = current.state.paused ? 0 : rawDelta * current.state.timeScale
            current.elapsed += delta
            current.controls?.update()
            await current.example.update?.({
              delta,
              rawDelta,
              elapsed: current.elapsed,
              state: current.state,
              camera: current.camera,
              controls: current.controls,
            })
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

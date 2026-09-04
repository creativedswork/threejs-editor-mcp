import assert from 'node:assert/strict'
import test from 'node:test'
import {
  disposeOwnedRuntimeResources,
  m7BootstrapHtml,
  runtimeGpuCapability,
  runtimeGpuCapabilityError,
} from '../src/m7-runtime.ts'

test('reports explicit WebGPU capability failures without fallback', () => {
  assert.deepEqual(runtimeGpuCapability('webgl', false, false), {
    backend: 'webgl',
    available: true,
    secureContext: false,
    webgpuApi: false,
  })
  const unavailable = runtimeGpuCapability('webgpu', false, true)
  assert.equal(unavailable.code, 'WEBGPU_UNAVAILABLE')
  assert.match(runtimeGpuCapabilityError(unavailable).message, /^\[WEBGPU_UNAVAILABLE\]/)
  assert.equal(
    runtimeGpuCapability('webgpu', true, false).code,
    'WEBGPU_INSECURE_CONTEXT',
  )

  const script = m7BootstrapHtml()
  const capabilityCheck = script.indexOf('if (!capabilities.available)')
  assert.ok(capabilityCheck > 0)
  assert.ok(capabilityCheck < script.indexOf('new THREE.WebGPURenderer(options)'))
  assert.match(script, /WEBGPU_INITIALIZATION_FAILED/)
  assert.match(script, /capability: error\.capability/)
})

test('disposes runtime-owned GPU resources once in reverse registration order', async () => {
  const order = []
  const resources = [
    { resource: { dispose: () => order.push('texture') } },
    { resource: { destroy: () => order.push('buffer') } },
    {
      resource: {},
      dispose() {
        order.push('compute')
      },
    },
  ]
  assert.deepEqual(await disposeOwnedRuntimeResources(resources), {
    disposed: 3,
    failures: [],
  })
  assert.deepEqual(order, ['compute', 'buffer', 'texture'])
  assert.equal(resources.length, 0)
  assert.deepEqual(await disposeOwnedRuntimeResources(resources), {
    disposed: 0,
    failures: [],
  })

  const script = m7BootstrapHtml()
  assert.match(script, /ownGpuResource\(resource, dispose\)/)
  assert.match(script, /await disposeOwnedRuntimeResources\(current\.gpuResources\)/)
  assert.match(script, /gpuResourcesAfterDispose: current\.gpuResources\.length/)
})

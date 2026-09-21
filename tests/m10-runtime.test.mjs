import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  disposeOwnedRuntimeResources,
  workspaceRuntimeHtml,
  runtimeGpuCapability,
  runtimeGpuCapabilityError,
} from '../src/workspace-runtime.ts'

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

  const script = workspaceRuntimeHtml()
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

  const script = workspaceRuntimeHtml()
  assert.match(script, /ownGpuResource\(resource, dispose\)/)
  assert.match(script, /await disposeOwnedRuntimeResources\(current\.gpuResources\)/)
  assert.match(script, /gpuResourcesAfterDispose: current\.gpuResources\.length/)
})

test('production runtime sources contain no fixed debug collector', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/workspace-runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspaces.ts', import.meta.url), 'utf8'),
  ])
  for (const source of sources) {
    assert.doesNotMatch(source, /127\.0\.0\.1:7781\/event/)
    assert.doesNotMatch(source, /#region debug-point/)
  }
})

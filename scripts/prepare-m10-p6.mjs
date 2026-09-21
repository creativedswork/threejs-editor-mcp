import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { resetGeneratedWorkspace } from './generated-workspace.mjs'

const EXPECTED_COMMIT = '98453747cc0678f6a5d910f38d7483596a5f9a40'
const DEFAULT_CORPUS = '.tmp/corpus/graphics-agent-skills'
const DEFAULT_DESTINATION = '.tmp/m10-p6-workspace'
const EXAMPLE = 'dev/example-gallery/examples/threejs-procedural-vfx/volumetric-fluid-fire'
const SKILL = 'skills/threejs-procedural-vfx/examples/volumetric-fluid-fire'

const corpus = resolve(process.argv[2] ?? DEFAULT_CORPUS)
const destination = resolve(process.argv[3] ?? DEFAULT_DESTINATION)
const commit = execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (commit !== EXPECTED_COMMIT) {
  throw new Error(`P6 corpus must be ${EXPECTED_COMMIT}; received ${commit}`)
}
const dirty = execFileSync(
  'git',
  ['-C', corpus, 'status', '--porcelain=v1', '--untracked-files=all', '--', EXAMPLE, SKILL],
  { encoding: 'utf8' },
).trim()
if (dirty !== '') {
  throw new Error(`P6 corpus contains uncommitted source changes:\n${dirty}`)
}
await resetGeneratedWorkspace(destination, 'prepare-m10-p6', {
  packageName: 'm10-volumetric-fluid-fire',
  title: 'P6 Volumetric Fluid Fire',
  entry: `${EXAMPLE}/scene.js`,
  backend: 'webgpu',
  provenance: {
    path: 'M10-P6-SOURCE.json',
    source: 'https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills',
    commit: EXPECTED_COMMIT,
    example: 'threejs-procedural-vfx/volumetric-fluid-fire',
  },
})

function replaceOnce(source, from, to, label) {
  const offset = source.indexOf(from)
  if (offset === -1 || source.indexOf(from, offset + from.length) !== -1) {
    throw new Error(`P6 integration anchor changed: ${label}`)
  }
  return source.slice(0, offset) + to + source.slice(offset + from.length)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

await cp(resolve(corpus, EXAMPLE), resolve(destination, EXAMPLE), { recursive: true })
await cp(resolve(corpus, SKILL), resolve(destination, SKILL), { recursive: true })
await rm(resolve(destination, EXAMPLE, 'example.json'))

const runtimeAssets = resolve(destination, 'src/runtime-assets')
await mkdir(runtimeAssets, { recursive: true })
const threeAssets = resolve('node_modules/three/examples/jsm/libs')
for (const [source, target] of [
  ['draco/draco_wasm_wrapper.js', 'draco-wasm-wrapper.bin'],
  ['draco/draco_decoder.wasm', 'draco-decoder.bin'],
  ['basis/basis_transcoder.js', 'basis-transcoder.bin'],
  ['basis/basis_transcoder.wasm', 'basis-transcoder-wasm.bin'],
]) {
  await copyFile(resolve(threeAssets, source), resolve(runtimeAssets, target))
}

await writeFile(resolve(destination, 'src/compressed-gltf-profile.js'), `
import { LoadingManager } from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

export function createCompressedGltfProfile(renderer, resolveAsset) {
  const manager = new LoadingManager();
  const basisPrefix = "https://threejs-editor.invalid/ktx2/";
  const aliases = new Map([
    [basisPrefix + "basis_transcoder.js", resolveAsset("./runtime-assets/basis-transcoder.bin")],
    [basisPrefix + "basis_transcoder.wasm", resolveAsset("./runtime-assets/basis-transcoder-wasm.bin")],
  ]);
  manager.setURLModifier((url) => aliases.get(url) ?? url);

  const draco = new DRACOLoader(manager).setDecoderPath({
    js: resolveAsset("./runtime-assets/draco-wasm-wrapper.bin"),
    wasm: resolveAsset("./runtime-assets/draco-decoder.bin"),
  });
  const ktx2 = new KTX2Loader(manager)
    .setTranscoderPath(basisPrefix)
    .detectSupport(renderer);
  const gltf = new GLTFLoader(manager)
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2);

  return {
    gltf,
    dispose() {
      draco.dispose();
      ktx2.dispose();
    },
  };
}
`.trimStart())

await writeFile(resolve(destination, 'src/dispose-fluid-fire.js'), `
function disposeMaterial(material, disposed) {
  for (const value of Array.isArray(material) ? material : [material]) {
    if (!value || disposed.has(value)) continue;
    disposed.add(value);
    value.dispose?.();
  }
}

export function disposeFluidFire(fire, renderPipeline) {
  fire.simulate = false;
  const disposed = new Set();
  const disposeTexture = (value) => {
    const texture = value?.getTexture?.();
    if (texture && !disposed.has(texture)) {
      disposed.add(texture);
      texture.dispose();
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) {
      if (child?.getTexture) disposeTexture(child);
    }
  };
  for (const value of Object.values(fire.shaderContext.texture)) disposeTexture(value);
  fire.traverse((object) => {
    if (object.geometry && !disposed.has(object.geometry)) {
      disposed.add(object.geometry);
      object.geometry.dispose();
    }
    if (object.material) disposeMaterial(object.material, disposed);
  });
  fire.volumetricPass?.dispose?.();
  renderPipeline.dispose();
  fire.removeFromParent();
}
`.trimStart())

await writeFile(resolve(destination, 'src/parameters.json'), `${JSON.stringify({
  primaryEmitter: 13,
  teapotEmitter: 22,
  pressureIterations: 4,
  simulationSpeed: 1.5,
  temperature: 8.5,
  fireDensity: 0.644,
  turbulence: 0.2,
}, null, 2)}\n`)

const scenePath = resolve(destination, EXAMPLE, 'scene.js')
let scene = await readFile(scenePath, 'utf8')
scene = replaceOnce(
  scene,
  'import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";\n'
    + 'import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\n',
  '',
  'loader imports',
)
scene = replaceOnce(
  scene,
  '} from "/skills/threejs-procedural-vfx/examples/volumetric-fluid-fire/volumetric-fluid-fire.js";\n',
  '} from "/skills/threejs-procedural-vfx/examples/volumetric-fluid-fire/volumetric-fluid-fire.js";\n'
    + 'import { createCompressedGltfProfile } from "/src/compressed-gltf-profile.js";\n'
    + 'import { disposeFluidFire } from "/src/dispose-fluid-fire.js";\n'
    + 'import parameters from "/src/parameters.json";\n',
  'M10 imports',
)
scene = replaceOnce(
  scene,
  'async setup({ THREE, renderer, scene, camera, controls, resolveAsset }) {',
  'async setup({ THREE, renderer, scene, camera, controls, resolveAsset, runtime }) {',
  'runtime context',
)
scene = replaceOnce(
  scene,
  '    const dracoLoader = new DRACOLoader();\n'
    + '    dracoLoader.setDecoderPath("/node_modules/three/examples/jsm/libs/draco/");\n'
    + '    const gltfLoader = new GLTFLoader();\n'
    + '    gltfLoader.setDRACOLoader(dracoLoader);\n\n'
    + '    const gltf = await gltfLoader.loadAsync(',
  '    const loaders = createCompressedGltfProfile(renderer, resolveAsset);\n'
    + '    const gltf = await loaders.gltf.loadAsync(',
  'compressed GLTF profile',
)
scene = replaceOnce(
  scene,
  'fire.getFireFor("primary", { emitMultiplier: 13, tintFactor: 0 })',
  'fire.getFireFor("primary", { emitMultiplier: parameters.primaryEmitter, tintFactor: 0 })',
  'primary emitter',
)
scene = replaceOnce(
  scene,
  'fire.getFireFor("teapot", { emitMultiplier: 22, tintFactor: 1 })',
  'fire.getFireFor("teapot", { emitMultiplier: parameters.teapotEmitter, tintFactor: 1 })',
  'teapot emitter',
)
scene = replaceOnce(
  scene,
  '    fire.applySettingsSnapshot(VOLUMETRIC_FLUID_FIRE_PRESET);',
  '    fire.applySettingsSnapshot({ ...VOLUMETRIC_FLUID_FIRE_PRESET, ...parameters });\n'
    + '    runtime.ownGpuResource(fire, () => disposeFluidFire(fire, renderPipeline));',
  'compute parameters and ownership',
)
scene = replaceOnce(
  scene,
  '      dispose() {\n        dracoLoader.dispose();',
  '      dispose() {\n        loaders.dispose();',
  'loader teardown',
)
await writeFile(scenePath, scene)

await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'm10-volumetric-fluid-fire',
  private: true,
  type: 'module',
  dependencies: { three: '0.185.1' },
}, null, 2)}\n`)
await mkdir(resolve(destination, '.threejs-editor'), { recursive: true })
await writeFile(resolve(destination, '.threejs-editor/project.json'), `${JSON.stringify({
  schemaVersion: 2,
  kind: 'linked-workspace',
  title: 'P6 Volumetric Fluid Fire',
  entry: `${EXAMPLE}/scene.js`,
  backend: 'webgpu',
  dependencies: { three: '0.185.1' },
  runtime: {
    debugModes: ['final', 'no-bloom', 'density', 'temperature', 'velocity', 'colliders'],
    qualityTiers: ['default'],
    parameters: [
      { id: 'primaryEmitter', label: 'Primary emitter', type: 'number', path: 'src/parameters.json', key: 'primaryEmitter', min: 1, max: 30, step: 1 },
      { id: 'teapotEmitter', label: 'Teapot emitter', type: 'number', path: 'src/parameters.json', key: 'teapotEmitter', min: 1, max: 40, step: 1 },
      { id: 'pressureIterations', label: 'Pressure iterations', type: 'number', path: 'src/parameters.json', key: 'pressureIterations', min: 1, max: 12, step: 1 },
      { id: 'simulationSpeed', label: 'Simulation speed', type: 'number', path: 'src/parameters.json', key: 'simulationSpeed', min: 0.25, max: 3, step: 0.05 },
      { id: 'temperature', label: 'Temperature', type: 'number', path: 'src/parameters.json', key: 'temperature', min: 1, max: 16, step: 0.1 },
      { id: 'fireDensity', label: 'Fire density', type: 'number', path: 'src/parameters.json', key: 'fireDensity', min: 0.1, max: 1.5, step: 0.01 },
      { id: 'turbulence', label: 'Turbulence', type: 'number', path: 'src/parameters.json', key: 'turbulence', min: 0, max: 2, step: 0.05 },
    ],
  },
}, null, 2)}\n`)

const provenance = []
for (const path of [
  `${EXAMPLE}/scene.js`,
  `${EXAMPLE}/assets/demo-scene.glb`,
  `${SKILL}/volumetric-fluid-fire.js`,
]) {
  const bytes = await readFile(resolve(destination, path))
  provenance.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
}
await writeFile(resolve(destination, 'M10-P6-SOURCE.json'), `${JSON.stringify({
  source: 'https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills',
  commit,
  example: 'threejs-procedural-vfx/volumetric-fluid-fire',
  license: 'MIT',
  distribution: 'external-only',
  runtimeDependencies: {
    three: '0.185.1',
    draco: 'three/examples/jsm/libs/draco',
    ktx2: 'three/examples/jsm/libs/basis',
  },
  files: provenance,
}, null, 2)}\n`)

process.stdout.write(`${JSON.stringify({ corpus, destination, commit }, null, 2)}\n`)

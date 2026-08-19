import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const EXPECTED_COMMIT = '98453747cc0678f6a5d910f38d7483596a5f9a40'
const DEFAULT_CORPUS = '.tmp/corpus/graphics-agent-skills'
const DEFAULT_DESTINATION = '.tmp/m7-p1-workspace'

const mappings = [
  [
    'dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car/scene.js',
    'source-materials/formula-one-race-car/scene.js',
  ],
  [
    'dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car/race-car-scene.js',
    'source-materials/formula-one-race-car/race-car-scene.js',
  ],
  [
    'dev/example-gallery/support/studio-stage.js',
    'dev/example-gallery/support/studio-stage.js',
  ],
  [
    'skills/threejs-procedural-geometry/examples/formula-one-race-car/race-car-model.js',
    'skills/threejs-procedural-geometry/examples/formula-one-race-car/race-car-model.js',
  ],
  ...[
    'design-contract.js',
    'mesh-kit.js',
    'race-car-materials.js',
    'race-car-model.js',
    'race-car-textures.js',
  ].map(name => [
    `skills/threejs-procedural-geometry/examples/formula-one-race-car/source/${name}`,
    `skills/threejs-procedural-geometry/examples/formula-one-race-car/source/${name}`,
  ]),
]

function safeDestination(path) {
  if (!isAbsolute(path)) return
  if (path === '/' || dirname(path) === path || basename(path) === '') {
    throw new Error('destination must be a dedicated Workspace directory')
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const corpus = resolve(process.argv[2] ?? DEFAULT_CORPUS)
const destination = resolve(process.argv[3] ?? DEFAULT_DESTINATION)
safeDestination(destination)

const commit = execFileSync('git', ['-C', corpus, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (commit !== EXPECTED_COMMIT) {
  throw new Error(`P1 corpus must be ${EXPECTED_COMMIT}; received ${commit}`)
}

await rm(destination, { recursive: true, force: true })
const evidence = []
for (const [sourcePath, destinationPath] of mappings) {
  const source = resolve(corpus, sourcePath)
  const target = resolve(destination, destinationPath)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  const bytes = await readFile(target)
  evidence.push({
    source: sourcePath,
    path: destinationPath,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  })
}

await mkdir(resolve(destination, 'src'), { recursive: true })
await writeFile(resolve(destination, 'src', 'parameters.json'), `${JSON.stringify({
  livery: false,
  bodyScale: 1,
}, null, 2)}\n`)
await writeFile(resolve(destination, 'src', 'main.js'), `
import * as THREE from "three/webgpu";
import { createStudioStage } from "/dev/example-gallery/support/studio-stage.js";
import { createFormulaOneRaceCar } from
  "/skills/threejs-procedural-geometry/examples/formula-one-race-car/race-car-model.js";
import parameters from "./parameters.json";

export default {
  backend: "webgpu",
  renderer: {
    options: { antialias: true },
    exposure: 0.76,
  },
  camera: {
    fov: 18,
    near: 0.05,
    far: 400,
    position: [7.72, 5.33, 8.16],
  },
  controls: {
    target: [0, 0.38, 0.05],
    enableDamping: true,
    dampingFactor: 0.055,
    minDistance: 1.4,
    maxDistance: 40,
    minPolarAngle: 0.04,
    maxPolarAngle: 1.55,
    enablePan: true,
  },
  setup({ renderer, scene, camera, controls }) {
    const stage = createStudioStage({
      renderer,
      scene,
      groundY: 0,
      shadowExtent: 4.2,
      shadowNear: 1,
      shadowFar: 24,
      blushSize: [3.2, 7.2],
      blushCenter: [0, 0.3],
    });
    const car = createFormulaOneRaceCar();
    car.object.scale.z = parameters.bodyScale;
    scene.add(car.object);
    return {
      setDebugMode(mode) {
        car.setWireframe(mode === "topology");
        car.setLivery(parameters.livery && mode !== "no-livery");
        car.setProjectorDebug(mode === "projector");
        car.setRolling(mode === "rolling");
        stage.ground.visible = mode !== "topology";
        stage.blush.visible = mode !== "topology";
      },
      update({ delta, elapsed }) {
        car.update({ delta, elapsed });
        if (controls) {
          camera.position.y = Math.max(0.12, camera.position.y);
          controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.1, 2.4);
        }
      },
      metrics() {
        return {
          emittedParts: car.stats.length,
          uniqueTriangles: car.totalTriangles,
          hullRings: 168,
          hullSegments: 96,
          livery: parameters.livery,
          bodyScale: parameters.bodyScale,
        };
      },
      dispose() {
        scene.remove(car.object);
        car.dispose();
        stage.dispose();
      },
    };
  },
};
`.trimStart())

await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'm7-formula-one-race-car',
  private: true,
  type: 'module',
  dependencies: { three: '0.185.1' },
}, null, 2)}\n`)
await mkdir(resolve(destination, '.threejs-editor'), { recursive: true })
await writeFile(
  resolve(destination, '.threejs-editor', 'project.json'),
  `${JSON.stringify({
    schemaVersion: 2,
    kind: 'linked-workspace',
    title: 'P1 Formula One Race Car',
    entry: 'src/main.js',
    backend: 'webgpu',
    dependencies: { three: '0.185.1' },
    runtime: {
      debugModes: ['final', 'topology', 'no-livery', 'projector', 'rolling'],
      qualityTiers: ['default'],
      parameters: [
        {
          id: 'livery',
          label: 'Livery',
          type: 'boolean',
          path: 'src/parameters.json',
          key: 'livery',
        },
        {
          id: 'bodyScale',
          label: 'Body length',
          type: 'number',
          path: 'src/parameters.json',
          key: 'bodyScale',
          min: 0.9,
          max: 1.1,
          step: 0.01,
        },
      ],
    },
  }, null, 2)}\n`,
)
await writeFile(
  resolve(destination, 'M7-P1-SOURCE.json'),
  `${JSON.stringify({
    source: 'https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills',
    commit,
    example: 'threejs-procedural-geometry/formula-one-race-car',
    files: evidence,
  }, null, 2)}\n`,
)

process.stdout.write(`${JSON.stringify({
  corpus,
  destination,
  commit,
  files: evidence.length,
  bytes: evidence.reduce((total, file) => total + file.bytes, 0),
}, null, 2)}\n`)

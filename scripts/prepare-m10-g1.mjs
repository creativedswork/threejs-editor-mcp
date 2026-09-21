import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resetGeneratedWorkspace } from './generated-workspace.mjs'

const destination = await resetGeneratedWorkspace(
  process.argv[2] ?? '.tmp/m10-g1-workspace',
  'prepare-m10-g1',
  {
    packageName: 'm10-gameplay-systems',
    title: 'G1 Gameplay Systems',
    entry: 'src/main.js',
    backend: 'webgl',
  },
)

function createAvatarGltf() {
  const chunks = []
  const bufferViews = []
  const accessors = []
  let byteLength = 0

  const addAccessor = (array, componentType, type, options = {}) => {
    const padding = (4 - byteLength % 4) % 4
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding))
      byteLength += padding
    }
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
    const bufferView = bufferViews.length
    bufferViews.push({
      buffer: 0,
      byteOffset: byteLength,
      byteLength: bytes.length,
      ...options.target === undefined ? {} : { target: options.target },
    })
    chunks.push(bytes)
    byteLength += bytes.length
    const accessor = accessors.length
    accessors.push({
      bufferView,
      componentType,
      count: array.length / options.components,
      type,
      ...options.min === undefined ? {} : { min: options.min },
      ...options.max === undefined ? {} : { max: options.max },
    })
    return accessor
  }

  const positions = addAccessor(new Float32Array([
    -0.45, 0, 0,
    0.45, 0, 0,
    -0.35, 1.8, 0,
    0.35, 1.8, 0,
  ]), 5126, 'VEC3', {
    components: 3,
    target: 34962,
    min: [-0.45, 0, 0],
    max: [0.45, 1.8, 0],
  })
  const normals = addAccessor(new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]), 5126, 'VEC3', { components: 3, target: 34962 })
  const joints = addAccessor(new Uint16Array([
    0, 0, 0, 0,
    0, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]), 5123, 'VEC4', { components: 4, target: 34962 })
  const weights = addAccessor(new Float32Array([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]), 5126, 'VEC4', { components: 4, target: 34962 })
  const morph = addAccessor(new Float32Array([
    0, 0, 0,
    0, 0, 0,
    -0.18, 0.15, 0,
    0.18, 0.15, 0,
  ]), 5126, 'VEC3', {
    components: 3,
    target: 34962,
    min: [-0.18, 0, 0],
    max: [0.18, 0.15, 0],
  })
  const indices = addAccessor(
    new Uint16Array([0, 1, 2, 2, 1, 3]),
    5123,
    'SCALAR',
    { components: 1, target: 34963 },
  )
  const inverseBindMatrices = addAccessor(new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 1,
  ]), 5126, 'MAT4', { components: 16 })
  const times = addAccessor(
    new Float32Array([0, 0.5, 1]),
    5126,
    'SCALAR',
    { components: 1, min: [0], max: [1] },
  )
  const rotations = addAccessor(new Float32Array([
    0, 0, -0.258819, 0.965926,
    0, 0, 0.258819, 0.965926,
    0, 0, -0.258819, 0.965926,
  ]), 5126, 'VEC4', { components: 4 })
  const morphWeights = addAccessor(
    new Float32Array([0, 1, 0]),
    5126,
    'SCALAR',
    { components: 1 },
  )
  const buffer = Buffer.concat(chunks)

  const json = {
    asset: { version: '2.0', generator: 'threejs-editor-mcp M10 G1' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'Player', mesh: 0, skin: 0 },
      { name: 'RootJoint', children: [2] },
      { name: 'UpperJoint', translation: [0, 1, 0] },
    ],
    meshes: [{
      name: 'PlayerMesh',
      weights: [0],
      primitives: [{
        attributes: {
          POSITION: positions,
          NORMAL: normals,
          JOINTS_0: joints,
          WEIGHTS_0: weights,
        },
        indices,
        material: 0,
        targets: [{ POSITION: morph }],
      }],
    }],
    skins: [{
      name: 'PlayerSkin',
      inverseBindMatrices,
      skeleton: 1,
      joints: [1, 2],
    }],
    animations: [{
      name: 'Run',
      samplers: [
        { input: times, output: rotations, interpolation: 'LINEAR' },
        { input: times, output: morphWeights, interpolation: 'LINEAR' },
      ],
      channels: [
        { sampler: 0, target: { node: 2, path: 'rotation' } },
        { sampler: 1, target: { node: 0, path: 'weights' } },
      ],
    }],
    materials: [{
      name: 'PlayerMaterial',
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [0.12, 0.65, 1, 1],
        metallicFactor: 0.15,
        roughnessFactor: 0.4,
      },
    }],
    buffers: [{ byteLength: buffer.length }],
    bufferViews,
    accessors,
  }
  const jsonBytes = Buffer.from(JSON.stringify(json))
  const jsonPadding = (4 - jsonBytes.length % 4) % 4
  const binPadding = (4 - buffer.length % 4) % 4
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)])
  const binChunk = Buffer.concat([buffer, Buffer.alloc(binPadding)])
  const glb = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length)
  glb.writeUInt32LE(0x46546c67, 0)
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jsonChunk.length, 12)
  glb.writeUInt32LE(0x4e4f534a, 16)
  jsonChunk.copy(glb, 20)
  const binHeader = 20 + jsonChunk.length
  glb.writeUInt32LE(binChunk.length, binHeader)
  glb.writeUInt32LE(0x004e4942, binHeader + 4)
  binChunk.copy(glb, binHeader + 8)
  return glb
}

await mkdir(resolve(destination, 'src'), { recursive: true })
await mkdir(resolve(destination, 'assets'), { recursive: true })

await writeFile(
  resolve(destination, 'assets/avatar.glb'),
  createAvatarGltf(),
)
await writeFile(resolve(destination, 'src/parameters.json'), `${JSON.stringify({
  moveSpeed: 3,
  jumpSpeed: 4.5,
  gravity: 12,
  morphScale: 1,
}, null, 2)}\n`)
await writeFile(resolve(destination, 'src/main.js'), `
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import parameters from "./parameters.json";

export default {
  backend: "webgl",
  renderer: { options: { antialias: true }, clearColor: 0x07111d },
  camera: { fov: 52, near: 0.1, far: 80, position: [4, 3, 7] },
  controls: { enabled: false },
  async setup({ canvas, scene, camera, resolveAsset }) {
    const gltf = await new GLTFLoader().loadAsync(resolveAsset("../assets/avatar.glb"));
    const player = gltf.scene.getObjectByName("Player");
    let skinnedMesh;
    gltf.scene.traverse((object) => {
      if (object.isSkinnedMesh) skinnedMesh = object;
    });
    if (!player || !skinnedMesh || gltf.animations.length !== 1) {
      throw new Error("G1 glTF must contain one skinned, animated, morphable player.");
    }
    scene.add(gltf.scene);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x102b3b, roughness: 0.8 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.add(new THREE.HemisphereLight(0x8ed7ff, 0x08131d, 2.4));
    const key = new THREE.DirectionalLight(0xffd5a8, 4);
    key.position.set(4, 7, 3);
    scene.add(key);

    const mixer = new THREE.AnimationMixer(gltf.scene);
    const action = mixer.clipAction(gltf.animations[0]);
    action.play();
    const skeleton = new THREE.SkeletonHelper(gltf.scene);
    skeleton.visible = false;
    scene.add(skeleton);

    const keys = new Set();
    const velocity = new THREE.Vector3();
    const direction = new THREE.Vector3();
    let grounded = true;
    let audioContext;
    let audioUnlocked = false;
    let paused = true;
    const keyDown = (event) => {
      keys.add(event.code);
      if (event.code === "Space" && grounded) {
        velocity.y = parameters.jumpSpeed;
        grounded = false;
      }
    };
    const keyUp = (event) => keys.delete(event.code);
    const unlockAudio = async () => {
      audioContext ??= new AudioContext();
      await audioContext.resume();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      gain.gain.value = 0.025;
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.06);
      audioUnlocked = audioContext.state === "running";
    };
    canvas.setAttribute("tabindex", "0");
    canvas.addEventListener("keydown", keyDown);
    canvas.addEventListener("keyup", keyUp);
    canvas.addEventListener("pointerdown", () => {
      canvas.focus();
      void unlockAudio();
    }, { once: true });

    return {
      setDebugMode(mode) {
        skeleton.visible = mode === "skeleton";
        floor.material.wireframe = mode === "collision";
      },
      update({ delta, state }) {
        paused = state.paused || state.timeScale === 0;
        if (paused || delta <= 0) return;
        direction.set(
          Number(keys.has("KeyD") || keys.has("ArrowRight"))
            - Number(keys.has("KeyA") || keys.has("ArrowLeft")),
          0,
          Number(keys.has("KeyS") || keys.has("ArrowDown"))
            - Number(keys.has("KeyW") || keys.has("ArrowUp")),
        );
        if (direction.lengthSq() > 0) direction.normalize();
        velocity.x = THREE.MathUtils.damp(velocity.x, direction.x * parameters.moveSpeed, 10, delta);
        velocity.z = THREE.MathUtils.damp(velocity.z, direction.z * parameters.moveSpeed, 10, delta);
        velocity.y -= parameters.gravity * delta;
        player.position.addScaledVector(velocity, delta);
        if (player.position.y <= 0) {
          player.position.y = 0;
          velocity.y = 0;
          grounded = true;
        }
        mixer.update(delta);
        if (skinnedMesh.morphTargetInfluences) {
          skinnedMesh.morphTargetInfluences[0] *= parameters.morphScale;
        }
        camera.position.lerp(
          new THREE.Vector3(player.position.x + 4, player.position.y + 3, player.position.z + 7),
          1 - Math.exp(-5 * delta),
        );
        camera.lookAt(player.position.x, player.position.y + 0.9, player.position.z);
      },
      metrics() {
        return {
          gltfSkin: skinnedMesh.isSkinnedMesh,
          animationClips: gltf.animations.length,
          animationTime: action.time,
          morphTargets: skinnedMesh.morphTargetInfluences?.length ?? 0,
          morphWeight: skinnedMesh.morphTargetInfluences?.[0] ?? 0,
          playerPosition: player.position.toArray(),
          grounded,
          paused,
          audioUnlocked,
          audioState: audioContext?.state ?? "locked",
          inputKeys: [...keys].sort(),
        };
      },
      async dispose() {
        canvas.removeEventListener("keydown", keyDown);
        canvas.removeEventListener("keyup", keyUp);
        keys.clear();
        mixer.stopAllAction();
        mixer.uncacheRoot(gltf.scene);
        skeleton.dispose();
        scene.remove(skeleton, floor, gltf.scene, key);
        floor.geometry.dispose();
        floor.material.dispose();
        gltf.scene.traverse((object) => {
          object.geometry?.dispose?.();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material?.dispose?.();
          object.skeleton?.dispose?.();
        });
        if (audioContext && audioContext.state !== "closed") await audioContext.close();
      },
    };
  },
};
`.trimStart())
await writeFile(resolve(destination, 'package.json'), `${JSON.stringify({
  name: 'm10-gameplay-systems',
  private: true,
  type: 'module',
  dependencies: { three: '0.185.1' },
}, null, 2)}\n`)
await mkdir(resolve(destination, '.threejs-editor'), { recursive: true })
await writeFile(resolve(destination, '.threejs-editor/project.json'), `${JSON.stringify({
  schemaVersion: 2,
  kind: 'linked-workspace',
  title: 'G1 Gameplay Systems',
  entry: 'src/main.js',
  backend: 'webgl',
  dependencies: { three: '0.185.1' },
  runtime: {
    debugModes: ['final', 'skeleton', 'collision'],
    qualityTiers: ['default'],
    parameters: [
      { id: 'moveSpeed', label: 'Move speed', type: 'number', path: 'src/parameters.json', key: 'moveSpeed', min: 1, max: 8, step: 0.25 },
      { id: 'jumpSpeed', label: 'Jump speed', type: 'number', path: 'src/parameters.json', key: 'jumpSpeed', min: 2, max: 8, step: 0.25 },
      { id: 'gravity', label: 'Gravity', type: 'number', path: 'src/parameters.json', key: 'gravity', min: 4, max: 24, step: 0.5 },
      { id: 'morphScale', label: 'Morph scale', type: 'number', path: 'src/parameters.json', key: 'morphScale', min: 0, max: 1, step: 0.05 },
    ],
  },
}, null, 2)}\n`)

process.stdout.write(`${JSON.stringify({ destination }, null, 2)}\n`)

import * as THREE from 'three'

export default {
  backend: 'webgl',
  renderer: {
    clearColor: 0x10151c,
  },
  camera: {
    position: [3.8, 2.6, 4.8],
  },
  controls: {
    target: [0, 0.2, 0],
  },
  setup({ scene }) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x243040, 2.4))
    const light = new THREE.DirectionalLight(0xffffff, 3)
    light.position.set(3, 5, 4)
    scene.add(light)

    const geometry = new THREE.TorusKnotGeometry(1, 0.32, 160, 24)
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f88ff,
      metalness: 0.25,
      roughness: 0.28,
    })
    const normalMaterial = new THREE.MeshNormalMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'Runtime Contract Mesh'
    mesh.rotation.set(0.2, 0.4, 0)
    scene.add(mesh)

    let debugMode = 'final'
    return {
      setDebugMode(mode) {
        debugMode = mode
        mesh.material = mode === 'normals' ? normalMaterial : material
      },
      metrics() {
        return {
          fixture: 'runtime-contract',
          debugMode,
          vertices: geometry.attributes.position.count,
        }
      },
      dispose() {
        geometry.dispose()
        material.dispose()
        normalMaterial.dispose()
      },
    }
  },
}

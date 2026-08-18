import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'vendor/three-editor/r185')
const repository = 'https://github.com/mrdoob/three.js'
const commit = '2431a09f46f34c560bc8e44b33be0e567723d5b9'
const files = [
  'LICENSE',
  'editor/js/Command.js',
  'editor/js/History.js',
  'editor/js/commands/AddObjectCommand.js',
  'editor/js/commands/AddScriptCommand.js',
  'editor/js/commands/Commands.js',
  'editor/js/commands/MoveObjectCommand.js',
  'editor/js/commands/MultiCmdsCommand.js',
  'editor/js/commands/RemoveObjectCommand.js',
  'editor/js/commands/RemoveScriptCommand.js',
  'editor/js/commands/SetColorCommand.js',
  'editor/js/commands/SetGeometryCommand.js',
  'editor/js/commands/SetGeometryValueCommand.js',
  'editor/js/commands/SetMaterialColorCommand.js',
  'editor/js/commands/SetMaterialCommand.js',
  'editor/js/commands/SetMaterialMapCommand.js',
  'editor/js/commands/SetMaterialRangeCommand.js',
  'editor/js/commands/SetMaterialValueCommand.js',
  'editor/js/commands/SetMaterialVectorCommand.js',
  'editor/js/commands/SetPositionCommand.js',
  'editor/js/commands/SetRotationCommand.js',
  'editor/js/commands/SetScaleCommand.js',
  'editor/js/commands/SetSceneCommand.js',
  'editor/js/commands/SetScriptValueCommand.js',
  'editor/js/commands/SetShadowValueCommand.js',
  'editor/js/commands/SetTextureParametersCommand.js',
  'editor/js/commands/SetUuidCommand.js',
  'editor/js/commands/SetValueCommand.js',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sync() {
  const hashes = {}
  for (const path of files) {
    const response = await fetch(
      `https://raw.githubusercontent.com/mrdoob/three.js/${commit}/${path}`,
    )
    if (!response.ok) throw new Error(`failed to fetch ${path}: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const output = resolve(destination, path)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, bytes)
    hashes[path] = sha256(bytes)
  }
  await writeFile(resolve(destination, 'upstream.json'), `${JSON.stringify({
    repository,
    tag: 'r185',
    commit,
    license: 'MIT',
    files: hashes,
  }, null, 2)}\n`)
}

async function check() {
  const manifest = JSON.parse(await readFile(resolve(destination, 'upstream.json'), 'utf8'))
  if (manifest.repository !== repository || manifest.commit !== commit) {
    throw new Error('unexpected Three.js Editor upstream')
  }
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...files].sort())) {
    throw new Error('Three.js Editor upstream file list changed')
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const actual = sha256(await readFile(resolve(destination, path)))
    if (actual !== expected) throw new Error(`Three.js Editor upstream hash mismatch: ${path}`)
  }
  process.stdout.write(`Verified ${files.length} Three.js Editor r185 files.\n`)
}

if (process.argv.includes('--sync')) await sync()
await check()

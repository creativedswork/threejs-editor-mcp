import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  validateCaseDirectory,
  validateCases,
} from '../scripts/validate-cases.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

test('community cases are discovered and normalized without central registration', async () => {
  const report = await validateCases(join(repository, 'examples'))
  assert.equal(report.summary.cases, 1)
  assert.deepEqual(report.summary.lanes, {
    'deterministic-core': 1,
    'webgl-corpus': 0,
    'webgpu-hardware': 0,
  })
  assert.deepEqual(report.cases[0], {
    id: 'runtime-contract',
    caseFile: 'runtime-contract/case.json',
    project: {
      path: 'runtime-contract',
      title: 'Runtime Contract',
      entry: 'runtime-contract/scene.js',
      backend: 'webgl',
    },
    source: {
      type: 'repository',
      license: 'MIT',
    },
    compatibility: {
      level: 'C1',
      lane: 'deterministic-core',
      blocking: true,
    },
    capture: {
      viewport: { width: 960, height: 540, dpr: 1 },
      qualityTier: 'default',
      warmupFrames: 2,
      frames: [
        {
          id: 'final',
          debugMode: 'final',
          waitFrames: 1,
          file: 'runtime-contract/artifacts/final.png',
        },
        {
          id: 'normals',
          debugMode: 'normals',
          waitFrames: 1,
          file: 'runtime-contract/artifacts/normals.png',
        },
      ],
      contactSheet: {
        columns: 2,
        rows: 1,
        file: 'runtime-contract/artifacts/contact-sheet.png',
      },
    },
  })
})

test('case validation rejects capture modes absent from example.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-case-contract-'))
  const directory = join(root, 'invalid')
  await mkdir(directory)
  await writeFile(join(directory, 'scene.js'), 'export default { setup() { return {} } }\n')
  await writeFile(join(directory, 'example.json'), JSON.stringify({
    title: 'Invalid Capture',
    backend: 'WebGL2',
    defaultViewport: { width: 640, height: 360 },
    defaultDpr: 1,
    debugModes: [{ value: 'final' }],
  }))
  await writeFile(join(directory, 'case.json'), JSON.stringify({
    schemaVersion: 1,
    source: { type: 'repository', license: 'MIT' },
    compatibility: {
      level: 'C1',
      lane: 'deterministic-core',
      blocking: true,
    },
    capture: {
      qualityTier: 'default',
      warmupFrames: 0,
      frames: [{ id: 'missing', debugMode: 'missing', waitFrames: 0 }],
      contactSheet: { columns: 1 },
    },
  }))
  try {
    await assert.rejects(
      validateCaseDirectory(directory, root),
      /capture frame missing references unknown debug mode missing/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('case validation rejects directories outside its root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-case-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'threejs-editor-case-outside-'))
  try {
    await assert.rejects(
      validateCaseDirectory(outside, root),
      /case directory must be within the validation root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('case validation rejects quality tiers unsupported by the backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'threejs-editor-case-quality-'))
  await writeFile(join(root, 'scene.js'), 'export default { setup() { return {} } }\n')
  await writeFile(join(root, 'example.json'), JSON.stringify({
    title: 'Invalid Quality',
    backend: 'WebGL2',
    defaultViewport: { width: 640, height: 360 },
    defaultDpr: 1,
    debugModes: ['final'],
  }))
  await writeFile(join(root, 'case.json'), JSON.stringify({
    schemaVersion: 1,
    source: { type: 'repository', license: 'MIT' },
    compatibility: {
      level: 'C1',
      lane: 'deterministic-core',
      blocking: true,
    },
    capture: {
      qualityTier: 'quality',
      warmupFrames: 0,
      frames: [{ id: 'final', debugMode: 'final', waitFrames: 0 }],
      contactSheet: { columns: 1 },
    },
  }))
  try {
    await assert.rejects(
      validateCaseDirectory(root),
      /capture qualityTier quality is not supported/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

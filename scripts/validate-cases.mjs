#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const CaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('repository'),
      license: z.string().trim().min(1),
    }),
    z.strictObject({
      type: z.literal('external'),
      repository: z.url(),
      revision: z.string().regex(/^[0-9a-f]{40}$/),
      license: z.string().trim().min(1),
      distribution: z.literal('external-only'),
    }),
  ]),
  compatibility: z.strictObject({
    level: z.enum(['C0', 'C1', 'C2', 'C3', 'C4', 'C5']),
    lane: z.enum(['deterministic-core', 'webgl-corpus', 'webgpu-hardware']),
    blocking: z.boolean(),
  }),
  capture: z.strictObject({
    qualityTier: z.string().trim().min(1),
    warmupFrames: z.number().int().min(0).max(10_000),
    frames: z.array(z.strictObject({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      debugMode: z.string().trim().min(1),
      waitFrames: z.number().int().min(0).max(10_000),
    })).min(1).max(12),
    contactSheet: z.strictObject({
      columns: z.number().int().min(1).max(6),
    }),
  }),
})

const ignoredDirectories = new Set(['.git', '.tmp', 'dist', 'node_modules', 'reports'])

function slash(path) {
  return path.split(sep).join('/')
}

function fail(path, message) {
  throw new Error(`${slash(path)}: ${message}`)
}

async function readJson(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    fail(path, `${label} is not readable: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(path, `${label} is not valid JSON: ${error.message}`)
  }
}

async function requireRegularFile(path, label) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    fail(path, `${label} is missing: ${error.message}`)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(path, `${label} must be a regular file`)
  }
}

function exampleDebugModes(example, examplePath) {
  if (!Array.isArray(example.debugModes) || example.debugModes.length === 0) {
    fail(examplePath, 'example.json debugModes must be a non-empty array')
  }
  const modes = example.debugModes.map((value, index) => {
    const mode = typeof value === 'string'
      ? value
      : value !== null && typeof value === 'object'
        ? value.value
        : undefined
    if (typeof mode !== 'string' || mode.trim() === '') {
      fail(examplePath, `example.json debugModes[${index}] must name a mode`)
    }
    return mode
  })
  if (new Set(modes).size !== modes.length) {
    fail(examplePath, 'example.json debugModes must be unique')
  }
  return modes
}

function exampleViewport(example, examplePath) {
  const viewport = example.defaultViewport
  if (viewport === null
    || typeof viewport !== 'object'
    || !Number.isInteger(viewport.width)
    || viewport.width < 64
    || viewport.width > 4096
    || !Number.isInteger(viewport.height)
    || viewport.height < 64
    || viewport.height > 4096) {
    fail(examplePath, 'example.json defaultViewport must contain width and height from 64 to 4096')
  }
  if (typeof example.defaultDpr !== 'number'
    || !Number.isFinite(example.defaultDpr)
    || example.defaultDpr <= 0
    || example.defaultDpr > 4) {
    fail(examplePath, 'example.json defaultDpr must be greater than 0 and at most 4')
  }
  return {
    width: viewport.width,
    height: viewport.height,
    dpr: example.defaultDpr,
  }
}

function backend(example) {
  const value = typeof example.backend === 'string' ? example.backend.toLowerCase() : ''
  return value.includes('raw webgpu')
    ? 'raw-webgpu'
    : value.includes('webgpu')
      ? 'webgpu'
      : 'webgl'
}

export async function discoverCaseDirectories(root) {
  const absoluteRoot = resolve(root)
  const directories = []
  let visited = 0
  const visit = async directory => {
    visited += 1
    if (visited > 2048) throw new Error('case discovery exceeds 2048 directories')
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.some(entry => entry.isFile() && entry.name === 'case.json')) {
      directories.push(directory)
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await visit(resolve(directory, entry.name))
      }
    }
  }
  await visit(absoluteRoot)
  return directories.sort()
}

export async function validateCaseDirectory(caseDirectory, root = caseDirectory) {
  const absoluteRoot = resolve(root)
  const directory = resolve(caseDirectory)
  const casePath = resolve(directory, 'case.json')
  const examplePath = resolve(directory, 'example.json')
  const entryPath = resolve(directory, 'scene.js')
  await requireRegularFile(casePath, 'case.json')
  await requireRegularFile(examplePath, 'example.json')
  await requireRegularFile(entryPath, 'scene.js')

  const parsed = CaseSchema.safeParse(await readJson(casePath, 'case.json'))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    fail(casePath, `${issue.path.join('.') || 'root'}: ${issue.message}`)
  }
  const spec = parsed.data
  if (spec.compatibility.level === 'C5' && spec.compatibility.blocking) {
    fail(casePath, 'C5 cases must be non-blocking')
  }

  const example = await readJson(examplePath, 'example.json')
  if (example === null || typeof example !== 'object' || Array.isArray(example)) {
    fail(examplePath, 'example.json must contain an object')
  }
  if (typeof example.title !== 'string' || example.title.trim() === '') {
    fail(examplePath, 'example.json title must be a non-empty string')
  }
  const debugModes = exampleDebugModes(example, examplePath)
  const captureIds = spec.capture.frames.map(frame => frame.id)
  if (new Set(captureIds).size !== captureIds.length) {
    fail(casePath, 'capture frame ids must be unique')
  }
  for (const frame of spec.capture.frames) {
    if (!debugModes.includes(frame.debugMode)) {
      fail(casePath, `capture frame ${frame.id} references unknown debug mode ${frame.debugMode}`)
    }
  }

  const projectPath = slash(relative(absoluteRoot, directory)) || '.'
  const artifactRoot = projectPath === '.' ? 'artifacts' : `${projectPath}/artifacts`
  return {
    id: projectPath,
    caseFile: projectPath === '.' ? 'case.json' : `${projectPath}/case.json`,
    project: {
      path: projectPath,
      title: example.title,
      entry: projectPath === '.' ? 'scene.js' : `${projectPath}/scene.js`,
      backend: backend(example),
    },
    source: spec.source,
    compatibility: spec.compatibility,
    capture: {
      viewport: exampleViewport(example, examplePath),
      qualityTier: spec.capture.qualityTier,
      warmupFrames: spec.capture.warmupFrames,
      frames: spec.capture.frames.map(frame => ({
        ...frame,
        file: `${artifactRoot}/${frame.id}.png`,
      })),
      contactSheet: {
        columns: spec.capture.contactSheet.columns,
        rows: Math.ceil(spec.capture.frames.length / spec.capture.contactSheet.columns),
        file: `${artifactRoot}/contact-sheet.png`,
      },
    },
  }
}

export async function validateCases(root) {
  const absoluteRoot = resolve(root)
  const directories = await discoverCaseDirectories(absoluteRoot)
  const cases = await Promise.all(directories.map(directory => (
    validateCaseDirectory(directory, absoluteRoot)
  )))
  const lanes = Object.fromEntries([
    'deterministic-core',
    'webgl-corpus',
    'webgpu-hardware',
  ].map(lane => [lane, cases.filter(item => item.compatibility.lane === lane).length]))
  return {
    schemaVersion: 1,
    summary: {
      cases: cases.length,
      blocking: cases.filter(item => item.compatibility.blocking).length,
      lanes,
    },
    cases,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const reportIndex = args.indexOf('--report')
  const reportPath = reportIndex === -1 ? undefined : args[reportIndex + 1]
  if (reportIndex !== -1) args.splice(reportIndex, 2)
  if (args.length > 1 || (reportIndex !== -1 && reportPath === undefined)) {
    throw new Error('Usage: validate-cases [root] [--report path]')
  }
  const report = await validateCases(args[0] ?? 'examples')
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (reportPath !== undefined) {
    await mkdir(dirname(resolve(reportPath)), { recursive: true })
    await writeFile(resolve(reportPath), output)
  }
  process.stdout.write(output)
}

if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

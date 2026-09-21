#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import { workspaceRuntimeHtml } from '../src/workspace-runtime.ts'
import { validateCaseDirectory } from './validate-cases.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

function parseArgs() {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(name)
    if (index === -1) return undefined
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${name} requires a value`)
    args.splice(index, 2)
    return value
  }
  const output = option('--output')
  const report = option('--report')
  const server = option('--server')
  if (args.length > 2) {
    throw new Error(
      'Usage: capture-case [root] [case-id] [--server path] [--output directory] [--report path]',
    )
  }
  const root = resolve(args[0] ?? 'examples')
  const caseId = args[1] ?? 'runtime-contract'
  return {
    root,
    caseId,
    server: resolve(server ?? resolve(repository, 'dist/server.js')),
    output: resolve(output ?? `.tmp/case-artifacts/${caseId}`),
    report: resolve(report ?? `.tmp/case-artifacts/${caseId}.json`),
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function createContactSheet(browser, title, captures, columns, path) {
  const figures = await Promise.all(captures.map(async capture => {
    const data = (await readFile(capture.path)).toString('base64')
    return `<figure><img src="data:image/png;base64,${data}" alt="">`
      + `<figcaption>${escapeHtml(capture.id)}</figcaption></figure>`
  }))
  const width = Math.min(1600, Math.max(640, columns * 520))
  const rows = Math.ceil(captures.length / columns)
  const height = Math.ceil(100 + rows * ((width - 48) / columns * 9 / 16 + 48))
  const sheet = await browser.newPage({ viewport: { width, height } })
  await sheet.setContent(`
    <style>
      * { box-sizing: border-box }
      body { margin: 0; padding: 24px; background: #10151c; color: #f4f7fb;
        font: 16px system-ui, sans-serif }
      h1 { margin: 0 0 18px; font-size: 24px; letter-spacing: 0 }
      main { display: grid; grid-template-columns: repeat(${columns}, minmax(0, 1fr));
        gap: 12px }
      figure { margin: 0; padding: 8px; background: #19222d; border: 1px solid #344556 }
      img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: contain;
        background: #070a0e }
      figcaption { padding-top: 8px; text-align: center }
    </style>
    <h1>${escapeHtml(title)}</h1>
    <main>${figures.join('')}</main>
  `)
  await sheet.screenshot({ path, fullPage: true })
  await sheet.close()
  const bytes = await readFile(path)
  return { file: basename(path), sha256: sha256(bytes), bytes: bytes.length, columns }
}

async function resourceText(client, uri) {
  return (await client.readResource({ uri })).contents[0].text
}

async function buildCase(client, root, projectPath) {
  const opened = await client.callTool({
    name: 'open_editor',
    arguments: { projectPath },
    _meta: { 'ai.deepseek.dsh/workspace': { cwd: root } },
  })
  assert.equal(opened.isError, undefined, JSON.stringify(opened))
  const built = await client.callTool({
    name: 'build_project',
    arguments: {
      projectId: opened.structuredContent.projectId,
      revision: opened.structuredContent.revision,
    },
  })
  assert.equal(built.structuredContent.status, 'ready', JSON.stringify(built))
  assert.deepEqual(built.structuredContent.diagnostics, [])
  const assets = []
  for (const asset of built.structuredContent.assets) {
    if (asset.resourceUri === undefined) continue
    const chunks = []
    for (let index = 0; index < asset.chunks; index += 1) {
      const result = await client.readResource({ uri: `${asset.resourceUri}/${index}` })
      chunks.push(Buffer.from(result.contents[0].blob, 'base64'))
    }
    const bytes = Buffer.concat(chunks)
    assert.equal(bytes.length, asset.size)
    assert.equal(sha256(bytes), asset.sha256)
    assets.push({
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      base64: bytes.toString('base64'),
    })
  }
  return {
    projectId: opened.structuredContent.projectId,
    revision: opened.structuredContent.revision,
    build: built.structuredContent,
    bundle: await resourceText(client, built.structuredContent.bundleUri),
    assets,
  }
}

async function captureCase(options) {
  const caseDirectory = resolve(options.root, options.caseId)
  const manifest = await validateCaseDirectory(caseDirectory, options.root)
  const store = await mkdtemp(resolve(tmpdir(), 'threejs-editor-case-'))
  const client = new Client({ name: 'threejs-editor-case-capture', version: '1.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [options.server, '--root', store],
  }))

  const webServer = createServer((_request, response) => {
    response.writeHead(200, {
      'content-security-policy': "connect-src 'self'",
      'content-type': 'text/html; charset=utf-8',
    })
    response.end('<!doctype html><title>Case Capture</title>')
  })
  await new Promise(resolveListen => webServer.listen(0, '127.0.0.1', resolveListen))
  const address = webServer.address()
  if (address === null || typeof address === 'string') throw new Error('capture server did not bind')

  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH === undefined
      ? { channel: 'chrome' }
      : { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }),
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const problems = []
  const page = await browser.newPage({
    viewport: {
      width: manifest.capture.viewport.width,
      height: manifest.capture.viewport.height,
    },
    deviceScaleFactor: manifest.capture.viewport.dpr,
    locale: 'en-US',
  })
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))

  try {
    await mkdir(options.output, { recursive: true })
    const candidate = await buildCase(client, options.root, manifest.project.path)
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.setContent(
      '<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style>'
        + '<iframe title="Case Runtime" sandbox="allow-scripts"></iframe>',
    )
    const iframe = page.locator('iframe')
    await iframe.evaluate((element, html) => {
      element.srcdoc = html
    }, workspaceRuntimeHtml())
    const frame = await (await iframe.elementHandle()).contentFrame()
    assert.notEqual(frame, null)
    await frame.waitForSelector('canvas')

    const run = {
      projectId: candidate.projectId,
      revision: candidate.revision,
      buildId: candidate.build.buildId,
      runId: randomUUID(),
      nonce: randomUUID(),
      evidenceToken: randomUUID(),
    }
    await page.evaluate(({ request, bundle, assets, qualityTier }) => {
      globalThis.__caseEvents = []
      globalThis.addEventListener('message', event => {
        if (event.data?.channel === 'threejs-editor-m7-runtime') {
          globalThis.__caseEvents.push(event.data)
        }
      })
      const payload = assets.map(asset => {
        const raw = atob(asset.base64)
        return {
          sha256: asset.sha256,
          mediaType: asset.mediaType,
          bytes: Uint8Array.from(raw, character => character.charCodeAt(0)).buffer,
        }
      })
      document.querySelector('iframe').contentWindow.postMessage({
        channel: 'threejs-editor-m7-runtime',
        action: 'run',
        ...request,
        bundle,
        assets: payload,
        backend: request.backend,
        mode: 'run',
        debugMode: 'final',
        qualityTier,
      }, '*')
    }, {
      request: { ...run, backend: candidate.build.backend },
      bundle: candidate.bundle,
      assets: candidate.assets,
      qualityTier: manifest.capture.qualityTier,
    })

    const event = async (types, commandId) => {
      await page.waitForFunction(({ identity, accepted, command }) => (
        globalThis.__caseEvents.some(item => (
          item.runId === identity.runId
            && item.nonce === identity.nonce
            && accepted.includes(item.type)
            && (command === undefined || item.data?.commandId === command)
        ))
      ), { identity: run, accepted: types, command: commandId }, { timeout: 120_000 })
      return page.evaluate(({ identity, accepted, command }) => (
        globalThis.__caseEvents.filter(item => (
          item.runId === identity.runId
            && item.nonce === identity.nonce
            && accepted.includes(item.type)
            && (command === undefined || item.data?.commandId === command)
        )).at(-1)
      ), { identity: run, accepted: types, command: commandId })
    }
    const startup = await event(['ready', 'runtime-error'])
    assert.equal(startup.type, 'ready', JSON.stringify(startup))

    const send = async (action, payload, types) => {
      const commandId = payload?.commandId
      const offset = await page.evaluate(() => globalThis.__caseEvents.length)
      await iframe.evaluate((element, request) => {
        element.contentWindow.postMessage({
          channel: 'threejs-editor-m7-runtime',
          ...request,
        }, '*')
      }, { ...run, action, ...payload })
      await page.waitForFunction(({ start, identity, accepted, command }) => (
        globalThis.__caseEvents.slice(start).some(item => (
          item.runId === identity.runId
            && item.nonce === identity.nonce
            && accepted.includes(item.type)
            && (command === undefined || item.data?.commandId === command)
        ))
      ), {
        start: offset,
        identity: run,
        accepted: types,
        command: commandId,
      }, { timeout: 120_000 })
      return event(types, commandId)
    }
    const waitFrames = frames => {
      const commandId = randomUUID()
      return send('harness-command', {
        commandId,
        kind: 'simulate-actions',
        target: 'validation',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        actions: [{ type: 'waitFrames', frames }],
      }, ['harness-result', 'harness-error'])
    }
    const captureFrame = () => {
      const commandId = randomUUID()
      return send('harness-command', {
        commandId,
        kind: 'capture-frame',
        target: 'validation',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        deterministic: true,
        format: 'png',
        maxWidth: manifest.capture.viewport.width,
        maxHeight: manifest.capture.viewport.height,
      }, ['harness-result', 'harness-error'])
    }

    await waitFrames(manifest.capture.warmupFrames)
    await send('set-time-scale', { timeScale: 0 }, ['time-scale'])
    const captures = []
    for (const capture of manifest.capture.frames) {
      await iframe.evaluate((element, request) => {
        element.contentWindow.postMessage({
          channel: 'threejs-editor-m7-runtime',
          ...request,
        }, '*')
      }, { ...run, action: 'set-debug', debugMode: capture.debugMode })
      await waitFrames(capture.waitFrames)
      const first = await captureFrame()
      const repeated = await captureFrame()
      assert.equal(first.type, 'harness-result', JSON.stringify(first))
      assert.equal(repeated.type, 'harness-result', JSON.stringify(repeated))
      assert.equal(first.data.result.digest, repeated.data.result.digest)
      const bytes = Buffer.from(first.data.result.data, 'base64')
      const path = resolve(options.output, `${capture.id}.png`)
      await writeFile(path, bytes)
      captures.push({
        id: capture.id,
        debugMode: capture.debugMode,
        file: basename(path),
        path,
        sha256: sha256(bytes),
        bytes: bytes.length,
        width: first.data.result.width,
        height: first.data.result.height,
        repeatedDigest: repeated.data.result.digest,
      })
    }
    const metrics = await send('metrics', {}, ['metrics'])
    const disposed = await send('stop', {}, ['disposed'])
    assert.deepEqual(problems, [])
    const contactSheetPath = resolve(options.output, 'contact-sheet.png')
    const contactSheet = await createContactSheet(
      browser,
      manifest.project.title,
      captures,
      manifest.capture.contactSheet.columns,
      contactSheetPath,
    )
    const report = {
      schemaVersion: 1,
      status: 'passed',
      case: manifest,
      runtime: {
        projectId: candidate.projectId,
        revision: candidate.revision,
        buildId: candidate.build.buildId,
        runId: run.runId,
        backend: candidate.build.backend,
        browser: browser.version(),
        metrics: metrics.data,
        teardown: disposed.data,
      },
      captures: captures.map(({ path: _path, ...capture }) => capture),
      contactSheet,
      browserProblems: problems,
    }
    await mkdir(dirname(options.report), { recursive: true })
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } finally {
    await browser.close()
    await client.close()
    await new Promise(resolveClose => webServer.close(resolveClose))
    await rm(store, { recursive: true, force: true })
  }
}

captureCase(parseArgs()).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

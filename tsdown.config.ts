import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'threejs-editor-mcp/server',
    entry: { server: 'src/server.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    fixedExtension: false,
    outputOptions: {
      entryFileNames: 'server.js',
    },
  },
  {
    name: 'threejs-editor-mcp/view',
    entry: { view: 'src/view.ts' },
    outDir: 'dist',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    minify: true,
    sourcemap: false,
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'view.js',
    },
  },
  {
    name: 'threejs-editor-mcp/workspace-runtime',
    entry: { 'workspace-runtime': 'src/workspace-runtime.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    fixedExtension: false,
    outputOptions: {
      entryFileNames: 'workspace-runtime.js',
    },
  },
])

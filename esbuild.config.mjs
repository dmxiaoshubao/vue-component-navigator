import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

await rm('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/src/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['vscode'],
  sourcemap: false,
})

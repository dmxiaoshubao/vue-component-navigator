import { build } from 'esbuild'

await build({
  entryPoints: {
    runTest: 'test-host/runTest.ts',
    'suite/index': 'test-host/suite/index.ts',
  },
  outdir: '.test-host-dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['@vscode/test-electron', 'vscode'],
})

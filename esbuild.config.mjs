import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import path from 'node:path'

await rm('dist', { recursive: true, force: true })

const optionalVueTemplateEngines = [
  'atpl',
  'babel-core',
  'bracket-template',
  'coffee-script',
  'dot',
  'dustjs-linkedin',
  'eco',
  'ect',
  'ejs',
  'haml-coffee',
  'hamlet',
  'hamljs',
  'handlebars',
  'hogan.js',
  'htmling',
  'jazz',
  'jqtpl',
  'just',
  'liquor',
  'marko',
  'mote',
  'mustache',
  'plates',
  'ractive',
  'react',
  'react-dom/server',
  'slm',
  'squirrelly',
  'teacup/lib/express',
  'templayed',
  'toffee',
  'twig',
  'twing',
  'vash',
  'velocityjs',
  'walrus',
  'whiskers',
]

const vscodeTypeScriptPlugin = {
  name: 'vscode-typescript-runtime',
  setup(build) {
    build.onResolve({ filter: /^typescript$/ }, () => ({
      path: path.resolve('src/utils/typescriptRuntime.ts'),
    }))
  },
}

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/src/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  external: ['vscode', ...optionalVueTemplateEngines],
  plugins: [vscodeTypeScriptPlugin],
  sourcemap: false,
})

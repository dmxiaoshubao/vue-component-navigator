import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as vscode from 'vscode'
import type * as ts from 'typescript'

const localRequire = createRequire(__filename)

let cachedTypeScript: typeof ts | undefined

export function loadTypeScript(): typeof ts {
  if (cachedTypeScript) {
    return cachedTypeScript
  }

  cachedTypeScript = loadVscodeTypeScript() ?? loadBundledTypeScript()
  return cachedTypeScript
}

function loadVscodeTypeScript(): typeof ts | undefined {
  const roots = vscodeTypeScriptExtensionRoots()

  for (const root of roots) {
    for (const candidate of vscodeTypeScriptRuntimeCandidates(root)) {
      const uri = path.join(root, candidate)
      if (!fs.existsSync(uri)) {
        continue
      }
      const loaded = tryRequire(uri)
      if (loaded) {
        return loaded
      }
    }
  }

  return undefined
}

export function vscodeTypeScriptRuntimeCandidates(_root: string): string[] {
  return [
    '../node_modules/typescript/lib/typescript.js',
    '../node_modules/typescript/lib/tsserverlibrary.js',
    'node_modules/typescript/lib/typescript.js',
    'node_modules/typescript/lib/tsserverlibrary.js',
    'dist/browser/typescript/tsserverlibrary.js',
    'dist/typescript/tsserverlibrary.js',
  ]
}

function vscodeTypeScriptExtensionRoots(): string[] {
  try {
    const extensionPath = vscode.extensions.getExtension('vscode.typescript-language-features')?.extensionPath
    return extensionPath ? [extensionPath] : []
  } catch {
    return []
  }
}

function loadBundledTypeScript(): typeof ts {
  const loaded = tryRequire('typescript')
  if (!loaded) {
    throw new Error('Unable to load TypeScript from VS Code or local dependencies.')
  }
  return loaded
}

function tryRequire(uri: string): typeof ts | undefined {
  try {
    return localRequire(uri) as typeof ts
  } catch {
    return undefined
  }
}

const lazyTypeScript = new Proxy({}, {
  get(_target, property) {
    return (loadTypeScript() as any)[property]
  },
}) as typeof ts

export default lazyTypeScript

import type { TextSpan } from './types'
import { resolveImportPathWithExtensions } from './relationResolver'
import { maskStringsAndComments } from '../utils/scriptScan'

export interface CommandComponentModule {
  uri: string
  componentUris: string[]
  anchorSpan: TextSpan
  methods: CommandComponentMethod[]
}

export interface CommandComponentMethod {
  name: string
  span: TextSpan
}

export interface CommandComponentUsage {
  commandUri: string
  componentUris: string[]
  methodName: string
  span: TextSpan
}

interface DefaultImport {
  localName: string
  source: string
  start: number
  end: number
}

const scriptExtensions = ['.js', '.jsx', '.ts', '.tsx']

export function parseCommandComponentModule(uri: string, content: string, workspaceRoots: string[]): CommandComponentModule | undefined {
  const imports = parseDefaultImports(content)
    .filter((item) => item.source.split('?')[0].endsWith('.vue'))
  if (imports.length === 0) {
    return undefined
  }

  const searchable = maskStringsAndComments(content)
  const componentUris = imports
    .filter((item) => isRenderedComponent(searchable, item.localName))
    .map((item) => resolveImportPathWithExtensions(uri, item.source.split('?')[0], workspaceRoots, ['.vue']))
    .filter((item): item is string => Boolean(item))
  if (componentUris.length === 0) {
    return undefined
  }

  const exported = findDefaultExportObject(searchable)
  if (!exported) {
    return undefined
  }

  return {
    uri,
    componentUris: [...new Set(componentUris)],
    anchorSpan: exported.anchorSpan,
    methods: parseObjectMethods(searchable, exported.objectStart, exported.objectEnd),
  }
}

export function parseCommandComponentUsages(
  uri: string,
  content: string,
  workspaceRoots: string[],
  resolveCommandModule: (uri: string) => CommandComponentModule | undefined,
): CommandComponentUsage[] {
  const searchable = maskStringsAndComments(content)
  const usages: CommandComponentUsage[] = []

  for (const imported of parseDefaultImports(content)) {
    if (imported.source.split('?')[0].endsWith('.vue')) {
      continue
    }
    const matches: Array<{ methodName: string, span: TextSpan }> = []
    const pattern = new RegExp(`\\b${escapeRegExp(imported.localName)}\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\.)?\\s*\\(`, 'g')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(searchable))) {
      if (match.index >= imported.start && match.index < imported.end) {
        continue
      }
      const methodStart = match.index + match[0].lastIndexOf(match[1])
      matches.push({
        methodName: match[1],
        span: { start: methodStart, end: methodStart + match[1].length },
      })
    }
    if (matches.length === 0) {
      continue
    }

    const commandUri = resolveImportPathWithExtensions(uri, imported.source, workspaceRoots, scriptExtensions)
    if (!commandUri) {
      continue
    }
    const commandModule = resolveCommandModule(commandUri)
    if (!commandModule) {
      continue
    }
    const exportedMethods = new Set(commandModule.methods.map((method) => method.name))
    for (const item of matches) {
      if (!exportedMethods.has(item.methodName)) {
        continue
      }
      usages.push({
        commandUri,
        componentUris: commandModule.componentUris,
        methodName: item.methodName,
        span: item.span,
      })
    }
  }

  return usages
}

function parseDefaultImports(content: string): DefaultImport[] {
  const results: DefaultImport[] = []
  const searchable = maskStringsAndComments(content)
  const pattern = /\bimport\s+(?!type\b)([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content))) {
    if (searchable.slice(match.index, match.index + 6) !== 'import') {
      continue
    }
    results.push({
      localName: match[1],
      source: match[3],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return results
}

function isRenderedComponent(searchable: string, localName: string): boolean {
  const escaped = escapeRegExp(localName)
  return new RegExp(`<${escaped}(?:\\s|/|>)`).test(searchable)
    || new RegExp(`\\b(?:h|createVNode)\\s*\\(\\s*${escaped}\\b`).test(searchable)
}

function findDefaultExportObject(searchable: string): { anchorSpan: TextSpan, objectStart: number, objectEnd: number } | undefined {
  const match = /\bexport\s+default\s+([A-Za-z_$][\w$]*|\{)/.exec(searchable)
  if (!match) {
    return undefined
  }
  if (match[1] === '{') {
    const objectStart = match.index + match[0].lastIndexOf('{')
    const objectEnd = findMatchingBrace(searchable, objectStart)
    return objectEnd === undefined ? undefined : {
      anchorSpan: { start: match.index, end: match.index + 'export default'.length },
      objectStart,
      objectEnd,
    }
  }

  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(match[1])}\\s*=\\s*\\{`).exec(searchable)
  if (declaration) {
    const objectStart = declaration.index + declaration[0].lastIndexOf('{')
    const objectEnd = findMatchingBrace(searchable, objectStart)
    return objectEnd === undefined ? undefined : {
      anchorSpan: { start: declaration.index, end: declaration.index + declaration[0].length - 1 },
      objectStart,
      objectEnd,
    }
  }
  return undefined
}

function findMatchingBrace(searchable: string, start: number): number | undefined {
  let depth = 0
  for (let index = start; index < searchable.length; index++) {
    if (searchable[index] === '{') depth++
    if (searchable[index] === '}' && --depth === 0) return index
  }
  return undefined
}

function parseObjectMethods(searchable: string, objectStart: number, objectEnd: number): CommandComponentMethod[] {
  const methods: CommandComponentMethod[] = []
  let depth = 0
  let propertyStart = objectStart + 1

  for (let index = objectStart + 1; index <= objectEnd; index++) {
    const character = searchable[index]
    if (index === objectEnd || (character === ',' && depth === 0)) {
      const method = parseTopLevelMethod(searchable, propertyStart, index)
      if (method) methods.push(method)
      propertyStart = index + 1
      continue
    }
    if ('{[('.includes(character)) depth++
    else if ('}])'.includes(character)) depth--
  }
  return methods
}

function parseTopLevelMethod(searchable: string, start: number, end: number): CommandComponentMethod | undefined {
  const segment = searchable.slice(start, end)
  const key = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(\(|:)/.exec(segment)
  if (!key) return undefined

  const keyStart = start + key.index + key[0].indexOf(key[1])
  if (key[2] === '(') {
    return { name: key[1], span: { start: keyStart, end: keyStart + key[1].length } }
  }

  const value = segment.slice(key[0].length).trimStart()
  const callable = /^(?:async\s+)?(?:function\b|[A-Za-z_$][\w$]*\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(value)
  if (!callable || /^(?:null|true|false|undefined)\b/.test(value)) return undefined
  return { name: key[1], span: { start: keyStart, end: keyStart + key[1].length } }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

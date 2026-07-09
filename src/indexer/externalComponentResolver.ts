import fs from 'node:fs'
import path from 'node:path'
import type { MethodInfo, SourceLocation, TextSpan, VueFileIndex } from './types'
import { createLineStarts } from '../utils/position'
import { skipStringCommentOrRegex } from '../utils/scriptScan'

interface ComponentTypeLibrary {
  packageName: string
  tagPrefix: string
  typesDir: string
  classNamePrefix?: string
}

const componentTypeLibraries: ComponentTypeLibrary[] = [
  {
    packageName: 'element-ui',
    tagPrefix: 'el-',
    typesDir: 'types',
    classNamePrefix: 'El',
  },
  {
    packageName: 'vant',
    tagPrefix: 'van-',
    typesDir: 'types',
  },
]
const MAX_TYPE_FILE_BYTES = 512 * 1024

export function resolveExternalRefComponent(root: string, tag: string): VueFileIndex | undefined {
  for (const library of componentTypeLibraries) {
    const component = resolveComponentFromLibrary(root, tag, library)
    if (component) {
      return component
    }
  }

  return undefined
}

function resolveComponentFromLibrary(root: string, tag: string, library: ComponentTypeLibrary): VueFileIndex | undefined {
  if (!tag.startsWith(library.tagPrefix)) {
    return undefined
  }

  const componentPart = tag.slice(library.tagPrefix.length)
  const componentName = `${library.classNamePrefix ?? ''}${toPascalCase(componentPart)}`
  const typeUri = path.join(root, 'node_modules', library.packageName, library.typesDir, `${componentPart}.d.ts`)
  try {
    const stat = fs.statSync(typeUri)
    if (!stat.isFile() || stat.size > MAX_TYPE_FILE_BYTES) {
      return undefined
    }
    return parseDtsComponent(typeUri, componentName)
  } catch {
    return undefined
  }
}

function parseDtsComponent(uri: string, componentName: string): VueFileIndex | undefined {
  const content = fs.readFileSync(uri, 'utf8')
  const lineStarts = createLineStarts(content)
  const classBody = findClassBody(content, componentName)
  if (!classBody) {
    return undefined
  }
  const methods = parseClassMethods(content, classBody, lineStarts, uri)

  return {
    uri,
    fileName: path.basename(uri),
    vueVersion: 2,
    content,
    searchableContent: content,
    lineStarts,
    script: { content, start: 0, end: content.length },
    template: undefined,
    scriptIndex: {
      componentName,
      imports: [],
      mixins: [],
      components: [],
      staticComponentNames: [],
      props: [],
      methods,
      optionMembers: methods.map((method) => ({
        name: method.name,
        kind: 'method',
        span: method.span,
        detail: method.signature,
        documentation: method.documentation,
        sourceLocation: method.sourceLocation,
      })),
      emits: [],
      eventBusCalls: [],
      provides: [],
      injects: [],
      vue3PropUsages: [],
      composableReturnUsages: [],
      slots: [],
    },
    templateIndex: { components: [], emits: [], eventBusCalls: [], slots: [], instanceMembers: [] },
    refMethodCalls: [],
  }
}

function findClassBody(content: string, className: string): TextSpan | undefined {
  const classMatch = new RegExp(`export\\s+(?:declare\\s+)?class\\s+${escapeRegExp(className)}\\b`).exec(content)
  if (!classMatch) {
    return undefined
  }

  const open = content.indexOf('{', classMatch.index + classMatch[0].length)
  if (open === -1) {
    return undefined
  }

  let depth = 0
  for (let index = open; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '{') {
      depth += 1
      continue
    }
    if (char !== '}') {
      continue
    }
    depth -= 1
    if (depth === 0) {
      return { start: open + 1, end: index }
    }
  }

  return undefined
}

function parseClassMethods(content: string, body: TextSpan, lineStarts: number[], uri: string): MethodInfo[] {
  const candidates: Array<{ name: string, params: string, returnType: string, fullText: string, declarationStart: number }> = []
  const seen = new Set<string>()
  const bodyContent = content.slice(body.start, body.end)
  const patterns = [
    /^\s*([A-Za-z_$][\w$]*)\??\s*(?:<[^;\r\n({]*>)?\s*\(([^)]*)\)\s*:\s*([^;\r\n]+)/gm,
    /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*\(([^)]*)\)\s*=>\s*([^;\r\n]+)/gm,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(bodyContent))) {
      const [fullText, name, params, returnType] = match
      candidates.push({
        name,
        params,
        returnType,
        fullText,
        declarationStart: body.start + match.index,
      })
    }
  }

  const methods: MethodInfo[] = []
  for (const candidate of candidates.sort((left, right) => left.declarationStart - right.declarationStart)) {
    const { fullText, name, params, returnType, declarationStart } = candidate
    if (seen.has(name)) {
      continue
    }
    seen.add(name)

    const nameStart = declarationStart + fullText.indexOf(name)
    const span: TextSpan = { start: nameStart, end: nameStart + name.length }
    const signature = `${name}(${params.trim()}): ${returnType.trim()}`
    const sourceLocation: SourceLocation = { uri, lineStarts, span }
    methods.push({
      name,
      span,
      detail: signature,
      signature,
      documentation: readLeadingJSDoc(content, declarationStart),
      sourceLocation,
    })
  }

  return methods
}

function readLeadingJSDoc(content: string, declarationStart: number): string | undefined {
  let cursor = declarationStart - 1
  while (cursor >= 0 && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  if (cursor < 1 || !content.startsWith('*/', cursor - 1)) {
    return undefined
  }

  const start = content.lastIndexOf('/**', cursor - 1)
  if (start === -1) {
    return undefined
  }

  return content
    .slice(start + 3, cursor - 1)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim()
}

function toPascalCase(tag: string): string {
  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

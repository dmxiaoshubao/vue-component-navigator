import fs from 'node:fs/promises'
import path from 'node:path'
import type { RefMethodAccess, TextSpan, UsageInfo, VueFileIndex } from './types'
import { parseSfc } from './sfcParser'
import { parseScript } from './scriptParser'
import { parseTemplate } from './templateParser'
import { positionToOffset } from '../utils/position'
import { matchesName, toKebabCase } from '../utils/casing'
import { maskStringsAndComments } from '../utils/scriptScan'

export interface IndexCancellationToken {
  readonly isCancellationRequested: boolean
}

export class WorkspaceIndex {
  private readonly files = new Map<string, VueFileIndex>()
  private readonly workspaceRoots: string[] = []
  private readonly propUsages = new Map<string, UsageInfo[]>()
  private readonly eventUsages = new Map<string, UsageInfo[]>()
  private readonly refMethodUsages = new Map<string, UsageInfo[]>()

  clear(): void {
    this.files.clear()
    this.workspaceRoots.length = 0
    this.clearReverseIndexes()
  }

  replaceWith(other: WorkspaceIndex): void {
    this.files.clear()
    for (const [uri, file] of other.files) {
      this.files.set(uri, file)
    }
    this.workspaceRoots.length = 0
    this.workspaceRoots.push(...other.workspaceRoots)
    this.clearReverseIndexes()
    for (const file of this.files.values()) {
      this.addReverseIndex(file)
    }
  }

  getWorkspaceRoots(): string[] {
    return [...this.workspaceRoots]
  }

  getFileCount(): number {
    return this.files.size
  }

  getIndexedUris(): string[] {
    return [...this.files.keys()]
  }

  getFile(uri: string): VueFileIndex | undefined {
    return this.files.get(uri)
  }

  getAllFiles(): VueFileIndex[] {
    return [...this.files.values()]
  }

  indexContent(uri: string, content: string): VueFileIndex {
    const previous = this.files.get(uri)
    if (previous) {
      this.removeReverseIndex(previous)
    }

    const sfc = parseSfc(uri, content)
    const scriptIndex = sfc.script
      ? parseScript(uri, sfc.script.content, sfc.script.start, this.workspaceRoots)
      : { imports: [], components: [], props: [], methods: [], emits: [] }
    const registeredTags = scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)])
    const templateIndex = sfc.template
      ? parseTemplate(sfc.template.content, sfc.template.start, registeredTags)
      : { components: [] }
    const searchableContent = maskStringsAndComments(sfc.content)

    const file: VueFileIndex = {
      uri,
      fileName: sfc.fileName,
      content: sfc.content,
      searchableContent,
      lineStarts: sfc.lineStarts,
      script: sfc.script,
      template: sfc.template,
      scriptIndex,
      templateIndex,
      refMethodCalls: findRefMethodCalls(searchableContent),
    }
    this.files.set(uri, file)
    this.addReverseIndex(file)
    return file
  }

  syncContent(uri: string, content: string): VueFileIndex {
    const current = this.files.get(uri)
    if (current?.content === content) {
      return current
    }
    return this.indexContent(uri, content)
  }

  remove(uri: string): void {
    const file = this.files.get(uri)
    if (file) {
      this.removeReverseIndex(file)
      this.files.delete(uri)
    }
  }

  async indexFile(uri: string): Promise<VueFileIndex> {
    return this.indexContent(uri, await fs.readFile(uri, 'utf8'))
  }

  async indexWorkspace(root: string, token?: IndexCancellationToken): Promise<void> {
    if (!this.workspaceRoots.includes(root)) {
      this.workspaceRoots.push(root)
    }
    await walkVueFiles(root, async (file) => {
      await this.indexFile(file)
    }, token)
  }

  offsetAt(uri: string, line: number, character: number): number | undefined {
    const file = this.getFile(uri)
    if (!file) {
      return undefined
    }
    return positionToOffset(file.lineStarts, { line, character })
  }

  findTemplatePropUsages(childUri: string, propName: string): UsageInfo[] {
    const results: UsageInfo[] = []
    for (const key of this.propKeys(childUri, propName)) {
      results.push(...(this.propUsages.get(key) ?? []))
    }
    return results
  }

  findTemplateEventUsages(childUri: string, eventName: string): UsageInfo[] {
    return [...(this.eventUsages.get(usageKey(childUri, eventName)) ?? [])]
  }

  findRefMethodUsages(childUri: string, methodName: string): UsageInfo[] {
    return [...(this.refMethodUsages.get(usageKey(childUri, methodName)) ?? [])]
  }

  private clearReverseIndexes(): void {
    this.propUsages.clear()
    this.eventUsages.clear()
    this.refMethodUsages.clear()
  }

  private addReverseIndex(file: VueFileIndex): void {
    for (const component of file.templateIndex.components) {
      const childUri = findRegisteredComponentInFile(file, component.tag)
      if (!childUri) {
        continue
      }

      for (const attr of component.attrs) {
        if (attr.kind === 'prop') {
          addUsage(this.propUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
        } else if (attr.kind === 'event') {
          addUsage(this.eventUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
        }
      }
    }

    for (const call of file.refMethodCalls) {
      const childUri = findRefComponentInFile(file, call.refName)
      if (childUri) {
        addUsage(this.refMethodUsages, usageKey(childUri, call.methodName), { file, span: call.methodSpan })
      }
    }
  }

  private removeReverseIndex(file: VueFileIndex): void {
    removeFileUsages(this.propUsages, file)
    removeFileUsages(this.eventUsages, file)
    removeFileUsages(this.refMethodUsages, file)
  }

  private propKeys(childUri: string, propName: string): string[] {
    const keys = new Set<string>()
    keys.add(usageKey(childUri, propName))
    keys.add(usageKey(childUri, toKebabCase(propName)))

    for (const key of this.propUsages.keys()) {
      const separator = key.lastIndexOf('\0')
      if (separator === -1 || key.slice(0, separator) !== childUri) {
        continue
      }
      const indexedName = key.slice(separator + 1)
      if (matchesName(indexedName, propName)) {
        keys.add(key)
      }
    }

    return [...keys]
  }
}

async function walkVueFiles(root: string, visit: (file: string) => Promise<void>, token?: IndexCancellationToken): Promise<void> {
  const ignored = new Set([
    'node_modules',
    '.git',
    '.vscode',
    '.idea',
    '.nuxt',
    '.output',
    'dist',
    'out',
    'build',
    'coverage',
    'public',
    'vendor',
    'tmp',
    'temp',
  ])

  async function walk(directory: string): Promise<void> {
    if (token?.isCancellationRequested) {
      return
    }

    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (token?.isCancellationRequested) {
        return
      }

      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          await walk(fullPath)
        }
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.vue')) {
        await visit(fullPath)
      }
    }
  }

  await walk(root)
}

export function findRefMethodAccess(content: string, offset: number): RefMethodAccess | undefined {
  return findRefMethodAccessInSearchableContent(maskStringsAndComments(content), offset)
}

export function findRefMethodAccessInFile(file: VueFileIndex, offset: number): RefMethodAccess | undefined {
  return findRefMethodAccessInSearchableContent(file.searchableContent, offset)
}

function findRefMethodAccessInSearchableContent(searchableContent: string, offset: number): RefMethodAccess | undefined {
  return findRefMethodCalls(searchableContent).find((call) => offset >= call.methodSpan.start && offset <= call.methodSpan.end)
}

function findRefMethodCalls(searchableContent: string): RefMethodAccess[] {
  const results: RefMethodAccess[] = []
  const pattern = /this\.\$refs(?:\.|\?\.)([A-Za-z_$][\w$]*)(?:\.|\?\.)([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(searchableContent))) {
    const [, refName, methodName] = match
    const methodStart = match.index + match[0].lastIndexOf(methodName)
    const methodSpan: TextSpan = { start: methodStart, end: methodStart + methodName.length }
    results.push({ refName, methodName, methodSpan })
  }

  return results
}

export interface RefCompletionContext {
  refName: string
  accessToken: '.' | '?.'
  partialMethodName: string
}

export function findRefCompletionContext(content: string, offset: number): RefCompletionContext | undefined {
  const searchableContent = maskStringsAndComments(content)
  return findRefCompletionContextInSearchableContent(searchableContent, offset)
}

export function findRefCompletionContextInFile(file: VueFileIndex, offset: number): RefCompletionContext | undefined {
  return findRefCompletionContextInSearchableContent(file.searchableContent, offset)
}

function findRefCompletionContextInSearchableContent(searchableContent: string, offset: number): RefCompletionContext | undefined {
  const prefix = searchableContent.slice(Math.max(0, offset - 160), offset)
  const match = /this\.\$refs(?:\.|\?\.)([A-Za-z_$][\w$]*)(\.|\?\.)([A-Za-z_$][\w$]*)?$/.exec(prefix)
  if (!match) {
    return undefined
  }
  return {
    refName: match[1],
    accessToken: match[2] === '?.' ? '?.' : '.',
    partialMethodName: match[3] ?? '',
  }
}

export function findSpanAtOffset(spans: Array<{ span: TextSpan }>, offset: number): TextSpan | undefined {
  return spans.find((item) => offset >= item.span.start && offset <= item.span.end)?.span
}

export function fileNameToComponentName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}

function findRegisteredComponentInFile(parent: VueFileIndex, tag: string): string | undefined {
  const normalizedTag = toKebabCase(tag)
  return parent.scriptIndex.components.find((component) => component.tag === tag || toKebabCase(component.tag) === normalizedTag)?.targetUri
}

function findRefComponentInFile(parent: VueFileIndex, refName: string): string | undefined {
  const usage = parent.templateIndex.components.find((component) => component.attrs.some((attr) => attr.kind === 'ref' && attr.name === refName))
  return usage ? findRegisteredComponentInFile(parent, usage.tag) : undefined
}

function usageKey(uri: string, name: string): string {
  return `${uri}\0${name}`
}

function addUsage(map: Map<string, UsageInfo[]>, key: string, usage: UsageInfo): void {
  const usages = map.get(key)
  if (usages) {
    usages.push(usage)
  } else {
    map.set(key, [usage])
  }
}

function removeFileUsages(map: Map<string, UsageInfo[]>, file: VueFileIndex): void {
  for (const [key, usages] of map) {
    const kept = usages.filter((usage) => usage.file !== file)
    if (kept.length === 0) {
      map.delete(key)
    } else if (kept.length !== usages.length) {
      map.set(key, kept)
    }
  }
}

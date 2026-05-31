import fs from 'node:fs/promises'
import path from 'node:path'
import type { GlobalComponentContext, GlobalComponentRegistration, RefMethodAccess, TextSpan, UsageInfo, VueFileIndex } from './types'
import { guessGlobalComponentsFromRequireContext, parseGlobalComponents } from './globalComponentParser'
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
  private readonly globalComponents = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentRegistrations = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentContexts = new Map<string, GlobalComponentContext[]>()
  private readonly propUsages = new Map<string, UsageInfo[]>()
  private readonly eventUsages = new Map<string, UsageInfo[]>()
  private readonly refMethodUsages = new Map<string, UsageInfo[]>()

  clear(): void {
    this.files.clear()
    this.workspaceRoots.length = 0
    this.globalComponents.clear()
    this.globalComponentRegistrations.clear()
    this.globalComponentContexts.clear()
    this.clearReverseIndexes()
  }

  replaceWith(other: WorkspaceIndex): void {
    this.files.clear()
    for (const [uri, file] of other.files) {
      this.files.set(uri, file)
    }
    this.workspaceRoots.length = 0
    this.workspaceRoots.push(...other.workspaceRoots)
    this.globalComponents.clear()
    for (const [name, components] of other.globalComponents) {
      this.globalComponents.set(name, [...components])
    }
    this.globalComponentRegistrations.clear()
    for (const [fileUri, registrations] of other.globalComponentRegistrations) {
      this.globalComponentRegistrations.set(fileUri, [...registrations])
    }
    this.globalComponentContexts.clear()
    for (const [fileUri, contexts] of other.globalComponentContexts) {
      this.globalComponentContexts.set(fileUri, [...contexts])
    }
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

  getGlobalComponents(): GlobalComponentRegistration[] {
    const seen = new Set<string>()
    const results: GlobalComponentRegistration[] = []

    for (const component of [...this.globalComponents.values()].flat()) {
      const key = `${component.targetUri ?? ''}\0${component.tag}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      results.push(component)
    }

    return results
  }

  resolveGlobalComponent(tag: string, fromUri?: string): string | undefined {
    const components = this.globalComponents.get(toKebabCase(tag)) ?? []
    if (components.length === 0) {
      return undefined
    }

    if (fromUri) {
      const sameProjectComponent = components.find((component) => component.targetUri && isSameProjectFile(fromUri, component.targetUri))
      if (sameProjectComponent) {
        return sameProjectComponent.targetUri
      }
    }

    return components[0].targetUri
  }

  resolveComponent(parent: VueFileIndex, tag: string): string | undefined {
    return findRegisteredComponentInFile(parent, tag) ?? this.resolveGlobalComponent(tag, parent.uri)
  }

  resolveRefComponent(parent: VueFileIndex, refName: string): string | undefined {
    const usage = parent.templateIndex.components.find((component) => component.attrs.some((attr) => attr.kind === 'ref' && attr.name === refName))
    return usage ? this.resolveComponent(parent, usage.tag) : undefined
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
    const registeredTags = [
      ...scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
      ...this.getGlobalComponents().flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
    ]
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
    const vueFiles: string[] = []
    const scriptFiles: string[] = []
    await walkIndexableFiles(root, async (file) => {
      if (file.endsWith('.vue')) {
        vueFiles.push(file)
      } else if (isScriptFile(file)) {
        scriptFiles.push(file)
      }
    }, token)
    if (token?.isCancellationRequested) {
      return
    }

    for (const file of scriptFiles) {
      await this.indexGlobalComponentFile(file)
      if (token?.isCancellationRequested) {
        return
      }
    }

    await this.expandRequireContextGlobals(vueFiles)
    if (token?.isCancellationRequested) {
      return
    }

    for (const file of vueFiles) {
      await this.indexFile(file)
      if (token?.isCancellationRequested) {
        return
      }
    }
  }

  async indexGlobalComponentFile(uri: string): Promise<void> {
    const content = await fs.readFile(uri, 'utf8')
    await this.indexGlobalComponentContent(uri, content)
  }

  async indexGlobalComponentContent(uri: string, content: string): Promise<void> {
    this.removeGlobalRegistrationsFromFile(uri)
    const registrations = parseGlobalComponents(uri, content, this.workspaceRoots)
    if (registrations.length > 0) {
      this.globalComponentRegistrations.set(uri, registrations)
    }
    this.addGlobalComponents(await this.resolveImportedNameGlobalComponents(registrations))
    const contexts = guessGlobalComponentsFromRequireContext(uri, content)
    if (contexts.length > 0) {
      this.globalComponentContexts.set(uri, contexts)
    }
  }

  async syncGlobalComponentFile(uri: string): Promise<void> {
    await this.indexGlobalComponentFile(uri)
    await this.refreshRequireContextGlobals(this.getIndexedUris())
    this.rebuildIndexedFiles()
  }

  removeGlobalComponentFile(uri: string): void {
    this.removeGlobalRegistrationsFromFile(uri)
    this.rebuildIndexedFiles()
  }

  async refreshGlobalComponentsFromVueFiles(): Promise<void> {
    if (!this.hasVueNameBasedGlobals()) {
      return
    }

    await this.refreshImportedNameGlobalComponents()
    await this.refreshRequireContextGlobals(this.getIndexedUris())
    this.rebuildIndexedFiles()
  }

  async refreshGlobalComponentsForVueFile(uri: string): Promise<void> {
    if (!this.isVueNameSourceFile(uri)) {
      return
    }

    await this.refreshGlobalComponentsFromVueFiles()
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
      const childUri = this.resolveComponent(file, component.tag)
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
      const childUri = this.resolveRefComponent(file, call.refName)
      if (childUri) {
        addUsage(this.refMethodUsages, usageKey(childUri, call.methodName), { file, span: call.methodSpan })
      }
    }
  }

  private addGlobalComponents(components: GlobalComponentRegistration[]): void {
    for (const component of components) {
      if (!component.targetUri) {
        continue
      }
      if (!this.isInsideWorkspace(component.targetUri)) {
        continue
      }
      this.addGlobalComponentAlias(component.tag, component)
      this.addGlobalComponentAlias(component.localName, component)
    }
  }

  private addGlobalComponentAlias(name: string, component: GlobalComponentRegistration): void {
    const key = toKebabCase(name)
    const components = this.globalComponents.get(key) ?? []
    const next = components.filter((item) => item.fileUri !== component.fileUri || item.targetUri !== component.targetUri)
    next.push(component)
    this.globalComponents.set(key, next)
  }

  private removeGlobalRegistrationsFromFile(fileUri: string): void {
    for (const [name, components] of this.globalComponents) {
      const kept = components.filter((component) => component.fileUri !== fileUri)
      if (kept.length === 0) {
        this.globalComponents.delete(name)
      } else if (kept.length !== components.length) {
        this.globalComponents.set(name, kept)
      }
    }
    this.globalComponentContexts.delete(fileUri)
    this.globalComponentRegistrations.delete(fileUri)
  }

  private removeGlobalComponentsFromContexts(): void {
    const contextFiles = new Set(this.globalComponentContexts.keys())
    for (const [name, components] of this.globalComponents) {
      const kept = components.filter((component) => !contextFiles.has(component.fileUri) || !component.usesImportedName || component.source)
      if (kept.length === 0) {
        this.globalComponents.delete(name)
      } else if (kept.length !== components.length) {
        this.globalComponents.set(name, kept)
      }
    }
  }

  private hasVueNameBasedGlobals(): boolean {
    return this.globalComponentContexts.size > 0 || this.getGlobalComponents().some((component) => component.usesImportedName)
  }

  private isVueNameSourceFile(uri: string): boolean {
    return this.getGlobalComponents().some((component) => component.usesImportedName && component.targetUri === uri)
      || [...this.globalComponentContexts.values()].flat().some((context) => isInsideDirectory(uri, context.targetUri))
  }

  private async refreshImportedNameGlobalComponents(): Promise<void> {
    const components = [...this.globalComponentRegistrations.values()]
      .flat()
      .filter((component) => component.usesImportedName && component.source)
    const byFile = new Map<string, GlobalComponentRegistration[]>()
    for (const component of components) {
      const registrations = byFile.get(component.fileUri) ?? []
      registrations.push(component)
      byFile.set(component.fileUri, registrations)
    }

    for (const [fileUri, componentsInFile] of byFile) {
      for (const [name, components] of this.globalComponents) {
        const kept = components.filter((component) => component.fileUri !== fileUri || !component.usesImportedName)
        if (kept.length === 0) {
          this.globalComponents.delete(name)
        } else if (kept.length !== components.length) {
          this.globalComponents.set(name, kept)
        }
      }
      this.addGlobalComponents(await this.resolveImportedNameGlobalComponents(componentsInFile))
    }
  }

  private rebuildIndexedFiles(): void {
    const indexedFiles = this.getAllFiles().map((file) => ({ uri: file.uri, content: file.content }))
    this.files.clear()
    this.clearReverseIndexes()
    for (const file of indexedFiles) {
      this.indexContent(file.uri, file.content)
    }
  }

  private async resolveImportedNameGlobalComponents(components: GlobalComponentRegistration[]): Promise<GlobalComponentRegistration[]> {
    const resolved: GlobalComponentRegistration[] = []

    for (const component of components) {
      if (!component.usesImportedName || !component.targetUri) {
        resolved.push(component)
        continue
      }

      const componentName = await this.readVueComponentName(component.targetUri)
      if (!componentName) {
        continue
      }

      resolved.push({
        ...component,
        tag: componentName,
        localName: componentName,
      })
    }

    return resolved
  }

  private async readVueComponentName(uri: string): Promise<string | undefined> {
    if (!this.isInsideWorkspace(uri)) {
      return undefined
    }

    const indexed = this.files.get(uri)
    if (indexed) {
      return indexed.scriptIndex.componentName
    }

    try {
      const content = await fs.readFile(uri, 'utf8')
      const parsed = parseSfc(uri, content)
      if (!parsed.script) {
        return undefined
      }
      return parseScript(uri, parsed.script.content, parsed.script.start, this.workspaceRoots).componentName
    } catch {
      return undefined
    }
  }

  private async expandRequireContextGlobals(vueFiles: string[]): Promise<void> {
    const contexts = [...this.globalComponentContexts.values()].flat()
    if (contexts.length === 0) {
      return
    }

    for (const context of contexts) {
      if (!context.targetUri) {
        continue
      }
      for (const file of vueFiles) {
        if (!isInsideDirectory(file, context.targetUri)) {
          continue
        }
        const componentName = await this.readVueComponentName(file)
        if (!componentName) {
          continue
        }
        this.addGlobalComponents([{
          tag: componentName,
          localName: componentName,
          targetUri: file,
          usesImportedName: true,
          nameSpan: { start: 0, end: 0 },
          registerSpan: context.registerSpan,
          fileUri: context.fileUri,
        }])
      }
    }
  }

  private async refreshRequireContextGlobals(vueFiles: string[]): Promise<void> {
    this.removeGlobalComponentsFromContexts()
    await this.expandRequireContextGlobals(vueFiles)
  }

  private isInsideWorkspace(uri: string): boolean {
    if (this.workspaceRoots.length === 0) {
      return true
    }
    return this.workspaceRoots.some((root) => uri === root || isInsideDirectory(uri, root))
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

async function walkIndexableFiles(root: string, visit: (file: string) => Promise<void>, token?: IndexCancellationToken): Promise<void> {
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
      if (entry.isFile() && (entry.name.endsWith('.vue') || isScriptFile(entry.name))) {
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
    ?? parent.scriptIndex.components.find((component) => toKebabCase(component.localName) === normalizedTag)?.targetUri
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

function isScriptFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.ts')
}

function isInsideDirectory(file: string, directory: string): boolean {
  const relative = path.relative(directory, file)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isSameProjectFile(left: string, right: string): boolean {
  const leftSrc = findSrcSegment(left)
  const rightSrc = findSrcSegment(right)
  return leftSrc !== undefined && leftSrc === rightSrc
}

function findSrcSegment(file: string): string | undefined {
  const parts = path.normalize(file).split(path.sep)
  const index = parts.lastIndexOf('src')
  return index === -1 ? undefined : parts.slice(0, index + 1).join(path.sep)
}

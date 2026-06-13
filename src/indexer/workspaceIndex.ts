import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ComponentRegistration, EventBusCall, EventBusRegistration, EventBusUsageInfo, GlobalComponentContext, GlobalComponentRegistration, InjectInfo, MethodInfo, MixinReference, PropInfo, ProvideInfo, RefMethodAccess, ScriptIndex, SourceLocation, TemplateComponentUsage, TextSpan, UsageInfo, VueFileIndex } from './types'
import { defaultEventBusNames, parseEventBusRegistrations, parseStaticImportSources } from './eventBusParser'
import { resolveExternalRefComponent } from './externalComponentResolver'
import { guessGlobalComponentsFromRequireContext, parseGlobalComponents } from './globalComponentParser'
import { resolveImportPathWithExtensions, resolveProjectPathWithExtensions } from './relationResolver'
import { parseSfc } from './sfcParser'
import { parseScript } from './scriptParser'
import { parseTemplate } from './templateParser'
import { createLineStarts, positionToOffset } from '../utils/position'
import { matchesName, toKebabCase } from '../utils/casing'
import { maskStringsAndComments } from '../utils/scriptScan'

export interface IndexCancellationToken {
  readonly isCancellationRequested: boolean
}

type EventBusEntryConfig = string | readonly string[]

export class WorkspaceIndex {
  private readonly files = new Map<string, VueFileIndex>()
  private readonly workspaceRoots: string[] = []
  private readonly eventBusEntriesByRoot = new Map<string, string[]>()
  private readonly externalRefComponents = new Map<string, VueFileIndex | undefined>()
  private readonly externalRefComponentUris = new Map<string, VueFileIndex>()
  private readonly globalComponents = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentRegistrations = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentContexts = new Map<string, GlobalComponentContext[]>()
  private readonly eventBusRegistrations = new Map<string, EventBusRegistration[]>()
  private readonly propUsages = new Map<string, UsageInfo[]>()
  private readonly eventUsages = new Map<string, UsageInfo[]>()
  private readonly eventBusEmits = new Map<string, EventBusUsageInfo[]>()
  private readonly eventBusListeners = new Map<string, EventBusUsageInfo[]>()
  private readonly eventBusEventNames = new Map<string, Set<string>>()
  private readonly refMethodUsages = new Map<string, UsageInfo[]>()
  private readonly provideDefinitions = new Map<string, UsageInfo[]>()
  private readonly injectUsages = new Map<string, UsageInfo[]>()
  private readonly parentComponents = new Map<string, Set<string>>()
  private readonly mixinIndexCache = new Map<string, { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } | undefined>()
  private readonly mixinSourceUris = new Set<string>()
  private isBulkIndexing = false

  clear(): void {
    this.files.clear()
    this.workspaceRoots.length = 0
    this.eventBusEntriesByRoot.clear()
    this.externalRefComponents.clear()
    this.externalRefComponentUris.clear()
    this.globalComponents.clear()
    this.globalComponentRegistrations.clear()
    this.globalComponentContexts.clear()
    this.eventBusRegistrations.clear()
    this.mixinIndexCache.clear()
    this.mixinSourceUris.clear()
    this.clearReverseIndexes()
  }

  replaceWith(other: WorkspaceIndex): void {
    this.files.clear()
    for (const [uri, file] of other.files) {
      this.files.set(uri, file)
    }
    this.workspaceRoots.length = 0
    this.workspaceRoots.push(...other.workspaceRoots)
    this.eventBusEntriesByRoot.clear()
    for (const [root, entries] of other.eventBusEntriesByRoot) {
      this.eventBusEntriesByRoot.set(root, [...entries])
    }
    this.externalRefComponents.clear()
    this.externalRefComponentUris.clear()
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
    this.eventBusRegistrations.clear()
    for (const [fileUri, registrations] of other.eventBusRegistrations) {
      this.eventBusRegistrations.set(fileUri, [...registrations])
    }
    this.mixinIndexCache.clear()
    this.mixinSourceUris.clear()
    for (const uri of other.mixinSourceUris) {
      this.mixinSourceUris.add(uri)
    }
    this.rebuildReverseIndexes()
  }

  getWorkspaceRoots(): string[] {
    return [...this.workspaceRoots]
  }

  setEventBusEntries(root: string, entries: EventBusEntryConfig): void {
    const values = Array.isArray(entries) ? entries : [entries]
    const normalized = uniqueStrings(values.map((entry) => entry.trim()).filter(Boolean))
    if (normalized.length === 0) {
      this.eventBusEntriesByRoot.delete(root)
      return
    }
    this.eventBusEntriesByRoot.set(root, normalized)
  }

  getFileCount(): number {
    return this.files.size
  }

  getIndexedUris(): string[] {
    return [...this.files.keys()]
  }

  getFile(uri: string): VueFileIndex | undefined {
    return this.files.get(uri) ?? this.externalRefComponentUris.get(uri)
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

  resolveTemplateComponentUris(parent: VueFileIndex, component: TemplateComponentUsage): string[] {
    const tags = component.dynamicTags?.length ? component.dynamicTags : [component.tag]
    return uniqueStrings(tags.map((tag) => this.resolveComponent(parent, tag)).filter((uri): uri is string => Boolean(uri)))
  }

  resolveRefComponent(parent: VueFileIndex, refName: string): string | undefined {
    return this.resolveRefComponents(parent, refName)[0]
  }

  resolveRefComponents(parent: VueFileIndex, refName: string): string[] {
    const usage = parent.templateIndex.components.find((component) => component.attrs.some((attr) => attr.kind === 'ref' && attr.name === refName))
    if (!usage) {
      return []
    }
    const tags = usage.dynamicTags?.length ? usage.dynamicTags : [usage.tag]
    return uniqueStrings(tags
      .map((tag) => this.resolveComponent(parent, tag) ?? this.resolveExternalRefComponent(parent.uri, tag))
      .filter((uri): uri is string => Boolean(uri)))
  }

  indexContent(uri: string, content: string): VueFileIndex {
    const previous = this.files.get(uri)
    const previousRelationshipChildren = previous ? this.relationshipChildren(previous) : new Set<string>()
    const wasMixinSource = this.isMixinSourceFile(uri) || this.hasMixinCacheForFile(uri)
    this.clearMixinCacheForFile(uri)
    if (previous) {
      this.removeReverseIndex(previous)
    }

    const sfc = parseSfc(uri, content)
    const eventBusNames = this.getEventBusNames()
    const ownScriptIndex = sfc.script
      ? parseScript(uri, sfc.script.content, sfc.script.start, this.workspaceRoots, 'default', eventBusNames)
      : { imports: [], mixins: [], components: [], staticComponentNames: [], props: [], methods: [], emits: [], eventBusCalls: [], provides: [], injects: [] }
    const mixed = this.mergeStaticMixins(uri, ownScriptIndex)
    let scriptIndex = mixed.scriptIndex
    const registeredTags = [
      ...scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
      ...this.getGlobalComponents().flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
    ]
    const templateIndex = sfc.template
      ? parseTemplate(sfc.template.content, sfc.template.start, registeredTags, scriptIndex.staticComponentNames, eventBusNames)
      : { components: [], emits: [], eventBusCalls: [] }
    scriptIndex = {
      ...scriptIndex,
      emits: [...scriptIndex.emits, ...templateIndex.emits],
      eventBusCalls: [...scriptIndex.eventBusCalls, ...templateIndex.eventBusCalls],
    }
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
      refMethodCalls: [
        ...findRefMethodCalls(searchableContent),
        ...mixed.refMethodCalls,
      ],
    }
    this.files.set(uri, file)
    if (this.isBulkIndexing) {
      return file
    }

    this.addProvideDefinitions(file)
    const relationshipChildren = this.addRelationshipUsages(file)
    this.addEventBusUsages(file)
    this.addInjectUsages(file)
    if (file.scriptIndex.provides.length > 0 || (previous?.scriptIndex.provides.length ?? 0) > 0 || !sameStringSet(previousRelationshipChildren, relationshipChildren)) {
      this.rebuildReverseIndexes()
    }
    if (wasMixinSource) {
      this.rebuildIndexedFiles()
    }
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
    const wasMixinSource = this.isMixinSourceFile(uri) || this.hasMixinCacheForFile(uri)
    this.clearMixinCacheForFile(uri)
    const file = this.files.get(uri)
    const hadRelationships = (file?.templateIndex.components.length ?? 0) > 0
    if (file) {
      this.removeReverseIndex(file)
      this.files.delete(uri)
      this.parentComponents.delete(uri)
    }
    if (hadRelationships) {
      this.rebuildReverseIndexes()
    }
    if (wasMixinSource) {
      this.rebuildIndexedFiles()
    }
  }

  async indexFile(uri: string): Promise<VueFileIndex> {
    return this.indexContent(uri, await fs.readFile(uri, 'utf8'))
  }

  async indexWorkspace(root: string, token?: IndexCancellationToken, eventBusEntries?: EventBusEntryConfig): Promise<void> {
    if (!this.workspaceRoots.includes(root)) {
      this.workspaceRoots.push(root)
    }
    if (eventBusEntries !== undefined) {
      this.setEventBusEntries(root, eventBusEntries)
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

    await this.refreshEventBusRegistrations(root, token)
    if (token?.isCancellationRequested) {
      return
    }

    this.isBulkIndexing = true
    try {
      for (const file of vueFiles) {
        await this.indexFile(file)
        if (token?.isCancellationRequested) {
          return
        }
      }
    } finally {
      this.isBulkIndexing = false
      this.rebuildReverseIndexes()
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
    this.clearMixinCacheForFile(uri)
    await this.indexGlobalComponentFile(uri)
    await this.refreshEventBusRegistrations()
    await this.refreshRequireContextGlobals(this.getIndexedUris())
    this.rebuildIndexedFiles()
  }

  async removeGlobalComponentFile(uri: string): Promise<void> {
    this.clearMixinCacheForFile(uri)
    this.removeGlobalRegistrationsFromFile(uri)
    await this.refreshEventBusRegistrations()
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

  findEventBusEmits(busName: string, eventName: string): EventBusUsageInfo[] {
    return dedupeUsages(this.eventBusEmits.get(eventBusKey(busName, eventName)) ?? [])
  }

  findEventBusListeners(busName: string, eventName: string): EventBusUsageInfo[] {
    return dedupeUsages(this.eventBusListeners.get(eventBusKey(busName, eventName)) ?? [])
  }

  getEventBusEventNames(busName: string): string[] {
    return [...(this.eventBusEventNames.get(busName) ?? [])].sort()
  }

  findRefMethodUsages(childUri: string, methodName: string): UsageInfo[] {
    return dedupeUsages(this.refMethodUsages.get(usageKey(childUri, methodName)) ?? [])
  }

  findInjectUsages(providerUri: string, provideKey: string): UsageInfo[] {
    return (this.injectUsages.get(usageKey(providerUri, provideKey)) ?? [])
      .filter((usage) => this.isStaticAncestor(providerUri, usage.file.uri))
  }

  findProvideDefinitions(consumer: VueFileIndex, injectKey: string): UsageInfo[] {
    return this.findNearestProvideDefinitions(consumer, injectKey)
  }

  getProvideKeysForConsumer(consumerUri: string): string[] {
    const results: string[] = []
    const seen = new Set<string>()
    const visited = new Set<string>([consumerUri])
    let current = [...(this.parentComponents.get(consumerUri) ?? [])]

    for (let depth = 0; depth < 8 && current.length > 0; depth += 1) {
      const next: string[] = []
      for (const uri of current) {
        if (visited.has(uri)) {
          continue
        }
        visited.add(uri)
        const file = this.files.get(uri)
        if (file) {
          for (const provide of file.scriptIndex.provides) {
            if (seen.has(provide.key)) {
              continue
            }
            seen.add(provide.key)
            results.push(provide.key)
          }
        }

        for (const parentUri of this.parentComponents.get(uri) ?? []) {
          if (visited.has(parentUri)) {
            continue
          }
          next.push(parentUri)
        }
      }
      current = next
    }

    return results
  }

  hasMixinSource(uri: string): boolean {
    return this.mixinSourceUris.has(uri) || this.hasMixinCacheForFile(uri)
  }

  async refreshEventBusRegistrations(root?: string, token?: IndexCancellationToken): Promise<void> {
    const roots = root ? [root] : this.workspaceRoots
    if (root && !this.workspaceRoots.includes(root)) {
      this.workspaceRoots.push(root)
    }
    if (root) {
      this.removeEventBusRegistrationsInRoot(root)
    } else {
      this.eventBusRegistrations.clear()
    }

    for (const workspaceRoot of roots) {
      if (token?.isCancellationRequested) {
        return
      }
      const registrations = await this.detectEventBusRegistrations(workspaceRoot, token)
      for (const registration of registrations) {
        const current = this.eventBusRegistrations.get(registration.fileUri) ?? []
        current.push(registration)
        this.eventBusRegistrations.set(registration.fileUri, current)
      }
    }
  }

  getEventBusNames(): string[] {
    return [...new Set([
      ...defaultEventBusNames,
      ...[...this.eventBusRegistrations.values()].flat().map((registration) => registration.propertyName),
    ])]
  }

  findTemplatePropUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceProps(sourceUri, offset)
      .flatMap(({ file, prop }) => this.findTemplatePropUsages(file.uri, prop.name)))
  }

  findRefMethodUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceMethods(sourceUri, offset)
      .flatMap(({ file, method }) => this.findRefMethodUsages(file.uri, method.name)))
  }

  findTemplateEventUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceEmits(sourceUri, offset)
      .flatMap(({ file, emit }) => this.findTemplateEventUsages(file.uri, emit.eventName)))
  }

  findEventBusListenersFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceEventBusCalls(sourceUri, offset)
      .filter(({ call }) => call.kind === 'emit')
      .flatMap(({ call }) => this.findEventBusListeners(call.busName, call.eventName)))
  }

  findEventBusEmitsFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceEventBusCalls(sourceUri, offset)
      .filter(({ call }) => call.kind === 'listener')
      .flatMap(({ call }) => this.findEventBusEmits(call.busName, call.eventName)))
  }

  findInjectUsagesFromProvideSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceProvides(sourceUri, offset)
      .flatMap(({ file, provide }) => this.findInjectUsages(file.uri, provide.key)))
  }

  findProvideDefinitionsFromInjectSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceInjects(sourceUri, offset)
      .flatMap(({ file, inject }) => this.findProvideDefinitions(file, inject.key)))
  }

  findSourceRefMethodCalls(sourceUri: string, offset: number): Array<{ file: VueFileIndex, call: RefMethodAccess }> {
    const results: Array<{ file: VueFileIndex, call: RefMethodAccess }> = []
    for (const file of this.files.values()) {
      for (const call of file.refMethodCalls) {
        if (containsSourceOffset(call.sourceLocation, sourceUri, offset)) {
          results.push({ file, call })
        }
      }
    }
    return results
  }

  findSourceEventBusCalls(sourceUri: string, offset: number): Array<{ file: VueFileIndex, call: EventBusCall }> {
    const results: Array<{ file: VueFileIndex, call: EventBusCall }> = []
    for (const file of this.files.values()) {
      for (const call of file.scriptIndex.eventBusCalls) {
        if (containsSourceOffset(call.sourceLocation, sourceUri, offset)) {
          results.push({ file, call })
        }
      }
    }
    return results
  }

  findSourceRefOwners(sourceUri: string, refName: string): VueFileIndex[] {
    const results: VueFileIndex[] = []
    const seen = new Set<string>()
    for (const file of this.files.values()) {
      if (!usesSource(file, sourceUri) || seen.has(file.uri) || !this.resolveRefComponent(file, refName)) {
        continue
      }
      seen.add(file.uri)
      results.push(file)
    }
    return results
  }

  findSourceConsumers(sourceUri: string): VueFileIndex[] {
    return [...this.files.values()].filter((file) => usesSource(file, sourceUri))
  }

  private isStaticAncestor(ancestorUri: string, childUri: string): boolean {
    if (ancestorUri === childUri) {
      return false
    }

    const visited = new Set<string>([childUri])
    let current = [childUri]
    for (let depth = 0; depth < 8 && current.length > 0; depth += 1) {
      const next: string[] = []
      for (const uri of current) {
        for (const parentUri of this.parentComponents.get(uri) ?? []) {
          if (parentUri === ancestorUri) {
            return true
          }
          if (visited.has(parentUri)) {
            continue
          }
          visited.add(parentUri)
          next.push(parentUri)
        }
      }
      current = next
    }

    return false
  }

  private async detectEventBusRegistrations(root: string, token?: IndexCancellationToken): Promise<EventBusRegistration[]> {
    const entryContents: Array<{ uri: string, content: string }> = []
    const directRegistrations: EventBusRegistration[] = []

    for (const uri of this.eventBusEntryCandidates(root)) {
      if (token?.isCancellationRequested) {
        return []
      }
      const content = await readTextIfExists(uri)
      if (content === undefined) {
        continue
      }
      entryContents.push({ uri, content })
      directRegistrations.push(...parseEventBusRegistrations(uri, content))
    }

    if (directRegistrations.length > 0 || entryContents.length === 0) {
      return directRegistrations
    }

    // 入口本身没有注册时，只展开入口直接引入的一层文件，避免递归扫描拖慢大项目。
    const importedUris = uniqueStrings(entryContents.flatMap(({ uri, content }) => {
      return parseStaticImportSources(content)
        .map((source) => resolveImportPathWithExtensions(uri, source, this.workspaceRootsFor(root), ['.js', '.ts']))
        .filter((resolved): resolved is string => Boolean(resolved))
        .filter((resolved) => this.isInsideWorkspace(resolved) && !isInsideNodeModules(resolved))
    }))

    const importedRegistrations: EventBusRegistration[] = []
    for (const uri of importedUris) {
      if (token?.isCancellationRequested) {
        return []
      }
      const content = await readTextIfExists(uri)
      if (content !== undefined) {
        importedRegistrations.push(...parseEventBusRegistrations(uri, content))
      }
    }

    return importedRegistrations
  }

  private eventBusEntryCandidates(root: string): string[] {
    const configuredEntries = this.eventBusEntriesByRoot.get(root)
    if (configuredEntries && configuredEntries.length > 0) {
      return uniqueStrings(configuredEntries
        .map((entry) => resolveProjectPathWithExtensions(root, entry, this.workspaceRootsFor(root), ['.js', '.ts']))
        .filter((resolved): resolved is string => Boolean(resolved))
        .filter((resolved) => this.isInsideWorkspace(resolved) && !isInsideNodeModules(resolved)))
    }

    return defaultEventBusEntryCandidates(root)
  }

  private findNearestProvideDefinitions(consumer: VueFileIndex, injectKey: string): UsageInfo[] {
    const definitionsByUri = new Map<string, UsageInfo[]>()
    for (const usage of this.provideDefinitions.get(injectKey) ?? []) {
      if (!isSameProjectFileOrUnknown(consumer.uri, usage.file.uri)) {
        continue
      }
      const definitions = definitionsByUri.get(usage.file.uri) ?? []
      definitions.push(usage)
      definitionsByUri.set(usage.file.uri, definitions)
    }

    if (definitionsByUri.size === 0) {
      return []
    }

    const results: UsageInfo[] = []
    const seenDefinitions = new Set<string>()
    const visited = new Set<string>([consumer.uri])
    let current = [...(this.parentComponents.get(consumer.uri) ?? [])]

    for (let depth = 0; depth < 8 && current.length > 0; depth += 1) {
      const next: string[] = []
      for (const uri of current) {
        if (visited.has(uri)) {
          continue
        }
        visited.add(uri)

        const definitions = definitionsByUri.get(uri)
        if (definitions) {
          for (const definition of definitions) {
            const key = `${definition.file.uri}\0${definition.span.start}\0${definition.span.end}`
            if (seenDefinitions.has(key)) {
              continue
            }
            seenDefinitions.add(key)
            results.push(definition)
          }
          continue
        }

        for (const parentUri of this.parentComponents.get(uri) ?? []) {
          if (!visited.has(parentUri)) {
            next.push(parentUri)
          }
        }
      }
      current = next
    }

    return results
  }

  private findSourceProps(sourceUri: string, offset: number): Array<{ file: VueFileIndex, prop: PropInfo }> {
    const results: Array<{ file: VueFileIndex, prop: PropInfo }> = []
    for (const file of this.files.values()) {
      for (const prop of file.scriptIndex.props) {
        if (containsSourceOffset(prop.sourceLocation, sourceUri, offset)) {
          results.push({ file, prop })
        }
      }
    }
    return results
  }

  private findSourceMethods(sourceUri: string, offset: number): Array<{ file: VueFileIndex, method: MethodInfo }> {
    const results: Array<{ file: VueFileIndex, method: MethodInfo }> = []
    for (const file of this.files.values()) {
      for (const method of file.scriptIndex.methods) {
        if (containsSourceOffset(method.sourceLocation, sourceUri, offset)) {
          results.push({ file, method })
        }
      }
    }
    return results
  }

  private findSourceEmits(sourceUri: string, offset: number): Array<{ file: VueFileIndex, emit: ScriptIndex['emits'][number] }> {
    const results: Array<{ file: VueFileIndex, emit: ScriptIndex['emits'][number] }> = []
    for (const file of this.files.values()) {
      for (const emit of file.scriptIndex.emits) {
        if (containsSourceOffset(emit.sourceLocation, sourceUri, offset)) {
          results.push({ file, emit })
        }
      }
    }
    return results
  }

  private findSourceProvides(sourceUri: string, offset: number): Array<{ file: VueFileIndex, provide: ProvideInfo }> {
    const results: Array<{ file: VueFileIndex, provide: ProvideInfo }> = []
    for (const file of this.files.values()) {
      for (const provide of file.scriptIndex.provides) {
        if (containsSourceOffset(provide.sourceLocation, sourceUri, offset)) {
          results.push({ file, provide })
        }
      }
    }
    return results
  }

  private findSourceInjects(sourceUri: string, offset: number): Array<{ file: VueFileIndex, inject: InjectInfo }> {
    const results: Array<{ file: VueFileIndex, inject: InjectInfo }> = []
    for (const file of this.files.values()) {
      for (const inject of file.scriptIndex.injects) {
        if (containsSourceOffset(inject.sourceLocation, sourceUri, offset)) {
          results.push({ file, inject })
        }
      }
    }
    return results
  }

  private mergeStaticMixins(uri: string, own: ScriptIndex): { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } {
    const collected = this.collectMixinIndexes(own.mixins, new Set([`${uri}\0default`]), 0)
    if (collected.length === 0) {
      return { scriptIndex: own, refMethodCalls: [] }
    }

    const mixinIndexes = collected.map((item) => item.scriptIndex)
    return {
      scriptIndex: {
        ...own,
        components: mergeNamed(own.components, mixinIndexes.flatMap((item) => item.components), (item) => item.tag),
        props: mergeNamed(own.props, mixinIndexes.flatMap((item) => item.props), (item) => item.name),
        methods: mergeNamed(own.methods, mixinIndexes.flatMap((item) => item.methods), (item) => item.name),
        emits: [...own.emits, ...mixinIndexes.flatMap((item) => item.emits)],
        eventBusCalls: [...own.eventBusCalls, ...mixinIndexes.flatMap((item) => item.eventBusCalls)],
        provides: mergeNamed(own.provides, mixinIndexes.flatMap((item) => item.provides), (item) => item.key),
        injects: mergeNamed(own.injects, mixinIndexes.flatMap((item) => item.injects), (item) => item.localName),
      },
      refMethodCalls: collected.flatMap((item) => item.refMethodCalls),
    }
  }

  private collectMixinIndexes(mixins: MixinReference[], visited: Set<string>, depth: number): Array<{ scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] }> {
    if (depth >= 4) {
      return []
    }

    const results: Array<{ scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] }> = []
    for (const mixin of mixins) {
      const key = mixinKey(mixin)
      if (!mixin.targetUri || visited.has(key) || !this.isInsideWorkspace(mixin.targetUri) || isInsideNodeModules(mixin.targetUri)) {
        continue
      }
      this.mixinSourceUris.add(mixin.targetUri)

      const parsed = this.parseMixin(mixin)
      if (!parsed) {
        continue
      }

      results.push(parsed)
      visited.add(key)
      results.push(...this.collectMixinIndexes(parsed.scriptIndex.mixins, visited, depth + 1))
      visited.delete(key)
    }

    return results
  }

  private parseMixin(mixin: MixinReference): { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } | undefined {
    if (!mixin.targetUri) {
      return undefined
    }

    const exportName = mixin.importedName ?? 'default'
    const cacheKey = `${mixin.targetUri}\0${exportName}`
    if (this.mixinIndexCache.has(cacheKey)) {
      return this.mixinIndexCache.get(cacheKey)
    }

    const parsed = this.readMixinIndex(mixin.targetUri, exportName)
    this.mixinIndexCache.set(cacheKey, parsed)
    return parsed
  }

  private isMixinSourceFile(uri: string): boolean {
    return this.getAllFiles().some((file) => file.scriptIndex.mixins.some((mixin) => mixin.targetUri === uri))
  }

  private clearMixinCacheForFile(uri: string): void {
    for (const key of [...this.mixinIndexCache.keys()]) {
      if (key.startsWith(`${uri}\0`)) {
        this.mixinIndexCache.delete(key)
      }
    }
  }

  private hasMixinCacheForFile(uri: string): boolean {
    for (const key of this.mixinIndexCache.keys()) {
      if (key.startsWith(`${uri}\0`)) {
        return true
      }
    }
    return false
  }

  private readMixinIndex(uri: string, exportName: string): { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } | undefined {
    try {
      const content = fsSync.readFileSync(uri, 'utf8')
      const lineStarts = createLineStarts(content)
      const source = (span: TextSpan): SourceLocation => ({ uri, lineStarts, span })

      if (uri.endsWith('.vue')) {
        const sfc = parseSfc(uri, content)
        if (!sfc.script) {
          return undefined
        }
        const scriptIndex = parseScript(uri, sfc.script.content, sfc.script.start, this.workspaceRoots, exportName, this.getEventBusNames())
        return {
          scriptIndex: withSourceLocations(scriptIndex, source),
          refMethodCalls: findRefMethodCalls(maskStringsAndComments(sfc.script.content))
            .map((call) => withRefSourceLocation(call, sfc.script!.start, source)),
        }
      }

      const scriptIndex = parseScript(uri, content, 0, this.workspaceRoots, exportName, this.getEventBusNames())
      return {
        scriptIndex: withSourceLocations(scriptIndex, source),
        refMethodCalls: findRefMethodCalls(maskStringsAndComments(content))
          .map((call) => withRefSourceLocation(call, 0, source)),
      }
    } catch {
      return undefined
    }
  }

  private clearReverseIndexes(): void {
    this.propUsages.clear()
    this.eventUsages.clear()
    this.eventBusEmits.clear()
    this.eventBusListeners.clear()
    this.eventBusEventNames.clear()
    this.refMethodUsages.clear()
    this.provideDefinitions.clear()
    this.injectUsages.clear()
    this.parentComponents.clear()
  }

  private addProvideDefinitions(file: VueFileIndex): void {
    for (const provide of file.scriptIndex.provides) {
      addUsage(this.provideDefinitions, provide.key, { file, span: provide.keySpan, sourceLocation: provide.sourceLocation })
    }
  }

  private addRelationshipUsages(file: VueFileIndex): Set<string> {
    const relationshipChildren = new Set<string>()
    for (const component of file.templateIndex.components) {
      const childUris = this.resolveTemplateComponentUris(file, component)
      if (childUris.length === 0) {
        continue
      }
      for (const childUri of childUris) {
        addParent(this.parentComponents, childUri, file.uri)
        relationshipChildren.add(childUri)
      }

      for (const attr of component.attrs) {
        for (const childUri of childUris) {
          if (attr.kind === 'prop') {
            addUsage(this.propUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
          } else if (attr.kind === 'event') {
            addUsage(this.eventUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
          }
        }
      }
    }

    for (const call of file.refMethodCalls) {
      for (const childUri of this.resolveRefComponents(file, call.refName)) {
        addUsage(this.refMethodUsages, usageKey(childUri, call.methodName), { file, span: call.methodSpan, sourceLocation: call.sourceLocation })
      }
    }

    return relationshipChildren
  }

  private addEventBusUsages(file: VueFileIndex): void {
    for (const call of file.scriptIndex.eventBusCalls) {
      const usage = { file, span: call.eventSpan, sourceLocation: call.sourceLocation, method: call.method }
      addUsage(call.kind === 'emit' ? this.eventBusEmits : this.eventBusListeners, eventBusKey(call.busName, call.eventName), usage)
      addEventBusEventName(this.eventBusEventNames, call.busName, call.eventName)
    }
  }

  private addInjectUsages(file: VueFileIndex): void {
    for (const inject of file.scriptIndex.injects) {
      for (const provider of this.findProvideDefinitions(file, inject.key)) {
        addUsage(this.injectUsages, usageKey(provider.file.uri, inject.key), { file, span: inject.keySpan, sourceLocation: inject.sourceLocation })
      }
    }
  }

  private addGlobalComponents(components: GlobalComponentRegistration[]): void {
    for (const component of components) {
      if (!component.targetUri) {
        continue
      }
      if (isInsideNodeModules(component.targetUri)) {
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
    this.eventBusRegistrations.delete(fileUri)
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
    this.isBulkIndexing = true
    try {
      for (const file of indexedFiles) {
        this.indexContent(file.uri, file.content)
      }
    } finally {
      this.isBulkIndexing = false
      this.rebuildReverseIndexes()
    }
  }

  private rebuildReverseIndexes(): void {
    this.clearReverseIndexes()
    for (const file of this.files.values()) {
      this.addProvideDefinitions(file)
    }
    for (const file of this.files.values()) {
      this.addRelationshipUsages(file)
      this.addEventBusUsages(file)
    }
    for (const file of this.files.values()) {
      this.addInjectUsages(file)
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
      return parseScript(uri, parsed.script.content, parsed.script.start, this.workspaceRoots, 'default', this.getEventBusNames()).componentName
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

  private workspaceRootsFor(root: string): string[] {
    return this.workspaceRoots.includes(root) ? this.workspaceRoots : [...this.workspaceRoots, root]
  }

  private resolveExternalRefComponent(fromUri: string, tag: string): string | undefined {
    const root = this.workspaceRootFor(fromUri)
    if (!root) {
      return undefined
    }

    const key = `${root}\0${tag}`
    if (!this.externalRefComponents.has(key)) {
      const component = resolveExternalRefComponent(root, tag)
      this.externalRefComponents.set(key, component)
      if (component) {
        this.externalRefComponentUris.set(component.uri, component)
      }
    }

    return this.externalRefComponents.get(key)?.uri
  }

  private workspaceRootFor(uri: string): string | undefined {
    return this.workspaceRoots.find((root) => uri === root || isInsideDirectory(uri, root))
  }

  private removeEventBusRegistrationsInRoot(root: string): void {
    for (const uri of [...this.eventBusRegistrations.keys()]) {
      if (uri === root || isInsideDirectory(uri, root)) {
        this.eventBusRegistrations.delete(uri)
      }
    }
  }

  private removeReverseIndex(file: VueFileIndex): void {
    removeFileUsages(this.propUsages, file)
    removeFileUsages(this.eventUsages, file)
    removeFileUsages(this.eventBusEmits, file)
    removeFileUsages(this.eventBusListeners, file)
    removeEventBusEventNames(this.eventBusEventNames, this.eventBusEmits, this.eventBusListeners, file)
    removeFileUsages(this.refMethodUsages, file)
    removeFileUsages(this.provideDefinitions, file)
    removeFileUsages(this.injectUsages, file)
    removeProviderUsages(this.injectUsages, file)
    removeParentLinks(this.parentComponents, file.uri)
  }

  private relationshipChildren(file: VueFileIndex): Set<string> {
    const children = new Set<string>()
    for (const component of file.templateIndex.components) {
      const childUri = this.resolveComponent(file, component.tag)
      if (childUri) {
        children.add(childUri)
      }
    }
    return children
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

function mergeNamed<T>(own: T[], mixed: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set(own.map(keyOf))
  const results = [...own]
  for (const item of mixed) {
    const key = keyOf(item)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(item)
  }
  return results
}

function mixinKey(mixin: MixinReference): string {
  return `${mixin.targetUri ?? ''}\0${mixin.importedName ?? 'default'}`
}

function withSourceLocations(scriptIndex: ScriptIndex, source: (span: TextSpan) => SourceLocation): ScriptIndex {
  return {
    ...scriptIndex,
    props: scriptIndex.props.map((item) => ({ ...item, sourceLocation: source(item.span) })),
    methods: scriptIndex.methods.map((item) => ({ ...item, sourceLocation: source(item.span) })),
    emits: scriptIndex.emits.map((item) => ({ ...item, sourceLocation: source(item.eventSpan) })),
    eventBusCalls: scriptIndex.eventBusCalls.map((item) => ({ ...item, sourceLocation: source(item.eventSpan) })),
    provides: scriptIndex.provides.map((item) => ({ ...item, sourceLocation: source(item.keySpan) })),
    injects: scriptIndex.injects.map((item) => ({ ...item, sourceLocation: source(item.keySpan) })),
  }
}

function withRefSourceLocation(call: RefMethodAccess, offset: number, source: (span: TextSpan) => SourceLocation): RefMethodAccess {
  const methodSpan = { start: call.methodSpan.start + offset, end: call.methodSpan.end + offset }
  return {
    ...call,
    methodSpan,
    sourceLocation: source(methodSpan),
  }
}

function containsSourceOffset(sourceLocation: SourceLocation | undefined, sourceUri: string, offset: number): boolean {
  return sourceLocation?.uri === sourceUri
    && offset >= sourceLocation.span.start
    && offset < sourceLocation.span.end
}

function dedupeUsages<T extends UsageInfo>(usages: T[]): T[] {
  const seen = new Set<string>()
  const results: T[] = []
  for (const usage of usages) {
    const uri = usage.sourceLocation?.uri ?? usage.file.uri
    const span = usage.sourceLocation?.span ?? usage.span
    const key = `${uri}\0${span.start}\0${span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(usage)
  }
  return results
}

function usesSource(file: VueFileIndex, sourceUri: string): boolean {
  return file.scriptIndex.props.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.scriptIndex.methods.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.scriptIndex.emits.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.scriptIndex.eventBusCalls.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.scriptIndex.provides.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.scriptIndex.injects.some((item) => item.sourceLocation?.uri === sourceUri)
    || file.refMethodCalls.some((call) => call.sourceLocation?.uri === sourceUri)
}

function defaultEventBusEntryCandidates(root: string): string[] {
  const src = path.join(root, 'src')
  return [
    path.join(src, 'main.js'),
    path.join(src, 'index.js'),
    path.join(src, 'main.ts'),
    path.join(src, 'index.ts'),
  ]
}

async function readTextIfExists(uri: string): Promise<string | undefined> {
  try {
    return await fs.readFile(uri, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') {
      return undefined
    }
    throw error
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

export interface RefRootCompletionContext {
  accessToken: '' | '.' | '?.'
  partialRefName: string
}

export function findRefRootCompletionContext(content: string, offset: number): RefRootCompletionContext | undefined {
  const searchableContent = maskStringsAndComments(content)
  return findRefRootCompletionContextInSearchableContent(searchableContent, offset)
}

export function findRefRootCompletionContextInFile(file: VueFileIndex, offset: number): RefRootCompletionContext | undefined {
  return findRefRootCompletionContextInSearchableContent(file.searchableContent, offset)
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

function findRefRootCompletionContextInSearchableContent(searchableContent: string, offset: number): RefRootCompletionContext | undefined {
  const prefix = searchableContent.slice(Math.max(0, offset - 80), offset)
  const directMatch = /this\.\$refs(\.|\?\.)?([A-Za-z_$][\w$]*)?$/.exec(prefix)
  if (directMatch) {
    return {
      accessToken: (directMatch[1] as '.' | '?.') ?? '',
      partialRefName: directMatch[2] ?? '',
    }
  }

  const rootMatch = /this\.\$refs$/.exec(prefix)
  if (!rootMatch) {
    return undefined
  }

  return {
    accessToken: '',
    partialRefName: '',
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

function eventBusKey(busName: string, eventName: string): string {
  return `${busName}\0${eventName}`
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function addUsage<T extends UsageInfo>(map: Map<string, T[]>, key: string, usage: T): void {
  const usages = map.get(key)
  if (usages) {
    usages.push(usage)
  } else {
    map.set(key, [usage])
  }
}

function addEventBusEventName(map: Map<string, Set<string>>, busName: string, eventName: string): void {
  const names = map.get(busName)
  if (names) {
    names.add(eventName)
  } else {
    map.set(busName, new Set([eventName]))
  }
}

function addParent(map: Map<string, Set<string>>, childUri: string, parentUri: string): void {
  const parents = map.get(childUri)
  if (parents) {
    parents.add(parentUri)
  } else {
    map.set(childUri, new Set([parentUri]))
  }
}

function removeParentLinks(map: Map<string, Set<string>>, parentUri: string): void {
  for (const [childUri, parents] of map) {
    parents.delete(parentUri)
    if (parents.size === 0) {
      map.delete(childUri)
    }
  }
}

function removeFileUsages<T extends UsageInfo>(map: Map<string, T[]>, file: VueFileIndex): void {
  for (const [key, usages] of map) {
    const kept = usages.filter((usage) => usage.file !== file)
    if (kept.length === 0) {
      map.delete(key)
    } else if (kept.length !== usages.length) {
      map.set(key, kept)
    }
  }
}

function removeEventBusEventNames(
  namesByBus: Map<string, Set<string>>,
  emits: Map<string, EventBusUsageInfo[]>,
  listeners: Map<string, EventBusUsageInfo[]>,
  file: VueFileIndex,
): void {
  for (const call of file.scriptIndex.eventBusCalls) {
    const key = eventBusKey(call.busName, call.eventName)
    if ((emits.get(key)?.length ?? 0) > 0 || (listeners.get(key)?.length ?? 0) > 0) {
      continue
    }

    const names = namesByBus.get(call.busName)
    names?.delete(call.eventName)
    if (names?.size === 0) {
      namesByBus.delete(call.busName)
    }
  }
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false
    }
  }
  return true
}

function removeProviderUsages(map: Map<string, UsageInfo[]>, file: VueFileIndex): void {
  for (const key of [...map.keys()]) {
    if (key.startsWith(`${file.uri}\0`)) {
      map.delete(key)
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

function isInsideNodeModules(file: string): boolean {
  return path.normalize(file).split(path.sep).includes('node_modules')
}

function isSameProjectFile(left: string, right: string): boolean {
  const leftSrc = findSrcSegment(left)
  const rightSrc = findSrcSegment(right)
  return leftSrc !== undefined && leftSrc === rightSrc
}

function isSameProjectFileOrUnknown(left: string, right: string): boolean {
  const leftSrc = findSrcSegment(left)
  const rightSrc = findSrcSegment(right)
  if (leftSrc === undefined && rightSrc === undefined) {
    return true
  }
  return leftSrc !== undefined && leftSrc === rightSrc
}

function findSrcSegment(file: string): string | undefined {
  const parts = path.normalize(file).split(path.sep)
  const index = parts.lastIndexOf('src')
  return index === -1 ? undefined : parts.slice(0, index + 1).join(path.sep)
}

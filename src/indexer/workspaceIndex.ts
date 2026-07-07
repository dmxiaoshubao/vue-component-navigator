import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ComponentRegistration, ComposableReturnUsage, EmitInfo, EventBusCall, EventBusRegistration, EventBusUsageInfo, GlobalComponentContext, GlobalComponentRegistration, ImportInfo, InjectInfo, MethodInfo, MixinReference, ParsedSfc, PropInfo, ProvideInfo, RefMethodAccess, ScriptIndex, SlotInfo, SourceLocation, TemplateComponentUsage, TextSpan, UsageInfo, VueFileIndex, Vue3PropTypeInfo, Vue3PropUsage, VueMajorVersion } from './types'
import { createComposableReturnParseCache, isComposableImport, parseComposableReturnUsages, resolveComposableImport, type ComposableReturnParseCache } from './composableParser'
import { parseEventBusRegistrations, parseStaticImportSources } from './eventBusParser'
import { resolveExternalRefComponent } from './externalComponentResolver'
import { guessGlobalComponentsFromRequireContext, parseGlobalComponents } from './globalComponentParser'
import { resolveImportPathWithExtensions, resolveProjectPathWithExtensions } from './relationResolver'
import { parseSfc } from './sfcParser'
import { parseScript } from './scriptParser'
import { parseTemplate } from './templateParser'
import { createVue3ScriptParseCache, parseVue3Script } from './vue3ScriptParser'
import { createLineStarts, positionToOffset } from '../utils/position'
import { matchesName, toCamelCase, toKebabCase } from '../utils/casing'
import { maskStringsAndComments, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

export interface IndexCancellationToken {
  readonly isCancellationRequested: boolean
}

type EventBusEntryConfig = string | readonly string[]
type TrackedUsageMap = Map<string, UsageInfo[]>

type SourceRelationMap<T extends { file: VueFileIndex }> = Map<string, T[]>

interface ScriptComponentUsageFile {
  file: VueFileIndex
  usages: Array<{ childUri: string, span: TextSpan }>
}

interface ScriptComponentUsageImport {
  localName: string
  childUri: string
  importStart: number
  importEnd: number
  fallbackSpan: TextSpan
  spans: TextSpan[]
}

interface ForwardedRefMethodNameCacheEntry {
  mtimeMs: number
  size: number
  methodsByExportName: Map<string, string[]>
}

type ForwardedRefMethodNameCache = Map<string, ForwardedRefMethodNameCacheEntry>

function emptyScriptIndex(): ScriptIndex {
  return {
    imports: [],
    mixins: [],
    components: [],
    staticComponentNames: [],
    props: [],
    methods: [],
    emits: [],
    eventBusCalls: [],
    provides: [],
    injects: [],
    vue3PropUsages: [],
    composableReturnUsages: [],
    slots: [],
  }
}

export class WorkspaceIndex {
  private readonly files = new Map<string, VueFileIndex>()
  private readonly workspaceRoots: string[] = []
  private readonly workspaceVueVersions = new Map<string, VueMajorVersion>()
  private readonly eventBusEntriesByRoot = new Map<string, string[]>()
  private readonly externalRefComponents = new Map<string, VueFileIndex | undefined>()
  private readonly externalRefComponentUris = new Map<string, VueFileIndex>()
  private readonly globalComponents = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentRegistrations = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentContexts = new Map<string, GlobalComponentContext[]>()
  private readonly eventBusRegistrations = new Map<string, EventBusRegistration[]>()
  private readonly propUsages = new Map<string, UsageInfo[]>()
  private readonly componentUsages = new Map<string, UsageInfo[]>()
  private readonly eventUsages = new Map<string, UsageInfo[]>()
  private readonly slotUsages = new Map<string, UsageInfo[]>()
  private readonly eventBusEmits = new Map<string, EventBusUsageInfo[]>()
  private readonly eventBusListeners = new Map<string, EventBusUsageInfo[]>()
  private readonly eventBusEventNames = new Map<string, Set<string>>()
  private readonly refMethodUsages = new Map<string, UsageInfo[]>()
  private readonly refMethodForwards = new Map<string, UsageInfo[]>()
  private readonly vue3PropInternalUsages = new Map<string, UsageInfo[]>()
  private readonly provideDefinitions = new Map<string, UsageInfo[]>()
  private readonly injectUsages = new Map<string, UsageInfo[]>()
  private readonly sourceProps: SourceRelationMap<{ file: VueFileIndex, prop: PropInfo }> = new Map()
  private readonly sourcePropTypes: SourceRelationMap<{ file: VueFileIndex, type: Vue3PropTypeInfo }> = new Map()
  private readonly sourceMethods: SourceRelationMap<{ file: VueFileIndex, method: MethodInfo }> = new Map()
  private readonly sourceEmits: SourceRelationMap<{ file: VueFileIndex, emit: ScriptIndex['emits'][number] }> = new Map()
  private readonly sourceSlots: SourceRelationMap<{ file: VueFileIndex, slot: SlotInfo }> = new Map()
  private readonly sourceEventBusCalls: SourceRelationMap<{ file: VueFileIndex, call: EventBusCall }> = new Map()
  private readonly sourceProvides: SourceRelationMap<{ file: VueFileIndex, provide: ProvideInfo }> = new Map()
  private readonly sourceInjects: SourceRelationMap<{ file: VueFileIndex, inject: InjectInfo }> = new Map()
  private readonly sourceRefMethodCalls: SourceRelationMap<{ file: VueFileIndex, call: RefMethodAccess }> = new Map()
  private readonly sourceComposableReturnUsages: SourceRelationMap<{ file: VueFileIndex, usage: ComposableReturnUsage }> = new Map()
  private readonly sourceRelationFiles = new Map<string, Set<string>>()
  private readonly vue3ScriptImportConsumers = new Map<string, Set<string>>()
  private readonly parentComponents = new Map<string, Set<string>>()
  private readonly scriptComponentUsageFiles = new Map<string, ScriptComponentUsageFile>()
  private readonly mixinIndexCache = new Map<string, { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } | undefined>()
  private readonly mixinSourceUris = new Set<string>()
  private readonly vue3ScriptParseCache = createVue3ScriptParseCache()
  private readonly composableReturnParseCache: ComposableReturnParseCache = createComposableReturnParseCache()
  private readonly forwardedRefMethodNameCache: ForwardedRefMethodNameCache = new Map()
  private usageKeysByFile = new WeakMap<VueFileIndex, Map<TrackedUsageMap, Set<string>>>()
  private refMethodForwardKeysByFile = new WeakMap<VueFileIndex, Set<string>>()
  private sourceKeysByFile = new WeakMap<VueFileIndex, Set<string>>()
  private scriptImportKeysByFile = new WeakMap<VueFileIndex, Set<string>>()
  private injectUsageKeysByProvider = new WeakMap<VueFileIndex, Set<string>>()
  private parentLinksByFile = new WeakMap<VueFileIndex, Set<string>>()
  private isBulkIndexing = false

  clear(): void {
    this.files.clear()
    this.workspaceRoots.length = 0
    this.workspaceVueVersions.clear()
    this.eventBusEntriesByRoot.clear()
    this.externalRefComponents.clear()
    this.externalRefComponentUris.clear()
    this.globalComponents.clear()
    this.globalComponentRegistrations.clear()
    this.globalComponentContexts.clear()
    this.eventBusRegistrations.clear()
    this.scriptComponentUsageFiles.clear()
    this.mixinIndexCache.clear()
    this.mixinSourceUris.clear()
    this.vue3ScriptParseCache.clear()
    this.composableReturnParseCache.clear()
    this.forwardedRefMethodNameCache.clear()
    this.clearReverseIndexes()
  }

  replaceWith(other: WorkspaceIndex): void {
    this.files.clear()
    for (const [uri, file] of other.files) {
      this.files.set(uri, file)
    }
    this.workspaceRoots.length = 0
    this.workspaceRoots.push(...other.workspaceRoots)
    this.workspaceVueVersions.clear()
    for (const [root, version] of other.workspaceVueVersions) {
      this.workspaceVueVersions.set(root, version)
    }
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
    this.scriptComponentUsageFiles.clear()
    for (const [uri, usageFile] of other.scriptComponentUsageFiles) {
      this.scriptComponentUsageFiles.set(uri, {
        file: usageFile.file,
        usages: [...usageFile.usages],
      })
    }
    this.composableReturnParseCache.clear()
    for (const [uri, entry] of other.composableReturnParseCache) {
      this.composableReturnParseCache.set(uri, entry)
    }
    this.forwardedRefMethodNameCache.clear()
    for (const [uri, entry] of other.forwardedRefMethodNameCache) {
      this.forwardedRefMethodNameCache.set(uri, {
        mtimeMs: entry.mtimeMs,
        size: entry.size,
        methodsByExportName: new Map([...entry.methodsByExportName].map(([name, methods]) => [name, [...methods]])),
      })
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

  setWorkspaceVueVersion(root: string, version: VueMajorVersion): void {
    if (!this.workspaceRoots.includes(root)) {
      this.workspaceRoots.push(root)
    }
    this.workspaceVueVersions.set(root, version)
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
    return findRegisteredComponentInFile(parent, tag)
      ?? (parent.vueVersion === 2 ? this.resolveGlobalComponent(tag, parent.uri) : undefined)
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

    const sfc = this.parseIndexableContent(uri, content)
    const vueVersion = this.vueVersionForUri(uri, sfc)
    const eventBusNames = vueVersion === 2 ? this.getEventBusNames() : []
    const ownScriptIndex = vueVersion === 3
      ? parseVue3Script(sfc, this.workspaceRoots, this.vue3ScriptParseCache)
      : sfc.script
        ? parseScript(uri, sfc.script.content, sfc.script.start, this.workspaceRoots, 'default', eventBusNames)
        : emptyScriptIndex()
    const mixed = vueVersion === 2
      ? this.mergeStaticMixins(uri, ownScriptIndex)
      : { scriptIndex: ownScriptIndex, refMethodCalls: [] }
    let scriptIndex = mixed.scriptIndex
    if (vueVersion === 3) {
      scriptIndex = {
        ...scriptIndex,
        components: isScriptFile(uri) && !uri.endsWith('.vue')
          ? [...scriptIndex.components, ...parseScriptImportedVueComponents(uri, content, scriptIndex.imports, this.workspaceRoots)]
          : scriptIndex.components,
        composableReturnUsages: [
          ...scriptIndex.composableReturnUsages,
          ...parseComposableReturnUsages(uri, sfc, scriptIndex.imports, this.workspaceRoots, this.composableReturnParseCache),
        ],
      }
    }
    const registeredTags = [
      ...scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
      ...(vueVersion === 2 ? this.getGlobalComponents().flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]) : []),
    ]
    const templateIndex = sfc.template
      ? parseTemplate(sfc.template.content, sfc.template.start, registeredTags, scriptIndex.staticComponentNames, eventBusNames, vueVersion === 3)
      : {
          components: vueVersion === 3 && isScriptFile(uri) && !uri.endsWith('.vue')
            ? parseVue3ScriptRefComponentUsages(content)
            : [],
          emits: [],
          eventBusCalls: [],
          slots: [],
        }
    scriptIndex = {
      ...scriptIndex,
      emits: [...scriptIndex.emits, ...templateIndex.emits],
      eventBusCalls: [...scriptIndex.eventBusCalls, ...templateIndex.eventBusCalls],
      slots: [...scriptIndex.slots, ...templateIndex.slots],
    }
    const searchableContent = maskStringsAndComments(sfc.content)

    const file: VueFileIndex = {
      uri,
      fileName: sfc.fileName,
      vueVersion,
      content: sfc.content,
      searchableContent,
      lineStarts: sfc.lineStarts,
      script: sfc.script,
      scriptSetup: sfc.scriptSetup,
      template: sfc.template,
      scriptIndex,
      templateIndex,
      refMethodCalls: vueVersion === 2
        ? [
            ...findRefMethodCalls(searchableContent),
            ...mixed.refMethodCalls,
          ]
        : [
            ...findVue3TemplateRefMethodCalls(sfc.content),
            ...findVue3DefineExposeForwardedRefMethodCalls(uri, sfc, scriptIndex.imports, this.workspaceRoots, this.forwardedRefMethodNameCache),
          ],
    }
    this.files.set(uri, file)
    if (this.isBulkIndexing) {
      return file
    }

    this.addSourceRelations(file)
    this.addVue3ScriptImportConsumers(file)
    this.addProvideDefinitions(file)
    const relationshipChildren = this.addRelationshipUsages(file)
    this.addEventBusUsages(file)
    this.addInjectUsages(file)
    if (
      file.scriptIndex.provides.length > 0
      || (previous?.scriptIndex.provides.length ?? 0) > 0
      || !sameStringSet(previousRelationshipChildren, relationshipChildren)
      || hasForwardedListeners(file)
      || (previous ? hasForwardedListeners(previous) : false)
      || ((hasTemplateEventAttrs(file) || (previous ? hasTemplateEventAttrs(previous) : false)) && this.hasAnyForwardedListeners())
      || hasForwardedAttrs(file)
      || (previous ? hasForwardedAttrs(previous) : false)
      || ((hasTemplatePropAttrs(file) || (previous ? hasTemplatePropAttrs(previous) : false)) && this.hasAnyForwardedAttrs())
    ) {
      this.rebuildReverseIndexes()
    }
    if (wasMixinSource) {
      this.rebuildIndexedFiles()
    }
    return file
  }

  private parseIndexableContent(uri: string, content: string): ParsedSfc {
    if (!isScriptFile(uri) || uri.endsWith('.vue')) {
      return parseSfc(uri, content)
    }

    return {
      uri,
      fileName: path.basename(uri),
      content,
      lineStarts: createLineStarts(content),
      script: { content, start: 0, end: content.length },
      template: undefined,
    }
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

  async indexWorkspace(root: string, token?: IndexCancellationToken, eventBusEntries?: EventBusEntryConfig, vueVersion: VueMajorVersion = 2): Promise<void> {
    this.setWorkspaceVueVersion(root, vueVersion)
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

    if (vueVersion === 2) {
      for (const file of scriptFiles) {
        await this.indexGlobalComponentFile(file, false)
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
    }
    if (vueVersion === 3) {
      const indexableScriptContents = new Map<string, string>()
      for (const file of scriptFiles) {
        if (token?.isCancellationRequested) {
          return
        }
        const content = await readTextIfExists(file)
        if (content !== undefined) {
          this.indexScriptComponentUsageContent(file, content, false)
          if (hasVue3StandaloneScriptRelations(content)) {
            indexableScriptContents.set(file, content)
          }
        }
      }

      this.isBulkIndexing = true
      try {
        for (const file of vueFiles) {
          await this.indexFile(file)
          if (token?.isCancellationRequested) {
            return
          }
        }
        for (const [file, content] of indexableScriptContents) {
          this.indexContent(file, content)
          if (token?.isCancellationRequested) {
            return
          }
        }
      } finally {
        this.isBulkIndexing = false
        this.rebuildReverseIndexes()
      }
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

  async indexGlobalComponentFile(uri: string, rebuildScriptUsages = true): Promise<void> {
    const content = await fs.readFile(uri, 'utf8')
    this.indexScriptComponentUsageContent(uri, content, rebuildScriptUsages)
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
    const vueVersion = this.vueVersionForUri(uri)
    const hasVue3ImportConsumers = vueVersion === 3 && this.vue3ScriptImportConsumers.has(uri)
    if (vueVersion === 3) {
      this.composableReturnParseCache.delete(uri)
      this.forwardedRefMethodNameCache.delete(uri)
    }
    const content = await readTextIfExists(uri)
    if (content !== undefined) {
      this.indexScriptComponentUsageContent(uri, content, vueVersion === 3 ? !hasVue3ImportConsumers : true)
      if (vueVersion === 3 && hasVue3StandaloneScriptRelations(content)) {
        this.indexContent(uri, content)
      } else if (vueVersion === 3) {
        this.remove(uri)
      }
    } else if (vueVersion === 3) {
      this.removeScriptComponentUsageFile(uri)
      this.remove(uri)
    }
    if (vueVersion === 3) {
      this.rebuildVue3ScriptImportConsumers(uri)
      return
    }
    const wasMixinSource = this.isMixinSourceFile(uri) || this.hasMixinCacheForFile(uri)
    const hadGlobalComponentContext = this.globalComponentContexts.has(uri)
    const beforeGlobals = this.globalComponentsSignature()
    const beforeContexts = this.globalComponentContextsSignature()
    const beforeEventBusNames = this.eventBusNamesSignature()
    this.clearMixinCacheForFile(uri)
    if (content !== undefined) {
      await this.indexGlobalComponentContent(uri, content)
    }
    const contextChanged = beforeContexts !== this.globalComponentContextsSignature()
    await this.refreshEventBusRegistrations()
    const eventBusChanged = beforeEventBusNames !== this.eventBusNamesSignature()
    if (hadGlobalComponentContext || this.globalComponentContexts.has(uri) || contextChanged) {
      await this.refreshRequireContextGlobals(this.getIndexedUris())
    }
    if (
      wasMixinSource
      || contextChanged
      || eventBusChanged
      || beforeGlobals !== this.globalComponentsSignature()
    ) {
      this.rebuildIndexedFiles()
    }
  }

  async removeGlobalComponentFile(uri: string): Promise<void> {
    this.removeScriptComponentUsageFile(uri)
    if (this.vueVersionForUri(uri) === 3) {
      this.composableReturnParseCache.delete(uri)
      this.forwardedRefMethodNameCache.delete(uri)
      this.remove(uri)
      this.rebuildVue3ScriptImportConsumers(uri)
      return
    }
    const wasMixinSource = this.isMixinSourceFile(uri) || this.hasMixinCacheForFile(uri)
    const beforeGlobals = this.globalComponentsSignature()
    const beforeContexts = this.globalComponentContextsSignature()
    const beforeEventBusNames = this.eventBusNamesSignature()
    this.clearMixinCacheForFile(uri)
    this.removeGlobalRegistrationsFromFile(uri)
    const contextChanged = beforeContexts !== this.globalComponentContextsSignature()
    await this.refreshEventBusRegistrations()
    const eventBusChanged = beforeEventBusNames !== this.eventBusNamesSignature()
    if (
      wasMixinSource
      || contextChanged
      || eventBusChanged
      || beforeGlobals !== this.globalComponentsSignature()
    ) {
      this.rebuildIndexedFiles()
    }
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

  findPropUsages(childUri: string, propName: string): UsageInfo[] {
    return dedupeUsages([
      ...this.findTemplatePropUsages(childUri, propName),
      ...this.findVue3PropInternalUsages(childUri, propName),
    ])
  }

  findTemplateEventUsages(childUri: string, eventName: string): UsageInfo[] {
    const results: UsageInfo[] = []
    for (const key of this.eventKeys(childUri, eventName)) {
      results.push(...(this.eventUsages.get(key) ?? []))
    }
    return dedupeUsages(results)
  }

  findTemplateSlotUsages(childUri: string, slotName: string): UsageInfo[] {
    const results: UsageInfo[] = []
    for (const key of this.slotKeys(childUri, slotName)) {
      results.push(...(this.slotUsages.get(key) ?? []))
    }
    return dedupeUsages(results)
  }

  findSlotDefinitions(childUri: string, slotName: string): Array<{ file: VueFileIndex, slot: SlotInfo }> {
    const file = this.getFile(childUri)
    if (!file) {
      return []
    }
    return file.scriptIndex.slots
      .filter((slot) => matchesName(slot.name, slotName))
      .map((slot) => ({ file, slot }))
  }

  findComponentUsages(childUri: string): UsageInfo[] {
    return dedupeUsages(this.componentUsages.get(childUri) ?? [])
  }

  findEventDefinitions(childUri: string, eventName: string): Array<{ file: VueFileIndex, emit: EmitInfo }> {
    return dedupeEventDefinitions(this.findEventDefinitionsRecursive(childUri, eventName, new Set<string>()))
  }

  findPropDefinitions(childUri: string, propName: string): Array<{ file: VueFileIndex, prop: PropInfo }> {
    return dedupePropDefinitions(this.findPropDefinitionsRecursive(childUri, propName, new Set<string>()))
  }

  findRefMethodDefinitions(childUri: string, methodName: string): Array<{ file: VueFileIndex, method: MethodInfo }> {
    return dedupeMethodDefinitions(this.findRefMethodDefinitionsRecursive(childUri, methodName, new Set<string>()))
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
    return dedupeUsages(this.findRefMethodUsagesRecursive(childUri, methodName, new Set<string>()))
  }

  private findRefMethodUsagesRecursive(childUri: string, methodName: string, visited: Set<string>): UsageInfo[] {
    const key = usageKey(childUri, methodName)
    if (visited.has(key)) {
      return []
    }
    visited.add(key)

    return [
      ...(this.refMethodUsages.get(key) ?? []),
      ...(this.refMethodForwards.get(key) ?? []).flatMap((forward) => this.findRefMethodUsagesRecursive(forward.file.uri, methodName, visited)),
    ]
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

  hasVue3PropSource(uri: string): boolean {
    return (this.sourceProps.get(uri)?.some(({ file }) => file.vueVersion === 3) ?? false)
      || (this.sourcePropTypes.get(uri)?.some(({ file }) => file.vueVersion === 3) ?? false)
  }

  hasVue3StaticKeySource(uri: string): boolean {
    return (this.sourceProvides.get(uri)?.some(({ file, provide }) => file.vueVersion === 3 && provide.keySourceLocation?.uri === uri) ?? false)
      || (this.sourceInjects.get(uri)?.some(({ file, inject }) => file.vueVersion === 3 && inject.keySourceLocation?.uri === uri) ?? false)
  }

  hasVue3ComposableSource(uri: string): boolean {
    return this.sourceComposableReturnUsages.has(uri)
  }

  hasVue3Source(uri: string): boolean {
    return this.hasVue3PropSource(uri) || this.hasVue3StaticKeySource(uri) || this.hasVue3ComposableSource(uri)
  }

  hasSourceRelations(uri: string): boolean {
    return this.hasMixinSource(uri) || this.sourceRelationFiles.has(uri)
  }

  async refreshEventBusRegistrations(root?: string, token?: IndexCancellationToken): Promise<boolean> {
    const beforeNames = this.eventBusNamesSignature()
    const roots = (root ? [root] : this.workspaceRoots)
      .filter((workspaceRoot) => this.workspaceVueVersions.get(workspaceRoot) !== 3)
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
        return beforeNames !== this.eventBusNamesSignature()
      }
      const registrations = await this.detectEventBusRegistrations(workspaceRoot, token)
      for (const registration of registrations) {
        const current = this.eventBusRegistrations.get(registration.fileUri) ?? []
        current.push(registration)
        this.eventBusRegistrations.set(registration.fileUri, current)
      }
    }
    return beforeNames !== this.eventBusNamesSignature()
  }

  getEventBusNames(): string[] {
    return [...new Set([
      ...[...this.eventBusRegistrations.values()].flat().map((registration) => registration.propertyName),
    ])]
  }

  findTemplatePropUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceProps(sourceUri, offset)
      .flatMap(({ file, prop }) => this.findTemplatePropUsages(file.uri, prop.name)))
  }

  findVue3PropInternalUsages(childUri: string, propName: string): UsageInfo[] {
    return dedupeUsages(this.vue3PropInternalUsages.get(usageKey(childUri, propName)) ?? [])
  }

  findVue3PropInternalUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceProps(sourceUri, offset)
      .filter(({ file }) => file.vueVersion === 3)
      .flatMap(({ file, prop }) => this.findVue3PropInternalUsages(file.uri, prop.name)))
  }

  findPropUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages(this.findSourceProps(sourceUri, offset).flatMap(({ file, prop }) => [
      ...this.findTemplatePropUsages(file.uri, prop.name),
      ...(file.vueVersion === 3 ? this.findVue3PropInternalUsages(file.uri, prop.name) : []),
    ]))
  }

  findVue3PropTypeUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return (this.sourcePropTypes.get(sourceUri) ?? [])
      .filter(({ type }) => containsSourceOffset(type.sourceLocation, sourceUri, offset))
      .map(({ file, type }) => ({ file, span: type.span }))
  }

  findComposableReturnUsagesFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages((this.sourceComposableReturnUsages.get(sourceUri) ?? [])
      .filter(({ usage }) => containsSourceOffset(usage.sourceLocation, sourceUri, offset))
      .map(({ file, usage }) => ({ file, span: usage.span })))
  }

  findVue3PropUsageAtOffset(file: VueFileIndex, offset: number): Vue3PropUsage | undefined {
    if (file.vueVersion !== 3) {
      return undefined
    }
    return file.scriptIndex.vue3PropUsages.find((usage) => offset >= usage.span.start && offset < usage.span.end)
  }

  findVue3PropTypeAtOffset(file: VueFileIndex, offset: number): ScriptIndex['vue3PropType'] | undefined {
    const type = file.scriptIndex.vue3PropType
    if (!type || offset < type.span.start || offset >= type.span.end) {
      return undefined
    }
    return type
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
    return (this.sourceRefMethodCalls.get(sourceUri) ?? [])
      .filter(({ call }) => containsSourceOffset(call.sourceLocation, sourceUri, offset))
  }

  findSourceEventBusCalls(sourceUri: string, offset: number): Array<{ file: VueFileIndex, call: EventBusCall }> {
    return (this.sourceEventBusCalls.get(sourceUri) ?? [])
      .filter(({ call }) => containsSourceOffset(call.sourceLocation, sourceUri, offset))
  }

  findSourceRefOwners(sourceUri: string, refName: string): VueFileIndex[] {
    const results: VueFileIndex[] = []
    const seen = new Set<string>()
    for (const file of this.findSourceConsumers(sourceUri)) {
      if (seen.has(file.uri) || !this.resolveRefComponent(file, refName)) {
        continue
      }
      seen.add(file.uri)
      results.push(file)
    }
    return results
  }

  findSourceConsumers(sourceUri: string): VueFileIndex[] {
    return [...(this.sourceRelationFiles.get(sourceUri) ?? [])]
      .map((uri) => this.files.get(uri))
      .filter((file): file is VueFileIndex => Boolean(file))
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
    const registrations: EventBusRegistration[] = []
    const importedUris: string[] = []

    for (const uri of this.eventBusEntryCandidates(root)) {
      if (token?.isCancellationRequested) {
        return []
      }
      const content = await readTextIfExists(uri)
      if (content === undefined) {
        continue
      }
      const directRegistrations = parseEventBusRegistrations(uri, content)
      if (directRegistrations.length > 0) {
        registrations.push(...directRegistrations)
        continue
      }

      // 入口本身没有注册时，只展开该入口直接引入的一层文件，避免递归扫描拖慢大项目。
      importedUris.push(...parseStaticImportSources(content)
        .map((source) => resolveImportPathWithExtensions(uri, source, this.workspaceRootsFor(root), ['.js', '.ts']))
        .filter((resolved): resolved is string => Boolean(resolved))
        .filter((resolved) => this.isInsideWorkspace(resolved) && !isInsideNodeModules(resolved)))
    }

    for (const uri of uniqueStrings(importedUris)) {
      if (token?.isCancellationRequested) {
        return []
      }
      const content = await readTextIfExists(uri)
      if (content !== undefined) {
        registrations.push(...parseEventBusRegistrations(uri, content))
      }
    }

    return registrations
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
    return (this.sourceProps.get(sourceUri) ?? [])
      .filter(({ prop }) => containsSourceOffset(prop.sourceLocation, sourceUri, offset))
  }

  private findSourceMethods(sourceUri: string, offset: number): Array<{ file: VueFileIndex, method: MethodInfo }> {
    return (this.sourceMethods.get(sourceUri) ?? [])
      .filter(({ method }) => containsSourceOffset(method.sourceLocation, sourceUri, offset))
  }

  private findSourceEmits(sourceUri: string, offset: number): Array<{ file: VueFileIndex, emit: ScriptIndex['emits'][number] }> {
    return (this.sourceEmits.get(sourceUri) ?? [])
      .filter(({ emit }) => containsSourceOffset(emit.sourceLocation, sourceUri, offset))
  }

  private findSourceProvides(sourceUri: string, offset: number): Array<{ file: VueFileIndex, provide: ProvideInfo }> {
    return (this.sourceProvides.get(sourceUri) ?? [])
      .filter(({ provide }) => containsSourceOffset(provide.sourceLocation, sourceUri, offset) || containsSourceOffset(provide.keySourceLocation, sourceUri, offset))
  }

  private findSourceInjects(sourceUri: string, offset: number): Array<{ file: VueFileIndex, inject: InjectInfo }> {
    return (this.sourceInjects.get(sourceUri) ?? [])
      .filter(({ inject }) => containsSourceOffset(inject.sourceLocation, sourceUri, offset) || containsSourceOffset(inject.keySourceLocation, sourceUri, offset))
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
    this.componentUsages.clear()
    this.eventUsages.clear()
    this.slotUsages.clear()
    this.eventBusEmits.clear()
    this.eventBusListeners.clear()
    this.eventBusEventNames.clear()
    this.refMethodUsages.clear()
    this.refMethodForwards.clear()
    this.vue3PropInternalUsages.clear()
    this.provideDefinitions.clear()
    this.injectUsages.clear()
    this.sourceProps.clear()
    this.sourcePropTypes.clear()
    this.sourceMethods.clear()
    this.sourceEmits.clear()
    this.sourceSlots.clear()
    this.sourceEventBusCalls.clear()
    this.sourceProvides.clear()
    this.sourceInjects.clear()
    this.sourceRefMethodCalls.clear()
    this.sourceComposableReturnUsages.clear()
    this.sourceRelationFiles.clear()
    this.vue3ScriptImportConsumers.clear()
    this.parentComponents.clear()
    this.usageKeysByFile = new WeakMap()
    this.refMethodForwardKeysByFile = new WeakMap()
    this.sourceKeysByFile = new WeakMap()
    this.scriptImportKeysByFile = new WeakMap()
    this.injectUsageKeysByProvider = new WeakMap()
    this.parentLinksByFile = new WeakMap()
  }

  private indexScriptComponentUsageContent(uri: string, content: string, rebuild = true): void {
    this.removeScriptComponentUsageFile(uri)
    const usages = parseScriptComponentUsages(uri, content, this.workspaceRoots)
      .filter((usage) => this.isInsideWorkspace(usage.childUri) && !isInsideNodeModules(usage.childUri))
    if (usages.length === 0) {
      return
    }

    this.scriptComponentUsageFiles.set(uri, {
      file: scriptUsageFile(uri, content, this.vueVersionForUri(uri)),
      usages,
    })
    if (rebuild && !this.isBulkIndexing) {
      this.rebuildReverseIndexes()
    }
  }

  private removeScriptComponentUsageFile(uri: string): void {
    const usageFile = this.scriptComponentUsageFiles.get(uri)
    if (!usageFile) {
      return
    }
    this.removeTrackedFileUsages(usageFile.file)
    this.scriptComponentUsageFiles.delete(uri)
  }

  private addScriptComponentUsages(): void {
    for (const usageFile of this.scriptComponentUsageFiles.values()) {
      for (const usage of usageFile.usages) {
        this.addUsage(this.componentUsages, usage.childUri, { file: usageFile.file, span: usage.span })
      }
    }
  }

  private addUsage<T extends UsageInfo>(map: Map<string, T[]>, key: string, usage: T): void {
    addUsage(map, key, usage)
    this.trackUsage(map, key, usage.file)
  }

  private addRefMethodForward(childUri: string, methodName: string, usage: UsageInfo): void {
    const key = usageKey(childUri, methodName)
    addUsage(this.refMethodForwards, key, usage)

    const keys = this.refMethodForwardKeysByFile.get(usage.file) ?? new Set<string>()
    keys.add(key)
    this.refMethodForwardKeysByFile.set(usage.file, keys)
  }

  private addUsageIfMissing<T extends UsageInfo>(map: Map<string, T[]>, key: string, usage: T): boolean {
    const usages = map.get(key) ?? []
    if (usages.some((item) => item.file === usage.file && item.span.start === usage.span.start && item.span.end === usage.span.end)) {
      return false
    }
    addUsage(map, key, usage)
    this.trackUsage(map, key, usage.file)
    return true
  }

  private trackUsage<T extends UsageInfo>(map: Map<string, T[]>, key: string, file: VueFileIndex): void {
    const trackedMap = map as unknown as TrackedUsageMap
    const usageMaps = this.usageKeysByFile.get(file) ?? new Map<TrackedUsageMap, Set<string>>()
    const keys = usageMaps.get(trackedMap) ?? new Set<string>()
    keys.add(key)
    usageMaps.set(trackedMap, keys)
    this.usageKeysByFile.set(file, usageMaps)
  }

  private addSourceRelation<T extends { file: VueFileIndex }>(map: SourceRelationMap<T>, sourceLocation: SourceLocation | undefined, item: T): void {
    if (!sourceLocation) {
      return
    }
    const items = map.get(sourceLocation.uri) ?? []
    items.push(item)
    map.set(sourceLocation.uri, items)

    const files = this.sourceRelationFiles.get(sourceLocation.uri) ?? new Set<string>()
    files.add(item.file.uri)
    this.sourceRelationFiles.set(sourceLocation.uri, files)

    const sourceKeys = this.sourceKeysByFile.get(item.file) ?? new Set<string>()
    sourceKeys.add(sourceLocation.uri)
    this.sourceKeysByFile.set(item.file, sourceKeys)
  }

  private addSourceRelations(file: VueFileIndex): void {
    for (const prop of file.scriptIndex.props) {
      this.addSourceRelation(this.sourceProps, prop.sourceLocation, { file, prop })
    }
    if (file.scriptIndex.vue3PropType) {
      this.addSourceRelation(this.sourcePropTypes, file.scriptIndex.vue3PropType.sourceLocation, { file, type: file.scriptIndex.vue3PropType })
    }
    for (const method of file.scriptIndex.methods) {
      this.addSourceRelation(this.sourceMethods, method.sourceLocation, { file, method })
    }
    for (const emit of file.scriptIndex.emits) {
      this.addSourceRelation(this.sourceEmits, emit.sourceLocation, { file, emit })
    }
    for (const slot of file.scriptIndex.slots) {
      this.addSourceRelation(this.sourceSlots, slot.sourceLocation, { file, slot })
    }
    for (const call of file.scriptIndex.eventBusCalls) {
      this.addSourceRelation(this.sourceEventBusCalls, call.sourceLocation, { file, call })
    }
    for (const provide of file.scriptIndex.provides) {
      this.addSourceRelation(this.sourceProvides, provide.sourceLocation, { file, provide })
      this.addSourceRelation(this.sourceProvides, provide.keySourceLocation, { file, provide })
    }
    for (const inject of file.scriptIndex.injects) {
      this.addSourceRelation(this.sourceInjects, inject.sourceLocation, { file, inject })
      this.addSourceRelation(this.sourceInjects, inject.keySourceLocation, { file, inject })
    }
    for (const call of file.refMethodCalls) {
      this.addSourceRelation(this.sourceRefMethodCalls, call.sourceLocation, { file, call })
    }
    for (const usage of file.scriptIndex.composableReturnUsages) {
      this.addSourceRelation(this.sourceComposableReturnUsages, usage.sourceLocation, { file, usage })
    }
  }

  private addVue3ScriptImportConsumers(file: VueFileIndex): void {
    if (file.vueVersion !== 3) {
      return
    }

    const keys = this.scriptImportKeysByFile.get(file) ?? new Set<string>()
    for (const imported of file.scriptIndex.imports) {
      if (!isComposableImport(imported)) {
        continue
      }

      const sourceUri = resolveComposableImport(file.uri, imported.source, this.workspaceRoots)
      if (!sourceUri || !this.isInsideWorkspace(sourceUri) || isInsideNodeModules(sourceUri)) {
        continue
      }

      const consumers = this.vue3ScriptImportConsumers.get(sourceUri) ?? new Set<string>()
      consumers.add(file.uri)
      this.vue3ScriptImportConsumers.set(sourceUri, consumers)
      keys.add(sourceUri)
    }

    if (keys.size > 0) {
      this.scriptImportKeysByFile.set(file, keys)
    }
  }

  private addInjectUsageProvider(provider: VueFileIndex, key: string): void {
    const keys = this.injectUsageKeysByProvider.get(provider) ?? new Set<string>()
    keys.add(key)
    this.injectUsageKeysByProvider.set(provider, keys)
  }

  private addParentLink(parent: VueFileIndex, childUri: string): void {
    addParent(this.parentComponents, childUri, parent.uri)
    const children = this.parentLinksByFile.get(parent) ?? new Set<string>()
    children.add(childUri)
    this.parentLinksByFile.set(parent, children)
  }

  private removeTrackedFileUsages(file: VueFileIndex): void {
    const usageMaps = this.usageKeysByFile.get(file)
    if (!usageMaps) {
      return
    }

    for (const [map, keys] of usageMaps) {
      for (const key of keys) {
        removeFileUsageAtKey(map, key, file)
      }
    }
    this.usageKeysByFile.delete(file)
  }

  private removeFileSourceRelations(file: VueFileIndex): void {
    const keys = this.sourceKeysByFile.get(file)
    if (!keys) {
      return
    }
    for (const key of keys) {
      removeSourceRelationItem(this.sourceProps, key, file)
      removeSourceRelationItem(this.sourcePropTypes, key, file)
      removeSourceRelationItem(this.sourceMethods, key, file)
      removeSourceRelationItem(this.sourceEmits, key, file)
      removeSourceRelationItem(this.sourceSlots, key, file)
      removeSourceRelationItem(this.sourceEventBusCalls, key, file)
      removeSourceRelationItem(this.sourceProvides, key, file)
      removeSourceRelationItem(this.sourceInjects, key, file)
      removeSourceRelationItem(this.sourceRefMethodCalls, key, file)
      removeSourceRelationItem(this.sourceComposableReturnUsages, key, file)

      const files = this.sourceRelationFiles.get(key)
      files?.delete(file.uri)
      if (files?.size === 0) {
        this.sourceRelationFiles.delete(key)
      }
    }
    this.sourceKeysByFile.delete(file)
  }

  private removeFileScriptImportConsumers(file: VueFileIndex): void {
    const keys = this.scriptImportKeysByFile.get(file)
    if (!keys) {
      return
    }

    for (const key of keys) {
      const consumers = this.vue3ScriptImportConsumers.get(key)
      consumers?.delete(file.uri)
      if (consumers?.size === 0) {
        this.vue3ScriptImportConsumers.delete(key)
      }
    }
    this.scriptImportKeysByFile.delete(file)
  }

  private removeFileRefMethodForwards(file: VueFileIndex): void {
    const keys = this.refMethodForwardKeysByFile.get(file)
    if (!keys) {
      return
    }

    for (const key of keys) {
      removeFileUsageAtKey(this.refMethodForwards, key, file)
    }
    this.refMethodForwardKeysByFile.delete(file)
  }

  private removeTrackedProviderUsages(file: VueFileIndex): void {
    const keys = this.injectUsageKeysByProvider.get(file)
    if (!keys) {
      return
    }

    for (const key of keys) {
      const usages = this.injectUsages.get(key) ?? []
      for (const usage of usages) {
        this.removeTrackedUsageKey(usage.file, this.injectUsages, key)
      }
      this.injectUsages.delete(key)
    }
    this.injectUsageKeysByProvider.delete(file)
  }

  private removeTrackedUsageKey<T extends UsageInfo>(file: VueFileIndex, map: Map<string, T[]>, key: string): void {
    const usageMaps = this.usageKeysByFile.get(file)
    const trackedMap = map as unknown as TrackedUsageMap
    const keys = usageMaps?.get(trackedMap)
    if (!keys) {
      return
    }
    keys.delete(key)
    if (keys.size === 0) {
      usageMaps?.delete(trackedMap)
    }
    if (usageMaps?.size === 0) {
      this.usageKeysByFile.delete(file)
    }
  }

  private removeTrackedParentLinks(file: VueFileIndex): void {
    const children = this.parentLinksByFile.get(file)
    if (!children) {
      return
    }

    for (const childUri of children) {
      const parents = this.parentComponents.get(childUri)
      if (!parents) {
        continue
      }
      parents.delete(file.uri)
      if (parents.size === 0) {
        this.parentComponents.delete(childUri)
      }
    }
    this.parentLinksByFile.delete(file)
  }

  private addProvideDefinitions(file: VueFileIndex): void {
    for (const provide of file.scriptIndex.provides) {
      this.addUsage(this.provideDefinitions, provide.key, { file, span: provide.keySpan, sourceLocation: provide.sourceLocation })
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
        this.addParentLink(file, childUri)
        this.addUsage(this.componentUsages, childUri, { file, span: component.span })
        relationshipChildren.add(childUri)
      }

      for (const attr of component.attrs) {
        for (const childUri of childUris) {
          if (attr.kind === 'prop') {
            this.addUsage(this.propUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
          } else if (attr.kind === 'event') {
            this.addUsage(this.eventUsages, usageKey(childUri, attr.normalizedName), { file, span: attr.span })
          }
        }
      }

      for (const bind of component.binds) {
        const resolved = resolveTemplateBindExpression(file, bind.expression)
        for (const propName of resolved.propNames) {
          for (const childUri of childUris) {
            this.addUsage(this.propUsages, usageKey(childUri, propName), { file, span: bind.span })
          }
        }
      }

      for (const slot of component.slots) {
        for (const childUri of childUris) {
          this.addUsage(this.slotUsages, usageKey(childUri, slot.normalizedName), { file, span: slot.span })
        }
      }
    }

    for (const call of file.refMethodCalls) {
      for (const childUri of this.resolveRefComponents(file, call.refName)) {
        const child = this.getFile(childUri)
        if (file.vueVersion === 3 && !hasVue3RefMethod(child, call.methodName)) {
          continue
        }
        if (call.forwarded) {
          this.addRefMethodForward(childUri, call.methodName, { file, span: call.methodSpan, sourceLocation: call.sourceLocation })
        } else {
          this.addUsage(this.refMethodUsages, usageKey(childUri, call.methodName), { file, span: call.methodSpan, sourceLocation: call.sourceLocation })
        }
      }
    }

    for (const usage of file.scriptIndex.vue3PropUsages) {
      this.addUsage(this.vue3PropInternalUsages, usageKey(file.uri, usage.propName), { file, span: usage.span })
    }

    return relationshipChildren
  }

  private addForwardedAttrEventUsages(): void {
    let changed = true
    while (changed) {
      changed = false
      const incomingEvents = this.collectIncomingTemplateEventUsages()
      for (const file of this.files.values()) {
        const fileIncomingEvents = incomingEvents.get(file.uri)
        if (!fileIncomingEvents?.length) {
          continue
        }
        for (const component of file.templateIndex.components) {
          if (!componentForwardsListeners(file, component)) {
            continue
          }
          const childUris = this.resolveTemplateComponentUris(file, component)
          for (const { eventName, usage } of fileIncomingEvents) {
            if (file.vueVersion === 3 && hasDeclaredEmit(file, eventName)) {
              continue
            }
            for (const childUri of childUris) {
              changed = this.addUsageIfMissing(this.eventUsages, usageKey(childUri, eventName), usage) || changed
            }
          }
        }
      }
    }
  }

  private addForwardedAttrPropUsages(): void {
    let changed = true
    while (changed) {
      changed = false
      const incomingProps = this.collectIncomingTemplatePropUsages()
      for (const file of this.files.values()) {
        const fileIncomingProps = incomingProps.get(file.uri)
        if (!fileIncomingProps?.length) {
          continue
        }
        for (const component of file.templateIndex.components) {
          if (!componentForwardsAttrs(file, component)) {
            continue
          }
          const childUris = this.resolveTemplateComponentUris(file, component)
          for (const { propName, usage } of fileIncomingProps) {
            if (hasDeclaredProp(file, propName)) {
              continue
            }
            for (const childUri of childUris) {
              changed = this.addUsageIfMissing(this.propUsages, usageKey(childUri, propName), usage) || changed
            }
          }
        }
      }
    }
  }

  private findEventDefinitionsRecursive(childUri: string, eventName: string, seen: Set<string>): Array<{ file: VueFileIndex, emit: EmitInfo }> {
    if (seen.has(childUri)) {
      return []
    }
    seen.add(childUri)
    const file = this.getFile(childUri)
    if (!file) {
      return []
    }

    const matchingEmits = file.scriptIndex.emits
      .filter((emit) => matchesName(emit.eventName, eventName))
    const preferredEmits = matchingEmits.some((emit) => emit.declared)
      ? matchingEmits.filter((emit) => emit.declared)
      : matchingEmits
    const definitions = preferredEmits
      .map((emit) => ({ file, emit }))

    if (file.vueVersion === 3 && definitions.length > 0) {
      return definitions
    }

    for (const component of file.templateIndex.components) {
      if (!componentForwardsListeners(file, component)) {
        continue
      }
      for (const forwardedChildUri of this.resolveTemplateComponentUris(file, component)) {
        definitions.push(...this.findEventDefinitionsRecursive(forwardedChildUri, eventName, seen))
      }
    }

    return definitions
  }

  private findPropDefinitionsRecursive(childUri: string, propName: string, seen: Set<string>): Array<{ file: VueFileIndex, prop: PropInfo }> {
    if (seen.has(childUri)) {
      return []
    }
    seen.add(childUri)
    const file = this.getFile(childUri)
    if (!file) {
      return []
    }

    const definitions = file.scriptIndex.props
      .filter((prop) => matchesName(prop.name, propName))
      .map((prop) => ({ file, prop }))

    if (definitions.length > 0) {
      return definitions
    }

    for (const component of file.templateIndex.components) {
      if (!componentForwardsAttrs(file, component)) {
        continue
      }
      for (const forwardedChildUri of this.resolveTemplateComponentUris(file, component)) {
        definitions.push(...this.findPropDefinitionsRecursive(forwardedChildUri, propName, seen))
      }
    }

    return definitions
  }

  private findRefMethodDefinitionsRecursive(childUri: string, methodName: string, seen: Set<string>): Array<{ file: VueFileIndex, method: MethodInfo }> {
    const key = usageKey(childUri, methodName)
    if (seen.has(key)) {
      return []
    }
    seen.add(key)

    const file = this.getFile(childUri)
    if (!file) {
      return []
    }

    const definitions = file.scriptIndex.methods
      .filter((method) => method.name === methodName)
      .map((method) => ({ file, method }))

    for (const call of file.refMethodCalls) {
      if (!call.forwarded || call.methodName !== methodName) {
        continue
      }
      for (const forwardedChildUri of this.resolveRefComponents(file, call.refName)) {
        definitions.push(...this.findRefMethodDefinitionsRecursive(forwardedChildUri, methodName, seen))
      }
    }

    return definitions
  }

  private hasAnyForwardedListeners(): boolean {
    return [...this.files.values()].some((file) => hasForwardedListeners(file))
  }

  private hasAnyForwardedAttrs(): boolean {
    return [...this.files.values()].some((file) => hasForwardedAttrs(file))
  }

  private collectIncomingTemplateEventUsages(): Map<string, Array<{ eventName: string, usage: UsageInfo }>> {
    const results = new Map<string, Array<{ eventName: string, usage: UsageInfo }>>()
    for (const [key, usages] of this.eventUsages) {
      const separator = key.lastIndexOf('\0')
      if (separator === -1) {
        continue
      }
      const childUri = key.slice(0, separator)
      const eventName = key.slice(separator + 1)
      const current = results.get(childUri) ?? []
      current.push(...usages.map((usage) => ({ eventName, usage })))
      results.set(childUri, current)
    }
    return results
  }

  private collectIncomingTemplatePropUsages(): Map<string, Array<{ propName: string, usage: UsageInfo }>> {
    const results = new Map<string, Array<{ propName: string, usage: UsageInfo }>>()
    for (const [key, usages] of this.propUsages) {
      const separator = key.lastIndexOf('\0')
      if (separator === -1) {
        continue
      }
      const childUri = key.slice(0, separator)
      const propName = key.slice(separator + 1)
      const current = results.get(childUri) ?? []
      current.push(...usages.map((usage) => ({ propName, usage })))
      results.set(childUri, current)
    }
    return results
  }

  private addEventBusUsages(file: VueFileIndex): void {
    for (const call of file.scriptIndex.eventBusCalls) {
      const usage = { file, span: call.eventSpan, sourceLocation: call.sourceLocation, method: call.method }
      this.addUsage(call.kind === 'emit' ? this.eventBusEmits : this.eventBusListeners, eventBusKey(call.busName, call.eventName), usage)
      addEventBusEventName(this.eventBusEventNames, call.busName, call.eventName)
    }
  }

  private addInjectUsages(file: VueFileIndex): void {
    for (const inject of file.scriptIndex.injects) {
      for (const provider of this.findProvideDefinitions(file, inject.key)) {
        const key = usageKey(provider.file.uri, inject.key)
        this.addUsage(this.injectUsages, key, { file, span: inject.keySpan, sourceLocation: inject.sourceLocation })
        this.addInjectUsageProvider(provider.file, key)
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

  private rebuildVue3ScriptImportConsumers(sourceUri: string): void {
    const consumerUris = new Set([
      ...(this.sourceRelationFiles.get(sourceUri) ?? []),
      ...(this.vue3ScriptImportConsumers.get(sourceUri) ?? []),
    ])
    const indexedFiles = [...consumerUris]
      .map((uri) => this.files.get(uri))
      .filter((file): file is VueFileIndex => Boolean(file))
      .map((file) => ({ uri: file.uri, content: file.content }))
    if (indexedFiles.length === 0) {
      return
    }

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
      this.addSourceRelations(file)
      this.addVue3ScriptImportConsumers(file)
      this.addProvideDefinitions(file)
    }
    for (const file of this.files.values()) {
      this.addRelationshipUsages(file)
      this.addEventBusUsages(file)
    }
    this.addScriptComponentUsages()
    this.addForwardedAttrPropUsages()
    this.addForwardedAttrEventUsages()
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

  private globalComponentsSignature(): string {
    const entries: string[] = []
    for (const [name, components] of this.globalComponents) {
      for (const component of components) {
        entries.push([
          name,
          component.tag,
          component.localName,
          component.targetUri ?? '',
          component.fileUri,
          component.source ?? '',
          component.usesImportedName ? '1' : '0',
        ].join('\0'))
      }
    }
    return entries.sort().join('\n')
  }

  private globalComponentContextsSignature(): string {
    const entries: string[] = []
    for (const [fileUri, contexts] of this.globalComponentContexts) {
      for (const context of contexts) {
        entries.push([
          fileUri,
          context.targetUri ?? '',
        ].join('\0'))
      }
    }
    return entries.sort().join('\n')
  }

  private eventBusNamesSignature(): string {
    return this.getEventBusNames().sort().join('\0')
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
    return this.workspaceRoots
      .filter((root) => uri === root || isInsideDirectory(uri, root))
      .sort((a, b) => b.length - a.length)[0]
  }

  private vueVersionForUri(uri: string, sfc?: ParsedSfc): VueMajorVersion {
    const root = this.workspaceRootFor(uri)
    if (root) {
      return this.workspaceVueVersions.get(root) ?? 2
    }
    return sfc?.scriptSetup ? 3 : 2
  }

  private removeEventBusRegistrationsInRoot(root: string): void {
    for (const uri of [...this.eventBusRegistrations.keys()]) {
      if (uri === root || isInsideDirectory(uri, root)) {
        this.eventBusRegistrations.delete(uri)
      }
    }
  }

  private removeReverseIndex(file: VueFileIndex): void {
    this.removeFileSourceRelations(file)
    this.removeFileScriptImportConsumers(file)
    this.removeFileRefMethodForwards(file)
    this.removeTrackedFileUsages(file)
    removeEventBusEventNames(this.eventBusEventNames, this.eventBusEmits, this.eventBusListeners, file)
    this.removeTrackedProviderUsages(file)
    this.removeTrackedParentLinks(file)
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

  private eventKeys(childUri: string, eventName: string): string[] {
    const keys = new Set<string>()
    keys.add(usageKey(childUri, eventName))
    keys.add(usageKey(childUri, toKebabCase(eventName)))

    for (const key of this.eventUsages.keys()) {
      const separator = key.lastIndexOf('\0')
      if (separator === -1 || key.slice(0, separator) !== childUri) {
        continue
      }
      const indexedName = key.slice(separator + 1)
      if (matchesName(indexedName, eventName)) {
        keys.add(key)
      }
    }

    return [...keys]
  }

  private slotKeys(childUri: string, slotName: string): string[] {
    const keys = new Set<string>()
    keys.add(usageKey(childUri, slotName))
    keys.add(usageKey(childUri, toKebabCase(slotName)))

    for (const key of this.slotUsages.keys()) {
      const separator = key.lastIndexOf('\0')
      if (separator === -1 || key.slice(0, separator) !== childUri) {
        continue
      }
      const indexedName = key.slice(separator + 1)
      if (matchesName(indexedName, slotName)) {
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

function dedupeEventDefinitions(definitions: Array<{ file: VueFileIndex, emit: EmitInfo }>): Array<{ file: VueFileIndex, emit: EmitInfo }> {
  const seen = new Set<string>()
  const results: Array<{ file: VueFileIndex, emit: EmitInfo }> = []
  for (const definition of definitions) {
    const uri = definition.emit.sourceLocation?.uri ?? definition.file.uri
    const span = definition.emit.sourceLocation?.span ?? definition.emit.eventSpan
    const key = `${uri}\0${span.start}\0${span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(definition)
  }
  return results
}

function dedupePropDefinitions(definitions: Array<{ file: VueFileIndex, prop: PropInfo }>): Array<{ file: VueFileIndex, prop: PropInfo }> {
  const seen = new Set<string>()
  const results: Array<{ file: VueFileIndex, prop: PropInfo }> = []
  for (const definition of definitions) {
    const uri = definition.prop.sourceLocation?.uri ?? definition.file.uri
    const span = definition.prop.sourceLocation?.span ?? definition.prop.span
    const key = `${uri}\0${span.start}\0${span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(definition)
  }
  return results
}

function dedupeMethodDefinitions(definitions: Array<{ file: VueFileIndex, method: MethodInfo }>): Array<{ file: VueFileIndex, method: MethodInfo }> {
  const seen = new Set<string>()
  const results: Array<{ file: VueFileIndex, method: MethodInfo }> = []
  for (const definition of definitions) {
    const uri = definition.method.sourceLocation?.uri ?? definition.file.uri
    const span = definition.method.sourceLocation?.span ?? definition.method.span
    const key = `${uri}\0${span.start}\0${span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(definition)
  }
  return results
}

function scriptUsageFile(uri: string, content: string, vueVersion: VueMajorVersion): VueFileIndex {
  return {
    uri,
    fileName: path.basename(uri),
    vueVersion,
    content: '',
    searchableContent: '',
    lineStarts: createLineStarts(content),
    scriptIndex: emptyScriptIndex(),
    templateIndex: { components: [], emits: [], eventBusCalls: [], slots: [] },
    refMethodCalls: [],
  }
}

function parseScriptComponentUsages(uri: string, content: string, workspaceRoots: string[]): Array<{ childUri: string, span: TextSpan }> {
  const usages: Array<{ childUri: string, span: TextSpan }> = []
  const imports: ScriptComponentUsageImport[] = []

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (!isCodeTokenAt(content, 'import', index)) {
      continue
    }

    const cursor = skipWhitespace(content, index + 'import'.length)
    if (content[cursor] === '(') {
      const literalStart = skipWhitespace(content, cursor + 1)
      const literal = readStringLiteral(content, literalStart)
      const childUri = literal ? resolveVueImport(uri, literal.value, workspaceRoots) : undefined
      if (literal && childUri) {
        usages.push({ childUri, span: { start: literal.start, end: literal.end } })
      }
      continue
    }

    const statementEnd = findImportStatementEnd(content, cursor)
    const statement = content.slice(index, statementEnd)
    const sourceMatch = /\bfrom\s*(["'])/.exec(statement)
    if (!sourceMatch) {
      continue
    }
    const literalStart = index + sourceMatch.index + sourceMatch[0].length - 1
    const literal = readStringLiteral(content, literalStart)
    const childUri = literal ? resolveVueImport(uri, literal.value, workspaceRoots) : undefined
    if (!literal || !childUri) {
      continue
    }

    const clause = content.slice(cursor, index + sourceMatch.index).trim()
    const localName = parseDefaultImportName(clause)
    if (localName) {
      imports.push({
        localName,
        childUri,
        importStart: index,
        importEnd: statementEnd,
        fallbackSpan: { start: literal.start, end: literal.end },
        spans: [],
      })
    } else {
      usages.push({ childUri, span: { start: literal.start, end: literal.end } })
    }
    index = statementEnd - 1
  }

  collectImportedIdentifierUsages(content, imports)
  for (const item of imports) {
    if (item.spans.length === 0) {
      usages.push({ childUri: item.childUri, span: item.fallbackSpan })
      continue
    }
    usages.push(...item.spans.map((span) => ({ childUri: item.childUri, span })))
  }

  return usages
}

function resolveVueImport(fromUri: string, source: string, workspaceRoots: string[]): string | undefined {
  const cleanSource = source.split('?')[0]
  if (!cleanSource.endsWith('.vue')) {
    return undefined
  }
  return resolveImportPathWithExtensions(fromUri, cleanSource, workspaceRoots, ['.vue'])
}

function parseDefaultImportName(clause: string): string | undefined {
  if (clause.startsWith('type ')) {
    return undefined
  }
  const match = /^([A-Za-z_$][\w$]*)\b/.exec(clause)
  return match?.[1]
}

function collectImportedIdentifierUsages(content: string, imports: ScriptComponentUsageImport[]): void {
  if (imports.length === 0) {
    return
  }

  const importsByName = new Map<string, ScriptComponentUsageImport[]>()
  for (const item of imports) {
    const items = importsByName.get(item.localName) ?? []
    items.push(item)
    importsByName.set(item.localName, items)
  }

  const importRanges = imports
    .map((item) => ({ start: item.importStart, end: item.importEnd }))
    .sort((a, b) => a.start - b.start)
  let rangeIndex = 0

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    while (rangeIndex < importRanges.length && importRanges[rangeIndex].end <= index) {
      rangeIndex += 1
    }
    const importRange = importRanges[rangeIndex]
    if (importRange && index >= importRange.start && index < importRange.end) {
      index = importRange.end - 1
      continue
    }

    if (!isIdentifierStart(content[index])) {
      continue
    }
    const end = readIdentifierEnd(content, index + 1)
    const name = content.slice(index, end)
    const items = importsByName.get(name)
    if (items) {
      for (const item of items) {
        item.spans.push({ start: index, end })
      }
    }
    index = end - 1
  }
}

function findImportStatementEnd(content: string, start: number): number {
  for (let index = start; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (content[index] === ';' || content[index] === '\n') {
      return index + 1
    }
  }
  return content.length
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) {
    index += 1
  }
  return index
}

function isCodeTokenAt(content: string, token: string, index: number): boolean {
  return content.startsWith(token, index)
    && !/[\w$]/.test(content[index - 1] ?? '')
    && !/[\w$]/.test(content[index + token.length] ?? '')
}

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char))
}

function readIdentifierEnd(content: string, index: number): number {
  while (index < content.length && /[\w$]/.test(content[index])) {
    index += 1
  }
  return index
}

function readIdentifierAt(content: string, index: number): { value: string, start: number, end: number } | undefined {
  if (!isIdentifierStart(content[index])) {
    return undefined
  }
  const end = readIdentifierEnd(content, index + 1)
  return { value: content.slice(index, end), start: index, end }
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
  return file.refMethodCalls.find((call) => !call.forwarded && offset >= call.methodSpan.start && offset <= call.methodSpan.end)
    ?? findRefMethodAccessInSearchableContent(file.searchableContent, offset)
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

function findVue3TemplateRefMethodCalls(content: string): RefMethodAccess[] {
  const searchableContent = maskStringsAndComments(content)
  const templateRefNames = collectUseTemplateRefNames(content)
  const refAliases = collectVue3RefAliases(searchableContent)
  const results: RefMethodAccess[] = []
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\.\s*value\s*!?\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(searchableContent))) {
    const [, localName, methodName] = match
    const methodStart = match.index + match[0].lastIndexOf(methodName)
    const methodSpan: TextSpan = { start: methodStart, end: methodStart + methodName.length }
    results.push({
      refName: templateRefNames.get(localName) ?? localName,
      methodName,
      methodSpan,
    })
  }

  const assertionPattern = /\(\s*([A-Za-z_$][\w$]*)\s*\.\s*value\s*!?\s+as\s+[^)]*\)\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)/g
  while ((match = assertionPattern.exec(searchableContent))) {
    const [, localName, methodName] = match
    const methodStart = match.index + match[0].lastIndexOf(methodName)
    results.push({
      refName: templateRefNames.get(localName) ?? localName,
      methodName,
      methodSpan: { start: methodStart, end: methodStart + methodName.length },
    })
  }

  const aliasPattern = /\b(?:(this)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)\s*(?=\()/g
  while ((match = aliasPattern.exec(searchableContent))) {
    const [, thisToken, localName, methodName] = match
    const aliasKey = thisToken ? `this.${localName}` : localName
    const refName = refAliases.get(aliasKey) ?? refAliases.get(localName)
    if (!refName) {
      continue
    }
    const methodStart = match.index + match[0].lastIndexOf(methodName)
    results.push({
      refName,
      methodName,
      methodSpan: { start: methodStart, end: methodStart + methodName.length },
    })
  }

  return results
}

function hasVue3RefMethod(file: VueFileIndex | undefined, methodName: string): boolean {
  return Boolean(file?.scriptIndex.methods.some((method) => method.name === methodName)
    || file?.refMethodCalls.some((call) => call.forwarded && call.methodName === methodName))
}

interface DefineExposeForwardCall {
  calleeName: string
  refName: string
  callSpan: TextSpan
}

function findVue3DefineExposeForwardedRefMethodCalls(uri: string, sfc: ParsedSfc, imports: ImportInfo[], workspaceRoots: string[], cache: ForwardedRefMethodNameCache): RefMethodAccess[] {
  const segment = sfc.scriptSetup
  if (!segment) {
    return []
  }

  const results: RefMethodAccess[] = []
  const calls = findDefineExposeForwardCalls(segment.content, segment.start)
  const methodsByComposable = new Map<string, string[]>()

  for (const call of calls) {
    const imported = imports.find((item) => item.localName === call.calleeName && isComposableImport(item))
    if (!imported) {
      continue
    }

    const sourceUri = resolveComposableImport(uri, imported.source, workspaceRoots)
    if (!sourceUri) {
      continue
    }

    const cacheKey = `${sourceUri}\0${imported.importedName ?? imported.localName}`
    let methodNames = methodsByComposable.get(cacheKey)
    if (!methodNames) {
      methodNames = readForwardedRefMethodNames(sourceUri, imported.importedName ?? imported.localName, cache)
      methodsByComposable.set(cacheKey, methodNames)
    }

    for (const methodName of methodNames) {
      results.push({
        refName: call.refName,
        methodName,
        methodSpan: call.callSpan,
        forwarded: true,
      })
    }
  }

  return results
}

function findDefineExposeForwardCalls(content: string, offset: number): DefineExposeForwardCall[] {
  const searchableContent = maskStringsAndComments(content)
  const results: DefineExposeForwardCall[] = []

  for (let index = 0; index < searchableContent.length; index += 1) {
    if (!isCodeTokenAt(searchableContent, 'defineExpose', index)) {
      continue
    }

    let cursor = skipWhitespace(searchableContent, index + 'defineExpose'.length)
    cursor = skipTypeArguments(searchableContent, cursor)
    cursor = skipWhitespace(searchableContent, cursor)
    if (searchableContent[cursor] !== '(') {
      continue
    }

    cursor = skipWhitespace(searchableContent, cursor + 1)
    const callee = readIdentifierAt(searchableContent, cursor)
    if (!callee) {
      continue
    }

    cursor = skipWhitespace(searchableContent, callee.end)
    cursor = skipTypeArguments(searchableContent, cursor)
    cursor = skipWhitespace(searchableContent, cursor)
    if (searchableContent[cursor] !== '(') {
      continue
    }

    const ref = readIdentifierAt(searchableContent, skipWhitespace(searchableContent, cursor + 1))
    if (!ref) {
      continue
    }

    results.push({
      calleeName: callee.value,
      refName: ref.value,
      callSpan: { start: offset + callee.start, end: offset + callee.end },
    })
  }

  return results
}

function readForwardedRefMethodNames(uri: string, exportName: string, cache: ForwardedRefMethodNameCache): string[] {
  try {
    const stats = fsSync.statSync(uri)
    const cached = cache.get(uri)
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      const cachedMethods = cached.methodsByExportName.get(exportName)
      if (cachedMethods) {
        return cachedMethods
      }
    }

    const content = fsSync.readFileSync(uri, 'utf8')
    const methodNames = readForwardedRefMethodNamesFromContent(content, exportName)
    const methodsByExportName = cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size
      ? cached.methodsByExportName
      : new Map<string, string[]>()
    methodsByExportName.set(exportName, methodNames)
    cache.set(uri, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      methodsByExportName,
    })
    return methodNames
  } catch {
    return []
  }
}

function readForwardedRefMethodNamesFromContent(content: string, exportName: string): string[] {
  const range = findComposableFunctionRange(content, exportName)
  if (!range) {
    return []
  }

  const methods = new Set<string>()
  const searchableContent = maskStringsAndComments(content)
  const escapedParam = escapeRegExp(range.paramName)
  const pattern = new RegExp(`\\b${escapedParam}\\s*\\.\\s*value\\s*!?\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][\\w$]*)`, 'g')
  pattern.lastIndex = range.bodyStart
  let match: RegExpExecArray | null

  while ((match = pattern.exec(searchableContent)) && match.index < range.bodyEnd) {
    methods.add(match[1])
  }

  const assertionPattern = new RegExp(`\\(\\s*${escapedParam}\\s*\\.\\s*value\\s*!?\\s+as\\s+[^)]*\\)\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][\\w$]*)`, 'g')
  assertionPattern.lastIndex = range.bodyStart
  while ((match = assertionPattern.exec(searchableContent)) && match.index < range.bodyEnd) {
    methods.add(match[1])
  }

  return [...methods]
}

function findComposableFunctionRange(content: string, exportName: string): { paramName: string, bodyStart: number, bodyEnd: number } | undefined {
  const searchableContent = maskStringsAndComments(content)
  return findVariableComposableFunctionRange(searchableContent, exportName)
    ?? findDeclaredComposableFunctionRange(searchableContent, exportName)
}

function findVariableComposableFunctionRange(content: string, exportName: string): { paramName: string, bodyStart: number, bodyEnd: number } | undefined {
  const pattern = new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(exportName)}\\s*=`, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const valueStart = skipWhitespace(content, pattern.lastIndex)
    const header = readArrowFunctionHeader(content, valueStart)
    if (!header) {
      continue
    }

    const arrow = findArrowAfterFunctionHeader(content, header.end)
    if (arrow === -1) {
      continue
    }

    const body = readArrowFunctionBodyRange(content, arrow + 2)
    if (body) {
      return { paramName: header.paramName, ...body }
    }
  }

  return undefined
}

function findDeclaredComposableFunctionRange(content: string, exportName: string): { paramName: string, bodyStart: number, bodyEnd: number } | undefined {
  const pattern = new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(exportName)}\\s*`, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    let paramsStart = skipWhitespace(content, pattern.lastIndex)
    paramsStart = skipTypeArguments(content, paramsStart)
    paramsStart = skipWhitespace(content, paramsStart)
    if (content[paramsStart] !== '(') {
      continue
    }

    const param = readIdentifierAt(content, skipWhitespace(content, paramsStart + 1))
    const paramsEnd = findMatchingBracket(content, paramsStart)
    const bodyStart = skipWhitespace(content, paramsEnd + 1)
    if (!param || content[bodyStart] !== '{') {
      continue
    }

    return {
      paramName: param.value,
      bodyStart,
      bodyEnd: findMatchingBracket(content, bodyStart),
    }
  }

  return undefined
}

function readArrowFunctionHeader(content: string, start: number): { paramName: string, end: number } | undefined {
  let cursor = skipWhitespace(content, start)
  if (isCodeTokenAt(content, 'async', cursor)) {
    cursor = skipWhitespace(content, cursor + 'async'.length)
  }
  cursor = skipTypeArguments(content, cursor)
  cursor = skipWhitespace(content, cursor)

  if (content[cursor] === '(') {
    const param = readIdentifierAt(content, skipWhitespace(content, cursor + 1))
    const paramsEnd = findMatchingBracket(content, cursor)
    if (!param) {
      return undefined
    }
    return { paramName: param.value, end: paramsEnd + 1 }
  }

  const param = readIdentifierAt(content, cursor)
  if (!param) {
    return undefined
  }
  return { paramName: param.value, end: param.end }
}

function findArrowAfterFunctionHeader(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = skipWhitespace(content, start); index < content.length; index += 1) {
    if (content.startsWith('=>', index) && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return index
    }

    const char = content[index]
    if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return -1
    }
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    }
  }

  return -1
}

function readArrowFunctionBodyRange(content: string, start: number): { bodyStart: number, bodyEnd: number } | undefined {
  const bodyStart = skipWhitespace(content, start)
  if (content[bodyStart] === '{') {
    return { bodyStart, bodyEnd: findMatchingBracket(content, bodyStart) }
  }

  if (content[bodyStart] === '(') {
    return { bodyStart, bodyEnd: findMatchingBracket(content, bodyStart) }
  }

  return { bodyStart, bodyEnd: findExpressionEnd(content, bodyStart) }
}

function findExpressionEnd(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    } else if ((char === ';' || char === '\n') && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return index
    }
  }

  return content.length
}

function collectUseTemplateRefNames(content: string): Map<string, string> {
  const searchableContent = maskStringsAndComments(content)
  const names = new Map<string, string>()

  for (let index = 0; index < searchableContent.length; index += 1) {
    const declaration = (['const', 'let', 'var'] as const).find((token) => isCodeTokenAt(searchableContent, token, index))
    if (!declaration) {
      continue
    }

    let cursor = skipWhitespace(searchableContent, index + declaration.length)
    if (!isIdentifierStart(searchableContent[cursor])) {
      continue
    }
    const nameEnd = readIdentifierEnd(searchableContent, cursor + 1)
    const localName = searchableContent.slice(cursor, nameEnd)
    const equals = findDeclaratorEquals(searchableContent, nameEnd)
    if (equals === undefined) {
      index = nameEnd - 1
      continue
    }

    cursor = skipWhitespace(searchableContent, equals + 1)
    if (!isCodeTokenAt(searchableContent, 'useTemplateRef', cursor)) {
      index = cursor - 1
      continue
    }

    cursor = skipWhitespace(searchableContent, cursor + 'useTemplateRef'.length)
    cursor = skipTypeArguments(searchableContent, cursor)
    cursor = skipWhitespace(searchableContent, cursor)
    if (searchableContent[cursor] !== '(') {
      index = cursor
      continue
    }

    const literalStart = skipWhitespace(content, cursor + 1)
    const literal = readStringLiteral(content, literalStart)
    if (literal) {
      names.set(localName, literal.value)
    }
    index = cursor
  }

  return names
}

function findDeclaratorEquals(content: string, start: number): number | undefined {
  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    if (char === '=') {
      return index
    }
    if (char === ';') {
      return undefined
    }
  }
  return undefined
}

function skipTypeArguments(content: string, index: number): number {
  if (content[index] !== '<') {
    return index
  }

  let depth = 0
  for (let cursor = index; cursor < content.length; cursor += 1) {
    if (content[cursor] === '<') {
      depth += 1
    } else if (content[cursor] === '>') {
      depth -= 1
      if (depth === 0) {
        return cursor + 1
      }
    } else if (depth === 0 && content[cursor] === '(') {
      return cursor
    }
  }
  return index
}

function collectVue3RefAliases(searchableContent: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const pattern = /\b(?:(this)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*\$refs\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(searchableContent))) {
    const [, thisToken, localName, refName] = match
    aliases.set(thisToken ? `this.${localName}` : localName, refName)
  }

  return aliases
}

function parseScriptImportedVueComponents(uri: string, content: string, imports: ImportInfo[], workspaceRoots: string[]): ComponentRegistration[] {
  return imports
    .map((item): ComponentRegistration | undefined => {
      const targetUri = resolveImportPathWithExtensions(uri, item.source, workspaceRoots, ['.vue'])
      if (!targetUri || !targetUri.endsWith('.vue') || !fsSync.existsSync(targetUri)) {
        return undefined
      }
      const start = content.indexOf(item.localName)
      const nameSpan = start === -1
        ? { start: 0, end: 0 }
        : { start, end: start + item.localName.length }
      return {
        tag: item.localName,
        localName: item.localName,
        source: item.source,
        targetUri,
        nameSpan,
      }
    })
    .filter((item): item is ComponentRegistration => Boolean(item))
}

function parseVue3ScriptRefComponentUsages(content: string): TemplateComponentUsage[] {
  const usages: TemplateComponentUsage[] = []

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (!isCodeTokenAt(content, 'h', index)) {
      continue
    }

    const open = skipWhitespace(content, index + 1)
    if (content[open] !== '(') {
      continue
    }
    const componentStart = skipWhitespace(content, open + 1)
    if (!isIdentifierStart(content[componentStart])) {
      continue
    }
    const componentEnd = readIdentifierEnd(content, componentStart + 1)
    const tag = content.slice(componentStart, componentEnd)
    const comma = skipWhitespace(content, componentEnd)
    if (content[comma] !== ',') {
      continue
    }
    const objectStart = skipWhitespace(content, comma + 1)
    if (content[objectStart] !== '{') {
      continue
    }
    const objectEnd = findMatchingBracket(content, objectStart)
    const ref = readObjectRefString(content, objectStart, objectEnd)
    if (!ref) {
      continue
    }

    usages.push({
      tag,
      span: { start: componentStart, end: componentEnd },
      attrs: [{
        kind: 'ref',
        name: ref.name,
        normalizedName: ref.name,
        span: ref.span,
        fullSpan: ref.fullSpan,
      }],
      binds: [],
      slots: [],
    })
    index = objectEnd
  }

  return usages
}

function readObjectRefString(content: string, objectStart: number, objectEnd: number): { name: string, span: TextSpan, fullSpan: TextSpan } | undefined {
  let index = objectStart + 1
  while (index < objectEnd) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }
    if (!isCodeTokenAt(content, 'ref', index)) {
      index += 1
      continue
    }

    const afterName = skipWhitespace(content, index + 'ref'.length)
    if (content[afterName] !== ':') {
      index = afterName
      continue
    }
    const valueStart = skipWhitespace(content, afterName + 1)
    const literal = readStringLiteral(content, valueStart)
    if (!literal) {
      index = valueStart + 1
      continue
    }
    return {
      name: literal.value,
      span: { start: literal.start, end: literal.end },
      fullSpan: { start: index, end: index + 'ref'.length },
    }
  }

  return undefined
}

function findMatchingBracket(content: string, openIndex: number): number {
  const open = content[openIndex]
  const close = open === '{' ? '}' : open === '[' ? ']' : ')'
  let depth = 0

  for (let index = openIndex; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (content[index] === open) {
      depth += 1
    } else if (content[index] === close) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return content.length - 1
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function removeFileUsageAtKey<T extends UsageInfo>(map: Map<string, T[]>, key: string, file: VueFileIndex): void {
  const usages = map.get(key)
  if (!usages) {
    return
  }
  const kept = usages.filter((usage) => usage.file !== file)
  if (kept.length === 0) {
    map.delete(key)
  } else if (kept.length !== usages.length) {
    map.set(key, kept)
  }
}

function removeSourceRelationItem<T extends { file: VueFileIndex }>(map: SourceRelationMap<T>, key: string, file: VueFileIndex): void {
  const items = map.get(key)
  if (!items) {
    return
  }
  const kept = items.filter((item) => item.file !== file)
  if (kept.length === 0) {
    map.delete(key)
  } else if (kept.length !== items.length) {
    map.set(key, kept)
  }
}

function hasForwardedListeners(file: VueFileIndex): boolean {
  return file.templateIndex.components.some((component) => componentForwardsListeners(file, component))
}

function hasForwardedAttrs(file: VueFileIndex): boolean {
  return file.templateIndex.components.some((component) => componentForwardsAttrs(file, component))
}

function hasTemplateEventAttrs(file: VueFileIndex): boolean {
  return file.templateIndex.components.some((component) => component.attrs.some((attr) => attr.kind === 'event'))
}

function hasTemplatePropAttrs(file: VueFileIndex): boolean {
  return file.templateIndex.components.some((component) => {
    return component.attrs.some((attr) => attr.kind === 'prop')
      || component.binds.some((bind) => resolveTemplateBindExpression(file, bind.expression).propNames.length > 0)
  })
}

function hasDeclaredProp(file: VueFileIndex, propName: string): boolean {
  return file.scriptIndex.props.some((prop) => matchesName(prop.name, propName))
}

function hasDeclaredEmit(file: VueFileIndex, eventName: string): boolean {
  return file.scriptIndex.emits.some((emit) => matchesName(emit.eventName, eventName))
}

interface TemplateBindResolution {
  propNames: string[]
  forwardsAttrs: boolean
}

interface TemplateBindContext {
  useAttrsNames: Set<string>
  definePropsNames: Set<string>
  initializers: Map<string, TemplateInitializer>
  restBindings: Map<string, { sourceName: string, omitted: string[] }>
}

interface TemplateInitializer {
  content: string
  span: TextSpan
}

const templateBindContextCache = new WeakMap<VueFileIndex, TemplateBindContext>()

function componentForwardsAttrs(file: VueFileIndex, component: TemplateComponentUsage): boolean {
  return Boolean(component.forwardsAttrs)
    || component.binds.some((bind) => resolveTemplateBindExpression(file, bind.expression).forwardsAttrs)
}

function componentForwardsListeners(file: VueFileIndex, component: TemplateComponentUsage): boolean {
  return Boolean(component.forwardsListeners) || componentForwardsAttrs(file, component)
}

function emptyBindResolution(): TemplateBindResolution {
  return { propNames: [], forwardsAttrs: false }
}

function mergeBindResolutions(items: TemplateBindResolution[]): TemplateBindResolution {
  return {
    propNames: uniqueStrings(items.flatMap((item) => item.propNames)),
    forwardsAttrs: items.some((item) => item.forwardsAttrs),
  }
}

function resolveTemplateBindExpression(file: VueFileIndex, expression: string, seen = new Set<string>()): TemplateBindResolution {
  const normalized = stripOuterParens(expression.trim())
  if (!normalized) {
    return emptyBindResolution()
  }

  if (normalized === '$attrs') {
    return { propNames: [], forwardsAttrs: true }
  }

  if (normalized.startsWith('{')) {
    return resolveObjectBindExpression(file, normalized, 0, findMatchingBracket(normalized, 0), seen)
  }

  const call = readCallExpression(normalized)
  if (call?.callee === 'mergeProps') {
    return mergeBindResolutions(call.args.map((arg) => resolveTemplateBindExpression(file, arg, seen)))
  }

  const identifier = readIdentifierAt(normalized, 0)
  if (identifier && identifier.end === normalized.length) {
    return resolveTemplateBindIdentifier(file, identifier.value, seen)
  }

  if (identifier && normalized.slice(identifier.end).trim() === '.value') {
    return resolveTemplateBindIdentifier(file, identifier.value, seen)
  }

  return emptyBindResolution()
}

function resolveTemplateBindIdentifier(file: VueFileIndex, name: string, seen: Set<string>): TemplateBindResolution {
  const seenKey = `${file.uri}\0${name}`
  if (seen.has(seenKey)) {
    return emptyBindResolution()
  }
  seen.add(seenKey)

  const context = getTemplateBindContext(file)
  if (context.useAttrsNames.has(name)) {
    return { propNames: [], forwardsAttrs: true }
  }

  if (context.definePropsNames.has(name)) {
    return { propNames: file.scriptIndex.props.map((prop) => prop.name), forwardsAttrs: false }
  }

  const restProps = resolveRestPropsIdentifier(file, name, seen, context)
  if (restProps) {
    return restProps
  }

  const initializer = context.initializers.get(name)
  if (!initializer) {
    return emptyBindResolution()
  }

  return resolveInitializerBindExpression(file, readTemplateInitializer(initializer), seen)
}

function resolveInitializerBindExpression(file: VueFileIndex, initializer: string, seen: Set<string>): TemplateBindResolution {
  const expression = stripTypeAssertion(stripOuterParens(initializer.trim()))
  if (!expression) {
    return emptyBindResolution()
  }

  if (expression.startsWith('{')) {
    return resolveObjectBindExpression(file, expression, 0, findMatchingBracket(expression, 0), seen)
  }

  const call = readCallExpression(expression)
  if (!call) {
    return resolveTemplateBindExpression(file, expression, seen)
  }

  if (['ref', 'shallowRef', 'reactive', 'shallowReactive', 'readonly', 'markRaw'].includes(call.callee)) {
    return call.args[0] ? resolveTemplateBindExpression(file, call.args[0], seen) : emptyBindResolution()
  }

  if (call.callee === 'computed') {
    return call.args[0] ? resolveComputedBindExpression(file, call.args[0], seen) : emptyBindResolution()
  }

  if (call.callee === 'mergeProps') {
    return mergeBindResolutions(call.args.map((arg) => resolveTemplateBindExpression(file, arg, seen)))
  }

  if (call.callee === 'useAttrs') {
    return { propNames: [], forwardsAttrs: true }
  }

  return emptyBindResolution()
}

function resolveComputedBindExpression(file: VueFileIndex, expression: string, seen: Set<string>): TemplateBindResolution {
  const arrow = findArrow(expression, 0)
  if (arrow === -1) {
    return emptyBindResolution()
  }

  const bodyStart = skipWhitespace(expression, arrow + 2)
  if (expression[bodyStart] === '{') {
    const bodyEnd = findMatchingBracket(expression, bodyStart)
    const returned = findReturnedObjectExpression(expression, bodyStart, bodyEnd)
    return returned
      ? resolveTemplateBindExpression(file, returned, seen)
      : emptyBindResolution()
  }

  return resolveTemplateBindExpression(file, expression.slice(bodyStart), seen)
}

function findArrow(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = start; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (content.startsWith('=>', index) && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return index
    }

    const char = content[index]
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    }
  }

  return -1
}

function findReturnedObjectExpression(content: string, bodyStart: number, bodyEnd: number): string | undefined {
  for (let index = bodyStart + 1; index < bodyEnd; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (!isCodeTokenAt(content, 'return', index)) {
      continue
    }
    const valueStart = skipWhitespace(content, index + 'return'.length)
    return content.slice(valueStart, findExpressionEnd(content, valueStart)).trim()
  }
  return undefined
}

function resolveObjectBindExpression(file: VueFileIndex, content: string, objectStart: number, objectEnd: number, seen: Set<string>): TemplateBindResolution {
  const propNames: string[] = []
  const spreadResolutions: TemplateBindResolution[] = []
  let cursor = objectStart + 1

  while (cursor < objectEnd) {
    cursor = skipWhitespace(content, cursor)
    if (cursor >= objectEnd) {
      break
    }
    if (content[cursor] === ',') {
      cursor += 1
      continue
    }

    if (content.startsWith('...', cursor)) {
      const spreadStart = skipWhitespace(content, cursor + 3)
      const spreadEnd = findTopLevelCommaOrEnd(content, spreadStart, objectEnd)
      spreadResolutions.push(resolveTemplateBindExpression(file, content.slice(spreadStart, spreadEnd), seen))
      cursor = spreadEnd + 1
      continue
    }

    const key = readObjectBindKey(content, cursor)
    if (!key) {
      cursor = findTopLevelCommaOrEnd(content, cursor + 1, objectEnd) + 1
      continue
    }

    if (isBindablePropName(key.value)) {
      propNames.push(toCamelCase(key.value))
    }
    cursor = findTopLevelCommaOrEnd(content, key.rawEnd ?? key.end, objectEnd) + 1
  }

  return mergeBindResolutions([
    { propNames, forwardsAttrs: false },
    ...spreadResolutions,
  ])
}

function readObjectBindKey(content: string, index: number): { value: string, start: number, end: number, rawEnd?: number } | undefined {
  if (content[index] === '[') {
    return undefined
  }

  const identifier = readIdentifierAt(content, index)
  if (identifier) {
    return identifier
  }

  const literal = readStringLiteral(content, index)
  return literal
    ? { value: literal.value, start: literal.start, end: literal.end, rawEnd: literal.end + 1 }
    : undefined
}

function isBindablePropName(name: string): boolean {
  return !['class', 'style', 'key', 'ref', 'is'].includes(name)
    && !/^on[A-Z]/.test(name)
}

function resolveRestPropsIdentifier(file: VueFileIndex, name: string, seen: Set<string>, context: TemplateBindContext): TemplateBindResolution | undefined {
  const rest = context.restBindings.get(name)
  if (!rest) {
    return undefined
  }

  const sourceResolution = resolveTemplateBindIdentifier(file, rest.sourceName, seen)
  return {
    propNames: sourceResolution.propNames.filter((propName) => !rest.omitted.some((omitted) => matchesName(omitted, propName))),
    forwardsAttrs: sourceResolution.forwardsAttrs,
  }
}

function readRestBinding(content: string, objectStart: number, objectEnd: number): { name: string, omitted: string[] } | undefined {
  const omitted: string[] = []
  let cursor = objectStart + 1

  while (cursor < objectEnd) {
    cursor = skipWhitespace(content, cursor)
    if (content.startsWith('...', cursor)) {
      const rest = readIdentifierAt(content, skipWhitespace(content, cursor + 3))
      return rest ? { name: rest.value, omitted } : undefined
    }

    const key = readObjectBindKey(content, cursor)
    if (key) {
      omitted.push(key.value)
      cursor = findTopLevelCommaOrEnd(content, key.rawEnd ?? key.end, objectEnd) + 1
      continue
    }
    cursor += 1
  }

  return undefined
}

function getTemplateBindContext(file: VueFileIndex): TemplateBindContext {
  const cached = templateBindContextCache.get(file)
  if (cached) {
    return cached
  }

  const context: TemplateBindContext = {
    useAttrsNames: new Set(),
    definePropsNames: new Set(),
    initializers: new Map(),
    restBindings: new Map(),
  }

  for (const segment of [file.script, file.scriptSetup]) {
    if (!segment) {
      continue
    }
    collectTemplateBindContextFromSegment(segment.content, context)
  }

  templateBindContextCache.set(file, context)
  return context
}

function collectTemplateBindContextFromSegment(content: string, context: TemplateBindContext): void {
  const masked = maskStringsAndComments(content)

  collectTopLevelInitializers(content, masked, context)
  collectTopLevelRestBindings(masked, context)

  for (const [name, initializer] of context.initializers) {
    const expression = stripTypeAssertion(stripOuterParens(readTemplateInitializer(initializer).trim()))
    const call = readCallExpression(expression)
    if (call?.callee === 'useAttrs') {
      context.useAttrsNames.add(name)
      continue
    }
    if (call?.callee === 'defineProps') {
      context.definePropsNames.add(name)
      continue
    }
    if (call?.callee === 'withDefaults' && call.args[0] && readCallExpression(stripOuterParens(call.args[0]))?.callee === 'defineProps') {
      context.definePropsNames.add(name)
    }
  }
}

function collectTopLevelInitializers(content: string, masked: string, context: TemplateBindContext): void {
  forEachTopLevelVariableDeclaration(masked, (declaration) => {
    if (!declaration.name) {
      return
    }

    const initializer = readVariableInitializerSpan(masked, declaration.afterName)
    if (initializer !== undefined) {
      context.initializers.set(declaration.name, { content, span: initializer })
    }
  })
}

function collectTopLevelRestBindings(masked: string, context: TemplateBindContext): void {
  forEachTopLevelVariableDeclaration(masked, (declaration) => {
    const objectStart = declaration.patternStart
    if (masked[objectStart] !== '{') {
      return
    }

    const objectEnd = declaration.patternEnd - 1
    const rest = readRestBinding(masked, objectStart, objectEnd)
    if (!rest) {
      return
    }

    const initializer = readVariableInitializerSpan(masked, declaration.patternEnd)
    if (!initializer) {
      return
    }

    const source = readIdentifierAt(masked, initializer.start)
    if (source) {
      context.restBindings.set(rest.name, { sourceName: source.value, omitted: rest.omitted })
    }
  })
}

function readTemplateInitializer(initializer: TemplateInitializer): string {
  return initializer.content.slice(initializer.span.start, initializer.span.end)
}

function readVariableInitializerSpan(masked: string, start: number): TextSpan | undefined {
  let cursor = skipWhitespace(masked, start)
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  while (cursor < masked.length) {
    const char = masked[cursor]
    if (masked.startsWith('=>', cursor)) {
      cursor += 2
      continue
    }
    if (char === '=' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      const valueStart = skipWhitespace(masked, cursor + 1)
      const valueEnd = findTopLevelExpressionEnd(masked, valueStart)
      return { start: valueStart, end: valueEnd }
    }
    if ((char === '\n' || char === ';') && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return undefined
    }
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    }
    cursor += 1
  }

  return undefined
}

interface TopLevelVariableDeclaration {
  name?: string
  patternStart: number
  patternEnd: number
  afterName: number
}

function forEachTopLevelVariableDeclaration(content: string, callback: (declaration: TopLevelVariableDeclaration) => void): void {
  let braceDepth = 0

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === '{') {
      braceDepth += 1
      continue
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      continue
    }
    if (braceDepth !== 0) {
      continue
    }

    const keyword = readVariableDeclarationKeywordAt(content, index)
    if (!keyword) {
      continue
    }

    const afterKeyword = index + keyword.length
    const statementEnd = findTopLevelVariableStatementEnd(content, afterKeyword)
    let cursor = afterKeyword

    while (cursor < statementEnd) {
      cursor = skipWhitespace(content, cursor)
      if (cursor >= statementEnd) {
        break
      }

      const declaration = readTopLevelVariableDeclaration(content, cursor, statementEnd)
      if (!declaration) {
        break
      }

      callback(declaration)
      const nextComma = findTopLevelCommaOrEnd(content, declaration.patternEnd, statementEnd)
      if (nextComma >= statementEnd) {
        break
      }
      cursor = nextComma + 1
    }

    index = statementEnd - 1
  }
}

function readTopLevelVariableDeclaration(content: string, start: number, statementEnd: number): TopLevelVariableDeclaration | undefined {
  if (content[start] === '{' || content[start] === '[') {
    const patternEnd = findMatchingBracket(content, start) + 1
    if (patternEnd > statementEnd) {
      return undefined
    }
    return {
      patternStart: start,
      patternEnd,
      afterName: patternEnd,
    }
  }

  const name = readIdentifierAt(content, start)
  if (!name) {
    return undefined
  }

  return {
    name: name.value,
    patternStart: name.start,
    patternEnd: name.end,
    afterName: name.end,
  }
}

function findTopLevelVariableStatementEnd(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = start; index < content.length; index += 1) {
    if (content.startsWith('=>', index)) {
      index += 1
      continue
    }

    const char = content[index]
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    } else if ((char === ';' || char === '\n') && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      const previous = previousNonWhitespace(content, index - 1)
      const next = skipWhitespace(content, index + 1)
      if (content[previous] !== ',' && content[next] !== ',') {
        return index
      }
    }
  }

  return content.length
}

function previousNonWhitespace(content: string, index: number): number {
  while (index >= 0 && /\s/.test(content[index])) {
    index -= 1
  }
  return index
}

function readVariableDeclarationKeywordAt(content: string, index: number): 'const' | 'let' | 'var' | undefined {
  if (isCodeTokenAt(content, 'const', index)) {
    return 'const'
  }
  if (isCodeTokenAt(content, 'let', index)) {
    return 'let'
  }
  return isCodeTokenAt(content, 'var', index) ? 'var' : undefined
}

function skipHorizontalWhitespace(content: string, index: number): number {
  while (index < content.length && /[^\S\r\n]/.test(content[index])) {
    index += 1
  }
  return index
}

function findTopLevelExpressionEnd(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let angleDepth = 0

  for (let index = start; index < content.length; index += 1) {
    if (content.startsWith('=>', index)) {
      index += 1
      continue
    }

    const char = content[index]
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    } else if ((char === ';' || char === '\n') && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
      return index
    }
  }

  return content.length
}

function readCallExpression(expression: string): { callee: string, args: string[] } | undefined {
  const callee = readIdentifierAt(expression, 0)
  if (!callee) {
    return undefined
  }

  let cursor = skipWhitespace(expression, callee.end)
  cursor = skipTypeArguments(expression, cursor)
  cursor = skipWhitespace(expression, cursor)
  if (expression[cursor] !== '(') {
    return undefined
  }

  const close = findMatchingBracket(expression, cursor)
  return {
    callee: callee.value,
    args: splitTopLevelArguments(expression.slice(cursor + 1, close)),
  }
}

function splitTopLevelArguments(content: string): string[] {
  const args: string[] = []
  let start = 0
  let depth = 0

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '(' || char === '{' || char === '[' || char === '<') {
      depth += 1
    } else if (char === ')' || char === '}' || char === ']' || char === '>') {
      depth = Math.max(0, depth - 1)
    } else if (char === ',' && depth === 0) {
      args.push(content.slice(start, index).trim())
      start = index + 1
    }
  }

  const last = content.slice(start).trim()
  if (last) {
    args.push(last)
  }
  return args
}

function findTopLevelCommaOrEnd(content: string, start: number, end: number): number {
  let depth = 0
  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = content[index]
    if (char === '(' || char === '{' || char === '[' || char === '<') {
      depth += 1
    } else if (char === ')' || char === '}' || char === ']' || char === '>') {
      depth = Math.max(0, depth - 1)
    } else if (char === ',' && depth === 0) {
      return index
    }
  }
  return end
}

function stripOuterParens(value: string): string {
  let current = value
  while (current.startsWith('(') && findMatchingBracket(current, 0) === current.length - 1) {
    current = current.slice(1, -1).trim()
  }
  return current
}

function stripTypeAssertion(value: string): string {
  return value
    .replace(/\s+as\s+const\s*$/u, '')
    .replace(/\s+as\s+[A-Za-z_$][\w$]*(?:<[\s\S]*>)?\s*$/u, '')
    .trim()
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

function isScriptFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.jsx') || file.endsWith('.tsx')
}

function hasVue3StandaloneScriptRelations(content: string): boolean {
  return content.includes('.vue')
    || content.includes('$refs')
    || content.includes('useTemplateRef')
    || /\bh\s*\(/.test(content)
    || hasComposableReturnUsageShape(content)
}

function hasComposableReturnUsageShape(content: string): boolean {
  const searchableContent = maskStringsAndComments(content)
  // 新增普通脚本文件可能只消费 hook 返回成员，也需要进入 Vue3 关系索引。
  if (!/\bimport\b/.test(searchableContent)) {
    return false
  }

  const pattern = /\b(?:const|let|var)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(searchableContent))) {
    const objectStart = searchableContent.indexOf('{', match.index)
    const objectEnd = findMatchingBracket(searchableContent, objectStart)
    const equal = skipWhitespace(searchableContent, objectEnd + 1)
    if (searchableContent[equal] !== '=') {
      continue
    }

    const callee = readIdentifierAt(searchableContent, skipWhitespace(searchableContent, equal + 1))
    if (!callee) {
      continue
    }

    let cursor = skipWhitespace(searchableContent, callee.end)
    cursor = skipTypeArguments(searchableContent, cursor)
    cursor = skipWhitespace(searchableContent, cursor)
    if (searchableContent[cursor] === '(') {
      return true
    }
  }

  return false
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

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { ComposableReturnUsage, EmitInfo, EventBusCall, EventBusRegistration, EventBusUsageInfo, GlobalComponentRegistration, IndexCancellationToken, InjectInfo, MethodInfo, MixinReference, OptionMemberInfo, ParsedSfc, PropInfo, ProvideInfo, RefMethodAccess, ScriptIndex, SlotInfo, SourceLocation, TemplateIndex, TemplateComponentUsage, TextSpan, UsageInfo, VueFileIndex, Vue3PropTypeInfo, Vue3PropUsage, VueMajorVersion } from './types'
import { isComposableImport, resolveComposableImport } from './composableParser'
import { parseCommandComponentModule, parseCommandComponentUsages, type CommandComponentModule, type CommandComponentUsage } from './commandComponentParser'
import { parseEventBusRegistrations, parseStaticImportSources } from './eventBusParser'
import { resolveExternalRefComponent } from './externalComponentResolver'
import { parseGlobalComponents } from './globalComponentParser'
import { resolveImportPathWithExtensions, resolveProjectPathWithExtensions } from './relationResolver'
import { parseSfc } from './sfcParser'
import { parseScript } from './scriptParser'
import { Vue2Runtime, emptyScriptIndex, findRefMethodCalls, mixinLikeReferences } from './vue2Runtime'
import { Vue3LanguageCoreRuntime } from './vue3LanguageCoreRuntime'
import type { VueRuntimeEngine } from './vueRuntime'
import { createLineStarts, positionToOffset } from '../utils/position'
import { matchesName, toCamelCase, toKebabCase } from '../utils/casing'
import { maskStringsAndComments, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

export type { IndexCancellationToken } from './types'

type EventBusEntryConfig = string | readonly string[]
type TrackedUsageMap = Map<string, UsageInfo[]>

type SourceRelationMap<T extends { file: VueFileIndex }> = Map<string, T[]>

const MAX_INITIAL_SCRIPT_SCAN_BYTES = 1_000_000

interface ScriptComponentUsageFile {
  file: VueFileIndex
  usages: Array<{ childUri: string, span: TextSpan }>
  commandUsages: CommandComponentUsage[]
}

interface ScriptComponentUsageImport {
  localName: string
  childUri: string
  importStart: number
  importEnd: number
  importSourceSpan: TextSpan
  spans: TextSpan[]
}

interface ForwardedUsageSeed {
  targetUri: string
  name: string
  usage: UsageInfo
}

interface RelationshipIndexResult {
  children: Set<string>
  propSeeds: ForwardedUsageSeed[]
  eventSeeds: ForwardedUsageSeed[]
}

interface RelationshipTopology {
  children: Set<string>
  forwardedPropChildren: Set<string>
  forwardedEventChildren: Set<string>
  declaredProps: Set<string>
  declaredEvents: Set<string>
  provideKeys: string[]
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>, cloneValue: (value: V) => V = (value) => value): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, cloneValue(value))
  }
}

function cloneArray<T>(items: T[]): T[] {
  return [...items]
}

function cloneStringSet(items: Set<string>): Set<string> {
  return new Set(items)
}

function cloneScriptComponentUsageFile(usageFile: ScriptComponentUsageFile): ScriptComponentUsageFile {
  return {
    file: usageFile.file,
    usages: [...usageFile.usages],
    commandUsages: [...usageFile.commandUsages],
  }
}

function cloneCommandComponentModule(module: CommandComponentModule | undefined): CommandComponentModule | undefined {
  return module ? {
    ...module,
    componentUris: [...module.componentUris],
    anchorSpan: { ...module.anchorSpan },
    methods: module.methods.map((method) => ({ ...method, span: { ...method.span } })),
  } : undefined
}

function cloneWeakSetTracking(files: VueFileIndex[], source: WeakMap<VueFileIndex, Set<string>>): WeakMap<VueFileIndex, Set<string>> {
  const cloned = new WeakMap<VueFileIndex, Set<string>>()
  for (const file of files) {
    const keys = source.get(file)
    if (keys?.size) {
      cloned.set(file, new Set(keys))
    }
  }
  return cloned
}

function cloneUsageTracking(
  files: VueFileIndex[],
  source: WeakMap<VueFileIndex, Map<TrackedUsageMap, Set<string>>>,
  mapRemap: Map<TrackedUsageMap, TrackedUsageMap>,
): WeakMap<VueFileIndex, Map<TrackedUsageMap, Set<string>>> {
  const cloned = new WeakMap<VueFileIndex, Map<TrackedUsageMap, Set<string>>>()
  for (const file of files) {
    const usageMaps = source.get(file)
    if (!usageMaps) {
      continue
    }

    const clonedUsageMaps = new Map<TrackedUsageMap, Set<string>>()
    for (const [sourceMap, keys] of usageMaps) {
      const targetMap = mapRemap.get(sourceMap)
      if (!targetMap || keys.size === 0) {
        continue
      }
      clonedUsageMaps.set(targetMap, new Set(keys))
    }

    if (clonedUsageMaps.size > 0) {
      cloned.set(file, clonedUsageMaps)
    }
  }
  return cloned
}

export class WorkspaceIndex {
  private readonly files = new Map<string, VueFileIndex>()
  private readonly optionMemberByFile = new WeakMap<VueFileIndex, Map<string, OptionMemberInfo>>()
  private readonly workspaceRoots: string[] = []
  private readonly workspaceVueVersions = new Map<string, VueMajorVersion>()
  private readonly eventBusEntriesByRoot = new Map<string, string[]>()
  private readonly externalRefComponents = new Map<string, VueFileIndex | undefined>()
  private readonly externalRefComponentUris = new Map<string, VueFileIndex>()
  private readonly globalComponents = new Map<string, GlobalComponentRegistration[]>()
  private readonly globalComponentRegistrations = new Map<string, GlobalComponentRegistration[]>()
  private readonly eventBusRegistrations = new Map<string, EventBusRegistration[]>()
  private readonly propUsages = new Map<string, UsageInfo[]>()
  private readonly componentUsages = new Map<string, UsageInfo[]>()
  private readonly commandComponentUsages = new Map<string, UsageInfo[]>()
  private readonly commandComponentMethodUsages = new Map<string, UsageInfo[]>()
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
  private readonly sourceMixinConsumers: SourceRelationMap<{ file: VueFileIndex, mixin: MixinReference }> = new Map()
  private readonly sourceRelationFiles = new Map<string, Set<string>>()
  private readonly vue3ScriptImportConsumers = new Map<string, Set<string>>()
  private readonly parentComponents = new Map<string, Set<string>>()
  private readonly scriptComponentUsageFiles = new Map<string, ScriptComponentUsageFile>()
  private readonly commandComponentModules = new Map<string, CommandComponentModule | undefined>()
  private readonly vue2Runtime = new Vue2Runtime({
    workspaceRoots: () => this.workspaceRoots,
    eventBusNames: () => this.getEventBusNames(),
    globalComponents: () => this.getGlobalComponents(),
    indexFile: (uri) => this.indexFile(uri),
    indexGlobalComponentFile: (uri, rebuildScriptUsages) => this.indexGlobalComponentFile(uri, rebuildScriptUsages),
    refreshEventBusRegistrations: (root, token) => this.refreshEventBusRegistrations(root, token).then(() => undefined),
    isInsideWorkspace: (uri) => this.isInsideWorkspace(uri),
    getIndexedContent: (uri) => this.files.get(uri)?.content,
    withBulkIndexing: async (task) => {
      this.isBulkIndexing = true
      try {
        await task()
      } finally {
        this.isBulkIndexing = false
        this.rebuildReverseIndexes(2)
      }
    },
  })
  private readonly vue3Runtime = new Vue3LanguageCoreRuntime({
    workspaceRoots: () => this.workspaceRoots,
    indexFile: (uri) => this.indexFile(uri),
    indexContent: (uri, content) => this.indexContent(uri, content),
    indexScriptComponentUsageContent: (uri, content, rebuild) => this.indexScriptComponentUsageContent(uri, content, rebuild),
    withBulkIndexing: async (task) => {
      this.isBulkIndexing = true
      try {
        await task()
      } finally {
        this.isBulkIndexing = false
        this.rebuildReverseIndexes(3)
      }
    },
  })
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
    this.eventBusRegistrations.clear()
    this.scriptComponentUsageFiles.clear()
    this.commandComponentModules.clear()
    this.vue2Runtime.clear()
    this.vue3Runtime.clear()
    this.clearReverseIndexes()
  }

  replaceWith(other: WorkspaceIndex): void {
    if (other === this) {
      return
    }

    replaceMap(this.files, other.files)
    this.workspaceRoots.length = 0
    this.workspaceRoots.push(...other.workspaceRoots)
    replaceMap(this.workspaceVueVersions, other.workspaceVueVersions)
    replaceMap(this.eventBusEntriesByRoot, other.eventBusEntriesByRoot, cloneArray)
    replaceMap(this.externalRefComponents, other.externalRefComponents)
    replaceMap(this.externalRefComponentUris, other.externalRefComponentUris)
    replaceMap(this.globalComponents, other.globalComponents, cloneArray)
    replaceMap(this.globalComponentRegistrations, other.globalComponentRegistrations, cloneArray)
    replaceMap(this.eventBusRegistrations, other.eventBusRegistrations, cloneArray)
    replaceMap(this.scriptComponentUsageFiles, other.scriptComponentUsageFiles, cloneScriptComponentUsageFile)
    replaceMap(this.commandComponentModules, other.commandComponentModules, cloneCommandComponentModule)
    this.vue2Runtime.replaceWith(other.vue2Runtime)
    this.vue3Runtime.replaceWith(other.vue3Runtime)
    this.replaceReverseIndexesWith(other)
    this.isBulkIndexing = false
  }

  getWorkspaceRoots(): string[] {
    return [...this.workspaceRoots]
  }

  getWorkspaceVueVersionForUri(uri: string): VueMajorVersion | undefined {
    const root = this.workspaceRootFor(uri)
    return root ? this.workspaceVueVersions.get(root) : undefined
  }

  isInsideIndexedWorkspace(uri: string): boolean {
    return this.workspaceRootFor(uri) !== undefined
  }

  hasIndexedDocumentContext(uri: string): boolean {
    return Boolean(this.getIndexedDocumentFile(uri))
      || this.hasSourceRelations(uri)
      || this.hasVue3Source(uri)
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
    const previous = this.workspaceVueVersions.get(root)
    if (previous !== undefined && previous !== version) {
      this.clearWorkspaceRoot(root)
    }
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

  getIndexedDocumentFile(uri: string): VueFileIndex | undefined {
    return this.getFile(uri) ?? this.scriptComponentUsageFiles.get(uri)?.file
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
    const targetUri = findRegisteredComponentInFile(parent, tag)
      ?? (parent.vueVersion === 2 ? this.resolveGlobalComponent(tag, parent.uri) : undefined)
    return targetUri && this.isSameVueVersionRelation(parent, targetUri) ? targetUri : undefined
  }

  resolveTemplateComponentUris(parent: VueFileIndex, component: TemplateComponentUsage): string[] {
    if (component.dynamicTags?.length) {
      return uniqueStrings(component.dynamicTags
        .map((tag) => this.resolveComponent(parent, tag))
        .filter((uri): uri is string => Boolean(uri)))
    }
    return uniqueStrings([this.resolveComponent(parent, component.tag)].filter((uri): uri is string => Boolean(uri)))
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
    const previousTopology = previous ? this.relationshipTopology(previous) : emptyRelationshipTopology()
    const affectedInjectConsumerUris = previous ? this.injectConsumerUris(previous) : []
    const vue2MixinConsumerUris = this.vue2Runtime.getMixinConsumerUris(uri)
    const vue3SourceConsumerUris = this.vue3SourceConsumerUris(uri)
    const hasDependentConsumers = vue2MixinConsumerUris.some((consumerUri) => consumerUri !== uri && this.files.get(consumerUri)?.vueVersion === 2)
      || vue3SourceConsumerUris.some((consumerUri) => this.files.get(consumerUri)?.vueVersion === 3)
    this.vue2Runtime.clearMixinCacheForFile(uri)
    if (previous) {
      this.removeReverseIndex(previous)
    }

    const sfc = this.parseIndexableContent(uri, content)
    const vueVersion = this.vueVersionForUri(uri, sfc)
    if (vueVersion === 3 || previous?.vueVersion === 3 || vue3SourceConsumerUris.length > 0) {
      this.vue3Runtime.invalidate(uri)
    }
    const file = this.runtimeFor(vueVersion).indexContent(uri, sfc)
    this.files.set(uri, file)
    if (vueVersion === 3 && vue3SourceConsumerUris.length > 0) {
      // 外部消费者必须读取本次同步内容，不能回退到磁盘上的旧版本。
      this.vue3Runtime.syncSourceContent(uri, content)
    }
    const scriptUsageFile = this.scriptComponentUsageFiles.get(uri)
    if (vueVersion === 3 && scriptUsageFile && scriptUsageFile.file !== file) {
      // standalone 脚本已经拥有完整索引时复用同一个文件对象，避免常驻两套源码与行号数据。
      this.removeTrackedFileUsages(scriptUsageFile.file)
      scriptUsageFile.file = file
    }
    if (this.isBulkIndexing) {
      return file
    }

    this.addSourceRelations(file)
    this.addVue3ScriptImportConsumers(file)
    this.addProvideDefinitions(file)
    const relationships = this.addRelationshipUsages(file)
    this.addEventBusUsages(file)
    this.addInjectUsages(file)
    const currentTopology = this.relationshipTopology(file)
    const topologyChanged = relationshipTopologyChanged(previousTopology, currentTopology)
    if (topologyChanged && !hasDependentConsumers) {
      this.rebuildReverseIndexes(file.vueVersion)
    } else if (!topologyChanged) {
      this.addForwardedAttrPropUsages(relationships.propSeeds)
      this.addForwardedAttrEventUsages(relationships.eventSeeds)
      this.refreshInjectUsages(affectedInjectConsumerUris)
    }
    if (vue2MixinConsumerUris.length > 0) {
      this.rebuildVue2MixinConsumers(uri, vue2MixinConsumerUris)
    }
    if (vue3SourceConsumerUris.length > 0) {
      this.rebuildVue3SourceConsumers(vue3SourceConsumerUris)
    }
    return file
  }

  private parseIndexableContent(uri: string, content: string): ParsedSfc {
    if (!isScriptFile(uri) || uri.endsWith('.vue')) {
      try {
        return parseSfc(uri, content)
      } catch {
        return {
          uri,
          fileName: path.basename(uri),
          content,
          lineStarts: createLineStarts(content),
        }
      }
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
    const vue2MixinConsumerUris = this.vue2Runtime.getMixinConsumerUris(uri)
    const vue3SourceConsumerUris = this.vue3SourceConsumerUris(uri)
    const hasVue2MixinConsumers = vue2MixinConsumerUris.some((consumerUri) => consumerUri !== uri && this.files.get(consumerUri)?.vueVersion === 2)
    const hasVue3SourceConsumers = vue3SourceConsumerUris.some((consumerUri) => this.files.get(consumerUri)?.vueVersion === 3)
    if (vue3SourceConsumerUris.length > 0 || this.files.get(uri)?.vueVersion === 3) {
      this.vue3Runtime.invalidate(uri)
    }
    this.vue2Runtime.clearMixinCacheForFile(uri)
    this.vue2Runtime.removeConsumer(uri)
    const file = this.files.get(uri)
    const requiresReverseIndexRebuild = (file?.templateIndex.components.length ?? 0) > 0
      || (file?.scriptIndex.provides.length ?? 0) > 0
    if (file) {
      this.removeReverseIndex(file)
      this.files.delete(uri)
      this.parentComponents.delete(uri)
    }
    if (hasVue2MixinConsumers) {
      this.rebuildVue2MixinConsumers(uri, vue2MixinConsumerUris)
    }
    if (hasVue3SourceConsumers) {
      this.rebuildVue3SourceConsumers(vue3SourceConsumerUris)
    }
    if (requiresReverseIndexRebuild && !hasVue2MixinConsumers && !hasVue3SourceConsumers) {
      this.rebuildReverseIndexes(file?.vueVersion)
    }
  }

  async indexFile(uri: string): Promise<VueFileIndex> {
    return this.indexContent(uri, await fs.readFile(uri, 'utf8'))
  }

  async indexWorkspace(root: string, token?: IndexCancellationToken, eventBusEntries?: EventBusEntryConfig, vueVersion: VueMajorVersion = 2, excludedRoots: string[] = []): Promise<void> {
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
    }, token, excludedRoots)
    if (token?.isCancellationRequested) {
      return
    }

    await this.runtimeFor(vueVersion).indexWorkspace(root, vueFiles, scriptFiles, token)
  }

  private runtimeFor(version: VueMajorVersion): VueRuntimeEngine {
    return version === 2 ? this.vue2Runtime : this.vue3Runtime
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
  }

  async syncGlobalComponentFile(uri: string): Promise<void> {
    const content = await readTextIfExists(uri)
    if (content !== undefined) {
      await this.syncGlobalComponentContent(uri, content)
      return
    }

    if (this.vueVersionForUri(uri) === 3) {
      this.removeScriptComponentUsageFile(uri)
      this.remove(uri)
    }
  }

  async syncGlobalComponentContent(uri: string, content: string): Promise<void> {
    const vueVersion = this.vueVersionForUri(uri)
    const hasVue3ImportConsumers = vueVersion === 3 && this.vue3ScriptImportConsumers.has(uri)
    this.syncScriptComponentUsageContent(uri, content, vueVersion === 3 ? !hasVue3ImportConsumers : true)

    if (vueVersion === 3) {
      if (this.vue3Runtime.shouldIndexScriptContent(content)) {
        this.syncContent(uri, content)
        return
      }
      if (this.files.has(uri)) {
        this.remove(uri)
        return
      }

      const consumerUris = this.vue3SourceConsumerUris(uri)
      if (consumerUris.length > 0 && this.vue3Runtime.syncSourceContent(uri, content)) {
        this.rebuildVue3SourceConsumers(consumerUris)
      }
      return
    }

    const mixinConsumerUris = this.vue2Runtime.getMixinConsumerUris(uri)
    const beforeGlobals = this.globalComponentsSignature()
    const beforeEventBusNames = this.eventBusNamesSignature()
    this.vue2Runtime.clearMixinCacheForFile(uri)
    await this.indexGlobalComponentContent(uri, content)
    await this.refreshEventBusRegistrations()
    const eventBusChanged = beforeEventBusNames !== this.eventBusNamesSignature()
    if (eventBusChanged || beforeGlobals !== this.globalComponentsSignature()) {
      this.rebuildIndexedFilesByVersion(2)
    } else if (mixinConsumerUris.length > 0) {
      this.rebuildVue2MixinConsumers(uri, mixinConsumerUris)
    }
  }

  async removeGlobalComponentFile(uri: string): Promise<void> {
    const version = this.vueVersionForUri(uri)
    const wasCommandModule = Boolean(this.resolveCommandComponentModule(uri))
    this.removeScriptComponentUsageFile(uri)
    if (version === 3) {
      this.vue3Runtime.invalidate(uri)
      this.remove(uri)
      if (wasCommandModule) this.rebuildReverseIndexes(version)
      return
    }
    const mixinConsumerUris = this.vue2Runtime.getMixinConsumerUris(uri)
    const beforeGlobals = this.globalComponentsSignature()
    const beforeEventBusNames = this.eventBusNamesSignature()
    this.vue2Runtime.clearMixinCacheForFile(uri)
    this.removeGlobalRegistrationsFromFile(uri)
    await this.refreshEventBusRegistrations()
    const eventBusChanged = beforeEventBusNames !== this.eventBusNamesSignature()
    if (eventBusChanged || beforeGlobals !== this.globalComponentsSignature()) {
      this.rebuildIndexedFilesByVersion(2)
    } else if (mixinConsumerUris.length > 0) {
      this.rebuildVue2MixinConsumers(uri, mixinConsumerUris)
    } else if (wasCommandModule) {
      this.rebuildReverseIndexes(version)
    }
  }

  async refreshGlobalComponentsFromVueFiles(): Promise<void> {
    if (!this.hasVueNameBasedGlobals()) {
      return
    }

    await this.refreshImportedNameGlobalComponents()
    this.rebuildIndexedFilesByVersion(2)
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

  getCommandComponentModule(uri: string): CommandComponentModule | undefined {
    return this.resolveCommandComponentModule(uri)
  }

  findCommandComponentUsages(commandUri: string): UsageInfo[] {
    return dedupeUsages(this.commandComponentUsages.get(commandUri) ?? [])
  }

  findCommandComponentMethodUsages(commandUri: string, methodName: string): UsageInfo[] {
    return dedupeUsages(this.commandComponentMethodUsages.get(usageKey(commandUri, methodName)) ?? [])
  }

  findCommandComponentMethodAtOffset(uri: string, offset: number) {
    const module = this.resolveCommandComponentModule(uri)
    const method = module?.methods.find((item) => offset >= item.span.start && offset <= item.span.end)
    return module && method ? { module, method } : undefined
  }

  syncScriptComponentUsageContent(uri: string, content: string, rebuild = true): void {
    if (this.scriptComponentUsageFiles.get(uri)?.file.content === content) {
      return
    }
    this.indexScriptComponentUsageContent(uri, content, rebuild)
  }

  findEventDefinitions(childUri: string, eventName: string): Array<{ file: VueFileIndex, emit: EmitInfo }> {
    return dedupeEventDefinitions(this.findEventDefinitionsRecursive(childUri, eventName, new Set<string>()))
  }

  findPropDefinitions(childUri: string, propName: string): Array<{ file: VueFileIndex, prop: PropInfo }> {
    return dedupePropDefinitions(this.findPropDefinitionsRecursive(childUri, propName, new Set<string>()))
  }

  findPropCompletionDefinitions(childUri: string): Array<{ file: VueFileIndex, prop: PropInfo }> {
    return dedupePropDefinitions(this.findPropCompletionDefinitionsRecursive(childUri, new Set<string>()))
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

    while (current.length > 0) {
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
    return this.vue2Runtime.hasMixinSource(uri)
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
    return [...(this.sourceRelationFiles.get(uri) ?? [])]
      .some((consumerUri) => this.files.get(consumerUri)?.vueVersion === 3)
      || this.vue3ScriptImportConsumers.has(uri)
  }

  hasSourceRelations(uri: string): boolean {
    return this.hasMixinSource(uri) || this.sourceRelationFiles.has(uri)
  }

  private vue3SourceConsumerUris(sourceUri: string): string[] {
    return [...new Set([
      ...(this.sourceRelationFiles.get(sourceUri) ?? []),
      ...(this.vue3ScriptImportConsumers.get(sourceUri) ?? []),
    ])]
      .filter((uri) => uri !== sourceUri)
      .filter((uri) => this.files.get(uri)?.vueVersion === 3)
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

  findMixinConsumersFromSource(sourceUri: string, offset: number): UsageInfo[] {
    return dedupeUsages((this.sourceMixinConsumers.get(sourceUri) ?? [])
      .filter(({ mixin }) => containsSourceOffset(mixin.sourceLocation, sourceUri, offset))
      .map(({ file, mixin }) => ({ file, span: mixin.span })))
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

  findTemplateInstanceMemberAtOffset(file: VueFileIndex, offset: number): { name: string, span: TextSpan, member: OptionMemberInfo } | undefined {
    const usage = this.findTemplateInstanceUsageAtOffset(file, offset)
    if (!usage) {
      return undefined
    }

    const member = this.findOptionMember(file, usage.name)
    return member ? { ...usage, member } : undefined
  }

  findOptionMember(file: VueFileIndex, name: string): OptionMemberInfo | undefined {
    let optionMembers = this.optionMemberByFile.get(file)
    if (!optionMembers) {
      optionMembers = new Map()
      for (const member of file.scriptIndex.optionMembers) {
        if (!optionMembers.has(member.name)) {
          optionMembers.set(member.name, member)
        }
      }
      this.optionMemberByFile.set(file, optionMembers)
    }
    return optionMembers.get(name)
  }

  private findTemplateInstanceUsageAtOffset(file: VueFileIndex, offset: number): TemplateIndex['instanceMembers'][number] | undefined {
    const members = file.templateIndex.instanceMembers
    let low = 0
    let high = members.length - 1

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const member = members[mid]
      if (offset < member.span.start) {
        high = mid - 1
        continue
      }
      if (offset >= member.span.end) {
        low = mid + 1
        continue
      }
      return member
    }

    return undefined
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
    while (current.length > 0) {
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

    while (current.length > 0) {
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

  private clearReverseIndexes(): void {
    this.propUsages.clear()
    this.componentUsages.clear()
    this.commandComponentUsages.clear()
    this.commandComponentMethodUsages.clear()
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
    this.sourceMixinConsumers.clear()
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

  private replaceReverseIndexesWith(other: WorkspaceIndex): void {
    replaceMap(this.propUsages, other.propUsages, cloneArray)
    replaceMap(this.componentUsages, other.componentUsages, cloneArray)
    replaceMap(this.commandComponentUsages, other.commandComponentUsages, cloneArray)
    replaceMap(this.commandComponentMethodUsages, other.commandComponentMethodUsages, cloneArray)
    replaceMap(this.eventUsages, other.eventUsages, cloneArray)
    replaceMap(this.slotUsages, other.slotUsages, cloneArray)
    replaceMap(this.eventBusEmits, other.eventBusEmits, cloneArray)
    replaceMap(this.eventBusListeners, other.eventBusListeners, cloneArray)
    replaceMap(this.eventBusEventNames, other.eventBusEventNames, cloneStringSet)
    replaceMap(this.refMethodUsages, other.refMethodUsages, cloneArray)
    replaceMap(this.refMethodForwards, other.refMethodForwards, cloneArray)
    replaceMap(this.vue3PropInternalUsages, other.vue3PropInternalUsages, cloneArray)
    replaceMap(this.provideDefinitions, other.provideDefinitions, cloneArray)
    replaceMap(this.injectUsages, other.injectUsages, cloneArray)
    replaceMap(this.sourceProps, other.sourceProps, cloneArray)
    replaceMap(this.sourcePropTypes, other.sourcePropTypes, cloneArray)
    replaceMap(this.sourceMethods, other.sourceMethods, cloneArray)
    replaceMap(this.sourceEmits, other.sourceEmits, cloneArray)
    replaceMap(this.sourceSlots, other.sourceSlots, cloneArray)
    replaceMap(this.sourceEventBusCalls, other.sourceEventBusCalls, cloneArray)
    replaceMap(this.sourceProvides, other.sourceProvides, cloneArray)
    replaceMap(this.sourceInjects, other.sourceInjects, cloneArray)
    replaceMap(this.sourceRefMethodCalls, other.sourceRefMethodCalls, cloneArray)
    replaceMap(this.sourceComposableReturnUsages, other.sourceComposableReturnUsages, cloneArray)
    replaceMap(this.sourceMixinConsumers, other.sourceMixinConsumers, cloneArray)
    replaceMap(this.sourceRelationFiles, other.sourceRelationFiles, cloneStringSet)
    replaceMap(this.vue3ScriptImportConsumers, other.vue3ScriptImportConsumers, cloneStringSet)
    replaceMap(this.parentComponents, other.parentComponents, cloneStringSet)

    const trackedUsageMapRemap = new Map<TrackedUsageMap, TrackedUsageMap>([
      [other.propUsages as TrackedUsageMap, this.propUsages as TrackedUsageMap],
      [other.componentUsages as TrackedUsageMap, this.componentUsages as TrackedUsageMap],
      [other.commandComponentUsages as TrackedUsageMap, this.commandComponentUsages as TrackedUsageMap],
      [other.commandComponentMethodUsages as TrackedUsageMap, this.commandComponentMethodUsages as TrackedUsageMap],
      [other.eventUsages as TrackedUsageMap, this.eventUsages as TrackedUsageMap],
      [other.slotUsages as TrackedUsageMap, this.slotUsages as TrackedUsageMap],
      [other.eventBusEmits as TrackedUsageMap, this.eventBusEmits as TrackedUsageMap],
      [other.eventBusListeners as TrackedUsageMap, this.eventBusListeners as TrackedUsageMap],
      [other.refMethodUsages as TrackedUsageMap, this.refMethodUsages as TrackedUsageMap],
      [other.vue3PropInternalUsages as TrackedUsageMap, this.vue3PropInternalUsages as TrackedUsageMap],
      [other.provideDefinitions as TrackedUsageMap, this.provideDefinitions as TrackedUsageMap],
      [other.injectUsages as TrackedUsageMap, this.injectUsages as TrackedUsageMap],
    ])
    const trackedFiles = this.reverseIndexTrackingFiles()
    this.usageKeysByFile = cloneUsageTracking(trackedFiles, other.usageKeysByFile, trackedUsageMapRemap)
    this.refMethodForwardKeysByFile = cloneWeakSetTracking(trackedFiles, other.refMethodForwardKeysByFile)
    this.sourceKeysByFile = cloneWeakSetTracking(trackedFiles, other.sourceKeysByFile)
    this.scriptImportKeysByFile = cloneWeakSetTracking(trackedFiles, other.scriptImportKeysByFile)
    this.injectUsageKeysByProvider = cloneWeakSetTracking(trackedFiles, other.injectUsageKeysByProvider)
    this.parentLinksByFile = cloneWeakSetTracking(trackedFiles, other.parentLinksByFile)
  }

  private reverseIndexTrackingFiles(): VueFileIndex[] {
    return [...new Set([
      ...this.files.values(),
      ...[...this.scriptComponentUsageFiles.values()].map((usageFile) => usageFile.file),
    ])]
  }

  private indexScriptComponentUsageContent(uri: string, content: string, rebuild = true): void {
    this.removeScriptComponentUsageFile(uri)
    this.commandComponentModules.delete(uri)
    const commandModule = parseCommandComponentModule(uri, content, this.workspaceRoots)
    this.commandComponentModules.set(uri, commandModule)
    const commandComponentUris = new Set(commandModule?.componentUris ?? [])
    const usages = parseScriptComponentUsages(uri, content, this.workspaceRoots)
      .filter((usage) => this.isInsideWorkspace(usage.childUri) && !isInsideNodeModules(usage.childUri))
      .filter((usage) => this.isSameVueVersionUri(uri, usage.childUri))
      .filter((usage) => !commandComponentUris.has(usage.childUri))
    const commandUsages = this.parseCommandUsages(uri, content)
    if (usages.length === 0 && commandUsages.length === 0 && !commandModule) {
      return
    }

    this.scriptComponentUsageFiles.set(uri, {
      file: scriptUsageFile(uri, content, this.vueVersionForUri(uri)),
      usages,
      commandUsages,
    })
    if (rebuild && !this.isBulkIndexing) {
      this.rebuildReverseIndexes(this.vueVersionForUri(uri))
    }
  }

  private removeScriptComponentUsageFile(uri: string): void {
    this.commandComponentModules.delete(uri)
    const usageFile = this.scriptComponentUsageFiles.get(uri)
    if (!usageFile) {
      return
    }
    this.removeTrackedFileUsages(usageFile.file)
    this.scriptComponentUsageFiles.delete(uri)
  }

  private addScriptComponentUsages(version?: VueMajorVersion): void {
    for (const usageFile of this.scriptComponentUsageFiles.values()) {
      if (version !== undefined && usageFile.file.vueVersion !== version) {
        continue
      }
      for (const usage of usageFile.usages) {
        this.addUsage(this.componentUsages, usage.childUri, { file: usageFile.file, span: usage.span })
      }
      // 已作为 Vue 3 standalone 文件建模时，command 关系会由 addRelationshipUsages 写入。
      if (!this.files.has(usageFile.file.uri)) {
        this.addCommandComponentUsageRelations(usageFile.file, usageFile.commandUsages)
      }
    }
  }

  private addCommandComponentUsageRelations(file: VueFileIndex, usages: CommandComponentUsage[]): void {
    for (const usage of usages) {
      const usageInfo = { file, span: usage.span }
      this.addUsage(this.commandComponentUsages, usage.commandUri, usageInfo)
      this.addUsage(this.commandComponentMethodUsages, usageKey(usage.commandUri, usage.methodName), usageInfo)
      for (const componentUri of usage.componentUris) {
        this.addUsage(this.componentUsages, componentUri, usageInfo)
      }
    }
  }

  private parseCommandUsages(uri: string, content: string): CommandComponentUsage[] {
    return parseCommandComponentUsages(uri, content, this.workspaceRoots, (commandUri) => this.resolveCommandComponentModule(commandUri))
      .filter((usage) => usage.componentUris.every((componentUri) => this.isSameVueVersionUri(uri, componentUri)))
  }

  private resolveCommandComponentModule(uri: string): CommandComponentModule | undefined {
    if (this.commandComponentModules.has(uri)) {
      return this.commandComponentModules.get(uri)
    }
    if (!this.isInsideWorkspace(uri) || isInsideNodeModules(uri)) {
      this.commandComponentModules.set(uri, undefined)
      return undefined
    }
    try {
      const module = parseCommandComponentModule(uri, fsSync.readFileSync(uri, 'utf8'), this.workspaceRoots)
      const valid = module && module.componentUris.every((componentUri) => this.isSameVueVersionUri(uri, componentUri))
        ? module
        : undefined
      this.commandComponentModules.set(uri, valid)
      return valid
    } catch {
      this.commandComponentModules.set(uri, undefined)
      return undefined
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
    for (const mixin of mixinLikeReferences(file.scriptIndex)) {
      const sourceLocation = this.vue2Runtime.resolveMixinSourceLocation(mixin)
      if (sourceLocation) {
        this.addSourceRelation(this.sourceMixinConsumers, sourceLocation, { file, mixin: { ...mixin, sourceLocation } })
      }
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

  private injectConsumerUris(provider: VueFileIndex): string[] {
    const consumerUris = new Set<string>()
    for (const key of this.injectUsageKeysByProvider.get(provider) ?? []) {
      for (const usage of this.injectUsages.get(key) ?? []) {
        consumerUris.add(usage.file.uri)
      }
    }
    return [...consumerUris]
  }

  private refreshInjectUsages(consumerUris: string[]): void {
    for (const uri of consumerUris) {
      const consumer = this.files.get(uri)
      if (!consumer) {
        continue
      }
      this.removeTrackedFileUsagesFromMap(consumer, this.injectUsages)
      this.addInjectUsages(consumer)
    }
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
        if (map === this.injectUsages && !map.has(key)) {
          this.removeInjectProviderTracking(key)
        }
      }
    }
    this.usageKeysByFile.delete(file)
  }

  private removeTrackedFileUsagesFromMap<T extends UsageInfo>(file: VueFileIndex, map: Map<string, T[]>): void {
    const usageMaps = this.usageKeysByFile.get(file)
    const trackedMap = map as unknown as TrackedUsageMap
    const keys = usageMaps?.get(trackedMap)
    if (!keys) {
      return
    }

    for (const key of keys) {
      removeFileUsageAtKey(map, key, file)
      if (map === this.injectUsages && !map.has(key)) {
        this.removeInjectProviderTracking(key)
      }
    }
    usageMaps?.delete(trackedMap)
    if (usageMaps?.size === 0) {
      this.usageKeysByFile.delete(file)
    }
  }

  private removeInjectProviderTracking(key: string): void {
    const separator = key.lastIndexOf('\0')
    const provider = separator === -1 ? undefined : this.files.get(key.slice(0, separator))
    const providerKeys = provider ? this.injectUsageKeysByProvider.get(provider) : undefined
    providerKeys?.delete(key)
    if (provider && providerKeys?.size === 0) {
      this.injectUsageKeysByProvider.delete(provider)
    }
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
      removeSourceRelationItem(this.sourceMixinConsumers, key, file)

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

  private addRelationshipUsages(file: VueFileIndex): RelationshipIndexResult {
    const result: RelationshipIndexResult = {
      children: new Set<string>(),
      propSeeds: [],
      eventSeeds: [],
    }
    for (const component of file.templateIndex.components) {
      const childUris = this.resolveTemplateComponentUris(file, component)
      if (childUris.length === 0) {
        continue
      }
      for (const childUri of childUris) {
        this.addParentLink(file, childUri)
        this.addUsage(this.componentUsages, childUri, { file, span: component.span })
        result.children.add(childUri)
      }

      for (const attr of component.attrs) {
        const usage = { file, span: attr.span }
        for (const childUri of childUris) {
          if (attr.kind === 'prop') {
            this.addUsage(this.propUsages, usageKey(childUri, attr.normalizedName), usage)
            result.propSeeds.push({ targetUri: childUri, name: attr.normalizedName, usage })
          } else if (attr.kind === 'event') {
            this.addUsage(this.eventUsages, usageKey(childUri, attr.normalizedName), usage)
            result.eventSeeds.push({ targetUri: childUri, name: attr.normalizedName, usage })
          }
        }
      }

      for (const bind of component.binds) {
        const resolved = resolveTemplateBindExpression(file, bind.expression)
        const usage = { file, span: bind.span }
        for (const propName of resolved.propNames) {
          for (const childUri of childUris) {
            this.addUsage(this.propUsages, usageKey(childUri, propName), usage)
            result.propSeeds.push({ targetUri: childUri, name: propName, usage })
          }
        }
      }

      for (const on of component.ons ?? []) {
        const resolved = resolveTemplateOnExpression(file, on.expression)
        const usage = { file, span: on.span }
        for (const eventName of resolved.eventNames) {
          for (const childUri of childUris) {
            this.addUsage(this.eventUsages, usageKey(childUri, eventName), usage)
            result.eventSeeds.push({ targetUri: childUri, name: eventName, usage })
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

    this.addCommandComponentUsageRelations(file, this.parseCommandUsages(file.uri, file.content))

    return result
  }

  private addForwardedAttrEventUsages(seeds: ForwardedUsageSeed[]): void {
    // 只沿新增 usage 做广度传播；addUsageIfMissing 同时负责去重和终止循环透传。
    const queue = [...seeds]
    for (let index = 0; index < queue.length; index += 1) {
      const seed = queue[index]
      const wrapper = this.files.get(seed.targetUri)
      if (!wrapper || wrapper.vueVersion !== seed.usage.file.vueVersion) {
        continue
      }
      if (wrapper.vueVersion === 3 && hasDeclaredEmit(wrapper, seed.name)) {
        continue
      }

      for (const component of wrapper.templateIndex.components) {
        if (!componentForwardsListeners(wrapper, component)) {
          continue
        }
        for (const childUri of this.resolveTemplateComponentUris(wrapper, component)) {
          if (this.addUsageIfMissing(this.eventUsages, usageKey(childUri, seed.name), seed.usage)) {
            queue.push({ ...seed, targetUri: childUri })
          }
        }
      }
    }
  }

  private addForwardedAttrPropUsages(seeds: ForwardedUsageSeed[]): void {
    // usage.file 始终保留最外层来源文件，来源重建时即可一次清掉整条透传链。
    const queue = [...seeds]
    for (let index = 0; index < queue.length; index += 1) {
      const seed = queue[index]
      const wrapper = this.files.get(seed.targetUri)
      if (!wrapper || wrapper.vueVersion !== seed.usage.file.vueVersion || hasDeclaredProp(wrapper, seed.name)) {
        continue
      }

      for (const component of wrapper.templateIndex.components) {
        if (!componentForwardsAttrs(wrapper, component)) {
          continue
        }
        for (const childUri of this.resolveTemplateComponentUris(wrapper, component)) {
          if (this.addUsageIfMissing(this.propUsages, usageKey(childUri, seed.name), seed.usage)) {
            queue.push({ ...seed, targetUri: childUri })
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

  private findPropCompletionDefinitionsRecursive(childUri: string, seen: Set<string>): Array<{ file: VueFileIndex, prop: PropInfo }> {
    if (seen.has(childUri)) {
      return []
    }
    seen.add(childUri)
    const file = this.getFile(childUri)
    if (!file) {
      return []
    }

    const definitions = file.scriptIndex.props.map((prop) => ({ file, prop }))

    for (const component of file.templateIndex.components) {
      if (!componentForwardsAttrs(file, component)) {
        continue
      }
      for (const forwardedChildUri of this.resolveTemplateComponentUris(file, component)) {
        const childDefinitions = this.findPropCompletionDefinitionsRecursive(forwardedChildUri, new Set(seen))
        definitions.push(...childDefinitions.filter(({ prop }) => !hasDeclaredProp(file, prop.name)))
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
    this.globalComponentRegistrations.delete(fileUri)
    this.eventBusRegistrations.delete(fileUri)
  }

  private clearWorkspaceRoot(root: string): void {
    const inRoot = (uri: string): boolean => {
      const owner = this.workspaceRootFor(uri)
      return owner ? owner === root : uri === root || isInsideDirectory(uri, root)
    }

    for (const [uri, file] of [...this.files]) {
      if (!inRoot(uri)) {
        continue
      }
      this.removeReverseIndex(file)
      this.files.delete(uri)
      this.parentComponents.delete(uri)
    }

    for (const uri of [...this.scriptComponentUsageFiles.keys()]) {
      if (inRoot(uri)) {
        this.removeScriptComponentUsageFile(uri)
      }
    }
    for (const uri of [...this.commandComponentModules.keys()]) {
      if (inRoot(uri)) {
        this.commandComponentModules.delete(uri)
      }
    }

    const globalStateFiles = new Set([
      ...this.globalComponentRegistrations.keys(),
      ...this.eventBusRegistrations.keys(),
    ])
    for (const uri of globalStateFiles) {
      if (inRoot(uri)) {
        this.removeGlobalRegistrationsFromFile(uri)
      }
    }

    this.vue2Runtime.clearWorkspaceRoot(inRoot)

    this.clearExternalRefComponentsForRoot(root)
    this.vue3Runtime.clearWorkspaceRoot(inRoot)
  }

  private clearExternalRefComponentsForRoot(root: string): void {
    const prefix = `${root}\0`
    for (const [key, component] of [...this.externalRefComponents]) {
      if (!key.startsWith(prefix)) {
        continue
      }
      this.externalRefComponents.delete(key)
      if (component) {
        this.externalRefComponentUris.delete(component.uri)
      }
    }
  }

  private hasVueNameBasedGlobals(): boolean {
    return this.getGlobalComponents().some((component) => component.usesImportedName)
  }

  private isVueNameSourceFile(uri: string): boolean {
    return this.getGlobalComponents().some((component) => component.usesImportedName && component.targetUri === uri)
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

  private rebuildIndexedFilesByVersion(version: VueMajorVersion): void {
    this.rebuildIndexedFiles((file) => file.vueVersion === version)
  }

  private rebuildIndexedFiles(filter: (file: VueFileIndex) => boolean = () => true): void {
    const indexedFiles = this.getAllFiles()
      .filter(filter)
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
      const version = indexedFiles
        .map((item) => this.files.get(item.uri)?.vueVersion)
        .find((item): item is VueMajorVersion => item !== undefined)
      this.rebuildReverseIndexes(version)
    }
  }

  private rebuildVue2MixinConsumers(sourceUri: string, consumerUris: string[]): void {
    // mixin 内容只影响真实消费它的组件；批量重解析后统一重建一次反向关系。
    const indexedFiles = consumerUris
      .filter((uri) => uri !== sourceUri)
      .map((uri) => this.files.get(uri))
      .filter((file): file is VueFileIndex => file?.vueVersion === 2)
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
      this.rebuildReverseIndexes(2)
    }
  }

  private rebuildVue3SourceConsumers(consumerUris: string[]): void {
    const indexedFiles = consumerUris
      .map((uri) => this.files.get(uri))
      .filter((file): file is VueFileIndex => file?.vueVersion === 3)
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
      this.rebuildReverseIndexes(3)
    }
  }

  private rebuildReverseIndexes(version?: VueMajorVersion): void {
    const files = [...this.files.values()]
      .filter((file) => version === undefined || file.vueVersion === version)
    if (version === undefined) {
      this.clearReverseIndexes()
    } else {
      for (const file of files) {
        this.removeReverseIndex(file)
      }
      for (const usageFile of this.scriptComponentUsageFiles.values()) {
        if (usageFile.file.vueVersion === version) {
          this.removeTrackedFileUsages(usageFile.file)
          usageFile.commandUsages = this.parseCommandUsages(usageFile.file.uri, usageFile.file.content)
        }
      }
    }
    for (const file of files) {
      this.addSourceRelations(file)
      this.addVue3ScriptImportConsumers(file)
      this.addProvideDefinitions(file)
    }
    const propSeeds: ForwardedUsageSeed[] = []
    const eventSeeds: ForwardedUsageSeed[] = []
    for (const file of files) {
      const relationships = this.addRelationshipUsages(file)
      propSeeds.push(...relationships.propSeeds)
      eventSeeds.push(...relationships.eventSeeds)
      this.addEventBusUsages(file)
    }
    this.addScriptComponentUsages(version)
    this.addForwardedAttrPropUsages(propSeeds)
    this.addForwardedAttrEventUsages(eventSeeds)
    for (const file of files) {
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

  /**
   * Vue 2 与 Vue 3 的关系图必须完全隔离。目标文件版本未知时保留原有
   * 单文件测试和未注册 workspace 的行为；一旦双方版本可确定，则必须一致。
   */
  private isSameVueVersionRelation(parent: VueFileIndex, targetUri: string): boolean {
    const sourceVersion = this.getWorkspaceVueVersionForUri(parent.uri)
    const targetVersion = this.files.get(targetUri)?.vueVersion
      ?? this.getWorkspaceVueVersionForUri(targetUri)
    if (sourceVersion !== undefined && targetVersion === undefined) {
      return false
    }
    return targetVersion === undefined || targetVersion === parent.vueVersion
  }

  private isSameVueVersionUri(sourceUri: string, targetUri: string): boolean {
    const sourceVersion = this.files.get(sourceUri)?.vueVersion
      ?? this.getWorkspaceVueVersionForUri(sourceUri)
    const targetVersion = this.files.get(targetUri)?.vueVersion
      ?? this.getWorkspaceVueVersionForUri(targetUri)
    if (sourceVersion !== undefined && targetVersion === undefined) {
      return false
    }
    return sourceVersion === undefined || targetVersion === undefined || sourceVersion === targetVersion
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

  private relationshipTopology(file: VueFileIndex): RelationshipTopology {
    const topology: RelationshipTopology = {
      children: new Set<string>(),
      forwardedPropChildren: new Set<string>(),
      forwardedEventChildren: new Set<string>(),
      declaredProps: new Set(file.scriptIndex.props.map((prop) => toKebabCase(prop.name))),
      declaredEvents: new Set(file.vueVersion === 3 ? file.scriptIndex.emits.map((emit) => toKebabCase(emit.eventName)) : []),
      provideKeys: file.scriptIndex.provides.map((provide) => provide.key).sort(),
    }
    for (const component of file.templateIndex.components) {
      for (const childUri of this.resolveTemplateComponentUris(file, component)) {
        topology.children.add(childUri)
        if (componentForwardsAttrs(file, component)) {
          topology.forwardedPropChildren.add(childUri)
        }
        if (componentForwardsListeners(file, component)) {
          topology.forwardedEventChildren.add(childUri)
        }
      }
    }
    return topology
  }

  private propKeys(childUri: string, propName: string): string[] {
    return usageKeysForName(childUri, propName)
  }

  private eventKeys(childUri: string, eventName: string): string[] {
    return usageKeysForName(childUri, eventName)
  }

  private slotKeys(childUri: string, slotName: string): string[] {
    return usageKeysForName(childUri, slotName)
  }
}

function usageKeysForName(childUri: string, name: string): string[] {
  const kebabName = toKebabCase(name)
  const names = new Set([
    name,
    kebabName,
    toCamelCase(name),
    toCamelCase(kebabName),
  ])
  return [...names].map((item) => usageKey(childUri, item))
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
    content,
    // 轻量 usage 文件不会执行基于 searchableContent 的语义查询，复用源码引用可避免等长副本。
    searchableContent: content,
    lineStarts: createLineStarts(content),
    scriptIndex: emptyScriptIndex(),
    templateIndex: { components: [], emits: [], eventBusCalls: [], slots: [], instanceMembers: [] },
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
    if (isTypeOnlyImportClause(clause)) {
      index = statementEnd - 1
      continue
    }
    const localName = parseDefaultImportName(clause)
    if (localName) {
      imports.push({
        localName,
        childUri,
        importStart: index,
        importEnd: statementEnd,
        importSourceSpan: { start: literal.start, end: literal.end },
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
      usages.push({ childUri: item.childUri, span: item.importSourceSpan })
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

function isTypeOnlyImportClause(clause: string): boolean {
  const normalized = clause.trim()
  if (/^type\b/.test(normalized)) {
    return true
  }

  const named = /^\{\s*([\s\S]*?)\s*\}$/.exec(normalized)
  if (!named) {
    return false
  }

  const parts = named[1].split(',').map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.every((part) => /^type\b/.test(part))
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

async function walkIndexableFiles(root: string, visit: (file: string) => Promise<void>, token?: IndexCancellationToken, excludedRoots: string[] = []): Promise<void> {
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
  const normalizedExcludedRoots = excludedRoots.map((item) => path.resolve(item))

  async function walk(directory: string): Promise<void> {
    if (token?.isCancellationRequested) {
      return
    }

    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (token?.isCancellationRequested) {
        return
      }

      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !isExcludedRoot(fullPath, normalizedExcludedRoots)) {
          await walk(fullPath)
        }
        continue
      }
      if (entry.isFile() && (entry.name.endsWith('.vue') || isScriptFile(entry.name))) {
        if (isScriptFile(entry.name)) {
          let stats: import('node:fs').Stats
          try {
            stats = await fs.stat(fullPath)
          } catch {
            continue
          }
          if (stats.size > MAX_INITIAL_SCRIPT_SCAN_BYTES) {
            continue
          }
        }
        await visit(fullPath)
      }
    }
  }

  await walk(root)
}

function isExcludedRoot(directory: string, excludedRoots: readonly string[]): boolean {
  const normalized = path.resolve(directory)
  return excludedRoots.some((root) => normalized === root)
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

function hasVue3RefMethod(file: VueFileIndex | undefined, methodName: string): boolean {
  return Boolean(file?.scriptIndex.methods.some((method) => method.name === methodName)
    || file?.refMethodCalls.some((call) => call.forwarded && call.methodName === methodName))
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

interface TemplateOnResolution {
  eventNames: string[]
  forwardsListeners: boolean
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
  return Boolean(component.forwardsListeners)
    || componentForwardsAttrs(file, component)
    || (component.ons ?? []).some((on) => resolveTemplateOnExpression(file, on.expression).forwardsListeners)
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

function emptyOnResolution(): TemplateOnResolution {
  return { eventNames: [], forwardsListeners: false }
}

function mergeOnResolutions(items: TemplateOnResolution[]): TemplateOnResolution {
  return {
    eventNames: uniqueStrings(items.flatMap((item) => item.eventNames)),
    forwardsListeners: items.some((item) => item.forwardsListeners),
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

function resolveTemplateOnExpression(file: VueFileIndex, expression: string, seen = new Set<string>()): TemplateOnResolution {
  const normalized = stripOuterParens(expression.trim())
  if (!normalized) {
    return emptyOnResolution()
  }

  if (normalized === '$listeners' || normalized === '$attrs') {
    return { eventNames: [], forwardsListeners: true }
  }

  if (normalized.startsWith('{')) {
    return resolveObjectOnExpression(file, normalized, 0, findMatchingBracket(normalized, 0), seen)
  }

  const identifier = readIdentifierAt(normalized, 0)
  if (identifier && identifier.end === normalized.length) {
    return resolveTemplateOnIdentifier(file, identifier.value, seen)
  }

  if (identifier && normalized.slice(identifier.end).trim() === '.value') {
    return resolveTemplateOnIdentifier(file, identifier.value, seen)
  }

  return emptyOnResolution()
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

function resolveTemplateOnIdentifier(file: VueFileIndex, name: string, seen: Set<string>): TemplateOnResolution {
  const seenKey = `${file.uri}\0${name}`
  if (seen.has(seenKey)) {
    return emptyOnResolution()
  }
  seen.add(seenKey)

  const context = getTemplateBindContext(file)
  if (context.useAttrsNames.has(name)) {
    return { eventNames: [], forwardsListeners: true }
  }

  const initializer = context.initializers.get(name)
  if (!initializer) {
    return emptyOnResolution()
  }

  return resolveInitializerOnExpression(file, readTemplateInitializer(initializer), seen)
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

function resolveInitializerOnExpression(file: VueFileIndex, initializer: string, seen: Set<string>): TemplateOnResolution {
  const expression = stripTypeAssertion(stripOuterParens(initializer.trim()))
  if (!expression) {
    return emptyOnResolution()
  }

  if (expression.startsWith('{')) {
    return resolveObjectOnExpression(file, expression, 0, findMatchingBracket(expression, 0), seen)
  }

  const call = readCallExpression(expression)
  if (!call) {
    return resolveTemplateOnExpression(file, expression, seen)
  }

  if (['ref', 'shallowRef', 'reactive', 'shallowReactive', 'readonly', 'markRaw'].includes(call.callee)) {
    return call.args[0] ? resolveTemplateOnExpression(file, call.args[0], seen) : emptyOnResolution()
  }

  if (call.callee === 'computed') {
    return call.args[0] ? resolveComputedOnExpression(file, call.args[0], seen) : emptyOnResolution()
  }

  if (call.callee === 'useAttrs') {
    return { eventNames: [], forwardsListeners: true }
  }

  return emptyOnResolution()
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

function resolveComputedOnExpression(file: VueFileIndex, expression: string, seen: Set<string>): TemplateOnResolution {
  const arrow = findArrow(expression, 0)
  if (arrow === -1) {
    return emptyOnResolution()
  }

  const bodyStart = skipWhitespace(expression, arrow + 2)
  if (expression[bodyStart] === '{') {
    const bodyEnd = findMatchingBracket(expression, bodyStart)
    const returned = findReturnedObjectExpression(expression, bodyStart, bodyEnd)
    return returned
      ? resolveTemplateOnExpression(file, returned, seen)
      : emptyOnResolution()
  }

  return resolveTemplateOnExpression(file, expression.slice(bodyStart), seen)
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

function resolveObjectOnExpression(file: VueFileIndex, content: string, objectStart: number, objectEnd: number, seen: Set<string>): TemplateOnResolution {
  const eventNames: string[] = []
  const spreadResolutions: TemplateOnResolution[] = []
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
      spreadResolutions.push(resolveTemplateOnExpression(file, content.slice(spreadStart, spreadEnd), seen))
      cursor = spreadEnd + 1
      continue
    }

    const key = readObjectBindKey(content, cursor)
    if (!key) {
      cursor = findTopLevelCommaOrEnd(content, cursor + 1, objectEnd) + 1
      continue
    }

    eventNames.push(key.value)
    cursor = findTopLevelCommaOrEnd(content, key.rawEnd ?? key.end, objectEnd) + 1
  }

  return mergeOnResolutions([
    { eventNames, forwardsListeners: false },
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

function emptyRelationshipTopology(): RelationshipTopology {
  return {
    children: new Set(),
    forwardedPropChildren: new Set(),
    forwardedEventChildren: new Set(),
    declaredProps: new Set(),
    declaredEvents: new Set(),
    provideKeys: [],
  }
}

function relationshipTopologyChanged(left: RelationshipTopology, right: RelationshipTopology): boolean {
  const propBoundaryChanged = (left.forwardedPropChildren.size > 0 || right.forwardedPropChildren.size > 0)
    && !sameStringSet(left.declaredProps, right.declaredProps)
  const eventBoundaryChanged = (left.forwardedEventChildren.size > 0 || right.forwardedEventChildren.size > 0)
    && !sameStringSet(left.declaredEvents, right.declaredEvents)
  return !sameStringSet(left.children, right.children)
    || !sameStringSet(left.forwardedPropChildren, right.forwardedPropChildren)
    || !sameStringSet(left.forwardedEventChildren, right.forwardedEventChildren)
    || propBoundaryChanged
    || eventBoundaryChanged
    || left.provideKeys.length !== right.provideKeys.length
    || left.provideKeys.some((key, index) => key !== right.provideKeys[index])
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

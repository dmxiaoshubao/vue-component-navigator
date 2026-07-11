import fsSync from 'node:fs'
import type { GlobalComponentRegistration, IndexCancellationToken, MixinReference, ParsedSfc, RefMethodAccess, ScriptIndex, SourceLocation, TemplateComponentUsage, TemplateIndex, TextSpan, VueFileIndex } from './types'
import { parseSfc } from './sfcParser'
import { findScriptExportSourceSpan, parseScript } from './scriptParser'
import { parseTemplate } from './templateParser'
import type { VueRuntimeEngine } from './vueRuntime'
import { createLineStarts } from '../utils/position'
import { toKebabCase } from '../utils/casing'
import { maskStringsAndComments } from '../utils/scriptScan'

interface Vue2RuntimeHost {
  workspaceRoots: () => string[]
  eventBusNames: () => string[]
  globalComponents: () => GlobalComponentRegistration[]
  indexFile: (uri: string) => Promise<VueFileIndex>
  indexGlobalComponentFile: (uri: string, rebuildScriptUsages?: boolean) => Promise<void>
  refreshEventBusRegistrations: (root: string, token?: IndexCancellationToken) => Promise<void>
  isInsideWorkspace: (uri: string) => boolean
  withBulkIndexing: (task: () => Promise<void>) => Promise<void>
}

type MixinIndexResult = { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[], exportSourceLocation?: SourceLocation }

export function emptyScriptIndex(): ScriptIndex {
  return {
    imports: [],
    mixins: [],
    components: [],
    staticComponentNames: [],
    props: [],
    methods: [],
    optionMembers: [],
    emits: [],
    eventBusCalls: [],
    provides: [],
    injects: [],
    vue3PropUsages: [],
    composableReturnUsages: [],
    slots: [],
  }
}

export function findRefMethodCalls(searchableContent: string): RefMethodAccess[] {
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

export function mixinLikeReferences(scriptIndex: ScriptIndex): MixinReference[] {
  return [
    ...(scriptIndex.extendsRef ? [scriptIndex.extendsRef] : []),
    ...scriptIndex.mixins,
  ]
}

export class Vue2Runtime implements VueRuntimeEngine {
  readonly version = 2

  private readonly mixinIndexCache = new Map<string, MixinIndexResult | undefined>()
  private readonly mixinSourceUris = new Set<string>()

  constructor(private readonly host: Vue2RuntimeHost) {}

  clear(): void {
    this.mixinIndexCache.clear()
    this.mixinSourceUris.clear()
  }

  replaceWith(other: Vue2Runtime): void {
    replaceMap(this.mixinIndexCache, other.mixinIndexCache)
    replaceSet(this.mixinSourceUris, other.mixinSourceUris)
  }

  hasMixinSource(uri: string): boolean {
    return this.mixinSourceUris.has(uri) || this.hasMixinCacheForFile(uri)
  }

  clearMixinCacheForFile(uri: string): void {
    for (const key of [...this.mixinIndexCache.keys()]) {
      if (key.startsWith(`${uri}\0`)) {
        this.mixinIndexCache.delete(key)
      }
    }
  }

  clearWorkspaceRoot(inRoot: (uri: string) => boolean): void {
    for (const uri of [...this.mixinSourceUris]) {
      if (inRoot(uri)) {
        this.mixinSourceUris.delete(uri)
      }
    }
    for (const key of [...this.mixinIndexCache.keys()]) {
      const sourceUri = key.split('\0')[0]
      if (inRoot(sourceUri)) {
        this.mixinIndexCache.delete(key)
      }
    }
  }

  resolveMixinSourceLocation(mixin: MixinReference): SourceLocation | undefined {
    if (!mixin.targetUri || !this.host.isInsideWorkspace(mixin.targetUri) || isInsideNodeModules(mixin.targetUri)) {
      return undefined
    }
    const exportName = mixin.importedName ?? 'default'
    return this.parseMixin({ ...mixin, importedName: exportName })?.exportSourceLocation
  }

  indexContent(uri: string, sfc: ParsedSfc): VueFileIndex {
    const eventBusNames = this.host.eventBusNames()
    const ownScriptIndex = sfc.script
      ? parseScript(uri, sfc.script.content, sfc.script.start, this.host.workspaceRoots(), 'default', eventBusNames)
      : emptyScriptIndex()
    const mixed = this.mergeStaticMixins(uri, ownScriptIndex)
    const scriptIndex = mixed.scriptIndex
    const registeredTags = [
      ...scriptComponentTagAliases(scriptIndex),
      ...this.host.globalComponents().flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)]),
    ]
    const templateIndex = sfc.template
      ? parseTemplate(sfc.template.content, sfc.template.start, registeredTags, scriptIndex.staticComponentNames, eventBusNames, false, new Set(scriptIndex.optionMembers.map((member) => member.name)))
      : emptyTemplateIndex()
    const mergedScriptIndex = mergeTemplateRelations(scriptIndex, templateIndex)
    const searchableContent = maskStringsAndComments(sfc.content)

    return createIndexedFile(uri, sfc, mergedScriptIndex, templateIndex, [
      ...findRefMethodCalls(searchableContent),
      ...mixed.refMethodCalls,
    ], searchableContent)
  }

  async indexWorkspace(root: string, vueFiles: string[], scriptFiles: string[], token?: IndexCancellationToken): Promise<void> {
    for (const file of scriptFiles) {
      try {
        await this.host.indexGlobalComponentFile(file, false)
      } catch (error) {
        if (!isUnreadableFileError(error)) {
          throw error
        }
        // 初始索引期间文件可能被删除或不可读，静默跳过即可。
      }
      if (token?.isCancellationRequested) {
        return
      }
    }

    await this.host.refreshEventBusRegistrations(root, token)
    if (token?.isCancellationRequested) {
      return
    }

    await this.host.withBulkIndexing(async () => {
      for (const file of vueFiles) {
        try {
          await this.host.indexFile(file)
        } catch (error) {
          if (!isUnreadableFileError(error)) {
            throw error
          }
          // 初始索引期间文件可能被删除或不可读，静默跳过即可。
        }
        if (token?.isCancellationRequested) {
          return
        }
      }
    })
  }

  private mergeStaticMixins(uri: string, own: ScriptIndex): { scriptIndex: ScriptIndex, refMethodCalls: RefMethodAccess[] } {
    const collected = this.collectMixinIndexes(mixinLikeReferences(own), new Set([`${uri}\0default`]), 0)
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
        optionMembers: mergeNamed(own.optionMembers, mixinIndexes.flatMap((item) => item.optionMembers), (item) => item.name),
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
      if (!mixin.targetUri || visited.has(key) || !this.host.isInsideWorkspace(mixin.targetUri) || isInsideNodeModules(mixin.targetUri)) {
        continue
      }
      this.mixinSourceUris.add(mixin.targetUri)

      const parsed = this.parseMixin(mixin)
      if (!parsed) {
        continue
      }

      results.push(parsed)
      visited.add(key)
      results.push(...this.collectMixinIndexes(mixinLikeReferences(parsed.scriptIndex), visited, depth + 1))
      visited.delete(key)
    }

    return results
  }

  private parseMixin(mixin: MixinReference): MixinIndexResult | undefined {
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

  private hasMixinCacheForFile(uri: string): boolean {
    for (const key of this.mixinIndexCache.keys()) {
      if (key.startsWith(`${uri}\0`)) {
        return true
      }
    }
    return false
  }

  private readMixinIndex(uri: string, exportName: string): MixinIndexResult | undefined {
    try {
      const content = fsSync.readFileSync(uri, 'utf8')
      const lineStarts = createLineStarts(content)
      const source = (span: TextSpan): SourceLocation => ({ uri, lineStarts, span })

      if (uri.endsWith('.vue')) {
        const sfc = parseSfc(uri, content)
        if (!sfc.script) {
          return undefined
        }
        const scriptIndex = parseScript(uri, sfc.script.content, sfc.script.start, this.host.workspaceRoots(), exportName, this.host.eventBusNames())
        const exportSpan = findScriptExportSourceSpan(sfc.script.content, exportName, sfc.script.start)
        return {
          scriptIndex: withSourceLocations(scriptIndex, source),
          exportSourceLocation: exportSpan ? source(exportSpan) : undefined,
          refMethodCalls: findRefMethodCalls(maskStringsAndComments(sfc.script.content))
            .map((call) => withRefSourceLocation(call, sfc.script!.start, source)),
        }
      }

      const scriptIndex = parseScript(uri, content, 0, this.host.workspaceRoots(), exportName, this.host.eventBusNames())
      const exportSpan = findScriptExportSourceSpan(content, exportName, 0)
      return {
        scriptIndex: withSourceLocations(scriptIndex, source),
        exportSourceLocation: exportSpan ? source(exportSpan) : undefined,
        refMethodCalls: findRefMethodCalls(maskStringsAndComments(content))
          .map((call) => withRefSourceLocation(call, 0, source)),
      }
    } catch {
      return undefined
    }
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, value)
  }
}

function replaceSet<T>(target: Set<T>, source: Set<T>): void {
  target.clear()
  for (const value of source) {
    target.add(value)
  }
}

function emptyTemplateIndex(components: TemplateComponentUsage[] = []): TemplateIndex {
  return {
    components,
    emits: [],
    eventBusCalls: [],
    slots: [],
    instanceMembers: [],
  }
}

function mergeTemplateRelations(scriptIndex: ScriptIndex, templateIndex: TemplateIndex): ScriptIndex {
  return {
    ...scriptIndex,
    emits: [...scriptIndex.emits, ...templateIndex.emits],
    eventBusCalls: [...scriptIndex.eventBusCalls, ...templateIndex.eventBusCalls],
    slots: [...scriptIndex.slots, ...templateIndex.slots],
  }
}

function createIndexedFile(uri: string, sfc: ParsedSfc, scriptIndex: ScriptIndex, templateIndex: TemplateIndex, refMethodCalls: RefMethodAccess[], searchableContent: string): VueFileIndex {
  return {
    uri,
    fileName: sfc.fileName,
    vueVersion: 2,
    content: sfc.content,
    searchableContent,
    lineStarts: sfc.lineStarts,
    script: sfc.script,
    scriptSetup: sfc.scriptSetup,
    template: sfc.template,
    scriptIndex,
    templateIndex,
    refMethodCalls,
  }
}

function scriptComponentTagAliases(scriptIndex: ScriptIndex): string[] {
  return scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)])
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
    components: scriptIndex.components.map((item) => ({ ...item, sourceLocation: source(item.nameSpan) })),
    props: scriptIndex.props.map((item) => ({ ...item, sourceLocation: source(item.span) })),
    methods: scriptIndex.methods.map((item) => ({ ...item, sourceLocation: source(item.span) })),
    optionMembers: scriptIndex.optionMembers.map((item) => ({ ...item, sourceLocation: source(item.span) })),
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

function isInsideNodeModules(file: string): boolean {
  return file.split(/[\\/]/).includes('node_modules')
}

function isUnreadableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR'
}

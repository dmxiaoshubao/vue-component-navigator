import fsSync from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { createVueLanguagePlugin, getDefaultCompilerOptions, tsCodegen, type VueVirtualCode } from '@vue/language-core'
import type {
  ComponentRegistration,
  EmitInfo,
  ImportInfo,
  IndexCancellationToken,
  InjectInfo,
  MethodInfo,
  ParsedSfc,
  PropInfo,
  ProvideInfo,
  RefMethodAccess,
  ScriptIndex,
  SfcBlock,
  SlotInfo,
  SourceLocation,
  StaticComponentNameBinding,
  TemplateComponentUsage,
  TemplateIndex,
  TextSpan,
  VueFileIndex,
  Vue3PropTypeInfo,
  Vue3PropUsage,
} from './types'
import type { VueRuntimeEngine } from './vueRuntime'
import { cacheComposableReturnDefinitions, createComposableReturnParseCache, parseComposableReturnUsages, resolveComposableImport, isComposableImport, type ComposableReturnParseCache } from './composableParser'
import { resolveImportPathWithExtensions } from './relationResolver'
import { collectStaticComponentNameBindings } from './scriptParser'
import { parseTemplate } from './templateParser'
import { toKebabCase } from '../utils/casing'
import { createLineStarts } from '../utils/position'
import { maskStringsAndComments } from '../utils/scriptScan'

interface Vue3LanguageCoreRuntimeHost {
  workspaceRoots: () => string[]
  indexFile: (uri: string) => Promise<VueFileIndex>
  indexContent: (uri: string, content: string) => VueFileIndex
  indexScriptComponentUsageContent: (uri: string, content: string, rebuild?: boolean) => void
  withBulkIndexing: (task: () => Promise<void>) => Promise<void>
}

interface LanguageCoreBlock {
  content: string
  startTagEnd: number
  endTagStart: number
}

interface ScriptSegment {
  uri: string
  content: string
  start: number
  lineStarts: number[]
  ast: ts.SourceFile
}

interface Vue3LanguageCoreContext {
  uri: string
  fileName: string
  content: string
  lineStarts: number[]
  script?: SfcBlock
  scriptSetup?: SfcBlock
  template?: SfcBlock
  templateAst?: unknown
  scriptSegment?: ScriptSegment
  scriptSetupSegment?: ScriptSegment
  scriptSetupRanges?: any
  virtualCode?: VueVirtualCode
}

interface TypeSource {
  uri: string
  lineStarts: number[]
  segments: ScriptSegment[]
}

interface TypeSourceCacheEntry {
  mtimeMs: number
  size: number
  source: TypeSource | undefined
}

interface StaticKeyInfo {
  key: string
  label: string
  sourceLocation?: SourceLocation
}

interface StaticKeyCacheEntry {
  mtimeMs: number
  size: number
  keys: Map<string, StaticKeyInfo>
}

interface PropsState {
  props: PropInfo[]
  vue3PropType?: Vue3PropTypeInfo
  objectName?: string
  destructured: Map<string, string>
  callEnd: number
}

interface TypeMemberReadResult {
  props: PropInfo[]
  typeLocation?: SourceLocation
}

interface CallKeyArgument {
  key: string
  label: string
  span: TextSpan
  callSpan: TextSpan
  keySourceLocation?: SourceLocation
}

interface LocalFunctionInfo {
  name: string
  span: TextSpan
  detail: string
  signature: string
  sourceLocation: SourceLocation
}

interface ForwardedRefMethodNameCacheEntry {
  mtimeMs: number
  size: number
  methodsByExportName: Map<string, string[]>
}

const vueCompilerOptions = getDefaultCompilerOptions(3.5)

let vueLanguagePlugin: ReturnType<typeof createVueLanguagePlugin<string>> | undefined

function getVueLanguagePlugin(): ReturnType<typeof createVueLanguagePlugin<string>> {
  vueLanguagePlugin ??= createVueLanguagePlugin(
    ts,
    {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.Latest,
    },
    vueCompilerOptions,
    (scriptId) => scriptId,
  )
  return vueLanguagePlugin
}

export class Vue3LanguageCoreRuntime implements VueRuntimeEngine {
  readonly version = 3

  private readonly typeSourceCache = new Map<string, TypeSourceCacheEntry>()
  private readonly staticKeyCache = new Map<string, StaticKeyCacheEntry>()
  private readonly composableReturnParseCache: ComposableReturnParseCache = createComposableReturnParseCache()
  private readonly forwardedRefMethodNameCache = new Map<string, ForwardedRefMethodNameCacheEntry>()
  private readonly syncedSourceVersions = new Map<string, number>()
  private readonly syncedSourceContents = new Map<string, string>()

  constructor(private readonly host: Vue3LanguageCoreRuntimeHost) {}

  clear(): void {
    this.typeSourceCache.clear()
    this.staticKeyCache.clear()
    this.composableReturnParseCache.clear()
    this.forwardedRefMethodNameCache.clear()
    this.syncedSourceVersions.clear()
    this.syncedSourceContents.clear()
  }

  clearWorkspaceRoot(inRoot: (uri: string) => boolean): void {
    clearMapEntriesInRoot(this.typeSourceCache, inRoot)
    clearMapEntriesInRoot(this.staticKeyCache, inRoot)
    clearMapEntriesInRoot(this.composableReturnParseCache, inRoot)
    clearMapEntriesInRoot(this.forwardedRefMethodNameCache, inRoot)
    clearMapEntriesInRoot(this.syncedSourceVersions, inRoot)
    clearMapEntriesInRoot(this.syncedSourceContents, inRoot)
  }

  replaceWith(other: Vue3LanguageCoreRuntime): void {
    replaceMap(this.typeSourceCache, other.typeSourceCache)
    replaceMap(this.staticKeyCache, other.staticKeyCache, cloneStaticKeyCacheEntry)
    replaceMap(this.composableReturnParseCache, other.composableReturnParseCache)
    replaceMap(this.forwardedRefMethodNameCache, other.forwardedRefMethodNameCache, cloneForwardedRefMethodNameCacheEntry)
    replaceMap(this.syncedSourceVersions, other.syncedSourceVersions)
    replaceMap(this.syncedSourceContents, other.syncedSourceContents)
  }

  invalidate(uri: string): void {
    this.typeSourceCache.delete(uri)
    this.staticKeyCache.delete(uri)
    this.composableReturnParseCache.delete(uri)
    this.forwardedRefMethodNameCache.delete(uri)
    this.syncedSourceVersions.delete(uri)
    this.syncedSourceContents.delete(uri)
  }

  syncSourceContent(uri: string, content: string, version?: number): boolean {
    if (version !== undefined && this.syncedSourceVersions.get(uri) === version) {
      return false
    }
    if (version === undefined && this.syncedSourceContents.get(uri) === content) {
      return false
    }
    this.typeSourceCache.delete(uri)
    this.staticKeyCache.delete(uri)
    this.composableReturnParseCache.delete(uri)
    this.forwardedRefMethodNameCache.delete(uri)

    const context = createVue3LanguageCoreContext(uri, content)
    this.typeSourceCache.set(uri, {
      mtimeMs: -1,
      size: -1,
      source: {
        uri,
        lineStarts: context.lineStarts,
        segments: contextSegments(context),
      },
    })
    this.staticKeyCache.set(uri, {
      mtimeMs: -1,
      size: -1,
      keys: collectLocalStaticKeys(uri, context.lineStarts, contextSegments(context)),
    })
    cacheComposableReturnDefinitions(uri, content, this.composableReturnParseCache)
    if (version === undefined) {
      this.syncedSourceVersions.delete(uri)
      this.syncedSourceContents.set(uri, content)
    } else {
      this.syncedSourceVersions.set(uri, version)
      this.syncedSourceContents.delete(uri)
    }
    return true
  }

  shouldIndexScriptContent(content: string): boolean {
    return hasVue3StandaloneScriptRelations(content)
  }

  indexContent(uri: string, sfc: ParsedSfc): VueFileIndex {
    const context = createVue3LanguageCoreContext(uri, sfc.content)
    const scriptIndex = this.createScriptIndex(context)
    const templateIndex = context.template
      ? parseTemplate(context.template.content, context.template.start, componentTagAliases(scriptIndex), scriptIndex.staticComponentNames, [], true, new Set<string>())
      : emptyTemplateIndex(isScriptFile(uri) && !uri.endsWith('.vue') ? parseScriptRefComponentUsages(context, scriptIndex.imports, this.host.workspaceRoots()) : [])
    const mergedScriptIndex = mergeTemplateRelations(scriptIndex, templateIndex)

    return {
      uri,
      fileName: context.fileName,
      vueVersion: 3,
      content: context.content,
      searchableContent: maskStringsAndComments(context.content),
      lineStarts: context.lineStarts,
      script: context.script,
      scriptSetup: context.scriptSetup,
      template: context.template,
      scriptIndex: mergedScriptIndex,
      templateIndex,
      refMethodCalls: [
        ...collectTemplateRefMethodCalls(context),
        ...this.collectDefineExposeForwardedRefMethodCalls(context, mergedScriptIndex.imports),
      ],
    }
  }

  async indexWorkspace(_root: string, vueFiles: string[], scriptFiles: string[], token?: IndexCancellationToken): Promise<void> {
    const indexableScriptContents = new Map<string, string>()
    for (const file of scriptFiles) {
      if (token?.isCancellationRequested) {
        return
      }
      const content = readTextIfExists(file)
      if (content !== undefined) {
        this.host.indexScriptComponentUsageContent(file, content, false)
        if (hasVue3StandaloneScriptRelations(content)) {
          indexableScriptContents.set(file, content)
        }
      }
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
      for (const [file, content] of indexableScriptContents) {
        this.host.indexContent(file, content)
        if (token?.isCancellationRequested) {
          return
        }
      }
    })
  }

  private createScriptIndex(context: Vue3LanguageCoreContext): ScriptIndex {
    const segments = contextSegments(context)
    const imports = collectImports(segments)
    const typeFileCache = new Map<string, TypeSource | undefined>()
    const propsState = collectProps(context, imports, this.host.workspaceRoots(), (uri) => this.readTypeSource(uri, typeFileCache))
    const staticKeys = collectStaticKeys(context.uri, context.lineStarts, segments, imports, this.host.workspaceRoots(), this.staticKeyCache)
    const emits = collectEmits(context, imports, this.host.workspaceRoots(), (uri) => this.readTypeSource(uri, typeFileCache))
    const methods = collectExposeMethods(context, imports, this.host.workspaceRoots(), (uri) => this.readTypeSource(uri, typeFileCache))
    const ownSfc = contextToParsedSfc(context)
    const ownScriptIndex = {
      componentName: collectDefineOptionsName(context),
      imports,
      mixins: [],
      components: collectComponents(context.uri, segments, imports, this.host.workspaceRoots()),
      staticComponentNames: collectStaticComponentNames(segments),
      props: propsState.props,
      methods,
      optionMembers: [],
      emits,
      eventBusCalls: [],
      provides: collectProvides(segments, staticKeys),
      injects: collectInjects(segments, staticKeys),
      vue3PropType: propsState.vue3PropType,
      vue3PropUsages: collectPropUsages(context, propsState),
      composableReturnUsages: parseComposableReturnUsages(context.uri, ownSfc, imports, this.host.workspaceRoots(), this.composableReturnParseCache),
      slots: collectSlots(context, imports, this.host.workspaceRoots(), (uri) => this.readTypeSource(uri, typeFileCache)),
    } satisfies ScriptIndex

    return ownScriptIndex
  }

  private readTypeSource(uri: string, scopedCache: Map<string, TypeSource | undefined>): TypeSource | undefined {
    if (scopedCache.has(uri)) {
      return scopedCache.get(uri)
    }
    const cached = this.readTypeSourceCached(uri)
    scopedCache.set(uri, cached)
    return cached
  }

  private readTypeSourceCached(uri: string): TypeSource | undefined {
    try {
      const stats = fsSync.statSync(uri)
      const cached = this.typeSourceCache.get(uri)
      if (cached && (cached.mtimeMs === -1 || (cached.mtimeMs === stats.mtimeMs && cached.size === stats.size))) {
        return cached.source
      }

      const content = fsSync.readFileSync(uri, 'utf8')
      const context = createVue3LanguageCoreContext(uri, content)
      const source: TypeSource = {
        uri,
        lineStarts: context.lineStarts,
        segments: contextSegments(context),
      }
      this.typeSourceCache.set(uri, { mtimeMs: stats.mtimeMs, size: stats.size, source })
      return source
    } catch {
      this.typeSourceCache.set(uri, { mtimeMs: -1, size: -1, source: undefined })
      return undefined
    }
  }

  private collectDefineExposeForwardedRefMethodCalls(context: Vue3LanguageCoreContext, imports: ImportInfo[]): RefMethodAccess[] {
    const setup = context.scriptSetupSegment
    if (!setup) {
      return []
    }
    const results: RefMethodAccess[] = []
    const workspaceRoots = this.host.workspaceRoots()

    visit(setup.ast, (node) => {
      if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'defineExpose')) {
        return
      }
      const exposed = node.arguments[0]
      const exposedCall = exposed ? skipExpressionNoise(exposed) : undefined
      if (!exposedCall || !ts.isCallExpression(exposedCall) || !ts.isIdentifier(exposedCall.expression)) {
        return
      }

      const call = exposedCall
      const callee = call.expression
      if (!ts.isIdentifier(callee)) {
        return
      }
      const calleeName = callee.text
      const refArg = call.arguments[0] ? skipExpressionNoise(call.arguments[0]) : undefined
      if (!refArg || !ts.isIdentifier(refArg)) {
        return
      }

      const imported = imports.find((item) => item.localName === calleeName && isComposableImport(item))
      if (!imported) {
        return
      }

      const sourceUri = resolveComposableImport(context.uri, imported.source, workspaceRoots)
      if (!sourceUri) {
        return
      }

      const exportName = imported.importedName ?? imported.localName
      for (const methodName of this.readForwardedRefMethodNames(sourceUri, exportName)) {
        results.push({
          refName: refArg.text,
          methodName,
          methodSpan: absoluteSpan(setup, call.expression),
          forwarded: true,
        })
      }
    })

    return dedupeRefMethodCalls(results)
  }

  private readForwardedRefMethodNames(sourceUri: string, exportName: string): string[] {
    try {
      const stats = fsSync.statSync(sourceUri)
      const cached = this.forwardedRefMethodNameCache.get(sourceUri)
      if (cached && (cached.mtimeMs === -1 || (cached.mtimeMs === stats.mtimeMs && cached.size === stats.size))) {
        return cached.methodsByExportName.get(exportName) ?? []
      }

      const source = this.readTypeSourceCached(sourceUri)
      const methodsByExportName = source ? collectComposableReturnMethodNames(source) : new Map<string, string[]>()
      this.forwardedRefMethodNameCache.set(sourceUri, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        methodsByExportName,
      })
      return methodsByExportName.get(exportName) ?? []
    } catch {
      return []
    }
  }
}

function createVue3LanguageCoreContext(uri: string, content: string): Vue3LanguageCoreContext {
  const lineStarts = createLineStarts(content)

  if (!uri.endsWith('.vue')) {
    const ast = createSourceFile(uri, content)
    const script: SfcBlock = { content, start: 0, end: content.length }
    return {
      uri,
      fileName: path.basename(uri),
      content,
      lineStarts,
      script,
      scriptSegment: { uri, content, start: 0, lineStarts, ast },
    }
  }

  const plugin = getVueLanguagePlugin()
  const languageId = plugin.getLanguageId(uri) ?? 'vue'
  const virtualCode = plugin.createVirtualCode?.(uri, languageId, ts.ScriptSnapshot.fromString(content), {
    getAssociatedScript: () => undefined,
  }) as VueVirtualCode | undefined

  if (!virtualCode) {
    return {
      uri,
      fileName: path.basename(uri),
      content,
      lineStarts,
    }
  }

  // 触发 Volar 生成脚本，tsCodegen 的宏范围随后才会挂到 IR 的 WeakMap 上。
  ;(plugin as any).typescript?.getServiceScript?.(virtualCode)

  const script = toSfcBlock(virtualCode.ir.script)
  const scriptSetup = toSfcBlock(virtualCode.ir.scriptSetup)
  const scriptSegment = virtualCode.ir.script && script
    ? createSegment(uri, virtualCode.ir.script.content, script.start, lineStarts, virtualCode.ir.script.ast)
    : undefined
  const scriptSetupSegment = virtualCode.ir.scriptSetup && scriptSetup
    ? createSegment(uri, virtualCode.ir.scriptSetup.content, scriptSetup.start, lineStarts, virtualCode.ir.scriptSetup.ast)
    : undefined
  const codegen = tsCodegen.get(virtualCode.ir)

  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts,
    script,
    scriptSetup,
    template: toSfcBlock(virtualCode.ir.template),
    templateAst: virtualCode.ir.template?.ast,
    scriptSegment,
    scriptSetupSegment,
    scriptSetupRanges: codegen?.getScriptSetupRanges(),
    virtualCode,
  }
}

function toSfcBlock(block: LanguageCoreBlock | undefined): SfcBlock | undefined {
  if (!block) {
    return undefined
  }
  return {
    content: block.content,
    start: block.startTagEnd,
    end: block.endTagStart,
  }
}

function createSegment(uri: string, content: string, start: number, lineStarts: number[], ast?: ts.SourceFile): ScriptSegment {
  return {
    uri,
    content,
    start,
    lineStarts,
    ast: ast ?? createSourceFile(uri, content),
  }
}

function createSourceFile(uri: string, content: string): ts.SourceFile {
  return ts.createSourceFile(uri, content, ts.ScriptTarget.Latest, true, scriptKindFor(uri))
}

function scriptKindFor(uri: string): ts.ScriptKind {
  if (uri.endsWith('.tsx')) {
    return ts.ScriptKind.TSX
  }
  if (uri.endsWith('.jsx')) {
    return ts.ScriptKind.JSX
  }
  if (uri.endsWith('.js')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function contextSegments(context: Vue3LanguageCoreContext): ScriptSegment[] {
  return [context.scriptSegment, context.scriptSetupSegment].filter((segment): segment is ScriptSegment => Boolean(segment))
}

function segmentForNode(segments: ScriptSegment[], node: ts.Node): ScriptSegment | undefined {
  const sourceFile = node.getSourceFile()
  if (!sourceFile) {
    return segments[0]
  }
  return segments.find((segment) => segment.ast === sourceFile || (sourceFile.fileName && segment.ast.fileName === sourceFile.fileName))
    ?? segments[0]
}

function contextToParsedSfc(context: Vue3LanguageCoreContext): ParsedSfc {
  return {
    uri: context.uri,
    fileName: context.fileName,
    content: context.content,
    lineStarts: context.lineStarts,
    script: context.script,
    scriptSetup: context.scriptSetup,
    template: context.template,
  }
}

function emptyScriptIndex(imports: ImportInfo[] = []): ScriptIndex {
  return {
    imports,
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

function collectImports(segments: ScriptSegment[]): ImportInfo[] {
  const imports: ImportInfo[] = []
  for (const segment of segments) {
    for (const statement of segment.ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const source = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!clause) {
        continue
      }
      if (clause.name) {
        imports.push({
          localName: clause.name.text,
          source,
          isTypeOnly: clause.isTypeOnly,
          nameSpan: absoluteSpan(segment, clause.name),
        })
      }
      const namedBindings = clause.namedBindings
      if (!namedBindings) {
        continue
      }
      if (ts.isNamespaceImport(namedBindings)) {
        imports.push({
          localName: namedBindings.name.text,
          importedName: '*',
          source,
          isTypeOnly: clause.isTypeOnly,
          nameSpan: absoluteSpan(segment, namedBindings.name),
        })
        continue
      }
      for (const element of namedBindings.elements) {
        imports.push({
          localName: element.name.text,
          importedName: (element.propertyName ?? element.name).text,
          source,
          isTypeOnly: clause.isTypeOnly || element.isTypeOnly,
          nameSpan: absoluteSpan(segment, element.name),
        })
      }
    }
  }
  return imports
}

function collectComponents(uri: string, segments: ScriptSegment[], imports: ImportInfo[], workspaceRoots: string[]): ComponentRegistration[] {
  return imports
    .filter((item) => !item.isTypeOnly && item.importedName === undefined)
    .map((item): ComponentRegistration | undefined => {
      const targetUri = resolveImportPathWithExtensions(uri, item.source, workspaceRoots, ['.vue'])
      if (!targetUri || !targetUri.endsWith('.vue') || !fsSync.existsSync(targetUri)) {
        return undefined
      }
      const segment = segments.find((candidate) => candidate.content.includes(item.localName))
      const localIndex = segment?.content.indexOf(item.localName) ?? -1
      const nameSpan = item.nameSpan ?? (segment && localIndex >= 0
        ? { start: segment.start + localIndex, end: segment.start + localIndex + item.localName.length }
        : { start: 0, end: 0 })
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

function collectStaticComponentNames(segments: ScriptSegment[]): StaticComponentNameBinding[] {
  return segments.flatMap((segment) => collectStaticComponentNameBindings(segment.content))
}

function componentTagAliases(scriptIndex: ScriptIndex): string[] {
  return scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)])
}

function collectDefineOptionsName(context: Vue3LanguageCoreContext): string | undefined {
  if (context.scriptSetupRanges?.defineOptions?.name) {
    return context.scriptSetupRanges.defineOptions.name
  }
  const setup = context.scriptSetupSegment
  if (!setup) {
    return undefined
  }
  let name: string | undefined
  visit(setup.ast, (node) => {
    if (name || !ts.isCallExpression(node) || !isIdentifierText(node.expression, 'defineOptions')) {
      return
    }
    const arg = node.arguments[0]
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      return
    }
    const prop = findObjectProperty(arg, 'name')
    const initializer = prop && ts.isPropertyAssignment(prop) ? skipExpressionNoise(prop.initializer) : undefined
    if (initializer && ts.isStringLiteralLike(initializer)) {
      name = initializer.text
    }
  })
  return name
}

function collectProps(
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): PropsState {
  const setup = context.scriptSetupSegment
  const empty: PropsState = { props: [], destructured: new Map(), callEnd: 0 }
  if (!setup) {
    return empty
  }

  let state: PropsState | undefined
  const modelProps: PropInfo[] = []
  visit(setup.ast, (node) => {
    if (!ts.isCallExpression(node)) {
      return
    }
    if (isIdentifierText(node.expression, 'defineModel')) {
      modelProps.push(readDefineModelProp(setup, node))
      return
    }
    if (state) {
      return
    }
    const macro = readDefinePropsCall(node)
    if (!macro) {
      return
    }

    const declaration = nearestVariableDeclaration(macro.outerCall)
    const destructured = declaration?.name && ts.isObjectBindingPattern(declaration.name)
      ? collectDestructuredProps(declaration.name)
      : new Map<string, string>()
    const objectName = declaration?.name && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : typeof context.scriptSetupRanges?.defineProps?.name === 'string'
        ? context.scriptSetupRanges.defineProps.name
        : undefined
    const typeRead = macro.defineCall.typeArguments?.[0]
      ? readTypeMembers(context.uri, context.lineStarts, contextSegments(context), imports, macro.defineCall.typeArguments[0], workspaceRoots, readTypeSource)
      : macro.defineCall.arguments[0] && ts.isObjectLiteralExpression(macro.defineCall.arguments[0])
        ? { props: readRuntimePropMembers(setup, macro.defineCall.arguments[0]) }
        : { props: [] }
    const defaultProps = readWithDefaultsPropMembers(setup, macro.outerCall)
    const typedPropNames = new Set(typeRead.props.map((prop) => prop.name))
    const props = [...typeRead.props, ...defaultProps.filter((prop) => !typedPropNames.has(prop.name))]
    const typeReference = macro.defineCall.typeArguments?.[0] ? readTypeReferenceInfo(setup, macro.defineCall.typeArguments[0], typeRead.typeLocation) : undefined

    state = {
      props,
      vue3PropType: typeReference,
      objectName,
      destructured,
      callEnd: setup.start + macro.outerCall.end,
    }
  })

  if (state) {
    return {
      ...state,
      props: dedupeProps([...state.props, ...modelProps]),
    }
  }
  if (modelProps.length > 0) {
    return { ...empty, props: dedupeProps(modelProps) }
  }
  return empty
}

function readDefinePropsCall(node: ts.CallExpression): { outerCall: ts.CallExpression, defineCall: ts.CallExpression } | undefined {
  if (isIdentifierText(node.expression, 'defineProps')) {
    return { outerCall: node, defineCall: node }
  }
  if (!isIdentifierText(node.expression, 'withDefaults')) {
    return undefined
  }
  const firstArg = node.arguments[0] ? skipExpressionNoise(node.arguments[0]) : undefined
  if (firstArg && ts.isCallExpression(firstArg) && isIdentifierText(firstArg.expression, 'defineProps')) {
    return { outerCall: node, defineCall: firstArg }
  }
  return undefined
}

function readWithDefaultsPropMembers(segment: ScriptSegment, call: ts.CallExpression): PropInfo[] {
  if (!isIdentifierText(call.expression, 'withDefaults')) {
    return []
  }
  const defaults = call.arguments[1] ? skipExpressionNoise(call.arguments[1]) : undefined
  return defaults && ts.isObjectLiteralExpression(defaults)
    ? readRuntimePropMembers(segment, defaults)
    : []
}

function collectDestructuredProps(pattern: ts.ObjectBindingPattern): Map<string, string> {
  const props = new Map<string, string>()
  for (const element of pattern.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      continue
    }
    const propName = element.propertyName && ts.isIdentifier(element.propertyName)
      ? element.propertyName.text
      : element.propertyName && ts.isStringLiteralLike(element.propertyName)
        ? element.propertyName.text
        : element.name.text
    props.set(element.name.text, propName)
  }
  return props
}

function readRuntimePropMembers(segment: ScriptSegment, object: ts.ObjectLiteralExpression): PropInfo[] {
  const props: PropInfo[] = []
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      continue
    }
    const name = propertyNameText(property.name)
    if (!name) {
      continue
    }
    const span = absoluteSpan(segment, property.name)
    props.push({
      name,
      span,
      detail: segment.content.slice(property.name.getStart(segment.ast), property.end).trim(),
    })
  }
  return props
}

function readTypeReferenceInfo(segment: ScriptSegment, node: ts.TypeNode, sourceLocation?: SourceLocation): Vue3PropTypeInfo | undefined {
  const reference = firstTypeReference(node)
  if (!reference || !ts.isIdentifier(reference.typeName)) {
    return undefined
  }
  return {
    name: reference.typeName.text,
    span: absoluteSpan(segment, reference.typeName),
    sourceLocation,
  }
}

function firstTypeReference(node: ts.TypeNode): ts.TypeReferenceNode | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return node
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return firstTypeReference(node.type)
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    return node.types.map(firstTypeReference).find(Boolean)
  }
  return undefined
}

function readTypeMembers(
  currentUri: string,
  currentLineStarts: number[],
  segments: ScriptSegment[],
  imports: ImportInfo[],
  typeNode: ts.TypeNode,
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): TypeMemberReadResult {
  if (ts.isTypeLiteralNode(typeNode)) {
    const segment = segmentForNode(segments, typeNode)
    return {
      props: readMembersFromTypeElements(
        typeNode.members,
        segment ? { uri: segment.uri, lineStarts: segment.lineStarts } : { uri: currentUri, lineStarts: currentLineStarts },
        segment?.start ?? 0,
        segment?.ast ?? typeNode.getSourceFile(),
      ),
    }
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return readTypeMembers(currentUri, currentLineStarts, segments, imports, typeNode.type, workspaceRoots, readTypeSource)
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    const parts = typeNode.types.map((type) => readTypeMembers(currentUri, currentLineStarts, segments, imports, type, workspaceRoots, readTypeSource))
    return {
      props: dedupeProps(parts.flatMap((part) => part.props)),
      typeLocation: parts.find((part) => part.typeLocation)?.typeLocation,
    }
  }
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return { props: [] }
  }

  const typeName = typeNode.typeName.text
  const imported = imports.find((item) => item.localName === typeName)
  const targetName = imported?.importedName && imported.importedName !== '*' ? imported.importedName : typeName
  const targetUri = imported?.source
    ? resolveImportPathWithExtensions(currentUri, imported.source, workspaceRoots, ['.ts', '.tsx', '.js', '.jsx', '.vue'])
    : undefined

  if (targetUri) {
    const source = readTypeSource(targetUri)
    const declaration = source ? findTypeDeclaration(source.segments, targetName) : undefined
    return declaration ? readTypeDeclarationMembers(declaration) : { props: [] }
  }

  const declaration = findTypeDeclaration(segments, typeName)
  return declaration ? readTypeDeclarationMembers(declaration) : { props: [] }
}

function findTypeDeclaration(segments: ScriptSegment[], typeName: string): { segment: ScriptSegment, node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration } | undefined {
  for (const segment of segments) {
    for (const statement of segment.ast.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === typeName) {
        return { segment, node: statement }
      }
    }
  }
  return undefined
}

function readTypeDeclarationMembers(declaration: { segment: ScriptSegment, node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration }): TypeMemberReadResult {
  const typeNameSpan = absoluteSpan(declaration.segment, declaration.node.name)
  const typeLocation = {
    uri: declaration.segment.uri,
    lineStarts: declaration.segment.lineStarts,
    span: typeNameSpan,
  }
  if (ts.isInterfaceDeclaration(declaration.node)) {
    return {
      props: readMembersFromTypeElements(declaration.node.members, { uri: declaration.segment.uri, lineStarts: declaration.segment.lineStarts }, declaration.segment.start, declaration.segment.ast),
      typeLocation,
    }
  }
  const members = readTypeAliasMembers(declaration.segment, declaration.node.type)
  return { props: members, typeLocation }
}

function readTypeAliasMembers(segment: ScriptSegment, typeNode: ts.TypeNode): PropInfo[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    return readMembersFromTypeElements(typeNode.members, { uri: segment.uri, lineStarts: segment.lineStarts }, segment.start, segment.ast)
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return dedupeProps(typeNode.types.flatMap((item) => readTypeAliasMembers(segment, item)))
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return readTypeAliasMembers(segment, typeNode.type)
  }
  return []
}

function readMembersFromTypeElements(members: ts.NodeArray<ts.TypeElement>, location: Omit<SourceLocation, 'span'>, offset: number, sourceFile: ts.SourceFile): PropInfo[] {
  const props: PropInfo[] = []
  for (const member of members) {
    if (!('name' in member) || !member.name) {
      continue
    }
    const name = propertyNameText(member.name)
    if (!name) {
      continue
    }
    const nameStart = member.name.getStart(sourceFile)
    const nameEnd = member.name.getEnd()
    const span = { start: offset + nameStart, end: offset + nameEnd }
    props.push({
      name,
      span,
      detail: member.getText(sourceFile).trim(),
      documentation: readJsDoc(member),
      sourceLocation: location.uri ? { ...location, span } : undefined,
    })
  }
  return props
}

function collectEmits(
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): EmitInfo[] {
  const setup = context.scriptSetupSegment
  if (!setup) {
    return []
  }
  const emitVariables = new Set<string>()
  const declarations: EmitInfo[] = []
  const calls: EmitInfo[] = []
  if (typeof context.scriptSetupRanges?.defineEmits?.name === 'string') {
    emitVariables.add(context.scriptSetupRanges.defineEmits.name)
  }

  visit(setup.ast, (node) => {
    if (!ts.isCallExpression(node)) {
      return
    }
    if (isIdentifierText(node.expression, 'defineEmits')) {
      const declaration = nearestVariableDeclaration(node)
      if (declaration?.name && ts.isIdentifier(declaration.name)) {
        emitVariables.add(declaration.name.text)
      }
      declarations.push(...readDefineEmitsDeclarations(setup, node, context, imports, workspaceRoots, readTypeSource))
      return
    }
    if (isIdentifierText(node.expression, 'defineModel')) {
      declarations.push(readDefineModelDeclaration(setup, node))
      return
    }
    if (ts.isIdentifier(node.expression) && emitVariables.has(node.expression.text)) {
      const literal = firstStringLiteralArg(node)
      if (!literal) {
        return
      }
      calls.push({
        eventName: literal.text,
        eventSpan: absoluteSpan(setup, literal),
        callSpan: absoluteSpan(setup, node),
      })
    }
  })

  const declarationByName = new Map(declarations.map((emit) => [emit.eventName, emit]))
  const calledNames = new Set(calls.map((emit) => emit.eventName))
  return dedupeEmits([
    ...declarations.filter((emit) => !calledNames.has(emit.eventName)),
    ...calls.map((emit) => {
      const declaration = declarationByName.get(emit.eventName)
      return declaration
        ? { ...emit, sourceLocation: declaration.sourceLocation, declared: declaration.declared }
        : emit
    }),
  ])
}

function readDefineEmitsDeclarations(
  segment: ScriptSegment,
  call: ts.CallExpression,
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): EmitInfo[] {
  const callSpan = absoluteSpan(segment, call)
  const typeArg = call.typeArguments?.[0]
  if (typeArg) {
    return readEmitTypeMembers(context.uri, context.lineStarts, contextSegments(context), imports, typeArg, workspaceRoots, readTypeSource, callSpan)
  }
  const firstArg = call.arguments[0] ? skipExpressionNoise(call.arguments[0]) : undefined
  if (firstArg && ts.isArrayLiteralExpression(firstArg)) {
    return firstArg.elements
      .filter(ts.isStringLiteralLike)
      .map((literal) => ({ eventName: literal.text, eventSpan: absoluteSpan(segment, literal), callSpan, declared: true }))
  }
  if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
    return firstArg.properties
      .map((property): EmitInfo | undefined => {
        if (!('name' in property) || !property.name) {
          return undefined
        }
        const name = propertyNameText(property.name)
        return name ? { eventName: name, eventSpan: absoluteSpan(segment, property.name), callSpan, declared: true } : undefined
      })
      .filter((emit): emit is EmitInfo => Boolean(emit))
  }
  return []
}

function readEmitTypeMembers(
  currentUri: string,
  currentLineStarts: number[],
  segments: ScriptSegment[],
  imports: ImportInfo[],
  typeNode: ts.TypeNode,
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
  callSpan: TextSpan,
): EmitInfo[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    const segment = segmentForNode(segments, typeNode)
    return readEmitsFromTypeElements(
      typeNode.members,
      segment ? { uri: segment.uri, lineStarts: segment.lineStarts } : { uri: currentUri, lineStarts: currentLineStarts },
      segment?.start ?? 0,
      callSpan,
      segment?.ast ?? typeNode.getSourceFile(),
    )
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return dedupeEmits(typeNode.types.flatMap((type) => readEmitTypeMembers(currentUri, currentLineStarts, segments, imports, type, workspaceRoots, readTypeSource, callSpan)))
  }
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return []
  }
  const typeName = typeNode.typeName.text
  const imported = imports.find((item) => item.localName === typeName)
  const targetName = imported?.importedName && imported.importedName !== '*' ? imported.importedName : typeName
  const targetUri = imported?.source
    ? resolveImportPathWithExtensions(currentUri, imported.source, workspaceRoots, ['.ts', '.tsx', '.vue'])
    : undefined
  const source = targetUri ? readTypeSource(targetUri) : undefined
  const declaration = source ? findTypeDeclaration(source.segments, targetName) : findTypeDeclaration(segments, typeName)
  if (!declaration) {
    return []
  }
  if (ts.isInterfaceDeclaration(declaration.node)) {
    return readEmitsFromTypeElements(declaration.node.members, { uri: declaration.segment.uri, lineStarts: declaration.segment.lineStarts }, declaration.segment.start, callSpan, declaration.segment.ast)
  }
  if (ts.isTypeLiteralNode(declaration.node.type)) {
    return readEmitsFromTypeElements(declaration.node.type.members, { uri: declaration.segment.uri, lineStarts: declaration.segment.lineStarts }, declaration.segment.start, callSpan, declaration.segment.ast)
  }
  return []
}

function readEmitsFromTypeElements(members: ts.NodeArray<ts.TypeElement>, location: Omit<SourceLocation, 'span'>, offset: number, callSpan: TextSpan, sourceFile: ts.SourceFile): EmitInfo[] {
  const emits: EmitInfo[] = []
  for (const member of members) {
    if (ts.isCallSignatureDeclaration(member)) {
      const eventName = readEventNameFromCallSignature(member)
      if (!eventName) {
        continue
      }
      const span = { start: offset + eventName.node.getStart(sourceFile), end: offset + eventName.node.getEnd() }
      emits.push({
        eventName: eventName.name,
        eventSpan: span,
        callSpan,
        sourceLocation: { ...location, span },
        declared: true,
      })
      continue
    }
    if (!('name' in member) || !member.name) {
      continue
    }
    const name = propertyNameText(member.name)
    if (!name) {
      continue
    }
    const span = { start: offset + member.name.getStart(sourceFile), end: offset + member.name.getEnd() }
    emits.push({
      eventName: name,
      eventSpan: span,
      callSpan,
      sourceLocation: { ...location, span },
      declared: true,
    })
  }
  return emits
}

function readEventNameFromCallSignature(node: ts.CallSignatureDeclaration): { name: string, node: ts.Node } | undefined {
  const parameter = node.parameters[0]
  const type = parameter?.type
  if (!type) {
    return undefined
  }
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) {
    return { name: type.literal.text, node: type.literal }
  }
  return undefined
}

function readDefineModelDeclaration(segment: ScriptSegment, call: ts.CallExpression): EmitInfo {
  const literal = firstStringLiteralArg(call)
  const declaration = nearestVariableDeclaration(call)
  const localName = declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name : undefined
  const modelName = literal?.text ?? 'modelValue'
  const eventSpan = literal
    ? absoluteSpan(segment, literal)
    : localName
      ? absoluteSpan(segment, localName)
      : absoluteSpan(segment, call.expression)
  return {
    eventName: `update:${modelName}`,
    eventSpan,
    callSpan: absoluteSpan(segment, call),
    declared: true,
  }
}

function readDefineModelProp(segment: ScriptSegment, call: ts.CallExpression): PropInfo {
  const literal = firstStringLiteralArg(call)
  const declaration = nearestVariableDeclaration(call)
  const localName = declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name : undefined
  const modelName = literal?.text ?? 'modelValue'
  const span = literal
    ? absoluteSpan(segment, literal)
    : localName
      ? absoluteSpan(segment, localName)
      : absoluteSpan(segment, call.expression)
  return {
    name: modelName,
    span,
    detail: call.getText(segment.ast).trim(),
  }
}

function collectSlots(
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): SlotInfo[] {
  const setup = context.scriptSetupSegment
  if (!setup) {
    return []
  }
  const slots: SlotInfo[] = []
  visit(setup.ast, (node) => {
    if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'defineSlots')) {
      return
    }
    const typeArg = node.typeArguments?.[0]
    if (!typeArg) {
      return
    }
    slots.push(...readSlotTypeMembers(context.uri, context.lineStarts, contextSegments(context), imports, typeArg, workspaceRoots, readTypeSource))
  })
  return dedupeSlots(slots)
}

function readSlotTypeMembers(
  currentUri: string,
  currentLineStarts: number[],
  segments: ScriptSegment[],
  imports: ImportInfo[],
  typeNode: ts.TypeNode,
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): SlotInfo[] {
  const props = readTypeMembers(currentUri, currentLineStarts, segments, imports, typeNode, workspaceRoots, readTypeSource).props
  return props.map((prop) => ({
    name: prop.name,
    span: prop.span,
    detail: prop.detail,
    documentation: prop.documentation,
    sourceLocation: prop.sourceLocation,
  }))
}

function collectProvides(segments: ScriptSegment[], staticKeys: Map<string, StaticKeyInfo>): ProvideInfo[] {
  const provides: ProvideInfo[] = []
  for (const segment of segments) {
    visit(segment.ast, (node) => {
      if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'provide')) {
        return
      }
      const key = readCallKeyArgument(segment, node, staticKeys)
      if (!key) {
        return
      }
      provides.push({
        key: key.key,
        keySpan: key.span,
        detail: key.label,
        sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span: key.callSpan },
        keySourceLocation: key.keySourceLocation,
      })
    })
  }
  return dedupeProvides(provides)
}

function collectInjects(segments: ScriptSegment[], staticKeys: Map<string, StaticKeyInfo>): InjectInfo[] {
  const injects: InjectInfo[] = []
  for (const segment of segments) {
    visit(segment.ast, (node) => {
      if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'inject')) {
        return
      }
      const key = readCallKeyArgument(segment, node, staticKeys)
      if (!key) {
        return
      }
      const local = readInjectLocalName(segment, node, key.label)
      injects.push({
        key: key.key,
        keySpan: key.span,
        localName: local.name,
        localSpan: local.span,
        detail: key.label,
        sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span: key.callSpan },
        keySourceLocation: key.keySourceLocation,
      })
    })
  }
  return dedupeInjects(injects)
}

function readCallKeyArgument(segment: ScriptSegment, call: ts.CallExpression, staticKeys: Map<string, StaticKeyInfo>): CallKeyArgument | undefined {
  const firstArg = call.arguments[0] ? skipExpressionNoise(call.arguments[0]) : undefined
  if (!firstArg) {
    return undefined
  }
  const callSpan = absoluteSpan(segment, call)
  if (ts.isStringLiteralLike(firstArg)) {
    return {
      key: firstArg.text,
      label: firstArg.text,
      span: absoluteSpan(segment, firstArg),
      callSpan,
    }
  }
  if (!ts.isIdentifier(firstArg)) {
    return undefined
  }
  const staticKey = staticKeys.get(firstArg.text)
  if (!staticKey) {
    return undefined
  }
  return {
    key: staticKey.key,
    label: staticKey.label,
    span: absoluteSpan(segment, firstArg),
    callSpan,
    keySourceLocation: staticKey.sourceLocation,
  }
}

function readInjectLocalName(segment: ScriptSegment, call: ts.CallExpression, defaultName: string): { name: string, span: TextSpan } {
  const declaration = nearestVariableDeclaration(call)
  if (declaration?.name && ts.isIdentifier(declaration.name)) {
    return { name: declaration.name.text, span: absoluteSpan(segment, declaration.name) }
  }
  const assigned = readAssignedIdentifierBefore(segment, call)
  if (assigned) {
    return assigned
  }
  return { name: defaultName, span: absoluteSpan(segment, call.expression) }
}

function readAssignedIdentifierBefore(segment: ScriptSegment, node: ts.Node): { name: string, span: TextSpan } | undefined {
  const parent = node.parent
  if (
    parent
    && ts.isBinaryExpression(parent)
    && parent.right === node
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(parent.left)
  ) {
    return { name: parent.left.text, span: absoluteSpan(segment, parent.left) }
  }

  const start = node.getStart(segment.ast)
  const prefix = segment.content.slice(0, start)
  const match = /(?:^|[;\n])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/u.exec(prefix)
    ?? /(?:^|[;\n])\s*([A-Za-z_$][\w$]*)\s*=\s*$/u.exec(prefix)
  if (!match) {
    return undefined
  }
  const localStart = match.index + match[0].lastIndexOf(match[1])
  return {
    name: match[1],
    span: { start: segment.start + localStart, end: segment.start + localStart + match[1].length },
  }
}

function collectStaticKeys(
  uri: string,
  lineStarts: number[],
  segments: ScriptSegment[],
  imports: ImportInfo[],
  workspaceRoots: string[],
  cache: Map<string, StaticKeyCacheEntry>,
): Map<string, StaticKeyInfo> {
  const needed = collectProvideInjectIdentifierKeys(segments)
  if (needed.size === 0) {
    return new Map()
  }
  return new Map([
    ...resolveImportedStaticKeys(uri, imports, workspaceRoots, needed, cache),
    ...collectLocalStaticKeys(uri, lineStarts, segments, needed),
  ])
}

function collectProvideInjectIdentifierKeys(segments: ScriptSegment[]): Set<string> {
  const names = new Set<string>()
  for (const segment of segments) {
    visit(segment.ast, (node) => {
      if (!ts.isCallExpression(node) || (!isIdentifierText(node.expression, 'provide') && !isIdentifierText(node.expression, 'inject'))) {
        return
      }
      const arg = node.arguments[0] ? skipExpressionNoise(node.arguments[0]) : undefined
      if (arg && ts.isIdentifier(arg)) {
        names.add(arg.text)
      }
    })
  }
  return names
}

function collectLocalStaticKeys(uri: string, lineStarts: number[], segments: ScriptSegment[], needed?: Set<string>): Map<string, StaticKeyInfo> {
  const keys = new Map<string, StaticKeyInfo>()
  for (const segment of segments) {
    for (const statement of segment.ast.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || (needed && !needed.has(declaration.name.text)) || !declaration.initializer) {
          continue
        }
        if (!isSymbolInitializer(skipExpressionNoise(declaration.initializer))) {
          continue
        }
        const span = absoluteSpan(segment, declaration.name)
        keys.set(declaration.name.text, {
          key: staticSymbolKey(uri, declaration.name.text),
          label: declaration.name.text,
          sourceLocation: { uri, lineStarts, span },
        })
      }
    }
  }
  return keys
}

function resolveImportedStaticKeys(
  uri: string,
  imports: ImportInfo[],
  workspaceRoots: string[],
  needed: Set<string>,
  cache: Map<string, StaticKeyCacheEntry>,
): Map<string, StaticKeyInfo> {
  const keys = new Map<string, StaticKeyInfo>()
  for (const item of imports) {
    if (!item.importedName || item.importedName === '*' || item.source === 'vue' || !needed.has(item.localName)) {
      continue
    }
    const targetUri = resolveImportPathWithExtensions(uri, item.source, workspaceRoots, ['.ts', '.tsx', '.js', '.jsx', '.vue'])
    if (!targetUri || !fsSync.existsSync(targetUri)) {
      continue
    }
    const targetKeys = readCachedStaticKeys(targetUri, cache)
    const targetKey = targetKeys.get(item.importedName)
    if (!targetKey) {
      continue
    }
    keys.set(item.localName, { ...targetKey, label: item.localName })
  }
  return keys
}

function readCachedStaticKeys(targetUri: string, cache: Map<string, StaticKeyCacheEntry>): Map<string, StaticKeyInfo> {
  try {
    const stats = fsSync.statSync(targetUri)
    const cached = cache.get(targetUri)
    if (cached && (cached.mtimeMs === -1 || (cached.mtimeMs === stats.mtimeMs && cached.size === stats.size))) {
      return cached.keys
    }
    const content = fsSync.readFileSync(targetUri, 'utf8')
    const context = createVue3LanguageCoreContext(targetUri, content)
    const keys = collectLocalStaticKeys(targetUri, context.lineStarts, contextSegments(context))
    cache.set(targetUri, { mtimeMs: stats.mtimeMs, size: stats.size, keys })
    return keys
  } catch {
    const keys = new Map<string, StaticKeyInfo>()
    cache.set(targetUri, { mtimeMs: -1, size: -1, keys })
    return keys
  }
}

function staticSymbolKey(uri: string, name: string): string {
  return `symbol:${uri}:${name}`
}

function isSymbolInitializer(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) {
    return false
  }
  if (isIdentifierText(node.expression, 'Symbol')) {
    return true
  }
  return ts.isPropertyAccessExpression(node.expression)
    && isIdentifierText(node.expression.expression, 'Symbol')
    && node.expression.name.text === 'for'
}

function collectExposeMethods(
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): MethodInfo[] {
  const setup = context.scriptSetupSegment
  if (!setup) {
    return []
  }
  const localFunctions = collectLocalFunctions(setup)
  const methods: MethodInfo[] = []

  visit(setup.ast, (node) => {
    if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'defineExpose')) {
      return
    }
    const typeArg = node.typeArguments?.[0]
    if (typeArg) {
      methods.push(...readExposedTypeMethods(context, imports, typeArg, workspaceRoots, readTypeSource))
    }
    const arg = node.arguments[0] ? skipExpressionNoise(node.arguments[0]) : undefined
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      return
    }
    for (const property of arg.properties) {
      const method = readExposeObjectMethod(setup, property, localFunctions)
      if (method) {
        methods.push(method)
      }
    }
  })

  return dedupeMethods(methods)
}

function collectLocalFunctions(segment: ScriptSegment): Map<string, LocalFunctionInfo> {
  const functions = new Map<string, LocalFunctionInfo>()
  for (const statement of segment.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const span = absoluteSpan(segment, statement.name)
      functions.set(statement.name.text, {
        name: statement.name.text,
        span,
        detail: statement.getText(segment.ast).trim(),
        signature: functionSignature(statement.name.text, statement, segment.ast),
        sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span },
      })
      continue
    }
    if (!ts.isVariableStatement(statement)) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue
      }
      const initializer = skipExpressionNoise(declaration.initializer)
      if (!isFunctionLikeExpression(initializer)) {
        continue
      }
      const span = absoluteSpan(segment, declaration.name)
      functions.set(declaration.name.text, {
        name: declaration.name.text,
        span,
        detail: declaration.getText(segment.ast).trim(),
        signature: functionSignature(declaration.name.text, initializer, segment.ast),
        sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span },
      })
    }
  }
  return functions
}

function readExposeObjectMethod(segment: ScriptSegment, property: ts.ObjectLiteralElementLike, localFunctions: Map<string, LocalFunctionInfo>): MethodInfo | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    const local = localFunctions.get(property.name.text)
    return local
      ? { ...localFunctionToMethod(local), span: absoluteSpan(segment, property.name) }
      : undefined
  }
  if (ts.isMethodDeclaration(property) && property.name) {
    const name = propertyNameText(property.name)
    if (!name) {
      return undefined
    }
    const span = absoluteSpan(segment, property.name)
    return {
      name,
      span,
      detail: property.getText(segment.ast).trim(),
      signature: functionSignature(name, property, segment.ast),
      sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span },
    }
  }
  if (!ts.isPropertyAssignment(property)) {
    return undefined
  }
  const name = propertyNameText(property.name)
  if (!name) {
    return undefined
  }
  const initializer = skipExpressionNoise(property.initializer)
  if (ts.isIdentifier(initializer)) {
    const local = localFunctions.get(initializer.text)
    return local ? { ...localFunctionToMethod(local), name, span: absoluteSpan(segment, property.name) } : undefined
  }
  if (!isFunctionLikeExpression(initializer)) {
    return undefined
  }
  const span = absoluteSpan(segment, property.name)
    return {
      name,
      span,
      detail: property.getText(segment.ast).trim(),
      signature: functionSignature(name, initializer, segment.ast),
      sourceLocation: { uri: segment.uri, lineStarts: segment.lineStarts, span },
    }
  }

function readExposedTypeMethods(
  context: Vue3LanguageCoreContext,
  imports: ImportInfo[],
  typeNode: ts.TypeNode,
  workspaceRoots: string[],
  readTypeSource: (uri: string) => TypeSource | undefined,
): MethodInfo[] {
  return readSlotTypeMembers(context.uri, context.lineStarts, contextSegments(context), imports, typeNode, workspaceRoots, readTypeSource)
    .map((slot): MethodInfo => ({
      name: slot.name,
      span: slot.span,
      detail: slot.detail,
      signature: `${slot.name}(...)`,
      documentation: slot.documentation,
      sourceLocation: slot.sourceLocation,
    }))
}

function localFunctionToMethod(local: LocalFunctionInfo): MethodInfo {
  return {
    name: local.name,
    span: local.span,
    detail: local.detail,
    signature: local.signature,
    sourceLocation: local.sourceLocation,
  }
}

function functionSignature(name: string, node: ts.SignatureDeclaration | ts.FunctionExpression | ts.ArrowFunction, sourceFile: ts.SourceFile): string {
  const parameters = node.parameters.map((param) => param.getText(sourceFile)).join(', ')
  return `${name}(${parameters})`
}

function isFunctionLikeExpression(node: ts.Expression): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

function collectPropUsages(context: Vue3LanguageCoreContext, propsState: PropsState): Vue3PropUsage[] {
  if (propsState.props.length === 0) {
    return []
  }
  const propNames = propsState.props.map((prop) => prop.name).filter(isIdentifierName)
  const propSet = new Set(propNames)
  const usages: Vue3PropUsage[] = []
  const setup = context.scriptSetupSegment
  if (setup) {
    visit(setup.ast, (node) => {
      const start = setup.start + node.getStart(setup.ast)
      if (start < propsState.callEnd) {
        return
      }
      if (propsState.objectName && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === propsState.objectName && propSet.has(node.name.text)) {
        usages.push({ propName: node.name.text, span: absoluteSpan(setup, node.name) })
        return
      }
      if (ts.isIdentifier(node)) {
        const propName = propsState.destructured.get(node.text)
        if (propName && !isDeclarationName(node) && start >= propsState.callEnd) {
          usages.push({ propName, span: absoluteSpan(setup, node) })
        }
      }
    })
  }

  if (context.template && context.templateAst) {
    for (const expression of collectTemplateExpressions(context.templateAst, context.template.start)) {
      usages.push(...collectPropUsagesFromExpression(expression.content, expression.start, propSet, propsState))
    }
  }
  return dedupePropUsages(usages)
}

function collectPropUsagesFromExpression(expression: string, expressionStart: number, propNames: Set<string>, propsState: PropsState): Vue3PropUsage[] {
  const source = createSourceFile('template-expression.ts', expression)
  const usages: Vue3PropUsage[] = []
  visit(source, (node) => {
    if (propsState.objectName && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === propsState.objectName && propNames.has(node.name.text)) {
      usages.push({
        propName: node.name.text,
        span: { start: expressionStart + node.name.getStart(source), end: expressionStart + node.name.getEnd() },
      })
      return
    }
    if (!ts.isIdentifier(node) || isDeclarationName(node)) {
      return
    }
    const directProp = propNames.has(node.text) ? node.text : undefined
    const destructuredProp = propsState.destructured.get(node.text)
    const propName = destructuredProp ?? directProp
    if (!propName) {
      return
    }
    usages.push({
      propName,
      span: { start: expressionStart + node.getStart(source), end: expressionStart + node.getEnd() },
    })
  })
  return usages.filter((usage) => usage.span.start >= expressionStart)
}

function collectTemplateExpressions(templateAst: unknown, templateStart: number): Array<{ content: string, start: number }> {
  const expressions: Array<{ content: string, start: number }> = []
  const visitNode = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (node.type === 5 && node.content?.content !== undefined) {
      expressions.push({ content: node.content.content, start: templateStart + node.content.loc.start.offset })
    }
    if (node.type === 1 && Array.isArray(node.props)) {
      for (const prop of node.props) {
        if (prop.type === 7 && prop.exp?.content) {
          expressions.push({ content: prop.exp.content, start: templateStart + prop.exp.loc.start.offset })
        }
      }
    }
    for (const child of node.children ?? []) {
      visitNode(child)
    }
  }
  visitNode(templateAst)
  return expressions
}

function collectTemplateRefMethodCalls(context: Vue3LanguageCoreContext): RefMethodAccess[] {
  const results: RefMethodAccess[] = []
  for (const segment of contextSegments(context)) {
    const templateRefNames = collectUseTemplateRefNames(segment)
    const aliases = collectRefAliases(segment)
    visit(segment.ast, (node) => {
      if (!ts.isCallExpression(node)) {
        return
      }
      const callee = skipExpressionNoise(node.expression)
      if (!ts.isPropertyAccessExpression(callee)) {
        return
      }
      const refName = resolveRefOwnerName(callee.expression, templateRefNames, aliases)
      if (!refName) {
        return
      }
      results.push({
        refName,
        methodName: callee.name.text,
        methodSpan: absoluteSpan(segment, callee.name),
      })
    })
  }
  return dedupeRefMethodCalls(results)
}

function collectUseTemplateRefNames(segment: ScriptSegment): Map<string, string> {
  const refs = new Map<string, string>()
  visit(segment.ast, (node) => {
    if (!ts.isCallExpression(node) || !isIdentifierText(node.expression, 'useTemplateRef')) {
      return
    }
    const declaration = nearestVariableDeclaration(node)
    const literal = firstStringLiteralArg(node)
    if (declaration?.name && ts.isIdentifier(declaration.name) && literal) {
      refs.set(declaration.name.text, literal.text)
      return
    }
    const assigned = readAssignedIdentifierBefore(segment, node)
    if (assigned && literal) {
      refs.set(assigned.name, literal.text)
    }
  })
  return refs
}

function collectRefAliases(segment: ScriptSegment): Map<string, string> {
  const aliases = new Map<string, string>()
  visit(segment.ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const refName = readRefsAccess(skipExpressionNoise(node.initializer))
      if (refName) {
        aliases.set(node.name.text, refName)
      }
      return
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const refName = readRefsAccess(skipExpressionNoise(node.right))
      if (refName) {
        aliases.set(expressionKey(node.left), refName)
      }
    }
  })
  return aliases
}

function resolveRefOwnerName(expression: ts.Expression, templateRefNames: Map<string, string>, aliases: Map<string, string>): string | undefined {
  const owner = skipExpressionNoise(expression)
  const ownerExpression = ts.isPropertyAccessExpression(owner) ? skipExpressionNoise(owner.expression) : undefined
  if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'value' && ownerExpression && ts.isIdentifier(ownerExpression)) {
    const localName = ownerExpression.text
    return templateRefNames.get(localName) ?? localName
  }
  const key = expressionKey(owner)
  return aliases.get(key)
}

function readRefsAccess(expression: ts.Expression): string | undefined {
  const node = skipExpressionNoise(expression)
  if (!ts.isPropertyAccessExpression(node)) {
    return undefined
  }
  const refName = node.name.text
  const owner = skipExpressionNoise(node.expression)
  if (ts.isPropertyAccessExpression(owner) && owner.name.text === '$refs') {
    return refName
  }
  return undefined
}

function parseScriptRefComponentUsages(context: Vue3LanguageCoreContext, imports: ImportInfo[], workspaceRoots: string[]): TemplateComponentUsage[] {
  const usages: TemplateComponentUsage[] = []
  const importByLocal = new Map(imports.map((item) => [item.localName, item]))
  for (const segment of contextSegments(context)) {
    visit(segment.ast, (node) => {
      if (!ts.isCallExpression(node) || !isIdentifierText(skipExpressionNoise(node.expression), 'h')) {
        return
      }
      const component = node.arguments[0] ? skipExpressionNoise(node.arguments[0]) : undefined
      const props = node.arguments[1] ? skipExpressionNoise(node.arguments[1]) : undefined
      if (!component || !ts.isIdentifier(component) || !props || !ts.isObjectLiteralExpression(props)) {
        return
      }
      const imported = importByLocal.get(component.text)
      const targetUri = imported ? resolveImportPathWithExtensions(context.uri, imported.source, workspaceRoots, ['.vue']) : undefined
      if (!targetUri) {
        return
      }
      const refProp = findObjectProperty(props, 'ref')
      const literal = refProp && ts.isPropertyAssignment(refProp) ? skipExpressionNoise(refProp.initializer) : undefined
      if (!literal || !ts.isStringLiteralLike(literal)) {
        return
      }
      usages.push({
        tag: component.text,
        span: absoluteSpan(segment, component),
        attrs: [{
          kind: 'ref',
          name: literal.text,
          normalizedName: literal.text,
          span: absoluteSpan(segment, literal),
          fullSpan: refProp && 'name' in refProp && refProp.name ? absoluteSpan(segment, refProp.name) : absoluteSpan(segment, literal),
        }],
        binds: [],
        slots: [],
      })
    })
  }
  return usages
}

function collectComposableReturnMethodNames(source: TypeSource): Map<string, string[]> {
  const namesByExport = new Map<string, string[]>()
  for (const segment of source.segments) {
    for (const statement of segment.ast.statements) {
      if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(statement)
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
            continue
          }
          const methods = readComposableReturnMethodsFromFunction(skipExpressionNoise(declaration.initializer), source, segment)
          if (methods.length > 0) {
            namesByExport.set(declaration.name.text, methods)
            if (exported && hasDefaultModifier(statement)) {
              namesByExport.set('default', methods)
            }
          }
        }
        continue
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const methods = readComposableReturnMethodsFromFunction(statement, source, segment)
        if (methods.length > 0) {
          namesByExport.set(statement.name.text, methods)
          if (hasDefaultModifier(statement)) {
            namesByExport.set('default', methods)
          }
        }
        continue
      }
      if (ts.isExportAssignment(statement)) {
        const target = skipExpressionNoise(statement.expression)
        if (ts.isIdentifier(target)) {
          const methods = namesByExport.get(target.text)
          if (methods) {
            namesByExport.set('default', methods)
          }
        }
      }
    }
  }
  return namesByExport
}

function readComposableReturnMethodsFromFunction(node: ts.Node, source: TypeSource, segment: ScriptSegment): string[] {
  if (ts.isArrowFunction(node)) {
    if (node.type) {
      const typedMethods = readMethodNamesFromTypeNode(node.type, source, segment)
      if (typedMethods.length > 0) {
        return typedMethods
      }
    }
    const body = skipExpressionNoise(node.body as ts.Expression)
    return ts.isObjectLiteralExpression(body) ? readMethodNamesFromObject(body) : []
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    if (node.type) {
      const typedMethods = readMethodNamesFromTypeNode(node.type, source, segment)
      if (typedMethods.length > 0) {
        return typedMethods
      }
    }
    if (!node.body) {
      return []
    }
    const methods: string[] = []
    visit(node.body, (child) => {
      const expression = ts.isReturnStatement(child) && child.expression ? skipExpressionNoise(child.expression) : undefined
      if (expression && ts.isObjectLiteralExpression(expression)) {
        methods.push(...readMethodNamesFromObject(expression))
      }
    })
    return uniqueStrings(methods)
  }
  return []
}

function readMethodNamesFromTypeNode(typeNode: ts.TypeNode, source: TypeSource, segment: ScriptSegment): string[] {
  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members
      .map((member) => ('name' in member && member.name ? propertyNameText(member.name) : undefined))
      .filter((name): name is string => Boolean(name))
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const declaration = findTypeDeclaration(source.segments, typeNode.typeName.text)
    if (!declaration) {
      return []
    }
    if (ts.isInterfaceDeclaration(declaration.node)) {
      return declaration.node.members
        .map((member) => ('name' in member && member.name ? propertyNameText(member.name) : undefined))
        .filter((name): name is string => Boolean(name))
    }
    return readMethodNamesFromTypeNode(declaration.node.type, source, declaration.segment)
  }
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return readMethodNamesFromTypeNode(typeNode.type, source, segment)
  }
  if (ts.isIntersectionTypeNode(typeNode)) {
    return uniqueStrings(typeNode.types.flatMap((type) => readMethodNamesFromTypeNode(type, source, segment)))
  }
  return []
}

function readMethodNamesFromObject(object: ts.ObjectLiteralExpression): string[] {
  return uniqueStrings(object.properties
    .map((member) => ('name' in member && member.name ? propertyNameText(member.name) : undefined))
    .filter((name): name is string => Boolean(name)))
}

function hasVue3StandaloneScriptRelations(content: string): boolean {
  return content.includes('.vue')
    || content.includes('$refs')
    || content.includes('useTemplateRef')
    || /\bh\s*\(/.test(maskStringsAndComments(content))
    || hasComposableReturnUsageShape(content)
}

function hasComposableReturnUsageShape(content: string): boolean {
  const searchableContent = maskStringsAndComments(content)
  return /\bimport\b/.test(searchableContent)
    && /\b(?:const|let|var)\s*\{[\s\S]*?\}\s*=/.test(searchableContent)
}

function absoluteSpan(segment: ScriptSegment, node: ts.Node): TextSpan {
  return {
    start: segment.start + node.getStart(segment.ast),
    end: segment.start + node.getEnd(),
  }
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

function findObjectProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    return 'name' in property && property.name && propertyNameText(property.name) === name
  })
}

function nearestVariableDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isVariableDeclaration(current)) {
      return current
    }
    if (ts.isStatement(current)) {
      return undefined
    }
    current = current.parent
  }
  return undefined
}

function firstStringLiteralArg(call: ts.CallExpression): ts.StringLiteralLike | undefined {
  const arg = call.arguments[0] ? skipExpressionNoise(call.arguments[0]) : undefined
  return arg && ts.isStringLiteralLike(arg) ? arg : undefined
}

function skipExpressionNoise<T extends ts.Node>(node: T): T
function skipExpressionNoise(node: ts.Expression): ts.Expression
function skipExpressionNoise(node: ts.Node): ts.Node {
  let current = node
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isIdentifierText(node: ts.Node, text: string): node is ts.Identifier {
  return ts.isIdentifier(node) && node.text === text
}

function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name)
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isImportSpecifier(parent) && parent.name === node)
    || (ts.isImportClause(parent) && parent.name === node)
}

function expressionKey(expression: ts.Node): string {
  const node = skipExpressionNoise(expression)
  if (ts.isIdentifier(node)) {
    return node.text
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this'
  }
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionKey(node.expression)}.${node.name.text}`
  }
  return ''
}

function readJsDoc(node: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node)
    .map((item) => item.getText())
    .filter((text) => text.startsWith('/**'))
  if (docs.length === 0) {
    return undefined
  }
  return docs[docs.length - 1]
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node)
  ts.forEachChild(node, (child) => visit(child, visitor))
}

function readTextIfExists(uri: string): string | undefined {
  try {
    return fsSync.readFileSync(uri, 'utf8')
  } catch {
    return undefined
  }
}

function isScriptFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.jsx') || file.endsWith('.tsx')
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>, cloneValue: (value: V) => V = (value) => value): void {
  target.clear()
  for (const [key, value] of source) {
    target.set(key, cloneValue(value))
  }
}

function cloneStaticKeyCacheEntry(entry: StaticKeyCacheEntry): StaticKeyCacheEntry {
  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    keys: new Map(entry.keys),
  }
}

function cloneForwardedRefMethodNameCacheEntry(entry: ForwardedRefMethodNameCacheEntry): ForwardedRefMethodNameCacheEntry {
  return {
    mtimeMs: entry.mtimeMs,
    size: entry.size,
    methodsByExportName: new Map([...entry.methodsByExportName].map(([name, methods]) => [name, [...methods]])),
  }
}

function dedupeProps(props: PropInfo[]): PropInfo[] {
  return dedupeBy(props, (prop) => `${prop.name}\0${prop.sourceLocation?.uri ?? ''}\0${prop.span.start}\0${prop.span.end}`)
}

function dedupeEmits(emits: EmitInfo[]): EmitInfo[] {
  return dedupeBy(emits, (emit) => `${emit.eventName}\0${emit.eventSpan.start}\0${emit.eventSpan.end}`)
}

function dedupeSlots(slots: SlotInfo[]): SlotInfo[] {
  return dedupeBy(slots, (slot) => `${slot.name}\0${slot.sourceLocation?.uri ?? ''}\0${slot.span.start}\0${slot.span.end}`)
}

function dedupeMethods(methods: MethodInfo[]): MethodInfo[] {
  const byName = new Map<string, MethodInfo>()
  for (const method of methods) {
    byName.set(method.name, method)
  }
  return [...byName.values()]
}

function dedupeProvides(provides: ProvideInfo[]): ProvideInfo[] {
  return dedupeBy(provides, (provide) => `${provide.key}\0${provide.keySpan.start}\0${provide.keySpan.end}`)
}

function dedupeInjects(injects: InjectInfo[]): InjectInfo[] {
  return dedupeBy(injects, (inject) => `${inject.localName}\0${inject.key}\0${inject.keySpan.start}\0${inject.keySpan.end}`)
}

function dedupePropUsages(usages: Vue3PropUsage[]): Vue3PropUsage[] {
  return dedupeBy(usages, (usage) => `${usage.propName}\0${usage.span.start}\0${usage.span.end}`)
}

function dedupeRefMethodCalls(calls: RefMethodAccess[]): RefMethodAccess[] {
  return dedupeBy(calls, (call) => `${call.refName}\0${call.methodName}\0${call.methodSpan.start}\0${call.methodSpan.end}\0${call.forwarded ? '1' : '0'}`)
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const results: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(item)
  }
  return results
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)]
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function hasDefaultModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
}

function isUnreadableFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTDIR'
}

function clearMapEntriesInRoot<T>(cache: Map<string, T>, inRoot: (uri: string) => boolean): void {
  for (const uri of [...cache.keys()]) {
    if (inRoot(uri)) {
      cache.delete(uri)
    }
  }
}

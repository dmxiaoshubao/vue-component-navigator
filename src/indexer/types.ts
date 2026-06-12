export interface TextPosition {
  line: number
  character: number
}

export interface TextRange {
  start: TextPosition
  end: TextPosition
}

export interface TextSpan {
  start: number
  end: number
}

export interface SourceLocation {
  uri: string
  lineStarts: number[]
  span: TextSpan
}

export interface SfcBlock {
  content: string
  start: number
  end: number
}

export interface ParsedSfc {
  uri: string
  fileName: string
  content: string
  lineStarts: number[]
  script?: SfcBlock
  template?: SfcBlock
}

export interface ImportInfo {
  localName: string
  source: string
  importedName?: string
}

export interface MixinReference {
  localName: string
  source?: string
  importedName?: string
  targetUri?: string
  span: TextSpan
}

export interface ComponentRegistration {
  tag: string
  localName: string
  source?: string
  targetUri?: string
  nameSpan: TextSpan
}

export interface StaticComponentNameBinding {
  variableName: string
  tags: string[]
  kind: 'literal' | 'map' | 'array' | 'expression'
  expression?: string
}

export interface GlobalComponentRegistration {
  tag: string
  localName: string
  source?: string
  targetUri?: string
  usesImportedName?: boolean
  nameSpan: TextSpan
  registerSpan: TextSpan
  fileUri: string
}

export interface GlobalComponentContext {
  source: string
  targetUri: string
  nameSpan: TextSpan
  registerSpan: TextSpan
  fileUri: string
}

export interface PropInfo {
  name: string
  span: TextSpan
  detail: string
  documentation?: string
  sourceLocation?: SourceLocation
}

export interface MethodInfo {
  name: string
  span: TextSpan
  detail: string
  signature: string
  documentation?: string
  sourceLocation?: SourceLocation
}

export interface EmitInfo {
  eventName: string
  eventSpan: TextSpan
  callSpan: TextSpan
  sourceLocation?: SourceLocation
}

export interface ProvideInfo {
  key: string
  keySpan: TextSpan
  detail: string
  documentation?: string
  sourceLocation?: SourceLocation
}

export interface InjectInfo {
  key: string
  keySpan: TextSpan
  localName: string
  localSpan: TextSpan
  detail: string
  sourceLocation?: SourceLocation
}

export interface ScriptIndex {
  componentName?: string
  imports: ImportInfo[]
  mixins: MixinReference[]
  components: ComponentRegistration[]
  staticComponentNames: StaticComponentNameBinding[]
  props: PropInfo[]
  methods: MethodInfo[]
  emits: EmitInfo[]
  provides: ProvideInfo[]
  injects: InjectInfo[]
}

export interface TemplateAttrUsage {
  kind: 'ref' | 'prop' | 'event'
  name: string
  normalizedName: string
  span: TextSpan
  fullSpan: TextSpan
}

export interface TemplateComponentUsage {
  tag: string
  dynamicTags?: string[]
  span: TextSpan
  attrs: TemplateAttrUsage[]
}

export interface TemplateIndex {
  components: TemplateComponentUsage[]
  emits: EmitInfo[]
}

export interface VueFileIndex {
  uri: string
  fileName: string
  content: string
  searchableContent: string
  lineStarts: number[]
  script?: SfcBlock
  template?: SfcBlock
  scriptIndex: ScriptIndex
  templateIndex: TemplateIndex
  refMethodCalls: RefMethodAccess[]
}

export interface RefMethodAccess {
  refName: string
  methodName: string
  methodSpan: TextSpan
  sourceLocation?: SourceLocation
}

export interface UsageInfo {
  file: VueFileIndex
  span: TextSpan
  sourceLocation?: SourceLocation
}

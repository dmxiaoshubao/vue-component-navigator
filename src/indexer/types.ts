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
}

export interface ComponentRegistration {
  tag: string
  localName: string
  source?: string
  targetUri?: string
  nameSpan: TextSpan
}

export interface PropInfo {
  name: string
  span: TextSpan
  detail: string
  documentation?: string
}

export interface MethodInfo {
  name: string
  span: TextSpan
  detail: string
  signature: string
  documentation?: string
}

export interface EmitInfo {
  eventName: string
  eventSpan: TextSpan
  callSpan: TextSpan
}

export interface ScriptIndex {
  componentName?: string
  imports: ImportInfo[]
  components: ComponentRegistration[]
  props: PropInfo[]
  methods: MethodInfo[]
  emits: EmitInfo[]
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
  span: TextSpan
  attrs: TemplateAttrUsage[]
}

export interface TemplateIndex {
  components: TemplateComponentUsage[]
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
}

export interface UsageInfo {
  file: VueFileIndex
  span: TextSpan
}

import fsSync from 'node:fs'
import type { ComponentRegistration, ImportInfo, InjectInfo, MethodInfo, ParsedSfc, PropInfo, ProvideInfo, ScriptIndex, SlotInfo, SourceLocation, SfcBlock, TextSpan, Vue3PropTypeInfo, Vue3PropUsage } from './types'
import { parseSfc } from './sfcParser'
import { collectStaticComponentNameBindings, parseImports } from './scriptParser'
import { resolveImportPathWithExtensions } from './relationResolver'
import { createLineStarts } from '../utils/position'
import { findCodeToken, maskStringsAndComments, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

interface ScriptSegment {
  content: string
  start: number
}

interface DefinePropsInfo {
  typeName?: string
  typeSpan?: TextSpan
  callEnd: number
  objectName?: string
  destructured: Map<string, string>
  inlineProps?: PropInfo[]
}

interface TypeMemberResult {
  typeInfo?: Vue3PropTypeInfo
  props: PropInfo[]
}

interface TypeObjectResolution {
  content: string
  objectStart: number
  objectEnd: number
  segmentStart: number
  location: Omit<SourceLocation, 'span'>
  typeSpan: TextSpan
}

interface TypeFileContent {
  lineStarts: number[]
  segments: ScriptSegment[]
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

interface CallKeyArgument {
  key: string
  label: string
  span: TextSpan
  callEnd: number
  keySourceLocation?: SourceLocation
}

export type Vue3ScriptParseCache = Map<string, unknown>

export function createVue3ScriptParseCache(): Vue3ScriptParseCache {
  return new Map()
}

function emptyScriptIndex(imports: ImportInfo[] = []): ScriptIndex {
  return {
    imports,
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

function skipWhitespace(content: string, index: number): number {
  let cursor = index
  while (cursor < content.length && /\s/.test(content[cursor])) {
    cursor += 1
  }
  return cursor
}

function skipTrivia(content: string, index: number): number {
  let cursor = skipWhitespace(content, index)
  while (cursor < content.length) {
    if (content.startsWith('//', cursor)) {
      const lineEnd = content.indexOf('\n', cursor + 2)
      cursor = skipWhitespace(content, lineEnd === -1 ? content.length : lineEnd + 1)
      continue
    }
    if (content.startsWith('/*', cursor)) {
      const commentEnd = content.indexOf('*/', cursor + 2)
      cursor = skipWhitespace(content, commentEnd === -1 ? content.length : commentEnd + 2)
      continue
    }
    break
  }
  return cursor
}

function readIdentifier(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(content.slice(index))
  if (!match) {
    return undefined
  }
  return { value: match[0], start: index, end: index + match[0].length }
}

function isIdentifierChar(char: string | undefined): boolean {
  return Boolean(char && /[\w$]/.test(char))
}

function isCodeTokenAt(content: string, token: string, index: number): boolean {
  return content.startsWith(token, index)
    && !isIdentifierChar(content[index - 1])
    && !isIdentifierChar(content[index + token.length])
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

function findMatchingAngle(content: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (content[index] === '<') {
      depth += 1
    } else if (content[index] === '>') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

function findCallEnd(content: string, fromIndex: number): number {
  const open = skipTrivia(content, fromIndex)
  if (content[open] !== '(') {
    return fromIndex
  }
  return findMatchingBracket(content, open) + 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniqueBySpan(usages: Vue3PropUsage[]): Vue3PropUsage[] {
  const seen = new Set<string>()
  const results: Vue3PropUsage[] = []
  for (const usage of usages) {
    const key = `${usage.propName}\0${usage.span.start}\0${usage.span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(usage)
  }
  return results
}

function normalizeJSDoc(comment: string): string {
  return comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

function readLeadingTypeTrivia(content: string, index: number): { cursor: number, documentation?: string } {
  let cursor = skipWhitespace(content, index)
  let documentation: string | undefined

  while (cursor < content.length) {
    if (content.startsWith('//', cursor)) {
      const lineEnd = content.indexOf('\n', cursor + 2)
      cursor = skipWhitespace(content, lineEnd === -1 ? content.length : lineEnd + 1)
      documentation = undefined
      continue
    }
    if (content.startsWith('/*', cursor)) {
      const commentEnd = content.indexOf('*/', cursor + 2)
      const end = commentEnd === -1 ? content.length : commentEnd + 2
      const comment = content.slice(cursor, end)
      documentation = comment.startsWith('/**') ? normalizeJSDoc(comment) : undefined
      cursor = skipWhitespace(content, end)
      continue
    }
    break
  }

  return { cursor, documentation }
}

function findMemberEnd(content: string, start: number, objectEnd: number): number {
  let depth = 0
  for (let index = start; index < objectEnd; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = content[index]
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (char === ';' || char === ',' || char === '\n')) {
      return index
    }
  }
  return objectEnd
}

function readTypeMemberName(content: string, index: number): { value: string, start: number, end: number, rawEnd?: number } | undefined {
  const identifier = readIdentifier(content, index)
  if (identifier) {
    return identifier
  }
  const literal = readStringLiteral(content, index)
  return literal ? { value: literal.value, start: literal.start, end: literal.end, rawEnd: literal.end + 1 } : undefined
}

function parseTypeMembers(content: string, objectStart: number, objectEnd: number, location: Omit<SourceLocation, 'span'>): PropInfo[] {
  const props: PropInfo[] = []
  let index = objectStart + 1

  while (index < objectEnd) {
    const trivia = readLeadingTypeTrivia(content, index)
    index = trivia.cursor
    if (index >= objectEnd) {
      break
    }
    if (content[index] === ';' || content[index] === ',') {
      index += 1
      continue
    }

    const name = readTypeMemberName(content, index)
    if (!name) {
      index += 1
      continue
    }

    const afterName = skipWhitespace(content, name.rawEnd ?? name.end)
    if (content[afterName] !== '?' && content[afterName] !== ':' && content[afterName] !== '(') {
      index = name.end
      continue
    }

    const memberEnd = findMemberEnd(content, afterName, objectEnd)
    const span = { start: name.start, end: name.end }
    props.push({
      name: name.value,
      span,
      detail: content.slice(name.start, memberEnd).trim(),
      documentation: trivia.documentation,
      sourceLocation: { ...location, span },
    })
    index = memberEnd + 1
  }

  return props
}

function findTypeObject(content: string, typeName: string): { typeSpan: TextSpan, objectStart: number, objectEnd: number } | undefined {
  const masked = content
  for (let index = 0; index < masked.length; index += 1) {
    const skipped = skipStringCommentOrRegex(masked, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const interfaceIndex = isCodeTokenAt(masked, 'interface', index) ? index : -1
    if (interfaceIndex !== -1) {
      const name = readIdentifier(masked, skipTrivia(masked, interfaceIndex + 'interface'.length))
      if (name?.value !== typeName) {
        continue
      }
      const objectStart = masked.indexOf('{', name.end)
      if (objectStart === -1) {
        continue
      }
      return { typeSpan: { start: name.start, end: name.end }, objectStart, objectEnd: findMatchingBracket(masked, objectStart) }
    }

    const typeIndex = isCodeTokenAt(masked, 'type', index) ? index : -1
    if (typeIndex === -1) {
      continue
    }
    const name = readIdentifier(masked, skipTrivia(masked, typeIndex + 'type'.length))
    if (name?.value !== typeName) {
      continue
    }
    const equals = masked.indexOf('=', name.end)
    if (equals === -1) {
      continue
    }
    const objectStart = masked.indexOf('{', equals + 1)
    if (objectStart === -1) {
      continue
    }
    return { typeSpan: { start: name.start, end: name.end }, objectStart, objectEnd: findMatchingBracket(masked, objectStart) }
  }

  return undefined
}

function readVueScriptContent(uri: string, content: string): Array<{ content: string, start: number }> {
  if (!uri.endsWith('.vue')) {
    return [{ content, start: 0 }]
  }
  const sfc = parseSfc(uri, content)
  return [sfc.script, sfc.scriptSetup]
    .filter((block): block is SfcBlock => Boolean(block))
    .map((block) => ({ content: block.content, start: block.start }))
}

function readTypeFileContent(targetUri: string, cache: Map<string, TypeFileContent | undefined>): TypeFileContent | undefined {
  if (cache.has(targetUri)) {
    return cache.get(targetUri)
  }

  try {
    const content = fsSync.readFileSync(targetUri, 'utf8')
    const result = {
      lineStarts: createLineStarts(content),
      segments: readVueScriptContent(targetUri, content),
    }
    cache.set(targetUri, result)
    return result
  } catch {
    cache.set(targetUri, undefined)
    return undefined
  }
}

function shiftSpan(span: TextSpan, offset: number): TextSpan {
  return { start: offset + span.start, end: offset + span.end }
}

function shiftSourceLocation(sourceLocation: SourceLocation | undefined, offset: number): SourceLocation | undefined {
  return sourceLocation
    ? { ...sourceLocation, span: shiftSpan(sourceLocation.span, offset) }
    : undefined
}

function shiftPropInfo(prop: PropInfo, offset: number): PropInfo {
  return {
    ...prop,
    span: shiftSpan(prop.span, offset),
    sourceLocation: shiftSourceLocation(prop.sourceLocation, offset),
  }
}

function readNamedGenericTypeReference(content: string, genericContentStart: number, genericEnd: number, segmentStart: number): { typeName: string, typeSpan: TextSpan } | undefined {
  const typeName = readIdentifier(content, genericContentStart)
  if (!typeName) {
    return undefined
  }

  let typeEnd = skipTrivia(content, typeName.end)
  if (content[typeEnd] === '<') {
    const typeArgumentEnd = findMatchingTypeArgument(content, typeEnd)
    if (typeArgumentEnd === -1 || typeArgumentEnd > genericEnd) {
      return undefined
    }
    typeEnd = skipTrivia(content, typeArgumentEnd + 1)
  }
  if (typeEnd !== genericEnd) {
    return undefined
  }

  return {
    typeName: typeName.value,
    typeSpan: { start: segmentStart + typeName.start, end: segmentStart + typeName.end },
  }
}

function resolveTypeObject(uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], typeName: string, workspaceRoots: string[], typeFileCache: Map<string, TypeFileContent | undefined>): TypeObjectResolution | undefined {
  const imported = imports.find((item) => item.localName === typeName)
  const targetTypeName = imported?.importedName ?? typeName
  const targetUri = imported?.source
    ? resolveImportPathWithExtensions(uri, imported.source, workspaceRoots, ['.ts', '.vue'])
    : undefined

  if (targetUri) {
    const source = readTypeFileContent(targetUri, typeFileCache)
    if (!source) {
      return undefined
    }
    for (const segment of source.segments) {
      const found = findTypeObject(segment.content, targetTypeName)
      if (!found) {
        continue
      }
      return {
        content: segment.content,
        objectStart: found.objectStart,
        objectEnd: found.objectEnd,
        segmentStart: segment.start,
        location: { uri: targetUri, lineStarts: source.lineStarts },
        typeSpan: shiftSpan(found.typeSpan, segment.start),
      }
    }
  }

  for (const segment of segments) {
    const found = findTypeObject(segment.content, typeName)
    if (!found) {
      continue
    }
    return {
      content: segment.content,
      objectStart: found.objectStart,
      objectEnd: found.objectEnd,
      segmentStart: segment.start,
      location: { uri, lineStarts },
      typeSpan: shiftSpan(found.typeSpan, segment.start),
    }
  }

  return undefined
}

function resolveTypeMembers(uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], defineProps: DefinePropsInfo, workspaceRoots: string[], typeFileCache: Map<string, TypeFileContent | undefined>): TypeMemberResult | undefined {
  if (defineProps.inlineProps) {
    return { props: defineProps.inlineProps }
  }
  if (!defineProps.typeName || !defineProps.typeSpan) {
    return undefined
  }

  const resolved = resolveTypeObject(uri, lineStarts, segments, imports, defineProps.typeName, workspaceRoots, typeFileCache)
  if (resolved) {
    return {
      typeInfo: {
        name: defineProps.typeName,
        span: defineProps.typeSpan,
        sourceLocation: { ...resolved.location, span: resolved.typeSpan },
      },
      props: parseTypeMembers(resolved.content, resolved.objectStart, resolved.objectEnd, resolved.location)
        .map((prop) => shiftPropInfo(prop, resolved.segmentStart)),
    }
  }

  return {
    typeInfo: { name: defineProps.typeName, span: defineProps.typeSpan },
    props: [],
  }
}

function parseDestructureBindings(content: string): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const rawPart of content.split(',')) {
    const part = rawPart.trim().replace(/\s*=.*$/, '')
    if (!part || part.startsWith('...')) {
      continue
    }
    const alias = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(part)
    if (alias) {
      bindings.set(alias[2], alias[1])
      continue
    }
    const direct = /^([A-Za-z_$][\w$]*)$/.exec(part)
    if (direct) {
      bindings.set(direct[1], direct[1])
    }
  }
  return bindings
}

function statementStartBefore(content: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (content[cursor] === ';' || content[cursor] === '\n') {
      return cursor + 1
    }
  }
  return 0
}

function parseDefineProps(segment: ScriptSegment): DefinePropsInfo | undefined {
  const content = segment.content
  let index = 0

  while (index < content.length) {
    const defineIndex = findCodeToken(content, 'defineProps', index)
    if (defineIndex === -1) {
      return undefined
    }
    if (isIdentifierChar(content[defineIndex - 1]) || isIdentifierChar(content[defineIndex + 'defineProps'.length])) {
      index = defineIndex + 'defineProps'.length
      continue
    }

    const genericStart = skipTrivia(content, defineIndex + 'defineProps'.length)
    if (content[genericStart] !== '<') {
      index = defineIndex + 'defineProps'.length
      continue
    }
    const genericEnd = findMatchingAngle(content, genericStart)
    if (genericEnd === -1) {
      return undefined
    }
    const callEnd = segment.start + findCallEnd(content, genericEnd + 1)
    const prefix = content.slice(statementStartBefore(content, defineIndex), defineIndex)
    const objectAssignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:withDefaults\s*\(\s*)?$/.exec(prefix)
    const destructureAssignment = /(?:const|let|var)\s*\{([\s\S]*)\}\s*=\s*(?:withDefaults\s*\(\s*)?$/.exec(prefix)
    const destructured = destructureAssignment ? parseDestructureBindings(destructureAssignment[1]) : new Map<string, string>()
    const genericContentStart = skipTrivia(content, genericStart + 1)

    if (content[genericContentStart] === '{') {
      const objectEnd = findMatchingBracket(content, genericContentStart)
      if (skipTrivia(content, objectEnd + 1) !== genericEnd) {
        index = genericEnd + 1
        continue
      }
      return {
        callEnd,
        objectName: objectAssignment?.[1],
        destructured,
        inlineProps: parseTypeMembers(content, genericContentStart, objectEnd, { uri: '', lineStarts: [] })
          .map((prop) => ({
            ...prop,
            span: { start: segment.start + prop.span.start, end: segment.start + prop.span.end },
            sourceLocation: undefined,
          })),
      }
    }

    const typeReference = readNamedGenericTypeReference(content, genericContentStart, genericEnd, segment.start)
    if (!typeReference) {
      index = genericEnd + 1
      continue
    }

    return {
      typeName: typeReference.typeName,
      typeSpan: typeReference.typeSpan,
      callEnd,
      objectName: objectAssignment?.[1],
      destructured,
    }
  }

  return undefined
}

function parseDefineOptionsName(segment: ScriptSegment | undefined): string | undefined {
  if (!segment) {
    return undefined
  }
  const defineIndex = findCodeToken(segment.content, 'defineOptions')
  if (defineIndex === -1) {
    return undefined
  }
  const open = skipTrivia(segment.content, defineIndex + 'defineOptions'.length)
  if (segment.content[open] !== '(') {
    return undefined
  }
  const objectStart = skipTrivia(segment.content, open + 1)
  if (segment.content[objectStart] !== '{') {
    return undefined
  }
  const objectEnd = findMatchingBracket(segment.content, objectStart)
  const nameMatch = /(?:^|[,{])\s*name\s*:\s*(['"])([^'"]+)\1/.exec(segment.content.slice(objectStart + 1, objectEnd))
  return nameMatch?.[2]
}

function parseSetupComponents(uri: string, segment: ScriptSegment | undefined, imports: ImportInfo[], workspaceRoots: string[]): ComponentRegistration[] {
  if (!segment) {
    return []
  }
  return imports
    .map((item): ComponentRegistration | undefined => {
      const targetUri = resolveImportPathWithExtensions(uri, item.source, workspaceRoots, ['.vue'])
      if (!targetUri || !targetUri.endsWith('.vue') || !fsSync.existsSync(targetUri)) {
        return undefined
      }
      const localIndex = segment.content.indexOf(item.localName)
      const nameSpan = localIndex === -1
        ? { start: segment.start, end: segment.start }
        : { start: segment.start + localIndex, end: segment.start + localIndex + item.localName.length }
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

function scanIdentifierUsages(content: string, offset: number, name: string, propName: string, minOffset = 0): Vue3PropUsage[] {
  const usages: Vue3PropUsage[] = []
  const searchable = maskStringsAndComments(content)
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(searchable))) {
    const start = offset + match.index
    if (start < minOffset) {
      continue
    }
    usages.push({ propName, span: { start, end: start + name.length } })
  }
  return usages
}

function scanObjectPropUsages(content: string, offset: number, objectName: string, propNames: string[], minOffset = 0): Vue3PropUsage[] {
  const usages: Vue3PropUsage[] = []
  if (propNames.length === 0) {
    return usages
  }
  const searchable = maskStringsAndComments(content)
  const pattern = new RegExp(`\\b${escapeRegExp(objectName)}\\s*(?:\\?\\.|\\.)\\s*(${propNames.map(escapeRegExp).join('|')})\\b`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(searchable))) {
    const propName = match[1]
    const propStart = offset + match.index + match[0].lastIndexOf(propName)
    if (propStart < minOffset) {
      continue
    }
    usages.push({ propName, span: { start: propStart, end: propStart + propName.length } })
  }
  return usages
}

function findHtmlCommentEnd(content: string, start: number): number {
  const end = content.indexOf('-->', start + 4)
  return end === -1 ? content.length : end + 3
}

function findTemplateOpenTagEnd(content: string, openStart: number): number {
  let quote: '"' | "'" | undefined

  for (let index = openStart; index < content.length; index += 1) {
    const char = content[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') {
      return index + 1
    }
  }

  return content.length
}

function isTemplateExpressionAttrName(rawName: string): boolean {
  const name = rawName.split('.')[0]
  return name.startsWith(':')
    || name.startsWith('@')
    || name === 'v-bind'
    || name.startsWith('v-bind:')
    || name === 'v-on'
    || name.startsWith('v-on:')
    || name === 'v-model'
    || name.startsWith('v-model:')
    || ['v-if', 'v-else-if', 'v-show', 'v-for', 'v-html', 'v-text'].includes(name)
}

function extractTemplateAttrExpressions(openTag: string, openStart: number): ScriptSegment[] {
  const expressions: ScriptSegment[] = []
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const rawValue = match[2]
    if (!rawValue || !isTemplateExpressionAttrName(rawName)) {
      continue
    }

    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      expressions.push({
        content: rawValue.slice(1, -1),
        start: rawValueStart + 1,
      })
      continue
    }

    expressions.push({
      content: rawValue,
      start: rawValueStart,
    })
  }

  return expressions
}

function extractTemplateExpressions(template: SfcBlock): ScriptSegment[] {
  const expressions: ScriptSegment[] = []
  const content = template.content
  let index = 0

  while (index < content.length) {
    if (content.startsWith('<!--', index)) {
      index = findHtmlCommentEnd(content, index)
      continue
    }

    if (content.startsWith('{{', index)) {
      const close = content.indexOf('}}', index + 2)
      if (close === -1) {
        break
      }
      expressions.push({
        content: content.slice(index + 2, close),
        start: template.start + index + 2,
      })
      index = close + 2
      continue
    }

    if (content[index] === '<') {
      const openEnd = findTemplateOpenTagEnd(content, index)
      const openTag = content.slice(index, openEnd)
      if (!openTag.startsWith('</')) {
        expressions.push(...extractTemplateAttrExpressions(openTag, template.start + index))
      }
      index = openEnd
      continue
    }

    index += 1
  }

  return expressions
}

function collectVue3PropUsages(defineProps: DefinePropsInfo | undefined, props: PropInfo[], scriptSetup: ScriptSegment | undefined, template: SfcBlock | undefined): Vue3PropUsage[] {
  if (!defineProps || props.length === 0) {
    return []
  }
  const propNames = props.map((prop) => prop.name).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
  const usages: Vue3PropUsage[] = []

  if (scriptSetup) {
    const searchableScript = scriptSetup.content
    if (defineProps.objectName) {
      usages.push(...scanObjectPropUsages(searchableScript, scriptSetup.start, defineProps.objectName, propNames, defineProps.callEnd))
    }
    for (const [localName, propName] of defineProps.destructured) {
      usages.push(...scanIdentifierUsages(searchableScript, scriptSetup.start, localName, propName, defineProps.callEnd))
    }
  }

  if (template) {
    for (const expression of extractTemplateExpressions(template)) {
      if (defineProps.objectName) {
        usages.push(...scanObjectPropUsages(expression.content, expression.start, defineProps.objectName, propNames))
      }
      for (const propName of propNames) {
        usages.push(...scanIdentifierUsages(expression.content, expression.start, propName, propName))
      }
      for (const [localName, propName] of defineProps.destructured) {
        if (localName !== propName) {
          usages.push(...scanIdentifierUsages(expression.content, expression.start, localName, propName))
        }
      }
    }
  }

  return uniqueBySpan(usages)
}

function findCallOpenAfterTypeArguments(content: string, tokenEnd: number): number | undefined {
  let open = skipTrivia(content, tokenEnd)
  if (content[open] === '<') {
    const genericEnd = findMatchingTypeArgument(content, open)
    if (genericEnd === -1) {
      return undefined
    }
    open = skipTrivia(content, genericEnd + 1)
  }
  if (content[open] !== '(') {
    return undefined
  }
  return open
}

function readCallStringArgument(content: string, tokenEnd: number): { value: string, span: TextSpan, callEnd: number } | undefined {
  const open = findCallOpenAfterTypeArguments(content, tokenEnd)
  if (open === undefined) {
    return undefined
  }
  const literal = readStringLiteral(content, skipTrivia(content, open + 1))
  if (!literal) {
    return undefined
  }
  return {
    value: literal.value,
    span: { start: literal.start, end: literal.end },
    callEnd: findMatchingBracket(content, open) + 1,
  }
}

function staticSymbolKey(uri: string, name: string): string {
  // Symbol/InjectionKey 用定义位置做身份，避免同名描述串被误连。
  return `symbol:${uri}:${name}`
}

function findDeclaratorEquals(content: string, start: number): number | undefined {
  let depth = 0

  for (let index = start; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && char === '=') {
      return index
    }
    if (depth === 0 && (char === ',' || char === ';')) {
      return undefined
    }
  }

  return undefined
}

function readSymbolCallLabel(content: string, start: number): string | undefined {
  if (!isCodeTokenAt(content, 'Symbol', start)) {
    return undefined
  }

  let cursor = skipTrivia(content, start + 'Symbol'.length)
  if (content[cursor] === '.') {
    const member = readIdentifier(content, skipTrivia(content, cursor + 1))
    if (member?.value !== 'for') {
      return undefined
    }
    cursor = skipTrivia(content, member.end)
  }

  if (content[cursor] !== '(') {
    return undefined
  }

  const literal = readStringLiteral(content, skipTrivia(content, cursor + 1))
  return literal ? `Symbol('${literal.value}')` : 'Symbol()'
}

function parseLocalStaticKeys(uri: string, lineStarts: number[], segments: ScriptSegment[], neededNames?: Set<string>): Map<string, StaticKeyInfo> {
  const keys = new Map<string, StaticKeyInfo>()

  for (const segment of segments) {
    for (let index = 0; index < segment.content.length; index += 1) {
      const skipped = skipStringCommentOrRegex(segment.content, index)
      if (skipped !== undefined) {
        index = skipped - 1
        continue
      }

      const declaration = (['const', 'let', 'var'] as const).find((token) => isCodeTokenAt(segment.content, token, index))
      if (!declaration) {
        continue
      }

      const name = readIdentifier(segment.content, skipTrivia(segment.content, index + declaration.length))
      if (!name) {
        continue
      }
      if (neededNames && !neededNames.has(name.value)) {
        index = name.end
        continue
      }

      const equals = findDeclaratorEquals(segment.content, name.end)
      if (equals === undefined) {
        continue
      }

      const symbolLabel = readSymbolCallLabel(segment.content, skipTrivia(segment.content, equals + 1))
      if (!symbolLabel) {
        continue
      }

      const span = { start: segment.start + name.start, end: segment.start + name.end }
      keys.set(name.value, {
        key: staticSymbolKey(uri, name.value),
        label: name.value,
        sourceLocation: { uri, lineStarts, span },
      })
      index = equals
    }
  }

  return keys
}

function readCachedStaticKeys(targetUri: string, cache: Vue3ScriptParseCache | undefined): Map<string, StaticKeyInfo> {
  const typedCache = cache as Map<string, StaticKeyCacheEntry> | undefined
  const stat = fsSync.statSync(targetUri)
  const cached = typedCache?.get(targetUri)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.keys
  }

  const content = fsSync.readFileSync(targetUri, 'utf8')
  const lineStarts = createLineStarts(content)
  const keys = parseLocalStaticKeys(targetUri, lineStarts, readVueScriptContent(targetUri, content))
  typedCache?.set(targetUri, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    keys,
  })
  return keys
}

function resolveImportedStaticKeys(uri: string, imports: ImportInfo[], workspaceRoots: string[], neededNames: Set<string>, cache: Vue3ScriptParseCache | undefined): Map<string, StaticKeyInfo> {
  const keys = new Map<string, StaticKeyInfo>()

  for (const item of imports) {
    if (!item.importedName || item.source === 'vue' || !neededNames.has(item.localName)) {
      continue
    }

    const targetUri = resolveImportPathWithExtensions(uri, item.source, workspaceRoots, ['.ts', '.vue'])
    if (!targetUri || !fsSync.existsSync(targetUri)) {
      continue
    }

    const targetKeys = readCachedStaticKeys(targetUri, cache)
    const targetKey = targetKeys.get(item.importedName)
    if (!targetKey) {
      continue
    }

    keys.set(item.localName, {
      ...targetKey,
      label: item.localName,
    })
  }

  return keys
}

function collectCallKeyIdentifiers(segments: ScriptSegment[]): Set<string> {
  const identifiers = new Set<string>()
  for (const segment of segments) {
    for (let index = 0; index < segment.content.length; index += 1) {
      const skipped = skipStringCommentOrRegex(segment.content, index)
      if (skipped !== undefined) {
        index = skipped - 1
        continue
      }
      const token = isCodeTokenAt(segment.content, 'provide', index)
        ? 'provide'
        : isCodeTokenAt(segment.content, 'inject', index)
          ? 'inject'
          : undefined
      if (!token) {
        continue
      }
      const open = findCallOpenAfterTypeArguments(segment.content, index + token.length)
      if (open === undefined) {
        continue
      }
      const firstArg = skipTrivia(segment.content, open + 1)
      if (readStringLiteral(segment.content, firstArg)) {
        continue
      }
      const identifier = readIdentifier(segment.content, firstArg)
      if (identifier) {
        identifiers.add(identifier.value)
      }
    }
  }
  return identifiers
}

function parseStaticKeys(uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], workspaceRoots: string[], cache: Vue3ScriptParseCache | undefined): Map<string, StaticKeyInfo> {
  const neededNames = collectCallKeyIdentifiers(segments)
  if (neededNames.size === 0) {
    return new Map()
  }
  return new Map([
    ...resolveImportedStaticKeys(uri, imports, workspaceRoots, neededNames, cache),
    ...parseLocalStaticKeys(uri, lineStarts, segments, neededNames),
  ])
}

function readCallKeyArgument(content: string, tokenEnd: number, staticKeys: Map<string, StaticKeyInfo>): CallKeyArgument | undefined {
  const open = findCallOpenAfterTypeArguments(content, tokenEnd)
  if (open === undefined) {
    return undefined
  }

  const firstArg = skipTrivia(content, open + 1)
  const literal = readStringLiteral(content, firstArg)
  const callEnd = findMatchingBracket(content, open) + 1
  if (literal) {
    return {
      key: literal.value,
      label: literal.value,
      span: { start: literal.start, end: literal.end },
      callEnd,
    }
  }

  const identifier = readIdentifier(content, firstArg)
  if (!identifier) {
    return undefined
  }

  const staticKey = staticKeys.get(identifier.value)
  if (!staticKey) {
    return undefined
  }

  return {
    key: staticKey.key,
    label: staticKey.label,
    span: { start: identifier.start, end: identifier.end },
    callEnd,
    keySourceLocation: staticKey.sourceLocation,
  }
}

function findMatchingTypeArgument(content: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (content[index] === '<') {
      depth += 1
      continue
    }
    if (content[index] === '>' && content[index - 1] !== '=') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

function parseEmitVariables(segment: ScriptSegment | undefined): string[] {
  if (!segment) {
    return []
  }
  const variables = new Set<string>()
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*defineEmits\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(segment.content))) {
    variables.add(match[1])
  }
  return [...variables]
}

function parseSetupEmitCalls(segment: ScriptSegment | undefined): ScriptIndex['emits'] {
  if (!segment) {
    return []
  }
  const emits: ScriptIndex['emits'] = []
  const variables = parseEmitVariables(segment)
  for (const variable of variables) {
    for (let index = 0; index < segment.content.length; index += 1) {
      const skipped = skipStringCommentOrRegex(segment.content, index)
      if (skipped !== undefined) {
        index = skipped - 1
        continue
      }
      if (!isCodeTokenAt(segment.content, variable, index)) {
        continue
      }
      const arg = readCallStringArgument(segment.content, index + variable.length)
      if (!arg) {
        continue
      }
      emits.push({
        eventName: arg.value,
        eventSpan: { start: segment.start + arg.span.start, end: segment.start + arg.span.end },
        callSpan: { start: segment.start + index, end: segment.start + arg.callEnd },
      })
    }
  }
  return emits
}

function parseObjectEmitDeclarations(content: string, objectStart: number, objectEnd: number, segmentStart: number, callSpan: TextSpan, location?: Omit<SourceLocation, 'span'>): ScriptIndex['emits'] {
  const emits: ScriptIndex['emits'] = []
  let index = objectStart + 1

  while (index < objectEnd) {
    const trivia = readLeadingTypeTrivia(content, index)
    index = trivia.cursor
    if (index >= objectEnd) {
      break
    }
    if (content[index] === ';' || content[index] === ',') {
      index += 1
      continue
    }

    if (content[index] === '(') {
      const signatureEnd = findMatchingBracket(content, index)
      for (let cursor = index + 1; cursor < signatureEnd; cursor += 1) {
        const literal = readStringLiteral(content, cursor)
        if (literal) {
          const eventSpan = shiftSpan({ start: literal.start, end: literal.end }, segmentStart)
          emits.push({
            eventName: literal.value,
            eventSpan,
            callSpan,
            sourceLocation: location ? { ...location, span: eventSpan } : undefined,
            declared: true,
          })
          break
        }
        const skipped = skipStringCommentOrRegex(content, cursor)
        if (skipped !== undefined) {
          cursor = skipped - 1
          continue
        }
      }
      index = findMemberEnd(content, signatureEnd + 1, objectEnd) + 1
      continue
    }

    const name = readTypeMemberName(content, index)
    if (!name) {
      index += 1
      continue
    }
    const afterName = skipWhitespace(content, name.rawEnd ?? name.end)
    if (content[afterName] !== '?' && content[afterName] !== ':' && content[afterName] !== '(') {
      index = name.end
      continue
    }
    const memberEnd = findMemberEnd(content, afterName, objectEnd)
    const eventSpan = shiftSpan({ start: name.start, end: name.end }, segmentStart)
    emits.push({
      eventName: name.value,
      eventSpan,
      callSpan,
      sourceLocation: location ? { ...location, span: eventSpan } : undefined,
      declared: true,
    })
    index = memberEnd + 1
  }

  return emits
}

function parseArrayEmitDeclarations(content: string, arrayStart: number, segmentStart: number, callSpan: TextSpan): ScriptIndex['emits'] {
  const emits: ScriptIndex['emits'] = []
  const arrayEnd = findMatchingBracket(content, arrayStart)
  for (let index = arrayStart + 1; index < arrayEnd; index += 1) {
    const literal = readStringLiteral(content, index)
    if (literal) {
      emits.push({
        eventName: literal.value,
        eventSpan: { start: segmentStart + literal.start, end: segmentStart + literal.end },
        callSpan,
        declared: true,
      })
      index = literal.end
      continue
    }
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
  }
  return emits
}

function parseDefineEmitsDeclarations(segment: ScriptSegment | undefined, uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], workspaceRoots: string[], typeFileCache: Map<string, TypeFileContent | undefined>): ScriptIndex['emits'] {
  if (!segment) {
    return []
  }
  const emits: ScriptIndex['emits'] = []
  let index = 0

  while (index < segment.content.length) {
    const defineIndex = findCodeToken(segment.content, 'defineEmits', index)
    if (defineIndex === -1) {
      break
    }
    if (isIdentifierChar(segment.content[defineIndex - 1]) || isIdentifierChar(segment.content[defineIndex + 'defineEmits'.length])) {
      index = defineIndex + 'defineEmits'.length
      continue
    }

    const afterDefine = skipTrivia(segment.content, defineIndex + 'defineEmits'.length)
    let callEnd = segment.start + findCallEnd(segment.content, afterDefine)
    if (segment.content[afterDefine] === '<') {
      const genericEnd = findMatchingTypeArgument(segment.content, afterDefine)
      if (genericEnd !== -1) {
        callEnd = segment.start + findCallEnd(segment.content, genericEnd + 1)
        const genericContentStart = skipTrivia(segment.content, afterDefine + 1)
        if (segment.content[genericContentStart] === '{') {
          const objectEnd = findMatchingBracket(segment.content, genericContentStart)
          if (skipTrivia(segment.content, objectEnd + 1) === genericEnd) {
            emits.push(...parseObjectEmitDeclarations(segment.content, genericContentStart, objectEnd, segment.start, {
              start: segment.start + defineIndex,
              end: callEnd,
            }))
          }
        } else {
          const typeReference = readNamedGenericTypeReference(segment.content, genericContentStart, genericEnd, segment.start)
          const resolved = typeReference
            ? resolveTypeObject(uri, lineStarts, segments, imports, typeReference.typeName, workspaceRoots, typeFileCache)
            : undefined
          if (resolved) {
            emits.push(...parseObjectEmitDeclarations(resolved.content, resolved.objectStart, resolved.objectEnd, resolved.segmentStart, {
              start: segment.start + defineIndex,
              end: callEnd,
            }, resolved.location))
          }
        }
      }
    } else {
      const open = findCallOpenAfterTypeArguments(segment.content, defineIndex + 'defineEmits'.length)
      if (open !== undefined) {
        callEnd = segment.start + findMatchingBracket(segment.content, open) + 1
        const firstArg = skipTrivia(segment.content, open + 1)
        if (segment.content[firstArg] === '[') {
          emits.push(...parseArrayEmitDeclarations(segment.content, firstArg, segment.start, {
            start: segment.start + defineIndex,
            end: callEnd,
          }))
        } else if (segment.content[firstArg] === '{') {
          emits.push(...parseObjectEmitDeclarations(segment.content, firstArg, findMatchingBracket(segment.content, firstArg), segment.start, {
            start: segment.start + defineIndex,
            end: callEnd,
          }))
        }
      }
    }

    index = defineIndex + 'defineEmits'.length
  }

  return emits
}

function parseSetupEmits(segment: ScriptSegment | undefined, uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], workspaceRoots: string[], typeFileCache: Map<string, TypeFileContent | undefined>): ScriptIndex['emits'] {
  const calls = parseSetupEmitCalls(segment)
  const declarations = parseDefineEmitsDeclarations(segment, uri, lineStarts, segments, imports, workspaceRoots, typeFileCache)
  const declarationByName = new Map(declarations.map((emit) => [emit.eventName, emit]))
  const calledNames = new Set(calls.map((emit) => emit.eventName))
  return [
    ...declarations.filter((emit) => !calledNames.has(emit.eventName)),
    ...calls.map((emit) => {
      const declaration = declarationByName.get(emit.eventName)
      return declaration
        ? { ...emit, sourceLocation: declaration.sourceLocation, declared: declaration.declared }
        : emit
    }),
  ]
}

function parseDefineModelLocalName(content: string, defineIndex: number): { name: string, span: TextSpan } | undefined {
  const prefix = content.slice(statementBoundaryBefore(content, defineIndex), defineIndex)
  const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[\s\S]*?)?\s*=\s*$/.exec(prefix)
  if (!match) {
    return undefined
  }
  const nameStart = defineIndex - prefix.length + prefix.lastIndexOf(match[1])
  return { name: match[1], span: { start: nameStart, end: nameStart + match[1].length } }
}

function parseDefineModelDeclarations(segment: ScriptSegment | undefined): ScriptIndex['emits'] {
  if (!segment) {
    return []
  }

  const emits: ScriptIndex['emits'] = []
  let index = 0

  while (index < segment.content.length) {
    const defineIndex = findCodeToken(segment.content, 'defineModel', index)
    if (defineIndex === -1) {
      break
    }

    const open = findCallOpenAfterTypeArguments(segment.content, defineIndex + 'defineModel'.length)
    if (open === undefined) {
      index = defineIndex + 'defineModel'.length
      continue
    }

    const callEnd = segment.start + findMatchingBracket(segment.content, open) + 1
    const firstArg = skipTrivia(segment.content, open + 1)
    const literal = readStringLiteral(segment.content, firstArg)
    const localName = parseDefineModelLocalName(segment.content, defineIndex)
    const modelName = literal?.value ?? 'modelValue'
    const localSpan = localName?.span ?? { start: defineIndex, end: defineIndex + 'defineModel'.length }
    const eventSpan = literal
      ? { start: segment.start + literal.start, end: segment.start + literal.end }
      : { start: segment.start + localSpan.start, end: segment.start + localSpan.end }

    emits.push({
      eventName: `update:${modelName}`,
      eventSpan,
      callSpan: { start: segment.start + defineIndex, end: callEnd },
      declared: true,
    })
    index = defineIndex + 'defineModel'.length
  }

  return emits
}

function parseSetupModels(segment: ScriptSegment | undefined, emits: ScriptIndex['emits']): ScriptIndex['emits'] {
  const existing = new Set(emits.map((emit) => emit.eventName))
  return [
    ...emits,
    ...parseDefineModelDeclarations(segment).filter((emit) => !existing.has(emit.eventName)),
  ]
}

function parseSlotTypeMembers(content: string, objectStart: number, objectEnd: number, segmentStart: number, location?: Omit<SourceLocation, 'span'>): SlotInfo[] {
  return parseTypeMembers(content, objectStart, objectEnd, location ?? { uri: '', lineStarts: [] })
    .map((slot) => ({
      name: slot.name,
      span: shiftSpan(slot.span, segmentStart),
      detail: slot.detail,
      documentation: slot.documentation,
      sourceLocation: location ? shiftSourceLocation(slot.sourceLocation, segmentStart) : undefined,
    }))
}

function parseDefineSlots(segment: ScriptSegment | undefined, uri: string, lineStarts: number[], segments: ScriptSegment[], imports: ImportInfo[], workspaceRoots: string[], typeFileCache: Map<string, TypeFileContent | undefined>): SlotInfo[] {
  if (!segment) {
    return []
  }

  const slots: SlotInfo[] = []
  let index = 0

  while (index < segment.content.length) {
    const defineIndex = findCodeToken(segment.content, 'defineSlots', index)
    if (defineIndex === -1) {
      break
    }

    const genericStart = skipTrivia(segment.content, defineIndex + 'defineSlots'.length)
    if (segment.content[genericStart] !== '<') {
      index = defineIndex + 'defineSlots'.length
      continue
    }
    const genericEnd = findMatchingTypeArgument(segment.content, genericStart)
    if (genericEnd === -1) {
      break
    }

    const genericContentStart = skipTrivia(segment.content, genericStart + 1)
    if (segment.content[genericContentStart] === '{') {
      const objectEnd = findMatchingBracket(segment.content, genericContentStart)
      if (skipTrivia(segment.content, objectEnd + 1) === genericEnd) {
        slots.push(...parseSlotTypeMembers(segment.content, genericContentStart, objectEnd, segment.start))
      }
    } else {
      const typeReference = readNamedGenericTypeReference(segment.content, genericContentStart, genericEnd, segment.start)
      const resolved = typeReference
        ? resolveTypeObject(uri, lineStarts, segments, imports, typeReference.typeName, workspaceRoots, typeFileCache)
        : undefined
      if (resolved) {
        slots.push(...parseSlotTypeMembers(resolved.content, resolved.objectStart, resolved.objectEnd, resolved.segmentStart, resolved.location))
      }
    }

    index = genericEnd + 1
  }

  return slots
}

function readFunctionSignature(content: string, name: string, start: number, end: number): string | undefined {
  let cursor = skipTrivia(content, start)
  let asyncPrefix = false
  const asyncToken = readIdentifier(content, cursor)
  if (asyncToken?.value === 'async') {
    asyncPrefix = true
    cursor = skipTrivia(content, asyncToken.end)
  }

  const functionToken = readIdentifier(content, cursor)
  if (functionToken?.value === 'function') {
    cursor = skipTrivia(content, functionToken.end)
    const functionName = readIdentifier(content, cursor)
    if (functionName) {
      cursor = skipTrivia(content, functionName.end)
    }
  }

  if (content[cursor] !== '(' || cursor >= end) {
    return undefined
  }

  const paramsEnd = findMatchingBracket(content, cursor)
  if (paramsEnd >= end) {
    return undefined
  }
  const params = content.slice(cursor, paramsEnd + 1).replace(/\s+/g, ' ')
  return `${asyncPrefix ? 'async ' : ''}${name}${params}`
}

function readFunctionExpressionSignature(content: string, name: string, start: number, end: number): string | undefined {
  let cursor = skipTrivia(content, start)
  const asyncToken = readIdentifier(content, cursor)
  if (asyncToken?.value === 'async') {
    cursor = skipTrivia(content, asyncToken.end)
  }

  const functionToken = readIdentifier(content, cursor)
  if (functionToken?.value !== 'function') {
    return undefined
  }
  return readFunctionSignature(content, name, start, end)
}

function readArrowFunctionSignature(content: string, name: string, start: number, end: number): string | undefined {
  let cursor = skipTrivia(content, start)
  let asyncPrefix = false
  const asyncToken = readIdentifier(content, cursor)
  if (asyncToken?.value === 'async') {
    asyncPrefix = true
    cursor = skipTrivia(content, asyncToken.end)
  }

  if (content[cursor] === '<') {
    const genericEnd = findMatchingTypeArgument(content, cursor)
    if (genericEnd === -1 || genericEnd >= end) {
      return undefined
    }
    cursor = skipTrivia(content, genericEnd + 1)
  }

  let params = ''
  if (content[cursor] === '(') {
    const paramsEnd = findMatchingBracket(content, cursor)
    params = content.slice(cursor, paramsEnd + 1).replace(/\s+/g, ' ')
    cursor = skipTrivia(content, paramsEnd + 1)
  } else {
    const arg = readIdentifier(content, cursor)
    if (!arg) {
      return undefined
    }
    params = `(${arg.value})`
    cursor = skipTrivia(content, arg.end)
  }

  return findArrowAfterParams(content, cursor, end) !== undefined ? `${asyncPrefix ? 'async ' : ''}${name}${params}` : undefined
}

function findArrowAfterParams(content: string, start: number, end: number): number | undefined {
  let depth = 0

  for (let index = skipTrivia(content, start); index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (depth === 0 && content.startsWith('=>', index)) {
      return index
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (char === ',' || char === ';')) {
      return undefined
    }
  }

  return undefined
}

function readObjectMethodSignature(content: string, name: string, start: number, end: number): string | undefined {
  let cursor = skipTrivia(content, start)
  let asyncPrefix = false
  const asyncToken = readIdentifier(content, cursor)
  if (asyncToken?.value === 'async') {
    asyncPrefix = true
    cursor = skipTrivia(content, asyncToken.end)
  }

  const memberName = readTypeMemberName(content, cursor)
  if (!memberName || memberName.value !== name) {
    return undefined
  }

  cursor = skipTrivia(content, memberName.rawEnd ?? memberName.end)
  if (content[cursor] !== '(' || cursor >= end) {
    return undefined
  }

  const paramsEnd = findMatchingBracket(content, cursor)
  if (paramsEnd >= end) {
    return undefined
  }
  const params = content.slice(cursor, paramsEnd + 1).replace(/\s+/g, ' ')
  return `${asyncPrefix ? 'async ' : ''}${name}${params}`
}

function collectLocalFunctionDefinitions(segment: ScriptSegment): Map<string, MethodInfo> {
  const definitions = new Map<string, MethodInfo>()

  for (let index = 0; index < segment.content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(segment.content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (isCodeTokenAt(segment.content, 'function', index)) {
      const name = readIdentifier(segment.content, skipTrivia(segment.content, index + 'function'.length))
      if (!name) {
        continue
      }
      const signature = readFunctionSignature(segment.content, name.value, index, segment.content.length) ?? `${name.value}()`
      definitions.set(name.value, {
        name: name.value,
        span: { start: segment.start + name.start, end: segment.start + name.end },
        detail: signature,
        signature,
      })
      index = name.end
      continue
    }

    const declaration = (['const', 'let', 'var'] as const).find((token) => isCodeTokenAt(segment.content, token, index))
    if (!declaration) {
      continue
    }

    const name = readIdentifier(segment.content, skipTrivia(segment.content, index + declaration.length))
    if (!name) {
      continue
    }
    const equals = findDeclaratorEquals(segment.content, name.end)
    if (equals === undefined) {
      continue
    }
    const valueStart = skipTrivia(segment.content, equals + 1)
    const valueEnd = findExpressionEnd(segment.content, valueStart)
    const signature = readFunctionSignature(segment.content, name.value, valueStart, valueEnd)
      ?? readArrowFunctionSignature(segment.content, name.value, valueStart, valueEnd)
    if (!signature) {
      continue
    }
    definitions.set(name.value, {
      name: name.value,
      span: { start: segment.start + name.start, end: segment.start + name.end },
      detail: signature,
      signature,
    })
    index = valueEnd
  }

  return definitions
}

function findExpressionEnd(content: string, start: number, end = content.length): number {
  let index = start
  let depth = 0

  while (index < end) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }

    const char = content[index]
    if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}' || char === '>') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
      return index
    }
    index += 1
  }

  return end
}

function parseDefineExposeMethods(segment: ScriptSegment | undefined, uri: string, lineStarts: number[]): MethodInfo[] {
  if (!segment) {
    return []
  }

  const localFunctions = collectLocalFunctionDefinitions(segment)
  const methods: MethodInfo[] = []
  let index = 0

  while (index < segment.content.length) {
    const defineIndex = findCodeToken(segment.content, 'defineExpose', index)
    if (defineIndex === -1) {
      break
    }

    const open = findCallOpenAfterTypeArguments(segment.content, defineIndex + 'defineExpose'.length)
    if (open === undefined) {
      index = defineIndex + 'defineExpose'.length
      continue
    }
    const objectStart = skipTrivia(segment.content, open + 1)
    if (segment.content[objectStart] !== '{') {
      index = open + 1
      continue
    }

    const objectEnd = findMatchingBracket(segment.content, objectStart)
    let cursor = objectStart + 1
    while (cursor < objectEnd) {
      const trivia = readLeadingTypeTrivia(segment.content, cursor)
      cursor = trivia.cursor
      if (cursor >= objectEnd) {
        break
      }
      if (segment.content[cursor] === ',') {
        cursor += 1
        continue
      }

      const name = readTypeMemberName(segment.content, cursor)
      if (!name) {
        cursor += 1
        continue
      }

      let publicName = name
      const methodStart = name.start
      let afterName = skipTrivia(segment.content, name.rawEnd ?? name.end)
      if (name.value === 'async' && segment.content[afterName] !== '(' && segment.content[afterName] !== ':') {
        const asyncMethodName = readTypeMemberName(segment.content, afterName)
        const afterAsyncMethodName = asyncMethodName ? skipTrivia(segment.content, asyncMethodName.rawEnd ?? asyncMethodName.end) : -1
        if (asyncMethodName && segment.content[afterAsyncMethodName] === '(') {
          publicName = asyncMethodName
          afterName = afterAsyncMethodName
        }
      }

      if (segment.content[afterName] === '(') {
        const memberEnd = findMemberEnd(segment.content, afterName, objectEnd)
        const publicSpan = { start: segment.start + publicName.start, end: segment.start + publicName.end }
        const signature = readObjectMethodSignature(segment.content, publicName.value, methodStart, memberEnd) ?? `${publicName.value}()`
        methods.push({
          name: publicName.value,
          span: publicSpan,
          detail: signature,
          signature,
          documentation: trivia.documentation,
          sourceLocation: {
            uri,
            lineStarts,
            span: publicSpan,
          },
        })
        cursor = memberEnd + 1
        continue
      }

      if (segment.content[afterName] === ':') {
        const valueStart = skipTrivia(segment.content, afterName + 1)
        const memberEnd = findMemberEnd(segment.content, valueStart, objectEnd)
        const publicSpan = { start: segment.start + name.start, end: segment.start + name.end }
        const valueName = readIdentifier(segment.content, valueStart)
        const local = valueName ? localFunctions.get(valueName.value) : undefined
        if (local) {
          methods.push({
            ...local,
            name: name.value,
            span: publicSpan,
            detail: local.detail.replace(new RegExp(`^${escapeRegExp(local.name)}\\b`), name.value),
            signature: local.signature.replace(new RegExp(`^${escapeRegExp(local.name)}\\b`), name.value),
            documentation: trivia.documentation,
            sourceLocation: {
              uri,
              lineStarts,
              span: local.span,
            },
          })
        } else {
          const signature = readFunctionExpressionSignature(segment.content, name.value, valueStart, memberEnd)
            ?? readArrowFunctionSignature(segment.content, name.value, valueStart, memberEnd)
          if (signature) {
            methods.push({
              name: name.value,
              span: publicSpan,
              detail: signature,
              signature,
              documentation: trivia.documentation,
              sourceLocation: {
                uri,
                lineStarts,
                span: publicSpan,
              },
            })
          }
        }
        cursor = memberEnd + 1
        continue
      }

      const local = localFunctions.get(name.value)
      if (local) {
        const publicSpan = { start: segment.start + name.start, end: segment.start + name.end }
        methods.push({
          ...local,
          span: publicSpan,
          documentation: trivia.documentation ?? local.documentation,
          sourceLocation: {
            uri,
            lineStarts,
            span: local.span,
          },
        })
      }
      cursor = findMemberEnd(segment.content, afterName, objectEnd) + 1
    }

    index = objectEnd + 1
  }

  return dedupeMethods(methods)
}

function dedupeMethods(methods: MethodInfo[]): MethodInfo[] {
  const seen = new Set<string>()
  const results: MethodInfo[] = []
  for (const method of methods) {
    const key = `${method.name}\0${method.span.start}\0${method.span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(method)
  }
  return results
}

function parseProvides(segments: ScriptSegment[], staticKeys: Map<string, StaticKeyInfo>): ProvideInfo[] {
  const provides: ProvideInfo[] = []
  for (const segment of segments) {
    for (let index = 0; index < segment.content.length; index += 1) {
      const skipped = skipStringCommentOrRegex(segment.content, index)
      if (skipped !== undefined) {
        index = skipped - 1
        continue
      }
      if (!isCodeTokenAt(segment.content, 'provide', index)) {
        continue
      }
      const arg = readCallKeyArgument(segment.content, index + 'provide'.length, staticKeys)
      if (!arg) {
        continue
      }
      provides.push({
        key: arg.key,
        keySpan: { start: segment.start + arg.span.start, end: segment.start + arg.span.end },
        detail: arg.label,
        keySourceLocation: arg.keySourceLocation,
      })
    }
  }
  return provides
}

function parseInjectLocalName(content: string, injectIndex: number, fallback: string): { name: string, span: TextSpan } {
  const prefix = content.slice(statementBoundaryBefore(content, injectIndex), injectIndex)
  const match = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[\s\S]*?)?\s*=\s*$/.exec(prefix)
  if (!match) {
    return { name: fallback, span: { start: injectIndex, end: injectIndex } }
  }
  const nameStart = injectIndex - prefix.length + prefix.lastIndexOf(match[1])
  return { name: match[1], span: { start: nameStart, end: nameStart + match[1].length } }
}

function statementBoundaryBefore(content: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (content[cursor] === ';' || content[cursor] === '{' || content[cursor] === '}') {
      return cursor + 1
    }
  }
  return 0
}

function parseInjects(segments: ScriptSegment[], staticKeys: Map<string, StaticKeyInfo>): InjectInfo[] {
  const injects: InjectInfo[] = []
  for (const segment of segments) {
    for (let index = 0; index < segment.content.length; index += 1) {
      const skipped = skipStringCommentOrRegex(segment.content, index)
      if (skipped !== undefined) {
        index = skipped - 1
        continue
      }
      if (!isCodeTokenAt(segment.content, 'inject', index)) {
        continue
      }
      const arg = readCallKeyArgument(segment.content, index + 'inject'.length, staticKeys)
      if (!arg) {
        continue
      }
      const local = parseInjectLocalName(segment.content, index, arg.label)
      injects.push({
        key: arg.key,
        keySpan: { start: segment.start + arg.span.start, end: segment.start + arg.span.end },
        localName: local.name,
        localSpan: { start: segment.start + local.span.start, end: segment.start + local.span.end },
        detail: arg.label,
        keySourceLocation: arg.keySourceLocation,
      })
    }
  }
  return injects
}

export function parseVue3Script(sfc: ParsedSfc, workspaceRoots: string[] = [], cache?: Vue3ScriptParseCache): ScriptIndex {
  const scriptSegment = sfc.script ? { content: sfc.script.content, start: sfc.script.start } : undefined
  const setupSegment = sfc.scriptSetup ? { content: sfc.scriptSetup.content, start: sfc.scriptSetup.start } : undefined
  const segments = [scriptSegment, setupSegment].filter((segment): segment is ScriptSegment => Boolean(segment))
  const imports = segments.flatMap((segment) => parseImports(segment.content))
  const setupImports = setupSegment ? parseImports(setupSegment.content) : []
  const defineProps = setupSegment ? parseDefineProps(setupSegment) : undefined
  const typeFileCache = new Map<string, TypeFileContent | undefined>()
  const resolvedType = defineProps
    ? resolveTypeMembers(sfc.uri, sfc.lineStarts, segments, imports, defineProps, workspaceRoots, typeFileCache)
    : undefined
  const props = resolvedType?.props ?? []
  const staticKeys = parseStaticKeys(sfc.uri, sfc.lineStarts, segments, imports, workspaceRoots, cache)
  const emits = parseSetupModels(setupSegment, parseSetupEmits(setupSegment, sfc.uri, sfc.lineStarts, segments, imports, workspaceRoots, typeFileCache))

  return {
    ...emptyScriptIndex(imports),
    componentName: parseDefineOptionsName(setupSegment),
    components: parseSetupComponents(sfc.uri, setupSegment, setupImports, workspaceRoots),
    staticComponentNames: setupSegment ? collectStaticComponentNameBindings(setupSegment.content) : [],
    props,
    methods: parseDefineExposeMethods(setupSegment, sfc.uri, sfc.lineStarts),
    emits,
    provides: parseProvides(segments, staticKeys),
    injects: parseInjects(segments, staticKeys),
    vue3PropType: resolvedType?.typeInfo,
    vue3PropUsages: collectVue3PropUsages(defineProps, props, setupSegment, sfc.template),
    slots: parseDefineSlots(setupSegment, sfc.uri, sfc.lineStarts, segments, imports, workspaceRoots, typeFileCache),
  }
}

import type { EmitInfo, EventBusCall, StaticComponentNameBinding, TemplateAttrUsage, TemplateComponentUsage, TemplateIndex } from './types'
import { parseEventBusCalls } from './eventBusParser'
import { toCamelCase, toKebabCase } from '../utils/casing'
import { readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

const ignoredPropNames = new Set([
  'class',
  'style',
  'key',
  'ref',
  'slot',
  'slot-scope',
  'is',
])

interface TemplateExpressionAttrValue {
  value: string
  start: number
}

function isVueDirective(name: string): boolean {
  return name.startsWith('v-') || name.startsWith('#')
}

function stripModifier(name: string): string {
  return name.split('.')[0]
}

function normalizeAttr(attrName: string): TemplateAttrUsage | undefined {
  if (attrName === 'ref') {
    return undefined
  }

  if (attrName.startsWith('@')) {
    const name = stripModifier(attrName.slice(1))
    return { kind: 'event', name, normalizedName: name, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith('v-on:')) {
    const name = stripModifier(attrName.slice('v-on:'.length))
    return { kind: 'event', name, normalizedName: name, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith(':')) {
    const name = stripModifier(attrName.slice(1))
    if (ignoredPropNames.has(name)) {
      return undefined
    }
    return { kind: 'prop', name, normalizedName: toCamelCase(name), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith('v-bind:')) {
    const name = stripModifier(attrName.slice('v-bind:'.length))
    if (ignoredPropNames.has(name)) {
      return undefined
    }
    return { kind: 'prop', name, normalizedName: toCamelCase(name), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (ignoredPropNames.has(attrName) || isVueDirective(attrName)) {
    return undefined
  }

  return { kind: 'prop', name: attrName, normalizedName: toCamelCase(attrName), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
}

function extractRef(openTag: string, openStart: number): TemplateAttrUsage[] {
  const refs: TemplateAttrUsage[] = []
  const pattern = /\sref\s*=\s*["']([^"']+)["']/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(openTag))) {
    const valueStart = openStart + match.index + match[0].lastIndexOf(match[1])
    const attrStart = openStart + match.index + match[0].indexOf('ref')
    refs.push({
      kind: 'ref',
      name: match[1],
      normalizedName: match[1],
      span: { start: valueStart, end: valueStart + match[1].length },
      fullSpan: { start: attrStart, end: attrStart + 3 },
    })
  }
  return refs
}

function extractAttrs(openTag: string, openStart: number): TemplateAttrUsage[] {
  const attrs = extractRef(openTag, openStart)
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    if (rawName === 'ref') {
      continue
    }
    const normalized = normalizeAttr(rawName)
    if (!normalized) {
      continue
    }

    const fullStart = openStart + match.index + match[0].indexOf(rawName)
    const semanticNameStart = rawName.startsWith('@')
      ? fullStart + 1
      : rawName.startsWith(':')
        ? fullStart + 1
        : rawName.startsWith('v-on:')
          ? fullStart + 'v-on:'.length
          : rawName.startsWith('v-bind:')
            ? fullStart + 'v-bind:'.length
            : fullStart

    attrs.push({
      ...normalized,
      span: { start: semanticNameStart, end: semanticNameStart + normalized.name.length },
      fullSpan: { start: fullStart, end: fullStart + rawName.length },
    })
  }

  return attrs
}

function extractAttrValue(openTag: string, rawName: string): string | undefined {
  const escaped = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\s${escaped}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`)
  const match = pattern.exec(openTag)
  if (!match) {
    return undefined
  }

  const rawValue = match[1]
  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
    return rawValue.slice(1, -1)
  }
  return rawValue
}

function isExpressionAttrName(rawName: string): boolean {
  return rawName.startsWith('@')
    || rawName === 'v-on'
    || rawName.startsWith('v-on:')
    || rawName.startsWith(':')
    || rawName === 'v-bind'
    || rawName.startsWith('v-bind:')
}

function extractExpressionAttrValues(openTag: string, openStart: number): TemplateExpressionAttrValue[] {
  const values: TemplateExpressionAttrValue[] = []
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const rawValue = match[2]
    if (!rawValue || !isExpressionAttrName(rawName)) {
      continue
    }

    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      values.push({
        value: rawValue.slice(1, -1),
        start: rawValueStart + 1,
      })
      continue
    }

    values.push({
      value: rawValue,
      start: rawValueStart,
    })
  }

  return values
}

function extractDynamicIsExpression(openTag: string): { value: string, static: boolean } | undefined {
  const shorthand = extractAttrValue(openTag, ':is')
  if (shorthand !== undefined) {
    return { value: shorthand, static: false }
  }

  const bind = extractAttrValue(openTag, 'v-bind:is')
  if (bind !== undefined) {
    return { value: bind, static: false }
  }

  const staticValue = extractAttrValue(openTag, 'is')
  return staticValue !== undefined ? { value: staticValue, static: true } : undefined
}

function findOpenTagEnd(template: string, openStart: number): number {
  let quote: '"' | "'" | undefined

  for (let index = openStart; index < template.length; index += 1) {
    const char = template[index]
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

  return template.length
}

export function parseTemplate(content: string, templateStart: number, registeredTags: string[], staticComponentNames: StaticComponentNameBinding[] = [], eventBusNames: readonly string[] = []): TemplateIndex {
  const uniqueTags = new Set(registeredTags.map((tag) => toKebabCase(tag)))
  const components: TemplateComponentUsage[] = []
  const emits: EmitInfo[] = []
  const eventBusCalls: EventBusCall[] = []

  const pattern = /<([A-Za-z][\w-]*)(?=\s|>|\/)/g
  let match: RegExpExecArray | null
  let nextCommentStart = content.indexOf('<!--')
  let commentEnd = -1

  while ((match = pattern.exec(content))) {
    while (nextCommentStart !== -1 && nextCommentStart < match.index && match.index >= commentEnd) {
      commentEnd = findHtmlCommentEnd(content, nextCommentStart)
      nextCommentStart = content.indexOf('<!--', commentEnd)
    }
    if (match.index < commentEnd) {
      continue
    }

    const rawTag = match[1]
    const openEnd = findOpenTagEnd(content, match.index)
    const openTag = content.slice(match.index, openEnd)
    emits.push(...parseTemplateEmits(openTag, templateStart + match.index))
    eventBusCalls.push(...parseTemplateEventBusCalls(openTag, templateStart + match.index, eventBusNames))
    const dynamicTags = isDynamicComponentTag(rawTag)
      ? resolveDynamicComponentTags(extractDynamicIsExpression(openTag), staticComponentNames, uniqueTags)
      : undefined

    if (!dynamicTags && !uniqueTags.has(toKebabCase(rawTag)) && !isLikelyComponentTag(rawTag)) {
      continue
    }

    const attrs = extractAttrs(openTag, templateStart + match.index)
    components.push({
      tag: rawTag,
      dynamicTags,
      span: {
        start: templateStart + match.index + 1,
        end: templateStart + match.index + 1 + rawTag.length,
      },
      attrs,
    })
  }

  components.sort((a, b) => a.span.start - b.span.start)
  return { components, emits, eventBusCalls }
}

function isDynamicComponentTag(tag: string): boolean {
  return tag === 'component' || tag === 'Component'
}

function isLikelyComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || tag.includes('-')
}

function resolveDynamicComponentTags(expression: { value: string, static: boolean } | undefined, staticComponentNames: StaticComponentNameBinding[], registeredTags: Set<string>): string[] | undefined {
  if (!expression || !expression.value) {
    return undefined
  }

  const value = expression.value.trim()
  const candidates = expression.static
    ? [value]
    : resolveStaticComponentNameExpression(value, staticComponentNames, registeredTags)

  const tags = candidates.filter((tag) => registeredTags.has(toKebabCase(tag)))
  return tags.length > 0 ? [...new Set(tags)] : undefined
}

function resolveStaticComponentNameExpression(expression: string, staticComponentNames: StaticComponentNameBinding[], registeredTags: Set<string>, visited = new Set<string>()): string[] {
  const trimmed = stripOuterParens(expression.trim())
  if (!trimmed) {
    return []
  }

  const literal = readStringLiteral(trimmed, 0)
  if (literal && literal.end === trimmed.length - 1) {
    return [literal.value]
  }

  const conditional = splitConditionalExpression(trimmed)
  if (conditional) {
    return uniqueStrings([
      ...resolveStaticComponentNameExpression(conditional.consequent, staticComponentNames, registeredTags, visited),
      ...resolveStaticComponentNameExpression(conditional.alternate, staticComponentNames, registeredTags, visited),
    ])
  }

  const logicalParts = splitLogicalExpression(trimmed)
  if (logicalParts.length > 1) {
    return uniqueStrings(logicalParts.flatMap((part) => resolveStaticComponentNameExpression(part, staticComponentNames, registeredTags, visited)))
  }

  const access = splitMemberExpression(trimmed)
  if (access) {
    const root = access.root
    if (/^[A-Za-z_$][\w$]*$/.test(root)) {
      const binding = staticComponentNames.find((item) => item.variableName === root)
      if (binding) {
        return resolveBindingCandidates(binding, staticComponentNames, registeredTags, visited)
      }
      return registeredTags.has(toKebabCase(root)) ? [root] : []
    }
    return resolveStaticComponentNameExpression(root, staticComponentNames, registeredTags, visited)
  }

  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const binding = staticComponentNames.find((item) => item.variableName === trimmed)
    const candidates = [
      ...(registeredTags.has(toKebabCase(trimmed)) ? [trimmed] : []),
      ...(binding ? resolveBindingCandidates(binding, staticComponentNames, registeredTags, visited) : []),
    ]
    return uniqueStrings(candidates)
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return resolveArrayLiteralCandidates(trimmed, staticComponentNames, registeredTags, visited)
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return resolveObjectLiteralCandidates(trimmed, staticComponentNames, registeredTags, visited)
  }

  return []
}

function resolveBindingCandidates(binding: StaticComponentNameBinding, staticComponentNames: StaticComponentNameBinding[], registeredTags: Set<string>, visited: Set<string>): string[] {
  if (visited.has(binding.variableName)) {
    return []
  }
  visited.add(binding.variableName)
  try {
    if (binding.tags.length > 0 && (binding.kind === 'literal' || binding.kind === 'map' || binding.kind === 'array')) {
      return binding.tags
    }
    if (!binding.expression) {
      return binding.tags
    }
    return resolveStaticComponentNameExpression(binding.expression, staticComponentNames, registeredTags, visited)
  } finally {
    visited.delete(binding.variableName)
  }
}

function resolveArrayLiteralCandidates(expression: string, staticComponentNames: StaticComponentNameBinding[], registeredTags: Set<string>, visited: Set<string>): string[] {
  const closeIndex = findMatchingBracket(expression, 0)
  if (closeIndex !== expression.length - 1) {
    return []
  }
  return uniqueStrings(readArrayCandidates(expression, 0, expression.length - 1)
    .flatMap((value) => resolveStaticComponentNameExpression(value, staticComponentNames, registeredTags, visited)))
}

function resolveObjectLiteralCandidates(expression: string, staticComponentNames: StaticComponentNameBinding[], registeredTags: Set<string>, visited: Set<string>): string[] {
  const closeIndex = findMatchingBracket(expression, 0)
  if (closeIndex !== expression.length - 1) {
    return []
  }
  return uniqueStrings(readObjectCandidates(expression, 0, expression.length - 1)
    .flatMap((value) => resolveStaticComponentNameExpression(value, staticComponentNames, registeredTags, visited)))
}

function splitConditionalExpression(expression: string): { consequent: string, alternate: string } | undefined {
  let depth = 0
  let questionIndex = -1
  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = expression[index]
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && char === '?' && expression[index + 1] !== '?' && expression[index - 1] !== '?') {
      questionIndex = index
      break
    }
  }

  if (questionIndex === -1) {
    return undefined
  }

  depth = 0
  for (let index = questionIndex + 1; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = expression[index]
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && char === ':') {
      return {
        consequent: expression.slice(questionIndex + 1, index).trim(),
        alternate: expression.slice(index + 1).trim(),
      }
    }
  }

  return undefined
}

function splitLogicalExpression(expression: string): string[] {
  for (const operator of ['||', '??', '&&'] as const) {
    const parts = splitByOperator(expression, operator)
    if (parts.length > 1) {
      return parts
    }
  }
  return [expression]
}

function splitByOperator(expression: string, operator: '||' | '??' | '&&'): string[] {
  const parts: string[] = []
  let depth = 0
  let last = 0
  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = expression[index]
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0 || !expression.startsWith(operator, index)) {
      continue
    }
    parts.push(expression.slice(last, index).trim())
    last = index + operator.length
    index += operator.length - 1
  }

  if (parts.length === 0) {
    return [expression]
  }

  parts.push(expression.slice(last).trim())
  return parts.filter(Boolean)
}

function splitMemberExpression(expression: string): { root: string } | undefined {
  let depth = 0
  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const char = expression[index]
    if (depth === 0 && (char === '.' || (char === '[' && expression.slice(0, index).trim()))) {
      return { root: expression.slice(0, index).trim() }
    }
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
  }
  return undefined
}

function stripOuterParens(expression: string): string {
  let current = expression
  while (current.startsWith('(') && findMatchingBracket(current, 0) === current.length - 1) {
    current = current.slice(1, -1).trim()
  }
  return current
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
    const char = content[index]
    if (char === open) {
      depth += 1
    } else if (char === close) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return content.length - 1
}

function readArrayCandidates(content: string, arrayStart: number, arrayEnd: number): string[] {
  const values: string[] = []
  let index = arrayStart + 1
  while (index < arrayEnd) {
    index = skipWhitespace(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }
    const entryEnd = findArrayEntryEnd(content, index, arrayEnd)
    const value = readStaticCandidate(content, index, entryEnd)
    if (value) {
      values.push(value)
    }
    index = entryEnd + 1
  }
  return [...new Set(values)]
}

function readObjectCandidates(content: string, objectStart: number, objectEnd: number): string[] {
  const values: string[] = []
  let index = objectStart + 1
  while (index < objectEnd) {
    index = skipWhitespace(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }
    const key = readIdentifier(content, index) ?? readQuotedPropertyName(content, index)
    if (!key) {
      index += 1
      continue
    }
    index = skipTrivia(content, key.end)
    if (content[index] !== ':') {
      index += 1
      continue
    }
    const valueStart = skipTrivia(content, index + 1)
    const valueEnd = findArrayEntryEnd(content, valueStart, objectEnd)
    const value = readStaticCandidate(content, valueStart, valueEnd)
    if (value) {
      values.push(value)
    }
    index = valueEnd + 1
  }
  return [...new Set(values)]
}

function readStaticCandidate(content: string, start: number, end: number): string | undefined {
  const literal = readStringLiteral(content, start)
  if (literal && skipTrivia(content, literal.end + 1) === end) {
    return literal.value
  }

  const identifier = readIdentifier(content, start)
  if (identifier && skipTrivia(content, identifier.end) === end) {
    return identifier.value
  }

  return undefined
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

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) {
    index += 1
  }
  return index
}

function readIdentifier(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(content.slice(index))
  if (!match) {
    return undefined
  }
  return { value: match[0], start: index, end: index + match[0].length }
}

function readQuotedPropertyName(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const literal = readStringLiteral(content, index)
  return literal ? { value: literal.value, start: literal.start, end: literal.end + 1 } : undefined
}

function findArrayEntryEnd(content: string, start: number, end: number): number {
  let index = start
  let depth = 0

  while (index < end) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }
    const char = content[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (char === ',' && depth === 0) {
      return skipWhitespaceBackward(content, index - 1, start)
    }
    index += 1
  }

  return skipWhitespaceBackward(content, end - 1, start)
}

function skipWhitespaceBackward(content: string, index: number, min: number): number {
  let cursor = index
  while (cursor >= min && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  return cursor + 1
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function findHtmlCommentEnd(content: string, start: number): number {
  const end = content.indexOf('-->', start + '<!--'.length)
  return end === -1 ? content.length : end + '-->'.length
}

function parseTemplateEmits(openTag: string, openStart: number): EmitInfo[] {
  const emits: EmitInfo[] = []
  for (const attr of extractExpressionAttrValues(openTag, openStart)) {
    emits.push(...parseTemplateExpressionEmits(attr.value, attr.start))
  }
  return emits
}

function parseTemplateEventBusCalls(openTag: string, openStart: number, eventBusNames: readonly string[]): EventBusCall[] {
  const calls: EventBusCall[] = []
  for (const attr of extractExpressionAttrValues(openTag, openStart)) {
    calls.push(...parseEventBusCalls(attr.value, attr.start, eventBusNames))
  }
  return calls
}

function parseTemplateExpressionEmits(expression: string, expressionStart: number): EmitInfo[] {
  const emits: EmitInfo[] = []
  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    const token = readTemplateEmitToken(expression, index)
    if (!token) {
      continue
    }

    const tokenStart = index
    let cursor = skipWhitespace(expression, index + token.length)
    if (expression[cursor] !== '(') {
      continue
    }
    cursor = skipWhitespace(expression, cursor + 1)
    const literal = readStringLiteral(expression, cursor)
    if (!literal) {
      continue
    }

    emits.push({
      eventName: literal.value,
      eventSpan: { start: expressionStart + literal.start, end: expressionStart + literal.end },
      callSpan: { start: expressionStart + tokenStart, end: expressionStart + literal.end + 1 },
    })
  }
  return emits
}

function readTemplateEmitToken(expression: string, index: number): 'this.$emit' | '$emit' | undefined {
  if (expression.startsWith('this.$emit', index) && hasEmitTokenBoundary(expression, index)) {
    return 'this.$emit'
  }

  if (expression.startsWith('$emit', index) && hasEmitTokenBoundary(expression, index)) {
    return '$emit'
  }

  return undefined
}

function hasEmitTokenBoundary(expression: string, index: number): boolean {
  const previous = expression[index - 1]
  // 避免把 $bus.$emit(...) 这类事件总线调用误判为当前组件 emit。
  return previous === undefined || (!/[\w$]/.test(previous) && previous !== '.')
}

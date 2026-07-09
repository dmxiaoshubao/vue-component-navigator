import type { EmitInfo, EventBusCall, SlotInfo, StaticComponentNameBinding, TemplateAttrUsage, TemplateBindUsage, TemplateComponentUsage, TemplateIndex, TemplateInstanceMemberUsage, TemplateSlotUsage } from './types'
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

const expressionKeywords = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'this',
  'typeof',
  'void',
  'new',
  'delete',
  'in',
  'of',
  'instanceof',
  'return',
  'if',
  'else',
  'Math',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'Date',
  'JSON',
  'console',
  '$event',
])

const staticComponentWrappers = new Set([
  'computed',
  'markRaw',
  'reactive',
  'readonly',
  'ref',
  'shallowReactive',
  'shallowRef',
])

interface TemplateExpressionAttrValue {
  value: string
  start: number
}

interface TemplateInstanceExpressionAttrValue extends TemplateExpressionAttrValue {
  rawName: string
  localNames?: string[]
}

interface DynamicComponentExpression {
  value: string
  static: boolean
  span: { start: number, end: number }
}

const voidHtmlTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

function isVueDirective(name: string): boolean {
  return name.startsWith('v-') || name.startsWith('#')
}

function stripModifier(name: string): string {
  return name.split('.')[0]
}

function hasModifier(name: string, modifier: string): boolean {
  return name.split('.').slice(1).includes(modifier)
}

function namedSyncProp(attrName: string): string | undefined {
  if (!hasModifier(attrName, 'sync')) {
    return undefined
  }

  const name = attrName.startsWith(':')
    ? stripModifier(attrName.slice(1))
    : attrName.startsWith('v-bind:')
      ? stripModifier(attrName.slice('v-bind:'.length))
      : undefined

  return name && !ignoredPropNames.has(name) ? name : undefined
}

function normalizeAttr(attrName: string, vue3ModelEvents: boolean): TemplateAttrUsage | undefined {
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

  if (vue3ModelEvents && attrName === 'v-model') {
    return { kind: 'event', name: 'v-model', normalizedName: 'update:modelValue', span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (vue3ModelEvents && attrName.startsWith('v-model:')) {
    const name = stripModifier(attrName.slice('v-model:'.length))
    return { kind: 'event', name, normalizedName: `update:${name}`, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
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

function normalizeAttrs(attrName: string, vue3ModelEvents: boolean): TemplateAttrUsage[] {
  const syncProp = namedSyncProp(attrName)
  if (syncProp) {
    const normalized = normalizeAttr(attrName, vue3ModelEvents)
    // Vue2 .sync 等价于传入 prop，并监听对应的 update:prop 事件。
    return normalized
      ? [
          normalized,
          {
            kind: 'event',
            name: syncProp,
            normalizedName: `update:${syncProp}`,
            span: { start: 0, end: 0 },
            fullSpan: { start: 0, end: 0 },
          },
        ]
      : []
  }

  if (vue3ModelEvents && attrName === 'v-model') {
    return [
      { kind: 'prop', name: 'v-model', normalizedName: 'modelValue', span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } },
      { kind: 'event', name: 'v-model', normalizedName: 'update:modelValue', span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } },
    ]
  }

  if (vue3ModelEvents && attrName.startsWith('v-model:')) {
    const name = stripModifier(attrName.slice('v-model:'.length))
    return [
      { kind: 'prop', name, normalizedName: toCamelCase(name), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } },
      { kind: 'event', name, normalizedName: `update:${name}`, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } },
    ]
  }

  const normalized = normalizeAttr(attrName, vue3ModelEvents)
  return normalized ? [normalized] : []
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

function extractAttrs(openTag: string, openStart: number, vue3ModelEvents: boolean): TemplateAttrUsage[] {
  const attrs = extractRef(openTag, openStart)
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    if (rawName === 'ref') {
      continue
    }
    const normalizedAttrs = normalizeAttrs(rawName, vue3ModelEvents)
    if (normalizedAttrs.length === 0) {
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
            : rawName.startsWith('v-model:')
              ? fullStart + 'v-model:'.length
              : fullStart

    for (const normalized of normalizedAttrs) {
      attrs.push({
        ...normalized,
        span: { start: semanticNameStart, end: semanticNameStart + normalized.name.length },
        fullSpan: { start: fullStart, end: fullStart + rawName.length },
      })
    }
  }

  return attrs
}

function extractBindUsages(openTag: string, openStart: number): TemplateBindUsage[] {
  const binds: TemplateBindUsage[] = []
  const pattern = /\s(v-bind)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawValue = match[2]
    if (!rawValue) {
      continue
    }

    const fullStart = openStart + match.index + match[0].indexOf(match[1])
    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
    const expression = quoted ? rawValue.slice(1, -1) : rawValue
    const expressionStart = rawValueStart + (quoted ? 1 : 0)

    binds.push({
      expression,
      span: { start: expressionStart, end: expressionStart + expression.length },
      fullSpan: { start: fullStart, end: fullStart + match[1].length },
    })
  }

  return binds
}

function extractOnUsages(openTag: string, openStart: number): TemplateBindUsage[] {
  const ons: TemplateBindUsage[] = []
  const pattern = /\s(v-on)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawValue = match[2]
    if (!rawValue) {
      continue
    }

    const fullStart = openStart + match.index + match[0].indexOf(match[1])
    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
    const expression = quoted ? rawValue.slice(1, -1) : rawValue
    const expressionStart = rawValueStart + (quoted ? 1 : 0)

    ons.push({
      expression,
      span: { start: expressionStart, end: expressionStart + expression.length },
      fullSpan: { start: fullStart, end: fullStart + match[1].length },
    })
  }

  return ons
}

function normalizeSlotAttr(rawName: string): { name: string, normalizedName: string, semanticOffset: number } | undefined {
  if (rawName.startsWith('#')) {
    const name = stripModifier(rawName.slice(1)) || 'default'
    return { name, normalizedName: name, semanticOffset: 1 }
  }

  if (rawName === 'v-slot') {
    return { name: 'default', normalizedName: 'default', semanticOffset: 0 }
  }

  if (rawName.startsWith('v-slot:')) {
    const name = stripModifier(rawName.slice('v-slot:'.length)) || 'default'
    return { name, normalizedName: name, semanticOffset: 'v-slot:'.length }
  }

  return undefined
}

function readStaticSlotAttr(openTag: string, openStart: number): TemplateSlotUsage | undefined {
  const pattern = /\sslot\s*=\s*(["'])([^"']+)\1/
  const match = pattern.exec(openTag)
  if (!match) {
    return undefined
  }

  const attrStart = openStart + match.index + match[0].indexOf('slot')
  const valueStart = openStart + match.index + match[0].lastIndexOf(match[2])
  return {
    name: match[2],
    normalizedName: match[2],
    span: { start: valueStart, end: valueStart + match[2].length },
    fullSpan: { start: attrStart, end: attrStart + 'slot'.length },
  }
}

function extractSlotUsages(openTag: string, openStart: number): TemplateSlotUsage[] {
  const slots: TemplateSlotUsage[] = []
  const legacySlot = readStaticSlotAttr(openTag, openStart)
  if (legacySlot) {
    slots.push(legacySlot)
  }
  const pattern = /\s([#:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const normalized = normalizeSlotAttr(rawName)
    if (!normalized) {
      continue
    }

    const fullStart = openStart + match.index + match[0].indexOf(rawName)
    const nameStart = fullStart + normalized.semanticOffset
    const span = normalized.semanticOffset === 0
      ? { start: fullStart, end: fullStart + rawName.length }
      : { start: nameStart, end: nameStart + normalized.name.length }
    slots.push({
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      span,
      fullSpan: { start: fullStart, end: fullStart + rawName.length },
    })
  }

  return slots
}

function uniqueSlotUsages(slots: TemplateSlotUsage[]): TemplateSlotUsage[] {
  const seen = new Set<string>()
  const results: TemplateSlotUsage[] = []
  for (const slot of slots) {
    const key = `${slot.normalizedName}\0${slot.span.start}\0${slot.span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(slot)
  }
  return results
}

function extractSlotDefinition(openTag: string, openStart: number): SlotInfo {
  const nameAttr = /\sname\s*=\s*(["'])([^"']+)\1/.exec(openTag)
  if (nameAttr) {
    const valueStart = openStart + nameAttr.index + nameAttr[0].lastIndexOf(nameAttr[2])
    return {
      name: nameAttr[2],
      span: { start: valueStart, end: valueStart + nameAttr[2].length },
      detail: `<slot name="${nameAttr[2]}">`,
    }
  }

  const tagStart = openStart + 1
  return {
    name: 'default',
    span: { start: tagStart, end: tagStart + 'slot'.length },
    detail: '<slot>',
  }
}

function forwardsAttrs(openTag: string): boolean {
  return /\sv-bind\s*=\s*["']\$attrs["']/.test(openTag)
}

function forwardsListeners(openTag: string): boolean {
  return forwardsAttrs(openTag) || /\sv-on\s*=\s*["']\$listeners["']/.test(openTag)
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

function isInstanceExpressionAttrName(rawName: string): boolean {
  return isExpressionAttrName(rawName)
    || rawName === 'v-for'
    || rawName === 'v-if'
    || rawName === 'v-else-if'
    || rawName === 'v-show'
    || rawName === 'v-text'
    || rawName === 'v-html'
    || rawName === 'v-model'
    || rawName.startsWith('v-model:')
}

function findTopLevelForOperator(expression: string): { index: number, length: number } | undefined {
  let depth = 0

  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = expression[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0) {
      continue
    }

    const match = /^(?:in|of)\b/.exec(expression.slice(index).trimStart())
    if (!match) {
      continue
    }
    const leading = expression.slice(index).length - expression.slice(index).trimStart().length
    const operatorIndex = index + leading
    const before = expression[operatorIndex - 1]
    if (before && /[\w$]/.test(before)) {
      continue
    }
    return { index: operatorIndex, length: match[0].length }
  }

  return undefined
}

function unquoteAttrValue(rawValue: string): string {
  return (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
    ? rawValue.slice(1, -1)
    : rawValue
}

function attrValueStart(rawValue: string, rawValueStart: number): number {
  return rawValueStart + (((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) ? 1 : 0)
}

function collectBindingIdentifiers(expression: string): string[] {
  const names: string[] = []
  const content = stripOuterParens(expression.trim())

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const identifier = readExpressionIdentifier(content, index)
    if (!identifier) {
      continue
    }

    const previous = previousNonWhitespace(content, identifier.start)
    if (
      previous?.char === '.'
      || expressionKeywords.has(identifier.value)
      || isObjectKeyLike(content, identifier.start, identifier.end)
    ) {
      index = identifier.end - 1
      continue
    }

    names.push(identifier.value)
    index = identifier.end - 1
  }

  return [...new Set(names)]
}

function readForExpression(expression: string): { localNames: string[], sourceStart: number } | undefined {
  const operator = findTopLevelForOperator(expression)
  if (!operator) {
    return undefined
  }

  return {
    localNames: collectBindingIdentifiers(expression.slice(0, operator.index)),
    sourceStart: operator.index + operator.length,
  }
}

function isSlotScopeAttrName(rawName: string): boolean {
  return rawName === 'slot-scope'
    || rawName === 'scope'
    || rawName === 'v-slot'
    || rawName.startsWith('v-slot:')
    || rawName.startsWith('#')
}

function extractLocalScopeNames(openTag: string): string[] {
  const names: string[] = []
  const pattern = /\s([#:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const rawValue = match[2]
    if (!rawValue) {
      continue
    }

    const value = unquoteAttrValue(rawValue)
    if (rawName === 'v-for') {
      names.push(...(readForExpression(value)?.localNames ?? []))
      continue
    }

    if (isSlotScopeAttrName(rawName)) {
      names.push(...collectBindingIdentifiers(value))
    }
  }

  return [...new Set(names)]
}

function extractInstanceExpressionAttrValues(openTag: string, openStart: number): TemplateInstanceExpressionAttrValue[] {
  const values: TemplateInstanceExpressionAttrValue[] = []
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const rawValue = match[2]
    if (!rawValue || !isInstanceExpressionAttrName(rawName)) {
      continue
    }

    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    const value = unquoteAttrValue(rawValue)
    const valueStart = attrValueStart(rawValue, rawValueStart)

    if (rawName === 'v-for') {
      const forExpression = readForExpression(value)
      if (!forExpression) {
        continue
      }
      const expressionStart = forExpression.sourceStart
      values.push({
        rawName,
        value: value.slice(expressionStart),
        start: valueStart + expressionStart,
        localNames: forExpression.localNames,
      })
      continue
    }

    values.push({ rawName, value, start: valueStart })
  }

  return values
}

function previousNonWhitespace(content: string, index: number): { char: string, index: number } | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(content[cursor])) {
      return { char: content[cursor], index: cursor }
    }
  }
  return undefined
}

function nextNonWhitespace(content: string, index: number): { char: string, index: number } | undefined {
  for (let cursor = index; cursor < content.length; cursor += 1) {
    if (!/\s/.test(content[cursor])) {
      return { char: content[cursor], index: cursor }
    }
  }
  return undefined
}

function readExpressionIdentifier(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(content.slice(index))
  if (!match) {
    return undefined
  }
  return { value: match[0], start: index, end: index + match[0].length }
}

function isObjectKeyLike(expression: string, identifierStart: number, identifierEnd: number): boolean {
  const previous = previousNonWhitespace(expression, identifierStart)
  const next = nextNonWhitespace(expression, identifierEnd)
  return next?.char === ':' && (!previous || previous.char === '{' || previous.char === ',')
}

function shouldCollectInstanceMember(name: string, candidateNames?: ReadonlySet<string>): boolean {
  return !candidateNames || candidateNames.has(name)
}

function parseTemplateExpressionInstanceMembers(expression: string, expressionStart: number, ignoredNames: ReadonlySet<string>, candidateNames?: ReadonlySet<string>): TemplateInstanceMemberUsage[] {
  const members: TemplateInstanceMemberUsage[] = []

  for (let index = 0; index < expression.length; index += 1) {
    const skipped = skipStringCommentOrRegex(expression, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const identifier = readExpressionIdentifier(expression, index)
    if (!identifier) {
      continue
    }

    const previous = previousNonWhitespace(expression, identifier.start)
    if (identifier.value === 'this') {
      const dot = nextNonWhitespace(expression, identifier.end)
      if (dot?.char === '.') {
        const member = readExpressionIdentifier(expression, dot.index + 1)
        if (member && !expressionKeywords.has(member.value) && shouldCollectInstanceMember(member.value, candidateNames)) {
          members.push({
            name: member.value,
            span: { start: expressionStart + member.start, end: expressionStart + member.end },
          })
          index = member.end - 1
          continue
        }
      }
    }

    if (
      previous?.char === '.'
      || expressionKeywords.has(identifier.value)
      || ignoredNames.has(identifier.value)
      || isObjectKeyLike(expression, identifier.start, identifier.end)
      || !shouldCollectInstanceMember(identifier.value, candidateNames)
    ) {
      index = identifier.end - 1
      continue
    }

    members.push({
      name: identifier.value,
      span: { start: expressionStart + identifier.start, end: expressionStart + identifier.end },
    })
    index = identifier.end - 1
  }

  return members
}

function withAdditionalLocalNames(base: ReadonlySet<string>, names: string[]): ReadonlySet<string> {
  if (names.length === 0) {
    return base
  }

  return new Set([...base, ...names])
}

function parseOpenTagInstanceMembers(openTag: string, openStart: number, activeLocalNames: ReadonlySet<string>, candidateNames?: ReadonlySet<string>): TemplateInstanceMemberUsage[] {
  const attrs = extractInstanceExpressionAttrValues(openTag, openStart)
  const localNames = attrs.flatMap((attr) => attr.localNames ?? [])
  const openTagLocalNames = withAdditionalLocalNames(activeLocalNames, localNames)

  return attrs.flatMap((attr) => parseTemplateExpressionInstanceMembers(
    attr.value,
    attr.start,
    attr.rawName === 'v-for' ? activeLocalNames : openTagLocalNames,
    candidateNames,
  ))
}

function parseInterpolationInstanceMembers(content: string, templateStart: number, activeLocalNames: ReadonlySet<string>, candidateNames?: ReadonlySet<string>, start = 0, end = content.length): TemplateInstanceMemberUsage[] {
  const members: TemplateInstanceMemberUsage[] = []
  let cursor = start
  let commentEnd = -1

  while (cursor < end) {
    const commentStart = content.indexOf('<!--', cursor)
    const interpolationStart = content.indexOf('{{', cursor)
    if (interpolationStart === -1 || interpolationStart >= end) {
      break
    }
    if (commentStart !== -1 && commentStart < interpolationStart) {
      commentEnd = findHtmlCommentEnd(content, commentStart)
      cursor = commentEnd
      continue
    }
    if (interpolationStart < commentEnd) {
      cursor = commentEnd
      continue
    }

    const interpolationEnd = content.indexOf('}}', interpolationStart + 2)
    if (interpolationEnd === -1 || interpolationEnd > end) {
      break
    }

    const expressionStart = interpolationStart + 2
    members.push(...parseTemplateExpressionInstanceMembers(
      content.slice(expressionStart, interpolationEnd),
      templateStart + expressionStart,
      activeLocalNames,
      candidateNames,
    ))
    cursor = interpolationEnd + 2
  }

  return members
}

function uniqueInstanceMembers(members: TemplateInstanceMemberUsage[]): TemplateInstanceMemberUsage[] {
  const seen = new Set<string>()
  const results: TemplateInstanceMemberUsage[] = []
  for (const member of members) {
    const key = `${member.name}\0${member.span.start}\0${member.span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(member)
  }
  return results.sort((a, b) => a.span.start - b.span.start)
}

function extractDynamicIsExpression(openTag: string, openStart: number): DynamicComponentExpression | undefined {
  const pattern = /\s(:is|v-bind:is|is)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    const rawValue = match[2]
    if (!rawValue) {
      continue
    }

    const rawValueStart = openStart + match.index + match[0].lastIndexOf(rawValue)
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
    const value = quoted ? rawValue.slice(1, -1) : rawValue
    const valueStart = rawValueStart + (quoted ? 1 : 0)
    return {
      value,
      static: rawName === 'is',
      span: { start: valueStart, end: valueStart + value.length },
    }
  }

  return undefined
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

function isSelfClosingOpenTag(openTag: string): boolean {
  return /\/\s*>$/.test(openTag)
}

function findMatchingCloseTag(template: string, tag: string, fromIndex: number): number | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<\\/?${escaped}(?=\\s|>|\\/)`, 'g')
  pattern.lastIndex = fromIndex
  let depth = 1
  let match: RegExpExecArray | null

  while ((match = pattern.exec(template))) {
    if (template.startsWith('<!--', match.index)) {
      pattern.lastIndex = findHtmlCommentEnd(template, match.index)
      continue
    }

    if (template[match.index + 1] === '/') {
      depth -= 1
      if (depth === 0) {
        return match.index
      }
      continue
    }

    const openEnd = findOpenTagEnd(template, match.index)
    const openTag = template.slice(match.index, openEnd)
    if (!isSelfClosingOpenTag(openTag)) {
      depth += 1
    }
    pattern.lastIndex = openEnd
  }

  return undefined
}

function isComponentLikeSlotChild(tag: string, registeredTags: Set<string>): boolean {
  return registeredTags.has(toKebabCase(tag)) || isLikelyComponentTag(tag)
}

function extractDefaultSlotUsage(template: string, templateStart: number, openEnd: number, closeStart: number, registeredTags: Set<string>): TemplateSlotUsage | undefined {
  let cursor = openEnd
  while (cursor < closeStart) {
    if (template.startsWith('<!--', cursor)) {
      cursor = findHtmlCommentEnd(template, cursor)
      continue
    }

    if (/\s/.test(template[cursor])) {
      cursor += 1
      continue
    }

    if (template[cursor] !== '<') {
      return {
        name: 'default',
        normalizedName: 'default',
        span: { start: templateStart + cursor, end: templateStart + cursor + 1 },
        fullSpan: { start: templateStart + cursor, end: templateStart + cursor + 1 },
      }
    }

    if (template[cursor + 1] === '/') {
      return undefined
    }

    const childOpenEnd = findOpenTagEnd(template, cursor)
    if (childOpenEnd > closeStart) {
      return undefined
    }
    const childOpenTag = template.slice(cursor, childOpenEnd)
    const childSlotUsages = extractSlotUsages(childOpenTag, templateStart + cursor)
    if (childSlotUsages.length === 0) {
      const tagMatch = /^<([A-Za-z][\w-]*)/.exec(childOpenTag)
      if (!tagMatch) {
        return undefined
      }
      if (isComponentLikeSlotChild(tagMatch[1], registeredTags)) {
        // 隐式默认插槽没有显式语法，避免把子组件标签名误当成父组件 slot 使用点。
        return {
          name: 'default',
          normalizedName: 'default',
          span: { start: templateStart + cursor, end: templateStart + cursor + 1 },
          fullSpan: { start: templateStart + cursor, end: templateStart + cursor + 1 },
        }
      }
      return {
        name: 'default',
        normalizedName: 'default',
        span: { start: templateStart + cursor + 1, end: templateStart + cursor + 1 + tagMatch[1].length },
        fullSpan: { start: templateStart + cursor + 1, end: templateStart + cursor + 1 + tagMatch[1].length },
      }
    }

    const tagMatch = /^<([A-Za-z][\w-]*)/.exec(childOpenTag)
    if (!tagMatch || isSelfClosingOpenTag(childOpenTag)) {
      cursor = childOpenEnd
      continue
    }
    const childCloseStart = findMatchingCloseTag(template, tagMatch[1], childOpenEnd)
    cursor = childCloseStart !== undefined && childCloseStart < closeStart
      ? findOpenTagEnd(template, childCloseStart)
      : childOpenEnd
  }

  return undefined
}

function extractComponentSlotUsages(template: string, templateStart: number, rawTag: string, openTag: string, openStart: number, openEnd: number, registeredTags: Set<string>): TemplateSlotUsage[] {
  const slots = extractSlotUsages(openTag, templateStart + openStart)
  if (isSelfClosingOpenTag(openTag)) {
    return slots
  }

  const closeStart = findMatchingCloseTag(template, rawTag, openEnd)
  if (closeStart === undefined) {
    return slots
  }
  const defaultSlot = extractDefaultSlotUsage(template, templateStart, openEnd, closeStart, registeredTags)
  if (defaultSlot) {
    slots.push(defaultSlot)
  }

  const nextTemplateStart = template.indexOf('<template', openEnd)
  const nextSlotMarkerStart = template.indexOf('slot', openEnd)
  if ((nextTemplateStart === -1 || nextTemplateStart >= closeStart) && (nextSlotMarkerStart === -1 || nextSlotMarkerStart >= closeStart)) {
    return uniqueSlotUsages(slots)
  }

  const pattern = /<([A-Za-z][\w-]*)(?=\s|>|\/)/g
  pattern.lastIndex = openEnd
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template)) && match.index < closeStart) {
    const childTag = match[1]
    const slotOpenEnd = findOpenTagEnd(template, match.index)
    if (slotOpenEnd > closeStart) {
      break
    }
    slots.push(...extractSlotUsages(template.slice(match.index, slotOpenEnd), templateStart + match.index))
    if (isSelfClosingOpenTag(template.slice(match.index, slotOpenEnd))) {
      pattern.lastIndex = slotOpenEnd
      continue
    }

    const childCloseStart = findMatchingCloseTag(template, childTag, slotOpenEnd)
    pattern.lastIndex = childCloseStart !== undefined && childCloseStart < closeStart
      ? findOpenTagEnd(template, childCloseStart)
      : slotOpenEnd
  }

  return uniqueSlotUsages(slots)
}

export function parseTemplate(content: string, templateStart: number, registeredTags: string[], staticComponentNames: StaticComponentNameBinding[] = [], eventBusNames: readonly string[] = [], vue3ModelEvents = false, instanceMemberNames?: ReadonlySet<string>): TemplateIndex {
  const uniqueTags = new Set(registeredTags.map((tag) => toKebabCase(tag)))
  const components: TemplateComponentUsage[] = []
  const emits: EmitInfo[] = []
  const eventBusCalls: EventBusCall[] = []
  const slotDefinitions: SlotInfo[] = []
  const instanceMembers: TemplateInstanceMemberUsage[] = []
  const shouldIndexInstanceMembers = instanceMemberNames === undefined || instanceMemberNames.size > 0
  const tagStack: Array<{ tag: string, localNames: string[] }> = []
  const activeLocalNames = new Set<string>()

  const pattern = /<\/?([A-Za-z][\w-]*)(?=\s|>|\/)/g
  let match: RegExpExecArray | null
  let nextCommentStart = content.indexOf('<!--')
  let commentEnd = -1
  let textCursor = 0

  function addLocalNames(names: string[]): void {
    for (const name of names) {
      activeLocalNames.add(name)
    }
  }

  function rebuildActiveLocalNames(): void {
    activeLocalNames.clear()
    for (const scope of tagStack) {
      addLocalNames(scope.localNames)
    }
  }

  function popTagScope(tag: string): void {
    let scopeIndex = -1
    for (let index = tagStack.length - 1; index >= 0; index -= 1) {
      if (tagStack[index].tag === tag) {
        scopeIndex = index
        break
      }
    }
    if (scopeIndex === -1) {
      return
    }

    tagStack.splice(scopeIndex)
    rebuildActiveLocalNames()
  }

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
    if (shouldIndexInstanceMembers && textCursor < match.index) {
      instanceMembers.push(...parseInterpolationInstanceMembers(content, templateStart, activeLocalNames, instanceMemberNames, textCursor, match.index))
    }

    if (content[match.index + 1] === '/') {
      if (shouldIndexInstanceMembers) {
        popTagScope(rawTag)
      }
      textCursor = openEnd
      pattern.lastIndex = openEnd
      continue
    }

    const openTag = content.slice(match.index, openEnd)
    const localNames = shouldIndexInstanceMembers ? extractLocalScopeNames(openTag) : []
    if (shouldIndexInstanceMembers) {
      instanceMembers.push(...parseOpenTagInstanceMembers(openTag, templateStart + match.index, activeLocalNames, instanceMemberNames))
    }
    if (rawTag === 'slot') {
      slotDefinitions.push(extractSlotDefinition(openTag, templateStart + match.index))
    } else {
      emits.push(...parseTemplateEmits(openTag, templateStart + match.index))
      eventBusCalls.push(...parseTemplateEventBusCalls(openTag, templateStart + match.index, eventBusNames))
      const dynamicExpression = isDynamicComponentTag(rawTag)
        ? extractDynamicIsExpression(openTag, templateStart + match.index)
        : undefined
      const dynamicTags = dynamicExpression
        ? resolveDynamicComponentTags(dynamicExpression, staticComponentNames, uniqueTags)
        : undefined

      if (dynamicTags || uniqueTags.has(toKebabCase(rawTag)) || isLikelyComponentTag(rawTag)) {
        const attrs = extractAttrs(openTag, templateStart + match.index, vue3ModelEvents)
        const binds = extractBindUsages(openTag, templateStart + match.index)
        const ons = extractOnUsages(openTag, templateStart + match.index)
        const slots = extractComponentSlotUsages(content, templateStart, rawTag, openTag, match.index, openEnd, uniqueTags)
        components.push({
          tag: rawTag,
          dynamicTags,
          dynamicExpressionSpan: dynamicExpression?.span,
          span: {
            start: templateStart + match.index + 1,
            end: templateStart + match.index + 1 + rawTag.length,
          },
          attrs,
          binds,
          ons,
          slots,
          forwardsAttrs: forwardsAttrs(openTag),
          forwardsListeners: forwardsListeners(openTag),
        })
      }
    }

    textCursor = openEnd
    pattern.lastIndex = openEnd
    if (shouldIndexInstanceMembers && !isSelfClosingOpenTag(openTag) && !voidHtmlTags.has(rawTag.toLowerCase())) {
      tagStack.push({ tag: rawTag, localNames })
      addLocalNames(localNames)
    }
  }

  if (shouldIndexInstanceMembers && textCursor < content.length) {
    instanceMembers.push(...parseInterpolationInstanceMembers(content, templateStart, activeLocalNames, instanceMemberNames, textCursor))
  }

  components.sort((a, b) => a.span.start - b.span.start)
  return { components, emits, eventBusCalls, slots: slotDefinitions, instanceMembers: uniqueInstanceMembers(instanceMembers) }
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

  const wrapped = unwrapStaticComponentWrapper(trimmed)
  if (wrapped) {
    return resolveStaticComponentNameExpression(wrapped, staticComponentNames, registeredTags, visited)
  }

  const arrowBody = readSimpleArrowBody(trimmed)
  if (arrowBody) {
    return resolveStaticComponentNameExpression(arrowBody, staticComponentNames, registeredTags, visited)
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
      const candidates = [
        ...binding.tags,
        ...binding.tags.flatMap((tag) => {
          const nested = staticComponentNames.find((item) => item.variableName === tag)
          return nested ? resolveBindingCandidates(nested, staticComponentNames, registeredTags, visited) : []
        }),
      ]
      return uniqueStrings(binding.kind === 'map' || binding.kind === 'array'
        ? [
            ...candidates,
            ...(binding.expression ? resolveStaticComponentNameExpression(binding.expression, staticComponentNames, registeredTags, visited) : []),
          ]
        : candidates)
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

function unwrapStaticComponentWrapper(expression: string): string | undefined {
  const callee = readIdentifier(expression, 0)
  if (!callee || !staticComponentWrappers.has(callee.value)) {
    return undefined
  }

  const open = skipTrivia(expression, callee.end)
  if (expression[open] !== '(' || findMatchingBracket(expression, open) !== expression.length - 1) {
    return undefined
  }

  const argStart = skipTrivia(expression, open + 1)
  const argEnd = findArrayEntryEnd(expression, argStart, expression.length - 1)
  const argument = expression.slice(argStart, argEnd).trim()
  if (!argument) {
    return undefined
  }

  return callee.value === 'computed'
    ? readSimpleFunctionReturn(argument) ?? argument
    : argument
}

function readSimpleFunctionReturn(expression: string): string | undefined {
  return readSimpleArrowBody(expression) ?? readSimpleFunctionBodyReturn(expression)
}

function readSimpleArrowBody(expression: string): string | undefined {
  const arrowIndex = findTopLevelArrow(expression)
  if (arrowIndex === -1) {
    return undefined
  }

  const body = stripOuterParens(expression.slice(arrowIndex + 2).trim())
  if (!body) {
    return undefined
  }
  if (body.startsWith('{') && body.endsWith('}')) {
    return readReturnedExpression(body, 1, body.length - 1)
  }
  return body
}

function readSimpleFunctionBodyReturn(expression: string): string | undefined {
  const functionIndex = expression.indexOf('function')
  if (functionIndex === -1) {
    return undefined
  }
  const bodyOpen = expression.indexOf('{', functionIndex + 'function'.length)
  if (bodyOpen === -1 || findMatchingBracket(expression, bodyOpen) !== expression.length - 1) {
    return undefined
  }
  return readReturnedExpression(expression, bodyOpen + 1, expression.length - 1)
}

function readReturnedExpression(content: string, start: number, end: number): string | undefined {
  let depth = 0
  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0 || !isTokenAt(content, 'return', index)) {
      continue
    }

    const valueStart = skipTrivia(content, index + 'return'.length)
    const valueEnd = findExpressionEnd(content, valueStart, end)
    return content.slice(valueStart, valueEnd).trim()
  }
  return undefined
}

function findTopLevelArrow(expression: string): number {
  let depth = 0
  for (let index = 0; index < expression.length - 1; index += 1) {
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
    if (depth === 0 && expression.startsWith('=>', index)) {
      return index
    }
  }
  return -1
}

function isTokenAt(content: string, token: string, index: number): boolean {
  return content.startsWith(token, index)
    && !/[\w$]/.test(content[index - 1] ?? '')
    && !/[\w$]/.test(content[index + token.length] ?? '')
}

function findExpressionEnd(content: string, start: number, close: number): number {
  let index = start
  let depth = 0

  while (index < close) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }

    const char = content[index]
    if ('([{'.includes(char)) {
      depth += 1
      index += 1
      continue
    }
    if (')]}'.includes(char)) {
      if (depth === 0) {
        return index
      }
      depth -= 1
      index += 1
      continue
    }
    if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
      return index
    }
    index += 1
  }

  return close
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
    const value = content.slice(index, entryEnd).trim()
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
  let depth = 0

  while (index < objectEnd) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (depth !== 0) {
      index += 1
      continue
    }
    if (char === ':') {
      const valueStart = skipTrivia(content, index + 1)
      const valueEnd = findArrayEntryEnd(content, valueStart, objectEnd)
      values.push(content.slice(valueStart, valueEnd).trim())
      index = valueEnd + 1
      continue
    }

    const shorthand = readIdentifier(content, index)
    if (shorthand) {
      const afterName = skipTrivia(content, shorthand.end)
      if (content[afterName] === ',' || afterName >= objectEnd) {
        values.push(shorthand.value)
        index = afterName + 1
        continue
      }
      index = shorthand.end
      continue
    }

    index += 1
  }
  return [...new Set(values)]
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

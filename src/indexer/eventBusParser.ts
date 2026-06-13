import type { EventBusCall, EventBusRegistration, TextSpan } from './types'
import { readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

export const defaultEventBusNames = ['$bus'] as const
const eventBusMethods = {
  $emit: 'emit',
  $on: 'listener',
  $once: 'listener',
  $off: 'listener',
} as const

interface EventBusRoot {
  busName: string
  token: string
}

function readIdentifier(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const match = /^[A-Za-z_$][\w$]*/.exec(content.slice(index))
  if (!match) {
    return undefined
  }
  return { value: match[0], start: index, end: index + match[0].length }
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) {
    index += 1
  }
  return index
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

function hasRootBoundary(content: string, root: string, index: number): boolean {
  const previous = content[index - 1]
  const next = content[index + root.length]
  const previousOk = previous === undefined || (!/[\w$]/.test(previous) && previous !== '.')
  return previousOk && !/[\w$]/.test(next ?? '')
}

function isCodeTokenAt(content: string, token: string, index: number): boolean {
  return content.startsWith(token, index)
    && !/[\w$]/.test(content[index - 1] ?? '')
    && !/[\w$]/.test(content[index + token.length] ?? '')
}

function readAccess(content: string, index: number): number | undefined {
  const cursor = skipTrivia(content, index)
  if (content.startsWith('?.', cursor)) {
    return cursor + 2
  }
  if (content[cursor] === '.') {
    return cursor + 1
  }
  return undefined
}

function readCallOpen(content: string, index: number): number | undefined {
  let cursor = skipTrivia(content, index)
  if (content.startsWith('?.', cursor)) {
    cursor = skipTrivia(content, cursor + 2)
  }
  return content[cursor] === '(' ? cursor : undefined
}

function normalizeEventBusNames(names: readonly string[]): string[] {
  return [...new Set([...defaultEventBusNames, ...names].filter(Boolean))]
}

function eventBusRoots(names: readonly string[]): EventBusRoot[] {
  return normalizeEventBusNames(names)
    .flatMap((busName) => [
      { busName, token: `this.${busName}` },
      { busName, token: busName },
    ])
    .sort((left, right) => right.token.length - left.token.length)
}

function readPrototypeProperty(content: string, index: number): { propertyName: string, span: TextSpan, end: number } | undefined {
  const cursor = skipTrivia(content, index)
  if (content[cursor] === '.') {
    const identifier = readIdentifier(content, skipTrivia(content, cursor + 1))
    return identifier
      ? { propertyName: identifier.value, span: { start: identifier.start, end: identifier.end }, end: identifier.end }
      : undefined
  }

  if (content[cursor] !== '[') {
    return undefined
  }

  const literal = readStringLiteral(content, skipTrivia(content, cursor + 1))
  if (!literal) {
    return undefined
  }
  const close = skipTrivia(content, literal.end + 1)
  return content[close] === ']'
    ? { propertyName: literal.value, span: { start: literal.start, end: literal.end }, end: close + 1 }
    : undefined
}

function isNewVueExpression(content: string, index: number): boolean {
  let cursor = skipTrivia(content, index)
  const newKeyword = readIdentifier(content, cursor)
  if (newKeyword?.value !== 'new') {
    return false
  }

  cursor = skipTrivia(content, newKeyword.end)
  const constructor = readIdentifier(content, cursor)
  return constructor?.value === 'Vue'
    && !/[\w$]/.test(content[constructor.end] ?? '')
}

function collectEventBusVariables(content: string): Set<string> {
  const variables = new Set<string>()
  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }
    if (!isCodeTokenAt(content, 'const', index) && !isCodeTokenAt(content, 'let', index) && !isCodeTokenAt(content, 'var', index)) {
      continue
    }

    let cursor = skipTrivia(content, index + (content.startsWith('const', index) ? 'const'.length : 3))
    const name = readIdentifier(content, cursor)
    if (!name) {
      continue
    }
    cursor = skipTrivia(content, name.end)
    if (content[cursor] === '=' && isNewVueExpression(content, cursor + 1)) {
      variables.add(name.value)
    }
  }
  return variables
}

function isEventBusValue(content: string, index: number, eventBusVariables: Set<string>): boolean {
  if (isNewVueExpression(content, index)) {
    return true
  }
  const identifier = readIdentifier(content, skipTrivia(content, index))
  return Boolean(identifier && eventBusVariables.has(identifier.value) && !/[\w$]/.test(content[identifier.end] ?? ''))
}

export function parseEventBusRegistrations(fileUri: string, content: string, offset = 0): EventBusRegistration[] {
  const registrations: EventBusRegistration[] = []
  const prototypeToken = 'Vue.prototype'
  const eventBusVariables = collectEventBusVariables(content)

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!content.startsWith(prototypeToken, index) || /[\w$]/.test(content[index - 1] ?? '')) {
      continue
    }

    const property = readPrototypeProperty(content, index + prototypeToken.length)
    if (!property) {
      continue
    }

    const equals = skipTrivia(content, property.end)
    if (content[equals] !== '=' || !isEventBusValue(content, equals + 1, eventBusVariables)) {
      continue
    }

    registrations.push({
      propertyName: property.propertyName,
      nameSpan: { start: offset + property.span.start, end: offset + property.span.end },
      fileUri,
    })
  }

  return registrations
}

function findImportFromIndex(content: string, start: number): number {
  let depth = 0

  for (let index = start; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && isCodeTokenAt(content, 'from', index)) {
      return index
    }
    if (depth === 0 && char === ';') {
      return -1
    }
  }

  return -1
}

export function parseStaticImportSources(content: string): string[] {
  const sources: string[] = []

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (isCodeTokenAt(content, 'import', index)) {
      const clauseStart = skipTrivia(content, index + 'import'.length)
      if (content[clauseStart] === '(') {
        const source = readStringLiteral(content, skipTrivia(content, clauseStart + 1))
        if (source) {
          sources.push(source.value)
          index = source.end
        }
        continue
      }

      const sideEffectImport = readStringLiteral(content, clauseStart)
      if (sideEffectImport) {
        sources.push(sideEffectImport.value)
        index = sideEffectImport.end
        continue
      }

      const fromIndex = findImportFromIndex(content, clauseStart)
      if (fromIndex === -1) {
        continue
      }
      const source = readStringLiteral(content, skipTrivia(content, fromIndex + 'from'.length))
      if (source) {
        sources.push(source.value)
        index = source.end
      }
      continue
    }

    if (!isCodeTokenAt(content, 'require', index)) {
      continue
    }
    const open = skipTrivia(content, index + 'require'.length)
    if (content[open] !== '(') {
      continue
    }
    const source = readStringLiteral(content, skipTrivia(content, open + 1))
    if (source) {
      sources.push(source.value)
      index = source.end
    }
  }

  return [...new Set(sources)]
}

export function parseEventBusCalls(content: string, offset: number, names: readonly string[] = [], start = 0, end = content.length): EventBusCall[] {
  const calls: EventBusCall[] = []
  const roots = eventBusRoots(names)

  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const root = roots.find((candidate) => content.startsWith(candidate.token, index) && hasRootBoundary(content, candidate.token, index))
    if (!root) {
      continue
    }

    const methodStart = readAccess(content, index + root.token.length)
    if (methodStart === undefined || methodStart >= end) {
      continue
    }

    const method = (Object.keys(eventBusMethods) as Array<keyof typeof eventBusMethods>)
      .find((candidate) => content.startsWith(candidate, methodStart) && !/[\w$]/.test(content[methodStart + candidate.length] ?? ''))
    if (!method) {
      continue
    }

    const callOpen = readCallOpen(content, methodStart + method.length)
    if (callOpen === undefined || callOpen >= end) {
      continue
    }

    const literal = readStringLiteral(content, skipTrivia(content, callOpen + 1))
    if (!literal || literal.end > end) {
      continue
    }

    calls.push({
      kind: eventBusMethods[method],
      method,
      busName: root.busName,
      eventName: literal.value,
      eventSpan: { start: offset + literal.start, end: offset + literal.end },
      callSpan: { start: offset + index, end: offset + literal.end + 1 },
    })
  }

  return calls
}

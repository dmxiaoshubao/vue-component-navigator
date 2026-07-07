import fsSync from 'node:fs'
import type { ComposableReturnUsage, ImportInfo, ParsedSfc, SfcBlock, SourceLocation, TextSpan } from './types'
import { resolveImportPathWithExtensions } from './relationResolver'
import { createLineStarts } from '../utils/position'
import { maskStringsAndComments, skipStringCommentOrRegex } from '../utils/scriptScan'

interface ScriptSegment {
  content: string
  start: number
}

interface ComposableReturnDefinition {
  name: string
  sourceLocation: SourceLocation
}

interface ReturnedMember {
  name: string
  localName: string
  nameSpan: TextSpan
}

interface DestructuredComposableMember {
  name: string
  localName: string
  nameSpan: TextSpan
}

type ComposableReturnDefinitions = Map<string, Map<string, ComposableReturnDefinition>>

interface ComposableReturnCacheEntry {
  mtimeMs: number
  size: number
  definitions: ComposableReturnDefinitions
}

export type ComposableReturnParseCache = Map<string, ComposableReturnCacheEntry>

interface ScriptSegmentContext extends ScriptSegment {
  masked: string
  destructuresByComposable: Map<string, Array<{ members: DestructuredComposableMember[], searchStart: number }>>
}

export function createComposableReturnParseCache(): ComposableReturnParseCache {
  return new Map()
}

export function parseComposableReturnUsages(uri: string, sfc: ParsedSfc, imports: ImportInfo[], workspaceRoots: string[], cache?: ComposableReturnParseCache): ComposableReturnUsage[] {
  const composableImports = imports.filter(isComposableImport)
  const segments = [sfc.script, sfc.scriptSetup]
    .filter((block): block is SfcBlock => Boolean(block))
    .map((block) => createScriptSegmentContext({ content: block.content, start: block.start }))
  if (segments.length === 0 || composableImports.length === 0) {
    return []
  }

  const definitionsBySource = new Map<string, ComposableReturnDefinitions | undefined>()
  const results: ComposableReturnUsage[] = []

  for (const imported of composableImports) {
    const sourceUri = resolveComposableImport(uri, imported.source, workspaceRoots)
    if (!sourceUri) {
      continue
    }

    if (!definitionsBySource.has(sourceUri)) {
      definitionsBySource.set(sourceUri, readComposableReturnDefinitions(sourceUri, cache))
    }

    const definitions = definitionsBySource.get(sourceUri)
    const returnedMembers = definitions ? definitionsForImport(definitions, imported) : undefined
    if (!returnedMembers || returnedMembers.size === 0) {
      continue
    }

    for (const segment of segments) {
      for (const destructured of segment.destructuresByComposable.get(imported.localName) ?? []) {
        const definitionsByLocalName = new Map<string, ComposableReturnDefinition>()
        const returnedNameByLocalName = new Map<string, string>()
        for (const member of destructured.members) {
          const definition = returnedMembers.get(member.name)
          if (definition) {
            definitionsByLocalName.set(member.localName, definition)
            returnedNameByLocalName.set(member.localName, member.name)
            results.push({
              composableName: imported.localName,
              name: member.name,
              span: shiftSpan(member.nameSpan, segment.start),
              sourceLocation: definition.sourceLocation,
            })
          }
        }

        const usageSpansByName = findIdentifierUsages(segment.masked, new Set(definitionsByLocalName.keys()), destructured.searchStart)
        for (const [localName, usageSpans] of usageSpansByName) {
          const definition = definitionsByLocalName.get(localName)
          if (!definition) {
            continue
          }
          for (const usageSpan of usageSpans) {
            results.push({
              composableName: imported.localName,
              name: returnedNameByLocalName.get(localName) ?? localName,
              span: shiftSpan(usageSpan, segment.start),
              sourceLocation: definition.sourceLocation,
            })
          }
        }
      }
    }
  }

  return dedupeComposableReturnUsages(results)
}

export function resolveComposableImport(fromUri: string, source: string, workspaceRoots: string[]): string | undefined {
  const cleanSource = source.split('?')[0]
  if (cleanSource.endsWith('.vue')) {
    return undefined
  }
  return resolveImportPathWithExtensions(fromUri, cleanSource, workspaceRoots, ['.ts', '.js'])
}

export function isComposableImport(imported: ImportInfo): boolean {
  return isComposableExportName(imported.importedName ?? imported.localName)
}

function readComposableReturnDefinitions(uri: string, cache?: ComposableReturnParseCache): ComposableReturnDefinitions | undefined {
  try {
    const stats = fsSync.statSync(uri)
    const cached = cache?.get(uri)
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.definitions
    }

    const definitions = parseComposableReturnDefinitions(uri, fsSync.readFileSync(uri, 'utf8'))
    cache?.set(uri, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      definitions,
    })
    return definitions
  } catch {
    return undefined
  }
}

function parseComposableReturnDefinitions(uri: string, content: string): ComposableReturnDefinitions {
  const masked = maskStringsAndComments(content)
  const lineStarts = createLineStarts(content)
  const definitions: ComposableReturnDefinitions = new Map()
  const functionReturns = collectComposableFunctions(masked)

  for (const item of functionReturns) {
    if (!isComposableExportName(item.name)) {
      continue
    }
    const returned = collectReturnedDefinitions(uri, lineStarts, content, masked, item.bodyStart, item.bodyEnd)
    if (returned.size === 0) {
      continue
    }
    definitions.set(item.name, returned)
    if (item.defaultExport) {
      definitions.set('default', returned)
    }
  }

  for (const alias of collectDefaultExportAliases(masked)) {
    const returned = definitions.get(alias)
    if (returned) {
      definitions.set('default', returned)
    }
  }

  return definitions
}

function definitionsForImport(definitions: ComposableReturnDefinitions, imported: ImportInfo): Map<string, ComposableReturnDefinition> | undefined {
  if (imported.importedName) {
    return definitions.get(imported.importedName)
  }
  return definitions.get('default') ?? definitions.get(imported.localName)
}

function collectComposableFunctions(content: string): Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> {
  return [
    ...collectVariableComposableFunctions(content),
    ...collectDeclaredComposableFunctions(content),
    ...collectDefaultArrowComposableFunctions(content),
  ]
}

function collectVariableComposableFunctions(content: string): Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> {
  const results: Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> = []
  const pattern = /\b(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const bodyStart = findFunctionBodyStart(content, pattern.lastIndex)
    if (bodyStart === undefined) {
      continue
    }
    results.push({
      name: match[2],
      bodyStart,
      bodyEnd: findMatchingBracket(content, bodyStart),
      defaultExport: false,
    })
  }

  return results
}

function collectDeclaredComposableFunctions(content: string): Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> {
  const results: Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> = []
  const pattern = /\bexport\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*\(|\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const name = match[1] ?? match[2] ?? 'default'
    const open = content.indexOf('(', match.index)
    const close = open === -1 ? -1 : findMatchingBracket(content, open)
    const bodyStart = close === -1 ? -1 : skipTrivia(content, close + 1)
    if (bodyStart < 0 || content[bodyStart] !== '{') {
      continue
    }
    results.push({
      name,
      bodyStart,
      bodyEnd: findMatchingBracket(content, bodyStart),
      defaultExport: match[0].includes('export default'),
    })
  }

  return results
}

function collectDefaultArrowComposableFunctions(content: string): Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> {
  const results: Array<{ name: string, bodyStart: number, bodyEnd: number, defaultExport: boolean }> = []
  const pattern = /\bexport\s+default\s+/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const cursor = skipTrivia(content, pattern.lastIndex)
    const keyword = readIdentifier(content, cursor)
    if (isCodeTokenAt(content, 'function', cursor) || (keyword && keyword.value !== 'async')) {
      continue
    }

    const bodyStart = findFunctionBodyStart(content, cursor)
    if (bodyStart === undefined) {
      continue
    }
    results.push({
      name: 'default',
      bodyStart,
      bodyEnd: findMatchingBracket(content, bodyStart),
      defaultExport: true,
    })
  }

  return results
}

function collectDefaultExportAliases(content: string): string[] {
  const aliases: string[] = []
  const pattern = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    if (match[1] !== 'function' && match[1] !== 'async') {
      aliases.push(match[1])
    }
  }

  return aliases
}

function collectReturnedDefinitions(uri: string, lineStarts: number[], content: string, masked: string, bodyStart: number, bodyEnd: number): Map<string, ComposableReturnDefinition> {
  const results = new Map<string, ComposableReturnDefinition>()

  for (const object of findTopLevelReturnObjects(masked, bodyStart, bodyEnd)) {
    for (const member of parseReturnedMembers(content, masked, object.start, object.end)) {
      if (results.has(member.name)) {
        continue
      }

      const declaration = findLocalDeclarationSpan(masked, member.localName, bodyStart + 1, member.nameSpan.start)
      const span = declaration ?? member.nameSpan
      results.set(member.name, {
        name: member.name,
        sourceLocation: {
          uri,
          lineStarts,
          span,
        },
      })
    }
  }

  return results
}

function findTopLevelReturnObjects(content: string, bodyStart: number, bodyEnd: number): TextSpan[] {
  const results: TextSpan[] = []
  let depth = 1

  for (let index = bodyStart + 1; index < bodyEnd; index += 1) {
    const char = content[index]
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      continue
    }

    if (depth !== 1 || !isCodeTokenAt(content, 'return', index)) {
      continue
    }

    const objectStart = skipTrivia(content, index + 'return'.length)
    if (content[objectStart] !== '{') {
      continue
    }
    results.push({ start: objectStart, end: findMatchingBracket(content, objectStart) })
  }

  return results
}

function parseReturnedMembers(content: string, masked: string, objectStart: number, objectEnd: number): ReturnedMember[] {
  const members: ReturnedMember[] = []
  let cursor = objectStart + 1

  while (cursor < objectEnd) {
    cursor = skipTrivia(masked, cursor)
    if (cursor >= objectEnd) {
      break
    }
    if (masked[cursor] === ',') {
      cursor += 1
      continue
    }
    if (masked.startsWith('...', cursor)) {
      cursor = findTopLevelCommaOrEnd(masked, cursor + 3, objectEnd)
      continue
    }

    const name = readIdentifier(content, cursor)
    if (!name) {
      cursor = findTopLevelCommaOrEnd(masked, cursor + 1, objectEnd)
      continue
    }

    let localName = name.value
    const afterName = skipTrivia(masked, name.end)
    if (masked[afterName] === ':') {
      const value = readIdentifier(content, skipTrivia(masked, afterName + 1))
      if (value) {
        localName = value.value
      }
    }

    members.push({
      name: name.value,
      localName,
      nameSpan: { start: name.start, end: name.end },
    })
    cursor = findTopLevelCommaOrEnd(masked, name.end, objectEnd)
  }

  return members
}

function createScriptSegmentContext(segment: ScriptSegment): ScriptSegmentContext {
  const masked = maskStringsAndComments(segment.content)
  return {
    ...segment,
    masked,
    destructuresByComposable: findComposableDestructures(segment.content, masked),
  }
}

function findComposableDestructures(content: string, masked: string): Map<string, Array<{ members: DestructuredComposableMember[], searchStart: number }>> {
  const results = new Map<string, Array<{ members: DestructuredComposableMember[], searchStart: number }>>()
  const pattern = /\b(?:const|let|var)\s*\{/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(masked))) {
    const objectStart = masked.indexOf('{', match.index)
    const objectEnd = findMatchingBracket(masked, objectStart)
    const equal = skipTrivia(masked, objectEnd + 1)
    if (masked[equal] !== '=') {
      continue
    }

    const callee = readIdentifier(content, skipTrivia(masked, equal + 1))
    if (!callee) {
      continue
    }

    const open = skipTrivia(masked, skipTypeArguments(masked, skipTrivia(masked, callee.end)))
    if (masked[open] !== '(') {
      continue
    }

    const close = findMatchingBracket(masked, open)
    const members = parseDestructuredMembers(content, masked, objectStart, objectEnd)
    if (members.length > 0) {
      const items = results.get(callee.value) ?? []
      items.push({ members, searchStart: close + 1 })
      results.set(callee.value, items)
    }
  }

  return results
}

function parseDestructuredMembers(content: string, masked: string, objectStart: number, objectEnd: number): DestructuredComposableMember[] {
  const members: DestructuredComposableMember[] = []
  let cursor = objectStart + 1

  while (cursor < objectEnd) {
    cursor = skipTrivia(masked, cursor)
    if (cursor >= objectEnd) {
      break
    }
    if (masked[cursor] === ',') {
      cursor += 1
      continue
    }
    if (masked.startsWith('...', cursor)) {
      cursor = findTopLevelCommaOrEnd(masked, cursor + 3, objectEnd)
      continue
    }

    const name = readIdentifier(content, cursor)
    if (!name) {
      cursor = findTopLevelCommaOrEnd(masked, cursor + 1, objectEnd)
      continue
    }

    let localName = name.value
    const afterName = skipTrivia(masked, name.end)
    if (masked[afterName] === ':') {
      const alias = readIdentifier(content, skipTrivia(masked, afterName + 1))
      if (alias) {
        localName = alias.value
      }
    }

    members.push({ name: name.value, localName, nameSpan: { start: name.start, end: name.end } })
    cursor = findTopLevelCommaOrEnd(masked, name.end, objectEnd)
  }

  return members
}

function findIdentifierUsages(masked: string, names: Set<string>, start: number): Map<string, TextSpan[]> {
  const usages = new Map<string, TextSpan[]>()
  const shadowed = new Set<string>()
  if (names.size === 0) {
    return usages
  }

  for (let index = start; index < masked.length; index += 1) {
    if (!isIdentifierStart(masked[index])) {
      continue
    }

    const end = readIdentifierEnd(masked, index + 1)
    const name = masked.slice(index, end)
    if (!names.has(name)) {
      index = end - 1
      continue
    }
    if (isDeclarationName(masked, index, end)) {
      shadowed.add(name)
      index = end - 1
      continue
    }
    if (!shadowed.has(name) && isVariableUsage(masked, index, end)) {
      const items = usages.get(name) ?? []
      items.push({ start: index, end })
      usages.set(name, items)
    }

    index = end - 1
  }

  return usages
}

function isDeclarationName(content: string, start: number, end: number): boolean {
  const before = content.slice(Math.max(0, start - 32), start)
  if (/\b(?:const|let|var|function)\s+$/.test(before)) {
    return true
  }

  const lineStart = content.lastIndexOf('\n', start - 1) + 1
  const linePrefix = content.slice(lineStart, start)
  return /\b(?:const|let|var)\s*\{[^=]*$/.test(linePrefix)
    || isParameterName(content, start, end)
}

function isParameterName(content: string, start: number, end: number): boolean {
  const next = nextNonWhitespace(content, end)
  if (next !== ')' && next !== ',' && next !== ':') {
    return false
  }

  let cursor = start - 1
  let depth = 0
  while (cursor >= 0) {
    const char = content[cursor]
    if (char === ')') {
      depth += 1
    } else if (char === '(') {
      if (depth === 0) {
        const prefix = content.slice(Math.max(0, cursor - 24), cursor)
        return /\bfunction\s+[A-Za-z_$][\w$]*\s*$/.test(prefix)
          || /=>\s*$/.test(content.slice(end, Math.min(content.length, end + 16)))
      }
      depth -= 1
    } else if (char === '\n' || char === ';' || char === '{') {
      return false
    }
    cursor -= 1
  }

  return false
}

function isVariableUsage(content: string, start: number, end: number): boolean {
  const previous = previousNonWhitespace(content, start - 1)
  if (previous === '.') {
    return false
  }
  const next = nextNonWhitespace(content, end)
  if (next === ':') {
    return false
  }
  return true
}

function findLocalDeclarationSpan(content: string, name: string, start: number, end: number): TextSpan | undefined {
  const escaped = escapeRegExp(name)
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+(${escaped})\\b`, 'g'),
    new RegExp(`\\b(?:async\\s+)?function\\s+(${escaped})\\b`, 'g'),
  ]

  for (const pattern of patterns) {
    pattern.lastIndex = start
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) && match.index < end) {
      const matchStart = match.index + match[0].lastIndexOf(name)
      return { start: matchStart, end: matchStart + name.length }
    }
  }

  return undefined
}

function findFunctionBodyStart(content: string, start: number): number | undefined {
  let cursor = skipTrivia(content, start)
  if (isCodeTokenAt(content, 'async', cursor)) {
    cursor = skipTrivia(content, cursor + 'async'.length)
  }

  if (isCodeTokenAt(content, 'function', cursor)) {
    const open = content.indexOf('(', cursor + 'function'.length)
    if (open === -1) {
      return undefined
    }
    const close = findMatchingBracket(content, open)
    const bodyStart = skipTrivia(content, close + 1)
    return content[bodyStart] === '{' ? bodyStart : undefined
  }

  const arrow = findArrow(content, cursor)
  if (arrow === -1) {
    return undefined
  }

  const bodyStart = skipTrivia(content, arrow + 2)
  return content[bodyStart] === '{' ? bodyStart : undefined
}

function findArrow(content: string, start: number): number {
  let parenDepth = 0
  let bracketDepth = 0
  let angleDepth = 0

  for (let index = start; index < content.length; index += 1) {
    const char = content[index]
    if (char === ';' && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
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
    } else if (char === '<') {
      angleDepth += 1
    } else if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1)
    } else if (content.startsWith('=>', index) && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      return index
    }
  }

  return -1
}

function findTopLevelCommaOrEnd(content: string, start: number, end: number): number {
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0

  for (let index = start; index < end; index += 1) {
    const char = content[index]
    if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
    } else if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
    } else if (char === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      return index + 1
    }
  }

  return end
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

function skipTrivia(content: string, index: number): number {
  let cursor = index
  while (cursor < content.length) {
    const skipped = skipStringCommentOrRegex(content, cursor)
    if (skipped !== undefined) {
      cursor = skipped
      continue
    }
    if (!/\s/.test(content[cursor] ?? '')) {
      break
    }
    cursor += 1
  }
  return cursor
}

function skipTypeArguments(content: string, index: number): number {
  if (content[index] !== '<') {
    return index
  }

  let depth = 0
  for (let cursor = index; cursor < content.length; cursor += 1) {
    if (content[cursor] === '<') {
      depth += 1
      continue
    }
    if (content[cursor] === '>') {
      depth -= 1
      if (depth === 0) {
        return cursor + 1
      }
      continue
    }
    if (depth === 0 && content[cursor] === '(') {
      return cursor
    }
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

function readIdentifierEnd(content: string, index: number): number {
  while (index < content.length && /[\w$]/.test(content[index])) {
    index += 1
  }
  return index
}

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char))
}

function isCodeTokenAt(content: string, token: string, index: number): boolean {
  return content.startsWith(token, index)
    && !/[\w$]/.test(content[index - 1] ?? '')
    && !/[\w$]/.test(content[index + token.length] ?? '')
}

function isComposableExportName(name: string): boolean {
  return name === 'default' || /^use[A-Z0-9_$]/.test(name)
}

function previousNonWhitespace(content: string, index: number): string | undefined {
  let cursor = index
  while (cursor >= 0 && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  return content[cursor]
}

function nextNonWhitespace(content: string, index: number): string | undefined {
  let cursor = index
  while (cursor < content.length && /\s/.test(content[cursor])) {
    cursor += 1
  }
  return content[cursor]
}

function shiftSpan(span: TextSpan, offset: number): TextSpan {
  return { start: span.start + offset, end: span.end + offset }
}

function dedupeComposableReturnUsages(usages: ComposableReturnUsage[]): ComposableReturnUsage[] {
  const seen = new Set<string>()
  const results: ComposableReturnUsage[] = []

  for (const usage of usages) {
    const key = `${usage.sourceLocation?.uri ?? ''}\0${usage.sourceLocation?.span.start ?? -1}\0${usage.span.start}\0${usage.span.end}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(usage)
  }

  return results
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

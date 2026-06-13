import type { ComponentRegistration, ImportInfo, MixinReference, PropInfo, ProvideInfo, ScriptIndex, StaticComponentNameBinding, TextSpan } from './types'
import { resolveImportPath, resolveImportPathWithExtensions } from './relationResolver'
import { parseEventBusCalls } from './eventBusParser'
import { findCodeToken, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

interface PropertyValue {
  name: string
  nameSpan: TextSpan
  valueStart: number
  valueEnd: number
  async: boolean
  documentation?: string
}

interface StaticComponentAlias {
  localName?: string
  source?: string
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

function normalizeJSDoc(comment: string): string {
  return comment
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim()
}

function readLeadingMemberTrivia(content: string, index: number): { cursor: number, documentation?: string } {
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

function readPropertyName(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const identifier = readIdentifier(content, index)
  if (identifier) {
    return identifier
  }

  const literal = readStringLiteral(content, index)
  if (!literal) {
    return undefined
  }
  return { value: literal.value, start: literal.start, end: literal.end }
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

function findDefaultExportObject(content: string): { open: number, close: number } | undefined {
  const exportIndex = findCodeToken(content, 'export default')
  if (exportIndex === -1) {
    return undefined
  }

  for (let index = exportIndex + 'export default'.length; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (content[index] !== '{') {
      continue
    }

    return { open: index, close: findMatchingBracket(content, index) }
  }

  return undefined
}

function findNamedExportObject(content: string, exportName: string): { open: number, close: number } | undefined {
  let index = 0

  while (index < content.length) {
    const exportIndex = findCodeToken(content, 'export', index)
    if (exportIndex === -1) {
      return undefined
    }

    let cursor = skipTrivia(content, exportIndex + 'export'.length)
    const declaration = readIdentifier(content, cursor)
    if (!declaration || !['const', 'let', 'var'].includes(declaration.value)) {
      index = exportIndex + 'export'.length
      continue
    }

    cursor = skipTrivia(content, declaration.end)
    const name = readIdentifier(content, cursor)
    if (name?.value !== exportName) {
      index = declaration.end
      continue
    }

    cursor = skipTrivia(content, name.end)
    if (content[cursor] !== '=') {
      index = name.end
      continue
    }

    cursor = skipTrivia(content, cursor + 1)
    if (content[cursor] === '{') {
      return { open: cursor, close: findMatchingBracket(content, cursor) }
    }
    index = cursor
  }

  return undefined
}

function findExportObject(content: string, exportName = 'default'): { open: number, close: number } | undefined {
  return exportName === 'default'
    ? findDefaultExportObject(content)
    : findNamedExportObject(content, exportName)
}

function findTopLevelProperty(content: string, open: number, close: number, name: string): PropertyValue | undefined {
  let index = open + 1
  let depth = 0

  while (index < close) {
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
      depth -= 1
      index += 1
      continue
    }

    if (depth !== 0) {
      index += 1
      continue
    }

    index = skipTrivia(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }

    const propertyName = readPropertyName(content, index)
    if (!propertyName) {
      index += 1
      continue
    }

    let cursor = skipTrivia(content, propertyName.end)
    if (content[cursor] === ':') {
      cursor = skipTrivia(content, cursor + 1)
    } else if (content[cursor] !== '(') {
      index = propertyName.end
      continue
    }

    const valueEnd = findMemberValueEnd(content, cursor, close)
    if (propertyName.value !== name) {
      index = valueEnd
      continue
    }

    return {
      name: propertyName.value,
      nameSpan: { start: propertyName.start, end: propertyName.end },
      valueStart: cursor,
      valueEnd,
      async: false,
    }
  }

  return undefined
}

function findFunctionLikeValueEnd(content: string, start: number, close: number): number | undefined {
  let cursor = start
  const firstWord = readIdentifier(content, cursor)
  if (firstWord?.value === 'async') {
    cursor = skipWhitespace(content, firstWord.end)
  }

  const functionWord = readIdentifier(content, cursor)
  if (functionWord?.value === 'function') {
    cursor = skipWhitespace(content, functionWord.end)
  }

  if (content[cursor] !== '(') {
    return undefined
  }

  const paramsEnd = findMatchingBracket(content, cursor)
  cursor = skipWhitespace(content, paramsEnd + 1)
  if (content.slice(cursor, cursor + 2) === '=>') {
    cursor = skipWhitespace(content, cursor + 2)
    if (content[cursor] === '{') {
      return findMatchingBracket(content, cursor) + 1
    }
    return findExpressionEnd(content, cursor, close)
  }

  if (content[cursor] === '{') {
    return findMatchingBracket(content, cursor) + 1
  }

  return undefined
}

function findMemberValueEnd(content: string, start: number, objectEnd: number): number {
  return findFunctionLikeValueEnd(content, start, objectEnd)
    ?? (content[start] === '{' || content[start] === '[' || content[start] === '('
      ? findMatchingBracket(content, start) + 1
      : findExpressionEnd(content, start, objectEnd))
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
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
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

function eachObjectMember(content: string, objectStart: number, objectEnd: number, visit: (member: PropertyValue) => void): void {
  let index = objectStart + 1

  while (index < objectEnd) {
    const trivia = readLeadingMemberTrivia(content, index)
    index = trivia.cursor
    if (content[index] === ',') {
      index += 1
      continue
    }

    const asyncKeyword = readIdentifier(content, index)
    const isAsync = asyncKeyword?.value === 'async'
    const propertyName = isAsync
      ? readPropertyName(content, skipTrivia(content, asyncKeyword.end)) ?? asyncKeyword
      : readPropertyName(content, index)

    if (!propertyName) {
      index += 1
      continue
    }

    let cursor = skipTrivia(content, propertyName.end)
    if (content[cursor] === ':') {
      cursor = skipTrivia(content, cursor + 1)
    }

    const valueEnd = findMemberValueEnd(content, cursor, objectEnd)

    visit({
      name: propertyName.value,
      nameSpan: { start: propertyName.start, end: propertyName.end },
      valueStart: cursor,
      valueEnd,
      async: isAsync,
      documentation: trivia.documentation,
    })

    index = valueEnd
  }
}

function parseImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  let index = 0

  while (index < content.length) {
    const importIndex = findCodeToken(content, 'import', index)
    if (importIndex === -1) {
      break
    }

    const clauseStart = skipTrivia(content, importIndex + 'import'.length)
    if (content[clauseStart] === '(') {
      index = importIndex + 'import'.length
      continue
    }

    const fromIndex = findImportFromIndex(content, clauseStart)
    if (fromIndex === -1) {
      index = importIndex + 'import'.length
      continue
    }

    const source = readStringLiteral(content, skipTrivia(content, fromIndex + 'from'.length))
    if (source) {
      imports.push(...parseImportClause(content.slice(clauseStart, fromIndex).trim(), source.value))
      index = source.end + 1
      continue
    }

    index = fromIndex + 'from'.length
  }

  return imports
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

function parseImportClause(clause: string, source: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  const namedStart = clause.indexOf('{')
  const defaultClause = namedStart === -1 ? clause : clause.slice(0, namedStart).replace(/,$/, '').trim()
  const defaultName = readIdentifier(defaultClause, 0)
  if (defaultName) {
    imports.push({ localName: defaultName.value, source })
  }

  if (namedStart === -1) {
    return imports
  }

  const namedEnd = clause.indexOf('}', namedStart + 1)
  if (namedEnd === -1) {
    return imports
  }

  for (const part of clause.slice(namedStart + 1, namedEnd).split(',')) {
    const match = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part)
    if (!match) {
      continue
    }
    imports.push({
      localName: match[2] ?? match[1],
      importedName: match[1],
      source,
    })
  }

  return imports
}

function parseStringLiteral(content: string, start: number, end: number): string | undefined {
  const text = content.slice(start, end).trim()
  const quote = text[0]
  if ((quote !== '\'' && quote !== '"') || text[text.length - 1] !== quote) {
    return undefined
  }
  return text.slice(1, -1)
}

function readAsyncImportSource(content: string, start: number, end: number): string | undefined {
  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!isCodeTokenAt(content, 'import', index)) {
      continue
    }

    const open = skipTrivia(content, index + 'import'.length)
    if (content[open] !== '(') {
      continue
    }

    const literal = readStringLiteral(content, skipTrivia(content, open + 1))
    if (literal && literal.end <= end) {
      return literal.value
    }
  }

  return undefined
}

function readRequireArraySource(content: string, start: number, end: number): string | undefined {
  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!isCodeTokenAt(content, 'require', index)) {
      continue
    }

    const open = skipTrivia(content, index + 'require'.length)
    if (content[open] !== '(') {
      continue
    }

    const arrayOpen = skipTrivia(content, open + 1)
    if (content[arrayOpen] !== '[') {
      continue
    }

    const literal = readStringLiteral(content, skipTrivia(content, arrayOpen + 1))
    if (literal && literal.end <= end) {
      return literal.value
    }
  }

  return undefined
}

function readComponentExpressionSource(content: string, start: number, end: number): string | undefined {
  return readAsyncImportSource(content, start, end)
    ?? readRequireArraySource(content, start, end)
}

function findVariableInitializer(content: string, start: number): number | undefined {
  let index = start
  let depth = 0

  while (index < content.length) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(' || char === '<') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')' || char === '>') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (depth === 0 && char === '=') {
      return index
    }
    if (depth === 0 && (char === ',' || char === ';' || char === '\n')) {
      return undefined
    }

    index += 1
  }

  return undefined
}

function collectStaticComponentAliases(content: string, importSources: Map<string, string>): Map<string, StaticComponentAlias> {
  const aliases = new Map<string, StaticComponentAlias>()
  let depth = 0

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0 || (!isCodeTokenAt(content, 'const', index) && !isCodeTokenAt(content, 'let', index) && !isCodeTokenAt(content, 'var', index))) {
      continue
    }

    let cursor = skipTrivia(content, index + 3)
    if (content.startsWith('const', index)) {
      cursor = skipTrivia(content, index + 'const'.length)
    }

    while (cursor < content.length) {
      const name = readIdentifier(content, cursor)
      if (!name) {
        break
      }

      cursor = skipTrivia(content, name.end)
      const equals = findVariableInitializer(content, cursor)
      if (equals === undefined) {
        break
      }

      const valueStart = skipTrivia(content, equals + 1)
      const valueEnd = findExpressionEnd(content, valueStart, content.length)
      const identifier = readIdentifier(content, valueStart)
      const importedSource = identifier ? importSources.get(identifier.value) : undefined
      const asyncSource = readComponentExpressionSource(content, valueStart, valueEnd)

      if (importedSource || asyncSource || identifier) {
        aliases.set(name.value, {
          localName: identifier?.value,
          source: importedSource ?? asyncSource,
        })
      }

      cursor = skipTrivia(content, valueEnd)
      if (content[cursor] !== ',') {
        break
      }
      cursor = skipTrivia(content, cursor + 1)
    }
  }

  return aliases
}

function readStaticCandidateValue(content: string, start: number, end: number): string | undefined {
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

function readObjectStaticCandidateValues(content: string, objectStart: number, objectEnd: number): string[] {
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
    if (depth !== 0 || char !== ':') {
      index += 1
      continue
    }

    const valueStart = skipTrivia(content, index + 1)
    const valueEnd = findMemberValueEnd(content, valueStart, objectEnd)
    const value = readStaticCandidateValue(content, valueStart, valueEnd)
    if (value) {
      values.push(value)
      index = valueEnd
      continue
    }

    index = valueEnd
  }

  return [...new Set(values)]
}

function readArrayStaticCandidateValues(content: string, arrayStart: number, arrayEnd: number): string[] {
  const values: string[] = []
  let index = arrayStart + 1

  while (index < arrayEnd) {
    index = skipTrivia(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }

    const entryEnd = findArrayEntryEnd(content, index, arrayEnd)
    const value = readStaticCandidateValue(content, index, entryEnd)
    if (value) {
      values.push(value)
    }
    index = entryEnd + 1
  }

  return [...new Set(values)]
}

function collectStaticComponentNameBindings(content: string): StaticComponentNameBinding[] {
  const bindings: StaticComponentNameBinding[] = []
  let depth = 0

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '{' || char === '[' || char === '(') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']' || char === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0 || (!isCodeTokenAt(content, 'const', index) && !isCodeTokenAt(content, 'let', index) && !isCodeTokenAt(content, 'var', index))) {
      continue
    }

    let cursor = skipTrivia(content, index + 3)
    if (content.startsWith('const', index)) {
      cursor = skipTrivia(content, index + 'const'.length)
    }

    while (cursor < content.length) {
      const name = readIdentifier(content, cursor)
      if (!name) {
        break
      }

      cursor = skipTrivia(content, name.end)
      const equals = findVariableInitializer(content, cursor)
      if (equals === undefined) {
        break
      }

      const valueStart = skipTrivia(content, equals + 1)
      const valueEnd = findExpressionEnd(content, valueStart, content.length)
      const expression = content.slice(valueStart, valueEnd).trim()
      const literalOrIdentifier = readStaticCandidateValue(content, valueStart, valueEnd)

      if (literalOrIdentifier) {
        bindings.push({
          variableName: name.value,
          tags: [literalOrIdentifier],
          kind: 'literal',
          expression,
        })
      } else if (content[valueStart] === '{') {
        const values = readObjectStaticCandidateValues(content, valueStart, findMatchingBracket(content, valueStart))
        if (values.length > 0) {
          bindings.push({
            variableName: name.value,
            tags: values,
            kind: 'map',
            expression,
          })
        }
      } else if (content[valueStart] === '[') {
        const values = readArrayStaticCandidateValues(content, valueStart, findMatchingBracket(content, valueStart))
        if (values.length > 0) {
          bindings.push({
            variableName: name.value,
            tags: values,
            kind: 'array',
            expression,
          })
        }
      } else if (expression) {
        bindings.push({
          variableName: name.value,
          tags: [],
          kind: 'expression',
          expression,
        })
      }

      cursor = skipTrivia(content, valueEnd)
      if (content[cursor] !== ',') {
        break
      }
      cursor = skipTrivia(content, cursor + 1)
    }
  }

  return bindings
}

function resolveStaticComponentAlias(name: string, aliases: Map<string, StaticComponentAlias>, importSources: Map<string, string>): StaticComponentAlias | undefined {
  let current = name
  const visited = new Set<string>()

  for (let depth = 0; depth < 4; depth += 1) {
    if (visited.has(current)) {
      return undefined
    }
    visited.add(current)

    const importedSource = importSources.get(current)
    if (importedSource) {
      return { localName: current, source: importedSource }
    }

    const alias = aliases.get(current)
    if (!alias) {
      return undefined
    }
    if (alias.source) {
      return { localName: alias.localName ?? current, source: alias.source }
    }
    if (!alias.localName || alias.localName === current) {
      return undefined
    }
    current = alias.localName
  }

  return undefined
}

function resolveComponentRegistration(content: string, member: PropertyValue, importSources: Map<string, string>, aliases: Map<string, StaticComponentAlias>): { localName: string, source?: string } {
  const valueEnd = findExpressionEnd(content, member.valueStart, member.valueEnd)
  const identifier = readIdentifier(content, member.valueStart)
  const localName = identifier?.value ?? member.name
  const expressionSource = readComponentExpressionSource(content, member.valueStart, valueEnd)
  if (expressionSource) {
    return { localName: member.name, source: expressionSource }
  }

  const resolvedAlias = resolveStaticComponentAlias(localName, aliases, importSources)
  return {
    localName: resolvedAlias?.localName ?? localName,
    source: resolvedAlias?.source,
  }
}

function parseComponents(content: string, components: PropertyValue | undefined, imports: ImportInfo[], uri: string, scriptStart: number, workspaceRoots: string[]): ComponentRegistration[] {
  if (!components || content[components.valueStart] !== '{') {
    return []
  }

  const results: ComponentRegistration[] = []
  const importSources = new Map(imports.map((item) => [item.localName, item.source]))
  const aliases = collectStaticComponentAliases(content, importSources)
  eachObjectMember(content, components.valueStart, components.valueEnd - 1, (member) => {
    const { localName, source } = resolveComponentRegistration(content, member, importSources, aliases)
    results.push({
      tag: member.name,
      localName,
      source,
      targetUri: source ? resolveImportPath(uri, source, workspaceRoots) : undefined,
      nameSpan: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
    })
  })
  return results
}

function parseMixins(content: string, mixins: PropertyValue | undefined, imports: ImportInfo[], uri: string, scriptStart: number, workspaceRoots: string[]): MixinReference[] {
  if (!mixins || content[mixins.valueStart] !== '[') {
    return []
  }

  const importMap = new Map(imports.map((item) => [item.localName, item]))
  const results: MixinReference[] = []
  let index = mixins.valueStart + 1
  const end = mixins.valueEnd - 1

  while (index < end) {
    index = skipTrivia(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }

    const entryEnd = findArrayEntryEnd(content, index, end)
    const identifier = readIdentifier(content, index)
    if (!identifier || skipTrivia(content, identifier.end) !== entryEnd) {
      index = entryEnd + 1
      continue
    }

    const imported = importMap.get(identifier.value)
    const source = imported?.source
    results.push({
      localName: identifier.value,
      importedName: imported?.importedName,
      source,
      targetUri: source ? resolveImportPathWithExtensions(uri, source, workspaceRoots, ['.js', '.ts', '.vue']) : undefined,
      span: { start: scriptStart + identifier.start, end: scriptStart + identifier.end },
    })
    index = entryEnd + 1
  }

  return results
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

function parseProps(content: string, props: PropertyValue | undefined, scriptStart: number): PropInfo[] {
  if (!props) {
    return []
  }

  const results: PropInfo[] = []
  if (content[props.valueStart] === '[') {
    const pattern = /['"]([^'"]+)['"]/g
    pattern.lastIndex = props.valueStart
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) && match.index < props.valueEnd) {
      results.push({
        name: match[1],
        span: { start: scriptStart + match.index + 1, end: scriptStart + match.index + 1 + match[1].length },
        detail: match[1],
      })
    }
    return results
  }

  if (content[props.valueStart] !== '{') {
    return []
  }

  eachObjectMember(content, props.valueStart, props.valueEnd - 1, (member) => {
    results.push({
      name: member.name,
      span: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
      detail: content.slice(member.nameSpan.start, member.valueEnd).trim(),
      documentation: member.documentation,
    })
  })
  return results
}

function formatMethodSignature(content: string, member: PropertyValue): string {
  let cursor = member.valueStart
  let asyncPrefix = member.async

  const firstWord = readIdentifier(content, cursor)
  if (firstWord?.value === 'async') {
    asyncPrefix = true
    cursor = skipWhitespace(content, firstWord.end)
  }

  const functionWord = readIdentifier(content, cursor)
  if (functionWord?.value === 'function') {
    cursor = skipWhitespace(content, functionWord.end)
    const functionName = readIdentifier(content, cursor)
    if (functionName) {
      cursor = skipWhitespace(content, functionName.end)
    }
  }

  if (content[cursor] !== '(') {
    return member.name
  }

  const paramsEnd = findMatchingBracket(content, cursor)
  const params = content.slice(cursor, paramsEnd + 1).replace(/\s+/g, ' ')
  return `${asyncPrefix ? 'async ' : ''}${member.name}${params}`
}

function parseMethods(content: string, methods: PropertyValue | undefined, scriptStart: number): ScriptIndex['methods'] {
  if (!methods || content[methods.valueStart] !== '{') {
    return []
  }

  const results: ScriptIndex['methods'] = []
  eachObjectMember(content, methods.valueStart, methods.valueEnd - 1, (member) => {
    const signature = formatMethodSignature(content, member)
    results.push({
      name: member.name,
      span: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
      detail: signature,
      signature,
      documentation: member.documentation,
    })
  })
  return results
}

function parseEmits(content: string, scriptStart: number, start = 0, end = content.length): ScriptIndex['emits'] {
  const emits: ScriptIndex['emits'] = []
  const emitToken = 'this.$emit'

  for (let index = start; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!content.startsWith(emitToken, index)) {
      continue
    }

    let cursor = skipTrivia(content, index + emitToken.length)
    if (content[cursor] !== '(' || cursor >= end) {
      continue
    }

    cursor = skipTrivia(content, cursor + 1)
    const literal = readStringLiteral(content, cursor)
    if (!literal || literal.end > end) {
      continue
    }

    emits.push({
      eventName: literal.value,
      eventSpan: { start: scriptStart + literal.start, end: scriptStart + literal.end },
      callSpan: { start: scriptStart + index, end: scriptStart + literal.end + 1 },
    })
  }

  return emits
}

function parseProvides(content: string, provide: PropertyValue | undefined, scriptStart: number): ProvideInfo[] {
  const objectRange = provide ? findProvideObjectRange(content, provide) : undefined
  if (!objectRange) {
    return []
  }

  const results: ProvideInfo[] = []
  eachObjectMember(content, objectRange.open, objectRange.close, (member) => {
    results.push({
      key: member.name,
      keySpan: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
      detail: content.slice(member.nameSpan.start, member.valueEnd).trim(),
      documentation: member.documentation,
    })
  })
  return results
}

function findProvideObjectRange(content: string, provide: PropertyValue): { open: number, close: number } | undefined {
  if (content[provide.valueStart] === '{') {
    return { open: provide.valueStart, close: provide.valueEnd - 1 }
  }

  for (let index = provide.valueStart; index < provide.valueEnd; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!content.startsWith('return', index)) {
      continue
    }

    const cursor = skipTrivia(content, index + 'return'.length)
    if (content[cursor] === '{') {
      return { open: cursor, close: findMatchingBracket(content, cursor) }
    }
  }

  return undefined
}

function parseInjects(content: string, inject: PropertyValue | undefined, scriptStart: number): ScriptIndex['injects'] {
  if (!inject) {
    return []
  }

  if (content[inject.valueStart] === '[') {
    return parseInjectArray(content, inject, scriptStart)
  }

  if (content[inject.valueStart] !== '{') {
    return []
  }

  const results: ScriptIndex['injects'] = []
  eachObjectMember(content, inject.valueStart, inject.valueEnd - 1, (member) => {
    const from = readInjectFrom(content, member)
    const key = from?.value ?? member.name
    const keySpan = from
      ? { start: scriptStart + from.span.start, end: scriptStart + from.span.end }
      : { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end }
    results.push({
      key,
      keySpan,
      localName: member.name,
      localSpan: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
      detail: content.slice(member.nameSpan.start, member.valueEnd).trim(),
    })
  })
  return results
}

function parseInjectArray(content: string, inject: PropertyValue, scriptStart: number): ScriptIndex['injects'] {
  const results: ScriptIndex['injects'] = []
  const pattern = /['"]([^'"]+)['"]/g
  pattern.lastIndex = inject.valueStart
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) && match.index < inject.valueEnd) {
    results.push({
      key: match[1],
      keySpan: { start: scriptStart + match.index + 1, end: scriptStart + match.index + 1 + match[1].length },
      localName: match[1],
      localSpan: { start: scriptStart + match.index + 1, end: scriptStart + match.index + 1 + match[1].length },
      detail: match[1],
    })
  }

  return results
}

function readInjectFrom(content: string, member: PropertyValue): { value: string, span: TextSpan } | undefined {
  const literal = readStringLiteral(content, member.valueStart)
  if (literal && literal.end <= member.valueEnd) {
    return { value: literal.value, span: { start: literal.start, end: literal.end } }
  }

  if (content[member.valueStart] !== '{') {
    return undefined
  }

  let result: { value: string, span: TextSpan } | undefined
  eachObjectMember(content, member.valueStart, member.valueEnd - 1, (nested) => {
    if (result || nested.name !== 'from') {
      return
    }
    const fromLiteral = readStringLiteral(content, nested.valueStart)
    if (fromLiteral && fromLiteral.end <= nested.valueEnd) {
      result = { value: fromLiteral.value, span: { start: fromLiteral.start, end: fromLiteral.end } }
    }
  })
  return result
}

export function parseScript(uri: string, content: string, scriptStart: number, workspaceRoots: string[] = [], exportName = 'default', eventBusNames: readonly string[] = []): ScriptIndex {
  const imports = parseImports(content)
  const staticComponentNames = exportName === 'default' ? collectStaticComponentNameBindings(content) : []
  const exportObject = findExportObject(content, exportName)
  if (!exportObject) {
    return {
      imports,
      mixins: [],
      components: [],
      staticComponentNames,
      props: [],
      methods: [],
      emits: exportName === 'default' ? parseEmits(content, scriptStart) : [],
      eventBusCalls: exportName === 'default' ? parseEventBusCalls(content, scriptStart, eventBusNames) : [],
      provides: [],
      injects: [],
    }
  }

  const nameProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'name')
  const mixinsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'mixins')
  const componentsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'components')
  const propsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'props')
  const methodsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'methods')
  const provideProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'provide')
  const injectProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'inject')

  return {
    componentName: nameProperty ? parseStringLiteral(content, nameProperty.valueStart, nameProperty.valueEnd) : undefined,
    imports,
    mixins: parseMixins(content, mixinsProperty, imports, uri, scriptStart, workspaceRoots),
    components: parseComponents(content, componentsProperty, imports, uri, scriptStart, workspaceRoots),
    staticComponentNames,
    props: parseProps(content, propsProperty, scriptStart),
    methods: parseMethods(content, methodsProperty, scriptStart),
    emits: parseEmits(content, scriptStart, exportObject.open, exportObject.close),
    eventBusCalls: parseEventBusCalls(content, scriptStart, eventBusNames, exportObject.open, exportObject.close),
    provides: parseProvides(content, provideProperty, scriptStart),
    injects: parseInjects(content, injectProperty, scriptStart),
  }
}

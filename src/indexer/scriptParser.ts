import type { ComponentRegistration, ImportInfo, PropInfo, ProvideInfo, ScriptIndex, TextSpan } from './types'
import { resolveImportPath } from './relationResolver'
import { findCodeToken, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

interface PropertyValue {
  name: string
  nameSpan: TextSpan
  valueStart: number
  valueEnd: number
  async: boolean
  documentation?: string
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

function findExportObject(content: string): { open: number, close: number } | undefined {
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

function findValueEnd(content: string, start: number, close: number): number {
  let index = start
  while (index < close) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }

    if (content[index] === ',' || content[index] === '\n') {
      break
    }
    index += 1
  }
  return index
}

function findFunctionLikeValueEnd(content: string, start: number): number | undefined {
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
  }

  if (content[cursor] === '{') {
    return findMatchingBracket(content, cursor) + 1
  }

  return paramsEnd + 1
}

function findMemberValueEnd(content: string, start: number, objectEnd: number): number {
  return findFunctionLikeValueEnd(content, start)
    ?? (content[start] === '{' || content[start] === '[' || content[start] === '('
      ? findMatchingBracket(content, start) + 1
      : findValueEnd(content, start, objectEnd))
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

    const localName = readIdentifier(content, skipTrivia(content, importIndex + 'import'.length))
    if (!localName) {
      index = importIndex + 'import'.length
      continue
    }

    const fromIndex = findCodeToken(content, 'from', localName.end)
    if (fromIndex === -1) {
      index = localName.end
      continue
    }

    const source = readStringLiteral(content, skipTrivia(content, fromIndex + 'from'.length))
    if (source) {
      imports.push({ localName: localName.value, source: source.value })
      index = source.end + 1
      continue
    }

    index = fromIndex + 'from'.length
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

function parseComponents(content: string, components: PropertyValue | undefined, imports: ImportInfo[], uri: string, scriptStart: number, workspaceRoots: string[]): ComponentRegistration[] {
  if (!components || content[components.valueStart] !== '{') {
    return []
  }

  const results: ComponentRegistration[] = []
  eachObjectMember(content, components.valueStart, components.valueEnd - 1, (member) => {
    const localIdentifier = readIdentifier(content, member.valueStart)
    const localName = localIdentifier?.value ?? member.name
    const source = imports.find((item) => item.localName === localName)?.source
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

function parseEmits(content: string, scriptStart: number): ScriptIndex['emits'] {
  const emits: ScriptIndex['emits'] = []
  const emitToken = 'this.$emit'

  for (let index = 0; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (!content.startsWith(emitToken, index)) {
      continue
    }

    let cursor = skipTrivia(content, index + emitToken.length)
    if (content[cursor] !== '(') {
      continue
    }

    cursor = skipTrivia(content, cursor + 1)
    const literal = readStringLiteral(content, cursor)
    if (!literal) {
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

export function parseScript(uri: string, content: string, scriptStart: number, workspaceRoots: string[] = []): ScriptIndex {
  const imports = parseImports(content)
  const exportObject = findExportObject(content)
  if (!exportObject) {
    return { imports, components: [], props: [], methods: [], emits: parseEmits(content, scriptStart), provides: [], injects: [] }
  }

  const nameProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'name')
  const componentsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'components')
  const propsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'props')
  const methodsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'methods')
  const provideProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'provide')
  const injectProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'inject')

  return {
    componentName: nameProperty ? parseStringLiteral(content, nameProperty.valueStart, nameProperty.valueEnd) : undefined,
    imports,
    components: parseComponents(content, componentsProperty, imports, uri, scriptStart, workspaceRoots),
    props: parseProps(content, propsProperty, scriptStart),
    methods: parseMethods(content, methodsProperty, scriptStart),
    emits: parseEmits(content, scriptStart),
    provides: parseProvides(content, provideProperty, scriptStart),
    injects: parseInjects(content, injectProperty, scriptStart),
  }
}

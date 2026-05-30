import type { ComponentRegistration, ImportInfo, PropInfo, ScriptIndex, TextSpan } from './types'
import { resolveImportPath } from './relationResolver'

interface PropertyValue {
  name: string
  nameSpan: TextSpan
  valueStart: number
  valueEnd: number
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

  const quote = content[index]
  if (quote !== '\'' && quote !== '"') {
    return undefined
  }

  const end = content.indexOf(quote, index + 1)
  if (end === -1) {
    return undefined
  }
  return { value: content.slice(index + 1, end), start: index + 1, end }
}

function findMatchingBracket(content: string, openIndex: number): number {
  const open = content[openIndex]
  const close = open === '{' ? '}' : open === '[' ? ']' : ')'
  let depth = 0
  let quote: string | undefined

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index]
    const previous = content[index - 1]

    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = undefined
      }
      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      continue
    }

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
  const exportIndex = content.indexOf('export default')
  if (exportIndex === -1) {
    return undefined
  }

  const open = content.indexOf('{', exportIndex)
  if (open === -1) {
    return undefined
  }

  return { open, close: findMatchingBracket(content, open) }
}

function findTopLevelProperty(content: string, open: number, close: number, name: string): PropertyValue | undefined {
  let index = open + 1
  let depth = 0
  let quote: string | undefined

  while (index < close) {
    const char = content[index]
    const previous = content[index - 1]

    if (quote) {
      if (char === quote && previous !== '\\') {
        quote = undefined
      }
      index += 1
      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      index += 1
      continue
    }

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
    if (content[cursor] !== ':') {
      index = propertyName.end
      continue
    }

    cursor = skipTrivia(content, cursor + 1)
    if (propertyName.value !== name) {
      index = cursor
      continue
    }

    const valueEnd = content[cursor] === '{' || content[cursor] === '[' || content[cursor] === '('
      ? findMatchingBracket(content, cursor) + 1
      : findValueEnd(content, cursor, close)

    return {
      name: propertyName.value,
      nameSpan: { start: propertyName.start, end: propertyName.end },
      valueStart: cursor,
      valueEnd,
    }
  }

  return undefined
}

function findValueEnd(content: string, start: number, close: number): number {
  let index = start
  while (index < close && content[index] !== ',' && content[index] !== '\n') {
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
    index = skipTrivia(content, index)
    if (content[index] === ',') {
      index += 1
      continue
    }

    const asyncKeyword = readIdentifier(content, index)
    const propertyName = asyncKeyword?.value === 'async'
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
    })

    index = valueEnd
  }
}

function parseImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  const pattern = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    imports.push({ localName: match[1], source: match[2] })
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

function parseComponents(content: string, components: PropertyValue | undefined, imports: ImportInfo[], uri: string, scriptStart: number): ComponentRegistration[] {
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
      targetUri: source ? resolveImportPath(uri, source) : undefined,
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
      detail: content.slice(member.nameSpan.start, Math.min(member.valueEnd, member.nameSpan.start + 120)).split('\n')[0],
    })
  })
  return results
}

function parseMethods(content: string, methods: PropertyValue | undefined, scriptStart: number): ScriptIndex['methods'] {
  if (!methods || content[methods.valueStart] !== '{') {
    return []
  }

  const results: ScriptIndex['methods'] = []
  eachObjectMember(content, methods.valueStart, methods.valueEnd - 1, (member) => {
    results.push({
      name: member.name,
      span: { start: scriptStart + member.nameSpan.start, end: scriptStart + member.nameSpan.end },
      detail: content.slice(member.nameSpan.start, Math.min(member.valueEnd, member.nameSpan.start + 120)).split('\n')[0],
    })
  })
  return results
}

function parseEmits(content: string, scriptStart: number): ScriptIndex['emits'] {
  const emits: ScriptIndex['emits'] = []
  const pattern = /this\.\$emit\(\s*(['"])([^'"]+)\1/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const eventStart = match.index + match[0].lastIndexOf(match[2])
    emits.push({
      eventName: match[2],
      eventSpan: { start: scriptStart + eventStart, end: scriptStart + eventStart + match[2].length },
      callSpan: { start: scriptStart + match.index, end: scriptStart + match.index + match[0].length },
    })
  }

  return emits
}

export function parseScript(uri: string, content: string, scriptStart: number): ScriptIndex {
  const imports = parseImports(content)
  const exportObject = findExportObject(content)
  if (!exportObject) {
    return { imports, components: [], props: [], methods: [], emits: parseEmits(content, scriptStart) }
  }

  const nameProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'name')
  const componentsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'components')
  const propsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'props')
  const methodsProperty = findTopLevelProperty(content, exportObject.open, exportObject.close, 'methods')

  return {
    componentName: nameProperty ? parseStringLiteral(content, nameProperty.valueStart, nameProperty.valueEnd) : undefined,
    imports,
    components: parseComponents(content, componentsProperty, imports, uri, scriptStart),
    props: parseProps(content, propsProperty, scriptStart),
    methods: parseMethods(content, methodsProperty, scriptStart),
    emits: parseEmits(content, scriptStart),
  }
}

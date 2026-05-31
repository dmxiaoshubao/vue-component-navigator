import path from 'node:path'
import type { GlobalComponentContext, GlobalComponentRegistration, ImportInfo, TextSpan } from './types'
import { resolveImportPath } from './relationResolver'
import { findCodeToken, readStringLiteral, skipStringCommentOrRegex } from '../utils/scriptScan'

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

function findMatchingParen(content: string, openIndex: number): number {
  let depth = 0

  for (let index = openIndex; index < content.length; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    if (content[index] === '(') {
      depth += 1
    } else if (content[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return content.length - 1
}

function splitTopLevelArguments(content: string, start: number, end: number): TextSpan[] {
  const args: TextSpan[] = []
  let argStart = skipTrivia(content, start)
  let depth = 0

  for (let index = argStart; index < end; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      index = skipped - 1
      continue
    }

    const char = content[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      continue
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      continue
    }
    if (char === ',' && depth === 0) {
      args.push({ start: argStart, end: index })
      argStart = skipTrivia(content, index + 1)
    }
  }

  if (argStart < end) {
    args.push({ start: argStart, end })
  }

  return args
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

function readStaticComponentName(content: string, span: TextSpan): { value: string, span: TextSpan, usesImportedName?: boolean } | undefined {
  const cursor = skipTrivia(content, span.start)
  const literal = readStringLiteral(content, cursor)
  if (literal && literal.end <= span.end) {
    return { value: literal.value, span: { start: literal.start, end: literal.end } }
  }

  const expression = content.slice(cursor, span.end).trim()
  const importNameMatch = /^([A-Za-z_$][\w$]*)\.name$/.exec(expression)
  if (importNameMatch) {
    const nameStart = content.indexOf('name', cursor + importNameMatch[1].length)
    return { value: importNameMatch[1], span: { start: nameStart, end: nameStart + 'name'.length }, usesImportedName: true }
  }

  return readStaticConstString(content, expression)
}

function readStaticConstString(content: string, identifier: string): { value: string, span: TextSpan } | undefined {
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) {
    return undefined
  }

  const pattern = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*(['"])([^'"]+)\\1`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content))) {
    const matchIndex = match.index
    if (isInSkippedRange(content, matchIndex)) {
      continue
    }

    const start = matchIndex + match[0].lastIndexOf(match[2])
    return { value: match[2], span: { start, end: start + match[2].length } }
  }

  return undefined
}

function isInSkippedRange(content: string, offset: number): boolean {
  for (let index = 0; index < offset; index += 1) {
    const skipped = skipStringCommentOrRegex(content, index)
    if (skipped !== undefined) {
      if (offset < skipped) {
        return true
      }
      index = skipped - 1
    }
  }
  return false
}

function readLocalComponentName(content: string, span: TextSpan): { value: string, span: TextSpan } | undefined {
  const identifier = readIdentifier(content, skipTrivia(content, span.start))
  if (!identifier || identifier.end > span.end) {
    return undefined
  }
  return { value: identifier.value, span: { start: identifier.start, end: identifier.end } }
}

export function parseGlobalComponents(uri: string, content: string, workspaceRoots: string[] = []): GlobalComponentRegistration[] {
  const imports = parseImports(content)
  const results: GlobalComponentRegistration[] = []
  let index = 0

  while (index < content.length) {
    const componentIndex = findNextComponentCall(content, index)
    if (componentIndex === -1) {
      break
    }

    const open = content.indexOf('(', componentIndex)
    if (open === -1) {
      break
    }

    const close = findMatchingParen(content, open)
    const args = splitTopLevelArguments(content, open + 1, close)
    if (args.length >= 2) {
      const tag = readStaticComponentName(content, args[0])
      const localName = readLocalComponentName(content, args[1])
      const source = localName ? imports.find((item) => item.localName === localName.value)?.source : undefined
      const targetUri = source ? resolveImportPath(uri, source, workspaceRoots) : undefined
      if (tag && localName && source && targetUri && !isInsideNodeModules(targetUri)) {
        results.push({
          tag: tag.value,
          localName: localName.value,
          source,
          targetUri,
          usesImportedName: tag.usesImportedName,
          nameSpan: tag.span,
          registerSpan: { start: componentIndex, end: close + 1 },
          fileUri: uri,
        })
      }
    }

    index = close + 1
  }

  return results
}

function findNextComponentCall(content: string, startIndex: number): number {
  let index = startIndex

  while (index < content.length) {
    const componentIndex = findCodeToken(content, '.component', index)
    if (componentIndex === -1) {
      return -1
    }

    const cursor = skipTrivia(content, componentIndex + '.component'.length)
    if (content[cursor] === '(') {
      return componentIndex
    }

    index = componentIndex + '.component'.length
  }

  return -1
}

export function guessGlobalComponentsFromRequireContext(uri: string, content: string): GlobalComponentContext[] {
  if (!content.includes('require.context') || !content.includes('.component')) {
    return []
  }

  const contextMatch = /require\.context\(\s*(['"])([^'"]+)\1\s*,\s*true\s*,\s*\/\\\.vue\$\/\s*\)/.exec(content)
  if (!contextMatch) {
    return []
  }

  const root = path.resolve(path.dirname(uri), contextMatch[2])
  if (isInsideNodeModules(root)) {
    return []
  }

  return [{
    source: contextMatch[2],
    targetUri: root,
    nameSpan: { start: contextMatch.index, end: contextMatch.index + contextMatch[0].length },
    registerSpan: { start: contextMatch.index, end: contextMatch.index + contextMatch[0].length },
    fileUri: uri,
  }]
}

function isInsideNodeModules(file: string): boolean {
  return path.normalize(file).split(path.sep).includes('node_modules')
}

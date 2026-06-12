import * as vscode from 'vscode'
import type { MethodInfo, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefCompletionContext, findRefCompletionContextInFile, findRefRootCompletionContext, findRefRootCompletionContextInFile } from '../indexer/workspaceIndex'
import { findResolvedRefComponents } from '../indexer/relationResolver'
import { formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { createLineStarts, positionToOffset } from '../utils/position'

const HIGH_PRIORITY_SORT_PREFIX = '\u0000\u0000'
const OPTIONAL_CHAIN_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0000`
const INJECT_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0001`
const MAX_INJECT_CONTEXT_SCAN = 20000

interface StringContext {
  start: number
  end: number
  text: string
}

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function offsetInDocument(document: vscode.TextDocument, position: vscode.Position): number | undefined {
  return positionToOffset(createLineStarts(document.getText()), { line: position.line, character: position.character })
}

export class VueCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    const file = isVueDocument(document)
      ? this.index.syncContent(document.uri.fsPath, document.getText())
      : this.index.getFile(document.uri.fsPath)
    const offset = isVueDocument(document)
      ? this.index.offsetAt(document.uri.fsPath, position.line, position.character)
      : offsetInDocument(document, position)
    if (offset === undefined) {
      return undefined
    }

    const injectContext = findInjectCompletionContext(document.getText(), offset)
    if (injectContext) {
      const consumers = file
        ? [file]
        : this.index.hasMixinSource(document.uri.fsPath)
          ? this.index.findSourceConsumers(document.uri.fsPath)
          : []
      return this.provideKeyCompletions(consumers, injectContext, position)
    }

    const refRootContext = isVueDocument(document) && file
      ? findRefRootCompletionContextInFile(file, offset)
      : findRefRootCompletionContext(document.getText(), offset)
    if (refRootContext) {
      const consumers = file
        ? [file]
        : this.index.hasMixinSource(document.uri.fsPath)
          ? this.index.findSourceConsumers(document.uri.fsPath)
          : []
      return this.refNameCompletions(consumers, refRootContext, position)
    }

    const refContext = isVueDocument(document) && file
      ? findRefCompletionContextInFile(file, offset)
      : findRefCompletionContext(document.getText(), offset)
    if (!refContext) {
      return undefined
    }

    const children = file
      ? this.resolveChildren(file, refContext.refName)
      : this.resolveSourceChildren(document.uri.fsPath, refContext.refName)
    const methods = this.uniqueMethods(children)

    const range = new vscode.Range(
      position.line,
      position.character - refContext.partialMethodName.length - refContext.accessToken.length,
      position.line,
      position.character,
    )

    return methods.map(({ child, method }) => {
      const item = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method)
      item.detail = `${child.scriptIndex.componentName ?? child.fileName}.methods.${method.name}`
      const documentation = formatJSDocMarkdown(method.documentation)
      if (documentation) {
        item.documentation = new vscode.MarkdownString(`${markdownCodeBlock(method.signature)}\n\n${documentation}`)
      } else {
        item.documentation = method.signature
      }
      item.range = range
      item.insertText = `${refContext.accessToken}${method.name}`
      item.filterText = `${refContext.accessToken}${refContext.partialMethodName}${method.name}`
      item.sortText = `${refContext.accessToken === '?.' ? OPTIONAL_CHAIN_SORT_PREFIX : HIGH_PRIORITY_SORT_PREFIX}${method.name}`
      item.preselect = true
      return item
    })
  }

  private refNameCompletions(consumers: VueFileIndex[], context: { accessToken: '' | '.' | '?.', partialRefName: string }, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const refNames = uniqueRefNames(consumers)
    if (refNames.length === 0) {
      return undefined
    }

    const range = new vscode.Range(
      position.line,
      position.character - context.partialRefName.length - context.accessToken.length,
      position.line,
      position.character,
    )

    return refNames.map((refName) => {
      const item = new vscode.CompletionItem(refName, vscode.CompletionItemKind.Method)
      item.detail = 'template ref'
      item.range = range
      item.insertText = `${context.accessToken}${refName}`
      item.filterText = `${context.accessToken}${context.partialRefName}${refName}`
      item.sortText = `${HIGH_PRIORITY_SORT_PREFIX}${refName}`
      item.preselect = true
      return item
    })
  }

  private resolveChildren(file: VueFileIndex, refName: string): VueFileIndex[] {
    return findResolvedRefComponents(this.index, file, refName)
      .map((childUri) => this.index.getFile(childUri))
      .filter((child): child is VueFileIndex => Boolean(child))
  }

  private resolveSourceChildren(sourceUri: string, refName: string): VueFileIndex[] {
    if (!this.index.hasMixinSource(sourceUri)) {
      return []
    }

    return this.index.findSourceRefOwners(sourceUri, refName)
      .flatMap((file) => findResolvedRefComponents(this.index, file, refName)
        .map((childUri) => this.index.getFile(childUri)))
      .filter((child): child is VueFileIndex => Boolean(child))
  }

  private uniqueMethods(children: VueFileIndex[]): Array<{ child: VueFileIndex, method: MethodInfo }> {
    const seen = new Set<string>()
    const results: Array<{ child: VueFileIndex, method: MethodInfo }> = []
    for (const child of children) {
      for (const method of child.scriptIndex.methods) {
        const key = `${child.uri}\0${method.name}`
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        results.push({ child, method })
      }
    }
    return results
  }

  private provideKeyCompletions(consumers: VueFileIndex[], context: StringContext, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const keys = this.provideKeysForConsumers(consumers)
    if (keys.length === 0) {
      return undefined
    }

    const range = new vscode.Range(
      position.line,
      position.character - context.text.length,
      position.line,
      position.character,
    )

    return keys.map((key) => {
      const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Method)
      item.detail = 'provide key'
      item.range = range
      item.insertText = key
      item.filterText = key
      item.sortText = `${INJECT_SORT_PREFIX}${key}`
      return item
    })
  }

  private provideKeysForConsumers(consumers: VueFileIndex[]): string[] {
    const seen = new Set<string>()
    const results: string[] = []
    for (const consumer of consumers) {
      for (const key of this.index.getProvideKeysForConsumer(consumer.uri)) {
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        results.push(key)
      }
    }
    return results
  }
}

function uniqueRefNames(consumers: VueFileIndex[]): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const consumer of consumers) {
    for (const component of consumer.templateIndex.components) {
      for (const attr of component.attrs) {
        if (attr.kind !== 'ref' || seen.has(attr.name)) {
          continue
        }
        seen.add(attr.name)
        results.push(attr.name)
      }
    }
  }
  return results
}

function findInjectCompletionContext(content: string, offset: number): StringContext | undefined {
  const stringContext = findStringContext(content, offset)
  if (!stringContext) {
    return undefined
  }

  const injectProperty = findNearestInjectProperty(content, stringContext.start)
  if (!injectProperty) {
    return undefined
  }

  const valueStart = skipWhitespace(content, injectProperty.valueStart)
  if (content[valueStart] === '[' && stringContext.start < injectProperty.valueEnd) {
    return isInsideRange(stringContext.start, valueStart, injectProperty.valueEnd) ? stringContext : undefined
  }

  if (content[valueStart] !== '{' || !isInsideRange(stringContext.start, valueStart, injectProperty.valueEnd)) {
    return undefined
  }

  if (isObjectMemberName(content, valueStart, injectProperty.valueEnd, stringContext.start)) {
    return stringContext
  }

  return isInjectFromValue(content, valueStart, injectProperty.valueEnd, stringContext.start) ? stringContext : undefined
}

function findStringContext(content: string, offset: number): StringContext | undefined {
  const quoteIndex = findOpeningQuote(content, offset)
  if (quoteIndex === undefined) {
    return undefined
  }

  const quote = content[quoteIndex]
  const end = findStringEnd(content, quoteIndex)
  if (offset > end) {
    return undefined
  }

  return { start: quoteIndex + 1, end, text: content.slice(quoteIndex + 1, offset) }
}

function findOpeningQuote(content: string, offset: number): number | undefined {
  for (let cursor = offset - 1; cursor >= 0; cursor -= 1) {
    const char = content[cursor]
    if (char === '\n') {
      return undefined
    }
    if ((char === '\'' || char === '"') && !isEscaped(content, cursor)) {
      return cursor
    }
  }
  return undefined
}

function isEscaped(content: string, index: number): boolean {
  let count = 0
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    count += 1
  }
  return count % 2 === 1
}

function findNearestInjectProperty(content: string, before: number): { valueStart: number, valueEnd: number } | undefined {
  let index = Math.max(0, before - MAX_INJECT_CONTEXT_SCAN)
  let result: { valueStart: number, valueEnd: number } | undefined

  while (index < before) {
    const match = /(?:^|[,{])\s*inject\s*:/.exec(content.slice(index, before))
    if (!match) {
      break
    }

    const colon = index + match.index + match[0].lastIndexOf(':')
    const valueStart = skipWhitespace(content, colon + 1)
    if (valueStart >= before) {
      break
    }

    const valueEnd = findValueEnd(content, valueStart)
    if (before <= valueEnd) {
      result = { valueStart, valueEnd }
    }
    index = valueEnd + 1
  }

  return result
}

function findValueEnd(content: string, start: number): number {
  const open = content[start]
  if (open === '[' || open === '{' || open === '(') {
    return findMatching(content, start) + 1
  }

  let index = start
  while (index < content.length && content[index] !== ',' && content[index] !== '\n') {
    index += 1
  }
  return index
}

function findMatching(content: string, openIndex: number): number {
  const open = content[openIndex]
  const close = open === '[' ? ']' : open === '{' ? '}' : ')'
  let depth = 0
  let index = openIndex

  while (index < content.length) {
    const quote = content[index]
    if (quote === '\'' || quote === '"' || quote === '`') {
      index = skipQuoted(content, index, quote)
      continue
    }

    if (content.startsWith('//', index)) {
      const lineEnd = content.indexOf('\n', index + 2)
      index = lineEnd === -1 ? content.length : lineEnd + 1
      continue
    }

    if (content.startsWith('/*', index)) {
      const commentEnd = content.indexOf('*/', index + 2)
      index = commentEnd === -1 ? content.length : commentEnd + 2
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
    index += 1
  }

  return content.length - 1
}

function isObjectMemberName(content: string, objectStart: number, objectEnd: number, stringStart: number): boolean {
  const afterString = skipWhitespace(content, findStringEnd(content, stringStart - 1) + 1)
  if (afterString !== -1 && content[afterString] === ':') {
    return isTopLevelObjectEntry(content, objectStart, objectEnd, stringStart)
  }
  return false
}

function isInjectFromValue(content: string, objectStart: number, objectEnd: number, stringStart: number): boolean {
  let cursor = stringStart - 2
  while (cursor >= objectStart && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  if (content[cursor] !== ':') {
    return false
  }
  cursor -= 1
  while (cursor >= objectStart && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  const end = cursor + 1
  while (cursor >= objectStart && /[\w$]/.test(content[cursor])) {
    cursor -= 1
  }
  return content.slice(cursor + 1, end) === 'from'
    && isInsideRange(stringStart, objectStart, objectEnd)
}

function isTopLevelObjectEntry(content: string, objectStart: number, objectEnd: number, offset: number): boolean {
  let depth = 0
  for (let index = objectStart; index < objectEnd; index += 1) {
    const quote = content[index]
    if (quote === '\'' || quote === '"' || quote === '`') {
      const stringEnd = skipQuoted(content, index, quote)
      if (offset > index && offset < stringEnd) {
        return depth === 1
      }
      index = stringEnd - 1
      continue
    }
    if (content[index] === '{' || content[index] === '[' || content[index] === '(') {
      depth += 1
    } else if (content[index] === '}' || content[index] === ']' || content[index] === ')') {
      depth = Math.max(0, depth - 1)
    }
  }
  return false
}

function findStringEnd(content: string, quoteIndex: number): number {
  return skipQuoted(content, quoteIndex, content[quoteIndex]) - 1
}

function skipQuoted(content: string, index: number, quote: string): number {
  let cursor = index + 1
  while (cursor < content.length) {
    if (content[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (content[cursor] === quote) {
      return cursor + 1
    }
    cursor += 1
  }
  return content.length
}

function skipWhitespace(content: string, index: number): number {
  let cursor = index
  while (cursor < content.length && /\s/.test(content[cursor])) {
    cursor += 1
  }
  return cursor
}

function isInsideRange(offset: number, start: number, end: number): boolean {
  return offset >= start && offset <= end
}

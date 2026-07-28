import * as vscode from 'vscode'
import type { EventBusMethod, MethodInfo, PropInfo, TemplateComponentUsage, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefCompletionContext, findRefCompletionContextInFile, findRefRootCompletionContext, findRefRootCompletionContextInFile } from '../indexer/workspaceIndex'
import { findResolvedRefComponents } from '../indexer/relationResolver'
import { toKebabCase } from '../utils/casing'
import { formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { createLineStarts, positionToOffset } from '../utils/position'
import { maskStringsAndComments } from '../utils/scriptScan'

const HIGH_PRIORITY_SORT_PREFIX = '\u0000\u0000'
const OPTIONAL_CHAIN_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0000`
const INJECT_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0001`
const EVENT_BUS_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0002`
const PROP_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0003`
const MAX_INJECT_CONTEXT_SCAN = 20000
const eventBusMethodCompletions: EventBusMethod[] = ['$emit', '$on', '$once', '$off']
const eventBusCompletionMethods = new Set<EventBusMethod>(eventBusMethodCompletions)

interface StringContext {
  start: number
  end: number
  text: string
}

interface EventBusCompletionContext extends StringContext {
  busName: string
  method: EventBusMethod
}

interface EventBusMethodCompletionContext {
  busName: string
  accessToken: '.' | '?.'
  partialMethodName: string
}

interface TemplatePropCompletionContext {
  tag: string
  component?: TemplateComponentUsage
  prefix: '' | ':' | 'v-bind:'
  partialName: string
  tokenLength: number
  existingPropNames: Set<string>
}

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function shouldInspectNonVueCompletion(document: vscode.TextDocument, position: vscode.Position, index: WorkspaceIndex): boolean {
  const linePrefix = getLinePrefix(document, position)
  if (linePrefix === undefined) {
    return true
  }

  if (linePrefix.includes('this.$refs')) {
    return true
  }

  const eventBusNames = index.getEventBusNames()
  if (eventBusNames.length > 0 && eventBusNames.some((name) => linePrefix.includes(name))) {
    return true
  }

  const inString = hasOpenStringBeforeCursor(linePrefix)
  if (inString && eventBusNames.length > 0) {
    return true
  }

  return inString && index.hasIndexedDocumentContext(document.uri.fsPath)
}

function getLinePrefix(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  if (typeof document.lineAt !== 'function') {
    return undefined
  }
  return document.lineAt(position.line).text.slice(0, position.character)
}

function hasOpenStringBeforeCursor(linePrefix: string): boolean {
  let quote: '\'' | '"' | undefined
  for (let index = 0; index < linePrefix.length; index += 1) {
    const char = linePrefix[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
    }
  }
  return quote !== undefined
}

function offsetInContent(content: string, position: vscode.Position): number | undefined {
  return positionToOffset(createLineStarts(content), { line: position.line, character: position.character })
}

function eventBusCompletionSearchContent(file: VueFileIndex | undefined, content: string, offset: number): string {
  if (!file) {
    return maskStringsAndComments(content)
  }

  if (file.script && offset >= file.script.start && offset <= file.script.end) {
    return file.searchableContent
  }

  return content
}

export class VueCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    const vueDocument = isVueDocument(document)
    if (document.uri.scheme !== 'file') {
      return undefined
    }
    // 补全可能在每次按键后触发；未保存时直接退出，不读取全文也不更新索引。
    if (document.isDirty) {
      return undefined
    }
    if (vueDocument && !this.index.isInsideIndexedWorkspace(document.uri.fsPath)) {
      return undefined
    }
    if (!vueDocument && !this.index.isInsideIndexedWorkspace(document.uri.fsPath)) {
      return undefined
    }
    if (!vueDocument && !shouldInspectNonVueCompletion(document, position, this.index)) {
      return undefined
    }
    const content = document.getText()
    const file = this.index.getIndexedDocumentFile(document.uri.fsPath)
    const offset = vueDocument
      ? this.index.offsetAt(document.uri.fsPath, position.line, position.character)
      : offsetInContent(content, position)
    if (offset === undefined) {
      return undefined
    }

    const eventBusNames = file?.vueVersion === 3 ? [] : this.index.getEventBusNames()
    const eventBusSearchContent = eventBusCompletionSearchContent(file, content, offset)
    const eventBusMethodContext = findEventBusMethodCompletionContext(eventBusSearchContent, offset, eventBusNames)
    if (eventBusMethodContext) {
      return this.eventBusMethodCompletions(eventBusMethodContext, position)
    }

    const eventBusContext = findEventBusCompletionContext(content, eventBusSearchContent, offset, eventBusNames)
    if (eventBusContext) {
      return this.eventBusEventCompletions(eventBusContext, position)
    }

    const injectContext = findInjectCompletionContext(content, offset)
    if (injectContext) {
      const consumers = file
        ? [file]
        : this.index.hasMixinSource(document.uri.fsPath)
          ? this.index.findSourceConsumers(document.uri.fsPath)
          : []
      return this.provideKeyCompletions(consumers, injectContext, position)
    }

    const propContext = vueDocument && file?.vueVersion === 2
      ? findTemplatePropCompletionContext(file, content, offset)
      : undefined
    if (propContext) {
      return this.templatePropCompletions(file!, propContext, position)
    }

    if (file?.vueVersion === 3) {
      return undefined
    }

    const refRootContext = isVueDocument(document) && file
      ? findRefRootCompletionContextInFile(file, offset)
      : findRefRootCompletionContext(content, offset)
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
      : findRefCompletionContext(content, offset)
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

  private eventBusMethodCompletions(context: EventBusMethodCompletionContext, position: vscode.Position): vscode.CompletionItem[] {
    const range = new vscode.Range(
      position.line,
      position.character - context.partialMethodName.length - context.accessToken.length,
      position.line,
      position.character,
    )

    return eventBusMethodCompletions.map((method) => {
      const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method)
      item.detail = `${context.busName} event bus method`
      item.range = range
      item.insertText = `${context.accessToken}${method}`
      item.filterText = `${context.accessToken}${context.partialMethodName}${method}`
      item.sortText = `${EVENT_BUS_SORT_PREFIX}${method}`
      item.preselect = true
      return item
    })
  }

  private eventBusEventCompletions(context: EventBusCompletionContext, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const eventNames = this.index.getEventBusEventNames(context.busName)
    if (eventNames.length === 0) {
      return undefined
    }

    const range = new vscode.Range(
      position.line,
      position.character - context.text.length,
      position.line,
      position.character,
    )

    return eventNames.map((eventName) => {
      const item = new vscode.CompletionItem(eventName, vscode.CompletionItemKind.Event)
      item.detail = `${context.busName}.${context.method} event bus event`
      item.range = range
      item.insertText = eventName
      item.filterText = eventName
      item.sortText = `${EVENT_BUS_SORT_PREFIX}${eventName}`
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

  private templatePropCompletions(file: VueFileIndex, context: TemplatePropCompletionContext, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const childUris = context.component
      ? this.index.resolveTemplateComponentUris(file, context.component)
      : [this.index.resolveComponent(file, context.tag)].filter((uri): uri is string => Boolean(uri))
    const props = this.uniqueProps(childUris, context.existingPropNames)
    if (props.length === 0) {
      return undefined
    }

    const range = new vscode.Range(
      position.line,
      position.character - context.tokenLength,
      position.line,
      position.character,
    )

    return props.map(({ file: owner, prop }) => {
      const name = toKebabCase(prop.name)
      const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property)
      item.detail = `${owner.scriptIndex.componentName ?? owner.fileName}.props.${prop.name}`
      const documentation = formatJSDocMarkdown(prop.documentation)
      if (documentation) {
        item.documentation = new vscode.MarkdownString(`${markdownCodeBlock(prop.detail)}\n\n${documentation}`)
      } else {
        item.documentation = prop.detail
      }
      item.range = range
      item.insertText = `${context.prefix}${name}`
      item.filterText = `${context.prefix}${name}`
      item.sortText = `${PROP_SORT_PREFIX}${name}`
      return item
    })
  }

  private uniqueProps(childUris: string[], existingPropNames: Set<string>): Array<{ file: VueFileIndex, prop: PropInfo }> {
    const seen = new Set<string>()
    const results: Array<{ file: VueFileIndex, prop: PropInfo }> = []
    for (const childUri of childUris) {
      for (const definition of this.index.findPropCompletionDefinitions(childUri)) {
        const name = toKebabCase(definition.prop.name)
        if (seen.has(name) || existingPropNames.has(name)) {
          continue
        }
        seen.add(name)
        results.push(definition)
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

function findTemplatePropCompletionContext(file: VueFileIndex, content: string, offset: number): TemplatePropCompletionContext | undefined {
  const templateStart = templateCompletionStart(file, content, offset)
  if (templateStart === undefined) {
    return undefined
  }

  const tagStart = findCurrentOpenTagStart(content, offset, templateStart)
  if (tagStart === undefined || isInsideOpenTagQuote(content, tagStart, offset)) {
    return undefined
  }

  const tagName = readTagName(content, tagStart + 1)
  if (!tagName || offset <= tagName.end) {
    return undefined
  }

  const tokenStart = findAttributeTokenStart(content, offset, tagName.end)
  const token = content.slice(tokenStart, offset)
  const parsed = parsePropCompletionToken(token)
  if (!parsed) {
    return undefined
  }
  const tagEnd = findOpenTagContentEnd(content, tagStart)

  return {
    tag: tagName.value,
    component: file.templateIndex.components.find((component) => component.span.start === tagName.start),
    ...parsed,
    tokenLength: token.length,
    existingPropNames: collectExistingPropNames(content, tagName.end, tagEnd, tokenStart, offset),
  }
}

function templateCompletionStart(file: VueFileIndex, content: string, offset: number): number | undefined {
  if (file.template && offset >= file.template.start && offset <= file.template.end) {
    return file.template.start
  }
  if (isInsideBlock(file.script, offset) || isInsideBlock(file.scriptSetup, offset)) {
    return undefined
  }

  const templateOpen = content.lastIndexOf('<template', offset)
  if (templateOpen === -1) {
    return undefined
  }
  const templateOpenEnd = content.indexOf('>', templateOpen)
  if (templateOpenEnd === -1 || templateOpenEnd >= offset) {
    return undefined
  }
  const templateClose = content.lastIndexOf('</template', offset)
  return templateClose > templateOpen ? undefined : templateOpenEnd + 1
}

function isInsideBlock(block: { start: number, end: number } | undefined, offset: number): boolean {
  return Boolean(block && offset >= block.start && offset <= block.end)
}

function findCurrentOpenTagStart(content: string, offset: number, templateStart: number): number | undefined {
  const tagStart = content.lastIndexOf('<', offset)
  if (tagStart < templateStart) {
    return undefined
  }
  const tagEnd = content.lastIndexOf('>', offset)
  if (tagEnd > tagStart) {
    return undefined
  }
  const next = content[tagStart + 1]
  if (next === '/' || next === '!' || next === '?') {
    return undefined
  }
  return tagStart
}

function findOpenTagContentEnd(content: string, tagStart: number): number {
  let quote: '\'' | '"' | undefined
  for (let index = tagStart + 1; index < content.length; index += 1) {
    const char = content[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      continue
    }
    if (char === '>' || char === '<') {
      return index
    }
  }
  return content.length
}

function isInsideOpenTagQuote(content: string, tagStart: number, offset: number): boolean {
  let quote: '\'' | '"' | undefined
  for (let index = tagStart; index < offset; index += 1) {
    const char = content[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
    }
  }
  return quote !== undefined
}

function readTagName(content: string, start: number): { value: string, start: number, end: number } | undefined {
  const match = /^[A-Za-z][\w.-]*/.exec(content.slice(start))
  if (!match) {
    return undefined
  }
  return { value: match[0], start, end: start + match[0].length }
}

function findAttributeTokenStart(content: string, offset: number, min: number): number {
  let cursor = offset
  while (cursor > min) {
    const char = content[cursor - 1]
    if (/\s/.test(char) || char === '<' || char === '>') {
      break
    }
    cursor -= 1
  }
  return cursor
}

function parsePropCompletionToken(token: string): { prefix: '' | ':' | 'v-bind:', partialName: string } | undefined {
  if (token.includes('=') || token.startsWith('/') || token.startsWith('@') || token.startsWith('#')) {
    return undefined
  }

  if (token === '') {
    return { prefix: '', partialName: '' }
  }

  if (token.startsWith('v-bind:')) {
    const partialName = token.slice('v-bind:'.length)
    return isPropNamePartial(partialName) ? { prefix: 'v-bind:', partialName } : undefined
  }

  if (token.startsWith(':')) {
    const partialName = token.slice(1)
    return isPropNamePartial(partialName) ? { prefix: ':', partialName } : undefined
  }

  if (token.startsWith('v-')) {
    return undefined
  }

  return isPropNamePartial(token) ? { prefix: '', partialName: token } : undefined
}

function isPropNamePartial(value: string): boolean {
  return value === '' || /^[A-Za-z_][\w.-]*$/.test(value)
}

const ignoredCompletionPropNames = new Set(['class', 'style', 'key', 'ref', 'slot', 'slot-scope', 'is'])

function collectExistingPropNames(content: string, start: number, end: number, currentStart: number, currentEnd: number): Set<string> {
  const names = new Set<string>()
  let index = start

  while (index < end) {
    while (index < end && /\s/.test(content[index])) {
      index += 1
    }
    if (index >= end) {
      break
    }
    if (content[index] === '/') {
      index += 1
      continue
    }

    const attrStart = index
    while (index < end && !/[\s=/>]/.test(content[index])) {
      index += 1
    }
    const attrName = content.slice(attrStart, index)
    const propName = normalizeExistingPropName(attrName)
    if (propName && !rangesOverlap(attrStart, index, currentStart, currentEnd)) {
      names.add(toKebabCase(propName))
    }

    while (index < end && /\s/.test(content[index])) {
      index += 1
    }
    if (content[index] !== '=') {
      continue
    }

    index += 1
    while (index < end && /\s/.test(content[index])) {
      index += 1
    }
    const quote = content[index]
    if (quote === '"' || quote === '\'') {
      index += 1
      while (index < end && content[index] !== quote) {
        index += 1
      }
      index += content[index] === quote ? 1 : 0
      continue
    }
    while (index < end && !/\s/.test(content[index]) && content[index] !== '>') {
      index += 1
    }
  }

  return names
}

function normalizeExistingPropName(attrName: string): string | undefined {
  if (!attrName || attrName.startsWith('@') || attrName.startsWith('#')) {
    return undefined
  }
  if (attrName.startsWith('v-bind:')) {
    return cleanExistingPropName(attrName.slice('v-bind:'.length))
  }
  if (attrName.startsWith(':')) {
    return cleanExistingPropName(attrName.slice(1))
  }
  if (attrName === 'v-bind' || attrName.startsWith('v-')) {
    return undefined
  }
  return cleanExistingPropName(attrName)
}

function cleanExistingPropName(name: string): string | undefined {
  const propName = name.split('.')[0]
  return propName && !ignoredCompletionPropNames.has(propName) ? propName : undefined
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
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

function findEventBusMethodCompletionContext(content: string, offset: number, eventBusNames: readonly string[]): EventBusMethodCompletionContext | undefined {
  const names = new Set(eventBusNames)
  const partial = readPartialIdentifierBefore(content, offset)
  const access = skipWhitespaceBackward(content, partial.start - 1)
  if (content[access] !== '.') {
    return undefined
  }

  const accessToken = content[access - 1] === '?' ? '?.' : '.'
  const rootEnd = accessToken === '?.'
    ? skipWhitespaceBackward(content, access - 2) + 1
    : access
  const busName = readEventBusRootBefore(content, rootEnd, names)
  if (!busName) {
    return undefined
  }

  return {
    busName,
    accessToken,
    partialMethodName: partial.value,
  }
}

function findEventBusCompletionContext(rawContent: string, searchableContent: string, offset: number, eventBusNames: readonly string[]): EventBusCompletionContext | undefined {
  const stringContext = findStringContext(rawContent, offset)
  if (!stringContext) {
    return undefined
  }

  const eventBusCall = readEventBusCallBeforeString(searchableContent, stringContext.start - 1, new Set(eventBusNames))
  if (!eventBusCall) {
    return undefined
  }

  return {
    ...stringContext,
    ...eventBusCall,
  }
}

function readEventBusCallBeforeString(content: string, quoteIndex: number, eventBusNames: Set<string>): { busName: string, method: EventBusMethod } | undefined {
  const open = skipWhitespaceBackward(content, quoteIndex - 1)
  if (content[open] !== '(') {
    return undefined
  }

  let methodEnd = skipWhitespaceBackward(content, open - 1)
  if (content[methodEnd] === '.' && content[methodEnd - 1] === '?') {
    methodEnd = skipWhitespaceBackward(content, methodEnd - 2)
  }

  const method = readIdentifierBackward(content, methodEnd + 1)
  if (!method || !eventBusCompletionMethods.has(method.value as EventBusMethod)) {
    return undefined
  }

  const access = skipWhitespaceBackward(content, method.start - 1)
  if (content[access] !== '.') {
    return undefined
  }

  const rootEnd = content[access - 1] === '?'
    ? skipWhitespaceBackward(content, access - 2) + 1
    : access
  const busName = readEventBusRootBefore(content, rootEnd, eventBusNames)
  return busName ? { busName, method: method.value as EventBusMethod } : undefined
}

function readPartialIdentifierBefore(content: string, offset: number): { value: string, start: number, end: number } {
  const identifier = readIdentifierBackward(content, offset)
  if (identifier && identifier.end === offset) {
    return identifier
  }
  return { value: '', start: offset, end: offset }
}

function readEventBusRootBefore(content: string, end: number, eventBusNames: Set<string>): string | undefined {
  const bus = readIdentifierBackward(content, end)
  if (!bus || !eventBusNames.has(bus.value)) {
    return undefined
  }

  const access = skipWhitespaceBackward(content, bus.start - 1)
  if (content[access] !== '.') {
    return bus.value
  }

  const object = readIdentifierBackward(content, access)
  return object?.value === 'this' ? bus.value : undefined
}

function readIdentifierBackward(content: string, end: number): { value: string, start: number, end: number } | undefined {
  let cursor = skipWhitespaceBackward(content, end - 1)
  const identifierEnd = cursor + 1
  while (cursor >= 0 && /[\w$]/.test(content[cursor])) {
    cursor -= 1
  }

  const start = cursor + 1
  if (start === identifierEnd || !/[A-Za-z_$]/.test(content[start])) {
    return undefined
  }

  return { value: content.slice(start, identifierEnd), start, end: identifierEnd }
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

function skipWhitespaceBackward(content: string, index: number): number {
  let cursor = index
  while (cursor >= 0 && /\s/.test(content[cursor])) {
    cursor -= 1
  }
  return cursor
}

function isInsideRange(offset: number, start: number, end: number): boolean {
  return offset >= start && offset <= end
}

import * as path from 'node:path'
import * as vscode from 'vscode'
import type { EmitInfo, EventBusCall, MethodInfo, PropInfo, SlotInfo, SourceLocation, TextSpan, UsageInfo, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccessInFile } from '../indexer/workspaceIndex'
import { findEmit, findIndexedInjectUsages, findIndexedProvideDefinitions, findIndexedRefMethodUsages, findIndexedTemplateEventUsages, findInject, findProp, findProvideAtOffset, findResolvedRefComponents } from '../indexer/relationResolver'
import { containsOffsetStrict, createLineStarts, offsetToPosition, positionToOffset } from '../utils/position'
import { escapeMarkdownText, formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { commonDirectory, relativePath, shortestUniquePathLabels } from '../utils/pathDisplay'

export const SHOW_USAGES_COMMAND = 'vueComponentNavigator.showUsages'
const MAX_VISIBLE_USAGES = 5
const OPTION_CONTAINERS = new Set(['methods', 'computed', 'watch'])
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function'])

type UsageCommandArgs =
  | { kind: 'event-listeners', childUri: string, eventName: string }
  | { kind: 'event-bus-listeners', busName: string, eventName: string }
  | { kind: 'event-bus-emits', busName: string, eventName: string }
  | { kind: 'prop-usages', childUri: string, propName: string }
  | { kind: 'slot-usages', childUri: string, slotName: string }
  | { kind: 'ref-method-usages', childUri: string, methodName: string }
  | { kind: 'provide-definitions', consumerUri: string, injectKey: string }
  | { kind: 'inject-usages', providerUri: string, provideKey: string }
  | { kind: 'source-usages', sourceUri: string, offset: number, relation: 'prop' | 'prop-type' | 'method' | 'event' | 'provide' | 'inject' | 'hook' }

function definitionLink(file: VueFileIndex, span: TextSpan, label: string, sourceLocation?: SourceLocation): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  const target = vscode.Uri.file(location.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  return `[${escapeMarkdownText(label)}](${target.toString()})`
}

function markdownHover(value: string, trusted = false): vscode.Hover {
  const markdown = new vscode.MarkdownString(value)
  markdown.isTrusted = trusted ? { enabledCommands: [SHOW_USAGES_COMMAND] } : false
  return new vscode.Hover(markdown)
}

function methodHover(child: VueFileIndex, method: MethodInfo, label: string): vscode.Hover {
  const docs = formatJSDocMarkdown(method.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}${markdownCodeBlock(method.signature)}\n\nDefinition: ${definitionLink(child, method.span, label, method.sourceLocation)}`)
}

function slotHover(child: VueFileIndex, slot: SlotInfo, label: string): vscode.Hover {
  const docs = formatJSDocMarkdown(slot.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}${markdownCodeBlock(formatCodeBlock(slot.detail))}\n\nDefinition: ${definitionLink(child, slot.span, label, slot.sourceLocation)}`)
}

function formatCodeBlock(code: string): string {
  const lines = code.trim().split('\n')
  if (lines.length <= 1) {
    return lines.join('\n')
  }

  const lastLine = lines.slice().reverse().find((line) => line.trim())
  const baseIndent = lastLine?.trim().startsWith('}')
    ? /^\s*/.exec(lastLine)?.[0].length ?? 0
    : 0

  return lines.map((line, index) => index === 0 ? line : line.slice(baseIndent)).join('\n')
}

function propHover(child: VueFileIndex, prop: PropInfo, label: string): vscode.Hover {
  const docs = formatJSDocMarkdown(prop.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}${markdownCodeBlock(formatCodeBlock(prop.detail))}\n\nDefinition: ${definitionLink(child, prop.span, label, prop.sourceLocation)}`)
}

function definitionKey(file: VueFileIndex, span: TextSpan, sourceLocation?: SourceLocation): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  return `${location.uri}\0${location.span.start}\0${location.span.end}`
}

function uniqueDefinitions<T extends { child: VueFileIndex, span: TextSpan, sourceLocation?: SourceLocation }>(definitions: T[]): T[] {
  const seen = new Set<string>()
  const results: T[] = []
  for (const definition of definitions) {
    const key = definitionKey(definition.child, definition.span, definition.sourceLocation)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(definition)
  }
  return results
}

function labelForDefinition(labels: Map<string, string>, file: VueFileIndex, sourceLocation?: SourceLocation): string {
  const uri = sourceLocation?.uri ?? file.uri
  return labels.get(uri) ?? path.basename(uri)
}

function formatUsage(file: VueFileIndex, offset: number, baseDirectory: string): string {
  return formatUsageLocation(file, { start: offset, end: offset }, baseDirectory)
}

function formatUsageLocation(file: VueFileIndex, span: TextSpan, baseDirectory: string, sourceLocation?: SourceLocation, includeContext = true): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  const target = vscode.Uri.file(location.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  const relativeFile = relativePath(location.uri, baseDirectory)
  const directory = path.dirname(relativeFile)
  const directoryText = directory && directory !== '.'
    ? ` - ${escapeMarkdownText(directory)}`
    : ''
  const context = includeContext && location.uri === file.uri
    ? optionsApiContext(file, location.span.start)
    : undefined
  const contextText = context
    ? `  \n  ${escapeMarkdownText(context)}`
    : ''
  return `- [${escapeMarkdownText(`${path.basename(location.uri)}:${position.line + 1}`)}](${target.toString()})${directoryText}${contextText}`
}

function optionsApiContext(file: VueFileIndex, offset: number): string | undefined {
  if (!file.script || offset < file.script.start || offset > file.script.end) {
    return undefined
  }

  const usageLine = offsetToPosition(file.lineStarts, offset).line
  for (let line = usageLine; line >= 0; line -= 1) {
    const text = lineText(file.content, file.lineStarts, line)
    const member = optionMemberFromLine(text)
    if (!member) {
      continue
    }

    const container = findOptionContainer(file, line, member.indent)
    return container ? `${container}.${member.name}` : member.name
  }

  return undefined
}

function lineText(content: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line] ?? 0
  const end = lineStarts[line + 1] ?? content.length
  return content.slice(start, end).replace(/\r?\n$/, '')
}

function indentation(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0
}

function normalizePropertyName(name: string): string {
  return name.replace(/^['"]|['"]$/g, '')
}

function optionMemberFromLine(line: string): { name: string, indent: number } | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
    return undefined
  }

  const shorthand = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(trimmed)
  if (shorthand && !CONTROL_KEYWORDS.has(shorthand[1])) {
    return { name: shorthand[1], indent: indentation(line) }
  }

  const property = /^((?:[A-Za-z_$][\w$]*)|(?:['"][^'"]+['"]))\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(trimmed)
  if (!property) {
    return undefined
  }

  return { name: normalizePropertyName(property[1]), indent: indentation(line) }
}

function optionContainerFromLine(line: string): { name: string, indent: number } | undefined {
  const match = /^((?:[A-Za-z_$][\w$]*)|(?:['"][^'"]+['"]))\s*:\s*\{/.exec(line.trim())
  if (!match) {
    return undefined
  }

  return { name: normalizePropertyName(match[1]), indent: indentation(line) }
}

function findOptionContainer(file: VueFileIndex, memberLine: number, memberIndent: number): string | undefined {
  let maxIndent = memberIndent
  for (let line = memberLine - 1; line >= 0; line -= 1) {
    const text = lineText(file.content, file.lineStarts, line)
    if (!text.trim()) {
      continue
    }

    const container = optionContainerFromLine(text)
    if (!container || container.indent >= maxIndent) {
      continue
    }
    if (OPTION_CONTAINERS.has(container.name)) {
      return container.name
    }

    maxIndent = container.indent
  }

  return undefined
}

function commandLink(args: UsageCommandArgs, label: string): string {
  const encoded = encodeURIComponent(JSON.stringify([args]))
  return `[▶ ${label}](command:${SHOW_USAGES_COMMAND}?${encoded})`
}

function usageSummary(
  usages: UsageInfo[],
  baseDirectory: string,
  options: {
    noneText: string
    title: string
    singular: string
    plural: string
    commandArgs: UsageCommandArgs
    formatUsage?: (usage: UsageInfo, baseDirectory: string) => string
    includeContext?: boolean
  },
): { text: string, trusted: boolean } {
  if (usages.length === 0) {
    return { text: options.noneText, trusted: false }
  }

  const visibleUsages = usages.slice(0, MAX_VISIBLE_USAGES)
  const lines = visibleUsages.map((usage) => options.formatUsage
    ? options.formatUsage(usage, baseDirectory)
    : formatUsageLocation(usage.file, usage.span, baseDirectory, usage.sourceLocation, options.includeContext ?? true))
  const noun = usages.length === 1 ? options.singular : options.plural
  const more = usages.length > visibleUsages.length
    ? `\n\n${commandLink(options.commandArgs, `Show all ${usages.length} ${noun}`)}`
    : ''
  return {
    text: `${options.title} ${usages.length} ${noun}:\n\n${lines.join('\n')}${more}`,
    trusted: usages.length > visibleUsages.length,
  }
}

function eventHover(index: WorkspaceIndex, child: VueFileIndex, eventName: string, labels: Map<string, string>): vscode.Hover | undefined {
  return eventDefinitionsHover(index.findEventDefinitions(child.uri, eventName).map(({ file, emit }) => ({ child: file, emit })), labels)
}

function propDefinitionsHover(definitions: Array<{ child: VueFileIndex, prop: PropInfo }>, labels: Map<string, string>): vscode.Hover | undefined {
  const unique = uniqueDefinitions(definitions.map(({ child, prop }) => ({
    child,
    prop,
    span: prop.span,
    sourceLocation: prop.sourceLocation,
  })))
  if (unique.length === 0) {
    return undefined
  }

  if (unique.length === 1) {
    const { child, prop } = unique[0]
    return propHover(child, prop, labelForDefinition(labels, child, prop.sourceLocation))
  }

  const links = unique.map(({ child, prop }) => {
    const label = labelForDefinition(labels, child, prop.sourceLocation)
    return `- ${definitionLink(child, prop.span, label, prop.sourceLocation)}`
  }).join('\n')
  return markdownHover(`Definitions:\n\n${links}`)
}

function methodDefinitionsHover(definitions: Array<{ child: VueFileIndex, method: MethodInfo }>, labels: Map<string, string>): vscode.Hover | undefined {
  const unique = uniqueDefinitions(definitions.map(({ child, method }) => ({
    child,
    method,
    span: method.span,
    sourceLocation: method.sourceLocation,
  })))
  if (unique.length === 0) {
    return undefined
  }

  if (unique.length === 1) {
    const { child, method } = unique[0]
    return methodHover(child, method, labelForDefinition(labels, child, method.sourceLocation))
  }

  const links = unique.map(({ child, method }) => {
    const label = labelForDefinition(labels, child, method.sourceLocation)
    return `- ${definitionLink(child, method.span, label, method.sourceLocation)}`
  }).join('\n')
  return markdownHover(`Definitions:\n\n${links}`)
}

function slotDefinitionsHover(definitions: Array<{ child: VueFileIndex, slot: SlotInfo }>, labels: Map<string, string>): vscode.Hover | undefined {
  const unique = uniqueDefinitions(definitions.map(({ child, slot }) => ({
    child,
    slot,
    span: slot.span,
    sourceLocation: slot.sourceLocation,
  })))
  if (unique.length === 0) {
    return undefined
  }

  if (unique.length === 1) {
    const { child, slot } = unique[0]
    return slotHover(child, slot, labelForDefinition(labels, child, slot.sourceLocation))
  }

  const links = unique.map(({ child, slot }) => {
    const label = labelForDefinition(labels, child, slot.sourceLocation)
    return `- ${definitionLink(child, slot.span, label, slot.sourceLocation)}`
  }).join('\n')
  return markdownHover(`Definitions:\n\n${links}`)
}

function eventDefinitionsHover(definitions: Array<{ child: VueFileIndex, emit: EmitInfo }>, labels: Map<string, string>): vscode.Hover | undefined {
  const unique = uniqueDefinitions(definitions.map(({ child, emit }) => ({
    child,
    emit,
    span: emit.eventSpan,
    sourceLocation: emit.sourceLocation,
  })))
  if (unique.length === 0) {
    return undefined
  }

  if (unique.length === 1) {
    const { child, emit } = unique[0]
    const label = labelForDefinition(labels, child, emit.sourceLocation)
    return markdownHover(`Definition: ${definitionLink(child, emit.eventSpan, label, emit.sourceLocation)}`)
  }

  const links = unique.map(({ child, emit }) => {
    const label = labelForDefinition(labels, child, emit.sourceLocation)
    return `- ${definitionLink(child, emit.eventSpan, label, emit.sourceLocation)}`
  }).join('\n')
  return markdownHover(`Definitions:\n\n${links}`)
}

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function offsetInDocument(document: vscode.TextDocument, position: vscode.Position): number | undefined {
  return positionToOffset(createLineStarts(document.getText()), { line: position.line, character: position.character })
}

function propDefinitionHover(index: WorkspaceIndex, child: VueFileIndex, prop: PropInfo, baseDirectory: string): vscode.Hover {
  const usages = index.findTemplatePropUsages(child.uri, prop.name)
  const summary = usageSummary(usages, baseDirectory, {
    noneText: 'No template prop usages found.',
    title: 'Used by',
    singular: 'template prop',
    plural: 'template props',
    commandArgs: { kind: 'prop-usages', childUri: child.uri, propName: prop.name },
  })
  return markdownHover(summary.text, summary.trusted)
}

function methodDefinitionHover(index: WorkspaceIndex, child: VueFileIndex, method: MethodInfo, baseDirectory: string): vscode.Hover {
  const usages = findIndexedRefMethodUsages(index, child.uri, method.name)
  const summary = usageSummary(usages, baseDirectory, {
    noneText: 'No ref method usages found.',
    title: 'Used by',
    singular: 'ref method',
    plural: 'ref methods',
    commandArgs: { kind: 'ref-method-usages', childUri: child.uri, methodName: method.name },
    includeContext: false,
  })
  return markdownHover(summary.text, summary.trusted)
}

function slotDefinitionHover(index: WorkspaceIndex, child: VueFileIndex, slot: SlotInfo, baseDirectory: string): vscode.Hover {
  const usages = index.findTemplateSlotUsages(child.uri, slot.name)
  const summary = usageSummary(usages, baseDirectory, {
    noneText: 'No slot usages found.',
    title: 'Used by',
    singular: 'slot usage',
    plural: 'slot usages',
    commandArgs: { kind: 'slot-usages', childUri: child.uri, slotName: slot.name },
  })
  return markdownHover(summary.text, summary.trusted)
}

export class VueHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const file = isVueDocument(document)
      ? this.index.syncContent(document.uri.fsPath, document.getText())
      : this.index.getFile(document.uri.fsPath)
    const offset = isVueDocument(document)
      ? this.index.offsetAt(document.uri.fsPath, position.line, position.character)
      : offsetInDocument(document, position)
    if (offset === undefined) {
      return undefined
    }
    const sourceHover = this.index.hasSourceRelations(document.uri.fsPath)
      ? this.sourceHover(document.uri.fsPath, offset)
      : undefined
    if (sourceHover) {
      return sourceHover
    }
    if (!file) {
      return undefined
    }
    let labels: Map<string, string> | undefined
    const definitionLabels = () => {
      labels ??= this.definitionLabels()
      return labels
    }

    const vue3PropType = this.index.findVue3PropTypeAtOffset(file, offset)
    if (vue3PropType) {
      const sourceUri = vue3PropType.sourceLocation?.uri ?? file.uri
      const sourceOffset = vue3PropType.sourceLocation?.span.start ?? vue3PropType.span.start
      const usages = this.index.findVue3PropTypeUsagesFromSource(sourceUri, sourceOffset)
      const summary = usageSummary(usages, this.workspaceBaseDirectory(), {
        noneText: 'No defineProps usages found.',
        title: 'Used by',
        singular: 'defineProps type',
        plural: 'defineProps types',
        commandArgs: { kind: 'source-usages', sourceUri, offset: sourceOffset, relation: 'prop-type' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const vue3PropUsage = this.index.findVue3PropUsageAtOffset(file, offset)
    if (vue3PropUsage) {
      const prop = findProp(file, vue3PropUsage.propName)
      return prop ? propHover(file, prop, labelForDefinition(definitionLabels(), file, prop.sourceLocation)) : undefined
    }

    const refAccess = findRefMethodAccessInFile(file, offset)
    if (refAccess) {
      const definitions = findResolvedRefComponents(this.index, file, refAccess.refName).flatMap((childUri) => {
        return this.index.findRefMethodDefinitions(childUri, refAccess.methodName)
          .map(({ file, method }) => ({ child: file, method }))
      })
      return methodDefinitionsHover(definitions, definitionLabels())
    }

    for (const call of file.scriptIndex.eventBusCalls) {
      if (containsOffsetStrict(call.eventSpan, offset)) {
        return this.eventBusHover(call)
      }
    }

    for (const component of file.templateIndex.components) {
      const children = this.index.resolveTemplateComponentUris(file, component)
        .map((childUri) => this.index.getFile(childUri))
        .filter((child): child is VueFileIndex => Boolean(child))
      if (children.length === 0) {
        continue
      }

      for (const attr of component.attrs) {
        if (!containsOffsetStrict(attr.span, offset)) {
          continue
        }
        if (attr.kind === 'prop') {
          const definitions = children.flatMap((child) => {
            return this.index.findPropDefinitions(child.uri, attr.normalizedName)
              .map(({ file, prop }) => ({ child: file, prop }))
          })
          if (definitions.length === 0) {
            return undefined
          }
          return propDefinitionsHover(definitions, definitionLabels())
        }
        if (attr.kind === 'event') {
          const definitions = children.flatMap((child) => this.index.findEventDefinitions(child.uri, attr.normalizedName).map(({ file, emit }) => ({ child: file, emit })))
          if (definitions.length === 0) {
            return undefined
          }
          return eventDefinitionsHover(definitions, definitionLabels())
        }
      }

      for (const slot of component.slots) {
        if (!containsOffsetStrict(slot.span, offset)) {
          continue
        }
        const definitions = children.flatMap((child) => this.index.findSlotDefinitions(child.uri, slot.normalizedName).map(({ file, slot }) => ({ child: file, slot })))
        if (definitions.length === 0) {
          return undefined
        }
        return slotDefinitionsHover(definitions, definitionLabels())
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return this.emitHover(file, emit.eventName)
      }
    }

    for (const method of file.scriptIndex.methods) {
      if (containsOffsetStrict(method.span, offset)) {
        return methodDefinitionHover(this.index, file, method, this.workspaceBaseDirectory())
      }
    }

    for (const prop of file.scriptIndex.props) {
      if (containsOffsetStrict(prop.span, offset)) {
        return propDefinitionHover(this.index, file, prop, this.workspaceBaseDirectory())
      }
    }

    for (const slot of file.scriptIndex.slots) {
      if (containsOffsetStrict(slot.span, offset)) {
        return slotDefinitionHover(this.index, file, slot, this.workspaceBaseDirectory())
      }
    }

    const inject = findInject(file, offset)
    if (inject) {
      return this.injectHover(file, inject.key)
    }

    const provide = findProvideAtOffset(file, offset)
    if (provide) {
      return this.provideKeyHover(file, provide.key)
    }

    return undefined
  }

  private sourceHover(sourceUri: string, offset: number): vscode.Hover | undefined {
    const refDefinitions = this.index.findSourceRefMethodCalls(sourceUri, offset).flatMap(({ file, call }) => {
      return findResolvedRefComponents(this.index, file, call.refName).flatMap((childUri) => {
        return this.index.findRefMethodDefinitions(childUri, call.methodName)
          .map(({ file, method }) => ({ child: file, method }))
      })
    })
    if (refDefinitions.length > 0) {
      return methodDefinitionsHover(refDefinitions, this.definitionLabels())
    }

    const eventBusCalls = this.index.findSourceEventBusCalls(sourceUri, offset)
    if (eventBusCalls.length > 0) {
      return this.eventBusHover(eventBusCalls[0].call)
    }

    const typeUsages = this.index.findVue3PropTypeUsagesFromSource(sourceUri, offset)
    if (typeUsages.length > 0) {
      const summary = usageSummary(typeUsages, this.workspaceBaseDirectory(), {
        noneText: 'No defineProps usages found.',
        title: 'Used by',
        singular: 'defineProps type',
        plural: 'defineProps types',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'prop-type' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const vue3PropUsages = this.index.findVue3PropInternalUsagesFromSource(sourceUri, offset)
    if (vue3PropUsages.length > 0) {
      const summary = usageSummary(vue3PropUsages, this.workspaceBaseDirectory(), {
        noneText: 'No prop usages found.',
        title: 'Used by',
        singular: 'prop usage',
        plural: 'prop usages',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'prop' },
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const propUsages = this.index.findTemplatePropUsagesFromSource(sourceUri, offset)
    if (propUsages.length > 0) {
      const summary = usageSummary(propUsages, this.workspaceBaseDirectory(), {
        noneText: 'No template prop usages found.',
        title: 'Used by',
        singular: 'template prop',
        plural: 'template props',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'prop' },
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const methodUsages = this.index.findRefMethodUsagesFromSource(sourceUri, offset)
    if (methodUsages.length > 0) {
      const summary = usageSummary(methodUsages, this.workspaceBaseDirectory(), {
        noneText: 'No ref method usages found.',
        title: 'Used by',
        singular: 'ref method',
        plural: 'ref methods',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'method' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const hookUsages = this.index.findComposableReturnUsagesFromSource(sourceUri, offset)
    if (hookUsages.length > 0) {
      const summary = usageSummary(hookUsages, this.workspaceBaseDirectory(), {
        noneText: 'No hook usages found.',
        title: 'Used by',
        singular: 'hook usage',
        plural: 'hook usages',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'hook' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const eventUsages = this.index.findTemplateEventUsagesFromSource(sourceUri, offset)
    if (eventUsages.length > 0) {
      const summary = usageSummary(eventUsages, this.workspaceBaseDirectory(), {
        noneText: 'No template listeners found.',
        title: 'Used by',
        singular: 'listener',
        plural: 'listeners',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'event' },
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const providerUsages = this.index.findProvideDefinitionsFromInjectSource(sourceUri, offset)
    if (providerUsages.length > 0) {
      const summary = usageSummary(providerUsages, this.workspaceBaseDirectory(), {
        noneText: 'No static provide definition found.',
        title: 'Provided by',
        singular: 'definition',
        plural: 'definitions',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'inject' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    const injectUsages = this.index.findInjectUsagesFromProvideSource(sourceUri, offset)
    if (injectUsages.length > 0) {
      const summary = usageSummary(injectUsages, this.workspaceBaseDirectory(), {
        noneText: 'No static inject usages found.',
        title: 'Injected by',
        singular: 'consumer',
        plural: 'consumers',
        commandArgs: { kind: 'source-usages', sourceUri, offset, relation: 'provide' },
        includeContext: false,
      })
      return markdownHover(summary.text, summary.trusted)
    }

    return undefined
  }

  private definitionLabels(): Map<string, string> {
    const uris = this.index.getAllFiles().flatMap((file) => [
      file.uri,
      ...file.scriptIndex.props.map((item) => item.sourceLocation?.uri),
      file.scriptIndex.vue3PropType?.sourceLocation?.uri,
      ...file.scriptIndex.methods.map((item) => item.sourceLocation?.uri),
      ...file.scriptIndex.slots.map((item) => item.sourceLocation?.uri),
      ...file.scriptIndex.emits.map((item) => item.sourceLocation?.uri),
      ...file.scriptIndex.eventBusCalls.map((item) => item.sourceLocation?.uri),
    ]).filter((uri): uri is string => Boolean(uri))
    return shortestUniquePathLabels(uris, commonDirectory(uris))
  }

  private emitHover(child: VueFileIndex, eventName: string): vscode.Hover {
    const usages = findIndexedTemplateEventUsages(this.index, child.uri, eventName)
    const summary = usageSummary(usages, this.workspaceBaseDirectory(), {
      noneText: 'No template listeners found.',
      title: 'Used by',
      singular: 'listener',
      plural: 'listeners',
      commandArgs: { kind: 'event-listeners', childUri: child.uri, eventName },
    })
    return markdownHover(summary.text, summary.trusted)
  }

  private eventBusHover(call: EventBusCall): vscode.Hover {
    const listeners = call.kind === 'emit'
    const usages = listeners
      ? this.index.findEventBusListeners(call.busName, call.eventName)
      : this.index.findEventBusEmits(call.busName, call.eventName)
    const summary = usageSummary(usages, this.workspaceBaseDirectory(), {
      noneText: listeners ? 'No event bus listeners found.' : 'No event bus emits found.',
      title: listeners ? 'Listened by' : 'Emitted by',
      singular: listeners ? 'event bus listener' : 'event bus emit',
      plural: listeners ? 'event bus listeners' : 'event bus emits',
      commandArgs: listeners
        ? { kind: 'event-bus-listeners', busName: call.busName, eventName: call.eventName }
        : { kind: 'event-bus-emits', busName: call.busName, eventName: call.eventName },
      formatUsage: (usage, baseDirectory) => {
        const method = 'method' in usage ? String(usage.method) : ''
        const methodText = method ? ` - ${escapeMarkdownText(method)}` : ''
        return `${formatUsageLocation(usage.file, usage.span, baseDirectory, usage.sourceLocation, false)}${methodText}`
      },
    })
    return markdownHover(summary.text, summary.trusted)
  }

  private injectHover(consumer: VueFileIndex, injectKey: string): vscode.Hover {
    const providers = findIndexedProvideDefinitions(this.index, consumer, injectKey)
    if (providers.length === 0) {
      return markdownHover('No static provide definition found.')
    }

    const summary = usageSummary(providers, this.workspaceBaseDirectory(), {
      noneText: 'No static provide definition found.',
      title: 'Provided by',
      singular: 'definition',
      plural: 'definitions',
      commandArgs: { kind: 'provide-definitions', consumerUri: consumer.uri, injectKey },
      includeContext: false,
    })
    return markdownHover(summary.text, summary.trusted)
  }

  private provideKeyHover(provider: VueFileIndex, provideKey: string): vscode.Hover {
    const usages = findIndexedInjectUsages(this.index, provider.uri, provideKey)
    if (usages.length === 0) {
      return markdownHover('No static inject usages found.')
    }

    const summary = usageSummary(usages, this.workspaceBaseDirectory(), {
      noneText: 'No static inject usages found.',
      title: 'Injected by',
      singular: 'consumer',
      plural: 'consumers',
      commandArgs: { kind: 'inject-usages', providerUri: provider.uri, provideKey },
      includeContext: false,
    })
    return markdownHover(summary.text, summary.trusted)
  }

  private workspaceBaseDirectory(): string {
    return commonDirectory(this.index.getAllFiles().map((file) => file.uri))
  }
}

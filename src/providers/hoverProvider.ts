import * as path from 'node:path'
import * as vscode from 'vscode'
import type { MethodInfo, PropInfo, SourceLocation, TextSpan, UsageInfo, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccessInFile } from '../indexer/workspaceIndex'
import { findEmit, findIndexedInjectUsages, findIndexedProvideDefinitions, findIndexedTemplateEventUsages, findInject, findMethod, findProp, findProvideAtOffset, findResolvedComponent, findResolvedRefComponent } from '../indexer/relationResolver'
import { containsOffsetStrict, createLineStarts, offsetToPosition, positionToOffset } from '../utils/position'
import { escapeMarkdownText, formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { commonDirectory, relativePath, shortestUniquePathLabels } from '../utils/pathDisplay'

export const SHOW_USAGES_COMMAND = 'vueComponentNavigator.showUsages'
const MAX_VISIBLE_USAGES = 5

type UsageCommandArgs =
  | { kind: 'event-listeners', childUri: string, eventName: string }
  | { kind: 'prop-usages', childUri: string, propName: string }
  | { kind: 'provide-definitions', consumerUri: string, injectKey: string }
  | { kind: 'inject-usages', providerUri: string, provideKey: string }
  | { kind: 'source-usages', sourceUri: string, offset: number, relation: 'prop' | 'method' | 'event' | 'provide' | 'inject' }

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

function labelForDefinition(labels: Map<string, string>, file: VueFileIndex, sourceLocation?: SourceLocation): string {
  const uri = sourceLocation?.uri ?? file.uri
  return labels.get(uri) ?? path.basename(uri)
}

function formatUsage(file: VueFileIndex, offset: number, baseDirectory: string): string {
  return formatUsageLocation(file, { start: offset, end: offset }, baseDirectory)
}

function formatUsageLocation(file: VueFileIndex, span: TextSpan, baseDirectory: string, sourceLocation?: SourceLocation): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  const target = vscode.Uri.file(location.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  const relativeFile = relativePath(location.uri, baseDirectory)
  const directory = path.dirname(relativeFile)
  const directoryText = directory && directory !== '.'
    ? ` - ${escapeMarkdownText(directory)}`
    : ''
  return `- [${escapeMarkdownText(path.basename(location.uri))}](${target.toString()})${directoryText}`
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
  },
): { text: string, trusted: boolean } {
  if (usages.length === 0) {
    return { text: options.noneText, trusted: false }
  }

  const visibleUsages = usages.slice(0, MAX_VISIBLE_USAGES)
  const lines = visibleUsages.map((usage) => formatUsageLocation(usage.file, usage.span, baseDirectory, usage.sourceLocation))
  const noun = usages.length === 1 ? options.singular : options.plural
  const more = usages.length > visibleUsages.length
    ? `\n\n${commandLink(options.commandArgs, `Show all ${usages.length} ${noun}`)}`
    : ''
  return {
    text: `${options.title} ${usages.length} ${noun}:\n\n${lines.join('\n')}${more}`,
    trusted: usages.length > visibleUsages.length,
  }
}

function eventHover(child: VueFileIndex, eventName: string, labels: Map<string, string>): vscode.Hover | undefined {
  const emits = findEmit(child, eventName)
  if (emits.length === 0) {
    return undefined
  }

  if (emits.length === 1) {
    const label = labelForDefinition(labels, child, emits[0].sourceLocation)
    return markdownHover(`Definition: ${definitionLink(child, emits[0].eventSpan, label, emits[0].sourceLocation)}`)
  }

  const definitions = emits.map((emit) => {
    const label = labelForDefinition(labels, child, emit.sourceLocation)
    return `- ${definitionLink(child, emit.eventSpan, label, emit.sourceLocation)}`
  }).join('\n')
  return markdownHover(`Definitions:\n\n${definitions}`)
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
    const sourceHover = this.index.hasMixinSource(document.uri.fsPath)
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

    const refAccess = findRefMethodAccessInFile(file, offset)
    if (refAccess) {
      const childUri = findResolvedRefComponent(this.index, file, refAccess.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, refAccess.methodName) : undefined
      return child && method ? methodHover(child, method, labelForDefinition(definitionLabels(), child, method.sourceLocation)) : undefined
    }

    for (const component of file.templateIndex.components) {
      const childUri = findResolvedComponent(this.index, file, component.tag)
      const child = childUri ? this.index.getFile(childUri) : undefined
      if (!child) {
        continue
      }

      for (const attr of component.attrs) {
        if (!containsOffsetStrict(attr.span, offset)) {
          continue
        }
        if (attr.kind === 'prop') {
          const prop = findProp(child, attr.normalizedName)
          return prop ? propHover(child, prop, labelForDefinition(definitionLabels(), child, prop.sourceLocation)) : undefined
        }
        if (attr.kind === 'event') {
          return eventHover(child, attr.normalizedName, definitionLabels())
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return this.emitHover(file, emit.eventName)
      }
    }

    for (const prop of file.scriptIndex.props) {
      if (containsOffsetStrict(prop.span, offset)) {
        return propDefinitionHover(this.index, file, prop, this.workspaceBaseDirectory())
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
      const childUri = findResolvedRefComponent(this.index, file, call.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, call.methodName) : undefined
      return child && method ? [{ child, method }] : []
    })
    if (refDefinitions.length > 0) {
      const { child, method } = refDefinitions[0]
      return methodHover(child, method, labelForDefinition(this.definitionLabels(), child, method.sourceLocation))
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
      })
      return markdownHover(summary.text, summary.trusted)
    }

    return undefined
  }

  private definitionLabels(): Map<string, string> {
    const uris = this.index.getAllFiles().flatMap((file) => [
      file.uri,
      ...file.scriptIndex.props.map((item) => item.sourceLocation?.uri),
      ...file.scriptIndex.methods.map((item) => item.sourceLocation?.uri),
      ...file.scriptIndex.emits.map((item) => item.sourceLocation?.uri),
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
    })
    return markdownHover(summary.text, summary.trusted)
  }

  private workspaceBaseDirectory(): string {
    return commonDirectory(this.index.getAllFiles().map((file) => file.uri))
  }
}

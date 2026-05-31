import * as path from 'node:path'
import * as vscode from 'vscode'
import type { MethodInfo, PropInfo, TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccessInFile } from '../indexer/workspaceIndex'
import { findEmit, findIndexedTemplateEventUsages, findMethod, findProp, findResolvedComponent, findResolvedRefComponent } from '../indexer/relationResolver'
import { containsOffsetStrict, offsetToPosition } from '../utils/position'
import { escapeMarkdownText, formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { commonDirectory, shortestUniquePathLabels, usagePathLabels } from '../utils/pathDisplay'

export const SHOW_EMIT_USAGES_COMMAND = 'vueComponentNavigator.showEmitUsages'

function definitionLink(file: VueFileIndex, span: TextSpan, label: string): string {
  const position = offsetToPosition(file.lineStarts, span.start)
  const target = vscode.Uri.file(file.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  return `[${escapeMarkdownText(label)}](${target.toString()})`
}

function markdownHover(value: string, trusted = false): vscode.Hover {
  const markdown = new vscode.MarkdownString(value)
  markdown.isTrusted = trusted ? { enabledCommands: [SHOW_EMIT_USAGES_COMMAND] } : false
  return new vscode.Hover(markdown)
}

function methodHover(child: VueFileIndex, method: MethodInfo, label: string): vscode.Hover {
  const docs = formatJSDocMarkdown(method.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}${markdownCodeBlock(method.signature)}\n\nDefinition: ${definitionLink(child, method.span, label)}`)
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
  return markdownHover(`${docText}${markdownCodeBlock(formatCodeBlock(prop.detail))}\n\nDefinition: ${definitionLink(child, prop.span, label)}`)
}

function formatUsage(file: VueFileIndex, offset: number, label: string): string {
  const position = offsetToPosition(file.lineStarts, offset)
  const target = vscode.Uri.file(file.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  return `- [${escapeMarkdownText(label)}:${position.line + 1}](${target.toString()})`
}

function commandLink(childUri: string, eventName: string, usageCount: number): string {
  const args = encodeURIComponent(JSON.stringify([{ childUri, eventName }]))
  return `[▶ Show all ${usageCount} listeners](command:${SHOW_EMIT_USAGES_COMMAND}?${args})`
}

function eventHover(child: VueFileIndex, eventName: string, labels: Map<string, string>): vscode.Hover | undefined {
  const emits = findEmit(child, eventName)
  if (emits.length === 0) {
    return undefined
  }

  const label = labels.get(child.uri) ?? path.basename(child.uri)
  if (emits.length === 1) {
    return markdownHover(`Definition: ${definitionLink(child, emits[0].eventSpan, label)}`)
  }

  const definitions = emits.map((emit) => `- ${definitionLink(child, emit.eventSpan, label)}`).join('\n')
  return markdownHover(`Definitions:\n\n${definitions}`)
}

export class VueHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    const offset = this.index.offsetAt(document.uri.fsPath, position.line, position.character)
    if (offset === undefined) {
      return undefined
    }
    const labels = this.definitionLabels()

    const refAccess = findRefMethodAccessInFile(file, offset)
    if (refAccess) {
      const childUri = findResolvedRefComponent(this.index, file, refAccess.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, refAccess.methodName) : undefined
      return child && method ? methodHover(child, method, labels.get(child.uri) ?? path.basename(child.uri)) : undefined
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
          return prop ? propHover(child, prop, labels.get(child.uri) ?? path.basename(child.uri)) : undefined
        }
        if (attr.kind === 'event') {
          return eventHover(child, attr.normalizedName, labels)
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return this.emitHover(file, emit.eventName)
      }
    }

    return undefined
  }

  private definitionLabels(): Map<string, string> {
    const uris = this.index.getAllFiles().map((file) => file.uri)
    return shortestUniquePathLabels(uris, commonDirectory(uris))
  }

  private emitHover(child: VueFileIndex, eventName: string): vscode.Hover {
    const usages = findIndexedTemplateEventUsages(this.index, child.uri, eventName)
    const visibleUsages = usages.slice(0, 5)
    const labels = usagePathLabels(visibleUsages.map((usage) => usage.file.uri), commonDirectory(this.index.getAllFiles().map((file) => file.uri)))
    const usageLines = visibleUsages.map((usage) => formatUsage(usage.file, usage.span.start, labels.get(usage.file.uri) ?? path.basename(usage.file.uri)))
    const usageText = usages.length > 0
      ? `Used by ${usages.length} listener${usages.length === 1 ? '' : 's'}:\n\n${usageLines.join('\n')}`
      : 'No template listeners found.'
    const more = usages.length > visibleUsages.length
      ? `\n\n${commandLink(child.uri, eventName, usages.length)}`
      : ''
    return markdownHover(`${usageText}${more}`, usages.length > visibleUsages.length)
  }
}

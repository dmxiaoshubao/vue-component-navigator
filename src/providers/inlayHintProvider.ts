import * as path from 'node:path'
import * as vscode from 'vscode'
import type { UsageInfo, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex } from '../indexer/workspaceIndex'
import { offsetToPosition } from '../utils/position'
import { escapeMarkdownText } from '../utils/jsdoc'
import { commonDirectory, relativePath } from '../utils/pathDisplay'
import { SHOW_USAGES_COMMAND } from './hoverProvider'

const MAX_TOOLTIP_USAGES = 5

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function toVsCodePosition(file: VueFileIndex, offset: number): vscode.Position {
  const position = offsetToPosition(file.lineStarts, offset)
  return new vscode.Position(position.line, position.character)
}

function positionInRange(position: vscode.Position, range: vscode.Range): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false
  }
  if (position.line === range.start.line && position.character < range.start.character) {
    return false
  }
  return !(position.line === range.end.line && position.character > range.end.character)
}

function usageLocation(usage: UsageInfo, baseDirectory: string): string {
  const location = usage.sourceLocation ?? { uri: usage.file.uri, lineStarts: usage.file.lineStarts, span: usage.span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  const target = vscode.Uri.file(location.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  const relativeFile = relativePath(location.uri, baseDirectory)
  const directory = path.dirname(relativeFile)
  const directoryText = directory && directory !== '.'
    ? ` - ${escapeMarkdownText(directory)}`
    : ''
  return `- [${escapeMarkdownText(`${path.basename(location.uri)}:${position.line + 1}`)}](${target.toString()})${directoryText}`
}

function componentUsageTooltip(usages: UsageInfo[], baseDirectory: string): vscode.MarkdownString {
  const visible = usages.slice(0, MAX_TOOLTIP_USAGES)
  const noun = usages.length === 1 ? 'component usage' : 'component usages'
  const more = usages.length > visible.length
    ? `\n\nUse the hint command to show all ${usages.length} ${noun}.`
    : ''
  const markdown = new vscode.MarkdownString(`Used by ${usages.length} ${noun}:\n\n${visible.map((usage) => usageLocation(usage, baseDirectory)).join('\n')}${more}`)
  markdown.isTrusted = false
  return markdown
}

export class VueInlayHintProvider implements vscode.InlayHintsProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.ProviderResult<vscode.InlayHint[]> {
    if (!isVueDocument(document) || document.uri.scheme !== 'file') {
      return []
    }

    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    if (!file.template) {
      return []
    }

    const usages = this.index.findComponentUsages(file.uri)
    if (usages.length === 0) {
      return []
    }

    const position = toVsCodePosition(file, file.template.start)
    if (!positionInRange(position, range)) {
      return []
    }

    const baseDirectory = commonDirectory([
      file.uri,
      ...usages.map((usage) => usage.sourceLocation?.uri ?? usage.file.uri),
    ])
    const noun = usages.length === 1 ? 'usage' : 'usages'
    const label = new vscode.InlayHintLabelPart(`Used by ${usages.length} ${noun}`)
    label.tooltip = componentUsageTooltip(usages, baseDirectory)
    label.command = {
      title: 'Show component usages',
      command: SHOW_USAGES_COMMAND,
      arguments: [{ kind: 'component-usages', childUri: file.uri }],
    }

    const hint = new vscode.InlayHint(position, [label], vscode.InlayHintKind.Parameter)
    hint.paddingLeft = true
    return [hint]
  }
}

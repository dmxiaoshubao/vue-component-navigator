import * as path from 'node:path'
import * as vscode from 'vscode'
import type { MethodInfo, PropInfo, TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccess } from '../indexer/workspaceIndex'
import { findEmit, findMethod, findProp, findRefComponent, findRegisteredComponent, findTemplateEventUsages } from '../indexer/relationResolver'
import { containsOffsetStrict, offsetToPosition } from '../utils/position'
import { formatJSDocMarkdown } from '../utils/jsdoc'

export const SHOW_EMIT_USAGES_COMMAND = 'vueComponentNavigator.showEmitUsages'

function definitionLink(file: VueFileIndex, span: TextSpan, baseDirectory: string): string {
  const position = offsetToPosition(file.lineStarts, span.start)
  const relativePath = baseDirectory ? path.relative(baseDirectory, file.uri) : file.uri
  const target = vscode.Uri.file(file.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  return `[${relativePath}](${target.toString()})`
}

function markdownHover(value: string): vscode.Hover {
  const markdown = new vscode.MarkdownString(value)
  markdown.isTrusted = true
  return new vscode.Hover(markdown)
}

function methodHover(child: VueFileIndex, method: MethodInfo, baseDirectory: string): vscode.Hover {
  const docs = formatJSDocMarkdown(method.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}\`\`\`js\n${method.signature}\n\`\`\`\n\nDefinition: ${definitionLink(child, method.span, baseDirectory)}`)
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

function propHover(child: VueFileIndex, prop: PropInfo, baseDirectory: string): vscode.Hover {
  const docs = formatJSDocMarkdown(prop.documentation)
  const docText = docs ? `${docs}\n\n` : ''
  return markdownHover(`${docText}\`\`\`js\n${formatCodeBlock(prop.detail)}\n\`\`\`\n\nDefinition: ${definitionLink(child, prop.span, baseDirectory)}`)
}

function findCommonDirectory(files: VueFileIndex[]): string {
  if (files.length === 0) {
    return ''
  }

  const parts = path.dirname(files[0].uri).split(path.sep)
  for (const file of files.slice(1)) {
    const current = path.dirname(file.uri).split(path.sep)
    while (parts.length > 0 && current.slice(0, parts.length).join(path.sep) !== parts.join(path.sep)) {
      parts.pop()
    }
  }
  return parts.join(path.sep)
}

function formatUsage(file: VueFileIndex, offset: number, baseDirectory: string): string {
  const position = offsetToPosition(file.lineStarts, offset)
  const relativePath = baseDirectory ? path.relative(baseDirectory, file.uri) : file.uri
  const target = vscode.Uri.file(file.uri).with({ fragment: `L${position.line + 1},${position.character + 1}` })
  return `- [${relativePath}](${target.toString()})`
}

function commandLink(childUri: string, eventName: string, usageCount: number): string {
  const args = encodeURIComponent(JSON.stringify([{ childUri, eventName }]))
  return `[▶ Show all ${usageCount} listeners](command:${SHOW_EMIT_USAGES_COMMAND}?${args})`
}

function eventHover(child: VueFileIndex, eventName: string, baseDirectory: string): vscode.Hover | undefined {
  const emits = findEmit(child, eventName)
  if (emits.length === 0) {
    return undefined
  }

  if (emits.length === 1) {
    return markdownHover(`Definition: ${definitionLink(child, emits[0].eventSpan, baseDirectory)}`)
  }

  const definitions = emits.map((emit) => `- ${definitionLink(child, emit.eventSpan, baseDirectory)}`).join('\n')
  return markdownHover(`Definitions:\n\n${definitions}`)
}

function emitHover(child: VueFileIndex, eventName: string, files: VueFileIndex[], baseDirectory: string): vscode.Hover {
  const usages = findTemplateEventUsages(files, child.uri, eventName)
  const visibleUsages = usages.slice(0, 5)
  const usageLines = visibleUsages.map((usage) => formatUsage(usage.file, usage.span.start, baseDirectory))
  const usageText = usages.length > 0
    ? `Used by ${usages.length} listener${usages.length === 1 ? '' : 's'}:\n\n${usageLines.join('\n')}`
    : 'No template listeners found.'
  const more = usages.length > visibleUsages.length
    ? `\n\n${commandLink(child.uri, eventName, usages.length)}`
    : ''
  return markdownHover(`${usageText}${more}`)
}

export class VueHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    const offset = this.index.offsetAt(document.uri.fsPath, position.line, position.character)
    if (offset === undefined) {
      return undefined
    }

    const files = this.index.getAllFiles()
    const baseDirectory = findCommonDirectory(files)
    const refAccess = findRefMethodAccess(file.content, offset)
    if (refAccess) {
      const childUri = findRefComponent(file, refAccess.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, refAccess.methodName) : undefined
      return child && method ? methodHover(child, method, baseDirectory) : undefined
    }

    for (const component of file.templateIndex.components) {
      const childUri = findRegisteredComponent(file, component.tag)
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
          return prop ? propHover(child, prop, baseDirectory) : undefined
        }
        if (attr.kind === 'event') {
          return eventHover(child, attr.normalizedName, baseDirectory)
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return emitHover(file, emit.eventName, files, baseDirectory)
      }
    }

    return undefined
  }
}

import * as vscode from 'vscode'
import { WorkspaceIndex } from '../indexer/workspaceIndex'
import { createLineStarts, offsetToPosition } from '../utils/position'
import { SHOW_USAGES_COMMAND } from './hoverProvider'

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function toVsCodePosition(lineStarts: number[], offset: number): vscode.Position {
  const position = offsetToPosition(lineStarts, offset)
  return new vscode.Position(position.line, position.character)
}

function usageTitle(usageCount: number): string {
  const noun = usageCount === 1 ? 'usage' : 'usages'
  return `Used by ${usageCount} ${noun}`
}

export class VueCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file') {
      return []
    }
    if (!this.index.isInsideIndexedWorkspace(document.uri.fsPath)) {
      return []
    }

    if (!isVueDocument(document)) {
      const content = document.getText()
      this.index.syncScriptComponentUsageContent(document.uri.fsPath, content, false)
      const commandModule = this.index.getCommandComponentModule(document.uri.fsPath)
      if (!commandModule) {
        return []
      }
      const usages = this.index.findCommandComponentUsages(document.uri.fsPath)
      if (usages.length === 0) {
        return []
      }
      const position = toVsCodePosition(createLineStarts(content), commandModule.anchorSpan.start)
      return [
        new vscode.CodeLens(new vscode.Range(position, position), {
          title: usageTitle(usages.length),
          command: SHOW_USAGES_COMMAND,
          arguments: [{ kind: 'command-component-usages', commandUri: document.uri.fsPath }],
        }),
      ]
    }

    // CodeLens 不依赖 Inlay Hints 设置，直接复用现有的组件用法索引。
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    if (!file.template) {
      return []
    }

    const usages = this.index.findComponentUsages(file.uri)
    if (usages.length === 0) {
      return []
    }

    const position = toVsCodePosition(file.lineStarts, file.template.start)
    const range = new vscode.Range(position, position)
    return [
      new vscode.CodeLens(range, {
        title: usageTitle(usages.length),
        command: SHOW_USAGES_COMMAND,
        arguments: [{ kind: 'component-usages', childUri: file.uri }],
      }),
    ]
  }
}

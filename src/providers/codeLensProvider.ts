import * as vscode from 'vscode'
import { WorkspaceIndex } from '../indexer/workspaceIndex'
import { offsetToPosition } from '../utils/position'
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
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.changeEmitter.event

  constructor(private readonly index: WorkspaceIndex) {}

  refresh(): void {
    this.changeEmitter.fire()
  }

  dispose(): void {
    this.changeEmitter.dispose()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
    if (document.uri.scheme !== 'file') {
      return []
    }
    // CodeLens 的位置来自已保存快照，编辑期间隐藏以避免使用过期偏移。
    if (document.isDirty) {
      return []
    }
    if (!this.index.isInsideIndexedWorkspace(document.uri.fsPath)) {
      return []
    }

    if (!isVueDocument(document)) {
      const commandModule = this.index.getCommandComponentModule(document.uri.fsPath)
      const file = this.index.getIndexedDocumentFile(document.uri.fsPath)
      if (!commandModule || !file) {
        return []
      }
      const usages = this.index.findCommandComponentUsages(document.uri.fsPath)
      if (usages.length === 0) {
        return []
      }
      const position = toVsCodePosition(file.lineStarts, commandModule.anchorSpan.start)
      return [
        new vscode.CodeLens(new vscode.Range(position, position), {
          title: usageTitle(usages.length),
          command: SHOW_USAGES_COMMAND,
          arguments: [{ kind: 'command-component-usages', commandUri: document.uri.fsPath }],
        }),
      ]
    }

    // CodeLens 不依赖 Inlay Hints 设置，直接复用现有的组件用法索引。
    const file = this.index.getFile(document.uri.fsPath)
    if (!file) {
      return []
    }
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

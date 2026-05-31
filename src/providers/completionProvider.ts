import * as vscode from 'vscode'
import { WorkspaceIndex, findRefCompletionContextInFile } from '../indexer/workspaceIndex'
import { findResolvedRefComponent } from '../indexer/relationResolver'
import { formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'

const HIGH_PRIORITY_SORT_PREFIX = '\u0000\u0000'
const OPTIONAL_CHAIN_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0000`

export class VueCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.CompletionItem[]> {
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    const offset = this.index.offsetAt(document.uri.fsPath, position.line, position.character)
    if (offset === undefined) {
      return undefined
    }

    const refContext = findRefCompletionContextInFile(file, offset)
    if (!refContext) {
      return undefined
    }

    const childUri = findResolvedRefComponent(this.index, file, refContext.refName)
    const child = childUri ? this.index.getFile(childUri) : undefined
    if (!child) {
      return undefined
    }

    const range = new vscode.Range(
      position.line,
      position.character - refContext.partialMethodName.length - refContext.accessToken.length,
      position.line,
      position.character,
    )

    return child.scriptIndex.methods.map((method) => {
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
}

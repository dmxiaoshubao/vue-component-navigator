import * as vscode from 'vscode'
import type { MethodInfo, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefCompletionContext, findRefCompletionContextInFile } from '../indexer/workspaceIndex'
import { findResolvedRefComponent } from '../indexer/relationResolver'
import { formatJSDocMarkdown, markdownCodeBlock } from '../utils/jsdoc'
import { createLineStarts, positionToOffset } from '../utils/position'

const HIGH_PRIORITY_SORT_PREFIX = '\u0000\u0000'
const OPTIONAL_CHAIN_SORT_PREFIX = `${HIGH_PRIORITY_SORT_PREFIX}\u0000`

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

  private resolveChildren(file: VueFileIndex, refName: string): VueFileIndex[] {
    const childUri = findResolvedRefComponent(this.index, file, refName)
    const child = childUri ? this.index.getFile(childUri) : undefined
    return child ? [child] : []
  }

  private resolveSourceChildren(sourceUri: string, refName: string): VueFileIndex[] {
    if (!this.index.hasMixinSource(sourceUri)) {
      return []
    }

    return this.index.findSourceRefOwners(sourceUri, refName)
      .map((file) => this.index.getFile(findResolvedRefComponent(this.index, file, refName) ?? ''))
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
}

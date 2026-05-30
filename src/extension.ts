import * as vscode from 'vscode'
import { WorkspaceIndex } from './indexer/workspaceIndex'
import { VueCompletionProvider } from './providers/completionProvider'
import { VueDefinitionProvider } from './providers/definitionProvider'
import { VueHoverProvider } from './providers/hoverProvider'
import { VueReferenceProvider } from './providers/referenceProvider'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new WorkspaceIndex()
  const selector: vscode.DocumentSelector = [{ language: 'vue', scheme: 'file' }]

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    await index.indexWorkspace(folder.uri.fsPath)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vueComponentNavigator.showStatus', () => {
      const activeDocument = vscode.window.activeTextEditor?.document
      const indexedCurrentFile = activeDocument?.uri.scheme === 'file'
        ? Boolean(index.getFile(activeDocument.uri.fsPath))
        : false
      void vscode.window.showInformationMessage([
        `Vue Component Navigator indexed ${index.getFileCount()} Vue files.`,
        activeDocument ? `Current language: ${activeDocument.languageId}.` : 'No active editor.',
        activeDocument ? `Current file indexed: ${indexedCurrentFile ? 'yes' : 'no'}.` : '',
      ].filter(Boolean).join(' '))
    }),
    vscode.languages.registerDefinitionProvider(selector, new VueDefinitionProvider(index)),
    vscode.languages.registerCompletionItemProvider(selector, new VueCompletionProvider(index), '.', '?'),
    vscode.languages.registerHoverProvider(selector, new VueHoverProvider(index)),
    vscode.languages.registerReferenceProvider(selector, new VueReferenceProvider(index)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'vue' && document.uri.scheme === 'file') {
        index.syncContent(document.uri.fsPath, document.getText())
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) {
        if (file.fsPath.endsWith('.vue')) {
          index.remove(file.fsPath)
        }
      }
    }),
    vscode.workspace.onDidCreateFiles(async (event) => {
      await Promise.all(event.files
        .filter((file) => file.fsPath.endsWith('.vue'))
        .map((file) => index.indexFile(file.fsPath)))
    }),
  )
}

export function deactivate(): void {}

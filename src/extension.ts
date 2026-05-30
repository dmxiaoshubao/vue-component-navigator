import * as path from 'node:path'
import * as vscode from 'vscode'
import type { TextSpan, VueFileIndex } from './indexer/types'
import { WorkspaceIndex } from './indexer/workspaceIndex'
import { findTemplateEventUsages } from './indexer/relationResolver'
import { VueCompletionProvider } from './providers/completionProvider'
import { VueDefinitionProvider } from './providers/definitionProvider'
import { SHOW_EMIT_USAGES_COMMAND, VueHoverProvider } from './providers/hoverProvider'
import { VueReferenceProvider } from './providers/referenceProvider'
import { offsetToPosition, spanToRange } from './utils/position'

function commonDirectory(files: VueFileIndex[]): string {
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

function usageLabel(file: VueFileIndex, span: TextSpan, baseDirectory: string): string {
  const position = offsetToPosition(file.lineStarts, span.start)
  const relativePath = baseDirectory ? path.relative(baseDirectory, file.uri) : file.uri
  return `${relativePath}:${position.line + 1}:${position.character + 1}`
}

function toVsCodeRange(file: VueFileIndex, span: TextSpan): vscode.Range {
  const range = spanToRange(file.lineStarts, span)
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

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
    vscode.commands.registerCommand(SHOW_EMIT_USAGES_COMMAND, async ({ childUri, eventName }: { childUri: string, eventName: string }) => {
      const child = index.getFile(childUri)
      if (!child) {
        return
      }

      const files = index.getAllFiles()
      const usages = findTemplateEventUsages(files, child.uri, eventName)
      const baseDirectory = commonDirectory(files)
      const selected = await vscode.window.showQuickPick(usages.map((usage) => ({
        label: usageLabel(usage.file, usage.span, baseDirectory),
        file: usage.file,
        span: usage.span,
      })), {
        matchOnDescription: true,
        placeHolder: `Select ${eventName} listener`,
      })
      if (!selected) {
        return
      }

      const range = toVsCodeRange(selected.file, selected.span)
      await vscode.window.showTextDocument(vscode.Uri.file(selected.file.uri), { selection: range, preview: true })
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

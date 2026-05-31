import * as path from 'node:path'
import * as vscode from 'vscode'
import type { TextSpan, VueFileIndex } from './indexer/types'
import { WorkspaceIndex } from './indexer/workspaceIndex'
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

export function activate(context: vscode.ExtensionContext): void {
  const index = new WorkspaceIndex()
  const selector: vscode.DocumentSelector = [{ language: 'vue', scheme: 'file' }]
  const pendingSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let indexStatus: 'idle' | 'indexing' | 'ready' | 'failed' | 'cancelled' = 'idle'

  function clearPendingSync(filePath: string): void {
    const timer = pendingSyncTimers.get(filePath)
    if (timer) {
      clearTimeout(timer)
      pendingSyncTimers.delete(filePath)
    }
  }

  function scheduleSync(filePath: string, content: string): void {
    clearPendingSync(filePath)
    // 输入过程中做短暂防抖，避免每次按键都重建整份文件索引。
    const timer = setTimeout(() => {
      pendingSyncTimers.delete(filePath)
      index.syncContent(filePath, content)
    }, 120)
    pendingSyncTimers.set(filePath, timer)
  }

  async function indexVueFile(filePath: string): Promise<void> {
    try {
      clearPendingSync(filePath)
      await index.indexFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Vue Component Navigator failed to index ${filePath}: ${message}`)
    }
  }

  async function syncGlobalComponentFile(filePath: string): Promise<void> {
    try {
      await index.syncGlobalComponentFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Vue Component Navigator failed to index ${filePath}: ${message}`)
    }
  }

  async function refreshGlobalComponentsFromVueFiles(): Promise<void> {
    try {
      await index.refreshGlobalComponentsFromVueFiles()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Vue Component Navigator failed to refresh global components: ${message}`)
    }
  }

  async function refreshGlobalComponentsForVueFile(filePath: string): Promise<void> {
    try {
      await index.refreshGlobalComponentsForVueFile(filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Vue Component Navigator failed to refresh global components: ${message}`)
    }
  }

  async function indexWorkspaceFolders(title: string, showSuccess: boolean): Promise<void> {
    if (indexStatus === 'indexing') {
      void vscode.window.showInformationMessage('Vue Component Navigator is already indexing the workspace.')
      return
    }

    indexStatus = 'indexing'
    try {
      const indexed = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title,
        cancellable: true,
      }, async (_progress, token) => {
        const nextIndex = new WorkspaceIndex()
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
          if (token.isCancellationRequested) {
            return false
          }
          await nextIndex.indexWorkspace(folder.uri.fsPath, token)
        }
        if (token.isCancellationRequested) {
          return false
        }
        index.replaceWith(nextIndex)
        return true
      })

      indexStatus = indexed ? 'ready' : 'cancelled'
      if (showSuccess && indexed) {
        void vscode.window.showInformationMessage(`Vue Component Navigator reindexed ${index.getFileCount()} Vue files.`)
      }
    } catch (error) {
      indexStatus = 'failed'
      const message = error instanceof Error ? error.message : String(error)
      void vscode.window.showWarningMessage(`Vue Component Navigator indexing failed: ${message}`)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('vueComponentNavigator.showStatus', () => {
      const activeDocument = vscode.window.activeTextEditor?.document
      const indexedCurrentFile = activeDocument?.uri.scheme === 'file'
        ? Boolean(index.getFile(activeDocument.uri.fsPath))
        : false
      void vscode.window.showInformationMessage([
        `Vue Component Navigator indexed ${index.getFileCount()} Vue files.`,
        `Index status: ${indexStatus}.`,
        activeDocument ? `Current language: ${activeDocument.languageId}.` : 'No active editor.',
        activeDocument ? `Current file indexed: ${indexedCurrentFile ? 'yes' : 'no'}.` : '',
      ].filter(Boolean).join(' '))
    }),
    vscode.commands.registerCommand('vueComponentNavigator.reindexWorkspace', async () => {
      await indexWorkspaceFolders('Reindexing Vue files...', true)
    }),
    vscode.commands.registerCommand(SHOW_EMIT_USAGES_COMMAND, async ({ childUri, eventName }: { childUri: string, eventName: string }) => {
      const child = index.getFile(childUri)
      if (!child) {
        return
      }

      const files = index.getAllFiles()
      const usages = index.findTemplateEventUsages(child.uri, eventName)
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
        clearPendingSync(document.uri.fsPath)
        index.syncContent(document.uri.fsPath, document.getText())
        void refreshGlobalComponentsForVueFile(document.uri.fsPath)
      } else if (isScriptFile(document.uri.fsPath) && document.uri.scheme === 'file') {
        void syncGlobalComponentFile(document.uri.fsPath)
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document
      if (document.languageId === 'vue' && document.uri.scheme === 'file') {
        scheduleSync(document.uri.fsPath, document.getText())
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) {
        if (file.fsPath.endsWith('.vue')) {
          clearPendingSync(file.fsPath)
          index.remove(file.fsPath)
          void refreshGlobalComponentsForVueFile(file.fsPath)
        } else if (isScriptFile(file.fsPath)) {
          index.removeGlobalComponentFile(file.fsPath)
        }
      }
    }),
    vscode.workspace.onDidCreateFiles(async (event) => {
      await Promise.all(event.files.map((file) => {
        if (file.fsPath.endsWith('.vue')) {
          return indexVueFile(file.fsPath).then(refreshGlobalComponentsFromVueFiles)
        }
        if (isScriptFile(file.fsPath)) {
          return syncGlobalComponentFile(file.fsPath)
        }
        return Promise.resolve()
      }))
    }),
    vscode.workspace.onDidRenameFiles(async (event) => {
      for (const file of event.files) {
        if (file.oldUri.fsPath.endsWith('.vue')) {
          clearPendingSync(file.oldUri.fsPath)
          index.remove(file.oldUri.fsPath)
          await refreshGlobalComponentsForVueFile(file.oldUri.fsPath)
        } else if (isScriptFile(file.oldUri.fsPath)) {
          index.removeGlobalComponentFile(file.oldUri.fsPath)
        }
        if (file.newUri.fsPath.endsWith('.vue')) {
          clearPendingSync(file.newUri.fsPath)
          await indexVueFile(file.newUri.fsPath)
          await refreshGlobalComponentsFromVueFiles()
        } else if (isScriptFile(file.newUri.fsPath)) {
          await syncGlobalComponentFile(file.newUri.fsPath)
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void indexWorkspaceFolders('Indexing Vue files...', false)
    }),
    {
      dispose: () => {
        for (const timer of pendingSyncTimers.values()) {
          clearTimeout(timer)
        }
        pendingSyncTimers.clear()
      },
    },
  )

  void indexWorkspaceFolders('Indexing Vue files...', false)
}

export function deactivate(): void {}

function isScriptFile(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.ts')
}

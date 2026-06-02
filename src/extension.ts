import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { SourceLocation, TextSpan, UsageInfo, VueFileIndex } from './indexer/types'
import { WorkspaceIndex } from './indexer/workspaceIndex'
import { VueCompletionProvider } from './providers/completionProvider'
import { VueDefinitionProvider } from './providers/definitionProvider'
import { SHOW_USAGES_COMMAND, VueHoverProvider } from './providers/hoverProvider'
import { VueReferenceProvider } from './providers/referenceProvider'
import { offsetToPosition, spanToRange } from './utils/position'
import { commonDirectory, relativePath, usagePathLabels } from './utils/pathDisplay'

type UsageCommandArgs =
  | { kind?: 'event-listeners', childUri: string, eventName: string }
  | { kind: 'prop-usages', childUri: string, propName: string }
  | { kind: 'provide-definitions', consumerUri: string, injectKey: string }
  | { kind: 'inject-usages', providerUri: string, provideKey: string }
  | { kind: 'source-usages', sourceUri: string, offset: number, relation: 'prop' | 'method' | 'event' | 'provide' | 'inject' }

type PackageDependencies = Record<string, string | undefined> | undefined

interface PackageJson {
  dependencies?: PackageDependencies
  devDependencies?: PackageDependencies
  peerDependencies?: PackageDependencies
  optionalDependencies?: PackageDependencies
}

function usageLabel(file: VueFileIndex, span: TextSpan, label: string, sourceLocation?: SourceLocation): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  return `${label}:${position.line + 1}:${position.character + 1}`
}

function toVsCodeRange(file: VueFileIndex, span: TextSpan, sourceLocation?: SourceLocation): vscode.Range {
  const location = sourceLocation ?? { lineStarts: file.lineStarts, span }
  const range = spanToRange(location.lineStarts, location.span)
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

export function activate(context: vscode.ExtensionContext): void {
  const index = new WorkspaceIndex()
  const selector: vscode.DocumentSelector = [
    { language: 'vue', scheme: 'file' },
    { language: 'javascript', scheme: 'file' },
    { language: 'typescript', scheme: 'file' },
  ]
  const pendingSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const featureDisposables: vscode.Disposable[] = []
  let vue2Workspace: boolean | undefined
  let featuresRegistered = false
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

  function registerWorkspaceFeatures(): void {
    if (featuresRegistered) {
      return
    }
    featuresRegistered = true
    featureDisposables.push(
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
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        if (await ensureVue2Workspace(false)) {
          await indexWorkspaceFolders('Indexing Vue files...', false)
        }
      }),
    )
  }

  function disableWorkspaceFeatures(): void {
    for (const disposable of featureDisposables.splice(0)) {
      disposable.dispose()
    }
    featuresRegistered = false
    for (const timer of pendingSyncTimers.values()) {
      clearTimeout(timer)
    }
    pendingSyncTimers.clear()
    index.replaceWith(new WorkspaceIndex())
  }

  async function ensureVue2Workspace(showMessage: boolean): Promise<boolean> {
    vue2Workspace = await hasVue2Workspace()
    if (!vue2Workspace) {
      disableWorkspaceFeatures()
      indexStatus = 'idle'
      if (showMessage) {
        void vscode.window.showInformationMessage('Vue Component Navigator is disabled because no Vue 2 dependency was found in workspace package.json.')
      }
      return false
    }

    registerWorkspaceFeatures()
    return true
  }

  function resolveUsages(args: UsageCommandArgs): { usages: UsageInfo[], placeHolder: string } {
    if (args.kind === 'source-usages') {
      if (args.relation === 'prop') {
        return {
          usages: index.findTemplatePropUsagesFromSource(args.sourceUri, args.offset),
          placeHolder: 'Select prop usage',
        }
      }
      if (args.relation === 'method') {
        return {
          usages: index.findRefMethodUsagesFromSource(args.sourceUri, args.offset),
          placeHolder: 'Select ref method usage',
        }
      }
      if (args.relation === 'provide') {
        return {
          usages: index.findInjectUsagesFromProvideSource(args.sourceUri, args.offset),
          placeHolder: 'Select inject consumer',
        }
      }
      if (args.relation === 'inject') {
        return {
          usages: index.findProvideDefinitionsFromInjectSource(args.sourceUri, args.offset),
          placeHolder: 'Select provide definition',
        }
      }
      return {
        usages: index.findTemplateEventUsagesFromSource(args.sourceUri, args.offset),
        placeHolder: 'Select event listener',
      }
    }

    if (args.kind === 'prop-usages') {
      return {
        usages: index.findTemplatePropUsages(args.childUri, args.propName),
        placeHolder: `Select ${args.propName} prop usage`,
      }
    }

    if (args.kind === 'provide-definitions') {
      const consumer = index.getFile(args.consumerUri)
      return {
        usages: consumer ? index.findProvideDefinitions(consumer, args.injectKey) : [],
        placeHolder: `Select ${args.injectKey} provider`,
      }
    }

    if (args.kind === 'inject-usages') {
      return {
        usages: index.findInjectUsages(args.providerUri, args.provideKey),
        placeHolder: `Select ${args.provideKey} inject consumer`,
      }
    }

    const child = index.getFile(args.childUri)
    return {
      usages: child ? index.findTemplateEventUsages(child.uri, args.eventName) : [],
      placeHolder: `Select ${args.eventName} listener`,
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
        `Vue 2 package detected: ${vue2Workspace === undefined ? 'unknown' : vue2Workspace ? 'yes' : 'no'}.`,
        activeDocument ? `Current language: ${activeDocument.languageId}.` : 'No active editor.',
        activeDocument ? `Current file indexed: ${indexedCurrentFile ? 'yes' : 'no'}.` : '',
      ].filter(Boolean).join(' '))
    }),
    vscode.commands.registerCommand('vueComponentNavigator.reindexWorkspace', async () => {
      if (!await ensureVue2Workspace(true)) {
        return
      }
      await indexWorkspaceFolders('Reindexing Vue files...', true)
    }),
    vscode.commands.registerCommand(SHOW_USAGES_COMMAND, async (args: UsageCommandArgs) => {
      const { usages, placeHolder } = resolveUsages(args)
      if (usages.length === 0) {
        return
      }

      const files = index.getAllFiles()
      const baseDirectory = commonDirectory(files.map((file) => file.uri))
      const labels = usagePathLabels(usages.map((usage) => usage.sourceLocation?.uri ?? usage.file.uri), baseDirectory)
      const selected = await vscode.window.showQuickPick(usages.map((usage) => ({
        label: usageLabel(usage.file, usage.span, labels.get(usage.sourceLocation?.uri ?? usage.file.uri) ?? path.basename(usage.sourceLocation?.uri ?? usage.file.uri), usage.sourceLocation),
        description: relativePath(usage.sourceLocation?.uri ?? usage.file.uri, baseDirectory),
        file: usage.file,
        span: usage.span,
        sourceLocation: usage.sourceLocation,
      })), {
        matchOnDescription: true,
        placeHolder,
      })
      if (!selected) {
        return
      }

      const range = toVsCodeRange(selected.file, selected.span, selected.sourceLocation)
      await vscode.window.showTextDocument(vscode.Uri.file(selected.sourceLocation?.uri ?? selected.file.uri), { selection: range, preview: true })
    }),
    {
      dispose: () => {
        disableWorkspaceFeatures()
      },
    },
  )

  void ensureVue2Workspace(false).then((enabled) => {
    if (enabled) {
      void indexWorkspaceFolders('Indexing Vue files...', false)
    }
  })
}

export function deactivate(): void {}

function isScriptFile(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.ts')
}

async function hasVue2Workspace(): Promise<boolean> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await hasVue2PackageJson(folder.uri.fsPath)) {
      return true
    }
  }
  return false
}

async function hasVue2PackageJson(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as PackageJson
    return packageHasVue2(pkg)
  } catch {
    return false
  }
}

export function packageHasVue2(pkg: PackageJson): boolean {
  const version = pkg.dependencies?.vue
    ?? pkg.devDependencies?.vue
    ?? pkg.peerDependencies?.vue
    ?? pkg.optionalDependencies?.vue
  return typeof version === 'string' && isVue2Version(version)
}

export function isVue2Version(version: string): boolean {
  const normalized = version.trim().toLowerCase()
  if (/^(?:npm:vue@)?[\^~]?\s*2(?:$|[.\s*x-])/.test(normalized)) {
    return true
  }
  if (/\b2\.(?:x|\*)\b/.test(normalized)) {
    return true
  }
  return /(?:^|\s)(?:>=|>|=)?\s*2(?:$|[.\s*x-])/.test(normalized) && /(?:^|\s)<\s*3(?:$|[.\s*x-])/.test(normalized)
}

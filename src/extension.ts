import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { SourceLocation, TextSpan, UsageInfo, VueFileIndex, VueMajorVersion } from './indexer/types'
import { clearTsConfigCache } from './indexer/relationResolver'
import { WorkspaceIndex } from './indexer/workspaceIndex'
import { VueCompletionProvider } from './providers/completionProvider'
import { VueDefinitionProvider } from './providers/definitionProvider'
import { SHOW_USAGES_COMMAND, VueHoverProvider } from './providers/hoverProvider'
import { VueReferenceProvider } from './providers/referenceProvider'
import { offsetToPosition, spanToRange } from './utils/position'
import { commonDirectory, relativePath, usagePathLabels } from './utils/pathDisplay'

type UsageCommandArgs =
  | { kind?: 'event-listeners', childUri: string, eventName: string }
  | { kind: 'event-bus-listeners', busName: string, eventName: string }
  | { kind: 'event-bus-emits', busName: string, eventName: string }
  | { kind: 'prop-usages', childUri: string, propName: string }
  | { kind: 'ref-method-usages', childUri: string, methodName: string }
  | { kind: 'provide-definitions', consumerUri: string, injectKey: string }
  | { kind: 'inject-usages', providerUri: string, provideKey: string }
  | { kind: 'source-usages', sourceUri: string, offset: number, relation: 'prop' | 'prop-type' | 'method' | 'event' | 'provide' | 'inject' }

type PackageDependencies = Record<string, string | undefined> | undefined
type EntryConfig = string | readonly string[] | undefined

interface PackageJson {
  dependencies?: PackageDependencies
  devDependencies?: PackageDependencies
  peerDependencies?: PackageDependencies
  optionalDependencies?: PackageDependencies
}

function usageLabel(file: VueFileIndex, span: TextSpan, label: string, sourceLocation?: SourceLocation): string {
  const location = sourceLocation ?? { uri: file.uri, lineStarts: file.lineStarts, span }
  const position = offsetToPosition(location.lineStarts, location.span.start)
  return `${label}:${position.line + 1}`
}

function eventBusMethodSuffix(usage: UsageInfo): string {
  return 'method' in usage ? ` ${String(usage.method)}` : ''
}

export function normalizeEntryConfig(value: EntryConfig): string[] {
  const entries = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string' ? [value] : []
  return [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))]
}

function getWorkspaceEntryConfig(folder: vscode.WorkspaceFolder): string[] {
  const value = vscode.workspace.getConfiguration('vueComponentNavigator', folder.uri).get<EntryConfig>('entry')
  return normalizeEntryConfig(value)
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
  let supportedVueWorkspace: boolean | undefined
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
      clearTsConfigCache()
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
          const vueVersion = await workspaceVueVersion(folder.uri.fsPath)
          if (!vueVersion) {
            continue
          }
          await nextIndex.indexWorkspace(folder.uri.fsPath, token, getWorkspaceEntryConfig(folder), vueVersion)
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

  async function refreshForAliasConfigChange(configPath: string): Promise<void> {
    clearTsConfigCache(path.dirname(configPath))
    if (await ensureSupportedVueWorkspace(false)) {
      await indexWorkspaceFolders('Indexing Vue files...', false)
    }
  }

  async function refreshForAliasConfigChanges(filePaths: string[]): Promise<void> {
    const configPaths = filePaths.filter(isAliasConfigFile)
    if (configPaths.length === 0) {
      return
    }

    for (const configPath of configPaths) {
      clearTsConfigCache(path.dirname(configPath))
    }
    if (await ensureSupportedVueWorkspace(false)) {
      await indexWorkspaceFolders('Indexing Vue files...', false)
    }
  }

  function registerWorkspaceFeatures(): void {
    if (featuresRegistered) {
      return
    }
    featuresRegistered = true
    featureDisposables.push(
      vscode.languages.registerDefinitionProvider(selector, new VueDefinitionProvider(index)),
      vscode.languages.registerCompletionItemProvider(selector, new VueCompletionProvider(index), '.', '?', '\'', '"'),
      vscode.languages.registerHoverProvider(selector, new VueHoverProvider(index)),
      vscode.languages.registerReferenceProvider(selector, new VueReferenceProvider(index)),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === 'vue' && document.uri.scheme === 'file') {
          clearPendingSync(document.uri.fsPath)
          index.syncContent(document.uri.fsPath, document.getText())
          void refreshGlobalComponentsForVueFile(document.uri.fsPath)
        } else if (isScriptFile(document.uri.fsPath) && document.uri.scheme === 'file') {
          void syncGlobalComponentFile(document.uri.fsPath)
        } else if (isAliasConfigFile(document.uri.fsPath) && document.uri.scheme === 'file') {
          return refreshForAliasConfigChange(document.uri.fsPath)
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const document = event.document
        if (document.languageId === 'vue' && document.uri.scheme === 'file') {
          scheduleSync(document.uri.fsPath, document.getText())
        }
      }),
      vscode.workspace.onDidDeleteFiles(async (event) => {
        await refreshForAliasConfigChanges(event.files.map((file) => file.fsPath))
        for (const file of event.files) {
          if (file.fsPath.endsWith('.vue')) {
            clearPendingSync(file.fsPath)
            index.remove(file.fsPath)
            void refreshGlobalComponentsForVueFile(file.fsPath)
          } else if (isScriptFile(file.fsPath)) {
            await index.removeGlobalComponentFile(file.fsPath)
          }
        }
      }),
      vscode.workspace.onDidCreateFiles(async (event) => {
        await refreshForAliasConfigChanges(event.files.map((file) => file.fsPath))
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
        await refreshForAliasConfigChanges(event.files.flatMap((file) => [file.oldUri.fsPath, file.newUri.fsPath]))
        for (const file of event.files) {
          if (file.oldUri.fsPath.endsWith('.vue')) {
            clearPendingSync(file.oldUri.fsPath)
            index.remove(file.oldUri.fsPath)
            await refreshGlobalComponentsForVueFile(file.oldUri.fsPath)
          } else if (isScriptFile(file.oldUri.fsPath)) {
            await index.removeGlobalComponentFile(file.oldUri.fsPath)
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
        if (await ensureSupportedVueWorkspace(false)) {
          await indexWorkspaceFolders('Indexing Vue files...', false)
        }
      }),
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration('vueComponentNavigator.entry')) {
          return
        }
        if (await ensureSupportedVueWorkspace(false)) {
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

  async function ensureSupportedVueWorkspace(showMessage: boolean): Promise<boolean> {
    supportedVueWorkspace = await hasSupportedVueWorkspace()
    if (!supportedVueWorkspace) {
      disableWorkspaceFeatures()
      indexStatus = 'idle'
      if (showMessage) {
        void vscode.window.showInformationMessage('Vue Component Navigator is disabled because no supported Vue 2 or Vue 3 dependency was found in workspace package.json.')
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
          usages: index.findPropUsagesFromSource(args.sourceUri, args.offset),
          placeHolder: 'Select prop usage',
        }
      }
      if (args.relation === 'prop-type') {
        return {
          usages: index.findVue3PropTypeUsagesFromSource(args.sourceUri, args.offset),
          placeHolder: 'Select defineProps usage',
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

    if (args.kind === 'event-bus-listeners') {
      return {
        usages: index.findEventBusListeners(args.busName, args.eventName),
        placeHolder: `Select ${args.busName} ${args.eventName} event bus listener`,
      }
    }

    if (args.kind === 'event-bus-emits') {
      return {
        usages: index.findEventBusEmits(args.busName, args.eventName),
        placeHolder: `Select ${args.busName} ${args.eventName} event bus emit`,
      }
    }

    if (args.kind === 'ref-method-usages') {
      return {
        usages: index.findRefMethodUsages(args.childUri, args.methodName),
        placeHolder: `Select ${args.methodName} ref method usage`,
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
        `Supported Vue package detected: ${supportedVueWorkspace === undefined ? 'unknown' : supportedVueWorkspace ? 'yes' : 'no'}.`,
        activeDocument ? `Current language: ${activeDocument.languageId}.` : 'No active editor.',
        activeDocument ? `Current file indexed: ${indexedCurrentFile ? 'yes' : 'no'}.` : '',
      ].filter(Boolean).join(' '))
    }),
    vscode.commands.registerCommand('vueComponentNavigator.reindexWorkspace', async () => {
      if (!await ensureSupportedVueWorkspace(true)) {
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
        label: `${usageLabel(usage.file, usage.span, labels.get(usage.sourceLocation?.uri ?? usage.file.uri) ?? path.basename(usage.sourceLocation?.uri ?? usage.file.uri), usage.sourceLocation)}${eventBusMethodSuffix(usage)}`,
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

  void ensureSupportedVueWorkspace(false).then((enabled) => {
    if (enabled) {
      void indexWorkspaceFolders('Indexing Vue files...', false)
    }
  })
}

export function deactivate(): void {}

function isScriptFile(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.ts')
}

function isAliasConfigFile(filePath: string): boolean {
  const fileName = path.basename(filePath)
  return fileName === 'jsconfig.json' || fileName === 'tsconfig.json'
}

async function hasSupportedVueWorkspace(): Promise<boolean> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await workspaceVueVersion(folder.uri.fsPath)) {
      return true
    }
  }
  return false
}

async function workspaceVueVersion(root: string): Promise<VueMajorVersion | undefined> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as PackageJson
    return packageVueVersion(pkg)
  } catch {
    return undefined
  }
}

export function packageHasVue2(pkg: PackageJson): boolean {
  return packageVueVersion(pkg) === 2
}

export function packageHasSupportedVue(pkg: PackageJson): boolean {
  return packageVueVersion(pkg) !== undefined
}

export function packageVueVersion(pkg: PackageJson): VueMajorVersion | undefined {
  const version = pkg.dependencies?.vue
    ?? pkg.devDependencies?.vue
    ?? pkg.peerDependencies?.vue
    ?? pkg.optionalDependencies?.vue
  if (typeof version !== 'string') {
    return undefined
  }
  if (isVue2Version(version)) {
    return 2
  }
  return isVue3Version(version) ? 3 : undefined
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

export function isVue3Version(version: string): boolean {
  const normalized = version.trim().toLowerCase()
  if (/^(?:npm:vue@)?[\^~]?\s*3(?:$|[.\s*x-])/.test(normalized)) {
    return true
  }
  if (/\b3\.(?:x|\*)\b/.test(normalized)) {
    return true
  }
  return /(?:^|\s)(?:>=|>|=)?\s*3(?:$|[.\s*x-])/.test(normalized) && !/(?:^|\s)<\s*3(?:$|[.\s*x-])/.test(normalized)
}

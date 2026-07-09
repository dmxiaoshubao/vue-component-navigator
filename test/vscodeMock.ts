type Disposable = { dispose(): void }

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  start: Position
  end: Position

  constructor(start: Position | number, startCharacter?: number, endLine?: number, endCharacter?: number) {
    if (start instanceof Position) {
      this.start = start
      this.end = startCharacter instanceof Position ? startCharacter : start
      return
    }

    this.start = new Position(start, startCharacter ?? 0)
    this.end = new Position(endLine ?? start, endCharacter ?? startCharacter ?? 0)
  }
}

export class Uri {
  scheme = 'file'
  constructor(public fsPath: string, public fragment = '') {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath)
  }
  with(change: { fragment?: string }): Uri {
    return new Uri(this.fsPath, change.fragment ?? this.fragment)
  }
  toString(): string {
    return `file://${this.fsPath}${this.fragment ? `#${this.fragment}` : ''}`
  }
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export enum CompletionItemKind {
  Method = 1,
  Event = 2,
  Property = 3,
}

export class CompletionItem {
  detail?: string
  documentation?: string | MarkdownString
  sortText?: string
  preselect?: boolean
  range?: Range
  insertText?: string
  filterText?: string
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class MarkdownString {
  isTrusted?: boolean | { enabledCommands: string[] }
  constructor(public value = '') {}
}

export class Hover {
  constructor(public contents: string | MarkdownString) {}
}

export class CodeLens {
  constructor(public range: Range, public command?: any) {}
}

export enum ProgressLocation {
  Window = 10,
}

export const registeredCommands = new Map<string, (...args: any[]) => any>()
export const saveListeners: Array<(document: any) => any> = []
export const changeTextListeners: Array<(event: any) => any> = []
export const deleteListeners: Array<(event: any) => any> = []
export const createListeners: Array<(event: any) => any> = []
export const renameListeners: Array<(event: any) => any> = []
export const workspaceFolderListeners: Array<(event: any) => any> = []
export const configurationListeners: Array<(event: any) => any> = []
export const informationMessages: string[] = []
export const warningMessages: string[] = []
export const quickPickCalls: Array<{ items: any[], options?: any }> = []
export const shownDocuments: Array<{ uri: Uri, options?: any }> = []
export const providerRegistrations: string[] = []
export const providerSelectors: any[] = []
export const codeLensProviders: any[] = []
export const configurationValues = new Map<string, any>()
export const extensionValues = new Map<string, any>()

function disposable(): Disposable {
  return { dispose() {} }
}

export function resetMockState(): void {
  registeredCommands.clear()
  saveListeners.length = 0
  changeTextListeners.length = 0
  deleteListeners.length = 0
  createListeners.length = 0
  renameListeners.length = 0
  workspaceFolderListeners.length = 0
  configurationListeners.length = 0
  informationMessages.length = 0
  warningMessages.length = 0
  quickPickCalls.length = 0
  shownDocuments.length = 0
  providerRegistrations.length = 0
  providerSelectors.length = 0
  codeLensProviders.length = 0
  configurationValues.clear()
  extensionValues.clear()
  workspace.workspaceFolders = []
  window.activeTextEditor = undefined
}

export const languages = {
  registerDefinitionProvider: (selector: any) => {
    providerRegistrations.push('definition')
    providerSelectors.push(selector)
    return disposable()
  },
  registerCompletionItemProvider: (selector: any) => {
    providerRegistrations.push('completion')
    providerSelectors.push(selector)
    return disposable()
  },
  registerHoverProvider: (selector: any) => {
    providerRegistrations.push('hover')
    providerSelectors.push(selector)
    return disposable()
  },
  registerReferenceProvider: (selector: any) => {
    providerRegistrations.push('reference')
    providerSelectors.push(selector)
    return disposable()
  },
  registerCodeLensProvider: (selector: any, provider: any) => {
    providerRegistrations.push('codeLens')
    providerSelectors.push(selector)
    codeLensProviders.push(provider)
    return disposable()
  },
}

export const commands = {
  registerCommand: (name: string, handler: (...args: any[]) => any) => {
    registeredCommands.set(name, handler)
    return disposable()
  },
}

export const extensions = {
  getExtension: (id: string) => extensionValues.get(id),
}

export const window = {
  activeTextEditor: undefined as { document: any } | undefined,
  showInformationMessage: (message: string) => {
    informationMessages.push(message)
    return Promise.resolve(message)
  },
  showWarningMessage: (message: string) => {
    warningMessages.push(message)
    return Promise.resolve(message)
  },
  showQuickPick: async (items: any[], options?: any) => {
    quickPickCalls.push({ items, options })
    return items[0]
  },
  showTextDocument: async (uri: Uri, options?: any) => {
    shownDocuments.push({ uri, options })
    return undefined
  },
  withProgress: async (_options: any, task: (progress: any, token: { isCancellationRequested: boolean }) => any) => task({}, { isCancellationRequested: false }),
}

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri }>,
  onDidSaveTextDocument: (listener: (document: any) => any) => {
    saveListeners.push(listener)
    return disposable()
  },
  onDidChangeTextDocument: (listener: (event: any) => any) => {
    changeTextListeners.push(listener)
    return disposable()
  },
  onDidDeleteFiles: (listener: (event: any) => any) => {
    deleteListeners.push(listener)
    return disposable()
  },
  onDidCreateFiles: (listener: (event: any) => any) => {
    createListeners.push(listener)
    return disposable()
  },
  onDidRenameFiles: (listener: (event: any) => any) => {
    renameListeners.push(listener)
    return disposable()
  },
  onDidChangeWorkspaceFolders: (listener: (event: any) => any) => {
    workspaceFolderListeners.push(listener)
    return disposable()
  },
  onDidChangeConfiguration: (listener: (event: any) => any) => {
    configurationListeners.push(listener)
    return disposable()
  },
  getConfiguration: (section?: string) => ({
    get: (key: string) => {
      const scopedKey = section ? `${section}.${key}` : key
      return configurationValues.get(scopedKey)
    },
  }),
}

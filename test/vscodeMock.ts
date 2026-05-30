export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position | number, public startCharacter?: number, public endLine?: number, public endCharacter?: number) {}
}

export class Uri {
  constructor(public fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath)
  }
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export enum CompletionItemKind {
  Method = 1,
}

export class CompletionItem {
  detail?: string
  documentation?: string
  sortText?: string
  preselect?: boolean
  constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class Hover {
  constructor(public contents: string) {}
}

export const languages = {
  registerDefinitionProvider: () => ({ dispose() {} }),
  registerCompletionItemProvider: () => ({ dispose() {} }),
  registerHoverProvider: () => ({ dispose() {} }),
  registerReferenceProvider: () => ({ dispose() {} }),
}

export const workspace = {
  workspaceFolders: [],
  onDidSaveTextDocument: () => ({ dispose() {} }),
  onDidDeleteFiles: () => ({ dispose() {} }),
  onDidCreateFiles: () => ({ dispose() {} }),
}

import * as vscode from 'vscode'
import type { TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex } from '../indexer/workspaceIndex'
import { findIndexedRefMethodUsages, findIndexedTemplateEventUsages, findIndexedTemplatePropUsages } from '../indexer/relationResolver'
import { containsOffsetStrict, spanToRange } from '../utils/position'

function toRange(file: VueFileIndex, span: TextSpan): vscode.Range {
  const range = spanToRange(file.lineStarts, span)
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

function toLocation(file: VueFileIndex, span: TextSpan): vscode.Location {
  return new vscode.Location(vscode.Uri.file(file.uri), toRange(file, span))
}

export class VueReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideReferences(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Location[]> {
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    const offset = this.index.offsetAt(document.uri.fsPath, position.line, position.character)
    if (offset === undefined) {
      return []
    }

    for (const method of file.scriptIndex.methods) {
      if (containsOffsetStrict(method.span, offset)) {
        return findIndexedRefMethodUsages(this.index, file.uri, method.name).map((usage) => toLocation(usage.file, usage.span))
      }
    }

    for (const prop of file.scriptIndex.props) {
      if (containsOffsetStrict(prop.span, offset)) {
        return findIndexedTemplatePropUsages(this.index, file.uri, prop.name).map((usage) => toLocation(usage.file, usage.span))
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return findIndexedTemplateEventUsages(this.index, file.uri, emit.eventName).map((usage) => toLocation(usage.file, usage.span))
      }
    }

    return []
  }
}

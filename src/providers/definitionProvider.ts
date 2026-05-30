import * as vscode from 'vscode'
import type { TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccess } from '../indexer/workspaceIndex'
import { findEmit, findMethod, findProp, findRefComponent, findRegisteredComponent, findTemplateEventUsages } from '../indexer/relationResolver'
import { containsOffsetStrict, spanToRange } from '../utils/position'

function toRange(file: VueFileIndex, span: TextSpan): vscode.Range {
  const range = spanToRange(file.lineStarts, span)
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

function toLocation(file: VueFileIndex, span: TextSpan): vscode.Location {
  return new vscode.Location(vscode.Uri.file(file.uri), toRange(file, span))
}

export class VueDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const file = this.index.syncContent(document.uri.fsPath, document.getText())
    const offset = this.index.offsetAt(document.uri.fsPath, position.line, position.character)
    if (offset === undefined) {
      return undefined
    }

    const refAccess = findRefMethodAccess(file.content, offset)
    if (refAccess) {
      const childUri = findRefComponent(file, refAccess.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, refAccess.methodName) : undefined
      return child && method ? toLocation(child, method.span) : undefined
    }

    for (const component of file.templateIndex.components) {
      const childUri = findRegisteredComponent(file, component.tag)
      const child = childUri ? this.index.getFile(childUri) : undefined
      if (!child) {
        continue
      }

      for (const attr of component.attrs) {
        if (!containsOffsetStrict(attr.span, offset)) {
          continue
        }
        if (attr.kind === 'prop') {
          const prop = findProp(child, attr.normalizedName)
          return prop ? toLocation(child, prop.span) : undefined
        }
        if (attr.kind === 'event') {
          const emits = findEmit(child, attr.normalizedName)
          return emits.map((emit) => toLocation(child, emit.eventSpan))
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        const usages = findTemplateEventUsages(this.index.getAllFiles(), file.uri, emit.eventName)
        return usages.map((usage) => toLocation(usage.file, usage.span))
      }
    }

    return undefined
  }
}

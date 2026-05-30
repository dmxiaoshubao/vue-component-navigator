import * as vscode from 'vscode'
import type { VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccess } from '../indexer/workspaceIndex'
import { findEmit, findMethod, findProp, findRefComponent, findRegisteredComponent } from '../indexer/relationResolver'
import { containsOffsetStrict } from '../utils/position'

function methodHover(child: VueFileIndex, methodName: string, detail: string): vscode.Hover {
  return new vscode.Hover(`**${child.scriptIndex.componentName ?? child.fileName}.methods.${methodName}**\n\n\`${detail}\``)
}

function propHover(child: VueFileIndex, propName: string, detail: string): vscode.Hover {
  return new vscode.Hover(`**${child.scriptIndex.componentName ?? child.fileName}.props.${propName}**\n\n\`${detail}\``)
}

function emitHover(child: VueFileIndex, eventName: string): vscode.Hover {
  return new vscode.Hover(`**${child.scriptIndex.componentName ?? child.fileName} emits ${eventName}**`)
}

export class VueHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
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
      return child && method ? methodHover(child, method.name, method.detail) : undefined
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
          return prop ? propHover(child, prop.name, prop.detail) : undefined
        }
        if (attr.kind === 'event') {
          const emits = findEmit(child, attr.normalizedName)
          return emits.length > 0 ? emitHover(child, attr.normalizedName) : undefined
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return emitHover(file, emit.eventName)
      }
    }

    return undefined
  }
}

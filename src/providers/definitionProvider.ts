import * as vscode from 'vscode'
import type { SourceLocation, TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccessInFile } from '../indexer/workspaceIndex'
import { findEmit, findIndexedInjectUsages, findIndexedProvideDefinitions, findIndexedTemplateEventUsages, findInject, findMethod, findProp, findProvideAtOffset, findResolvedComponent, findResolvedRefComponent, hasRegisteredComponent } from '../indexer/relationResolver'
import { containsOffsetStrict, createLineStarts, positionToOffset, spanToRange } from '../utils/position'

function toRange(file: VueFileIndex, span: TextSpan): vscode.Range {
  const range = spanToRange(file.lineStarts, span)
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

function toLocation(file: VueFileIndex, span: TextSpan, sourceLocation?: SourceLocation): vscode.Location {
  if (sourceLocation) {
    const range = spanToRange(sourceLocation.lineStarts, sourceLocation.span)
    return new vscode.Location(
      vscode.Uri.file(sourceLocation.uri),
      new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
    )
  }
  return new vscode.Location(vscode.Uri.file(file.uri), toRange(file, span))
}

function isVueDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'vue' || document.uri.fsPath.endsWith('.vue')
}

function offsetInDocument(document: vscode.TextDocument, position: vscode.Position): number | undefined {
  return positionToOffset(createLineStarts(document.getText()), { line: position.line, character: position.character })
}

export class VueDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const file = isVueDocument(document)
      ? this.index.syncContent(document.uri.fsPath, document.getText())
      : this.index.getFile(document.uri.fsPath)
    const offset = isVueDocument(document)
      ? this.index.offsetAt(document.uri.fsPath, position.line, position.character)
      : offsetInDocument(document, position)
    if (offset === undefined) {
      return undefined
    }

    const sourceDefinition = this.index.hasMixinSource(document.uri.fsPath)
      ? this.provideSourceDefinition(document.uri.fsPath, offset)
      : undefined
    if (sourceDefinition) {
      return sourceDefinition
    }
    if (!file) {
      return undefined
    }

    const refAccess = findRefMethodAccessInFile(file, offset)
    if (refAccess) {
      const childUri = findResolvedRefComponent(this.index, file, refAccess.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, refAccess.methodName) : undefined
      return child && method ? toLocation(child, method.span, method.sourceLocation) : undefined
    }

    for (const component of file.templateIndex.components) {
      const childUri = findResolvedComponent(this.index, file, component.tag)
      const child = childUri ? this.index.getFile(childUri) : undefined
      if (!child) {
        continue
      }

      if (containsOffsetStrict(component.span, offset) && !hasRegisteredComponent(file, component.tag)) {
        return toLocation(child, { start: 0, end: 0 })
      }

      for (const attr of component.attrs) {
        if (!containsOffsetStrict(attr.span, offset)) {
          continue
        }
        if (attr.kind === 'prop') {
          const prop = findProp(child, attr.normalizedName)
          return prop ? toLocation(child, prop.span, prop.sourceLocation) : undefined
        }
        if (attr.kind === 'event') {
          const emits = findEmit(child, attr.normalizedName)
          return emits.map((emit) => toLocation(child, emit.eventSpan, emit.sourceLocation))
        }
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        const usages = findIndexedTemplateEventUsages(this.index, file.uri, emit.eventName)
        return usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    const inject = findInject(file, offset)
    if (inject) {
      return findIndexedProvideDefinitions(this.index, file, inject.key).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const provide = findProvideAtOffset(file, offset)
    if (provide) {
      return findIndexedInjectUsages(this.index, file.uri, provide.key).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    return undefined
  }

  private provideSourceDefinition(sourceUri: string, offset: number): vscode.Definition | undefined {
    const refDefinitions = this.index.findSourceRefMethodCalls(sourceUri, offset).flatMap(({ file, call }) => {
      const childUri = findResolvedRefComponent(this.index, file, call.refName)
      const child = childUri ? this.index.getFile(childUri) : undefined
      const method = child ? findMethod(child, call.methodName) : undefined
      return child && method ? [toLocation(child, method.span, method.sourceLocation)] : []
    })
    if (refDefinitions.length > 0) {
      return refDefinitions
    }

    const eventUsages = this.index.findTemplateEventUsagesFromSource(sourceUri, offset)
    if (eventUsages.length > 0) {
      return eventUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const provideDefinitions = this.index.findProvideDefinitionsFromInjectSource(sourceUri, offset)
    if (provideDefinitions.length > 0) {
      return provideDefinitions.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const injectUsages = this.index.findInjectUsagesFromProvideSource(sourceUri, offset)
    if (injectUsages.length > 0) {
      return injectUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    return undefined
  }
}

import * as vscode from 'vscode'
import type { SourceLocation, TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex } from '../indexer/workspaceIndex'
import { findIndexedInjectUsages, findIndexedPropUsages, findIndexedRefMethodUsages, findIndexedTemplateEventUsages } from '../indexer/relationResolver'
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

export class VueReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly index: WorkspaceIndex) {}

  provideReferences(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Location[]> {
    const vueDocument = isVueDocument(document)
    if (document.uri.scheme !== 'file') {
      return []
    }
    // 索引只对应已保存内容；脏文档的偏移可能已经变化，避免返回错误引用。
    if (document.isDirty) {
      return []
    }
    if (vueDocument && !this.index.isInsideIndexedWorkspace(document.uri.fsPath)) {
      return []
    }
    if (!vueDocument && !this.index.hasIndexedDocumentContext(document.uri.fsPath)) {
      return []
    }

    const content = document.getText()
    const file = this.index.getIndexedDocumentFile(document.uri.fsPath)
    const offset = vueDocument
      ? this.index.offsetAt(document.uri.fsPath, position.line, position.character)
      : positionToOffset(createLineStarts(content), { line: position.line, character: position.character })
    if (offset === undefined) {
      return []
    }

    const sourceReferences = this.index.hasSourceRelations(document.uri.fsPath)
      ? this.sourceReferences(document.uri.fsPath, offset)
      : []
    if (sourceReferences.length > 0) {
      return sourceReferences
    }
    if (!file) {
      return []
    }

    const vue3PropType = this.index.findVue3PropTypeAtOffset(file, offset)
    if (vue3PropType) {
      const usages = this.index.findVue3PropTypeUsagesFromSource(vue3PropType.sourceLocation?.uri ?? file.uri, vue3PropType.sourceLocation?.span.start ?? vue3PropType.span.start)
      return usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const vue3PropUsage = this.index.findVue3PropUsageAtOffset(file, offset)
    if (vue3PropUsage) {
      return this.index.findVue3PropInternalUsages(file.uri, vue3PropUsage.propName)
        .map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    for (const call of file.scriptIndex.eventBusCalls) {
      if (containsOffsetStrict(call.eventSpan, offset)) {
        const usages = call.kind === 'emit'
          ? this.index.findEventBusListeners(call.busName, call.eventName)
          : this.index.findEventBusEmits(call.busName, call.eventName)
        return usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const method of file.scriptIndex.methods) {
      if (containsOffsetStrict(method.span, offset)) {
        return findIndexedRefMethodUsages(this.index, file.uri, method.name).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const prop of file.scriptIndex.props) {
      if (containsOffsetStrict(prop.span, offset)) {
        return findIndexedPropUsages(this.index, file.uri, prop.name).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        return findIndexedTemplateEventUsages(this.index, file.uri, emit.eventName).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const slot of file.scriptIndex.slots) {
      if (containsOffsetStrict(slot.span, offset)) {
        return this.index.findTemplateSlotUsages(file.uri, slot.name).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const provide of file.scriptIndex.provides) {
      if (containsOffsetStrict(provide.keySpan, offset)) {
        return findIndexedInjectUsages(this.index, file.uri, provide.key).map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    return []
  }

  private sourceReferences(sourceUri: string, offset: number): vscode.Location[] {
    return [
      ...this.index.findRefMethodUsagesFromSource(sourceUri, offset),
      ...this.index.findPropUsagesFromSource(sourceUri, offset),
      ...this.index.findVue3PropTypeUsagesFromSource(sourceUri, offset),
      ...this.index.findComposableReturnUsagesFromSource(sourceUri, offset),
      ...this.index.findTemplateEventUsagesFromSource(sourceUri, offset),
      ...this.index.findEventBusListenersFromSource(sourceUri, offset),
      ...this.index.findEventBusEmitsFromSource(sourceUri, offset),
      ...this.index.findInjectUsagesFromProvideSource(sourceUri, offset),
      ...this.index.findMixinConsumersFromSource(sourceUri, offset),
    ].map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
  }
}

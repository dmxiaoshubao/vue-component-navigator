import * as vscode from 'vscode'
import type { SourceLocation, TextSpan, VueFileIndex } from '../indexer/types'
import { WorkspaceIndex, findRefMethodAccessInFile } from '../indexer/workspaceIndex'
import { findEmit, findIndexedInjectUsages, findIndexedProvideDefinitions, findIndexedRefMethodUsages, findIndexedTemplateEventUsages, findIndexedTemplatePropUsages, findInject, findProp, findProvideAtOffset, findResolvedRefComponents, hasRegisteredComponent } from '../indexer/relationResolver'
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

function uniqueLocations(locations: vscode.Location[]): vscode.Location[] {
  const seen = new Set<string>()
  const results: vscode.Location[] = []
  for (const location of locations) {
    const key = `${location.uri.toString()}\0${location.range.start.line}\0${location.range.start.character}\0${location.range.end.line}\0${location.range.end.character}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push(location)
  }
  return results
}

function locationResult(locations: vscode.Location[]): vscode.Location | vscode.Location[] | undefined {
  if (locations.length === 0) {
    return undefined
  }
  return locations.length === 1 ? locations[0] : locations
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

    const sourceDefinition = this.index.hasSourceRelations(document.uri.fsPath)
      ? this.provideSourceDefinition(document.uri.fsPath, offset)
      : undefined
    if (sourceDefinition) {
      return sourceDefinition
    }
    if (!file) {
      return undefined
    }

    const vue3PropType = this.index.findVue3PropTypeAtOffset(file, offset)
    if (vue3PropType?.sourceLocation) {
      return toLocation(file, vue3PropType.span, vue3PropType.sourceLocation)
    }

    const vue3PropUsage = this.index.findVue3PropUsageAtOffset(file, offset)
    if (vue3PropUsage) {
      const prop = findProp(file, vue3PropUsage.propName)
      return prop ? toLocation(file, prop.span, prop.sourceLocation) : undefined
    }

    const refAccess = findRefMethodAccessInFile(file, offset)
    if (refAccess) {
      const definitions = uniqueLocations(findResolvedRefComponents(this.index, file, refAccess.refName).flatMap((childUri) => {
        return this.index.findRefMethodDefinitions(childUri, refAccess.methodName)
          .map(({ file, method }) => toLocation(file, method.span, method.sourceLocation))
      }))
      return locationResult(definitions)
    }

    for (const call of file.scriptIndex.eventBusCalls) {
      if (containsOffsetStrict(call.eventSpan, offset)) {
        const usages = call.kind === 'emit'
          ? this.index.findEventBusListeners(call.busName, call.eventName)
          : this.index.findEventBusEmits(call.busName, call.eventName)
        return locationResult(uniqueLocations(usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))))
      }
    }

    for (const component of file.templateIndex.components) {
      const children = this.index.resolveTemplateComponentUris(file, component)
        .map((childUri) => this.index.getFile(childUri))
        .filter((child): child is VueFileIndex => Boolean(child))
      if (children.length === 0) {
        continue
      }

      if (containsOffsetStrict(component.span, offset) && !hasRegisteredComponent(file, component.tag)) {
        return locationResult(uniqueLocations(children.map((child) => toLocation(child, { start: 0, end: 0 }))))
      }

      for (const attr of component.attrs) {
        if (!containsOffsetStrict(attr.span, offset)) {
          continue
        }
        if (attr.kind === 'prop') {
          const definitions = children.flatMap((child) => {
            return this.index.findPropDefinitions(child.uri, attr.normalizedName)
              .map(({ file, prop }) => toLocation(file, prop.span, prop.sourceLocation))
          })
          return locationResult(uniqueLocations(definitions))
        }
        if (attr.kind === 'event') {
          return uniqueLocations(children.flatMap((child) => {
            return this.index.findEventDefinitions(child.uri, attr.normalizedName)
              .map(({ file, emit }) => toLocation(file, emit.eventSpan, emit.sourceLocation))
          }))
        }
      }

      for (const slot of component.slots) {
        if (!containsOffsetStrict(slot.span, offset)) {
          continue
        }
        const definitions = children.flatMap((child) => {
          return this.index.findSlotDefinitions(child.uri, slot.normalizedName)
            .map(({ file, slot }) => toLocation(file, slot.span, slot.sourceLocation))
        })
        return locationResult(uniqueLocations(definitions))
      }
    }

    for (const emit of file.scriptIndex.emits) {
      if (containsOffsetStrict(emit.eventSpan, offset)) {
        const usages = findIndexedTemplateEventUsages(this.index, file.uri, emit.eventName)
        return usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const method of file.scriptIndex.methods) {
      if (containsOffsetStrict(method.span, offset)) {
        const usages = findIndexedRefMethodUsages(this.index, file.uri, method.name)
        return usages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
      }
    }

    for (const prop of file.scriptIndex.props) {
      if (containsOffsetStrict(prop.span, offset)) {
        const usages = findIndexedTemplatePropUsages(this.index, file.uri, prop.name)
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
    const refDefinitions = uniqueLocations(this.index.findSourceRefMethodCalls(sourceUri, offset).flatMap(({ file, call }) => {
      return findResolvedRefComponents(this.index, file, call.refName).flatMap((childUri) => {
        return this.index.findRefMethodDefinitions(childUri, call.methodName)
          .map(({ file, method }) => toLocation(file, method.span, method.sourceLocation))
      })
    }))
    if (refDefinitions.length > 0) {
      return refDefinitions
    }

    const methodUsages = this.index.findRefMethodUsagesFromSource(sourceUri, offset)
    if (methodUsages.length > 0) {
      return methodUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const typeUsages = this.index.findVue3PropTypeUsagesFromSource(sourceUri, offset)
    if (typeUsages.length > 0) {
      return typeUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const propUsages = this.index.findPropUsagesFromSource(sourceUri, offset)
    if (propUsages.length > 0) {
      return propUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const eventUsages = this.index.findTemplateEventUsagesFromSource(sourceUri, offset)
    if (eventUsages.length > 0) {
      return eventUsages.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const eventBusListeners = this.index.findEventBusListenersFromSource(sourceUri, offset)
    if (eventBusListeners.length > 0) {
      return eventBusListeners.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
    }

    const eventBusEmits = this.index.findEventBusEmitsFromSource(sourceUri, offset)
    if (eventBusEmits.length > 0) {
      return eventBusEmits.map((usage) => toLocation(usage.file, usage.span, usage.sourceLocation))
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

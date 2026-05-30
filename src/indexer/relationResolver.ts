import path from 'node:path'
import type { VueFileIndex } from './types'
import { matchesName, toCamelCase, toKebabCase } from '../utils/casing'

export function resolveImportPath(fromUri: string, source: string): string | undefined {
  if (!source.startsWith('.')) {
    return undefined
  }

  const base = path.dirname(fromUri)
  const resolved = path.resolve(base, source)
  return path.extname(resolved) ? resolved : `${resolved}.vue`
}

export function findRegisteredComponent(parent: VueFileIndex, tag: string): string | undefined {
  const registration = parent.scriptIndex.components.find((component) => {
    return component.tag === tag || toKebabCase(component.tag) === toKebabCase(tag)
  })
  return registration?.targetUri
}

export function findProp(child: VueFileIndex, propName: string) {
  const camelName = toCamelCase(propName)
  return child.scriptIndex.props.find((prop) => matchesName(prop.name, propName) || prop.name === camelName)
}

export function findMethod(child: VueFileIndex, methodName: string) {
  return child.scriptIndex.methods.find((method) => method.name === methodName)
}

export function findEmit(child: VueFileIndex, eventName: string) {
  return child.scriptIndex.emits.filter((emit) => emit.eventName === eventName)
}

export function findRefComponent(parent: VueFileIndex, refName: string): string | undefined {
  const usage = parent.templateIndex.components.find((component) => {
    return component.attrs.some((attr) => attr.kind === 'ref' && attr.name === refName)
  })
  if (!usage) {
    return undefined
  }
  return findRegisteredComponent(parent, usage.tag)
}

export function findTemplatePropUsages(files: VueFileIndex[], childUri: string, propName: string) {
  const kebabName = toKebabCase(propName)
  const results: Array<{ file: VueFileIndex, span: { start: number, end: number } }> = []

  for (const file of files) {
    for (const component of file.templateIndex.components) {
      if (findRegisteredComponent(file, component.tag) !== childUri) {
        continue
      }

      for (const attr of component.attrs) {
        if (attr.kind === 'prop' && (matchesName(attr.normalizedName, propName) || attr.normalizedName === kebabName)) {
          results.push({ file, span: attr.span })
        }
      }
    }
  }

  return results
}

export function findTemplateEventUsages(files: VueFileIndex[], childUri: string, eventName: string) {
  const results: Array<{ file: VueFileIndex, span: { start: number, end: number } }> = []

  for (const file of files) {
    for (const component of file.templateIndex.components) {
      if (findRegisteredComponent(file, component.tag) !== childUri) {
        continue
      }

      for (const attr of component.attrs) {
        if (attr.kind === 'event' && attr.normalizedName === eventName) {
          results.push({ file, span: attr.span })
        }
      }
    }
  }

  return results
}

export function findRefMethodUsages(files: VueFileIndex[], childUri: string, methodName: string) {
  const results: Array<{ file: VueFileIndex, span: { start: number, end: number } }> = []

  for (const file of files) {
    const pattern = /this\.\$refs\.([A-Za-z_$][\w$]*)(?:\.|\?\.)([A-Za-z_$][\w$]*)/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(file.content))) {
      const [, refName, calledMethod] = match
      if (calledMethod !== methodName || findRefComponent(file, refName) !== childUri) {
        continue
      }
      const methodStart = match.index + match[0].lastIndexOf(calledMethod)
      results.push({ file, span: { start: methodStart, end: methodStart + calledMethod.length } })
    }
  }

  return results
}

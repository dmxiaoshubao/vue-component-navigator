import path from 'node:path'
import type { UsageInfo, VueFileIndex } from './types'
import type { WorkspaceIndex } from './workspaceIndex'
import { matchesName, toCamelCase, toKebabCase } from '../utils/casing'

const registeredComponentCache = new WeakMap<VueFileIndex, Map<string, string | undefined>>()

function getRegisteredComponentCache(parent: VueFileIndex): Map<string, string | undefined> {
  let cache = registeredComponentCache.get(parent)
  if (!cache) {
    cache = new Map()
    registeredComponentCache.set(parent, cache)
  }
  return cache
}

export function resolveImportPath(fromUri: string, source: string, workspaceRoots: string[] = []): string | undefined {
  if (source.startsWith('@/')) {
    const suffix = source.slice(2)
    const root = workspaceRoots.find((item) => fromUri.startsWith(item))
    if (!root) {
      return undefined
    }
    const resolved = path.resolve(root, 'src', suffix)
    return path.extname(resolved) ? resolved : `${resolved}.vue`
  }

  if (!source.startsWith('.')) {
    return undefined
  }

  const base = path.dirname(fromUri)
  const resolved = path.resolve(base, source)
  return path.extname(resolved) ? resolved : `${resolved}.vue`
}

export function findRegisteredComponent(parent: VueFileIndex, tag: string): string | undefined {
  const normalizedTag = toKebabCase(tag)
  const cache = getRegisteredComponentCache(parent)
  if (cache.has(normalizedTag)) {
    return cache.get(normalizedTag)
  }

  const registration = parent.scriptIndex.components.find((component) => {
    return component.tag === tag || toKebabCase(component.tag) === normalizedTag
  })
  cache.set(normalizedTag, registration?.targetUri)
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

export function findIndexedTemplatePropUsages(index: WorkspaceIndex, childUri: string, propName: string): UsageInfo[] {
  return index.findTemplatePropUsages(childUri, propName)
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

export function findIndexedTemplateEventUsages(index: WorkspaceIndex, childUri: string, eventName: string): UsageInfo[] {
  return index.findTemplateEventUsages(childUri, eventName)
}

export function findRefMethodUsages(files: VueFileIndex[], childUri: string, methodName: string) {
  const results: UsageInfo[] = []

  for (const file of files) {
    for (const call of file.refMethodCalls) {
      if (call.methodName !== methodName || findRefComponent(file, call.refName) !== childUri) {
        continue
      }
      results.push({ file, span: call.methodSpan })
    }
  }

  return results
}

export function findIndexedRefMethodUsages(index: WorkspaceIndex, childUri: string, methodName: string): UsageInfo[] {
  return index.findRefMethodUsages(childUri, methodName)
}

import path from 'node:path'
import fs from 'node:fs'
import type { UsageInfo, VueFileIndex } from './types'
import type { WorkspaceIndex } from './workspaceIndex'
import { matchesName, toCamelCase, toKebabCase } from '../utils/casing'

const registeredComponentCache = new WeakMap<VueFileIndex, Map<string, string | undefined>>()
const tsConfigCache = new Map<string, TsConfigAlias | undefined>()

interface TsConfigAlias {
  configDir: string
  baseUrl: string
  paths: Record<string, string[]>
}

function getRegisteredComponentCache(parent: VueFileIndex): Map<string, string | undefined> {
  let cache = registeredComponentCache.get(parent)
  if (!cache) {
    cache = new Map()
    registeredComponentCache.set(parent, cache)
  }
  return cache
}

export function resolveImportPath(fromUri: string, source: string, workspaceRoots: string[] = []): string | undefined {
  return resolveImportPathWithExtensions(fromUri, source, workspaceRoots, ['.vue'])
}

export function resolveImportPathWithExtensions(fromUri: string, source: string, workspaceRoots: string[] = [], extensions: string[] = ['.vue']): string | undefined {
  if (!source.startsWith('.')) {
    return resolveFromTsConfig(fromUri, source, workspaceRoots, extensions)
  }

  const base = path.dirname(fromUri)
  const resolved = path.resolve(base, source)
  return withDefaultExtensions(resolved, extensions)
}

function resolveFromTsConfig(fromUri: string, source: string, workspaceRoots: string[], extensions: string[]): string | undefined {
  const config = findNearestTsConfig(path.dirname(fromUri), workspaceRoots)
  if (!config) {
    return undefined
  }

  for (const [alias, targets] of Object.entries(config.paths)) {
    const wildcard = matchPathAlias(alias, source)
    if (wildcard === undefined) {
      continue
    }

    for (const target of targets) {
      const resolved = path.resolve(config.configDir, config.baseUrl, target.replace('*', wildcard))
      return withDefaultExtensions(resolved, extensions)
    }
  }

  return undefined
}

function findNearestTsConfig(startDir: string, workspaceRoots: string[]): TsConfigAlias | undefined {
  let current = startDir
  const boundaries = workspaceRoots.filter((root) => startDir === root || isInsideDirectory(startDir, root))
  const visited: string[] = []

  while (true) {
    const cached = tsConfigCache.get(current)
    if (tsConfigCache.has(current)) {
      cacheVisitedTsConfigDirs(visited, cached)
      return cached
    }

    visited.push(current)
    const parsed = readTsConfigAlias(current)
    if (parsed) {
      cacheVisitedTsConfigDirs(visited, parsed)
      return parsed
    }

    if (boundaries.includes(current)) {
      cacheVisitedTsConfigDirs(visited, undefined)
      return undefined
    }

    const parent = path.dirname(current)
    if (parent === current) {
      cacheVisitedTsConfigDirs(visited, undefined)
      return undefined
    }
    current = parent
  }
}

function cacheVisitedTsConfigDirs(directories: string[], config: TsConfigAlias | undefined): void {
  for (const directory of directories) {
    tsConfigCache.set(directory, config)
  }
}

function readTsConfigAlias(directory: string): TsConfigAlias | undefined {
  const configPath = ['tsconfig.json', 'jsconfig.json']
    .map((name) => path.join(directory, name))
    .find((file) => fs.existsSync(file))
  if (!configPath) {
    return undefined
  }

  try {
    const config = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8'))) as {
      compilerOptions?: {
        baseUrl?: string
        paths?: Record<string, string[]>
      }
    }
    const paths = config.compilerOptions?.paths
    if (!paths) {
      return undefined
    }
    return {
      configDir: directory,
      baseUrl: config.compilerOptions?.baseUrl ?? '.',
      paths,
    }
  } catch {
    return undefined
  }
}

function matchPathAlias(alias: string, source: string): string | undefined {
  if (!alias.includes('*')) {
    return alias === source ? '' : undefined
  }

  const [prefix, suffix] = alias.split('*')
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) {
    return undefined
  }
  return source.slice(prefix.length, source.length - suffix.length)
}

function withDefaultExtensions(resolved: string, extensions: string[]): string {
  if (path.extname(resolved)) {
    return resolved
  }

  for (const extension of extensions) {
    const candidate = `${resolved}${extension}`
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  for (const extension of extensions) {
    const candidate = path.join(resolved, `index${extension}`)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return `${resolved}${extensions[0]}`
}

function stripJsonComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function isInsideDirectory(file: string, directory: string): boolean {
  const relative = path.relative(directory, file)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
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

export function hasRegisteredComponent(parent: VueFileIndex, tag: string): boolean {
  return findRegisteredComponent(parent, tag) !== undefined
}

export function findResolvedComponent(index: WorkspaceIndex, parent: VueFileIndex, tag: string): string | undefined {
  return index.resolveComponent(parent, tag)
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
  const tags = usage.dynamicTags?.length ? usage.dynamicTags : [usage.tag]
  return tags.map((tag) => findRegisteredComponent(parent, tag)).find(Boolean)
}

export function findResolvedRefComponent(index: WorkspaceIndex, parent: VueFileIndex, refName: string): string | undefined {
  return index.resolveRefComponent(parent, refName)
}

export function findResolvedRefComponents(index: WorkspaceIndex, parent: VueFileIndex, refName: string): string[] {
  return index.resolveRefComponents(parent, refName)
}

export function findTemplatePropUsages(files: VueFileIndex[], childUri: string, propName: string) {
  const kebabName = toKebabCase(propName)
  const results: Array<{ file: VueFileIndex, span: { start: number, end: number } }> = []

  for (const file of files) {
    for (const component of file.templateIndex.components) {
      if (!templateComponentMatches(file, component, childUri)) {
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
      if (!templateComponentMatches(file, component, childUri)) {
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

export function findIndexedEventBusEmits(index: WorkspaceIndex, busName: string, eventName: string): UsageInfo[] {
  return index.findEventBusEmits(busName, eventName)
}

export function findIndexedEventBusListeners(index: WorkspaceIndex, busName: string, eventName: string): UsageInfo[] {
  return index.findEventBusListeners(busName, eventName)
}

function templateComponentMatches(file: VueFileIndex, component: VueFileIndex['templateIndex']['components'][number], childUri: string): boolean {
  const tags = component.dynamicTags?.length ? component.dynamicTags : [component.tag]
  return tags.some((tag) => findRegisteredComponent(file, tag) === childUri)
}

export function findProvide(file: VueFileIndex, provideKey: string) {
  return file.scriptIndex.provides.filter((provide) => provide.key === provideKey)
}

export function findInject(file: VueFileIndex, offset: number) {
  return file.scriptIndex.injects.find((inject) => {
    return (offset >= inject.keySpan.start && offset < inject.keySpan.end)
      || (offset >= inject.localSpan.start && offset < inject.localSpan.end)
  })
}

export function findProvideAtOffset(file: VueFileIndex, offset: number) {
  return file.scriptIndex.provides.find((provide) => offset >= provide.keySpan.start && offset < provide.keySpan.end)
}

export function findIndexedInjectUsages(index: WorkspaceIndex, providerUri: string, provideKey: string): UsageInfo[] {
  return index.findInjectUsages(providerUri, provideKey)
}

export function findIndexedProvideDefinitions(index: WorkspaceIndex, consumer: VueFileIndex, injectKey: string): UsageInfo[] {
  return index.findProvideDefinitions(consumer, injectKey)
}

export function findRefMethodUsages(files: VueFileIndex[], childUri: string, methodName: string) {
  const results: UsageInfo[] = []

  for (const file of files) {
    for (const call of file.refMethodCalls) {
      if (call.methodName !== methodName || findRefComponent(file, call.refName) !== childUri) {
        continue
      }
      results.push({ file, span: call.methodSpan, sourceLocation: call.sourceLocation })
    }
  }

  return results
}

export function findIndexedRefMethodUsages(index: WorkspaceIndex, childUri: string, methodName: string): UsageInfo[] {
  return index.findRefMethodUsages(childUri, methodName)
}

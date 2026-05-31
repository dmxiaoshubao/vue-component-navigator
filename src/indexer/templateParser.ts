import type { TemplateAttrUsage, TemplateComponentUsage, TemplateIndex } from './types'
import { toCamelCase, toKebabCase } from '../utils/casing'

const ignoredPropNames = new Set([
  'class',
  'style',
  'key',
  'ref',
  'slot',
  'slot-scope',
  'is',
])

function isVueDirective(name: string): boolean {
  return name.startsWith('v-') || name.startsWith('#')
}

function stripModifier(name: string): string {
  return name.split('.')[0]
}

function normalizeAttr(attrName: string): TemplateAttrUsage | undefined {
  if (attrName === 'ref') {
    return undefined
  }

  if (attrName.startsWith('@')) {
    const name = stripModifier(attrName.slice(1))
    return { kind: 'event', name, normalizedName: name, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith('v-on:')) {
    const name = stripModifier(attrName.slice('v-on:'.length))
    return { kind: 'event', name, normalizedName: name, span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith(':')) {
    const name = stripModifier(attrName.slice(1))
    return { kind: 'prop', name, normalizedName: toCamelCase(name), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (attrName.startsWith('v-bind:')) {
    const name = stripModifier(attrName.slice('v-bind:'.length))
    return { kind: 'prop', name, normalizedName: toCamelCase(name), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
  }

  if (ignoredPropNames.has(attrName) || isVueDirective(attrName)) {
    return undefined
  }

  return { kind: 'prop', name: attrName, normalizedName: toCamelCase(attrName), span: { start: 0, end: 0 }, fullSpan: { start: 0, end: 0 } }
}

function extractRef(openTag: string, openStart: number): TemplateAttrUsage[] {
  const refs: TemplateAttrUsage[] = []
  const pattern = /\sref\s*=\s*["']([^"']+)["']/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(openTag))) {
    const valueStart = openStart + match.index + match[0].lastIndexOf(match[1])
    const attrStart = openStart + match.index + match[0].indexOf('ref')
    refs.push({
      kind: 'ref',
      name: match[1],
      normalizedName: match[1],
      span: { start: valueStart, end: valueStart + match[1].length },
      fullSpan: { start: attrStart, end: attrStart + 3 },
    })
  }
  return refs
}

function extractAttrs(openTag: string, openStart: number): TemplateAttrUsage[] {
  const attrs = extractRef(openTag, openStart)
  const pattern = /\s([:@A-Za-z_][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(openTag))) {
    const rawName = match[1]
    if (rawName === 'ref') {
      continue
    }
    const normalized = normalizeAttr(rawName)
    if (!normalized) {
      continue
    }

    const fullStart = openStart + match.index + match[0].indexOf(rawName)
    const semanticNameStart = rawName.startsWith('@')
      ? fullStart + 1
      : rawName.startsWith(':')
        ? fullStart + 1
        : rawName.startsWith('v-on:')
          ? fullStart + 'v-on:'.length
          : rawName.startsWith('v-bind:')
            ? fullStart + 'v-bind:'.length
            : fullStart

    attrs.push({
      ...normalized,
      span: { start: semanticNameStart, end: semanticNameStart + normalized.name.length },
      fullSpan: { start: fullStart, end: fullStart + rawName.length },
    })
  }

  return attrs
}

function findOpenTagEnd(template: string, openStart: number): number {
  let quote: '"' | "'" | undefined

  for (let index = openStart; index < template.length; index += 1) {
    const char = template[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '>') {
      return index + 1
    }
  }

  return template.length
}

export function parseTemplate(content: string, templateStart: number, registeredTags: string[]): TemplateIndex {
  const uniqueTags = new Set(registeredTags.map((tag) => toKebabCase(tag)))
  const components: TemplateComponentUsage[] = []

  const pattern = /<([A-Za-z][\w-]*)(?=\s|>|\/)/g
  let match: RegExpExecArray | null
  let nextCommentStart = content.indexOf('<!--')
  let commentEnd = -1

  while ((match = pattern.exec(content))) {
    while (nextCommentStart !== -1 && nextCommentStart < match.index && match.index >= commentEnd) {
      commentEnd = findHtmlCommentEnd(content, nextCommentStart)
      nextCommentStart = content.indexOf('<!--', commentEnd)
    }
    if (match.index < commentEnd) {
      continue
    }

    const rawTag = match[1]
    if (!uniqueTags.has(toKebabCase(rawTag))) {
      continue
    }

    const openEnd = findOpenTagEnd(content, match.index)
    const openTag = content.slice(match.index, openEnd)
    const attrs = extractAttrs(openTag, templateStart + match.index)
    components.push({
      tag: rawTag,
      span: {
        start: templateStart + match.index + 1,
        end: templateStart + match.index + 1 + rawTag.length,
      },
      attrs,
    })
  }

  components.sort((a, b) => a.span.start - b.span.start)
  return { components }
}

function findHtmlCommentEnd(content: string, start: number): number {
  const end = content.indexOf('-->', start + '<!--'.length)
  return end === -1 ? content.length : end + '-->'.length
}

import path from 'node:path'
import type { ParsedSfc, SfcBlock } from './types'
import { createLineStarts } from '../utils/position'

const templateOpen = /<template(?=[\s/>])/iy
const scriptOpen = /<script(?=[\s/>])/iy
const templateClose = /<\/template(?=[\s>])/iy

interface OpenTag {
  openEnd: number
  selfClosing: boolean
  attrs: string
}

function readOpenTag(source: string, tagNameEnd: number, start: number): OpenTag {
  let quote: '"' | "'" | undefined
  for (let index = tagNameEnd; index < source.length; index += 1) {
    const char = source[index]
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
      const attrs = source.slice(tagNameEnd, index)
      return { openEnd: index + 1, selfClosing: attrs.trimEnd().endsWith('/'), attrs }
    }
  }
  return { openEnd: source.length, selfClosing: false, attrs: source.slice(tagNameEnd) }
}

function commentEndAt(source: string, index: number): number {
  if (!source.startsWith('<!--', index)) {
    return -1
  }
  const end = source.indexOf('-->', index + '<!--'.length)
  return end === -1 ? source.length : end + '-->'.length
}

function blockBetween(source: string, start: number, end: number): SfcBlock {
  return { content: source.slice(start, end), start, end }
}

function findTemplateClose(source: string, contentStart: number): number {
  let depth = 1
  let cursor = contentStart
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      cursor += 1
      continue
    }
    const commentEnd = commentEndAt(source, cursor)
    if (commentEnd !== -1) {
      cursor = commentEnd
      continue
    }

    templateClose.lastIndex = cursor
    if (templateClose.test(source)) {
      const gt = source.indexOf('>', cursor)
      const closeStart = cursor
      cursor = gt === -1 ? source.length : gt + 1
      depth -= 1
      if (depth === 0) {
        return closeStart
      }
      continue
    }

    templateOpen.lastIndex = cursor
    if (templateOpen.test(source)) {
      const tag = readOpenTag(source, templateOpen.lastIndex, cursor)
      if (!tag.selfClosing) {
        depth += 1
      }
      cursor = tag.openEnd
      continue
    }

    cursor += 1
  }
  return source.length
}

function hasSetupAttr(attrs: string): boolean {
  return /(?:^|\s)setup(?=[\s=/>]|$)/i.test(attrs)
}

function hasSrcAttr(attrs: string): boolean {
  return /(?:^|\s)src\s*=/i.test(attrs)
}

interface ScanResult {
  script?: SfcBlock
  scriptSetup?: SfcBlock
  template?: SfcBlock
}

function scanBlocks(source: string): ScanResult {
  const result: ScanResult = {}
  let cursor = 0

  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      cursor += 1
      continue
    }
    const commentEnd = commentEndAt(source, cursor)
    if (commentEnd !== -1) {
      cursor = commentEnd
      continue
    }

    templateOpen.lastIndex = cursor
    if (result.template === undefined && templateOpen.test(source)) {
      const tag = readOpenTag(source, templateOpen.lastIndex, cursor)
      if (tag.selfClosing) {
        result.template = { content: '', start: tag.openEnd, end: tag.openEnd }
        cursor = tag.openEnd
      } else {
        const closeStart = findTemplateClose(source, tag.openEnd)
        result.template = blockBetween(source, tag.openEnd, closeStart)
        const gt = source.indexOf('>', closeStart)
        cursor = gt === -1 ? source.length : gt + 1
      }
      continue
    }

    scriptOpen.lastIndex = cursor
    if (scriptOpen.test(source)) {
      const tag = readOpenTag(source, scriptOpen.lastIndex, cursor)
      const setup = hasSetupAttr(tag.attrs)
      let block: SfcBlock
      if (tag.selfClosing || hasSrcAttr(tag.attrs)) {
        block = { content: '', start: tag.openEnd, end: tag.openEnd }
        cursor = tag.openEnd
      } else {
        const close = source.indexOf('</script>', tag.openEnd)
        const end = close === -1 ? source.length : close
        block = blockBetween(source, tag.openEnd, end)
        cursor = close === -1 ? source.length : close + '</script>'.length
      }
      if (setup) {
        result.scriptSetup ??= block
      } else {
        result.script ??= block
      }
      continue
    }

    cursor += 1
  }

  return result
}

export function parseSfc(uri: string, content: string): ParsedSfc {
  const { script, scriptSetup, template } = scanBlocks(content)
  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts: createLineStarts(content),
    script,
    scriptSetup,
    template,
  }
}

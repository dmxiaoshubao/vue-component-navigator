import path from 'node:path'
import type { ParsedSfc, SfcBlock } from './types'
import { createLineStarts } from '../utils/position'

interface TagToken {
  index: number
  end: number
  text: string
  isClose: boolean
}

function findTagEnd(source: string, start: number): number {
  let quote: string | undefined
  for (let index = start; index < source.length; index += 1) {
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
      return index + 1
    }
  }
  return -1
}

function findNextTagToken(source: string, tag: 'script' | 'template', from: number): TagToken | undefined {
  const pattern = new RegExp(`<\\/?${tag}\\b`, 'gi')
  pattern.lastIndex = from

  const match = pattern.exec(source)
  if (!match) {
    return undefined
  }

  const end = findTagEnd(source, match.index)
  if (end === -1) {
    return undefined
  }

  return {
    index: match.index,
    end,
    text: source.slice(match.index, end),
    isClose: match[0].startsWith('</'),
  }
}

function findBlock(source: string, tag: 'script' | 'template'): SfcBlock | undefined {
  let firstOpenEnd = -1
  let depth = 0
  let cursor = 0

  while (cursor < source.length) {
    const token = findNextTagToken(source, tag, cursor)
    if (!token) {
      break
    }
    cursor = token.end

    if (!token.isClose) {
      if (depth === 0) {
        firstOpenEnd = token.end
      }
      depth += 1
      continue
    }

    if (depth === 0) {
      continue
    }

    depth -= 1
    if (depth === 0 && firstOpenEnd !== -1) {
      return { content: source.slice(firstOpenEnd, token.index), start: firstOpenEnd, end: token.index }
    }
  }

  return undefined
}

function findScriptBlocks(source: string): { script?: SfcBlock, scriptSetup?: SfcBlock } {
  let openTag: TagToken | undefined
  let cursor = 0
  let script: SfcBlock | undefined
  let scriptSetup: SfcBlock | undefined

  while (cursor < source.length) {
    const token = findNextTagToken(source, 'script', cursor)
    if (!token) {
      break
    }
    cursor = token.end

    if (!token.isClose) {
      openTag = token
      continue
    }

    if (!openTag) {
      continue
    }

    const block = {
      content: source.slice(openTag.end, token.index),
      start: openTag.end,
      end: token.index,
    }
    if (/\bsetup\b/i.test(openTag.text)) {
      scriptSetup ??= block
    } else {
      script ??= block
    }
    openTag = undefined
  }

  return { script, scriptSetup }
}

export function parseSfc(uri: string, content: string): ParsedSfc {
  const scripts = findScriptBlocks(content)
  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts: createLineStarts(content),
    script: scripts.script,
    scriptSetup: scripts.scriptSetup,
    template: findBlock(content, 'template'),
  }
}

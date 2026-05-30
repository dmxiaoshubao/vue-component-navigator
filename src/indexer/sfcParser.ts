import path from 'node:path'
import type { ParsedSfc, SfcBlock } from './types'
import { createLineStarts } from '../utils/position'

function findBlock(source: string, tag: 'script' | 'template'): SfcBlock | undefined {
  const tagPattern = new RegExp(`<${tag}\\b[^>]*>|<\\/${tag}>`, 'gi')
  let firstOpenEnd = -1
  let depth = 0
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(source))) {
    const token = match[0]
    const isClose = token.startsWith('</')

    if (!isClose) {
      if (depth === 0) {
        firstOpenEnd = tagPattern.lastIndex
      }
      depth += 1
      continue
    }

    if (depth === 0) {
      continue
    }

    depth -= 1
    if (depth === 0 && firstOpenEnd !== -1) {
      return { content: source.slice(firstOpenEnd, match.index), start: firstOpenEnd, end: match.index }
    }
  }

  return undefined
}

export function parseSfc(uri: string, content: string): ParsedSfc {
  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts: createLineStarts(content),
    script: findBlock(content, 'script'),
    template: findBlock(content, 'template'),
  }
}

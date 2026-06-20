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

function findScriptBlocks(source: string): { script?: SfcBlock, scriptSetup?: SfcBlock } {
  const tagPattern = /<script\b[^>]*>|<\/script>/gi
  let openTag: RegExpExecArray | undefined
  let match: RegExpExecArray | null
  let script: SfcBlock | undefined
  let scriptSetup: SfcBlock | undefined

  while ((match = tagPattern.exec(source))) {
    const token = match[0]
    if (!token.startsWith('</')) {
      openTag = match
      continue
    }

    if (!openTag) {
      continue
    }

    const block = {
      content: source.slice(openTag.index + openTag[0].length, match.index),
      start: openTag.index + openTag[0].length,
      end: match.index,
    }
    if (/\bsetup\b/i.test(openTag[0])) {
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

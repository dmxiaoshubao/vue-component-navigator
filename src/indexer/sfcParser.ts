import path from 'node:path'
import { parse, type SFCBlock as CompilerSfcBlock } from '@vue/compiler-sfc'
import type { ParsedSfc, SfcBlock } from './types'
import { createLineStarts } from '../utils/position'

function toSfcBlock(source: string, block: CompilerSfcBlock | null): SfcBlock | undefined {
  if (!block) {
    return undefined
  }

  const start = block.loc.start.offset
  const end = block.loc.end.offset
  return {
    content: source.slice(start, end),
    start,
    end,
  }
}

export function parseSfc(uri: string, content: string): ParsedSfc {
  const { descriptor } = parse(content, { filename: uri, sourceMap: false })

  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts: createLineStarts(content),
    script: toSfcBlock(content, descriptor.script),
    scriptSetup: toSfcBlock(content, descriptor.scriptSetup),
    template: toSfcBlock(content, descriptor.template),
  }
}

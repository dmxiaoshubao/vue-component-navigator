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

function findRawScriptBlock(source: string, setup: boolean, after: number): SfcBlock | undefined {
  const pattern = /<script\b([^>]*)>/gi
  pattern.lastIndex = after
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    const attrs = match[1] ?? ''
    if (/\bsrc\s*=/i.test(attrs)) {
      continue
    }
    if (/\bsetup\b/i.test(attrs) !== setup) {
      continue
    }

    const start = match.index + match[0].length
    const close = source.indexOf('</script>', start)
    const end = close === -1 ? source.length : close
    return {
      content: source.slice(start, end),
      start,
      end,
    }
  }
  return undefined
}

export function parseSfc(uri: string, content: string): ParsedSfc {
  const { descriptor } = parse(content, { filename: uri, sourceMap: false })
  const script = toSfcBlock(content, descriptor.script)
  const scriptSetup = toSfcBlock(content, descriptor.scriptSetup)
  const templateClose = content.indexOf('</template>')
  const fallbackScriptStart = templateClose === -1 ? content.length : templateClose + '</template>'.length

  return {
    uri,
    fileName: path.basename(uri),
    content,
    lineStarts: createLineStarts(content),
    // 编辑态模板未闭合时 compiler-sfc 可能丢失后续 script，这里兜底保住脚本索引。
    script: script ?? findRawScriptBlock(content, false, fallbackScriptStart),
    scriptSetup: scriptSetup ?? findRawScriptBlock(content, true, fallbackScriptStart),
    template: toSfcBlock(content, descriptor.template),
  }
}

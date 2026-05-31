function maxBacktickRun(value: string): number {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length))
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#|>])/g, '\\$1')
}

function inlineCode(value: string): string {
  const fence = '`'.repeat(Math.max(1, maxBacktickRun(value) + 1))
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${padding}${value}${padding}${fence}`
}

export function markdownCodeBlock(code: string, language = 'js'): string {
  const content = code.trim()
  const fence = '`'.repeat(Math.max(3, maxBacktickRun(content) + 1))
  return `${fence}${language}\n${content}\n${fence}`
}

function splitTypePrefix(text: string): { type?: string, rest: string } {
  const match = /^\{([^}]+)\}\s*(.*)$/.exec(text.trim())
  return match ? { type: match[1], rest: match[2] } : { rest: text.trim() }
}

function formatTag(tag: string, text: string): string {
  const safeTag = escapeMarkdownText(tag)
  const { type, rest } = splitTypePrefix(text)
  if (tag === 'param' || tag === 'arg' || tag === 'argument') {
    const match = /^([^\s-]+)\s*-?\s*(.*)$/.exec(rest)
    if (!match) {
      return `*@${safeTag}*`
    }
    const typeText = type ? ` ${inlineCode(`{${type}}`)}` : ''
    const description = match[2] ? ` — ${escapeMarkdownText(match[2])}` : ''
    return `*@${safeTag}* ${inlineCode(match[1])}${typeText}${description}`
  }

  if (tag === 'returns' || tag === 'return') {
    const typeText = type ? inlineCode(`{${type}}`) : ''
    const description = rest ? `${typeText ? ' — ' : ''}${escapeMarkdownText(rest)}` : ''
    return `*@${safeTag}*${typeText ? ` ${typeText}` : ''}${description}`
  }

  return `*@${safeTag}*${rest ? ` — ${escapeMarkdownText(rest)}` : ''}`
}

export function formatJSDocMarkdown(documentation: string | undefined): string {
  if (!documentation) {
    return ''
  }

  const lines = documentation.split('\n').map((line) => line.trim()).filter(Boolean)
  const blocks: string[] = []
  let currentTag: { tag: string, text: string } | undefined

  for (const line of lines) {
    const tagMatch = /^@(\S+)\s*(.*)$/.exec(line)
    if (tagMatch) {
      if (currentTag) {
        blocks.push(formatTag(currentTag.tag, currentTag.text))
      }
      currentTag = { tag: tagMatch[1], text: tagMatch[2] }
      continue
    }

    if (currentTag) {
      currentTag.text = `${currentTag.text} ${line}`.trim()
    } else {
      blocks.push(escapeMarkdownText(line))
    }
  }

  if (currentTag) {
    blocks.push(formatTag(currentTag.tag, currentTag.text))
  }

  return blocks.join('\n\n')
}

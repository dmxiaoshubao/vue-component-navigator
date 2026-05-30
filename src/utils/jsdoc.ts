function splitTypePrefix(text: string): { type?: string, rest: string } {
  const match = /^\{([^}]+)\}\s*(.*)$/.exec(text.trim())
  return match ? { type: match[1], rest: match[2] } : { rest: text.trim() }
}

function formatTag(tag: string, text: string): string {
  const { type, rest } = splitTypePrefix(text)
  if (tag === 'param' || tag === 'arg' || tag === 'argument') {
    const match = /^([^\s-]+)\s*-?\s*(.*)$/.exec(rest)
    if (!match) {
      return `*@${tag}*`
    }
    const typeText = type ? ` \`{${type}}\`` : ''
    const description = match[2] ? ` — ${match[2]}` : ''
    return `*@${tag}* \`${match[1]}\`${typeText}${description}`
  }

  if (tag === 'returns' || tag === 'return') {
    const typeText = type ? `\`{${type}}\`` : ''
    const description = rest ? `${typeText ? ' — ' : ''}${rest}` : ''
    return `*@${tag}*${typeText ? ` ${typeText}` : ''}${description}`
  }

  return `*@${tag}*${rest ? ` — ${rest}` : ''}`
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
      blocks.push(line)
    }
  }

  if (currentTag) {
    blocks.push(formatTag(currentTag.tag, currentTag.text))
  }

  return blocks.join('\n\n')
}

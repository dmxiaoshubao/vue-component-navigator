export function skipStringCommentOrRegex(content: string, index: number): number | undefined {
  const char = content[index]
  if (char === '\'' || char === '"' || char === '`') {
    return skipQuoted(content, index, char)
  }

  if (content.startsWith('//', index)) {
    const lineEnd = content.indexOf('\n', index + 2)
    return lineEnd === -1 ? content.length : lineEnd
  }

  if (content.startsWith('/*', index)) {
    const commentEnd = content.indexOf('*/', index + 2)
    return commentEnd === -1 ? content.length : commentEnd + 2
  }

  if (char === '/' && isRegexStart(content, index)) {
    return skipRegex(content, index)
  }

  return undefined
}

export function findCodeToken(content: string, token: string, startIndex = 0): number {
  for (let index = startIndex; index < content.length; index += 1) {
    const nextIndex = skipStringCommentOrRegex(content, index)
    if (nextIndex !== undefined) {
      index = nextIndex - 1
      continue
    }

    if (content.startsWith(token, index)) {
      return index
    }
  }

  return -1
}

export function maskNonCode(content: string): string {
  const chars = content.split('')
  let index = 0

  while (index < chars.length) {
    const nextIndex = skipStringCommentOrRegex(content, index)
    if (nextIndex === undefined) {
      index += 1
      continue
    }

    // 保持长度与换行不变，便于后续继续沿用原始 offset。
    for (let cursor = index; cursor < nextIndex; cursor += 1) {
      if (chars[cursor] !== '\n') {
        chars[cursor] = ' '
      }
    }
    index = nextIndex
  }

  return chars.join('')
}

export const skipStringOrComment = skipStringCommentOrRegex
export const maskStringsAndComments = maskNonCode

export function readStringLiteral(content: string, index: number): { value: string, start: number, end: number } | undefined {
  const quote = content[index]
  if (quote !== '\'' && quote !== '"') {
    return undefined
  }

  let cursor = index + 1
  while (cursor < content.length) {
    const char = content[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === quote) {
      return {
        value: content.slice(index + 1, cursor),
        start: index + 1,
        end: cursor,
      }
    }
    cursor += 1
  }

  return undefined
}

function skipQuoted(content: string, index: number, quote: '\'' | '"' | '`'): number {
  let cursor = index + 1
  while (cursor < content.length) {
    const char = content[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === quote) {
      return cursor + 1
    }
    cursor += 1
  }
  return content.length
}

function isRegexStart(content: string, index: number): boolean {
  if (content[index + 1] === '/' || content[index + 1] === '*') {
    return false
  }

  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(content[cursor])) {
    cursor -= 1
  }

  if (cursor < 0) {
    return true
  }

  const previous = content[cursor]
  return '({[=,:;!&|?+-*%^~<>'.includes(previous)
}

function skipRegex(content: string, index: number): number {
  let cursor = index + 1
  let inCharacterClass = false

  while (cursor < content.length) {
    const char = content[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }
    if (char === '[') {
      inCharacterClass = true
      cursor += 1
      continue
    }
    if (char === ']') {
      inCharacterClass = false
      cursor += 1
      continue
    }
    if (char === '/' && !inCharacterClass) {
      cursor += 1
      while (cursor < content.length && /[a-z]/i.test(content[cursor])) {
        cursor += 1
      }
      return cursor
    }
    if (char === '\n') {
      return cursor
    }
    cursor += 1
  }

  return content.length
}

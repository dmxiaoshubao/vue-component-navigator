import type { TextPosition, TextRange, TextSpan } from '../indexer/types'

export function createLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }
  return starts
}

export function offsetToPosition(lineStarts: number[], offset: number): TextPosition {
  let low = 0
  let high = lineStarts.length - 1

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lineStarts[mid] <= offset) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const line = Math.max(0, high)
  return { line, character: offset - lineStarts[line] }
}

export function positionToOffset(lineStarts: number[], position: TextPosition): number {
  const lineStart = lineStarts[position.line]
  if (lineStart === undefined) {
    return lineStarts[lineStarts.length - 1]
  }
  return lineStart + position.character
}

export function spanToRange(lineStarts: number[], span: TextSpan): TextRange {
  return {
    start: offsetToPosition(lineStarts, span.start),
    end: offsetToPosition(lineStarts, span.end),
  }
}

export function containsOffset(span: TextSpan, offset: number): boolean {
  return offset >= span.start && offset <= span.end
}

export function containsOffsetStrict(span: TextSpan, offset: number): boolean {
  return offset >= span.start && offset < span.end
}

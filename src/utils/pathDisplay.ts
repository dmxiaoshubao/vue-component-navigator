import path from 'node:path'

const MAX_LABEL_LENGTH = 52

export function commonDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return ''
  }

  const parts = path.dirname(paths[0]).split(path.sep)
  for (const file of paths.slice(1)) {
    const current = path.dirname(file).split(path.sep)
    while (parts.length > 0 && current.slice(0, parts.length).join(path.sep) !== parts.join(path.sep)) {
      parts.pop()
    }
  }
  return parts.join(path.sep)
}

export function relativePath(file: string, baseDirectory: string): string {
  return baseDirectory ? path.relative(baseDirectory, file) : file
}

export function compactPathLabel(relativeFile: string, maxLength = MAX_LABEL_LENGTH): string {
  if (relativeFile.length <= maxLength) {
    return relativeFile
  }

  const parts = relativeFile.split(path.sep)
  if (parts.length <= 2) {
    return `...${relativeFile.slice(-maxLength + 3)}`
  }

  const first = parts[0]
  const last = parts[parts.length - 1]
  let label = `${first}${path.sep}...${path.sep}${last}`
  for (let index = parts.length - 2; index > 0 && label.length < maxLength; index -= 1) {
    const next = `${first}${path.sep}...${path.sep}${parts.slice(index).join(path.sep)}`
    if (next.length > maxLength) {
      break
    }
    label = next
  }
  return label
}

export function shortestUniquePathLabels(files: string[], baseDirectory: string): Map<string, string> {
  const relativeFiles = files.map((file) => relativePath(file, baseDirectory))
  const labels = new Map<string, string>()

  for (let index = 0; index < files.length; index += 1) {
    const relativeFile = relativeFiles[index]
    const parts = relativeFile.split(path.sep)

    for (let length = 1; length <= parts.length; length += 1) {
      const candidate = parts.slice(parts.length - length).join(path.sep)
      const duplicate = relativeFiles.some((other, otherIndex) => {
        if (otherIndex === index) {
          return false
        }
        return other.endsWith(candidate)
      })
      if (!duplicate) {
        labels.set(files[index], compactPathLabel(candidate))
        break
      }
    }

    if (!labels.has(files[index])) {
      labels.set(files[index], compactPathLabel(relativeFile))
    }
  }

  return labels
}

export function usagePathLabels(files: string[], baseDirectory: string): Map<string, string> {
  const commonPrefix = commonPathPrefix(files.map((file) => relativePath(file, baseDirectory)))
  const withoutPrefix = files.map((file) => {
    const relativeFile = relativePath(file, baseDirectory)
    return commonPrefix ? relativeFile.slice(commonPrefix.length) : relativeFile
  })
  const labels = new Map<string, string>()

  for (let index = 0; index < files.length; index += 1) {
    const parts = withoutPrefix[index].split(path.sep).filter(Boolean)

    for (let length = 1; length <= parts.length; length += 1) {
      const candidate = parts.slice(parts.length - length).join(path.sep)
      const duplicate = withoutPrefix.some((other, otherIndex) => {
        if (otherIndex === index) {
          return false
        }
        return other.endsWith(candidate)
      })
      if (!duplicate) {
        labels.set(files[index], compactPathLabel(candidate))
        break
      }
    }

    if (!labels.has(files[index])) {
      labels.set(files[index], compactPathLabel(withoutPrefix[index] || relativePath(files[index], baseDirectory)))
    }
  }

  return labels
}

function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return ''
  }

  const splitPaths = paths.map((file) => file.split(path.sep))
  const prefix: string[] = []
  for (let index = 0; index < splitPaths[0].length - 1; index += 1) {
    const part = splitPaths[0][index]
    if (splitPaths.every((items) => items[index] === part)) {
      prefix.push(part)
      continue
    }
    break
  }

  return prefix.length > 0 ? `${prefix.join(path.sep)}${path.sep}` : ''
}

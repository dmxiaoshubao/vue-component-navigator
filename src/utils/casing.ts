export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

export function toCamelCase(value: string): string {
  return value.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}

export function normalizeComponentName(value: string): string {
  return toKebabCase(value).replace(/-/g, '')
}

export function matchesName(a: string, b: string): boolean {
  return a === b || toKebabCase(a) === toKebabCase(b) || toCamelCase(a) === toCamelCase(b)
}

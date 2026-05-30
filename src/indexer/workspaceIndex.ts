import fs from 'node:fs/promises'
import path from 'node:path'
import type { RefMethodAccess, TextSpan, VueFileIndex } from './types'
import { parseSfc } from './sfcParser'
import { parseScript } from './scriptParser'
import { parseTemplate } from './templateParser'
import { positionToOffset } from '../utils/position'
import { toKebabCase } from '../utils/casing'

export class WorkspaceIndex {
  private readonly files = new Map<string, VueFileIndex>()
  private readonly workspaceRoots: string[] = []

  getFileCount(): number {
    return this.files.size
  }

  getIndexedUris(): string[] {
    return [...this.files.keys()]
  }

  getFile(uri: string): VueFileIndex | undefined {
    return this.files.get(uri)
  }

  getAllFiles(): VueFileIndex[] {
    return [...this.files.values()]
  }

  indexContent(uri: string, content: string): VueFileIndex {
    const sfc = parseSfc(uri, content)
    const scriptIndex = sfc.script
      ? parseScript(uri, sfc.script.content, sfc.script.start, this.workspaceRoots)
      : { imports: [], components: [], props: [], methods: [], emits: [] }
    const registeredTags = scriptIndex.components.flatMap((component) => [component.tag, component.localName, toKebabCase(component.tag), toKebabCase(component.localName)])
    const templateIndex = sfc.template
      ? parseTemplate(sfc.template.content, sfc.template.start, registeredTags)
      : { components: [] }

    const file: VueFileIndex = {
      uri,
      fileName: sfc.fileName,
      content: sfc.content,
      lineStarts: sfc.lineStarts,
      script: sfc.script,
      template: sfc.template,
      scriptIndex,
      templateIndex,
    }
    this.files.set(uri, file)
    return file
  }

  syncContent(uri: string, content: string): VueFileIndex {
    const current = this.files.get(uri)
    if (current?.content === content) {
      return current
    }
    return this.indexContent(uri, content)
  }

  remove(uri: string): void {
    this.files.delete(uri)
  }

  async indexFile(uri: string): Promise<VueFileIndex> {
    return this.indexContent(uri, await fs.readFile(uri, 'utf8'))
  }

  async indexWorkspace(root: string): Promise<void> {
    if (!this.workspaceRoots.includes(root)) {
      this.workspaceRoots.push(root)
    }
    const vueFiles = await findVueFiles(root)
    for (const file of vueFiles) {
      await this.indexFile(file)
    }
  }

  offsetAt(uri: string, line: number, character: number): number | undefined {
    const file = this.getFile(uri)
    if (!file) {
      return undefined
    }
    return positionToOffset(file.lineStarts, { line, character })
  }
}

async function findVueFiles(root: string): Promise<string[]> {
  const results: string[] = []
  const ignored = new Set(['node_modules', '.git', 'dist', 'out'])

  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          await walk(fullPath)
        }
        return
      }
      if (entry.isFile() && entry.name.endsWith('.vue')) {
        results.push(fullPath)
      }
    }))
  }

  await walk(root)
  return results
}

export function findRefMethodAccess(content: string, offset: number): RefMethodAccess | undefined {
  const pattern = /this\.\$refs(?:\.|\?\.)([A-Za-z_$][\w$]*)(?:\.|\?\.)([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content))) {
    const [, refName, methodName] = match
    const methodStart = match.index + match[0].lastIndexOf(methodName)
    const methodSpan: TextSpan = { start: methodStart, end: methodStart + methodName.length }
    if (offset >= methodSpan.start && offset <= methodSpan.end) {
      return { refName, methodName, methodSpan }
    }
  }

  return undefined
}

export interface RefCompletionContext {
  refName: string
  accessToken: '.' | '?.'
  partialMethodName: string
}

export function findRefCompletionContext(content: string, offset: number): RefCompletionContext | undefined {
  const prefix = content.slice(Math.max(0, offset - 160), offset)
  const match = /this\.\$refs(?:\.|\?\.)([A-Za-z_$][\w$]*)(\.|\?\.)([A-Za-z_$][\w$]*)?$/.exec(prefix)
  if (!match) {
    return undefined
  }
  return {
    refName: match[1],
    accessToken: match[2] === '?.' ? '?.' : '.',
    partialMethodName: match[3] ?? '',
  }
}

export function findSpanAtOffset(spans: Array<{ span: TextSpan }>, offset: number): TextSpan | undefined {
  return spans.find((item) => offset >= item.span.start && offset <= item.span.end)?.span
}

export function fileNameToComponentName(fileName: string): string {
  return path.basename(fileName, path.extname(fileName))
}

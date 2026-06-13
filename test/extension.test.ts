import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeMock'))

class TestDocument {
  uri: { fsPath: string, scheme: string }
  languageId = 'vue'

  constructor(public filePath: string, private readonly content: string) {
    this.uri = { fsPath: filePath, scheme: 'file' }
  }

  getText(): string {
    return this.content
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function writeVue(filePath: string, name: string): void {
  fs.writeFileSync(filePath, `<template><div /></template>\n<script>export default { name: '${name}' }</script>\n`)
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writePackageJson(root: string, vueVersion = '^2.7.16'): void {
  writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: vueVersion } }))
}

describe('Extension lifecycle indexing', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reindex 时没有 Vue 2 package 会禁用索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-reindex-'))
    const keepFile = path.join(root, 'Keep.vue')
    writePackageJson(root)
    writeVue(keepFile, 'Keep')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    vscode.window.activeTextEditor = { document: new TestDocument(keepFile, fs.readFileSync(keepFile, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')

    const vue3Root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-'))
    writePackageJson(vue3Root, '^3.4.0')
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(vue3Root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.informationMessages.at(-2)).toContain('no Vue 2 dependency')
    expect(vscode.informationMessages.at(-1)).toContain('Vue 2 package detected: no')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: no')
  })

  it('rename 和未保存 change 会同步索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-events-'))
    const oldFile = path.join(root, 'Old.vue')
    const newFile = path.join(root, 'New.vue')
    writePackageJson(root)
    writeVue(oldFile, 'Old')
    writeVue(newFile, 'New')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    const renameListener = vscode.renameListeners.find((listener) => typeof listener === 'function')
    expect(renameListener).toBeDefined()
    await renameListener!({ files: [{ oldUri: vscode.Uri.file(oldFile), newUri: vscode.Uri.file(newFile) }] })
    vscode.window.activeTextEditor = { document: new TestDocument(oldFile, fs.readFileSync(oldFile, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: no')

    const changed = fs.readFileSync(newFile, 'utf8').replace('New', 'Changed')
    vscode.changeTextListeners[0]({ document: new TestDocument(newFile, changed) })
    vscode.window.activeTextEditor = { document: new TestDocument(newFile, changed) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('Show usages 命令可以打开 prop 使用位置', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-usages-'))
    const childFile = path.join(root, 'Child.vue')
    const parentFile = path.join(root, 'Parent.vue')
    writePackageJson(root)
    writeText(childFile, `
<template><div /></template>
<script>
export default {
  props: {
    title: String,
  },
}
</script>
`)
    writeText(parentFile, `
<template>
  <Child :title="title" />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`)
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    await vscode.registeredCommands.get('vueComponentNavigator.showUsages')?.({
      kind: 'prop-usages',
      childUri: childFile,
      propName: 'title',
    })

    expect(vscode.quickPickCalls.at(-1)?.items[0].label).toContain('Parent.vue')
    expect(vscode.shownDocuments.at(-1)?.uri.fsPath).toBe(parentFile)
  })

  it('非 Vue 2 workspace 不注册 provider 且不索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-disabled-'))
    const file = path.join(root, 'App.vue')
    writePackageJson(root, '^3.4.0')
    writeVue(file, 'App')
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.providerRegistrations).toEqual([])
    expect(vscode.informationMessages.at(-2)).toContain('no Vue 2 dependency')
    expect(vscode.informationMessages.at(-1)).toContain('Vue 2 package detected: no')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: no')
  })

  it('Vue 2 package 版本识别只接受 2.x 范围', async () => {
    const { isVue2Version, normalizeEntryConfig, packageHasVue2 } = await import('../src/extension')

    expect(isVue2Version('^2.7.16')).toBe(true)
    expect(isVue2Version('2.x')).toBe(true)
    expect(isVue2Version('>=2.6.0 <3')).toBe(true)
    expect(isVue2Version('^3.4.0')).toBe(false)
    expect(isVue2Version('latest')).toBe(false)
    expect(packageHasVue2({ devDependencies: { vue: '~2.6.14' } })).toBe(true)
    expect(normalizeEntryConfig(' src/entry.js ')).toEqual(['src/entry.js'])
    expect(normalizeEntryConfig(['src/main.js', '', 'src/main.js', '@/bootstrap'])).toEqual(['src/main.js', '@/bootstrap'])
  })
})

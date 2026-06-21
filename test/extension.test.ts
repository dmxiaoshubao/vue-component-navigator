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

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-no-vue-'))
    writeText(path.join(emptyRoot, 'package.json'), JSON.stringify({ dependencies: {} }))
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(emptyRoot) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.informationMessages.at(-2)).toContain('no supported Vue 2 or Vue 3 dependency')
    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: no')
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

  it('Show usages 命令在单个组件使用位置时直接打开引用', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-component-usages-'))
    const childFile = path.join(root, 'Child.vue')
    const parentFile = path.join(root, 'Parent.vue')
    writePackageJson(root)
    writeText(childFile, `
<template><div /></template>
<script>
export default { name: 'Child' }
</script>
`)
    writeText(parentFile, `
<template>
  <Child />
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
      kind: 'component-usages',
      childUri: childFile,
    })

    expect(vscode.quickPickCalls).toHaveLength(0)
    expect(vscode.shownDocuments.at(-1)?.uri.fsPath).toBe(parentFile)
  })

  it('Show usages 命令在多个组件使用位置时保留选择列表', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-component-usages-many-'))
    const childFile = path.join(root, 'Child.vue')
    const firstParentFile = path.join(root, 'ParentA.vue')
    const secondParentFile = path.join(root, 'ParentB.vue')
    writePackageJson(root)
    writeText(childFile, `
<template><div /></template>
<script>
export default { name: 'Child' }
</script>
`)
    writeText(firstParentFile, `
<template>
  <Child />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`)
    writeText(secondParentFile, `
<template>
  <Child />
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
      kind: 'component-usages',
      childUri: childFile,
    })

    const items = vscode.quickPickCalls.at(-1)?.items ?? []
    expect(items).toHaveLength(2)
    expect(items.map((item: any) => item.label)).toEqual(expect.arrayContaining([
      expect.stringContaining('ParentA.vue'),
      expect.stringContaining('ParentB.vue'),
    ]))
    expect([firstParentFile, secondParentFile]).toContain(vscode.shownDocuments.at(-1)?.uri.fsPath)
  })

  it('保存 jsconfig 后会清理别名缓存并重建入口索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-jsconfig-refresh-'))
    const jsconfigPath = path.join(root, 'jsconfig.json')
    const listenerFile = path.join(root, 'Listener.vue')
    const emitterFile = path.join(root, 'Emitter.vue')
    writePackageJson(root)
    vscode.configurationValues.set('vueComponentNavigator.entry', '@/entry')
    writeText(jsconfigPath, JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
        },
      },
    }))
    writeText(path.join(root, 'src/entry.js'), `
import Vue from 'vue'
Vue.prototype.$oldBus = new Vue()
`)
    writeText(path.join(root, 'app/entry.js'), `
import Vue from 'vue'
Vue.prototype.$newBus = new Vue()
`)
    writeText(listenerFile, `
<script>
export default {
  mounted() {
    this.$newBus.$on('refresh', () => {})
  },
}
</script>
`)
    writeText(emitterFile, `
<script>
export default {
  mounted() {
    this.$newBus.$emit('refresh')
  },
}
</script>
`)
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    writeText(jsconfigPath, JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['app/*'],
        },
      },
    }))
    const configDocument = new TestDocument(jsconfigPath, fs.readFileSync(jsconfigPath, 'utf8'))
    configDocument.languageId = 'json'
    await vscode.saveListeners[0](configDocument)

    await vscode.registeredCommands.get('vueComponentNavigator.showUsages')?.({
      kind: 'event-bus-listeners',
      busName: '$newBus',
      eventName: 'refresh',
    })

    expect(vscode.quickPickCalls.at(-1)?.items[0].label).toContain('Listener.vue')
    expect(vscode.shownDocuments.at(-1)?.uri.fsPath).toBe(listenerFile)
  })

  it('Vue 3 workspace 会注册 provider 且索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-enabled-'))
    const file = path.join(root, 'App.vue')
    writePackageJson(root, '^3.4.0')
    writeVue(file, 'App')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.providerRegistrations.length).toBeGreaterThan(0)
    expect(vscode.providerRegistrations).toContain('inlayHint')
    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: yes')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('Vue package 版本识别支持 2.x 和 3.x 范围', async () => {
    const { isVue2Version, isVue3Version, normalizeEntryConfig, packageHasSupportedVue, packageHasVue2, packageVueVersion } = await import('../src/extension')

    expect(isVue2Version('^2.7.16')).toBe(true)
    expect(isVue2Version('2.x')).toBe(true)
    expect(isVue2Version('>=2.6.0 <3')).toBe(true)
    expect(isVue2Version('^3.4.0')).toBe(false)
    expect(isVue2Version('latest')).toBe(false)
    expect(isVue3Version('^3.4.0')).toBe(true)
    expect(isVue3Version('3.x')).toBe(true)
    expect(isVue3Version('^2.7.16')).toBe(false)
    expect(packageHasVue2({ devDependencies: { vue: '~2.6.14' } })).toBe(true)
    expect(packageVueVersion({ dependencies: { vue: '^3.4.0' } })).toBe(3)
    expect(packageHasSupportedVue({ dependencies: { vue: '^3.4.0' } })).toBe(true)
    expect(normalizeEntryConfig(' src/entry.js ')).toEqual(['src/entry.js'])
    expect(normalizeEntryConfig(['src/main.js', '', 'src/main.js', '@/bootstrap'])).toEqual(['src/main.js', '@/bootstrap'])
  })
})

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

async function fireListeners<T>(listeners: Array<(event: T) => any>, event: T): Promise<void> {
  for (const listener of [...listeners]) {
    await listener(event)
  }
}

describe('Extension lifecycle indexing', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('从 VS Code 共享 node_modules 加载 TypeScript runtime', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const extensionRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vscode-ts-')), 'typescript-language-features')
    const runtimePath = path.join(extensionRoot, '../node_modules/typescript/lib/typescript.js')
    writeText(runtimePath, `
module.exports = {
  version: 'fake-vscode-typescript',
  createSourceFile() {},
}
`)
    vscode.extensionValues.set('vscode.typescript-language-features', { extensionPath: extensionRoot })

    const runtime = await import('../src/utils/typescriptRuntime')

    expect(runtime.vscodeTypeScriptRuntimeCandidates(extensionRoot)).toContain('../node_modules/typescript/lib/typescript.js')
    expect((runtime.loadTypeScript() as any).version).toBe('fake-vscode-typescript')
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

    await fireListeners(vscode.renameListeners, { files: [{ oldUri: vscode.Uri.file(oldFile), newUri: vscode.Uri.file(newFile) }] })
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
    await fireListeners(vscode.saveListeners, configDocument)

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
    expect(vscode.providerRegistrations).toContain('codeLens')
    expect(vscode.providerRegistrations).not.toContain('inlayHint')
    expect(vscode.providerSelectors.flat().map((selector: any) => selector.language)).toContain('typescriptreact')
    expect(vscode.providerSelectors.flat().map((selector: any) => selector.language)).toContain('javascriptreact')
    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: yes')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('根 package 无 Vue 时会识别 monorepo 子包 Vue 项目', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-monorepo-vue-package-'))
    const appRoot = path.join(root, 'packages/app')
    const file = path.join(appRoot, 'src/App.vue')
    writeText(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }))
    writeText(path.join(appRoot, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(file, '<template><div /></template><script setup lang="ts"></script>')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: yes')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('启动时无 Vue，保存 package.json 加 Vue 后会自动启用并索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-package-save-enable-'))
    const file = path.join(root, 'src/App.vue')
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    writeText(file, '<template><div /></template><script setup lang="ts"></script>')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]

    writePackageJson(root, '^3.5.0')
    const packageDocument = new TestDocument(path.join(root, 'package.json'), fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    packageDocument.languageId = 'json'
    await fireListeners(vscode.saveListeners, packageDocument)

    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.providerRegistrations).toContain('definition')
    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: yes')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('保存 package.json 移除 Vue 依赖后会禁用并清空索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-package-save-disable-'))
    const file = path.join(root, 'src/App.vue')
    writePackageJson(root, '^3.5.0')
    writeText(file, '<template><div /></template><script setup lang="ts"></script>')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    const packageDocument = new TestDocument(path.join(root, 'package.json'), fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    packageDocument.languageId = 'json'
    await fireListeners(vscode.saveListeners, packageDocument)

    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.informationMessages.at(-1)).toContain('Supported Vue package detected: no')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: no')
  })

  it('根 package 有 Vue 时仍会按子包 Vue 版本索引 monorepo', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-monorepo-nested-vue-version-'))
    const appRoot = path.join(root, 'packages/app')
    const childFile = path.join(appRoot, 'src/Child.vue')
    const parentFile = path.join(appRoot, 'src/Parent.vue')
    writePackageJson(root, '^2.7.16')
    writePackageJson(appRoot, '^3.5.0')
    writeText(childFile, `
<template><div /></template>
<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>
`)
    writeText(parentFile, `
<template>
  <Child title="nested" />
</template>
<script setup lang="ts">
import Child from './Child.vue'
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

  it('保存 package 从 Vue2 改 Vue3 后会按新 runtime 重建索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-package-save-runtime-'))
    const childFile = path.join(root, 'src/Child.vue')
    const parentFile = path.join(root, 'src/Parent.vue')
    writePackageJson(root, '^2.7.16')
    writeText(childFile, `
<template><div /></template>
<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>
`)
    writeText(parentFile, `
<template>
  <Child title="root" />
</template>
<script setup lang="ts">
import Child from './Child.vue'
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
    expect(vscode.quickPickCalls).toHaveLength(0)

    writePackageJson(root, '^3.5.0')
    const packageDocument = new TestDocument(path.join(root, 'package.json'), fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    packageDocument.languageId = 'json'
    await fireListeners(vscode.saveListeners, packageDocument)
    await vscode.registeredCommands.get('vueComponentNavigator.showUsages')?.({
      kind: 'prop-usages',
      childUri: childFile,
      propName: 'title',
    })

    expect(vscode.quickPickCalls.at(-1)?.items[0].label).toContain('Parent.vue')
    expect(vscode.shownDocuments.at(-1)?.uri.fsPath).toBe(parentFile)
  })

  it('创建和删除子包 package.json 会重建 runtime roots', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-package-create-delete-'))
    const appRoot = path.join(root, 'packages/app')
    const packagePath = path.join(appRoot, 'package.json')
    const childFile = path.join(appRoot, 'src/Child.vue')
    const parentFile = path.join(appRoot, 'src/Parent.vue')
    writePackageJson(root, '^2.7.16')
    writeText(childFile, `
<template><div /></template>
<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>
`)
    writeText(parentFile, `
<template>
  <Child title="nested" />
</template>
<script setup lang="ts">
import Child from './Child.vue'
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
    expect(vscode.quickPickCalls).toHaveLength(0)

    writePackageJson(appRoot, '^3.5.0')
    await fireListeners(vscode.createListeners, { files: [vscode.Uri.file(packagePath)] })
    await vscode.registeredCommands.get('vueComponentNavigator.showUsages')?.({
      kind: 'prop-usages',
      childUri: childFile,
      propName: 'title',
    })
    expect(vscode.quickPickCalls.at(-1)?.items[0].label).toContain('Parent.vue')

    fs.unlinkSync(packagePath)
    const quickPickCount = vscode.quickPickCalls.length
    await fireListeners(vscode.deleteListeners, { files: [vscode.Uri.file(packagePath)] })
    await vscode.registeredCommands.get('vueComponentNavigator.showUsages')?.({
      kind: 'prop-usages',
      childUri: childFile,
      propName: 'title',
    })

    expect(vscode.quickPickCalls).toHaveLength(quickPickCount)
  })

  it('重命名为 package.json 后会自动启用 Vue workspace', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-package-rename-enable-'))
    const file = path.join(root, 'src/App.vue')
    const oldPackagePath = path.join(root, 'package.tmp')
    const newPackagePath = path.join(root, 'package.json')
    writeText(oldPackagePath, JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(file, '<template><div /></template><script setup lang="ts"></script>')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]

    fs.renameSync(oldPackagePath, newPackagePath)
    await fireListeners(vscode.renameListeners, { files: [{ oldUri: vscode.Uri.file(oldPackagePath), newUri: vscode.Uri.file(newPackagePath) }] })
    vscode.window.activeTextEditor = { document: new TestDocument(file, fs.readFileSync(file, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

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

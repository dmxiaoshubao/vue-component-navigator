import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeMock'))

const fixtureRoot = path.resolve(__dirname, './fixtures/vue2-basic')

class TestDocument {
  uri: { fsPath: string, scheme: string }

  constructor(public filePath: string, private readonly content: string, public languageId = 'vue') {
    this.uri = { fsPath: filePath, scheme: 'file' }
  }

  getText(): string {
    return this.content
  }

  lineAt(line: number): { text: string } {
    return { text: this.content.split(/\r?\n/)[line] ?? '' }
  }
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8')
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writeElementUiTypes(root: string): void {
  writeText(path.join(root, 'node_modules/element-ui/types/component.d.ts'), `
import Vue from 'vue'
export declare class ElementUIComponent extends Vue {}
`)
  writeText(path.join(root, 'node_modules/element-ui/types/form.d.ts'), `
import { ElementUIComponent } from './component'

/** Form Component */
export declare class ElForm extends ElementUIComponent {
  /**
   * Validate the whole form
   */
  validate (): Promise<boolean>

  /** reset all the fields and remove validation result */
  resetFields (): void

  /** clear validation message for certain fields */
  clearValidate (props?: string | string[]): void
}
`)
  writeText(path.join(root, 'node_modules/element-ui/types/input.d.ts'), `
import { ElementUIComponent } from './component'

/** Input Component */
export declare class ElInput extends ElementUIComponent {
  /**
   * Focus the Input component
   */
  focus (): void

  /**
   * Blur the Input component
   */
  blur (): void

  /**
   * Select the text in input element
   */
  select (): void
}
`)
}

function writeVantTypes(root: string): void {
  writeText(path.join(root, 'node_modules/vant/types/component.d.ts'), `
import Vue from 'vue';
export class VanComponent extends Vue {}
`)
  writeText(path.join(root, 'node_modules/vant/types/field.d.ts'), `
import { VanComponent } from './component';

export class Field extends VanComponent {
  focus(): void;

  blur(): void;
}
`)
  writeText(path.join(root, 'node_modules/vant/types/form.d.ts'), `
import { VanComponent } from './component';

export class Form extends VanComponent {
  submit(): void;

  validate(name?: string | string[]): Promise<void>;

  resetValidation(name?: string | string[]): void;

  scrollToField(name: string, options?: boolean | ScrollIntoViewOptions): void;
}
`)
}

function positionAt(content: string, offset: number): any {
  const before = content.slice(0, offset).split('\n')
  return { line: before.length - 1, character: before[before.length - 1].length }
}

function markdownText(value: any): string {
  return typeof value === 'string' ? value : value.value
}

function hoverText(hover: any): string {
  return markdownText(hover.contents)
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : value ? [value] : []
}

describe('Vue providers', () => {
  let WorkspaceIndex: typeof import('../src/indexer/workspaceIndex').WorkspaceIndex
  let VueDefinitionProvider: typeof import('../src/providers/definitionProvider').VueDefinitionProvider
  let VueCompletionProvider: typeof import('../src/providers/completionProvider').VueCompletionProvider
  let VueHoverProvider: typeof import('../src/providers/hoverProvider').VueHoverProvider
  let VueCodeLensProvider: typeof import('../src/providers/codeLensProvider').VueCodeLensProvider
  let VueReferenceProvider: typeof import('../src/providers/referenceProvider').VueReferenceProvider
  let index: import('../src/indexer/workspaceIndex').WorkspaceIndex

  beforeEach(async () => {
    ;({ WorkspaceIndex } = await import('../src/indexer/workspaceIndex'))
    ;({ VueDefinitionProvider } = await import('../src/providers/definitionProvider'))
    ;({ VueCompletionProvider } = await import('../src/providers/completionProvider'))
    ;({ VueHoverProvider } = await import('../src/providers/hoverProvider'))
    ;({ VueCodeLensProvider } = await import('../src/providers/codeLensProvider'))
    ;({ VueReferenceProvider } = await import('../src/providers/referenceProvider'))
    index = new WorkspaceIndex()
    await index.indexWorkspace(fixtureRoot)
  })

  it('命令式组件导出对象的方法会展示独立 usage hover', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-command-method-hover-'))
    const dialogUri = path.join(root, 'src/Dialog.vue')
    const commandUri = path.join(root, 'src/command.ts')
    const consumerUri = path.join(root, 'src/consumer.ts')
    const commandContent = `
import { createApp, h } from 'vue'
import DialogView from './Dialog.vue'
const confirmHandler = () => createApp({ render: () => h(DialogView) })
const Dialog = { instance: null, options: {}, confirm: confirmHandler, alert() {} }
export default Dialog
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(dialogUri, '<template><div /></template>')
    writeText(commandUri, commandContent)
    writeText(consumerUri, "import Dialog from './command'\nDialog.confirm()\nDialog.alert()\nDialog.notExists()\n")

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const hoverProvider = new VueHoverProvider(localIndex)
    const document = new TestDocument(commandUri, commandContent, 'typescript') as any
    const hover = hoverProvider.provideHover(document, positionAt(commandContent, commandContent.indexOf('confirm:') + 1)) as any

    expect(hoverText(hover)).toContain('Used by 1 usage')
    expect(hoverText(hover)).toContain('consumer.ts:2')
    expect(hoverText(hover)).not.toContain('(command component method)')
    expect(hoverText(hover)).not.toContain('Dialog.vue')
    expect(localIndex.findCommandComponentMethodUsages(commandUri, 'alert')).toHaveLength(1)
    expect(localIndex.findCommandComponentMethodUsages(commandUri, 'notExists')).toEqual([])
    expect(localIndex.findCommandComponentMethodAtOffset(commandUri, commandContent.indexOf('instance') + 1)).toBeUndefined()
    expect(localIndex.findCommandComponentMethodAtOffset(commandUri, commandContent.indexOf('options') + 1)).toBeUndefined()
  })

  it('Vue2 命令式组件脚本的方法也会展示精简 usage hover', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue2-command-method-hover-'))
    const dialogUri = path.join(root, 'src/Dialog.vue')
    const commandUri = path.join(root, 'src/index.js')
    const consumerUri = path.join(root, 'src/consumer.js')
    const commandContent = `
import Vue from 'vue'
import DialogView from './Dialog.vue'
export default {
  open() {
    const VM = Vue.extend({ render: () => <DialogView /> })
    return new VM()
  },
}
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^2.7.0' } }))
    writeText(dialogUri, '<template><div /></template>')
    writeText(commandUri, commandContent)
    writeText(consumerUri, "import Dialog from './index'\nDialog.open()\n")

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 2)
    const hoverProvider = new VueHoverProvider(localIndex)
    const document = new TestDocument(commandUri, commandContent, 'javascript') as any
    const hover = hoverProvider.provideHover(document, positionAt(commandContent, commandContent.indexOf('open()') + 1)) as any

    expect(hoverText(hover)).toContain('Used by 1 usage')
    expect(hoverText(hover)).toContain('consumer.js:2')
    expect(hoverText(hover)).not.toContain('Dialog.vue')
  })

  it('$refs 方法定义跳转、补全、悬浮可用', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const openOffset = content.indexOf('open()') + 1
    const provider = new VueDefinitionProvider(index)
    const completionProvider = new VueCompletionProvider(index)
    const hoverProvider = new VueHoverProvider(index)

    const definition = provider.provideDefinition(document, positionAt(content, openOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(content, content.indexOf('this.$refs.child.') + 'this.$refs.child.'.length)) as any[]
    const hover = hoverProvider.provideHover(document, positionAt(content, openOffset)) as any

    expect(definition.uri.fsPath.endsWith('Child.vue')).toBe(true)
    expect(completions.map((item) => item.label)).toEqual(['open', 'close', 'load', 'notify'])
    expect(completions.every((item) => item.preselect === true)).toBe(true)
    expect(completions.every((item) => item.sortText?.startsWith('\u0000\u0000'))).toBe(true)
    expect(completions.find((item) => item.label === 'open')?.insertText).toBe('.open')
    expect(completions.find((item) => item.label === 'open')?.filterText).toBe('.open')
    expect(hoverText(hover).startsWith('*@description* — Open child dialog.')).toBe(true)
    expect(hoverText(hover)).toContain('*@param* `source` `{string}` — trigger source')
    expect(markdownText(completions.find((item) => item.label === 'open')?.documentation)).toContain('*@param* `source` `{string}` — trigger source')
    expect(hoverText(hover)).toContain('open(source)')
    expect(hoverText(hover)).not.toContain('open(source) {')
    expect(hoverText(hover)).not.toContain('Child.methods.open')
    expect(hoverText(hover)).toContain('Definition: [Child.vue:21]')
    expect(hoverText(hover)).toContain('file://')
    expect(hover.contents.isTrusted).toBe(false)
  })

  it('provider 不会把 workspace 外 Vue 文件同步进索引', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-outside-workspace-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-outside-file-'))
    const outsideUri = path.join(outsideRoot, 'Outside.vue')
    const content = `
<template><div /></template>
<script>
export default { props: { title: String } }
</script>
`
    localIndex.setWorkspaceVueVersion(root, 2)

    const document = new TestDocument(outsideUri, content) as any
    const provider = new VueDefinitionProvider(localIndex)

    expect(provider.provideDefinition(document, positionAt(content, content.indexOf('title') + 1))).toBeUndefined()
    expect(localIndex.getFile(outsideUri)).toBeUndefined()
  })

  it('provider 在没有 workspace root 时不会同步 Vue 文件', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-empty-roots-'))
    const uri = path.join(root, 'Loose.vue')
    const content = `
<template><div /></template>
<script>
export default { props: { title: String } }
</script>
`
    const document = new TestDocument(uri, content) as any
    const provider = new VueDefinitionProvider(localIndex)

    expect(provider.provideDefinition(document, positionAt(content, content.indexOf('title') + 1))).toBeUndefined()
    expect(localIndex.getFile(uri)).toBeUndefined()
  })

  it('Vue2 普通静态 ref 不会仅凭 import 解析未注册组件', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-unregistered-static-ref-'))
    const childUri = path.join(root, 'src/UnregisteredChild.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<template><div /></template>
<script>
export default {
  methods: {
    open() {},
  },
}
</script>
`
    const parentContent = `
<template>
  <UnregisteredChild ref="child" />
</template>
<script>
import UnregisteredChild from './UnregisteredChild.vue'

export default {
  methods: {
    callChild() {
      this.$refs.child.open()
    },
  },
}
</script>
`
    localIndex.setWorkspaceVueVersion(root, 2)
    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(parentUri, parentContent)
    const document = new TestDocument(parentUri, parentContent) as any
    const provider = new VueDefinitionProvider(localIndex)

    expect(provider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('open()') + 1))).toBeUndefined()
  })

  it('非 Vue 源文件未保存内容会同步刷新 Vue3 反向关系', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-unsaved-ts-source-'))
    const hookUri = path.join(root, 'src/hooks/use-verify.ts')
    const pageUri = path.join(root, 'src/Page.vue')
    const initialHookContent = `
export function useVerify() {
  return {}
}
`
    const nextHookContent = `
export function useVerify() {
  const runVerifyWithCode = () => true
  return { runVerifyWithCode }
}
`
    const pageContent = `
<template><div /></template>
<script setup lang="ts">
import { useVerify } from './hooks/use-verify'
const { runVerifyWithCode } = useVerify()
runVerifyWithCode()
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(hookUri, initialHookContent)
    writeText(pageUri, pageContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hookDocument = new TestDocument(hookUri, nextHookContent, 'typescript') as any

    const references = referenceProvider.provideReferences(
      hookDocument,
      positionAt(nextHookContent, nextHookContent.indexOf('runVerifyWithCode =') + 1),
    ) as any[]

    expect(references).toHaveLength(2)
    expect(references.every((reference) => reference.uri.fsPath === pageUri)).toBe(true)
  })

  it('普通 JS/TS 没有补全语境时不读取全文', () => {
    const localIndex = new WorkspaceIndex()
    const completionProvider = new VueCompletionProvider(localIndex)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-completion-fast-path-'))
    const uri = path.join(root, 'src/util.ts')
    const content = 'const value = 1\n'
    const document = new TestDocument(uri, content, 'typescript') as any
    const getText = vi.spyOn(document, 'getText')

    localIndex.setWorkspaceVueVersion(root, 2)

    expect(completionProvider.provideCompletionItems(document, positionAt(content, content.length))).toBeUndefined()
    expect(getText).not.toHaveBeenCalled()
  })

  it('普通 JS/TS 换行 EventBus 字符串仍提供事件名补全', async () => {
    const localIndex = new WorkspaceIndex()
    const completionProvider = new VueCompletionProvider(localIndex)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-eventbus-multiline-js-'))

    writeText(path.join(root, 'src/main.js'), 'Vue.prototype.$eventBus = new Vue()\n')
    await localIndex.refreshEventBusRegistrations(root)
    localIndex.indexContent(path.join(root, 'src/EventSource.vue'), `
<script>
export default {
  mounted() {
    this.$eventBus.$emit('ready')
  },
}
</script>
`)

    const content = `
this.$eventBus.$emit(
  ''
)
`
    const document = new TestDocument(path.join(root, 'src/plain.ts'), content, 'typescript') as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(content, content.indexOf("''") + 1)) as any[]

    expect(completions.map((item) => item.label)).toContain('ready')
  })

  it('$refs 根对象补全模板 ref 名称', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const completionProvider = new VueCompletionProvider(index)

    const completions = completionProvider.provideCompletionItems(document, positionAt(content, content.indexOf('this.$refs.') + 'this.$refs.'.length)) as any[]

    expect(completions.map((item) => item.label)).toEqual(['child'])
    expect(completions.every((item) => item.detail === 'template ref')).toBe(true)
    expect(completions.every((item) => item.preselect === true)).toBe(true)
    expect(completions.find((item) => item.label === 'child')?.insertText).toBe('.child')
    expect(completions.find((item) => item.label === 'child')?.filterText).toBe('.child')
    expect(completions.every((item) => item.sortText?.startsWith('\u0000\u0000'))).toBe(true)
  })

  it('$refs 裸对象也补全模板 ref 名称', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const completionProvider = new VueCompletionProvider(index)

    const completions = completionProvider.provideCompletionItems(document, positionAt(content, content.indexOf('this.$refs') + 'this.$refs'.length)) as any[]

    expect(completions.map((item) => item.label)).toEqual(['child'])
  })

  it('Vue2 wrapper 通过 v-bind $attrs 透传深层 props 时提供模板 prop 补全', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue2-forwarded-prop-completion-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const childUri = path.join(root, 'src/Child.vue')
    const middleUri = path.join(root, 'src/Middle.vue')
    const outerUri = path.join(root, 'src/Outer.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<template><div /></template>
<script>
export default {
  name: 'Child',
  props: {
    inheritedTitle: String,
    operateType: Number,
    statusText: String,
    sizeType: String,
    displayName: String,
  },
}
</script>
`
    const middleContent = `
<template>
  <Child v-bind="$attrs" />
</template>
<script>
import Child from './Child.vue'
export default { name: 'Middle', components: { Child } }
</script>
`
    const outerContent = `
<template>
  <Middle v-bind="$attrs" />
</template>
<script>
import Middle from './Middle.vue'
export default {
  name: 'Outer',
  components: { Middle },
  props: {
    inheritedTitle: String,
  },
}
</script>
`
    const parentContent = `
<template>
  <Outer : />
</template>
<script>
import Outer from './Outer.vue'
export default { components: { Outer } }
</script>
`
    const parentBindContent = `
<template>
  <Outer v-bind:o />
</template>
<script>
import Outer from './Outer.vue'
export default { components: { Outer } }
</script>
`
    const parentOpenTagContent = `
<template>
  <Outer :
</template>
<script>
import Outer from './Outer.vue'
export default { components: { Outer } }
</script>
`
    const parentValueContent = `
<template>
  <Outer title=":" />
</template>
<script>
import Outer from './Outer.vue'
export default { components: { Outer } }
</script>
`
    const parentExistingContent = `
<template>
  <Outer operateType="1" v-bind:status-text="status" :size-type.sync="size" : />
</template>
<script>
import Outer from './Outer.vue'
export default { components: { Outer } }
</script>
`
    writeText(childUri, childContent)
    writeText(middleUri, middleContent)
    writeText(outerUri, outerContent)
    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(middleUri, middleContent)
    localIndex.indexContent(outerUri, outerContent)
    const completionProvider = new VueCompletionProvider(localIndex)
    const document = new TestDocument(parentUri, parentContent) as any

    const completions = completionProvider.provideCompletionItems(
      document,
      positionAt(parentContent, parentContent.indexOf('<Outer :') + '<Outer :'.length),
    ) as any[]
    const bindDocument = new TestDocument(parentUri, parentBindContent) as any
    const bindCompletions = completionProvider.provideCompletionItems(
      bindDocument,
      positionAt(parentBindContent, parentBindContent.indexOf('v-bind:o') + 'v-bind:o'.length),
    ) as any[]
    const openTagDocument = new TestDocument(parentUri, parentOpenTagContent) as any
    const openTagCompletions = completionProvider.provideCompletionItems(
      openTagDocument,
      positionAt(parentOpenTagContent, parentOpenTagContent.indexOf('<Outer :') + '<Outer :'.length),
    ) as any[]
    const valueDocument = new TestDocument(parentUri, parentValueContent) as any
    const valueCompletions = completionProvider.provideCompletionItems(
      valueDocument,
      positionAt(parentValueContent, parentValueContent.indexOf('title=":"') + 'title=":'.length),
    )
    const existingDocument = new TestDocument(parentUri, parentExistingContent) as any
    const existingCompletions = completionProvider.provideCompletionItems(
      existingDocument,
      positionAt(parentExistingContent, parentExistingContent.indexOf(': />') + 1),
    ) as any[]

    expect(completions.map((item) => item.label)).toContain('inherited-title')
    expect(completions.map((item) => item.label)).toContain('operate-type')
    expect(completions.filter((item) => item.label === 'inherited-title')).toHaveLength(1)
    expect(completions.find((item) => item.label === 'inherited-title')?.detail).toBe('Outer.props.inheritedTitle')
    expect(completions.find((item) => item.label === 'inherited-title')?.insertText).toBe(':inherited-title')
    expect(completions.find((item) => item.label === 'operate-type')?.detail).toBe('Child.props.operateType')
    expect(completions.find((item) => item.label === 'operate-type')?.insertText).toBe(':operate-type')
    expect(bindCompletions.find((item) => item.label === 'operate-type')?.insertText).toBe('v-bind:operate-type')
    expect(openTagCompletions.find((item) => item.label === 'operate-type')?.insertText).toBe(':operate-type')
    expect(valueCompletions).toBeUndefined()
    expect(existingCompletions.map((item) => item.label)).not.toContain('operate-type')
    expect(existingCompletions.map((item) => item.label)).not.toContain('status-text')
    expect(existingCompletions.map((item) => item.label)).not.toContain('size-type')
    expect(existingCompletions.map((item) => item.label)).toContain('display-name')
  })

  it('$refs 根对象可选链补全模板 ref 名称', () => {
    const content = `
<template>
  <Child ref="child" />
</template>
<script>
import Child from './Child.vue'
export default {
  components: { Child },
  methods: {
    call() {
      this.$refs?.
    },
  },
}
</script>
`
    const uri = path.join(fixtureRoot, 'OptionalRefRootParent.vue')
    index.indexContent(uri, content)
    const document = new TestDocument(uri, content) as any
    const completionProvider = new VueCompletionProvider(index)

    const completions = completionProvider.provideCompletionItems(document, positionAt(content, content.indexOf('this.$refs?.') + 'this.$refs?.'.length)) as any[]

    expect(completions.map((item) => item.label)).toEqual(['child'])
    expect(completions.find((item) => item.label === 'child')?.insertText).toBe('?.child')
    expect(completions.every((item) => item.sortText?.startsWith('\u0000\u0000'))).toBe(true)
  })

  it('$refs 可选链方法补全有更高排序优先级', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const completionProvider = new VueCompletionProvider(index)
    const optionalChainOffset = content.indexOf('this.$refs.child?.') + 'this.$refs.child?.'.length

    const completions = completionProvider.provideCompletionItems(document, positionAt(content, optionalChainOffset)) as any[]

    expect(completions.map((item) => item.label)).toEqual(['open', 'close', 'load', 'notify'])
    expect(completions.every((item) => item.sortText?.startsWith('\u0000\u0000\u0000'))).toBe(true)
  })

  it('$refs 可选链方法定义跳转可用', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const closeOffset = content.indexOf('close()') + 1
    const provider = new VueDefinitionProvider(index)

    const definition = provider.provideDefinition(document, positionAt(content, closeOffset)) as any

    expect(definition.uri.fsPath.endsWith('Child.vue')).toBe(true)
  })

  it('$refs 根对象可选链方法定义跳转、补全、悬浮可用', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const provider = new VueDefinitionProvider(index)
    const completionProvider = new VueCompletionProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const loadOffset = content.indexOf('load()') + 1
    const completionOffset = content.indexOf('this.$refs?.child?.') + 'this.$refs?.child?.'.length

    const definition = provider.provideDefinition(document, positionAt(content, loadOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(content, completionOffset)) as any[]
    const hover = hoverProvider.provideHover(document, positionAt(content, loadOffset)) as any

    expect(definition.uri.fsPath.endsWith('Child.vue')).toBe(true)
    expect(completions.map((item) => item.label)).toEqual(['open', 'close', 'load', 'notify'])
    expect(completions.every((item) => item.sortText?.startsWith('\u0000\u0000\u0000'))).toBe(true)
    expect(hoverText(hover)).toContain('async load()')
    expect(hoverText(hover)).toContain('Definition: [Child.vue:27]')
  })

  it('静态 mixin 中的定义和 $refs 引用 provider 可用', () => {
    const parentContent = readFixture('MixinParent.vue')
    const innerContent = readFixture('MixinInner.vue')
    const parentDocument = new TestDocument(path.join(fixtureRoot, 'MixinParent.vue'), parentContent) as any
    const innerDocument = new TestDocument(path.join(fixtureRoot, 'MixinInner.vue'), innerContent) as any
    const definitionProvider = new VueDefinitionProvider(index)
    const referenceProvider = new VueReferenceProvider(index)
    const completionProvider = new VueCompletionProvider(index)

    const propDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf(':mixed-title') + 2)) as any
    const eventDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('@mixed-save') + 1)) as any[]
    const methodDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('mixedMethod()') + 1)) as any
    const completions = completionProvider.provideCompletionItems(parentDocument, positionAt(parentContent, parentContent.indexOf('this.$refs.mixinChild.') + 'this.$refs.mixinChild.'.length)) as any[]
    const innerReferences = referenceProvider.provideReferences(innerDocument, positionAt(innerContent, innerContent.indexOf('focus()') + 1)) as any[]

    expect(propDefinition.uri.fsPath).toBe(path.join(fixtureRoot, 'mixin-default.js'))
    expect(eventDefinition[0].uri.fsPath).toBe(path.join(fixtureRoot, 'mixin-default.js'))
    expect(methodDefinition.uri.fsPath).toBe(path.join(fixtureRoot, 'mixin-default.js'))
    expect(completions.map((item) => item.label)).toContain('mixedMethod')
    expect(completions.map((item) => item.label)).toContain('namedMethod')
    expect(completions.map((item) => item.label)).toContain('nestedMethod')
    expect(innerReferences[0].uri.fsPath).toBe(path.join(fixtureRoot, 'mixin-default.js'))
  })

  it('JS mixin 源文件中的定义、悬浮和引用 provider 可用', () => {
    const mixinContent = readFixture('mixin-default.js')
    const mixinDocument = new TestDocument(path.join(fixtureRoot, 'mixin-default.js'), mixinContent, 'javascript') as any
    const definitionProvider = new VueDefinitionProvider(index)
    const referenceProvider = new VueReferenceProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const completionProvider = new VueCompletionProvider(index)

    const eventDefinitions = definitionProvider.provideDefinition(mixinDocument, positionAt(mixinContent, mixinContent.indexOf("'mixed-save'") + 2)) as any[]
    const refDefinition = definitionProvider.provideDefinition(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('focus?.') + 1)) as any[]
    const propHover = hoverProvider.provideHover(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('mixedTitle') + 1)) as any
    const methodReferences = referenceProvider.provideReferences(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('mixedMethod') + 1)) as any[]
    const completions = completionProvider.provideCompletionItems(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('this.$refs?.inner?.') + 'this.$refs?.inner?.'.length)) as any[]

    expect(eventDefinitions[0].uri.fsPath).toBe(path.join(fixtureRoot, 'MixinParent.vue'))
    expect(refDefinition[0].uri.fsPath).toBe(path.join(fixtureRoot, 'MixinInner.vue'))
    expect(hoverText(propHover)).toContain('Used by 1 prop usage')
    expect(methodReferences[0].uri.fsPath).toBe(path.join(fixtureRoot, 'MixinParent.vue'))
    expect(completions.map((item) => item.label)).toEqual(['focus'])
  })

  it('JS mixin 源文件中的 $refs 根对象补全来自消费组件模板 ref', () => {
    const mixinContent = readFixture('mixin-default.js')
    const mixinDocument = new TestDocument(path.join(fixtureRoot, 'mixin-default.js'), mixinContent, 'javascript') as any
    const completionProvider = new VueCompletionProvider(index)

    const completions = completionProvider.provideCompletionItems(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('this.$refs') + 'this.$refs'.length)) as any[]

    expect(completions.map((item) => item.label)).toContain('inner')
    expect(completions.every((item) => item.detail === 'template ref')).toBe(true)
  })

  it('Vue mixin 源文件中的引用按消费组件查询', () => {
    const sourceContent = readFixture('MixinVueSource.vue')
    const sourceDocument = new TestDocument(path.join(fixtureRoot, 'MixinVueSource.vue'), sourceContent) as any
    const referenceProvider = new VueReferenceProvider(index)
    const hoverProvider = new VueHoverProvider(index)

    const propReferences = referenceProvider.provideReferences(sourceDocument, positionAt(sourceContent, sourceContent.indexOf('vueMixedTitle') + 1)) as any[]
    const methodReferences = referenceProvider.provideReferences(sourceDocument, positionAt(sourceContent, sourceContent.indexOf('vueMixedMethod') + 1)) as any[]
    const propHover = hoverProvider.provideHover(sourceDocument, positionAt(sourceContent, sourceContent.indexOf('vueMixedTitle') + 1)) as any

    expect(propReferences[0].uri.fsPath).toBe(path.join(fixtureRoot, 'MixinVueParent.vue'))
    expect(methodReferences[0].uri.fsPath).toBe(path.join(fixtureRoot, 'MixinVueParent.vue'))
    expect(hoverText(propHover)).toContain('Used by 1 prop usage')
  })

  it('$emit 与 template 事件双向定义跳转可用', () => {
    const childContent = readFixture('Child.vue')
    const parentContent = readFixture('Parent.vue')
    const childDocument = new TestDocument(path.join(fixtureRoot, 'Child.vue'), childContent) as any
    const parentDocument = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), parentContent) as any
    const provider = new VueDefinitionProvider(index)
    const emitOffset = childContent.indexOf("'save'") + 2
    const eventOffset = parentContent.indexOf('@save') + 2

    const emitDefinitions = provider.provideDefinition(childDocument, positionAt(childContent, emitOffset)) as any[]
    const eventDefinitions = provider.provideDefinition(parentDocument, positionAt(parentContent, eventOffset)) as any[]

    expect(emitDefinitions).toHaveLength(2)
    expect(emitDefinitions[0].uri.fsPath.endsWith('Parent.vue')).toBe(true)
    expect(eventDefinitions).toHaveLength(2)
    expect(eventDefinitions[0].uri.fsPath.endsWith('Child.vue')).toBe(true)
  })

  it('未从入口注册的 $bus 不提供 Event Bus 能力', () => {
    const localIndex = new WorkspaceIndex()
    const uri = path.join(fixtureRoot, 'UnregisteredBus.vue')
    const content = `
<script>
export default {
  mounted() {
    this.$bus.$emit('hiddenEvent')
    this.$bus.
  },
}
</script>
`
    localIndex.indexContent(uri, content)
    const document = new TestDocument(uri, content) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const completionProvider = new VueCompletionProvider(localIndex)
    const eventOffset = content.indexOf("'hiddenEvent'") + 2
    const completionOffset = content.indexOf('this.$bus.') + 'this.$bus.'.length

    expect(definitionProvider.provideDefinition(document, positionAt(content, eventOffset))).toBeUndefined()
    expect(hoverProvider.provideHover(document, positionAt(content, eventOffset))).toBeUndefined()
    expect(completionProvider.provideCompletionItems(document, positionAt(content, completionOffset))).toBeUndefined()
  })

  it('Event Bus emit 和 listener 支持双向定义、悬浮和引用', async () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-event-bus-'))
    writeText(path.join(root, 'src/main.js'), `
import Vue from 'vue'
Vue.prototype.$eventBus = new Vue()
`)
    await localIndex.refreshEventBusRegistrations(root)
    const emitUri = path.join(root, 'EventBusEmit.vue')
    const listenerUri = path.join(root, 'EventBusListener.vue')
    const emitContent = `
<script>
export default {
  methods: {
    collect() {
      this.$eventBus.$emit('joinOrDeleteCollect', [{ ...this.item }, true])
    },
  },
}
</script>
`
    const listenerContent = `
<script>
export default {
  mounted() {
    this.$eventBus.$on('joinOrDeleteCollect', async ([item, isFavorite]) => {})
    this.$eventBus.$once('joinOrDeleteCollect', () => {})
    this.$eventBus.$off('joinOrDeleteCollect', this.onCollect)
  },
}
</script>
`
    localIndex.indexContent(emitUri, emitContent)
    localIndex.indexContent(listenerUri, listenerContent)
    const emitDocument = new TestDocument(emitUri, emitContent) as any
    const listenerDocument = new TestDocument(listenerUri, listenerContent) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const completionProvider = new VueCompletionProvider(localIndex)
    const emitOffset = emitContent.indexOf("'joinOrDeleteCollect'") + 2
    const listenerOffset = listenerContent.indexOf("'joinOrDeleteCollect'") + 2
    const offOffset = listenerContent.lastIndexOf("'joinOrDeleteCollect'") + 2
    const completionContent = `
<script>
export default {
  mounted() {
    this.$eventBus.
    this.$eventBus?.
    $eventBus.
    this.$eventBus.$emit('')
    this.$eventBus.$on('')
    this.$eventBus.$once('')
    this.$eventBus.$off('')
    // this.$eventBus.
    const methodText = "this.$eventBus."
    const eventText = "this.$eventBus.$emit('"
  },
}
</script>
`
    const completionDocument = new TestDocument(path.join(root, 'EventBusCompletion.vue'), completionContent) as any
    const completionResult = (needle: string) => {
      return completionProvider.provideCompletionItems(completionDocument, positionAt(completionContent, completionContent.indexOf(needle) + needle.length)) as any[] | undefined
    }
    const completionLabels = (needle: string) => {
      return completionResult(needle)?.map((item) => item.label) ?? []
    }
    const completionItems = (needle: string) => {
      return completionResult(needle) ?? []
    }

    const emitDefinitions = asArray(definitionProvider.provideDefinition(emitDocument, positionAt(emitContent, emitOffset)))
    const listenerDefinitions = asArray(definitionProvider.provideDefinition(listenerDocument, positionAt(listenerContent, listenerOffset)))
    const offDefinitions = asArray(definitionProvider.provideDefinition(listenerDocument, positionAt(listenerContent, offOffset)))
    const emitReferences = referenceProvider.provideReferences(emitDocument, positionAt(emitContent, emitOffset)) as any[]
    const listenerReferences = referenceProvider.provideReferences(listenerDocument, positionAt(listenerContent, listenerOffset)) as any[]
    const offReferences = referenceProvider.provideReferences(listenerDocument, positionAt(listenerContent, offOffset)) as any[]
    const emitHover = hoverProvider.provideHover(emitDocument, positionAt(emitContent, emitOffset)) as any
    const listenerHover = hoverProvider.provideHover(listenerDocument, positionAt(listenerContent, listenerOffset)) as any

    expect(emitDefinitions[0].uri.fsPath).toBe(listenerUri)
    expect(emitDefinitions).toHaveLength(3)
    expect(listenerDefinitions[0].uri.fsPath).toBe(emitUri)
    expect(offDefinitions[0].uri.fsPath).toBe(emitUri)
    expect(emitReferences[0].uri.fsPath).toBe(listenerUri)
    expect(emitReferences).toHaveLength(3)
    expect(listenerReferences[0].uri.fsPath).toBe(emitUri)
    expect(offReferences[0].uri.fsPath).toBe(emitUri)
    expect(hoverText(emitHover)).toContain('Listened by 3 event bus listeners')
    expect(hoverText(emitHover)).toContain('[EventBusListener.vue:')
    expect(hoverText(emitHover)).toContain('$on')
    expect(hoverText(emitHover)).toContain('$once')
    expect(hoverText(emitHover)).toContain('$off')
    expect(hoverText(listenerHover)).toContain('Emitted by 1 event bus emit')
    expect(hoverText(listenerHover)).toContain('[EventBusEmit.vue:')
    expect(hoverText(listenerHover)).toContain('$emit')
    expect(hoverText(emitHover)).not.toContain('\n  $on')
    expect(completionLabels('this.$eventBus.')).toEqual(['$emit', '$on', '$once', '$off'])
    expect(completionLabels('this.$eventBus?.')).toEqual(['$emit', '$on', '$once', '$off'])
    expect(completionLabels('$eventBus.')).toEqual(['$emit', '$on', '$once', '$off'])
    expect(completionItems('this.$eventBus.').find((item) => item.label === '$emit')?.insertText).toBe('.$emit')
    expect(completionItems('this.$eventBus?.').find((item) => item.label === '$emit')?.insertText).toBe('?.$emit')
    expect(completionLabels("this.$eventBus.$emit('")).toContain('joinOrDeleteCollect')
    expect(completionLabels("this.$eventBus.$on('")).toContain('joinOrDeleteCollect')
    expect(completionLabels("this.$eventBus.$once('")).toContain('joinOrDeleteCollect')
    expect(completionLabels("this.$eventBus.$off('")).toContain('joinOrDeleteCollect')
    expect(completionResult('// this.$eventBus.')).toBeUndefined()
    expect(completionResult('"this.$eventBus.')).toBeUndefined()
    expect(completionResult('"this.$eventBus.$emit(\'')).toBeUndefined()
    expect(emitHover.contents.isTrusted).toBe(false)
    expect(listenerHover.contents.isTrusted).toBe(false)
  })

  it('带修饰符的 template 事件也能跳到子组件 emits', () => {
    const parentContent = `
<template>
  <Child @save.once="onSave" />
</template>
<script>
import Child from './Child.vue'
export default {
  components: { Child },
  methods: { onSave() {} },
}
</script>
`
    const document = new TestDocument(path.join(fixtureRoot, 'ModifierParent.vue'), parentContent) as any
    const provider = new VueDefinitionProvider(index)
    const eventOffset = parentContent.indexOf('@save.once') + 2

    index.indexContent(path.join(fixtureRoot, 'ModifierParent.vue'), parentContent)
    const definitions = provider.provideDefinition(document, positionAt(parentContent, eventOffset)) as any[]

    expect(definitions).toHaveLength(2)
    expect(definitions[0].uri.fsPath.endsWith('Child.vue')).toBe(true)
  })

  it('全局注册组件的 prop、event 和 $refs provider 可用', () => {
    const parentContent = readFixture('GlobalParent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'GlobalParent.vue'), parentContent) as any
    const definitionProvider = new VueDefinitionProvider(index)
    const referenceProvider = new VueReferenceProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const completionProvider = new VueCompletionProvider(index)
    const labelOffset = parentContent.indexOf(':label') + 2
    const readyOffset = parentContent.indexOf('@ready') + 2
    const focusOffset = parentContent.indexOf('focus()') + 1
    const completionOffset = parentContent.indexOf('this.$refs.globalChild.') + 'this.$refs.globalChild.'.length
    const childContent = fs.readFileSync(path.join(fixtureRoot, 'global-components/GlobalChild.vue'), 'utf8')
    const childDocument = new TestDocument(path.join(fixtureRoot, 'global-components/GlobalChild.vue'), childContent) as any
    const childPropOffset = childContent.indexOf('label: String') + 1

    const propDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, labelOffset)) as any
    const eventDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, readyOffset)) as any[]
    const methodDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, focusOffset)) as any
    const propReferences = referenceProvider.provideReferences(childDocument, positionAt(childContent, childPropOffset)) as any[]
    const hover = hoverProvider.provideHover(document, positionAt(parentContent, labelOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(parentContent, completionOffset)) as any[]

    expect(propDefinition.uri.fsPath.endsWith('GlobalChild.vue')).toBe(true)
    expect(eventDefinition[0].uri.fsPath.endsWith('GlobalChild.vue')).toBe(true)
    expect(methodDefinition.uri.fsPath.endsWith('GlobalChild.vue')).toBe(true)
    expect(propReferences).toHaveLength(1)
    expect(hoverText(hover)).toContain('label: String')
    expect(completions.map((item) => item.label)).toContain('focus')
  })

  it('Element UI ref 方法定义、补全和悬浮可用', async () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-element-ui-ref-'))
    writeElementUiTypes(root)
    const parentUri = path.join(root, 'src/Parent.vue')
    const parentContent = `
<template>
  <div>
    <el-form ref="form" />
    <el-input ref="input" />
  </div>
</template>
<script>
export default {
  mounted() {
    this.$refs.form.validate()
    this.$refs.form.
    this.$refs?.input?.focus()
  },
}
</script>
`
    writeText(parentUri, parentContent)
    await localIndex.indexWorkspace(root)
    const document = new TestDocument(parentUri, parentContent) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const completionProvider = new VueCompletionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const formTypeUri = path.join(root, 'node_modules/element-ui/types/form.d.ts')
    const inputTypeUri = path.join(root, 'node_modules/element-ui/types/input.d.ts')
    const validateOffset = parentContent.indexOf('validate()') + 1
    const focusOffset = parentContent.indexOf('focus()') + 1
    const completionOffset = parentContent.indexOf('this.$refs.form.') + 'this.$refs.form.'.length

    const validateDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, validateOffset)) as any
    const focusDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, focusOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(parentContent, completionOffset)) as any[]
    const hover = hoverProvider.provideHover(document, positionAt(parentContent, focusOffset)) as any

    expect(validateDefinition.uri.fsPath).toBe(formTypeUri)
    expect(focusDefinition.uri.fsPath).toBe(inputTypeUri)
    expect(completions.map((item) => item.label)).toEqual(['validate', 'resetFields', 'clearValidate'])
    expect(completions.find((item) => item.label === 'validate')?.detail).toBe('ElForm.methods.validate')
    expect(hoverText(hover)).toContain('Focus the Input component')
    expect(hoverText(hover)).toContain('Definition: [input.d.ts:9]')
  })

  it('Vant ref 方法定义和补全可用', async () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-provider-vant-ref-'))
    writeVantTypes(root)
    const parentUri = path.join(root, 'src/Parent.vue')
    const parentContent = `
<template>
  <div>
    <van-field ref="field" />
    <van-form ref="form" />
  </div>
</template>
<script>
export default {
  mounted() {
    this.$refs.field.focus()
    this.$refs.form.
  },
}
</script>
`
    writeText(parentUri, parentContent)
    await localIndex.indexWorkspace(root)
    const document = new TestDocument(parentUri, parentContent) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const completionProvider = new VueCompletionProvider(localIndex)
    const fieldTypeUri = path.join(root, 'node_modules/vant/types/field.d.ts')
    const focusOffset = parentContent.indexOf('focus()') + 1
    const completionOffset = parentContent.indexOf('this.$refs.form.') + 'this.$refs.form.'.length

    const definition = definitionProvider.provideDefinition(document, positionAt(parentContent, focusOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(parentContent, completionOffset)) as any[]

    expect(definition.uri.fsPath).toBe(fieldTypeUri)
    expect(completions.map((item) => item.label)).toEqual(['submit', 'validate', 'resetValidation', 'scrollToField'])
    expect(completions.find((item) => item.label === 'validate')?.detail).toBe('Form.methods.validate')
  })

  it('全局组件晚于父组件索引时仍能从 prop 跳转', async () => {
    const localIndex = new WorkspaceIndex()
    localIndex.setWorkspaceVueVersion(fixtureRoot, 2)
    const parentUri = path.join(fixtureRoot, 'LateGlobalParent.vue')
    const childUri = path.join(fixtureRoot, 'LateGlobalChild.vue')
    const globalUri = path.join(fixtureRoot, 'late-global.js')
    const parentContent = `
<template>
  <LateGlobalChild :value.sync="value" />
</template>
<script>
export default {}
</script>
`
    const childContent = `
<template><div /></template>
<script>
export default {
  props: {
    value: String,
  },
}
</script>
`
    const document = new TestDocument(parentUri, parentContent) as any
    const provider = new VueDefinitionProvider(localIndex)

    localIndex.indexContent(parentUri, parentContent)
    localIndex.indexContent(childUri, childContent)
    await localIndex.indexGlobalComponentContent(globalUri, `
import LateGlobalChild from './LateGlobalChild.vue'
Vue.component('LateGlobalChild', LateGlobalChild)
`)

    const definition = provider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf(':value.sync') + 2)) as any

    expect(definition.uri.fsPath).toBe(childUri)
  })

  it('全局组件标签名可跳转到组件文件', () => {
    const parentContent = readFixture('GlobalParent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'GlobalParent.vue'), parentContent) as any
    const definitionProvider = new VueDefinitionProvider(index)

    const definition = definitionProvider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('GlobalChild') + 1)) as any

    expect(definition.uri.fsPath.endsWith('GlobalChild.vue')).toBe(true)
  })

  it('局部注册组件标签名不由本扩展跳转，避免和 Vue 官方扩展重复', () => {
    const parentContent = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), parentContent) as any
    const definitionProvider = new VueDefinitionProvider(index)

    const definition = definitionProvider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('Child') + 1))

    expect(definition).toBeUndefined()
  })

  it('mixin 注册的局部组件标签名可跳转到组件文件', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-mixin-component-tag-definition-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const childUri = path.join(root, 'src/components/business-channel-dialog/index.vue')
    const mixinUri = path.join(root, 'src/pages/home/mixin.js')
    const parentUri = path.join(root, 'src/pages/home/big-screen/index.vue')
    const childContent = `
<template><div /></template>
<script>
export default { name: 'business-channel-dialog' }
</script>
`
    const mixinContent = `
import BusinessChannelDialog from '../../components/business-channel-dialog/index.vue'

export default {
  components: {
    BusinessChannelDialog,
  },
}
`
    const parentContent = `
<template>
  <business-channel-dialog v-if="channelVisible" />
</template>
<script>
import homeMixin from '../mixin'

export default {
  mixins: [homeMixin],
  data() {
    return {
      channelVisible: true,
    }
  },
}
</script>
`
    writeText(childUri, childContent)
    writeText(mixinUri, mixinContent)
    writeText(parentUri, parentContent)
    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(parentUri, parentContent)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const document = new TestDocument(parentUri, parentContent) as any
    const tagPosition = positionAt(parentContent, parentContent.indexOf('business-channel-dialog') + 1)

    const definition = definitionProvider.provideDefinition(document, tagPosition) as any
    const hover = hoverProvider.provideHover(document, tagPosition) as any

    expect(definition.uri.fsPath).toBe(childUri)
    expect(hoverText(hover)).toContain('Definition: [business-channel-dialog/index.vue:')
  })

  it('template 实例成员可跳转到当前组件或 mixin 定义并展示 JSDoc', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-template-instance-member-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const mixinUri = path.join(root, 'src/pages/home/mixin.js')
    const parentUri = path.join(root, 'src/pages/home/big-screen/index.vue')
    const screenSaverUri = path.join(root, 'src/pages/home/components/screen-saver-dialog.vue')
    const mixinContent = `
import ScreenSaverDialog from './components/screen-saver-dialog.vue'

export default {
  components: {
    ScreenSaverDialog,
  },
  computed: {
    // 不支持普通行注释 hover
    screenBannerList() {
      return []
    },
  },
}
`
    const parentContent = `
<template>
  <section>
    <div :class="buttonFormatArr.length > 2 ? 'main' : 'main-min'">
      <button v-for="item in buttonFormatArr" :key="item.id" @click="onBtnHandle(item.id)">
        {{ localCount }} {{ item.name }}
      </button>
    </div>
    <ScreenSaverDialog :bannerList="screenBannerList" v-slot="{ slotItem }">
      {{ slotItem.title }}
    </ScreenSaverDialog>
  </section>
</template>
<script>
import homeMixin from '../mixin'

export default {
  mixins: [homeMixin],
  data() {
    return {
      /** Local count docs */
      localCount: 1,
      /** Instance item docs */
      item: null,
      /** Instance slot item docs */
      slotItem: null,
    }
  },
  computed: {
    /** Button format docs */
    buttonFormatArr() {
      return []
    },
  },
  methods: {
    /** Button click docs */
    onBtnHandle(id) {
      return id
    },
  },
}
</script>
`
    writeText(mixinUri, mixinContent)
    writeText(parentUri, parentContent)
    writeText(screenSaverUri, '<template><div /></template><script>export default { name: "ScreenSaverDialog" }</script>')
    localIndex.indexContent(screenSaverUri, fs.readFileSync(screenSaverUri, 'utf8'))
    localIndex.indexContent(parentUri, parentContent)

    const definitionProvider = new VueDefinitionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const document = new TestDocument(parentUri, parentContent) as any

    const screenDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('screenBannerList') + 1)) as any
    const buttonDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('buttonFormatArr.length') + 1)) as any
    const buttonHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('buttonFormatArr.length') + 1)) as any
    const dataHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('localCount') + 1)) as any
    const methodHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('onBtnHandle') + 1)) as any
    const screenHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('screenBannerList') + 1)) as any
    const forItemDefinition = definitionProvider.provideDefinition(document, positionAt(parentContent, parentContent.indexOf('item.id') + 1)) as any
    const nestedForItemHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('item.name') + 1)) as any
    const slotItemHover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('slotItem.title') + 1)) as any

    expect(screenDefinition.uri.fsPath).toBe(mixinUri)
    expect(buttonDefinition.uri.fsPath).toBe(parentUri)
    expect(hoverText(buttonHover)).toContain('Button format docs')
    expect(hoverText(dataHover)).toContain('Local count docs')
    expect(hoverText(methodHover)).toContain('Button click docs')
    expect(hoverText(buttonHover)).not.toContain('buttonFormatArr()')
    expect(hoverText(dataHover)).not.toContain('localCount: 1')
    expect(hoverText(methodHover)).not.toContain('onBtnHandle(id)')
    expect(hoverText(screenHover)).not.toContain('不支持普通行注释 hover')
    expect(hoverText(screenHover)).not.toContain('screenBannerList()')
    expect(forItemDefinition).toBeUndefined()
    expect(nestedForItemHover).toBeUndefined()
    expect(slotItemHover).toBeUndefined()
  })

  it('默认 slot 使用不抢占嵌套局部组件标签名', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-default-slot-component-child-'))
    const childUri = path.join(root, 'Child.vue')
    const nestedUri = path.join(root, 'Nested.vue')
    const parentUri = path.join(root, 'Parent.vue')
    const childContent = `
<template>
  <section><slot /></section>
</template>
<script>
export default { name: 'Child' }
</script>
`
    const nestedContent = `
<template><div /></template>
<script>
export default { name: 'Nested' }
</script>
`
    const parentContent = `
<template>
  <Child>
    <Nested />
  </Child>
</template>
<script>
import Child from './Child.vue'
import Nested from './Nested.vue'
export default { components: { Child, Nested } }
</script>
`

    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(nestedUri, nestedContent)
    localIndex.indexContent(parentUri, parentContent)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const nestedTagOffset = parentContent.indexOf('Nested') + 1
    const nestedOpenOffset = parentContent.indexOf('<Nested')
    const defaultSlotUsages = localIndex.findTemplateSlotUsages(childUri, 'default')

    const definition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, nestedTagOffset))
    const hover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, nestedTagOffset))

    expect(defaultSlotUsages).toHaveLength(1)
    expect(defaultSlotUsages[0].span).toEqual({ start: nestedOpenOffset, end: nestedOpenOffset + 1 })
    expect(definition).toBeUndefined()
    expect(hover).toBeUndefined()
  })

  it('template prop 定义跳转和悬浮可用，未知 prop 不跳转', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const provider = new VueDefinitionProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const titleOffset = content.indexOf(':title') + 2
    const unknownContent = content.replace(':title="pageTitle"', ':missing="pageTitle"')
    const unknownDocument = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), unknownContent) as any
    const unknownOffset = unknownContent.indexOf(':missing') + 2

    const definition = provider.provideDefinition(document, positionAt(content, titleOffset)) as any
    const hover = hoverProvider.provideHover(document, positionAt(content, titleOffset)) as any
    const missing = provider.provideDefinition(unknownDocument, positionAt(unknownContent, unknownOffset))

    expect(definition.uri.fsPath.endsWith('Child.vue')).toBe(true)
    expect(hoverText(hover)).toContain('title: String')
    expect(hoverText(hover)).toContain('Definition: [Child.vue:9]')
    expect(hoverText(hover)).toContain('file://')
    expect(hover.contents.isTrusted).toBe(false)
    expect(missing).toBeUndefined()
  })

  it('template .sync prop 定义跳转和悬浮可用', () => {
    const content = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), content) as any
    const provider = new VueDefinitionProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const userIdOffset = content.indexOf(':user-id.sync') + 2

    const definition = provider.provideDefinition(document, positionAt(content, userIdOffset)) as any
    const hover = hoverProvider.provideHover(document, positionAt(content, userIdOffset)) as any

    expect(definition.uri.fsPath.endsWith('Child.vue')).toBe(true)
    expect(hoverText(hover)).toContain('userId: Number')
  })

  it('alias 组件 prop 与 event 定义跳转和悬浮可用', () => {
    const parentContent = readFixture('Parent.vue')
    const aliasContent = fs.readFileSync(path.join(fixtureRoot, 'src/components/AliasChild.vue'), 'utf8')
    const parentDocument = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), parentContent) as any
    const aliasDocument = new TestDocument(path.join(fixtureRoot, 'src/components/AliasChild.vue'), aliasContent) as any
    const definitionProvider = new VueDefinitionProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const originOffset = parentContent.indexOf(':origin-url') + 2
    const eventOffset = parentContent.indexOf('@onLoadSuccess') + 2
    const emitOffset = aliasContent.indexOf('onLoadSuccess') + 1

    const propDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, originOffset)) as any
    const eventDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, eventOffset)) as any[]
    const propHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, originOffset)) as any
    const eventHover = hoverProvider.provideHover(aliasDocument, positionAt(aliasContent, emitOffset)) as any
    const parentEventHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, eventOffset))

    expect(propDefinition.uri.fsPath.endsWith('AliasChild.vue')).toBe(true)
    expect(eventDefinition[0].uri.fsPath.endsWith('AliasChild.vue')).toBe(true)
    expect(hoverText(propHover).startsWith('*@description* — Source image URL.')).toBe(true)
    expect(hoverText(propHover)).toContain("originUrl: {\n  type: String,")
    expect(hoverText(propHover)).toContain('default')
    expect(hoverText(propHover)).toContain('Definition: [AliasChild.vue:12]')
    expect(hoverText(propHover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(propHover.contents.isTrusted).toBe(false)
    expect(parentEventHover).toBeDefined()
    expect(hoverText(parentEventHover)).toContain('Definition: [AliasChild.vue:19]')
    expect(hoverText(parentEventHover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(hoverText(parentEventHover)).not.toContain('Used by 1 listener')
    expect(parentEventHover.contents.isTrusted).toBe(false)
    expect(hoverText(eventHover)).not.toContain('Definition: [AliasChild.vue:')
    expect(hoverText(eventHover)).toContain('Used by 1 listener')
    expect(hoverText(eventHover)).not.toContain('AliasChild emits onLoadSuccess')
    expect(hoverText(eventHover)).toContain('[Parent.vue')
    expect(hoverText(eventHover)).toContain('file://')
    expect(eventHover.contents.isTrusted).toBe(false)
  })

  it('Definition 链接展示最短可区分路径，target 仍保留完整 file URI', () => {
    const parentContent = readFixture('Parent.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Parent.vue'), parentContent) as any
    const hoverProvider = new VueHoverProvider(index)
    const originOffset = parentContent.indexOf(':origin-url') + 2

    const hover = hoverProvider.provideHover(document, positionAt(parentContent, originOffset)) as any

    expect(hoverText(hover)).toContain('Definition: [AliasChild.vue:12]')
    expect(hoverText(hover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(hoverText(hover)).toContain('file://')
  })

  it('emit 引用列表使用文件名和目录上下文', () => {
    const childUri = path.join(fixtureRoot, 'NestedEmitChild.vue')
    const childContent = `
<template><div /></template>
<script>
export default {
  methods: {
    submit() {
      this.$emit('submit')
    },
  },
}
</script>
`
    const parents = [
      ['pages/admin/marketing/red-packet/index.vue', 'onRedPacketSubmit'],
      ['pages/admin/marketing/activity/index.vue', 'onActivitySubmit'],
      ['pages/admin/marketing/coupon/index.vue', 'onCouponSubmit'],
    ] as const
    index.indexContent(childUri, childContent)
    for (const [relativePath, handler] of parents) {
      index.indexContent(path.join(fixtureRoot, relativePath), `
<template>
  <NestedEmitChild @submit="${handler}" />
</template>
<script>
import NestedEmitChild from '../../../../NestedEmitChild.vue'
export default { components: { NestedEmitChild }, methods: { ${handler}() {} } }
</script>
`)
    }

    const document = new TestDocument(childUri, childContent) as any
    const hoverProvider = new VueHoverProvider(index)
    const hover = hoverProvider.provideHover(document, positionAt(childContent, childContent.indexOf("'submit'") + 2)) as any

    expect(hoverText(hover)).toContain('- [index.vue:3]')
    expect(hoverText(hover)).toContain('#L')
    expect(hoverText(hover)).toContain('- pages/admin/marketing/red-packet')
    expect(hoverText(hover)).toContain('- pages/admin/marketing/activity')
    expect(hoverText(hover)).toContain('- pages/admin/marketing/coupon')
    expect(hoverText(hover)).not.toContain('- [pages/admin/marketing/red-packet/index.vue')
  })

  it('Vue2 .sync 使用会作为 update 事件的反向引用', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue2-sync-event-usage-'))
    const childUri = path.join(root, 'BusinessSwitchTakeCoinsDialog.vue')
    const parentUri = path.join(root, 'Parent.vue')
    const childContent = `
<template><div /></template>
<script>
export default {
  name: 'BusinessSwitchTakeCoinsDialog',
  props: {
    visible: Boolean,
    userId: String,
  },
  computed: {
    dialogVisible: {
      set(val) {
        this.$emit('update:visible', val)
      },
    },
  },
  methods: {
    updateUser(val) {
      this.$emit('update:userId', val)
    },
  },
}
</script>
`
    const parentContent = `
<template>
  <BusinessSwitchTakeCoinsDialog :visible.sync="switchTakeCoinsDialogVisible" :user-id.sync="userId" />
</template>
<script>
import BusinessSwitchTakeCoinsDialog from './BusinessSwitchTakeCoinsDialog.vue'
export default {
  components: { BusinessSwitchTakeCoinsDialog },
  data() {
    return {
      switchTakeCoinsDialogVisible: false,
      userId: '1',
    }
  },
}
</script>
`
    localIndex.setWorkspaceVueVersion(root, 2)
    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(parentUri, parentContent)
    const childDocument = new TestDocument(childUri, childContent) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const eventPosition = positionAt(childContent, childContent.indexOf("'update:visible'") + 2)
    const camelEventPosition = positionAt(childContent, childContent.indexOf("'update:userId'") + 2)
    const propPosition = positionAt(childContent, childContent.indexOf('visible: Boolean') + 1)

    const definitions = asArray(definitionProvider.provideDefinition(childDocument, eventPosition) as any)
    const references = referenceProvider.provideReferences(childDocument, eventPosition) as any[]
    const camelDefinitions = asArray(definitionProvider.provideDefinition(childDocument, camelEventPosition) as any)
    const eventHover = hoverProvider.provideHover(childDocument, eventPosition) as any
    const camelEventHover = hoverProvider.provideHover(childDocument, camelEventPosition) as any
    const propHover = hoverProvider.provideHover(childDocument, propPosition) as any

    expect(definitions.map((item) => item.uri.fsPath)).toEqual([parentUri])
    expect(references.map((item) => item.uri.fsPath)).toEqual([parentUri])
    expect(camelDefinitions.map((item) => item.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(eventHover)).toContain('Used by 1 listener')
    expect(hoverText(eventHover)).toContain('Parent.vue')
    expect(hoverText(camelEventHover)).toContain('Used by 1 listener')
    expect(hoverText(propHover)).toContain('Used by 1 prop usage')
  })

  it('prop 定义悬浮展示模板使用位置', () => {
    const content = readFixture('Child.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Child.vue'), content) as any
    const hoverProvider = new VueHoverProvider(index)
    const propOffset = content.indexOf('title: String') + 1

    const hover = hoverProvider.provideHover(document, positionAt(content, propOffset)) as any

    expect(hoverText(hover)).toContain('Used by 1 prop usage')
    expect(hoverText(hover)).toContain('- [Parent.vue:5]')
    expect(hoverText(hover)).not.toContain('title: String')
    expect(hover.contents.isTrusted).toBe(false)
  })

  it('$refs 方法定义悬浮展示静态使用位置', () => {
    const content = readFixture('Child.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Child.vue'), content) as any
    const hoverProvider = new VueHoverProvider(index)
    const methodOffset = content.indexOf('open(source)') + 1

    const hover = hoverProvider.provideHover(document, positionAt(content, methodOffset)) as any

    expect(hoverText(hover)).toContain('Used by 2 ref methods')
    expect(hoverText(hover)).toContain('- [Parent.vue:39]')
    expect(hoverText(hover)).not.toContain('methods.callChild')
    expect(hoverText(hover)).not.toContain('open(source)')
    expect(hover.contents.isTrusted).toBe(false)
  })

  it('Vue2 slot 定义和使用的 definition、hover、reference 可用', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue2-slot-providers-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const childUri = path.join(root, 'Child.vue')
    const parentUri = path.join(root, 'Parent.vue')
    const childContent = `
<template>
  <section>
    <slot />
    <slot name="footer" />
  </section>
</template>
<script>
export default { name: 'Child' }
</script>
`
    const parentContent = `
<template>
  <Child>
    <span>Default</span>
    <template slot="footer">Footer</template>
  </Child>
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`

    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(parentUri, parentContent)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const childDocument = new TestDocument(childUri, childContent) as any
    const parentDocument = new TestDocument(parentUri, parentContent) as any

    const slotDefinitionOffset = childContent.indexOf('footer') + 1
    const defaultSlotDefinitionOffset = childContent.indexOf('<slot />') + '<'.length + 1
    const defaultSlotUsageOffset = parentContent.indexOf('<span>') + '<'.length + 1
    const slotUsageOffset = parentContent.indexOf('slot="footer"') + 'slot="'.length + 1
    const references = referenceProvider.provideReferences(childDocument, positionAt(childContent, slotDefinitionOffset)) as any[]
    const defaultReferences = referenceProvider.provideReferences(childDocument, positionAt(childContent, defaultSlotDefinitionOffset)) as any[]
    const definition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, slotUsageOffset)) as any
    const defaultDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, defaultSlotUsageOffset)) as any
    const hover = hoverProvider.provideHover(childDocument, positionAt(childContent, slotDefinitionOffset)) as any
    const defaultHover = hoverProvider.provideHover(childDocument, positionAt(childContent, defaultSlotDefinitionOffset)) as any

    expect(references.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(defaultReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(definition.uri.fsPath).toBe(childUri)
    expect(defaultDefinition.uri.fsPath).toBe(childUri)
    expect(hoverText(hover)).toContain('Used by 1 slot usage')
    expect(hoverText(defaultHover)).toContain('Used by 1 slot usage')
  })

  it('provide 和 inject 支持双向定义、悬浮和引用', () => {
    const providerUri = path.join(fixtureRoot, 'ProvideSource.vue')
    const consumerUri = path.join(fixtureRoot, 'InjectConsumer.vue')
    const providerContent = `
<template><InjectConsumer /></template>
<script>
import InjectConsumer from './InjectConsumer.vue'
export default {
  components: { InjectConsumer },
  methods: {
    getValue() {},
  },
  provide: {
    service: this.service,
  },
}
</script>
`
    const consumerContent = `
<template><div /></template>
<script>
export default {
  methods: {
    getValue() {},
  },
  inject: {
    localService: {
      from: 'service',
    },
  },
}
</script>
`
    index.indexContent(providerUri, providerContent)
    index.indexContent(consumerUri, consumerContent)
    const definitionProvider = new VueDefinitionProvider(index)
    const referenceProvider = new VueReferenceProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const providerDocument = new TestDocument(providerUri, providerContent) as any
    const consumerDocument = new TestDocument(consumerUri, consumerContent) as any

    const injectDefinition = definitionProvider.provideDefinition(consumerDocument, positionAt(consumerContent, consumerContent.indexOf("'service'") + 2)) as any[]
    const provideDefinitions = definitionProvider.provideDefinition(providerDocument, positionAt(providerContent, providerContent.indexOf('service:') + 1)) as any[]
    const provideReferences = referenceProvider.provideReferences(providerDocument, positionAt(providerContent, providerContent.indexOf('service:') + 1)) as any[]
    const injectHover = hoverProvider.provideHover(consumerDocument, positionAt(consumerContent, consumerContent.indexOf("'service'") + 2)) as any
    const provideHover = hoverProvider.provideHover(providerDocument, positionAt(providerContent, providerContent.indexOf('service:') + 1)) as any

    expect(injectDefinition[0].uri.fsPath).toBe(providerUri)
    expect(provideDefinitions[0].uri.fsPath).toBe(consumerUri)
    expect(provideReferences[0].uri.fsPath).toBe(consumerUri)
    expect(hoverText(injectHover)).toContain('Provided by 1 definition')
    expect(hoverText(provideHover)).toContain('Injected by 1 consumer')
    expect(hoverText(provideHover)).toContain('- [InjectConsumer.vue:')
    expect(hoverText(injectHover)).not.toContain('getValue')
    expect(hoverText(provideHover)).not.toContain('getValue')
    expect(hoverText(provideHover)).not.toContain('localService')
  })

  it('inject 字符串支持 provide key 补全', () => {
    const arrayChildUri = path.join(fixtureRoot, 'CompletionArrayChild.vue')
    const objectChildUri = path.join(fixtureRoot, 'CompletionObjectChild.vue')
    const middleUri = path.join(fixtureRoot, 'CompletionMiddle.vue')
    const parentUri = path.join(fixtureRoot, 'CompletionParent.vue')
    const unrelatedUri = path.join(fixtureRoot, 'CompletionUnrelated.vue')
    const unrelatedContent = `
<script>
export default {
  provide: {
    unrelated: {},
  },
}
</script>`
    const arrayChildContent = `
<script>
export default {
  name: 'CompletionArrayChild',
  provide: {
    selfOnly: {},
  },
  inject: [''],
}
</script>`
    const objectChildContent = `
<script>
export default {
  name: 'CompletionObjectChild',
  inject: {
    localService: { from: '' },
    '': 'fallback',
  },
}
</script>`
    const middleContent = `
<template>
  <CompletionArrayChild />
  <CompletionObjectChild />
</template>
<script>
import CompletionArrayChild from './CompletionArrayChild.vue'
import CompletionObjectChild from './CompletionObjectChild.vue'
export default {
  components: { CompletionArrayChild, CompletionObjectChild },
  provide: {
    middleService: {},
  },
}
</script>`
    const parentContent = `
<template>
  <CompletionMiddle />
</template>
<script>
import CompletionMiddle from './CompletionMiddle.vue'
export default {
  components: { CompletionMiddle },
  provide: {
    localService: {},
  },
}
</script>`
    const localIndex = new WorkspaceIndex()
    localIndex.setWorkspaceVueVersion(fixtureRoot, 2)
    localIndex.indexContent(unrelatedUri, unrelatedContent)
    localIndex.indexContent(arrayChildUri, arrayChildContent)
    localIndex.indexContent(objectChildUri, objectChildContent)
    localIndex.indexContent(middleUri, middleContent)
    localIndex.indexContent(parentUri, parentContent)
    const completionProvider = new VueCompletionProvider(localIndex)
    const arrayDocument = new TestDocument(arrayChildUri, arrayChildContent) as any
    const objectDocument = new TestDocument(objectChildUri, objectChildContent) as any

    const arrayCompletions = completionProvider.provideCompletionItems(arrayDocument, positionAt(arrayChildContent, arrayChildContent.indexOf("''") + 1)) as any[]
    const fromCompletions = completionProvider.provideCompletionItems(objectDocument, positionAt(objectChildContent, objectChildContent.indexOf("from: ''") + "from: '".length)) as any[]
    const keyCompletions = completionProvider.provideCompletionItems(objectDocument, positionAt(objectChildContent, objectChildContent.indexOf("'':") + 1)) as any[]
    const nonInjectCompletions = completionProvider.provideCompletionItems(arrayDocument, positionAt(arrayChildContent, arrayChildContent.indexOf("'CompletionArrayChild'") + 2))

    expect(arrayCompletions.map((item) => item.label)).toEqual(['middleService', 'localService'])
    expect(fromCompletions.map((item) => item.label)).toEqual(['middleService', 'localService'])
    expect(keyCompletions.map((item) => item.label)).toEqual(['middleService', 'localService'])
    expect(nonInjectCompletions).toBeUndefined()
  })

  it('inject provider 超过 5 个时只展示前 5 个并提供完整列表入口', () => {
    const consumerUri = path.join(fixtureRoot, 'ManyProviderConsumer.vue')
    const consumerContent = `
<template><div /></template>
<script>
export default {
  inject: ['service'],
}
</script>
`
    index.indexContent(consumerUri, consumerContent)
    for (let count = 0; count < 6; count += 1) {
      index.indexContent(path.join(fixtureRoot, `ManyProvider${count}.vue`), `
<template><ManyProviderConsumer /></template>
<script>
import ManyProviderConsumer from './ManyProviderConsumer.vue'
export default {
  components: { ManyProviderConsumer },
  provide: {
    service: this.service,
  },
}
</script>
`)
    }

    const document = new TestDocument(consumerUri, consumerContent) as any
    const hoverProvider = new VueHoverProvider(index)
    const hover = hoverProvider.provideHover(document, positionAt(consumerContent, consumerContent.indexOf("'service'") + 2)) as any

    expect(hoverText(hover)).toContain('Provided by 6 definitions')
    expect(hoverText(hover)).toContain('Show all 6 definitions')
    expect(hoverText(hover)).toContain('- [ManyProvider0.vue:8]')
    expect(hoverText(hover)).toContain('- [ManyProvider4.vue:8]')
    expect(hoverText(hover)).not.toContain('- [ManyProvider5.vue]')
    expect(hover.contents.isTrusted).toEqual({ enabledCommands: ['vueComponentNavigator.showUsages'] })
  })

  it('$emit 使用位置超过 5 个时才启用 command trusted hover', () => {
    for (let count = 0; count < 4; count += 1) {
      index.indexContent(path.join(fixtureRoot, `ExtraParent${count}.vue`), `
<template>
  <Child @save="onSave${count}" />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child }, methods: { onSave${count}() {} } }
</script>
`)
    }

    const content = readFixture('Child.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Child.vue'), content) as any
    const hoverProvider = new VueHoverProvider(index)
    const emitOffset = content.indexOf("'save'") + 2

    const hover = hoverProvider.provideHover(document, positionAt(content, emitOffset)) as any

    expect(hoverText(hover)).toContain('Used by 6 listeners')
    expect(hoverText(hover)).toContain('Show all 6 listeners')
    expect(hover.contents.isTrusted).toEqual({ enabledCommands: ['vueComponentNavigator.showUsages'] })
  })

  it('Markdown 文档内容不会启用命令信任', () => {
    const parentContent = `
<template>
  <InjectedChild ref="child" />
</template>
<script>
import InjectedChild from './InjectedChild.vue'
export default {
  components: { InjectedChild },
  methods: {
    callChild() {
      this.$refs.child.injected()
    },
  },
}
</script>
`
    const childContent = `
<template><div /></template>
<script>
export default {
  name: 'InjectedChild',
  methods: {
    /**
     * [click](command:evil) \`\`\`js
     * @param {string} source - [run](command:bad)
     */
    injected(source) {},
  },
}
</script>
`
    const parentPath = path.join(fixtureRoot, 'InjectedParent.vue')
    const childPath = path.join(fixtureRoot, 'InjectedChild.vue')
    index.indexContent(childPath, childContent)
    index.indexContent(parentPath, parentContent)
    const document = new TestDocument(parentPath, parentContent) as any
    const hoverProvider = new VueHoverProvider(index)
    const completionProvider = new VueCompletionProvider(index)
    const methodOffset = parentContent.indexOf('injected()') + 1
    const completionOffset = parentContent.indexOf('this.$refs.child.') + 'this.$refs.child.'.length

    const hover = hoverProvider.provideHover(document, positionAt(parentContent, methodOffset)) as any
    const completions = completionProvider.provideCompletionItems(document, positionAt(parentContent, completionOffset)) as any[]
    const documentation = markdownText(completions.find((item) => item.label === 'injected')?.documentation)

    expect(hoverText(hover)).toContain('\\[click\\]\\(command:evil\\)')
    expect(hoverText(hover)).toContain('\\`\\`\\`js')
    expect(hoverText(hover)).toContain('*@param* `source` `{string}` — \\[run\\]\\(command:bad\\)')
    expect(hover.contents.isTrusted).toBe(false)
    expect(documentation).toContain('\\[click\\]\\(command:evil\\)')
    expect(documentation).toContain('\\`\\`\\`js')
    expect(documentation).toContain('*@param* `source` `{string}` — \\[run\\]\\(command:bad\\)')
  })

  it('真实引用只返回可证明的关系', () => {
    const content = readFixture('Child.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Child.vue'), content) as any
    const provider = new VueReferenceProvider(index)
    const methodOffset = content.indexOf('open(source)') + 1
    const propOffset = content.indexOf('title: String') + 1
    const emitOffset = content.indexOf("'save'") + 2

    expect((provider.provideReferences(document, positionAt(content, methodOffset)) as any[])).toHaveLength(2)
    expect((provider.provideReferences(document, positionAt(content, propOffset)) as any[])).toHaveLength(1)
    expect((provider.provideReferences(document, positionAt(content, emitOffset)) as any[])).toHaveLength(2)
  })

  it('prop 和 $refs 方法定义处支持跳到静态引用点', () => {
    const content = readFixture('Child.vue')
    const document = new TestDocument(path.join(fixtureRoot, 'Child.vue'), content) as any
    const provider = new VueDefinitionProvider(index)
    const methodOffset = content.indexOf('open(source)') + 1
    const propOffset = content.indexOf('title: String') + 1

    const methodDefinitions = provider.provideDefinition(document, positionAt(content, methodOffset)) as any[]
    const propDefinitions = provider.provideDefinition(document, positionAt(content, propOffset)) as any[]

    expect(methodDefinitions.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'Parent.vue'))
    expect(propDefinitions.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'Parent.vue'))
  })

  it('mixin 中的 prop 和 $refs 方法定义处支持跳到静态引用点', () => {
    const mixinContent = readFixture('MixinVueSource.vue')
    const mixinDocument = new TestDocument(path.join(fixtureRoot, 'MixinVueSource.vue'), mixinContent) as any
    const provider = new VueDefinitionProvider(index)

    const methodDefinitions = provider.provideDefinition(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('vueMixedMethod') + 1)) as any[]
    const propDefinitions = provider.provideDefinition(mixinDocument, positionAt(mixinContent, mixinContent.indexOf('vueMixedTitle') + 1)) as any[]

    expect(methodDefinitions.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'MixinVueParent.vue'))
    expect(propDefinitions.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'MixinVueParent.vue'))
  })

  it('mixin 源导出处支持反查继承和混入它的组件', () => {
    const mixinUri = path.join(fixtureRoot, 'mixin-default.js')
    const mixinContent = readFixture('mixin-default.js')
    const mixinDocument = new TestDocument(mixinUri, mixinContent, 'javascript') as any
    const definitionProvider = new VueDefinitionProvider(index)
    const referenceProvider = new VueReferenceProvider(index)
    const hoverProvider = new VueHoverProvider(index)
    const exportOffset = mixinContent.indexOf('export default') + 1

    const definitions = definitionProvider.provideDefinition(mixinDocument, positionAt(mixinContent, exportOffset)) as any[]
    const references = referenceProvider.provideReferences(mixinDocument, positionAt(mixinContent, exportOffset)) as any[]
    const hover = hoverProvider.provideHover(mixinDocument, positionAt(mixinContent, exportOffset)) as any

    expect(definitions.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'MixinChild.vue'))
    expect(references.map((item) => item.uri.fsPath)).toContain(path.join(fixtureRoot, 'MixinChild.vue'))
    expect(hoverText(hover)).toContain('Used by 1 component')
    expect(hoverText(hover)).toContain('MixinChild.vue')
  })

  it('动态组件候选中的 mixin emit 支持跳到父模板监听', () => {
    const localIndex = new WorkspaceIndex()
    localIndex.setWorkspaceVueVersion(fixtureRoot, 2)
    const mixinPath = path.join(fixtureRoot, 'mixin-default.js')
    const normalPath = path.join(fixtureRoot, 'ProviderDynamicNormal.vue')
    const bigPath = path.join(fixtureRoot, 'ProviderDynamicBig.vue')
    const parentPath = path.join(fixtureRoot, 'ProviderDynamicHost.vue')
    const childContent = `
<template><div /></template>
<script>
import baseMixin from './mixin-default'
export default { mixins: [baseMixin] }
</script>
`
    const parentContent = `
<template>
  <component :is="SCREEN_TYPE[themeType]" @mixed-save="onMixedSave" />
</template>
<script>
import ProviderDynamicNormal from './ProviderDynamicNormal.vue'
import ProviderDynamicBig from './ProviderDynamicBig.vue'

const SCREEN_TYPE = {
  1: 'ProviderDynamicNormal',
  2: 'ProviderDynamicBig',
}

export default {
  components: { ProviderDynamicNormal, ProviderDynamicBig },
  data() {
    return { SCREEN_TYPE }
  },
}
</script>
`
    localIndex.indexContent(parentPath, parentContent)
    localIndex.indexContent(normalPath, childContent)
    localIndex.indexContent(bigPath, childContent)

    const mixinContent = readFixture('mixin-default.js')
    const parentDocument = new TestDocument(parentPath, parentContent) as any
    const mixinDocument = new TestDocument(mixinPath, mixinContent, 'javascript') as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const emitOffset = mixinContent.indexOf("'mixed-save'") + 2
    const componentTagOffset = parentContent.indexOf('<component') + 2
    const dynamicExpressionOffset = parentContent.indexOf('SCREEN_TYPE') + 1

    const definitions = definitionProvider.provideDefinition(mixinDocument, positionAt(mixinContent, emitOffset)) as any[]
    const references = referenceProvider.provideReferences(mixinDocument, positionAt(mixinContent, emitOffset)) as any[]
    const hover = hoverProvider.provideHover(mixinDocument, positionAt(mixinContent, emitOffset)) as any
    const tagDefinitions = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, componentTagOffset)) as any[]
    const expressionDefinitions = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, dynamicExpressionOffset)) as any[]
    const tagHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, componentTagOffset)) as any
    const expressionHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, dynamicExpressionOffset)) as any

    expect(definitions).toHaveLength(1)
    expect(definitions[0].uri.fsPath).toBe(parentPath)
    expect(references).toHaveLength(1)
    expect(references[0].uri.fsPath).toBe(parentPath)
    expect(hoverText(hover)).toContain('Used by 1 listener')
    expect(hoverText(hover)).toContain('[ProviderDynamicHost.vue:')
    expect(tagDefinitions.map((item) => item.uri.fsPath).sort()).toEqual([bigPath, normalPath].sort())
    expect(expressionDefinitions.map((item) => item.uri.fsPath).sort()).toEqual([bigPath, normalPath].sort())
    expect(hoverText(tagHover)).toContain('ProviderDynamicNormal.vue')
    expect(hoverText(tagHover)).toContain('ProviderDynamicBig.vue')
    expect(hoverText(expressionHover)).toContain('ProviderDynamicNormal.vue')
    expect(hoverText(expressionHover)).toContain('ProviderDynamicBig.vue')
  })

  it('动态组件候选中的 template $emit 支持跳到父模板监听', () => {
    const localIndex = new WorkspaceIndex()
    localIndex.setWorkspaceVueVersion(fixtureRoot, 2)
    const categoryPath = path.join(fixtureRoot, 'ProviderCategoryList.vue')
    const channelPath = path.join(fixtureRoot, 'ProviderChannelList.vue')
    const parentPath = path.join(fixtureRoot, 'ProviderTernaryDynamicHost.vue')
    const categoryContent = `
<template><button @click="$emit('onAddToCart')" /></template>
<script>
export default {}
</script>
`
    const channelContent = `
<template><ProductItem @onClick="$emit('onAddToCart', item)" /></template>
<script>
export default {}
</script>
`
    const parentContent = `
<template>
  <component :is="isCategoryMode ? 'ProviderCategoryList' : 'ProviderChannelList'" @onAddToCart="addToCartFromCard" />
</template>
<script>
import ProviderCategoryList from './ProviderCategoryList.vue'
import ProviderChannelList from './ProviderChannelList.vue'

export default {
  components: { ProviderCategoryList, ProviderChannelList },
}
</script>
`
    localIndex.indexContent(parentPath, parentContent)
    localIndex.indexContent(categoryPath, categoryContent)
    localIndex.indexContent(channelPath, channelContent)
    const parentDocument = new TestDocument(parentPath, parentContent) as any
    const channelDocument = new TestDocument(channelPath, channelContent) as any
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentEventOffset = parentContent.indexOf('@onAddToCart') + 1
    const emitOffset = channelContent.indexOf("'onAddToCart'") + 2

    const definitions = definitionProvider.provideDefinition(channelDocument, positionAt(channelContent, emitOffset)) as any[]
    const references = referenceProvider.provideReferences(channelDocument, positionAt(channelContent, emitOffset)) as any[]
    const hover = hoverProvider.provideHover(channelDocument, positionAt(channelContent, emitOffset)) as any
    const parentHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, parentEventOffset)) as any

    expect(definitions).toHaveLength(1)
    expect(definitions[0].uri.fsPath).toBe(parentPath)
    expect(references).toHaveLength(1)
    expect(references[0].uri.fsPath).toBe(parentPath)
    expect(hoverText(hover)).toContain('Used by 1 listener')
    expect(hoverText(hover)).toContain('[ProviderTernaryDynamicHost.vue:')
    expect(hoverText(parentHover)).toContain('Definitions:')
    expect(hoverText(parentHover)).toContain('ProviderCategoryList.vue')
    expect(hoverText(parentHover)).toContain('ProviderChannelList.vue')
    expect(parentHover.contents.isTrusted).toBe(false)
  })

  it('动态 ref 方法悬浮展示所有候选定义', () => {
    const localIndex = new WorkspaceIndex()
    localIndex.setWorkspaceVueVersion(fixtureRoot, 2)
    const firstPath = path.join(fixtureRoot, 'DynamicRefFirst.vue')
    const secondPath = path.join(fixtureRoot, 'DynamicRefSecond.vue')
    const parentPath = path.join(fixtureRoot, 'DynamicRefHost.vue')
    const firstContent = `
<template><div /></template>
<script>
export default {
  methods: {
    open() {},
  },
}
</script>
`
    const secondContent = `
<template><div /></template>
<script>
export default {
  methods: {
    open() {},
  },
}
</script>
`
    const parentContent = `
<template>
  <component :is="kind === 'first' ? 'DynamicRefFirst' : 'DynamicRefSecond'" ref="screen" />
</template>
<script>
import DynamicRefFirst from './DynamicRefFirst.vue'
import DynamicRefSecond from './DynamicRefSecond.vue'

export default {
  components: { DynamicRefFirst, DynamicRefSecond },
  methods: {
    callScreen() {
      this.$refs.screen.open()
    },
  },
}
</script>
`
    localIndex.indexContent(firstPath, firstContent)
    localIndex.indexContent(secondPath, secondContent)
    localIndex.indexContent(parentPath, parentContent)
    const document = new TestDocument(parentPath, parentContent) as any
    const hoverProvider = new VueHoverProvider(localIndex)

    const hover = hoverProvider.provideHover(document, positionAt(parentContent, parentContent.indexOf('open()') + 1)) as any

    expect(hoverText(hover)).toContain('Definitions:')
    expect(hoverText(hover)).toContain('DynamicRefFirst.vue')
    expect(hoverText(hover)).toContain('DynamicRefSecond.vue')
    expect(hoverText(hover)).not.toContain('```')
    expect(hover.contents.isTrusted).toBe(false)
  })

  it('多个消费组件展开同一个 mixin $refs 调用时 hover 使用位置去重', () => {
    const innerContent = readFixture('MixinInner.vue')
    const extraConsumerUri = path.join(fixtureRoot, 'MixinChildClone.vue')
    const extraConsumerContent = `
<template>
  <MixinInner ref="inner" />
</template>
<script>
import baseMixin from './mixin-default'
import MixinInner from './MixinInner.vue'
export default {
  components: { MixinInner },
  mixins: [baseMixin],
}
</script>`
    index.indexContent(extraConsumerUri, extraConsumerContent)
    const document = new TestDocument(path.join(fixtureRoot, 'MixinInner.vue'), innerContent) as any
    const hoverProvider = new VueHoverProvider(index)

    const hover = hoverProvider.provideHover(document, positionAt(innerContent, innerContent.indexOf('focus') + 1)) as any

    expect(hoverText(hover)).toContain('Used by 1 ref method')
    expect(hoverText(hover).match(/- \[mixin-default\.js:/g)).toHaveLength(1)
  })

  it('Vue3 props 类型、内部使用和 emits 的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-providers-'))
    const typeUri = path.join(root, 'src/components/confirm-dialog/type.ts')
    const childUri = path.join(root, 'src/components/confirm-dialog/index.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const typeContent = `
export type ConfirmDialogProps = {
  show: boolean
  /** 确认之前的回调 */
  beforeConfirm?: () => Promise<boolean> | boolean | void
  title?: string
}
`
    const childContent = `
<template>
  <div>{{ title }} {{ props.beforeConfirm }}</div>
</template>
<script setup lang="ts">
import type { ConfirmDialogProps } from './type'

const props = defineProps<ConfirmDialogProps>()
const emit = defineEmits<{
  confirm: []
}>()

const submit = async () => {
  if (props.beforeConfirm) {
    await props.beforeConfirm()
  }
  emit('confirm')
}
</script>
`
    const parentContent = `
<template>
  <ConfirmDialog :beforeConfirm="beforeConfirm" @confirm="onConfirm" />
</template>
<script setup lang="ts">
import ConfirmDialog from './components/confirm-dialog/index.vue'
const beforeConfirm = () => true
const onConfirm = () => {}
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.4.0' } }))
    writeText(typeUri, typeContent)
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const childDocument = new TestDocument(childUri, childContent) as any
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const typeDocument = new TestDocument(typeUri, typeContent, 'typescript') as any

    const propDefinition = definitionProvider.provideDefinition(childDocument, positionAt(childContent, childContent.indexOf('beforeConfirm') + 1)) as any
    const propReferences = referenceProvider.provideReferences(typeDocument, positionAt(typeContent, typeContent.indexOf('beforeConfirm') + 1)) as any[]
    const propHover = hoverProvider.provideHover(typeDocument, positionAt(typeContent, typeContent.indexOf('beforeConfirm') + 1)) as any
    const typeDefinition = definitionProvider.provideDefinition(childDocument, positionAt(childContent, childContent.lastIndexOf('ConfirmDialogProps') + 1)) as any
    const templatePropDefinition = asArray(definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf(':beforeConfirm') + 2)) as any)
    const templatePropHover = hoverProvider.provideHover(parentDocument, positionAt(parentContent, parentContent.indexOf(':beforeConfirm') + 2)) as any
    const eventDefinition = asArray(definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('@confirm') + 1)) as any)

    expect(propDefinition.uri.fsPath).toBe(typeUri)
    expect(propDefinition.range.start.line).toBeGreaterThan(0)
    expect(propReferences.map((location) => location.uri.fsPath)).toEqual([parentUri, childUri, childUri, childUri])
    expect(hoverText(propHover)).toContain('Used by 4 prop usages')
    expect(hoverText(propHover)).toContain('Parent.vue:3')
    expect(typeDefinition.uri.fsPath).toBe(typeUri)
    expect(templatePropDefinition.map((location) => location.uri.fsPath)).toEqual([typeUri])
    expect(hoverText(templatePropHover)).toContain('Definition')
    expect(hoverText(templatePropHover)).toContain('beforeConfirm')
    expect(eventDefinition.map((location) => location.uri.fsPath)).toEqual([childUri])
  })

  it('Vue3 defineModel、defineSlots 和 defineExpose 的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-component-contract-providers-'))
    const childUri = path.join(root, 'src/Child.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<template><section /></template>
<script setup lang="ts">
defineModel<boolean>('visible')

defineSlots<{
  footer?: () => any
}>()

function open() {}

defineExpose({ open })
</script>
`
    const parentContent = `
<template>
  <Child ref="childRef" v-model:visible="visible">
    <template #footer>Footer</template>
  </Child>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import Child from './Child.vue'

const visible = ref(false)
const childRef = ref<InstanceType<typeof Child>>()

childRef.value?.open()
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const childDocument = new TestDocument(childUri, childContent) as any
    const parentDocument = new TestDocument(parentUri, parentContent) as any

    const modelReferences = referenceProvider.provideReferences(childDocument, positionAt(childContent, childContent.indexOf("'visible'") + 1)) as any[]
    const modelDefinition = asArray(definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('v-model:visible') + 'v-model:'.length + 1)) as any)
    const slotReferences = referenceProvider.provideReferences(childDocument, positionAt(childContent, childContent.indexOf('footer') + 1)) as any[]
    const slotDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('#footer') + 1)) as any
    const slotHover = hoverProvider.provideHover(childDocument, positionAt(childContent, childContent.indexOf('footer') + 1)) as any
    const exposeReferences = referenceProvider.provideReferences(childDocument, positionAt(childContent, childContent.indexOf('open()') + 1)) as any[]
    const exposeHover = hoverProvider.provideHover(childDocument, positionAt(childContent, childContent.indexOf('open()') + 1)) as any

    expect(modelReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(modelDefinition.map((location) => location.uri.fsPath)).toEqual([childUri])
    expect(slotReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(slotDefinition.uri.fsPath).toBe(childUri)
    expect(hoverText(slotHover)).toContain('Used by 1 slot usage')
    expect(exposeReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(exposeHover)).toContain('Used by 1 ref method')
  })

  it('Vue3 defineExpose composable 转发的 ref 方法 hover 可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-expose-composable-forward-hover-'))
    const commonListUri = path.join(root, 'src/components/common-list/index.vue')
    const forwardUri = path.join(root, 'src/components/common-list/hooks/use-forward-list-ref.ts')
    const productListUri = path.join(root, 'src/ProductList.vue')
    const pageUri = path.join(root, 'src/Page.vue')
    const commonListContent = `
<template><section /></template>
<script setup lang="ts" generic="T extends Record<string, any>, R extends Record<string, any>, K extends keyof R = 'list'">
type ListRef<T extends Record<string, any>> = {
  onRefresh: (params?: T, refreshing?: boolean) => void
  onLoad: (params?: T) => void
}

defineExpose<ListRef<T>>({
  onRefresh: (params?: T) => {
    return params
  },
  onLoad: (params?: T) => {
    return params
  },
})
</script>
`
    const pageContent = `
<template>
  <ProductList ref="listRef" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import ProductList from './ProductList.vue'

const listRef = ref()

listRef.value?.onRefresh({})
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(commonListUri, commonListContent)
    writeText(forwardUri, `
import type { Ref } from 'vue'

type ListRef<T extends Record<string, any>> = {
  onRefresh: (params?: T, refreshing?: boolean) => void
  onLoad: (params?: T) => void
}

export const useForwardListRef = <T extends Record<string, any>>(
  targetRef: Ref<ListRef<T> | undefined>,
): ListRef<T> => ({
  onLoad: params => targetRef.value?.onLoad(params),
  onRefresh: (params, refreshing) => targetRef.value?.onRefresh(params, refreshing),
})
`)
    writeText(productListUri, `
<template>
  <CommonList ref="listRef" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import CommonList from './components/common-list/index.vue'
import { useForwardListRef } from './components/common-list/hooks/use-forward-list-ref'

const listRef = ref()

defineExpose(useForwardListRef(listRef))
</script>
`)
    writeText(pageUri, pageContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const document = new TestDocument(commonListUri, commonListContent) as any
    const pageDocument = new TestDocument(pageUri, pageContent) as any
    const hover = hoverProvider.provideHover(document, positionAt(commonListContent, commonListContent.lastIndexOf('onRefresh:') + 1)) as any
    const usageHover = hoverProvider.provideHover(pageDocument, positionAt(pageContent, pageContent.indexOf('onRefresh') + 1)) as any
    const usageDefinition = definitionProvider.provideDefinition(pageDocument, positionAt(pageContent, pageContent.indexOf('onRefresh') + 1)) as any

    expect(hoverText(hover)).toContain('Used by 1 ref method')
    expect(hoverText(hover)).toContain('[Page.vue:')
    expect(hoverText(hover)).not.toContain('[ProductList.vue:')
    expect(hoverText(usageHover)).toContain('onRefresh(params?: T)')
    expect(hoverText(usageHover)).toContain('Definition:')
    expect(usageDefinition.uri.fsPath).toBe(commonListUri)
  })

  it('Vue3 template slot、useTemplateRef 泛型和 TSX 命令式 ref 的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-real-ref-provider-'))
    const buttonUri = path.join(root, 'src/components/common-button/index.vue')
    const numberPadUri = path.join(root, 'src/pages/components/number-pad/index.vue')
    const dialogUri = path.join(root, 'src/pages/components/coin-out-dialog/index.vue')
    const parentUri = path.join(root, 'src/pages/home/components/member-store-take-coin-dialog/index.vue')
    const commandUri = path.join(root, 'src/pages/components/coin-out-dialog/command.tsx')

    const buttonContent = `
<template>
  <button>
    <slot name="left-icon"></slot>
  </button>
</template>
<script setup lang="ts">
const reset = () => {}

defineExpose({
  reset,
})
</script>
`
    const numberPadContent = `
<template><div /></template>
<script setup lang="ts">
defineExpose({
  resetInput() {},
})
</script>
`
    const dialogContent = `
<template><section /></template>
<script setup lang="ts">
type CoinOutOptions = { coinNum: number }

async function open(props: CoinOutOptions) {
  return props.coinNum
}

defineExpose({
  open,
})
</script>
`
    const parentContent = `
<template>
  <CommonButton ref="buttonRef">
    <template #left-icon>
      <i />
    </template>
  </CommonButton>
  <NumberPad ref="numberPadRef" />
</template>
<script setup lang="ts">
import { ref, useTemplateRef } from 'vue'
import CommonButton from '../../../../components/common-button/index.vue'
import NumberPad from '../../../components/number-pad/index.vue'

const buttonRef = ref<InstanceType<typeof CommonButton>>()
const numberPadRef = useTemplateRef<InstanceType<typeof NumberPad>>('numberPadRef')

buttonRef.value?.reset()
numberPadRef.value?.resetInput()
</script>
`
    const commandContent = `
import type { App } from 'vue'
import { createApp, h } from 'vue'
import CoinOutDialog from './index.vue'

class CoinOutDialogManager {
  private app: App<Element> | null = null
  private container: HTMLElement | null = null
  private instance: { open: (options: { coinNum: number }) => number } | null = null

  public create() {
    this.app = createApp({
      render() {
        return h(CoinOutDialog, {
          ref: 'dialogRef',
        })
      },
    })
    const vm = this.app.mount(this.container!)
    this.instance = vm.$refs.dialogRef as { open: (options: { coinNum: number }) => number }

    return this.instance.open({ coinNum: 1 })
  }
}
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(buttonUri, buttonContent)
    writeText(numberPadUri, numberPadContent)
    writeText(dialogUri, dialogContent)
    writeText(parentUri, parentContent)
    writeText(commandUri, commandContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const buttonDocument = new TestDocument(buttonUri, buttonContent) as any
    const dialogDocument = new TestDocument(dialogUri, dialogContent) as any
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const commandDocument = new TestDocument(commandUri, commandContent, 'typescriptreact') as any

    const slotReferences = referenceProvider.provideReferences(buttonDocument, positionAt(buttonContent, buttonContent.indexOf('left-icon') + 1)) as any[]
    const exposeReferences = referenceProvider.provideReferences(buttonDocument, positionAt(buttonContent, buttonContent.indexOf('reset,') + 1)) as any[]
    const exposeHover = hoverProvider.provideHover(buttonDocument, positionAt(buttonContent, buttonContent.indexOf('reset,') + 1)) as any
    const dialogExposeHover = hoverProvider.provideHover(dialogDocument, positionAt(dialogContent, dialogContent.indexOf('open(') + 1)) as any
    const dialogPublicExposeHover = hoverProvider.provideHover(dialogDocument, positionAt(dialogContent, dialogContent.indexOf('open,') + 1)) as any
    const resetDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('reset()') + 1)) as any
    const resetInputDefinition = definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('resetInput()') + 1)) as any
    const commandDefinition = definitionProvider.provideDefinition(commandDocument, positionAt(commandContent, commandContent.indexOf('open({') + 1)) as any

    expect(slotReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(exposeReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(exposeHover)).toContain('Used by 1 ref method')
    expect(hoverText(dialogExposeHover)).toContain('Used by 1 ref method')
    expect(hoverText(dialogExposeHover)).toContain('[command.tsx:')
    expect(hoverText(dialogExposeHover)).not.toContain('  \n  open')
    expect(hoverText(dialogPublicExposeHover)).toContain('Used by 1 ref method')
    expect(hoverText(dialogPublicExposeHover)).toContain('[command.tsx:')
    expect(hoverText(dialogPublicExposeHover)).not.toContain('  \n  open')
    expect(resetDefinition.uri.fsPath).toBe(buttonUri)
    expect(resetInputDefinition.uri.fsPath).toBe(numberPadUri)
    expect(commandDefinition.uri.fsPath).toBe(dialogUri)
  })

  it('Vue3 provide/inject 支持带泛型的静态字符串 key', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provide-inject-'))
    const providerUri = path.join(root, 'src/pages/components/member-login/index.vue')
    const positiveUri = path.join(root, 'src/pages/components/member-login/components/positive-scan.vue')
    const readCardUri = path.join(root, 'src/pages/components/member-login/components/read-card.vue')
    const providerContent = `
<template>
  <ReadCard />
  <PositiveScan />
</template>
<script setup lang="ts">
import PositiveScan from './components/positive-scan.vue'
import ReadCard from './components/read-card.vue'
import { provide } from 'vue'

const handleFetchStart = (type: string) => {
  return type
}

provide('handleFetchStart', handleFetchStart)
</script>
`
    const positiveContent = `
<template><button /></template>
<script setup lang="ts">
import { inject } from 'vue'

const handleFetchStart =
  inject<(type: string) => void>('handleFetchStart')

handleFetchStart?.('positive')
</script>
`
    const readCardContent = `
<template><button /></template>
<script setup lang="ts">
import { inject } from 'vue'

const handleFetchStart =
  inject<(type: string) => void>('handleFetchStart')

handleFetchStart?.('read')
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(providerUri, providerContent)
    writeText(positiveUri, positiveContent)
    writeText(readCardUri, readCardContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const providerDocument = new TestDocument(providerUri, providerContent) as any
    const positiveDocument = new TestDocument(positiveUri, positiveContent) as any
    const readCardDocument = new TestDocument(readCardUri, readCardContent) as any
    const providerFile = localIndex.getFile(providerUri)!
    const positiveFile = localIndex.getFile(positiveUri)!
    const readCardFile = localIndex.getFile(readCardUri)!

    const localDefinition = definitionProvider.provideDefinition(readCardDocument, positionAt(readCardContent, readCardContent.indexOf('handleFetchStart') + 1)) as any[]
    const keyDefinitions = asArray(definitionProvider.provideDefinition(providerDocument, positionAt(providerContent, providerContent.indexOf("'handleFetchStart'") + 2)) as any)
    const keyReferences = referenceProvider.provideReferences(providerDocument, positionAt(providerContent, providerContent.indexOf("'handleFetchStart'") + 2)) as any[]
    const providerHover = hoverProvider.provideHover(providerDocument, positionAt(providerContent, providerContent.indexOf("'handleFetchStart'") + 2)) as any
    const injectHover = hoverProvider.provideHover(positiveDocument, positionAt(positiveContent, positiveContent.indexOf("'handleFetchStart'") + 2)) as any

    expect(providerFile.scriptIndex.provides.map((provide) => provide.key)).toEqual(['handleFetchStart'])
    expect(positiveFile.scriptIndex.injects.map((inject) => [inject.localName, inject.key])).toEqual([['handleFetchStart', 'handleFetchStart']])
    expect(readCardFile.scriptIndex.injects.map((inject) => [inject.localName, inject.key])).toEqual([['handleFetchStart', 'handleFetchStart']])
    expect(localIndex.findInjectUsages(providerUri, 'handleFetchStart').map((usage) => usage.file.uri).sort()).toEqual([positiveUri, readCardUri].sort())
    expect(localDefinition.map((location) => location.uri.fsPath)).toEqual([providerUri])
    expect(keyDefinitions.map((location) => location.uri.fsPath).sort()).toEqual([positiveUri, readCardUri].sort())
    expect(keyReferences.map((location) => location.uri.fsPath).sort()).toEqual([positiveUri, readCardUri].sort())
    expect(hoverText(providerHover)).toContain('Injected by 2 consumers')
    expect(hoverText(injectHover)).toContain('Provided by 1 definition')
  })

  it('Vue3 v-model 事件声明和 InjectionKey 的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provider-static-features-'))
    const keyUri = path.join(root, 'src/keys.ts')
    const childUri = path.join(root, 'src/Child.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const providerUri = path.join(root, 'src/Provider.vue')
    const consumerUri = path.join(root, 'src/Consumer.vue')
    const keyContent = `
import type { InjectionKey } from 'vue'

interface Service {
  ready: boolean
}

export const serviceKey: InjectionKey<Service> = Symbol('service')
`
    const childContent = `
<template>
  <button>{{ props.inlineTitle }}</button>
</template>
<script setup lang="ts">
const props = defineProps<{
  inlineTitle?: string
  show: boolean
}>()

const emit = defineEmits<{
  declared: []
  'update:show': [value: boolean]
}>()

function close() {
  emit('update:show', false)
}
</script>
`
    const parentContent = `
<template>
  <Child v-model:show="show" inline-title="hello" @declared="onDeclared" />
</template>
<script setup lang="ts">
import Child from './Child.vue'

const show = ref(false)
const onDeclared = () => {}
</script>
`
    const providerContent = `
<template><Consumer /></template>
<script setup lang="ts">
import Consumer from './Consumer.vue'
import { serviceKey } from './keys'

provide(serviceKey, { ready: true })
</script>
`
    const consumerContent = `
<template><div /></template>
<script setup lang="ts">
import { serviceKey as injectedServiceKey } from './keys'

const service = inject(injectedServiceKey)
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(keyUri, keyContent)
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)
    writeText(providerUri, providerContent)
    writeText(consumerUri, consumerContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const childDocument = new TestDocument(childUri, childContent) as any
    const providerDocument = new TestDocument(providerUri, providerContent) as any
    const consumerDocument = new TestDocument(consumerUri, consumerContent) as any
    const keyDocument = new TestDocument(keyUri, keyContent, 'typescript') as any

    const modelDefinition = asArray(definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('v-model:show') + 'v-model:'.length + 1)) as any)
    const declaredDefinition = asArray(definitionProvider.provideDefinition(parentDocument, positionAt(parentContent, parentContent.indexOf('@declared') + 2)) as any)
    const updateDefinitions = asArray(definitionProvider.provideDefinition(childDocument, positionAt(childContent, childContent.lastIndexOf("'update:show'") + 2)) as any)
    const injectDefinitions = asArray(definitionProvider.provideDefinition(consumerDocument, positionAt(consumerContent, consumerContent.lastIndexOf('injectedServiceKey') + 1)) as any)
    const provideDefinitions = asArray(definitionProvider.provideDefinition(providerDocument, positionAt(providerContent, providerContent.lastIndexOf('serviceKey') + 1)) as any)
    const keyReferences = referenceProvider.provideReferences(keyDocument, positionAt(keyContent, keyContent.indexOf('serviceKey') + 1)) as any[]
    const keyHover = hoverProvider.provideHover(keyDocument, positionAt(keyContent, keyContent.indexOf('serviceKey') + 1)) as any

    expect(modelDefinition.map((location) => location.uri.fsPath)).toEqual([childUri])
    expect(declaredDefinition.map((location) => location.uri.fsPath)).toEqual([childUri])
    expect(updateDefinitions.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(injectDefinitions.map((location) => location.uri.fsPath)).toEqual([providerUri])
    expect(provideDefinitions.map((location) => location.uri.fsPath)).toEqual([consumerUri])
    expect(keyReferences.map((location) => location.uri.fsPath)).toEqual([consumerUri])
    expect(hoverText(keyHover)).toContain('Provided by 1 definition')
  })

  it('Vue2 v-on $listeners 透传事件的 provider 关系可用', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue2-provider-forwarded-listeners-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const wrapperUri = path.join(root, 'src/GoodsDetail.vue')
    const physicalUri = path.join(root, 'src/PhysicalGoodsDetail.vue')
    const virtualUri = path.join(root, 'src/VirtualGoodsDetail.vue')
    const parentUri = path.join(root, 'src/GoodsAdd.vue')
    const wrapperContent = `
<template>
  <component :is="compName" v-bind="$attrs" v-on="$listeners"></component>
</template>
<script>
import PhysicalGoodsDetail from './PhysicalGoodsDetail.vue'
import VirtualGoodsDetail from './VirtualGoodsDetail.vue'

export default {
  components: {
    PhysicalGoodsDetail,
    VirtualGoodsDetail,
  },
  data() {
    const goodsClassify = {
      20101: 'PhysicalGoodsDetail',
      20102: 'VirtualGoodsDetail',
    }
    return {
      compName: goodsClassify[this.classifyId],
    }
  },
}
</script>
`
    const physicalContent = `
<script>
export default {
  props: {
    operateType: String,
  },
  methods: {
    save() {
      this.$emit('saveSuccess')
    },
  },
}
</script>
`
    const virtualContent = physicalContent
    const parentContent = `
<template>
  <goods-detail classify-id="20101" operate-type="add" @saveSuccess="handleSaveSuccess"></goods-detail>
</template>
<script>
import GoodsDetail from './GoodsDetail.vue'

export default {
  components: { GoodsDetail },
  methods: {
    handleSaveSuccess() {},
  },
}
</script>
`

    localIndex.indexContent(wrapperUri, wrapperContent)
    localIndex.indexContent(physicalUri, physicalContent)
    localIndex.indexContent(virtualUri, virtualContent)
    localIndex.indexContent(parentUri, parentContent)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const physicalDocument = new TestDocument(physicalUri, physicalContent) as any

    const listenerPosition = positionAt(parentContent, parentContent.indexOf('@saveSuccess') + 2)
    const propPosition = positionAt(parentContent, parentContent.indexOf('operate-type') + 2)
    const eventPosition = positionAt(physicalContent, physicalContent.indexOf("'saveSuccess'") + 2)
    const propDefinitionPosition = positionAt(physicalContent, physicalContent.indexOf('operateType') + 2)
    const listenerDefinitions = asArray(definitionProvider.provideDefinition(parentDocument, listenerPosition) as any)
    const propDefinitions = asArray(definitionProvider.provideDefinition(parentDocument, propPosition) as any)
    const listenerHover = hoverProvider.provideHover(parentDocument, listenerPosition) as any
    const propHover = hoverProvider.provideHover(parentDocument, propPosition) as any
    const eventReferences = referenceProvider.provideReferences(physicalDocument, eventPosition) as any[]
    const eventHover = hoverProvider.provideHover(physicalDocument, eventPosition) as any
    const propReferences = referenceProvider.provideReferences(physicalDocument, propDefinitionPosition) as any[]
    const propDefinitionHover = hoverProvider.provideHover(physicalDocument, propDefinitionPosition) as any

    expect(listenerDefinitions.map((location) => location.uri.fsPath).sort()).toEqual([physicalUri, virtualUri].sort())
    expect(propDefinitions.map((location) => location.uri.fsPath).sort()).toEqual([physicalUri, virtualUri].sort())
    expect(hoverText(listenerHover)).toContain('Definitions')
    expect(hoverText(propHover)).toContain('Definitions')
    expect(eventReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(eventHover)).toContain('Used by 1 listener')
    expect(propReferences.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(propDefinitionHover)).toContain('Used by 1 prop usage')
  })

  it('Vue3 v-bind $attrs 透传事件的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provider-forwarded-attrs-'))
    const childUri = path.join(root, 'src/PositiveScan.vue')
    const middleUri = path.join(root, 'src/MemberLogin.vue')
    const parentUri = path.join(root, 'src/Dialog.vue')
    const childContent = `
<template><button @click="start">start</button></template>
<script setup lang="ts">
const emits = defineEmits<{
  fetchStart: []
}>()

function start() {
  emits('fetchStart')
}
</script>
`
    const middleContent = `
<template>
  <PositiveScan v-bind="$attrs" />
</template>
<script setup lang="ts">
import PositiveScan from './PositiveScan.vue'
</script>
`
    const parentContent = `
<template>
  <MemberLogin @fetchStart="onFetchStart" />
</template>
<script setup lang="ts">
import MemberLogin from './MemberLogin.vue'

const onFetchStart = () => {}
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(middleUri, middleContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const childDocument = new TestDocument(childUri, childContent) as any

    const eventPosition = positionAt(childContent, childContent.lastIndexOf("'fetchStart'") + 2)
    const definitions = asArray(definitionProvider.provideDefinition(childDocument, eventPosition) as any)
    const references = referenceProvider.provideReferences(childDocument, eventPosition) as any[]
    const hover = hoverProvider.provideHover(childDocument, eventPosition) as any
    const listenerPosition = positionAt(parentContent, parentContent.indexOf('@fetchStart') + 2)
    const listenerDefinitions = asArray(definitionProvider.provideDefinition(parentDocument, listenerPosition) as any)
    const listenerHover = hoverProvider.provideHover(parentDocument, listenerPosition) as any

    expect(definitions.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(references.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(hover)).toContain('Used by 1 listener')
    expect(hoverText(hover)).not.toContain('No template listeners found')
    expect(listenerDefinitions.map((location) => location.uri.fsPath)).toEqual([childUri])
    expect(hoverText(listenerHover)).toContain('Definition')
  })

  it('Vue3 v-bind $attrs 透传 prop 的 provider 关系可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provider-forwarded-props-'))
    const childUri = path.join(root, 'src/PositiveScan.vue')
    const middleUri = path.join(root, 'src/MemberLogin.vue')
    const parentUri = path.join(root, 'src/Dialog.vue')
    const childContent = `
<template><section>{{ props.classifyId }}</section></template>
<script setup lang="ts">
const props = defineProps<{
  classifyId: string
}>()
</script>
`
    const middleContent = `
<template>
  <PositiveScan v-bind="$attrs" />
</template>
<script setup lang="ts">
import PositiveScan from './PositiveScan.vue'
</script>
`
    const parentContent = `
<template>
  <MemberLogin :classify-id="classifyId" />
</template>
<script setup lang="ts">
import MemberLogin from './MemberLogin.vue'

const classifyId = '1'
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(middleUri, middleContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const parentDocument = new TestDocument(parentUri, parentContent) as any
    const childDocument = new TestDocument(childUri, childContent) as any

    const parentPropPosition = positionAt(parentContent, parentContent.indexOf(':classify-id') + 2)
    const childPropPosition = positionAt(childContent, childContent.lastIndexOf('classifyId') + 1)
    const definitions = asArray(definitionProvider.provideDefinition(parentDocument, parentPropPosition) as any)
    const references = referenceProvider.provideReferences(childDocument, childPropPosition) as any[]
    const hover = hoverProvider.provideHover(childDocument, childPropPosition) as any
    const templatePropHover = hoverProvider.provideHover(parentDocument, parentPropPosition) as any

    expect(definitions.map((location) => location.uri.fsPath)).toEqual([childUri])
    expect(references.map((location) => location.uri.fsPath)).toEqual([parentUri, childUri])
    expect(hoverText(hover)).toContain('Used by 2 prop usages')
    expect(hoverText(templatePropHover)).toContain('Definition')
    expect(hoverText(templatePropHover)).toContain('classifyId')
  })

  it('Vue3 v-bind 对象 prop 的 provider 反向引用可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provider-object-bind-props-'))
    const childUri = path.join(root, 'src/Child.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>
`
    const parentContent = `
<template>
  <Child v-bind="childProps" />
</template>
<script setup lang="ts">
import Child from './Child.vue'

const childProps = {
  title: 'hello',
}
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const childDocument = new TestDocument(childUri, childContent) as any
    const titlePosition = positionAt(childContent, childContent.indexOf('title') + 1)

    const references = referenceProvider.provideReferences(childDocument, titlePosition) as any[]
    const hover = hoverProvider.provideHover(childDocument, titlePosition) as any

    expect(references.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(hover)).toContain('Used by 1 prop usage')
  })

  it('Vue3 v-on 对象事件的 provider 反向引用可用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-provider-object-on-events-'))
    const childUri = path.join(root, 'src/Child.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<script setup lang="ts">
const emit = defineEmits<{
  saveSuccess: []
}>()

function save() {
  emit('saveSuccess')
}
</script>
`
    const parentContent = `
<template>
  <Child v-on="listeners" />
</template>
<script setup lang="ts">
import Child from './Child.vue'

const onSaveSuccess = () => {}
const listeners = {
  saveSuccess: onSaveSuccess,
}
</script>
`
    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const definitionProvider = new VueDefinitionProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const childDocument = new TestDocument(childUri, childContent) as any
    const eventPosition = positionAt(childContent, childContent.lastIndexOf("'saveSuccess'") + 2)

    const definitions = asArray(definitionProvider.provideDefinition(childDocument, eventPosition) as any)
    const references = referenceProvider.provideReferences(childDocument, eventPosition) as any[]
    const hover = hoverProvider.provideHover(childDocument, eventPosition) as any

    expect(definitions.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(references.map((location) => location.uri.fsPath)).toEqual([parentUri])
    expect(hoverText(hover)).toContain('Used by 1 listener')
  })

  it('Vue3 hook 返回方法可在源码处 hover 和查找反向引用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-hook-return-usages-'))
    const hookUri = path.join(root, 'src/pages/channel-verify/hooks/use-verify.ts')
    const pageUri = path.join(root, 'src/pages/channel-verify/index.vue')
    const hookContent = `
const useVerify = () => {
  const runVerifyWithCode = async (code: string) => {
    return code
  }

  const getChannelType = () => 'sms'

  return {
    runVerifyWithCode,
    getChannelType,
  }
}

export default useVerify
`
    const pageContent = `
<template>
  <div />
</template>
<script setup lang="ts">
import useVerify from './hooks/use-verify'

const { runVerifyWithCode } = useVerify()

const runTask = (task: (code: string) => Promise<string>, payload: { code: string }) => task(payload.code)

runTask(runVerifyWithCode, { code: 'first' })
runTask(runVerifyWithCode, { code: 'second' })
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(hookUri, hookContent)
    writeText(pageUri, pageContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hoverProvider = new VueHoverProvider(localIndex)
    const hookDocument = new TestDocument(hookUri, hookContent, 'typescript') as any
    const methodPosition = positionAt(hookContent, hookContent.indexOf('runVerifyWithCode =') + 1)

    const references = referenceProvider.provideReferences(hookDocument, methodPosition) as any[]
    const hover = hoverProvider.provideHover(hookDocument, methodPosition) as any

    expect(references).toHaveLength(3)
    expect(references.map((location) => location.uri.fsPath)).toEqual([pageUri, pageUri, pageUri])
    expect(hoverText(hover)).toContain('Used by 3 hook usages')
    expect(hoverText(hover)).toContain('- [index.vue:')
    expect(hoverText(hover)).not.toContain('No hook usages found')
  })

  it('Vue3 hook 返回方法保存后可重建直接导入它的消费文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-hook-incremental-'))
    const hookUri = path.join(root, 'src/hooks/use-verify.ts')
    const pageUri = path.join(root, 'src/ChannelVerify.vue')
    const initialHookContent = `
const useVerify = () => {
  const runVerifyWithCode = async (code: string) => code

  return {}
}

export default useVerify
`
    const nextHookContent = `
const useVerify = () => {
  const runVerifyWithCode = async (code: string) => code

  return {
    runVerifyWithCode,
  }
}

export default useVerify
`
    const pageContent = `
<script setup lang="ts">
import useVerify from './hooks/use-verify'

const { runVerifyWithCode } = useVerify()

runVerifyWithCode('code')
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(hookUri, initialHookContent)
    writeText(pageUri, pageContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    let referenceProvider = new VueReferenceProvider(localIndex)
    let hookDocument = new TestDocument(hookUri, initialHookContent, 'typescript') as any

    expect(referenceProvider.provideReferences(hookDocument, positionAt(initialHookContent, initialHookContent.indexOf('runVerifyWithCode =') + 1)) as any[]).toEqual([])

    writeText(hookUri, nextHookContent)
    await localIndex.syncGlobalComponentFile(hookUri)
    referenceProvider = new VueReferenceProvider(localIndex)
    hookDocument = new TestDocument(hookUri, nextHookContent, 'typescript') as any

    const references = referenceProvider.provideReferences(hookDocument, positionAt(nextHookContent, nextHookContent.indexOf('runVerifyWithCode =') + 1)) as any[]

    expect(references).toHaveLength(2)
    expect(references[0].uri.fsPath).toBe(pageUri)
  })

  it('Vue3 hook 返回方法仅被另一个 hook 解构时也可在源码处 hover', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-hook-destructure-hover-'))
    const hookUri = path.join(root, 'src/pages/channel-verify/hooks/use-test-create.ts')
    const consumerUri = path.join(root, 'src/pages/channel-verify/hooks/use-verify.ts')
    const hookContent = `
const useTestCreate = () => {
  const test = () => {
    console.log('hello')
  }
  return { test }
}

export default useTestCreate
`
    const consumerContent = `
import useTestCreate from './use-test-create'

const useVerify = () => {
  const { test } = useTestCreate()

  return {}
}

export default useVerify
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(hookUri, hookContent)
    writeText(consumerUri, consumerContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const hoverProvider = new VueHoverProvider(localIndex)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hookDocument = new TestDocument(hookUri, hookContent, 'typescript') as any
    const methodPosition = positionAt(hookContent, hookContent.indexOf('test =') + 1)

    const hover = hoverProvider.provideHover(hookDocument, methodPosition) as any
    const references = referenceProvider.provideReferences(hookDocument, methodPosition) as any[]

    expect(references).toHaveLength(1)
    expect(references[0].uri.fsPath).toBe(consumerUri)
    expect(hoverText(hover)).toContain('Used by 1 hook usage')
    expect(hoverText(hover)).toContain('- [use-verify.ts:')
  })

  it('Vue3 hook 返回方法不会把后续同名局部变量算成反向引用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-hook-shadow-'))
    const hookUri = path.join(root, 'src/hooks/use-verify.ts')
    const pageUri = path.join(root, 'src/ChannelVerify.vue')
    const hookContent = `
const useVerify = () => {
  const runVerifyWithCode = async (code: string) => code

  return {
    runVerifyWithCode,
  }
}

export default useVerify
`
    const pageContent = `
<script setup lang="ts">
import useVerify from './hooks/use-verify'

const { runVerifyWithCode } = useVerify()

runVerifyWithCode('from-hook')

const runVerifyWithCode = (code: string) => code

runVerifyWithCode('local')
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(hookUri, hookContent)
    writeText(pageUri, pageContent)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const referenceProvider = new VueReferenceProvider(localIndex)
    const hookDocument = new TestDocument(hookUri, hookContent, 'typescript') as any

    const references = referenceProvider.provideReferences(hookDocument, positionAt(hookContent, hookContent.indexOf('runVerifyWithCode =') + 1)) as any[]

    expect(references).toHaveLength(2)
    expect(references[0].uri.fsPath).toBe(pageUri)
  })

  it('组件 template 处展示组件用法 CodeLens，单个用法也可点击执行命令', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-component-usage-codelens-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const childUri = path.join(root, 'src/Child.vue')
    const parentUri = path.join(root, 'src/Parent.vue')
    const childContent = `
<template>
  <div />
</template>
<script>
export default { name: 'Child' }
</script>
`
    const parentContent = `
<template>
  <Child />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`

    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(parentUri, parentContent)
    const provider = new VueCodeLensProvider(localIndex)
    const document = new TestDocument(childUri, childContent) as any
    const lenses = provider.provideCodeLenses(document) as any[]

    expect(lenses).toHaveLength(1)
    expect(lenses[0].range.start.line).toBe(1)
    expect(lenses[0].range.end.line).toBe(1)
    expect(lenses[0].command.title).toBe('Used by 1 usage')
    expect(lenses[0].command.command).toBe('vueComponentNavigator.showUsages')
    expect(lenses[0].command.arguments).toEqual([{ kind: 'component-usages', childUri }])
  })

  it('组件有多个用法时 CodeLens 可点击打开用法列表', () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-component-usage-list-codelens-'))
    localIndex.setWorkspaceVueVersion(root, 2)
    const childUri = path.join(root, 'src/Child.vue')
    const firstParentUri = path.join(root, 'src/FirstParent.vue')
    const secondParentUri = path.join(root, 'src/SecondParent.vue')
    const childContent = `
<template>
  <div />
</template>
<script>
export default { name: 'Child' }
</script>
`
    const parentContent = `
<template>
  <Child />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`

    localIndex.indexContent(childUri, childContent)
    localIndex.indexContent(firstParentUri, parentContent)
    localIndex.indexContent(secondParentUri, parentContent)
    const provider = new VueCodeLensProvider(localIndex)
    const document = new TestDocument(childUri, childContent) as any
    const lenses = provider.provideCodeLenses(document) as any[]

    expect(lenses).toHaveLength(1)
    expect(lenses[0].command.title).toBe('Used by 2 usages')
    expect(lenses[0].command.command).toBe('vueComponentNavigator.showUsages')
    expect(lenses[0].command.arguments).toEqual([{ kind: 'component-usages', childUri }])
  })

  it('Vue3 组件也只在 template 处展示组件用法 CodeLens', async () => {
    const localIndex = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vue3-component-usage-codelens-'))
    const childUri = path.join(root, 'src/MemberLogin.vue')
    const parentUri = path.join(root, 'src/Dialog.vue')
    const childContent = `
<template>
  <div />
</template>
<script setup lang="ts">
defineOptions({ name: 'MemberLogin' })
</script>
`
    const parentContent = `
<template>
  <MemberLogin />
</template>
<script setup lang="ts">
import MemberLogin from './MemberLogin.vue'
</script>
`

    writeText(path.join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }))
    writeText(childUri, childContent)
    writeText(parentUri, parentContent)
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const provider = new VueCodeLensProvider(localIndex)
    const document = new TestDocument(childUri, childContent) as any
    const lenses = provider.provideCodeLenses(document) as any[]

    expect(lenses).toHaveLength(1)
    expect(lenses[0].range.start.line).toBe(1)
    expect(lenses[0].command.title).toBe('Used by 1 usage')
  })

  it('命令式组件的 command 脚本展示最终业务调用 CodeLens', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-command-component-codelens-'))
    const componentUri = path.join(root, 'src/dialog/index.vue')
    const commandUri = path.join(root, 'src/dialog/command.tsx')
    const consumerUri = path.join(root, 'src/use-dialog.ts')
    const componentContent = '<template><div /></template><script setup lang="ts"></script>'
    const commandContent = `
import { createApp, h } from 'vue'
import Dialog from './index.vue'
const command = { open: () => createApp({ render: () => h(Dialog) }) }
export default command
`
    writeText(componentUri, componentContent)
    writeText(commandUri, commandContent)
    writeText(consumerUri, `import command from './dialog/command'\ncommand.open()`)

    const localIndex = new WorkspaceIndex()
    await localIndex.indexWorkspace(root, undefined, undefined, 3)
    const provider = new VueCodeLensProvider(localIndex)
    const commandDocument = new TestDocument(commandUri, commandContent, 'typescriptreact') as any
    const commandLenses = provider.provideCodeLenses(commandDocument) as any[]
    const componentDocument = new TestDocument(componentUri, componentContent) as any
    const componentLenses = provider.provideCodeLenses(componentDocument) as any[]

    expect(commandLenses).toHaveLength(1)
    expect(commandLenses[0].command.title).toBe('Used by 1 usage')
    expect(commandLenses[0].command.arguments).toEqual([{ kind: 'command-component-usages', commandUri }])
    expect(componentLenses).toHaveLength(1)
    expect(componentLenses[0].command.title).toBe('Used by 1 usage')
  })

  it('没有组件用法时不展示 CodeLens', () => {
    const localIndex = new WorkspaceIndex()
    const uri = path.join(fixtureRoot, 'UnusedHint.vue')
    const content = `
<template>
  <div />
</template>
<script>
export default { name: 'UnusedHint' }
</script>
`

    localIndex.indexContent(uri, content)
    const provider = new VueCodeLensProvider(localIndex)
    const document = new TestDocument(uri, content) as any

    expect(provider.provideCodeLenses(document)).toEqual([])
  })
})

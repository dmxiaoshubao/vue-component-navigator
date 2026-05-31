import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeMock'))

const fixtureRoot = path.resolve(__dirname, '../test-fixtures/vue2-basic')

class TestDocument {
  uri: { fsPath: string }
  languageId = 'vue'

  constructor(public filePath: string, private readonly content: string) {
    this.uri = { fsPath: filePath }
  }

  getText(): string {
    return this.content
  }
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8')
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

describe('Vue providers', () => {
  let WorkspaceIndex: typeof import('../src/indexer/workspaceIndex').WorkspaceIndex
  let VueDefinitionProvider: typeof import('../src/providers/definitionProvider').VueDefinitionProvider
  let VueCompletionProvider: typeof import('../src/providers/completionProvider').VueCompletionProvider
  let VueHoverProvider: typeof import('../src/providers/hoverProvider').VueHoverProvider
  let VueReferenceProvider: typeof import('../src/providers/referenceProvider').VueReferenceProvider
  let index: import('../src/indexer/workspaceIndex').WorkspaceIndex

  beforeEach(async () => {
    ;({ WorkspaceIndex } = await import('../src/indexer/workspaceIndex'))
    ;({ VueDefinitionProvider } = await import('../src/providers/definitionProvider'))
    ;({ VueCompletionProvider } = await import('../src/providers/completionProvider'))
    ;({ VueHoverProvider } = await import('../src/providers/hoverProvider'))
    ;({ VueReferenceProvider } = await import('../src/providers/referenceProvider'))
    index = new WorkspaceIndex()
    await index.indexWorkspace(fixtureRoot)
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
    expect(hoverText(hover)).toContain('Definition: [Child.vue]')
    expect(hoverText(hover)).not.toContain('Definition: [Child.vue:')
    expect(hoverText(hover)).toContain('file://')
    expect(hover.contents.isTrusted).toBe(false)
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
    expect(hoverText(hover)).toContain('Definition: [Child.vue]')
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

  it('全局组件晚于父组件索引时仍能从 prop 跳转', async () => {
    const localIndex = new WorkspaceIndex()
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
    expect(hoverText(hover)).toContain('Definition: [Child.vue]')
    expect(hoverText(hover)).not.toContain('Definition: [Child.vue:')
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
    expect(hoverText(propHover)).toContain('Definition: [AliasChild.vue]')
    expect(hoverText(propHover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(propHover.contents.isTrusted).toBe(false)
    expect(parentEventHover).toBeDefined()
    expect(hoverText(parentEventHover)).toContain('Definition: [AliasChild.vue]')
    expect(hoverText(parentEventHover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(hoverText(parentEventHover)).not.toContain('Used by 1 listener')
    expect(parentEventHover.contents.isTrusted).toBe(false)
    expect(hoverText(eventHover)).not.toContain('Definition: [AliasChild.vue]')
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

    expect(hoverText(hover)).toContain('Definition: [AliasChild.vue]')
    expect(hoverText(hover)).not.toContain('Definition: [src/components/AliasChild.vue]')
    expect(hoverText(hover)).toContain('file://')
  })

  it('emit 引用列表使用当前引用集合的最短差异路径', () => {
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

    expect(hoverText(hover)).toContain('[red-packet/index.vue:')
    expect(hoverText(hover)).toContain('[activity/index.vue:')
    expect(hoverText(hover)).toContain('[coupon/index.vue:')
    expect(hoverText(hover)).not.toContain('- [pages/admin/marketing/red-packet/index.vue:')
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
    expect(hover.contents.isTrusted).toEqual({ enabledCommands: ['vueComponentNavigator.showEmitUsages'] })
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
})

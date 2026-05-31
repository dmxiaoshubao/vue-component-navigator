import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceIndex, findRefMethodAccess } from '../src/indexer/workspaceIndex'
import { findEmit, findProp, findRefComponent, findRefMethodUsages, findRegisteredComponent, findTemplateEventUsages, findTemplatePropUsages } from '../src/indexer/relationResolver'

const fixtureRoot = path.resolve(__dirname, '../test-fixtures/vue2-basic')

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8')
}

async function buildIndex(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex()
  await index.indexWorkspace(fixtureRoot)
  return index
}

describe('Vue2 indexer', () => {
  it('解析 SFC、imports、components、props、methods 和 emits', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const child = index.getFile(path.join(fixtureRoot, 'Child.vue'))!
    const other = index.getFile(path.join(fixtureRoot, 'OtherChild.vue'))!

    expect(parent.template?.content).toContain('<OtherChild')
    expect(parent.script).toBeTruthy()
    expect(parent.scriptIndex.imports).toContainEqual({ localName: 'Child', source: './Child.vue' })
    expect(parent.scriptIndex.components.map((item) => item.localName)).toContain('Child')
    expect(child.scriptIndex.componentName).toBe('Child')
    expect(child.scriptIndex.props.map((prop) => prop.name)).toEqual(['title', 'titleText', 'userId'])
    expect(other.scriptIndex.props.map((prop) => prop.name)).toEqual(['title'])
    expect(child.scriptIndex.methods.map((method) => method.name)).toEqual(['open', 'close', 'load', 'notify'])
    expect(child.scriptIndex.emits.filter((emit) => emit.eventName === 'save')).toHaveLength(2)
  })

  it('支持清空索引用于手动重建', async () => {
    const index = await buildIndex()

    expect(index.getFileCount()).toBeGreaterThan(0)
    index.clear()

    expect(index.getFileCount()).toBe(0)
    expect(index.getIndexedUris()).toEqual([])
  })

  it('解析 template 中组件 ref、props、event 并过滤内置属性', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const childUsage = parent.templateIndex.components.find((component) => component.tag === 'Child')!

    expect(childUsage.attrs.some((attr) => attr.kind === 'ref' && attr.name === 'child')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'title')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'title-text' && attr.normalizedName === 'titleText')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'event' && attr.name === 'save')).toBe(true)
    expect(childUsage.attrs.some((attr) => ['class', 'style', 'key', 'v-if'].includes(attr.name))).toBe(false)
  })

  it('支持带修饰符的 template 事件监听', () => {
    const index = new WorkspaceIndex()
    const content = `
<template>
  <Child @save.once="onSave" v-on:submit.stop="onSubmit" />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`

    const file = index.indexContent(path.join(fixtureRoot, 'ModifierEvent.vue'), content)
    const childUsage = file.templateIndex.components.find((component) => component.tag === 'Child')!

    expect(childUsage.attrs.some((attr) => attr.kind === 'event' && attr.name === 'save')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'event' && attr.name === 'submit')).toBe(true)
  })

  it('属性值包含 > 时仍能解析同一组件后续属性', () => {
    const index = new WorkspaceIndex()
    const content = `
<template>
  <Child title="a > b" :user-id="userId" @save="onSave" />
</template>
<script>
import Child from './Child.vue'
export default { components: { Child } }
</script>
`

    const file = index.indexContent(path.join(fixtureRoot, 'GreaterThanAttr.vue'), content)
    const childUsage = file.templateIndex.components.find((component) => component.tag === 'Child')!

    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'title')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'user-id')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'event' && attr.name === 'save')).toBe(true)
  })

  it('脚本中的注释不会破坏对象结构解析或伪引用扫描', () => {
    const content = `
<script>
const ignored = "export default { props: { fake: String } }"
export default {
  methods: {
    foo() {
      // this.$refs.child.open()
      /* } */
      const matcher = /}/
      return 1
    },
    bar() {
      return this.$emit('save')
    },
  },
  props: {
    'foo-bar': String,
  },
}
</script>
`

    const file = new WorkspaceIndex().indexContent(path.join(fixtureRoot, 'CommentSafe.vue'), content)

    expect(file.scriptIndex.methods.map((method) => method.name)).toEqual(['foo', 'bar'])
    expect(file.scriptIndex.props.map((prop) => prop.name)).toEqual(['foo-bar'])
    expect(file.scriptIndex.emits).toHaveLength(1)
  })

  it('忽略注释中的 import 与 template 组件', () => {
    const index = new WorkspaceIndex()
    const content = `
<template>
  <!-- <FakeChild ref="fake" @save="onSave" /> -->
  <RealChild ref="real" />
</template>
<script>
// import FakeChild from './FakeChild.vue'
import RealChild from './RealChild.vue'
export default {
  components: { FakeChild, RealChild },
}
</script>
`

    const file = index.indexContent(path.join(fixtureRoot, 'IgnoredComment.vue'), content)

    expect(file.scriptIndex.imports).toEqual([{ localName: 'RealChild', source: './RealChild.vue' }])
    expect(file.scriptIndex.components.find((component) => component.localName === 'FakeChild')?.targetUri).toBeUndefined()
    expect(file.templateIndex.components.map((component) => component.tag)).toEqual(['RealChild'])
  })

  it('解析静态 provide 和 inject 关系', () => {
    const index = new WorkspaceIndex()
    const provider = index.indexContent(path.join(fixtureRoot, 'Provider.vue'), `
<template><div /></template>
<script>
export default {
  provide() {
    return {
      theme: this.theme,
      'user-service': this.userService,
    }
  },
}
</script>
`)
    const consumer = index.indexContent(path.join(fixtureRoot, 'Consumer.vue'), `
<template><div /></template>
<script>
export default {
  inject: {
    localTheme: 'theme',
    userService: {
      from: 'user-service',
    },
  },
}
</script>
`)

    expect(provider.scriptIndex.provides.map((item) => item.key)).toEqual(['theme', 'user-service'])
    expect(consumer.scriptIndex.injects.map((item) => [item.localName, item.key])).toEqual([
      ['localTheme', 'theme'],
      ['userService', 'user-service'],
    ])
    expect(index.findProvideDefinitions(consumer, 'theme').map((usage) => usage.file.uri)).toEqual([provider.uri])
    expect(index.findInjectUsages(provider.uri, 'user-service').map((usage) => usage.file.uri)).toEqual([consumer.uri])
  })

  it('provide 更新后同步刷新 inject 反向索引', () => {
    const index = new WorkspaceIndex()
    const providerUri = path.join(fixtureRoot, 'ChangingProvider.vue')
    const consumerUri = path.join(fixtureRoot, 'ChangingConsumer.vue')
    const consumer = index.indexContent(consumerUri, `
<template><div /></template>
<script>
export default {
  inject: ['service'],
}
</script>
`)
    const provider = index.indexContent(providerUri, `
<template><div /></template>
<script>
export default {
  provide: {
    service: this.service,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service').map((usage) => usage.file.uri)).toEqual([provider.uri])
    expect(index.findInjectUsages(provider.uri, 'service')).toHaveLength(1)

    index.syncContent(providerUri, `
<template><div /></template>
<script>
export default {
  provide: {
    renamedService: this.service,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service')).toHaveLength(0)
    expect(index.findInjectUsages(provider.uri, 'service')).toHaveLength(0)
  })

  it('没有 tsconfig 或 jsconfig 时不猜测 @/ 别名', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(__dirname, 'no-config/Parent.vue'), `
<template>
  <AliasChild />
</template>
<script>
import AliasChild from '@/components/AliasChild.vue'
export default {
  components: { AliasChild },
}
</script>
`)

    expect(file.scriptIndex.components.find((component) => component.localName === 'AliasChild')?.targetUri).toBeUndefined()
  })
})

describe('Vue2 relation resolver', () => {
  it('解析 ref 到子组件方法关系', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const openOffset = parent.content.indexOf('open()')
    const closeOffset = parent.content.indexOf('close()')

    expect(findRefComponent(parent, 'child')).toBe(childUri)
    expect(findRefMethodAccess(parent.content, openOffset + 1)?.methodName).toBe('open')
    expect(findRefMethodAccess(parent.content, closeOffset + 1)?.methodName).toBe('close')
  })

  it('解析 template props 到子组件 props', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const child = index.getFile(path.join(fixtureRoot, 'Child.vue'))!
    const childUsage = parent.templateIndex.components.find((component) => component.tag === 'Child')!
    const titleText = childUsage.attrs.find((attr) => attr.kind === 'prop' && attr.name === 'title-text')!

    const alias = index.getFile(path.join(fixtureRoot, 'src/components/AliasChild.vue'))!

    expect(findRegisteredComponent(parent, 'Child')).toBe(child.uri)
    expect(findProp(child, titleText.normalizedName)?.name).toBe('titleText')
    expect(findRegisteredComponent(parent, 'AliasChild')).toBe(alias.uri)
    expect(findProp(alias, 'originUrl')?.detail).toContain('default')
    expect(findEmit(alias, 'onLoadSuccess')).toHaveLength(1)
  })

  it('解析全局注册组件到 props、events 和 ref 方法关系', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'GlobalParent.vue'))!
    const globalChild = index.getFile(path.join(fixtureRoot, 'global-components/GlobalChild.vue'))!
    const globalDialog = index.getFile(path.join(fixtureRoot, 'global-components/dialog/index.vue'))!
    const namedOnlyDialog = index.getFile(path.join(fixtureRoot, 'global-components/NamedOnlyDialog.vue'))!
    const autoWidget = index.getFile(path.join(fixtureRoot, 'global-components/auto-widget/index.vue'))!

    expect(index.getGlobalComponents().map((component) => component.tag)).toContain('GlobalChild')
    expect(index.resolveComponent(parent, 'GlobalChild')).toBe(globalChild.uri)
    expect(index.resolveComponent(parent, 'GlobalDialog')).toBe(globalDialog.uri)
    expect(index.resolveComponent(parent, 'NamedOnlyDialog')).toBe(namedOnlyDialog.uri)
    expect(index.resolveComponent(parent, 'AutoWidget')).toBe(autoWidget.uri)
    expect(index.resolveRefComponent(parent, 'globalChild')).toBe(globalChild.uri)
    expect(index.resolveRefComponent(parent, 'dialog')).toBe(globalDialog.uri)
    expect(index.resolveRefComponent(parent, 'namedOnlyDialog')).toBe(namedOnlyDialog.uri)
    expect(index.resolveRefComponent(parent, 'autoWidget')).toBe(autoWidget.uri)
    expect(index.findTemplatePropUsages(globalChild.uri, 'label')).toHaveLength(1)
    expect(index.findTemplateEventUsages(globalChild.uri, 'ready')).toHaveLength(1)
    expect(index.findRefMethodUsages(globalChild.uri, 'focus')).toHaveLength(1)
    expect(index.findTemplatePropUsages(globalDialog.uri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(globalDialog.uri, 'confirm')).toHaveLength(1)
    expect(index.findTemplatePropUsages(namedOnlyDialog.uri, 'title')).toHaveLength(1)
    expect(index.findRefMethodUsages(namedOnlyDialog.uri, 'show')).toHaveLength(1)
    expect(index.findRefMethodUsages(autoWidget.uri, 'refresh')).toHaveLength(1)
  })

  it('全局注册会过滤第三方 package 组件', async () => {
    const index = new WorkspaceIndex()
    const root = path.join(fixtureRoot, 'third-party-filter')
    const registerUri = path.join(root, 'src/bootstrap.js')
    const parentUri = path.join(root, 'src/Parent.vue')
    const thirdPartyUri = path.join(root, 'node_modules/vendor-ui/ElForm.vue')

    await index.indexGlobalComponentContent(registerUri, `
import ElForm from '../node_modules/vendor-ui/ElForm.vue'
Vue.component('ElForm', ElForm)
`)
    index.indexContent(parentUri, `
<template>
  <ElForm :model="form" @validate="onValidate" />
</template>
<script>
export default {}
</script>
`)

    expect(index.getGlobalComponents().some((component) => component.targetUri === thirdPartyUri)).toBe(false)
    expect(index.resolveComponent(index.getFile(parentUri)!, 'ElForm')).toBeUndefined()
    expect(index.findTemplatePropUsages(thirdPartyUri, 'model')).toHaveLength(0)
    expect(index.findTemplateEventUsages(thirdPartyUri, 'validate')).toHaveLength(0)
  })

  it('全局注册文件与组件 name 变化后会刷新索引', async () => {
    const index = new WorkspaceIndex()
    const parentUri = path.join(fixtureRoot, 'IncrementalGlobalParent.vue')
    const childUri = path.join(fixtureRoot, 'IncrementalGlobalChild.vue')
    const registerUri = path.join(fixtureRoot, 'incremental-global.js')

    index.indexContent(parentUri, `
<template>
  <IncrementalGlobalChild ref="child" title="hello" />
</template>
<script>
export default {
  methods: {
    callChild() {
      this.$refs.child.open()
    },
  },
}
</script>
`)
    index.indexContent(childUri, `
<template><div /></template>
<script>
export default {
  name: 'IncrementalGlobalChild',
  props: { title: String },
  methods: { open() {} },
}
</script>
`)

    await index.indexGlobalComponentContent(registerUri, `
import IncrementalGlobalChild from './IncrementalGlobalChild.vue'
Vue.component(IncrementalGlobalChild.name, IncrementalGlobalChild)
`)
    await index.refreshGlobalComponentsForVueFile(childUri)

    expect(index.resolveComponent(index.getFile(parentUri)!, 'IncrementalGlobalChild')).toBe(childUri)
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findRefMethodUsages(childUri, 'open')).toHaveLength(1)

    index.syncContent(childUri, `
<template><div /></template>
<script>
export default {
  name: 'RenamedGlobalChild',
  props: { title: String },
  methods: { open() {} },
}
</script>
`)
    index.syncContent(parentUri, `
<template>
  <RenamedGlobalChild ref="child" title="hello" />
</template>
<script>
export default {
  methods: {
    callChild() {
      this.$refs.child.open()
    },
  },
}
</script>
`)
    await index.refreshGlobalComponentsForVueFile(childUri)

    expect(index.resolveComponent(index.getFile(parentUri)!, 'IncrementalGlobalChild')).toBeUndefined()
    expect(index.resolveComponent(index.getFile(parentUri)!, 'RenamedGlobalChild')).toBe(childUri)
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findRefMethodUsages(childUri, 'open')).toHaveLength(1)
  })

  it('只返回真实 props、emit、ref 方法引用', async () => {
    const index = await buildIndex()
    const files = index.getAllFiles()
    const childUri = path.join(fixtureRoot, 'Child.vue')

    expect(findTemplatePropUsages(files, childUri, 'title')).toHaveLength(1)
    expect(findTemplateEventUsages(files, childUri, 'save')).toHaveLength(2)
    expect(findRefMethodUsages(files, childUri, 'open')).toHaveLength(2)
    expect(findRefMethodUsages(files, childUri, 'missing')).toHaveLength(0)
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(2)
    expect(index.findRefMethodUsages(childUri, 'open')).toHaveLength(2)
  })

  it('更新和删除文件时同步清理反向索引', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'IndexedChild.vue')
    const parentUri = path.join(fixtureRoot, 'IndexedParent.vue')

    index.indexContent(childUri, `
<template><div /></template>
<script>
export default {
  props: { title: String },
  methods: { open() {} },
}
</script>
`)
    index.indexContent(parentUri, `
<template>
  <IndexedChild ref="child" :title="title" @save="onSave" />
</template>
<script>
import IndexedChild from './IndexedChild.vue'
export default {
  components: { IndexedChild },
  methods: {
    callChild() {
      this.$refs.child.open()
    },
  },
}
</script>
`)

    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
    expect(index.findRefMethodUsages(childUri, 'open')).toHaveLength(1)

    index.syncContent(parentUri, `
<template>
  <IndexedChild ref="child" />
</template>
<script>
import IndexedChild from './IndexedChild.vue'
export default { components: { IndexedChild } }
</script>
`)

    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(0)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(0)
    expect(index.findRefMethodUsages(childUri, 'open')).toHaveLength(0)

    index.remove(parentUri)
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(0)
  })

  it('忽略注释中的 $refs 调用', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'CommentChild.vue')
    const parentUri = path.join(fixtureRoot, 'CommentParent.vue')

    index.indexContent(childUri, `
<template><div /></template>
<script>
export default {
  methods: {
    open() {},
  },
}
</script>
`)
    index.indexContent(parentUri, `
<template>
  <CommentChild ref="child" />
</template>
<script>
import CommentChild from './CommentChild.vue'
export default {
  components: { CommentChild },
  methods: {
    callChild() {
      // this.$refs.child.open()
      const matcher = /this\\.\$refs\\.child\\.open/
      return this.$refs.child.open()
    },
  },
}
</script>
`)

    expect(findRefMethodUsages(index.getAllFiles(), childUri, 'open')).toHaveLength(1)
  })

  it('同名事件或 prop 但组件不同不算引用', async () => {
    const index = await buildIndex()
    const files = index.getAllFiles()
    const otherUri = path.join(fixtureRoot, 'OtherChild.vue')

    expect(findTemplatePropUsages(files, otherUri, 'title')).toHaveLength(1)
    expect(findTemplateEventUsages(files, otherUri, 'save')).toHaveLength(1)
  })
})

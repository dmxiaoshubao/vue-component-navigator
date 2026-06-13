import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceIndex, findRefMethodAccess } from '../src/indexer/workspaceIndex'
import { findEmit, findMethod, findProp, findRefComponent, findRefMethodUsages, findRegisteredComponent, findTemplateEventUsages, findTemplatePropUsages } from '../src/indexer/relationResolver'

const fixtureRoot = path.resolve(__dirname, '../test-fixtures/vue2-basic')

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

  it('解析 components 中的 import() 异步组件注册', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const parentUri = path.join(fixtureRoot, 'AsyncParent.vue')
    index.indexContent(childUri, readFixture('Child.vue'))
    const parent = index.indexContent(parentUri, `
<template>
  <AsyncChild :title="title" @save="onSave" />
</template>
<script>
export default {
  components: {
    AsyncChild: () => import('./Child.vue'),
  },
}
</script>
`)

    expect(parent.scriptIndex.components).toContainEqual(expect.objectContaining({
      tag: 'AsyncChild',
      localName: 'AsyncChild',
      targetUri: childUri,
    }))
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
  })

  it('解析 components 中的 require 数组异步组件注册', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const parentUri = path.join(fixtureRoot, 'RequireAsyncParent.vue')
    index.indexContent(childUri, readFixture('Child.vue'))
    const parent = index.indexContent(parentUri, `
<template>
  <AsyncChild :title="title" @save="onSave" />
</template>
<script>
export default {
  components: {
    AsyncChild: resolve => require(['./Child.vue'], resolve),
  },
}
</script>
`)

    expect(parent.scriptIndex.components).toContainEqual(expect.objectContaining({
      tag: 'AsyncChild',
      localName: 'AsyncChild',
      targetUri: childUri,
    }))
    expect(parent.scriptIndex.components).toHaveLength(1)
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
  })

  it('解析 components 中的静态变量别名注册', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const parentUri = path.join(fixtureRoot, 'AliasParent.vue')
    index.indexContent(childUri, readFixture('Child.vue'))
    const parent = index.indexContent(parentUri, `
<template>
  <RenamedChild :title="title" @save="onSave" />
</template>
<script>
import Child from './Child.vue'
const ChildAlias = Child
export default {
  components: {
    RenamedChild: ChildAlias,
  },
}
</script>
`)

    expect(parent.scriptIndex.components).toContainEqual(expect.objectContaining({
      tag: 'RenamedChild',
      localName: 'Child',
      targetUri: childUri,
    }))
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
  })

  it('解析 components 中的异步变量别名注册', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const parentUri = path.join(fixtureRoot, 'AsyncAliasParent.vue')
    index.indexContent(childUri, readFixture('Child.vue'))
    const parent = index.indexContent(parentUri, `
<template>
  <AsyncChild :title="title" @save="onSave" />
</template>
<script>
const AsyncChild = () => import('./Child.vue')
export default {
  components: {
    AsyncChild,
  },
}
</script>
`)

    expect(parent.scriptIndex.components).toContainEqual(expect.objectContaining({
      tag: 'AsyncChild',
      localName: 'AsyncChild',
      targetUri: childUri,
    }))
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
  })

  it('解析带类型标注的异步变量别名注册', () => {
    const index = new WorkspaceIndex()
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const parentUri = path.join(fixtureRoot, 'TypedAsyncAliasParent.vue')
    index.indexContent(childUri, readFixture('Child.vue'))
    const parent = index.indexContent(parentUri, `
<template>
  <AsyncChild :title="title" @save="onSave" />
</template>
<script lang="ts">
const AsyncChild: unknown = () => import('./Child.vue')
export default {
  components: {
    AsyncChild,
  },
}
</script>
`)

    expect(parent.scriptIndex.components).toContainEqual(expect.objectContaining({
      tag: 'AsyncChild',
      localName: 'AsyncChild',
      targetUri: childUri,
    }))
    expect(index.findTemplatePropUsages(childUri, 'title')).toHaveLength(1)
    expect(index.findTemplateEventUsages(childUri, 'save')).toHaveLength(1)
  })

  it('合并静态 mixin 中的 props、methods、emits、provide、inject 和 $refs 调用', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'MixinParent.vue'))!
    const child = index.getFile(path.join(fixtureRoot, 'MixinChild.vue'))!
    const inner = index.getFile(path.join(fixtureRoot, 'MixinInner.vue'))!
    const defaultMixinUri = path.join(fixtureRoot, 'mixin-default.js')
    const namedMixinUri = path.join(fixtureRoot, 'mixin-named.js')
    const nestedMixinUri = path.join(fixtureRoot, 'mixin-nested.js')

    expect(child.scriptIndex.mixins.map((mixin) => [mixin.localName, mixin.importedName, mixin.targetUri])).toEqual([
      ['baseMixin', undefined, defaultMixinUri],
      ['aliasedMixin', 'namedMixin', namedMixinUri],
    ])
    expect(findProp(child, 'mixedTitle')?.sourceLocation?.uri).toBe(defaultMixinUri)
    expect(findProp(child, 'nestedTitle')?.sourceLocation?.uri).toBe(nestedMixinUri)
    expect(findMethod(child, 'mixedMethod')?.sourceLocation?.uri).toBe(defaultMixinUri)
    expect(findMethod(child, 'namedMethod')?.sourceLocation?.uri).toBe(namedMixinUri)
    expect(findMethod(child, 'nestedMethod')?.sourceLocation?.uri).toBe(nestedMixinUri)
    expect(findEmit(child, 'mixed-save')[0]?.sourceLocation?.uri).toBe(defaultMixinUri)
    expect(child.scriptIndex.provides.find((provide) => provide.key === 'sharedService')?.sourceLocation?.uri).toBe(defaultMixinUri)
    expect(child.scriptIndex.injects.find((inject) => inject.key === 'sharedService')?.sourceLocation?.uri).toBe(namedMixinUri)

    expect(index.findTemplatePropUsages(child.uri, 'mixedTitle')).toHaveLength(1)
    expect(index.findTemplatePropUsages(child.uri, 'nestedTitle')).toHaveLength(1)
    expect(index.findTemplateEventUsages(child.uri, 'mixed-save')).toHaveLength(1)
    expect(index.findRefMethodUsages(child.uri, 'mixedMethod')).toHaveLength(1)
    expect(index.findRefMethodUsages(child.uri, 'namedMethod')).toHaveLength(1)
    expect(index.findRefMethodUsages(child.uri, 'nestedMethod')).toHaveLength(1)
    expect(index.findRefMethodUsages(inner.uri, 'focus')[0]?.sourceLocation?.uri).toBe(defaultMixinUri)
    expect(index.findProvideDefinitions(child, 'sharedService')[0]?.file.uri).toBe(parent.uri)
    expect(index.findInjectUsages(parent.uri, 'sharedService')[0]?.sourceLocation?.uri).toBe(namedMixinUri)
  })

  it('静态可证明的动态组件参与 mixin prop、emit 和 ref 方法关系', () => {
    const index = new WorkspaceIndex()
    const mixinUri = path.join(fixtureRoot, 'mixin-default.js')
    const normalUri = path.join(fixtureRoot, 'DynamicNormal.vue')
    const bigUri = path.join(fixtureRoot, 'DynamicBig.vue')
    const parentUri = path.join(fixtureRoot, 'DynamicHost.vue')
    const childContent = `
<template><div /></template>
<script>
import baseMixin from './mixin-default'
export default { mixins: [baseMixin] }
</script>
`
    const parent = index.indexContent(parentUri, `
<template>
  <component
    :is="SCREEN_TYPE[themeType]"
    ref="screen"
    :mixed-title="title"
    @mixed-save="onMixedSave"
  />
</template>
<script>
import DynamicNormal from './DynamicNormal.vue'
import DynamicBig from './DynamicBig.vue'

const SCREEN_TYPE = {
  1: 'DynamicNormal',
  2: 'DynamicBig',
}

export default {
  components: { DynamicNormal, DynamicBig },
  data() {
    return { SCREEN_TYPE }
  },
  methods: {
    callScreen() {
      this.$refs.screen.mixedMethod()
    },
  },
}
</script>
`)
    index.indexContent(normalUri, childContent)
    index.indexContent(bigUri, childContent)

    const dynamicUsage = parent.templateIndex.components.find((component) => component.tag === 'component')!
    const emitOffset = readFixture('mixin-default.js').indexOf("'mixed-save'") + 2
    const propOffset = readFixture('mixin-default.js').indexOf('mixedTitle') + 1

    expect(dynamicUsage.dynamicTags).toEqual(['DynamicNormal', 'DynamicBig'])
    expect(index.resolveTemplateComponentUris(parent, dynamicUsage).sort()).toEqual([bigUri, normalUri].sort())
    expect(index.findTemplatePropUsages(normalUri, 'mixedTitle')).toHaveLength(1)
    expect(index.findTemplatePropUsages(bigUri, 'mixedTitle')).toHaveLength(1)
    expect(index.findTemplateEventUsages(normalUri, 'mixed-save')).toHaveLength(1)
    expect(index.findTemplateEventUsages(bigUri, 'mixed-save')).toHaveLength(1)
    expect(index.findRefMethodUsages(normalUri, 'mixedMethod')).toHaveLength(1)
    expect(index.findRefMethodUsages(bigUri, 'mixedMethod')).toHaveLength(1)
    expect(index.findTemplateEventUsagesFromSource(mixinUri, emitOffset)).toHaveLength(1)
    expect(index.findTemplatePropUsagesFromSource(mixinUri, propOffset)).toHaveLength(1)
  })

  it('静态可证明的动态组件表达式和 template $emit 参与 event 关系', () => {
    const index = new WorkspaceIndex()
    const categoryUri = path.join(fixtureRoot, 'GoodsCategoryTypeList.vue')
    const channelUri = path.join(fixtureRoot, 'GoodsChannelTypeList.vue')
    const objectUri = path.join(fixtureRoot, 'ObjectChild.vue')
    const parentUri = path.join(fixtureRoot, 'StaticDynamicExpressionHost.vue')
    const category = index.indexContent(categoryUri, `
<template><button @click="onAddToCart" /></template>
<script>
export default {
  methods: {
    onAddToCart() {
      this.$emit('onAddToCart')
    },
  },
}
</script>
`)
    const channel = index.indexContent(channelUri, `
<template>
  <div>
    $emit('fakeText')
    <ProductItem
      @onClick="$emit('onAddToCart', item)"
      :title="'$emit(\\'fakeTitle\\')'"
      label="$emit('fakeStaticAttr')"
    />
  </div>
</template>
<script>
export default {}
</script>
`)
    const objectChild = index.indexContent(objectUri, `
<script>
export default {
  methods: {
    save() {
      this.$emit('save')
    },
  },
}
</script>
`)
    const parent = index.indexContent(parentUri, `
<template>
  <component :is="isCategoryMode ? 'GoodsCategoryTypeList' : 'GoodsChannelTypeList'" @onAddToCart="addToCartFromCard" />
  <component :is="COMPONENTS[index]" @save="onSave" />
  <component :is="isReady && ObjectChild" @save="onSave" />
</template>
<script>
import GoodsCategoryTypeList from './GoodsCategoryTypeList.vue'
import GoodsChannelTypeList from './GoodsChannelTypeList.vue'
import ObjectChild from './ObjectChild.vue'

const COMPONENTS = ['ObjectChild']

export default {
  components: { GoodsCategoryTypeList, GoodsChannelTypeList, ObjectChild },
  data() {
    return { COMPONENTS }
  },
}
</script>
`)

    const dynamicUsages = parent.templateIndex.components.filter((component) => component.tag === 'component')

    expect(dynamicUsages[0].dynamicTags).toEqual(['GoodsCategoryTypeList', 'GoodsChannelTypeList'])
    expect(dynamicUsages[1].dynamicTags).toEqual(['ObjectChild'])
    expect(dynamicUsages[2].dynamicTags).toEqual(['ObjectChild'])
    expect(channel.scriptIndex.emits.map((emit) => emit.eventName)).toEqual(['onAddToCart'])
    expect(index.findTemplateEventUsages(category.uri, 'onAddToCart')).toHaveLength(1)
    expect(index.findTemplateEventUsages(channel.uri, 'onAddToCart')).toHaveLength(1)
    expect(index.findTemplateEventUsages(objectChild.uri, 'save')).toHaveLength(2)
  })

  it('template $emit 只索引当前组件 emit 调用', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(fixtureRoot, 'TemplateEmitBoundary.vue'), `
<template>
  <div>
    <button @click="$emit('direct')" />
    <button @click="this.$emit('explicit')" />
    <button @click="$bus.$emit('bus')" />
    <button @click="eventBus.$emit('event-bus')" />
  </div>
</template>
<script>
export default {}
</script>
`)

    expect(file.scriptIndex.emits.map((emit) => emit.eventName)).toEqual(['direct', 'explicit'])
  })

  it('解析 Vue 2 Event Bus 的静态 emit 和 listener 调用', () => {
    const index = new WorkspaceIndex()
    const uri = path.join(fixtureRoot, 'EventBusUsage.vue')
    const file = index.indexContent(uri, `
<template>
  <div>
    <button @click="this.$bus.$emit('fromTemplate')" />
    <button @click="$bus.$on('templateListen', noop)" />
  </div>
</template>
<script>
export default {
  mounted() {
    this.$bus.$on('joinOrDeleteCollect', async ([item, isFavorite]) => {})
    this.$bus?.$emit('cancelCollect', item)
    this.$bus.$once('refreshExchangeList', () => {})
    this.$bus.$off('cancelCollect', this.onCancelCollect)
    this.$emit('local')
  },
}
</script>
`)

    expect(file.scriptIndex.eventBusCalls.map((call) => [call.method, call.kind, call.eventName])).toEqual([
      ['$on', 'listener', 'joinOrDeleteCollect'],
      ['$emit', 'emit', 'cancelCollect'],
      ['$once', 'listener', 'refreshExchangeList'],
      ['$off', 'listener', 'cancelCollect'],
      ['$emit', 'emit', 'fromTemplate'],
      ['$on', 'listener', 'templateListen'],
    ])
    expect(file.scriptIndex.emits.map((emit) => emit.eventName)).toEqual(['local'])
    expect(file.scriptIndex.eventBusCalls.every((call) => call.busName === '$bus')).toBe(true)
    expect(index.findEventBusListeners('$bus', 'joinOrDeleteCollect')).toHaveLength(1)
    expect(index.findEventBusListeners('$bus', 'cancelCollect').map((usage) => usage.method)).toEqual(['$off'])
    expect(index.findEventBusEmits('$bus', 'cancelCollect')).toHaveLength(1)
    expect(index.findEventBusEmits('$bus', 'local')).toHaveLength(0)
    expect(index.getEventBusEventNames('$bus')).toEqual(['cancelCollect', 'fromTemplate', 'joinOrDeleteCollect', 'refreshExchangeList', 'templateListen'])

    index.syncContent(uri, `
<script>
export default {
  mounted() {
    this.$bus.$emit('nextEvent')
  },
}
</script>
`)
    expect(index.getEventBusEventNames('$bus')).toEqual(['nextEvent'])
  })

  it('通过 Vue.prototype 注册入口识别非 $bus 的 Event Bus 名称', async () => {
    const index = new WorkspaceIndex()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-entry-'))
    writeText(path.join(root, 'src/index.js'), `
import Vue from 'vue'
Vue.prototype.$eventBus = new Vue()
`)
    await index.refreshEventBusRegistrations(root)
    const file = index.indexContent(path.join(root, 'CustomEventBusUsage.vue'), `
<script>
export default {
  mounted() {
    this.$eventBus.$on('refreshExchangeList', () => {})
    this.$eventBus.$emit('refreshExchangeList')
    this.$unknownBus.$emit('refreshExchangeList')
  },
}
</script>
`)

    expect(index.getEventBusNames()).toContain('$eventBus')
    expect(file.scriptIndex.eventBusCalls.map((call) => [call.busName, call.kind, call.eventName])).toEqual([
      ['$eventBus', 'listener', 'refreshExchangeList'],
      ['$eventBus', 'emit', 'refreshExchangeList'],
    ])
    expect(index.findEventBusListeners('$eventBus', 'refreshExchangeList')).toHaveLength(1)
    expect(index.findEventBusEmits('$eventBus', 'refreshExchangeList')).toHaveLength(1)
    expect(index.findEventBusEmits('$unknownBus', 'refreshExchangeList')).toHaveLength(0)
  })

  it('Event Bus 入口配置优先于默认入口', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-config-entry-'))
    writeText(path.join(root, 'src/main.js'), `
import Vue from 'vue'
Vue.prototype.$defaultBus = new Vue()
`)
    writeText(path.join(root, 'custom/start.js'), `
import Vue from 'vue'
Vue.prototype.$configuredBus = new Vue()
`)

    const index = new WorkspaceIndex()
    await index.indexWorkspace(root, undefined, ['custom/start'])

    expect(index.getEventBusNames()).toContain('$configuredBus')
    expect(index.getEventBusNames()).not.toContain('$defaultBus')
  })

  it('Event Bus 入口配置和一层 import 支持 jsconfig 别名', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-alias-entry-'))
    writeText(path.join(root, 'jsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
        },
      },
    }))
    writeText(path.join(root, 'src/entry.js'), `
import '@/plugins/event-bus'
`)
    writeText(path.join(root, 'src/plugins/event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$aliasBus = new Vue()
`)

    const index = new WorkspaceIndex()
    await index.indexWorkspace(root, undefined, '@/entry')

    expect(index.getEventBusNames()).toContain('$aliasBus')
  })

  it('Event Bus 入口探测只查 src/index|main 和一层 import', async () => {
    const oneLevelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-one-level-'))
    writeText(path.join(oneLevelRoot, 'src/main.js'), `
import './plugins/event-bus'
import('./plugins/dynamic-event-bus')
require('./plugins/require-event-bus')
import('./plugins/deep-entry')
`)
    writeText(path.join(oneLevelRoot, 'src/plugins/event-bus.js'), `
import Vue from 'vue'
const bus = new Vue()
Vue.prototype.$eventBus = bus
`)
    writeText(path.join(oneLevelRoot, 'src/plugins/dynamic-event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$dynamicBus = new Vue()
`)
    writeText(path.join(oneLevelRoot, 'src/plugins/require-event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$requireBus = new Vue()
`)
    writeText(path.join(oneLevelRoot, 'src/plugins/deep-entry.js'), `
import './deep-event-bus'
`)
    writeText(path.join(oneLevelRoot, 'src/plugins/deep-event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$deepImportedBus = new Vue()
`)

    const oneLevelIndex = new WorkspaceIndex()
    await oneLevelIndex.refreshEventBusRegistrations(oneLevelRoot)
    expect(oneLevelIndex.getEventBusNames()).toContain('$eventBus')
    expect(oneLevelIndex.getEventBusNames()).toContain('$dynamicBus')
    expect(oneLevelIndex.getEventBusNames()).toContain('$requireBus')
    expect(oneLevelIndex.getEventBusNames()).not.toContain('$deepImportedBus')

    const deepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-deep-'))
    writeText(path.join(deepRoot, 'src/index.js'), `
import './bootstrap'
`)
    writeText(path.join(deepRoot, 'src/bootstrap.js'), `
import './plugins/event-bus'
`)
    writeText(path.join(deepRoot, 'src/plugins/event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$deepBus = new Vue()
`)

    const deepIndex = new WorkspaceIndex()
    await deepIndex.refreshEventBusRegistrations(deepRoot)
    expect(deepIndex.getEventBusNames()).not.toContain('$deepBus')
  })

  it('Event Bus 入口探测会检查 index 直接动态 import 的每个文件', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-event-bus-index-imports-'))
    writeText(path.join(root, 'src/index.js'), `
import('./bootstrap')
import('./entry')
`)
    writeText(path.join(root, 'src/bootstrap.js'), `
import './plugins/nested-event-bus'
import Vue from 'vue'
Vue.prototype.$bootstrapBus = new Vue()
`)
    writeText(path.join(root, 'src/entry.js'), `
import Vue from 'vue'
Vue.prototype.$entryBus = new Vue()
`)
    writeText(path.join(root, 'src/plugins/nested-event-bus.js'), `
import Vue from 'vue'
Vue.prototype.$nestedBus = new Vue()
`)

    const index = new WorkspaceIndex()
    await index.refreshEventBusRegistrations(root)

    expect(index.getEventBusNames()).toContain('$bootstrapBus')
    expect(index.getEventBusNames()).toContain('$entryBus')
    expect(index.getEventBusNames()).not.toContain('$nestedBus')
  })

  it('忽略动态 mixin 表达式', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(fixtureRoot, 'DynamicMixin.vue'), `
<template><div /></template>
<script>
import baseMixin from './mixin-default'
export default {
  mixins: [enabled ? baseMixin : null],
}
</script>
`)

    expect(file.scriptIndex.mixins).toHaveLength(0)
    expect(file.scriptIndex.props).toHaveLength(0)
    expect(file.scriptIndex.methods).toHaveLength(0)
  })

  it('静态 mixin 循环引用不会导致递归解析', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(fixtureRoot, 'CycleMixinConsumer.vue'), `
<template><div /></template>
<script>
import cycleA from './mixin-cycle-a'
export default {
  mixins: [cycleA],
}
</script>
`)

    expect(file.scriptIndex.methods.map((method) => method.name).sort()).toEqual(['cycleA', 'cycleB'])
  })

  it('命名导出不存在时不会把同文件其他 mixin 的 emit 合并进来', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(fixtureRoot, 'MissingNamedMixinConsumer.vue'), `
<template><div /></template>
<script>
import { missingMixin } from './mixin-export-miss'
export default {
  mixins: [missingMixin],
}
</script>
`)

    expect(findEmit(file, 'other-event')).toHaveLength(0)
  })

  it('解析静态 provide 和 inject 关系', () => {
    const index = new WorkspaceIndex()
    const provider = index.indexContent(path.join(fixtureRoot, 'Provider.vue'), `
<template><Consumer /></template>
<script>
import Consumer from './Consumer.vue'
export default {
  components: { Consumer },
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
<template><ChangingConsumer /></template>
<script>
import ChangingConsumer from './ChangingConsumer.vue'
export default {
  components: { ChangingConsumer },
  provide: {
    service: this.service,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service').map((usage) => usage.file.uri)).toEqual([provider.uri])
    expect(index.findInjectUsages(provider.uri, 'service')).toHaveLength(1)

    index.syncContent(providerUri, `
<template><ChangingConsumer /></template>
<script>
import ChangingConsumer from './ChangingConsumer.vue'
export default {
  components: { ChangingConsumer },
  provide: {
    renamedService: this.service,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service')).toHaveLength(0)
    expect(index.findInjectUsages(provider.uri, 'service')).toHaveLength(0)
  })

  it('父组件模板更新后同步清理 provide/inject 静态父链', () => {
    const index = new WorkspaceIndex()
    const providerUri = path.join(fixtureRoot, 'TemplateChangingProvider.vue')
    const consumerUri = path.join(fixtureRoot, 'TemplateChangingConsumer.vue')
    const consumer = index.indexContent(consumerUri, `
<template><div /></template>
<script>
export default {
  inject: ['service'],
}
</script>
`)
    const provider = index.indexContent(providerUri, `
<template><TemplateChangingConsumer /></template>
<script>
import TemplateChangingConsumer from './TemplateChangingConsumer.vue'
export default {
  components: { TemplateChangingConsumer },
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
    service: this.service,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service')).toHaveLength(0)
    expect(index.findInjectUsages(provider.uri, 'service')).toHaveLength(0)
  })

  it('provide/inject 静态父链不把当前组件自身当作祖先', () => {
    const index = new WorkspaceIndex()
    const file = index.indexContent(path.join(fixtureRoot, 'SelfProvideInject.vue'), `
<template><div /></template>
<script>
export default {
  provide: {
    service: this.service,
  },
  inject: ['service'],
}
</script>
`)

    expect(index.findProvideDefinitions(file, 'service')).toHaveLength(0)
    expect(index.findInjectUsages(file.uri, 'service')).toHaveLength(0)
  })

  it('inject 优先匹配每条静态父链最近的 provide', () => {
    const index = new WorkspaceIndex()
    const consumerUri = path.join(fixtureRoot, 'NearestConsumer.vue')
    const parentUri = path.join(fixtureRoot, 'NearestParent.vue')
    const grandParentUri = path.join(fixtureRoot, 'NearestGrandParent.vue')
    const consumer = index.indexContent(consumerUri, `
<template><div /></template>
<script>
export default {
  inject: ['service'],
}
</script>
`)
    const parent = index.indexContent(parentUri, `
<template><NearestConsumer /></template>
<script>
import NearestConsumer from './NearestConsumer.vue'
export default {
  components: { NearestConsumer },
  provide: {
    service: this.parentService,
  },
}
</script>
`)
    const grandParent = index.indexContent(grandParentUri, `
<template><NearestParent /></template>
<script>
import NearestParent from './NearestParent.vue'
export default {
  components: { NearestParent },
  provide: {
    service: this.grandParentService,
  },
}
</script>
`)

    expect(index.findProvideDefinitions(consumer, 'service').map((usage) => usage.file.uri)).toEqual([parent.uri])
    expect(index.findInjectUsages(parent.uri, 'service').map((usage) => usage.file.uri)).toEqual([consumer.uri])
    expect(index.findInjectUsages(grandParent.uri, 'service')).toHaveLength(0)
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

  it('$refs 支持按需读取 Element UI 组件类型方法', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-element-ui-ref-'))
    writeElementUiTypes(root)
    const parentUri = path.join(root, 'src/Parent.vue')
    writeText(parentUri, `
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
    this.$refs.form?.resetFields()
    this.$refs?.input?.focus()
  },
}
</script>
`)

    const index = new WorkspaceIndex()
    await index.indexWorkspace(root)
    const parent = index.getFile(parentUri)!
    const formTypeUri = path.join(root, 'node_modules/element-ui/types/form.d.ts')
    const inputTypeUri = path.join(root, 'node_modules/element-ui/types/input.d.ts')

    expect(index.resolveRefComponent(parent, 'form')).toBe(formTypeUri)
    expect(index.resolveRefComponent(parent, 'input')).toBe(inputTypeUri)
    expect(index.getFile(formTypeUri)?.scriptIndex.methods.map((method) => method.name)).toEqual(['validate', 'resetFields', 'clearValidate'])
    expect(index.getFile(inputTypeUri)?.scriptIndex.methods.map((method) => method.name)).toEqual(['focus', 'blur', 'select'])
    expect(index.findRefMethodUsages(formTypeUri, 'validate')).toHaveLength(1)
    expect(index.findRefMethodUsages(formTypeUri, 'resetFields')).toHaveLength(1)
    expect(index.findRefMethodUsages(inputTypeUri, 'focus')).toHaveLength(1)
    expect(index.findTemplatePropUsages(formTypeUri, 'model')).toHaveLength(0)
  })

  it('$refs 支持按需读取 Vant 组件类型方法', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-vant-ref-'))
    writeVantTypes(root)
    const parentUri = path.join(root, 'src/Parent.vue')
    writeText(parentUri, `
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
    this.$refs.form?.validate()
  },
}
</script>
`)

    const index = new WorkspaceIndex()
    await index.indexWorkspace(root)
    const parent = index.getFile(parentUri)!
    const fieldTypeUri = path.join(root, 'node_modules/vant/types/field.d.ts')
    const formTypeUri = path.join(root, 'node_modules/vant/types/form.d.ts')

    expect(index.resolveRefComponent(parent, 'field')).toBe(fieldTypeUri)
    expect(index.resolveRefComponent(parent, 'form')).toBe(formTypeUri)
    expect(index.getFile(fieldTypeUri)?.scriptIndex.methods.map((method) => method.name)).toEqual(['focus', 'blur'])
    expect(index.getFile(formTypeUri)?.scriptIndex.methods.map((method) => method.name)).toEqual(['submit', 'validate', 'resetValidation', 'scrollToField'])
    expect(index.findRefMethodUsages(fieldTypeUri, 'focus')).toHaveLength(1)
    expect(index.findRefMethodUsages(formTypeUri, 'validate')).toHaveLength(1)
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

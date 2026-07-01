# vue-component-navigator

给 Vue 2 Options API 项目和 Vue 3 `<script setup>` 静态关系使用的 VS Code 导航辅助插件。

> English documentation: [README.md](./README.md)

这个插件主要处理 Vue 项目里容易断开的静态关系。Vue 2 继续支持 `$refs`、组件 props/events、slots、`provide` / `inject`、mixins、全局组件，以及常见的 Event Bus。Vue 3 支持范围更聚焦，当前覆盖 `defineProps`、`defineEmits`、`defineModel`、`defineSlots`、`defineExpose`、静态动态组件和静态 `provide` / `inject` 这类类型化组件契约。

它不会替代 Vue 官方工具。比如局部组件标签名的定义跳转会交给官方扩展处理，避免同一个位置出现重复结果。

## 功能演示

### `$refs` 跳转

展示从 `this.$refs.child.open()` 跳到子组件方法，并展示方法补全和 hover。

##### ![$refs 跳转](docs/gifs/refs-navigation.gif)


### Props 和 Events

展示模板 prop 到子组件 prop 定义、模板事件到 `this.$emit(...)`、hover 概览和反向引用。

##### ![Props 和 Events](docs/gifs/props-events.gif)

### Event Bus

展示 `$emit`、`$on`、`$once`、`$off` 的跳转、事件名补全、方法补全，以及 hover 中的方法标记。

##### ![Event Bus](docs/gifs/event-bus.gif)


### `provide` / `inject`

展示静态 `inject` key 跳到最近的静态 provider，以及 provider 反查 consumer。

##### ![provide inject](docs/gifs/provide-inject.gif)


## 支持的场景

- `$refs` 方法跳转、补全、hover 和引用查询。
- 模板 prop 跳到子组件 prop 定义。
- 模板事件和子组件 `this.$emit(...)` 互相跳转。
- 在组件 `<template>` 标签处显示组件用法 CodeLens，并支持 template 标签和静态 `.vue` import 用法的点击跳转。
- Vue 2 通过 `v-bind="$attrs"` / `v-on="$listeners"` wrapper 透传的 prop 和 listener 导航，包括可静态解析的动态组件候选。
- Vue 2 子组件 `<slot name="...">` 定义和父组件 `slot="..."` 使用之间的关系。
- Vue 2 Event Bus 静态字符串事件名导航。
- 静态 `provide` / `inject` key 跳转和补全。
- 静态局部组件 import、异步组件 import、简单别名。
- workspace 内 `.js`、`.ts`、`.vue` 文件中的静态 mixin。
- `Vue.component(...)` 这类静态全局组件注册。
- 已支持第三方库的 `$refs` 方法类型，例如 Element UI 的 `el-form.validate()` 和 Vant 的 `van-field.focus()`。
- Vue 3 `<script setup>` 中的局部组件 import。
- Vue 3 `defineProps<Props>()` / `defineProps<{ ... }>()` 的类型成员与组件内部静态 prop 使用。
- Vue 3 `defineEmits` 声明和 `emit('confirm')` 这类调用与父组件模板监听的关系。
- Vue 3 通过 `v-bind="$attrs"` 透传的 listener 与子组件 `defineEmits` 声明关系。
- Vue 3 `defineModel()` / `defineModel('show')` 与父组件 `v-model` / `v-model:show` 使用的关系。
- Vue 3 `defineSlots<{ ... }>()` 与父组件 `#slot` / `v-slot:slot` 使用的关系。
- Vue 3 `defineExpose({ open })` 与父组件 `childRef.value?.open()` 这类 template ref 调用的关系。
- Vue 3 `<component :is="componentMap[type]" />` 使用的静态动态组件 map 候选。
- Vue 3 composable / hook 返回成员从源码定义到消费端解构使用的反向引用。
- Vue 3 静态 `provide('key', value)` / `inject('key')` 和 `InjectionKey` / `Symbol` key 关系。
- 从最近的 `jsconfig.json` 或 `tsconfig.json` 读取 `@/` 这类路径别名。

## 关系示例

### Vue 3 `defineModel` 和父组件 `v-model`

子组件可以用 `defineModel` 声明 model 契约。在子组件 model 定义处 hover 或查找引用，可以看到父组件的 `v-model` 使用；父组件 `v-model` 使用处也可以跳回子组件契约。

```vue
<!-- Child.vue -->
<script setup lang="ts">
defineModel<boolean>('visible')
const modelValue = defineModel<string>()
</script>
```

```vue
<!-- Parent.vue -->
<template>
  <Child v-model:visible="visible" v-model="title" />
</template>
```

### Vue 3 `defineSlots` 和父组件 slot 使用

`defineSlots` 声明的 slot 契约会和父组件 `#name` / `v-slot:name` 使用关联。扫描时只把直接子节点里的 slot 模板归属给当前组件，嵌套组件里的 slot 不会误算到外层组件。

```vue
<!-- Child.vue -->
<script setup lang="ts">
defineSlots<{
  footer?: () => any
  default?: () => any
}>()
</script>
```

```vue
<!-- Parent.vue -->
<template>
  <Child>
    <template #footer>Footer</template>
  </Child>
</template>
```

### Vue 3 `defineExpose` 和 template ref

子组件暴露的方法会和父组件 template ref 调用关联。扩展只索引能匹配到子组件 `defineExpose` 的方法；普通 `.value` ref 不会被当作组件方法调用。

```vue
<!-- Child.vue -->
<script setup lang="ts">
function open() {}

defineExpose({ open })
</script>
```

```vue
<!-- Parent.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import Child from './Child.vue'

const childRef = ref<InstanceType<typeof Child>>()

childRef.value?.open()
</script>

<template>
  <Child ref="childRef" />
</template>
```

Vue 3.5 的 `useTemplateRef` 名称也支持：

```vue
<script setup lang="ts">
const panel = useTemplateRef<InstanceType<typeof Child>>('childRef')

panel.value?.open()
</script>

<template>
  <Child ref="childRef" />
</template>
```

### Vue 3 静态动态组件 map

`<script setup>` 中的静态对象 map 被 `<component :is="...">` 使用时，会参与组件用法关系。

```vue
<script setup lang="ts">
import UserPanel from './UserPanel.vue'
import OrderPanel from './OrderPanel.vue'

const componentMap = {
  user: UserPanel,
  order: OrderPanel,
}
</script>

<template>
  <component :is="componentMap[type]" />
</template>
```

`UserPanel` 和 `OrderPanel` 都会被识别为可能的动态组件用法。

### Vue 3 composable 返回成员使用

Composable 返回成员可以从源码定义反查到消费端解构后的使用位置。在 hook 源码里的 `runVerifyWithCode` 上 hover 或查找引用，可以看到哪些消费文件调用了这个返回成员。

```ts
// hooks/use-verify.ts
const useVerify = () => {
  const runVerifyWithCode = async (code: string) => code

  return {
    runVerifyWithCode,
  }
}

export default useVerify
```

```vue
<!-- VerifyPanel.vue -->
<script setup lang="ts">
import useVerify from './hooks/use-verify'

const { runVerifyWithCode } = useVerify()

runVerifyWithCode('code')
</script>
```

### Vue 2 slots

Vue 2 子组件 slot 定义会和父组件 legacy slot 使用关联。在子组件 `<slot name="...">` 处 hover 或查找引用可以看到父组件使用，父组件 `slot="..."` 也可以跳回子组件 slot 定义。

```vue
<!-- Child.vue -->
<template>
  <section>
    <slot />
    <slot name="footer" />
    <slot name="actionBar" />
  </section>
</template>
```

```vue
<!-- Parent.vue -->
<template>
  <Child>
    <template slot="footer">Footer</template>
    <button slot="action-bar">Action</button>
  </Child>
</template>
```

## Event Bus 入口

Event Bus 名称需要能从 Vue prototype 注册中识别，例如：

```js
Vue.prototype.$bus = new Vue()
Vue.prototype.$eventBus = new Vue()
```

默认会检查这些入口：

- `src/main.js`
- `src/index.js`
- `src/main.ts`
- `src/index.ts`

如果项目入口不在这些文件里，可以显式配置：

```json
{
  "vueComponentNavigator.entry": "src/bootstrap.js"
}
```

也可以配置多个入口：

```json
{
  "vueComponentNavigator.entry": ["src/bootstrap.js", "@/entry"]
}
```

入口路径支持 workspace 相对路径，也支持 `jsconfig.json` / `tsconfig.json` 中 `compilerOptions.baseUrl` 和 `compilerOptions.paths` 定义的别名。

扫描范围只包括入口文件本身，以及入口直接字面量 `import`、`import()`、`require()` 的一层文件。不会继续递归扫整个项目。

只有在这些入口文件中识别到的 bus 名称才会参与 Event Bus 分析。`$bus` 不再有内置兜底。

## 命令

| 命令 | 说明 |
| --- | --- |
| `Vue Component Navigator: Show Status` | 查看索引状态，以及当前文件是否已被索引。 |
| `Vue Component Navigator: Reindex Workspace` | 手动重建 workspace 索引。大型重构或配置变更后可以使用。 |

## 配置

| 配置 | 说明 |
| --- | --- |
| `vueComponentNavigator.entry` | Event Bus 注册入口文件。支持字符串或字符串数组。 |

## 边界

- Vue 2 和 Vue 3 workspace 会按检测到的 Vue 主版本分别索引，两套能力边界保持隔离。
- 忽略 workspace 外部文件。

解析策略会尽量保守。静态证明不了的关系，不返回猜测结果。

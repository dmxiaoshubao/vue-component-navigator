# vue-component-navigator

VS Code navigation helpers for Vue 2 Options API projects and focused Vue 3 `<script setup>` relationships.

> 中文文档: [README.zh-CN.md](./README.zh-CN.md)

This extension focuses on relationships that are easy to miss in Vue codebases. Vue 2 keeps the existing `$refs`, component props/events, slots, `provide` / `inject`, mixins, global components, and Event Bus support. Vue 3 support is intentionally narrower and targets typed component contracts such as `defineProps`, `defineEmits`, `defineModel`, `defineSlots`, `defineExpose`, static dynamic components, and static `provide` / `inject`.

It does not try to replace the official Vue tooling. Local component tag definitions are intentionally left alone to avoid duplicate results.

## Demos

### `$refs` Navigation

Shows jumping from `this.$refs.child.open()` to the child component method, with method completion and hover.

##### ![refs navigation](docs/gifs/refs-navigation.gif)


### Props And Events

Shows template prop definition lookup, component `$emit` lookup, hover summaries, and reverse references.

##### ![props and events](docs/gifs/props-events.gif)

### Event Bus

Shows `$emit`, `$on`, `$once`, and `$off` navigation, event-name completion, method completion, and hover labels.

##### ![event bus](docs/gifs/event-bus.gif)

### `provide` / `inject`

Shows jumping from static `inject` keys to the nearest static provider, and from providers back to consumers.

##### ![provide inject](docs/gifs/provide-inject.gif)


## What It Handles

- `$refs` method navigation, completion, hover, and references.
- Component prop navigation from template usage to child prop definitions.
- Component event navigation between template listeners and `this.$emit(...)`.
- Component usage CodeLens on the component `<template>` tag, with click-through usage navigation for template tags and static `.vue` imports.
- Vue 2 fallthrough prop and listener navigation through `v-bind="$attrs"` / `v-on="$listeners"` wrappers, including statically resolved dynamic component candidates.
- Vue 2 slot relationships from child `<slot name="...">` definitions to parent `slot="..."` usages.
- Vue 2 Event Bus navigation for static string event names.
- Static `provide` / `inject` key navigation and completion.
- Static local component imports, async component imports, and simple aliases.
- Static mixins imported from workspace `.js`, `.ts`, or `.vue` files.
- Static global component registrations such as `Vue.component(...)`.
- Third-party `$refs` methods for supported libraries, such as Element UI `el-form.validate()` and Vant `van-field.focus()`.
- Vue 3 `<script setup>` local component imports.
- Vue 3 `defineProps<Props>()` / `defineProps<{ ... }>()` type members and static internal prop usages.
- Vue 3 `defineEmits` declarations and calls such as `emit('confirm')` linked to parent template listeners.
- Vue 3 `v-bind="$attrs"` listener fallthrough linked to child `defineEmits` declarations.
- Vue 3 `defineModel()` / `defineModel('show')` relationships to parent `v-model` / `v-model:show` usages.
- Vue 3 `defineSlots<{ ... }>()` relationships to parent `#slot` / `v-slot:slot` usages.
- Vue 3 `defineExpose({ open })` relationships to parent template-ref calls such as `childRef.value?.open()`.
- Vue 3 static dynamic component map candidates used by `<component :is="componentMap[type]" />`.
- Vue 3 composable / hook return-member reverse references from source definitions to destructured consumer usages.
- Vue 3 static `provide('key', value)` / `inject('key')` and `InjectionKey` / `Symbol` key relationships.
- `@/` style aliases from the nearest `jsconfig.json` or `tsconfig.json`.

## Relationship Examples

### Vue 3 `defineModel` And Parent `v-model`

Child components can declare model contracts with `defineModel`. Hover or references on the child model definition show parent `v-model` usages. Parent `v-model` usage can jump back to the child model contract.

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

### Vue 3 `defineSlots` And Parent Slot Usage

Slot contracts declared with `defineSlots` are linked to parent `#name` and `v-slot:name` usages. The scanner only treats direct child slot templates as belonging to that component, so nested component slots are not attributed to the outer component.

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

### Vue 3 `defineExpose` And Template Refs

Exposed methods are linked to parent template-ref calls. The extension only indexes calls that match methods statically exposed by the child component; general `.value` refs are ignored.

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

Vue 3.5 `useTemplateRef` names are also handled:

```vue
<script setup lang="ts">
const panel = useTemplateRef<InstanceType<typeof Child>>('childRef')

panel.value?.open()
</script>

<template>
  <Child ref="childRef" />
</template>
```

### Vue 3 Static Dynamic Component Maps

Static object maps in `<script setup>` can participate in component usage relationships when they are used by `<component :is="...">`.

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

Both `UserPanel` and `OrderPanel` are indexed as possible dynamic component usages.

### Vue 3 Composable Return Usages

Composable return members can be reverse-linked from the source definition to destructured consumer usages. Hover or references on `runVerifyWithCode` in the hook source show where consumers call the returned member.

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

### Vue 2 Slots

Vue 2 child slot definitions are linked to parent legacy slot usages. Hover or references on the child `<slot name="...">` show parent usages, and `slot="..."` can jump back to the child slot definition.

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

## Event Bus Entry

Event Bus names are detected from Vue prototype registrations such as:

```js
Vue.prototype.$bus = new Vue()
Vue.prototype.$eventBus = new Vue()
```

By default, the extension checks these entry files:

- `src/main.js`
- `src/index.js`
- `src/main.ts`
- `src/index.ts`

If your project uses a different bootstrap file, configure it explicitly:

```json
{
  "vueComponentNavigator.entry": "src/bootstrap.js"
}
```

Multiple entries are also supported:

```json
{
  "vueComponentNavigator.entry": ["src/bootstrap.js", "@/entry"]
}
```

Configured entries support workspace-relative paths and aliases from `compilerOptions.baseUrl` / `compilerOptions.paths` in `jsconfig.json` or `tsconfig.json`.

The scanner only checks the entry file and one layer of literal `import`, `import()`, or `require()` targets. It does not recursively crawl the whole project.

Event Bus usage is ignored until the bus name is found from these entry files. There is no built-in fallback for `$bus`.

## Commands

| Command | Description |
| --- | --- |
| `Vue Component Navigator: Show Status` | Shows index status and whether the active file is indexed. |
| `Vue Component Navigator: Reindex Workspace` | Rebuilds the workspace index. Use it after large refactors or config changes. |

## Configuration

| Setting | Description |
| --- | --- |
| `vueComponentNavigator.entry` | Event Bus registration entry file or files. Accepts a string or string array. |

## Boundaries

- Vue 2 and Vue 3 workspaces are indexed by detected Vue major version; their feature sets are intentionally separated.
- Files outside the workspace are ignored.

The parser is deliberately conservative. When a relationship cannot be proven statically, the extension avoids returning a misleading result.

# vue-component-navigator

一个用于增强 Vue 2 Options API `.vue` 单文件组件导航能力的 VS Code 扩展。

> English documentation: [README.md](./README.md)

## 功能覆盖

| 能力范围 | 是否支持 | 说明 |
| --- | --- | --- |
| `$refs` 方法定义跳转 | 支持 | 从 `this.$refs.child.method()` 跳到子组件方法。支持 `this.$refs.child?.method()` 和 `this.$refs?.child?.method()`。 |
| `$refs` 方法补全 | 支持 | 基于静态解析到的子组件补全 methods，并提高排序优先级。 |
| `$refs` 方法悬浮 | 支持 | 展示方法签名、JSDoc 摘要、参数和定义链接。 |
| `$emit` 到模板监听 | 支持 | 从 `this.$emit('event')` 跳到父组件模板里的事件监听位置。 |
| 模板事件到子组件 emit | 支持 | 从 `@event` / `v-on:event` 跳到子组件内匹配的 `this.$emit('event')`。支持 `.once`、`.stop` 等修饰符。 |
| 模板 prop 到子组件 prop | 支持 | 从 `:prop`、`v-bind:prop`、静态 prop、`.sync` prop 跳到子组件 prop 定义。 |
| 模板 prop / prop 定义悬浮 | 支持 | 展示 prop 定义片段、JSDoc 摘要、定义链接，并在 prop 定义处展示模板使用概览。 |
| 模板事件悬浮 | 支持 | 在模板监听处展示 emit 定义，在 emit 位置展示引用概览。 |
| prop / event / ref 反向引用 | 支持 | 基于索引关系查找父组件模板 prop 使用、事件监听和 `$refs` 方法调用。 |
| `provide` / `inject` 导航 | 支持 | 从静态 `inject` key 跳到匹配的 `provide` key，也支持从 `provide` key 反向跳到静态 inject 消费方。 |
| `provide` / `inject` 悬浮和引用 | 支持 | 展示 provider / consumer 概览，并为静态 provide key 返回 inject 引用。 |
| 局部组件关系 | 支持 | 支持 `components` 中的静态 default import、静态别名，以及 `() => import('./Child.vue')` 或 `resolve => require(['./Child.vue'], resolve)` 这类异步组件注册。局部组件标签名跳转刻意交给 Vue 官方扩展，避免重复定义。 |
| 静态 mixin 关系 | 支持 | 合并 workspace 内 `.js`、`.ts` 或 `.vue` 文件中静态 import 的 `mixins: [foo]`，支持 `export default { ... }` 和 `export const foo = { ... }` 对象字面量 mixin。mixin 内的 props、methods、emits、provide/inject、局部组件和 `$refs` 方法调用会参与导航。 |
| 全局组件关系 | 支持 | 支持静态可证明的 `Vue.component(...)` / `app.component(...)` 风格全局注册。 |
| `Component.name` 全局注册 | 支持 | 支持 `Vue.component(Component.name, Component)`，会读取被 import 的 `.vue` 组件 `name`。 |
| 常量组件名全局注册 | 支持 | 支持 `const name = 'MyComponent'; Vue.component(name, MyComponent)`。 |
| `require.context` 全局注册 | 部分支持 | 保守支持 Vue 2 常见自动注册模式，如 `require.context('./components', true, /\.vue$/)`，并读取每个 `.vue` 的 `name`。 |
| `@/` 别名 import | 支持 | 从最近的 `tsconfig.json` 或 `jsconfig.json` 读取 `compilerOptions.baseUrl` 和 `compilerOptions.paths`；没有配置时不额外猜测别名。 |
| 工作区重建索引 | 支持 | 提供 `Vue Component Navigator: Reindex Workspace` 命令，并维护内存索引用于快速响应 provider。 |
| 增量更新 | 支持 | `.vue` 编辑/保存会更新索引；相关 `.js`、`.ts` 或全局组件源文件变化时会刷新全局组件映射。 |

## 范围与限制

| 范围 | 状态 | 原因 |
| --- | --- | --- |
| Vue 版本 | Vue 2 Options API | 解析器面向 Vue 2 Options API SFC 做了优化。 |
| Vue 3 / `<script setup>` | 不支持 | 现代 Vue 场景官方 Vue 工具通常覆盖得更好。 |
| 动态组件注册 | 不支持 | 无法静态证明的组件注册不做猜测，避免误跳转；静态异步 import 支持。 |
| 动态或全局 mixin | 不支持 | 只合并静态 import 的局部 `mixins: [...]`；`Vue.mixin(...)`、spread、条件 mixin 和 package mixin 会被忽略。 |
| 动态 refs / prop 名 / event 名 | 不支持 | 只索引静态可证明的关系。 |
| 动态 provide / inject key | 不支持 | 只索引静态字符串/对象 key；不会推断运行时祖先/后代作用域。 |
| 局部组件标签名定义跳转 | 刻意不处理 | 避免和 Vue 官方扩展产生重复定义；局部组件的 prop、event、ref 关系仍支持。 |
| 第三方 package 组件 | 忽略 | 解析到 `node_modules` 的组件会被过滤，即使它通过 Element UI 这类插件全局注册。 |
| workspace 外部组件源 | 忽略 | 保证索引安全且边界明确。 |
| 复杂 JavaScript 解析 | 尽力支持 | 使用轻量静态解析；不支持的语法会被忽略，而不是猜测。 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `Vue Component Navigator: Show Status` | 展示当前索引状态和当前文件覆盖情况。 |
| `Vue Component Navigator: Reindex Workspace` | 手动重建工作区索引。大型重构后或扩展宿主已运行时建议使用。 |

## 设计原则

- 优先静态证明，不做动态猜测。
- 避免重复 Vue 官方扩展已经支持的能力，尤其是局部组件标签名定义跳转。
- 保持索引轻量，适配大型 Vue 2 工作区。
- 对不安全或有歧义的动态模式保持忽略，不产出不可靠结果。

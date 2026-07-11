# vue-component-navigator

给 Vue 2 Options API 项目和 Vue 3 `<script setup>` 静态关系使用的 VS Code 导航辅助插件。

> English documentation: [README.md](./README.md)

这个插件主要处理 Vue 项目里容易断开的静态关系。它是 Vue 官方工具的补充，不会替代官方扩展；局部组件标签名的定义跳转会交给 Vue 语言扩展处理，避免同一个位置出现重复结果。

当前文档对应功能版本：`2.1.0`。

## 2.0 运行时隔离

`2.0.0` 围绕 Vue 主版本隔离重建索引器。同一套扩展代码可以同时维护 Vue 2 和 Vue 3 能力，但在具体项目里只会运行匹配该项目主版本的一套运行时。

- Vue 2 保留 Options API 能力，包括 mixins、Event Bus、全局组件和第三方 `$refs` 辅助。
- Vue 2 SFC block 通过轻量的词法块扫描切分，`v-bind.sync` 等合法的 Vue 2 模板语法不会再中断索引。
- Vue 3 使用 `@vue/language-core` 获取 SFC 结构和宏相关 script ranges，不再走旧的 Vue 3 script parser 路径。
- Vue 3 关系索引聚焦静态组件契约：`defineProps`、`defineEmits`、`defineModel`、`defineSlots`、`defineExpose`、typed template refs、composable 返回成员，以及静态 provide/inject key。
- Vue 2 和 Vue 3 的关系图与反向索引重建按检测到的 package 版本隔离。跨版本组件 import 会被忽略，runtime 缓存失效仅作用于所属 package root。
- VSIX 会复用 VS Code 内置 TypeScript runtime 做 Vue 3 索引，不再把完整 TypeScript 打进 `extension.js`。

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

## 功能矩阵

| 能力             | 支持的关系                                                                               | Vue 2                                                        | Vue 3                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 编辑器动作       | 已索引关系上的定义跳转、引用查询、hover、补全和 CodeLens。                               | 支持                                                         | 支持已索引的静态关系                                                                            |
| 组件用法         | 静态组件 import、异步组件 import、简单别名、用法 CodeLens、命令式组件 API 调用，以及静态 `.vue` import 用法。 | 支持，包括 `Vue.extend` / JSX 命令模块                        | 支持 `<script setup>`、`createApp` / `h` / JSX 命令模块和静态动态组件 map                        |
| Props            | 模板 prop 使用到子组件 prop 定义，包括 `$attrs` wrapper 透传。                           | 支持                                                         | `defineProps` 内联类型、命名类型、导入类型、命名泛型类型成员、组件内部 prop 使用、`$attrs` / `useAttrs()` / `mergeProps()` 透传、静态对象 `v-bind` |
| Events / emits   | 模板监听到组件事件声明和 emit 调用点。                                                   | `this.$emit(...)` 和 `$listeners` wrapper 透传               | `defineEmits` 内联对象/数组、调用签名、命名/导入/泛型类型成员，以及 emit 调用                   |
| Models           | model 使用到组件 model 契约。                                                            | 静态可见时通过 prop 和 event 关系覆盖                        | `defineModel()` 和 `defineModel('name')` 到 `v-model` / `v-model:name` 的 model prop 与 `update:*` event |
| Slots            | slot 定义到父组件 slot 使用。                                                            | legacy `<slot name>` 和 `slot="..."` 关系                    | `defineSlots` 内联类型、命名类型、导入类型、命名泛型类型成员到 `#name` / `v-slot:name`          |
| Template refs    | ref 方法调用到子组件方法。                                                               | `this.$refs.name.method()` 的补全、hover、定义跳转和引用查询 | `ref.value?.method()`、非空断言、类型断言、TSX/h refs 和 `useTemplateRef<T>()`                  |
| Exposed methods  | 暴露的公开方法到父组件 ref 调用。                                                        | 通过 `$refs` 访问的组件 methods                              | `defineExpose` 本地函数、对象方法、async 方法、函数表达式、内联箭头函数和 composable 转发       |
| Composables      | 返回成员到消费端解构使用。                                                               | 不适用                                                       | 静态 composable / hook 返回成员反向引用                                                         |
| Provide / inject | 静态 provider key 到 consumer。                                                          | 静态字符串 key                                               | 静态字符串、静态 `Symbol` key 和 `InjectionKey` 关系                                            |
| Mixins           | workspace 文件中的静态 imported mixin 成员。                                             | 支持 `.js`、`.ts`、`.vue` 文件                               | 非目标能力                                                                                      |
| Event Bus        | 静态事件名跳转、补全、hover 和引用查询。                                                 | 从配置入口识别到 bus 后支持                                  | 非目标能力                                                                                      |
| 全局组件         | 静态全局注册到组件用法。                                                                 | `Vue.component(...)`                                         | 非目标能力                                                                                      |
| 第三方组件 refs  | 已知组件库 ref 方法。                                                                    | Element UI、Vant 等 ref 方法，例如表单校验和输入框 focus     | 非目标能力                                                                                      |
| 类型感知导航     | 通过 TypeScript 声明识别组件契约成员。                                                   | 限于静态 Options API 模式                                    | `defineProps`、`defineEmits`、`defineModel`、`defineSlots`、`defineExpose`、typed template refs 和导入类型声明 |
| 路径别名         | 从最近的 `jsconfig.json` 或 `tsconfig.json` 读取 workspace 路径别名。                    | 支持                                                         | 支持                                                                                            |

## Vue 3 静态 Prop 关系

Vue 3 prop 导航会在能够静态证明关系时，把父模板中的 prop 使用链接到子组件 `defineProps` 声明。

支持的模板形式包括：

- 直接 prop，例如 `<Child :title="title" />`，并支持 kebab/camel case 变体。
- `v-model` / `v-model:name`，会同时作为 model prop 使用和 `update:*` event 使用索引。
- 通过 `<Child v-bind="$attrs" />` 做 wrapper 透传。
- 通过 `useAttrs()` 创建别名后再 `v-bind`，包括简单的 `computed(() => ({ ...attrs }))` 包装。
- `mergeProps($attrs, props)`，前提是每个参数都能被静态解析。
- 静态对象 `v-bind`，包括对象字面量，以及被 `ref`、`shallowRef`、`reactive`、`shallowReactive`、`readonly`、`markRaw` 或简单 `computed` 箭头返回包装的对象。
- `defineProps()` / `withDefaults(defineProps(), ...)` 的顶层别名。
- 顶层 rest 绑定，例如 `const { title, ...forwardedProps } = props`，也支持解构模式上的类型标注。
- 同一条声明里的多个 declarator，例如 `const ignored = {}, childProps = { title: 'ok' }`。

扫描器只追踪组件脚本块里的顶层绑定。运行时分支、导入对象值、动态属性名、复杂 TypeScript 类型展开不会被求值。

## Event Bus 入口

Event Bus 名称需要能从入口文件里的 Vue prototype 注册中识别。

默认会检查这些入口：

- `src/main.js`
- `src/index.js`
- `src/main.ts`
- `src/index.ts`

如果项目入口不在这些文件里，可以把 `vueComponentNavigator.entry` 设置为 workspace 相对路径、别名路径，或路径数组。入口路径支持 `jsconfig.json` / `tsconfig.json` 中 `compilerOptions.baseUrl` 和 `compilerOptions.paths` 定义的别名。

扫描范围只包括入口文件本身，以及入口直接字面量 `import`、`import()`、`require()` 的一层文件。不会继续递归扫整个项目。

只有在这些入口文件中识别到的 bus 名称才会参与 Event Bus 分析。`$bus` 不再有内置兜底。

## 命令

| 命令                                         | 说明                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `Vue Component Navigator: Show Status`       | 查看索引状态，以及当前文件是否已被索引。                |
| `Vue Component Navigator: Reindex Workspace` | 手动重建 workspace 索引。大型重构或配置变更后可以使用。 |

## 命令式组件

当关系可以被静态证明时，命令式组件包装器会关联到最终业务调用位置。识别依据是文件内容，不要求文件必须命名为 `command.tsx` 或 `index.js`。

一个 command module 需要同时满足：

- 默认导入 workspace 内的 `.vue` 组件。
- 通过 Vue 2 JSX，或 Vue 3 JSX、`h()`、`createVNode()` 渲染该组件。
- 直接默认导出命令对象，或默认导出本地声明的命令对象。

支持对象方法、async 对象方法、本地 handler 引用、函数表达式和箭头函数：

```ts
const Dialog = {
  open() {},
  async confirm() {},
  alert: alertHandler,
  close: () => {},
}

export default Dialog
```

`Dialog.open()`、`Dialog.confirm()` 等业务调用会计入真实组件的 usage CodeLens；command 脚本自身也会展示可点击的 `Used by N usages` CodeLens。将鼠标悬停在导出方法上时，只展示该方法的 usage 数量和调用位置。

索引只处理默认导入后的直接成员调用。调用未出现在导出对象中的方法时不会计入 usage。解构调用、计算属性调用、CommonJS 导入、运行时生成的方法名和跨 Vue 主版本关系不在支持范围内。

## 配置

| 配置                          | 说明                                             |
| ----------------------------- | ------------------------------------------------ |
| `vueComponentNavigator.entry` | Event Bus 注册入口文件。支持字符串或字符串数组。 |

## 边界

- Vue 2 和 Vue 3 workspace 会按检测到的 Vue 主版本分别索引，两套能力边界保持隔离。
- 组件关系不会跨越 Vue 主版本。Vue 2 package 导入 Vue 3 组件或 Vue 3 package 导入 Vue 2 组件时，不会产生组件、prop、event、slot、ref 或 provide/inject 关系。
- 忽略 workspace 外部文件。
- 动态组件名、计算得出的 `provide` / `inject` key、运行时事件名和动态 Event Bus 名称不在支持范围内。
- 路由懒加载组件 import 和 `<router-view>` slot 组件属于路由配置关系，不作为模板父子组件用法索引。
- 运行时变量形式的 `<component :is="...">` 会被忽略，除非静态 map 能证明候选组件。
- conditional、mapped、intersection 等复杂 TypeScript 类型展开会保持有限支持。
- 静态对象 `v-bind` 会保持保守策略。如果值来自运行时控制流、导入对象或无法在本地解析的函数返回，会被忽略。
- 命令式组件只追踪静态可见的默认导入、导出对象方法和 `Dialog.open()` 形式的直接成员调用。

解析策略会尽量保守。静态证明不了的关系，不返回猜测结果。

# vue-component-navigator

给 Vue 2 Options API 项目和 Vue 3 `<script setup>` 静态关系使用的 VS Code 导航辅助插件。

> English documentation: [README.md](./README.md)

这个插件主要处理 Vue 项目里容易断开的静态关系。它是 Vue 官方工具的补充，不会替代官方扩展；局部组件标签名的定义跳转会交给 Vue 语言扩展处理，避免同一个位置出现重复结果。

当前文档对应功能版本：`1.3.0`。

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
| 组件用法         | 静态组件 import、异步组件 import、简单别名、用法 CodeLens，以及静态 `.vue` import 用法。 | 支持                                                         | 支持 `<script setup>` 局部 import 和静态动态组件 map                                            |
| Props            | 模板 prop 使用到子组件 prop 定义，包括 `$attrs` wrapper 透传。                           | 支持                                                         | `defineProps` 内联类型、命名类型、导入类型、命名泛型类型成员、组件内部 prop 使用、`$attrs` / `useAttrs()` / `mergeProps()` 透传、静态对象 `v-bind` |
| Events / emits   | 模板监听到组件事件声明和 emit 调用点。                                                   | `this.$emit(...)` 和 `$listeners` wrapper 透传               | `defineEmits` 内联对象/数组、调用签名、命名/导入/泛型类型成员，以及 emit 调用                   |
| Models           | model 使用到组件 model 契约。                                                            | 静态可见时通过 prop 和 event 关系覆盖                        | `defineModel()` 和 `defineModel('name')` 到 `v-model` / `v-model:name`                          |
| Slots            | slot 定义到父组件 slot 使用。                                                            | legacy `<slot name>` 和 `slot="..."` 关系                    | `defineSlots` 内联类型、命名类型、导入类型、命名泛型类型成员到 `#name` / `v-slot:name`          |
| Template refs    | ref 方法调用到子组件方法。                                                               | `this.$refs.name.method()` 的补全、hover、定义跳转和引用查询 | `ref.value?.method()`、非空断言、类型断言、TSX/h refs 和 `useTemplateRef<T>()`                  |
| Exposed methods  | 暴露的公开方法到父组件 ref 调用。                                                        | 通过 `$refs` 访问的组件 methods                              | `defineExpose` 本地函数、对象方法、async 方法、函数表达式、内联箭头函数和 composable 转发       |
| Composables      | 返回成员到消费端解构使用。                                                               | 不适用                                                       | 静态 composable / hook 返回成员反向引用                                                         |
| Provide / inject | 静态 provider key 到 consumer。                                                          | 静态字符串 key                                               | 静态字符串、静态 `Symbol` key 和 `InjectionKey` 关系                                            |
| Mixins           | workspace 文件中的静态 imported mixin 成员。                                             | 支持 `.js`、`.ts`、`.vue` 文件                               | 非目标能力                                                                                      |
| Event Bus        | 静态事件名跳转、补全、hover 和引用查询。                                                 | 从配置入口识别到 bus 后支持                                  | 非目标能力                                                                                      |
| 全局组件         | 静态全局注册到组件用法。                                                                 | `Vue.component(...)`                                         | 非目标能力                                                                                      |
| 第三方组件 refs  | 已知组件库 ref 方法。                                                                    | Element UI、Vant 等 ref 方法，例如表单校验和输入框 focus     | 非目标能力                                                                                      |
| 类型感知导航     | 通过 TypeScript 声明识别组件契约成员。                                                   | 限于静态 Options API 模式                                    | `defineProps`、`defineEmits`、`defineSlots`、`defineExpose`、typed template refs 和导入类型声明 |
| 路径别名         | 从最近的 `jsconfig.json` 或 `tsconfig.json` 读取 workspace 路径别名。                    | 支持                                                         | 支持                                                                                            |

## Vue 3 静态 Prop 关系

Vue 3 prop 导航会在能够静态证明关系时，把父模板中的 prop 使用链接到子组件 `defineProps` 声明。

支持的模板形式包括：

- 直接 prop，例如 `<Child :title="title" />`，并支持 kebab/camel case 变体。
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

## 配置

| 配置                          | 说明                                             |
| ----------------------------- | ------------------------------------------------ |
| `vueComponentNavigator.entry` | Event Bus 注册入口文件。支持字符串或字符串数组。 |

## 边界

- Vue 2 和 Vue 3 workspace 会按检测到的 Vue 主版本分别索引，两套能力边界保持隔离。
- 忽略 workspace 外部文件。
- 动态组件名、计算得出的 `provide` / `inject` key、运行时事件名和动态 Event Bus 名称不在支持范围内。
- conditional、mapped、intersection 等复杂 TypeScript 类型展开会保持有限支持。
- 静态对象 `v-bind` 会保持保守策略。如果值来自运行时控制流、导入对象或无法在本地解析的函数返回，会被忽略。

解析策略会尽量保守。静态证明不了的关系，不返回猜测结果。

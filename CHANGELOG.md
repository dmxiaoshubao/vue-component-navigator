# Changelog

## 1.2.0 - 2026-06-20

### English

#### Added

- Added Vue 3 workspace support for static component navigation, `defineProps` type usage, `defineEmits` event relationships, and Composition API `provide` / `inject` relationships.

#### Improved

- Improved Vue workspace detection so Vue 2 and Vue 3 projects use separate indexing behavior.
- Improved Vue 3 source-file indexing performance with source relation tracking, cached static key parsing, and direct-consumer rebuilds.

### 中文

#### 新增

- 新增 Vue 3 workspace 支持，覆盖静态组件导航、`defineProps` 类型使用、`defineEmits` 事件关系，以及 Composition API `provide` / `inject` 关系。

#### 改进

- 改进 Vue workspace 识别，让 Vue 2 和 Vue 3 项目分别使用对应索引行为。
- 改进 Vue 3 source 文件索引性能，通过 source relation 跟踪、静态 key 缓存和直接依赖文件重建减少不必要扫描。

## 1.1.0 - 2026-06-13

### English

#### Added

- Added static dynamic component navigation for provable `<component :is="...">` cases, including direct identifiers, string literals, conditional expressions, object maps, array maps, component-object identifiers, and static `is="Child"` usage. Dynamic component candidates now participate in prop, event, `$refs`, mixin-source, hover, reference, and completion relationships.
- Added navigation from component `$emit(...)` calls to parent template listeners, including `$emit(...)` used inside template expressions.
- Added reverse navigation from prop and `$refs` method definitions to their static usage locations.
- Added richer hover summaries for `$refs` methods, props, emits, mixin-sourced definitions, dynamic component candidates, and static usage lists.
- Added Vue 2 Event Bus support for names registered through `Vue.prototype.<name> = new Vue()`, including `$emit`, `$on`, `$once`, and `$off` navigation, definition, hover, references, event-name completion, and method completion.
- Added Event Bus entry discovery and configuration through `vueComponentNavigator.entry`, with default `src/main|index.js` / `src/main|index.ts` lookup, one layer of literal `import`, `import()`, and `require()` targets, aliases from `jsconfig.json` or `tsconfig.json`, and no built-in `$bus` fallback.
- Added `$refs` method support for supported third-party components, including Element UI and Vant. This covers navigation, hover, definition, completion, optional chaining such as `this.$refs.form?.validate()`, and on-demand type loading from package declarations without indexing all of `node_modules`.
- Added README demo GIF slots and release packaging support for externally hosted GIF assets.

#### Improved

- Improved relationship accuracy by deduplicating mixin-expanded `$refs` usages, keeping Event Bus `$emit(...)` calls separate from component emits, and returning only real static matches while skipping comments or unrelated text.
- Improved incremental indexing performance by tracking reverse-index keys per file instead of scanning every usage map on each edit.
- Improved README structure and user-facing feature descriptions.

#### Fixed

- Fixed stale alias resolution after `jsconfig.json` or `tsconfig.json` changes.

### 中文

#### 新增

- 新增静态动态组件跳转能力，支持可静态证明的 `<component :is="...">` 场景，包括直接变量、字符串字面量、条件表达式、对象映射、数组映射、组件对象标识符，以及静态 `is="Child"`。动态组件候选现在也会参与 prop、event、`$refs`、mixin 来源、hover、references 和 completion 关系。
- 新增从组件 `$emit(...)` 调用跳转到父组件模板监听的位置，包括 template 表达式中的 `$emit(...)`。
- 新增从 prop 定义和 `$refs` 方法定义反向跳到静态使用位置。
- 新增更完整的 hover 摘要，覆盖 `$refs` 方法、props、emits、mixin 来源定义、动态组件候选和静态使用列表。
- 新增 Vue 2 Event Bus 支持，可识别通过 `Vue.prototype.<name> = new Vue()` 注册的 bus，并提供 `$emit`、`$on`、`$once`、`$off` 的跳转、definition、hover、references、事件名补全和方法补全。
- 新增 Event Bus 入口发现和 `vueComponentNavigator.entry` 配置能力，默认检查 `src/main|index.js` / `src/main|index.ts`，并支持入口直接引入的一层 `import`、`import()`、`require()` 文件、`jsconfig.json` / `tsconfig.json` 中的路径别名，以及不再对 `$bus` 使用内置兜底。
- 新增第三方组件 `$refs` 方法支持，当前覆盖 Element UI 和 Vant 的常见组件，包括跳转、hover、definition、completion、`this.$refs.form?.validate()` 这类可选链调用，以及从组件库声明文件按需读取类型而不索引整个 `node_modules`。
- 新增 README 功能 GIF 展示位置，并支持发布包中使用外部托管的 GIF 资源。

#### 改进

- 改进关系识别准确性：对 mixin 展开的 `$refs` 使用位置去重，避免把 `$bus.$emit(...)` 这类 Event Bus 调用混入组件 emit 导航，并让 prop、emit、`$refs`、provide/inject 和 Event Bus 关系只返回真实静态匹配、跳过注释和无关文本。
- 改进增量索引性能，通过按文件记录反向索引 key，避免每次编辑都扫描所有 usage map。
- 改进 README 结构和面向用户的功能说明。

#### 修复

- 修复 `jsconfig.json` 或 `tsconfig.json` 变更后路径别名仍使用旧缓存的问题。

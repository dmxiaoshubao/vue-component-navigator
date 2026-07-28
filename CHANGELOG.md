# Changelog

## 2.1.1 - 2026-07-29

### English

#### Fixed

- Fixed VS Code typing lag in large Vue workspaces by keeping the index on the last saved snapshot and no longer reparsing documents or rebuilding relationships for every unsaved edit.
- Fixed incremental relationship tracking that could retain stale or duplicate forwarded prop/listener and provide/inject usages after repeated updates.
- Fixed manual workspace reindex leaving existing CodeLens views stale after the rebuilt index had been installed.

#### Changed

- Navigation, references, hover, completion, and CodeLens now pause for a dirty document and refresh from the new snapshot after save, preventing stale offsets while editing.
- Save-time indexing now updates only affected Vue 2 mixin, Vue 3 source, forwarded attribute/listener, and provide/inject consumers unless the relationship topology actually changes, reducing CPU work and allocation churn.
- Files written directly by AI or other external tools are intentionally not watched. Run `Vue Component Navigator: Reindex Workspace` to rebuild all saved files and relationships from disk; CodeLens now refreshes immediately when the rebuild completes.

### 中文

#### 修复

- 修复大型 Vue workspace 中的 VS Code 输入卡顿：索引保持在最近一次保存的快照，未保存编辑期间不再重复解析文档或重建关系。
- 修复反复增量更新后，透传 prop/listener 与 provide/inject usage 可能残留或重复的问题。
- 修复手动重新索引完成后，已打开编辑器中的 CodeLens 仍可能停留在旧结果的问题。

#### 变更

- 文档未保存时，本插件的跳转、引用、hover、补全和 CodeLens 暂停工作；保存后基于新快照恢复并刷新，避免编辑偏移变化导致错误结果。
- 保存时的索引更新只处理受影响的 Vue 2 mixin、Vue 3 source、透传 attribute/listener 和 provide/inject 消费者；仅在关系拓扑真实变化时才扩大重建范围，减少 CPU 工作与临时内存分配。
- AI 或其他外部工具直接写入的文件不会被自动监听。执行 `Vue Component Navigator: Reindex Workspace` 可从磁盘重建全部已保存文件及其关系；重建完成后 CodeLens 现在会立即刷新。

## 2.1.0 - 2026-07-11

### English

#### Added

- Added command-component usage indexing for Vue 2 `Vue.extend` / JSX wrappers and Vue 3 `createApp` / `h` / JSX wrappers. Final calls such as `Dialog.open()` and `Dialog.confirm()` now appear in both the real component and command-script CodeLens.
- Added method-level hover and usage navigation for exported command-component APIs, with stale relation cleanup and stricter script-index boundaries.
- Added Vue 2 command-object method hover with the same compact, method-specific usage summary as Vue 3.

#### Breaking

- Component relationships no longer cross Vue major-version package boundaries. Vue 2 packages cannot create navigation relationships to Vue 3 components, and Vue 3 packages cannot create them to Vue 2 components.

#### Changed

- Scoped Vue 3 runtime cache cleanup to the package root whose Vue version changed, preventing one package from clearing another Vue 3 package's cached sources.
- Scoped reverse-index rebuilds by Vue major version so Vue 2 updates do not clear or recompute Vue 3 relationships, and vice versa.
- Excluded nested Vue package roots from parent-package scans so every file is indexed only by its nearest Vue package version.
- Registered all detected package versions before indexing files, and rejected unknown-version targets from registered packages, closing an indexing-order gap in cross-version isolation.
- Prevented repeated version rebuilds from accumulating duplicate standalone-script component usages in internal reverse-index arrays.
- Filtered command calls against the methods actually exported by the command object and excluded obvious state properties from method hover.
- Reduced large-workspace memory usage by avoiding duplicate masked source strings for lightweight script indexes and reusing Vue 3 standalone file indexes.
- Scoped third-party ref component cache cleanup to the package root whose version changed.

### 中文

#### 新增

- 新增命令式组件 usage 索引，支持 Vue 2 `Vue.extend` / JSX 包装器以及 Vue 3 `createApp` / `h` / JSX 包装器。`Dialog.open()`、`Dialog.confirm()` 等最终调用现在会同时展示在真实组件和 command 脚本的 CodeLens 中。
- 新增命令式组件导出方法的独立 hover 与 usage 跳转，并补齐陈旧关系清理和脚本索引边界。
- 新增 Vue 2 命令对象方法 hover，与 Vue 3 一样只展示精简的方法级 usage 摘要。

#### 破坏性变更

- 组件关系不再跨越 Vue 主版本 package 边界。Vue 2 package 不会再与 Vue 3 组件建立导航关系，反向亦然。

#### 变更

- Vue 3 runtime 缓存改为仅清理发生版本变化的 package root，避免一个 package 清空其他 Vue 3 package 的源文件缓存。
- 反向索引改为按 Vue 主版本重建，Vue 2 更新不会再清理或重算 Vue 3 关系，反向亦然。
- 父 package 扫描时排除嵌套 Vue package root，保证每个文件只按最近 package 的 Vue 主版本索引。
- 文件索引前先注册全部 package 版本，并拒绝已注册 package 指向版本未知目标的关系，关闭跨版本隔离中的索引顺序缺口。
- 修复重复执行版本重建时，standalone script 组件用法在内部反向索引数组中持续累积的问题。
- command 调用现在只匹配导出对象中真实存在的方法，并排除明显的状态属性，避免产生错误的方法 hover。
- 轻量脚本索引不再保留重复的 masked 源码，Vue 3 standalone 文件复用完整索引对象，降低大型 workspace 的常驻内存。
- 第三方 ref 组件缓存改为仅清理发生版本变化的 package root。

## 2.0.1 - 2026-07-09

### English

#### Fixed

- Fixed workspace indexing aborting with `Cannot read properties of undefined (reading 'loc')` on Vue 2 files that use valid syntax such as `v-bind.sync`. Vue 2 SFC blocks are no longer parsed by the Vue 3 `@vue/compiler-sfc` template compiler.

#### Changed

- Replaced `@vue/compiler-sfc` SFC block parsing with a lightweight, single-pass lexical block scanner that only extracts the `script` / `scriptSetup` / `template` byte ranges. Template internals stay with the in-house template parser and Vue 3 keeps using `@vue/language-core`.
- Hardened single-file parsing so any parse failure skips that file instead of aborting the whole workspace index.

### 中文

#### 修复

- 修复 Vue 2 文件使用 `v-bind.sync` 等合法语法时，整库索引以 `Cannot read properties of undefined (reading 'loc')` 中断的问题。Vue 2 SFC block 不再交给 Vue 3 的 `@vue/compiler-sfc` 模板编译器解析。

#### 变更

- 将 `@vue/compiler-sfc` 的 SFC block 解析替换为轻量的单遍词法块扫描，只提取 `script` / `scriptSetup` / `template` 的字节范围。模板内部仍由自研 template parser 处理，Vue 3 继续使用 `@vue/language-core`。
- 加固单文件解析：任何解析失败只跳过该文件，而不再中断整库索引。

## 2.0.0 - 2026-07-08

### English

#### Changed

- Rebuilt the indexer around isolated Vue 2 and Vue 3 runtimes. A workspace now runs only the runtime that matches its detected Vue major version.
- Replaced the legacy Vue 3 script-parser path with `@vue/language-core` based SFC and macro-aware indexing.
- Moved Vue SFC block parsing to `@vue/compiler-sfc`.
- Kept Vue 2 and Vue 3 cache state, reverse indexes, source relations, and incremental rebuild rules separated.

#### Improved

- Expanded Vue 3 type-aware contract indexing for `defineProps`, `defineEmits`, `defineModel`, `defineSlots`, `defineExpose`, typed refs, composable return members, and static provide/inject keys.
- Added Vue 3 `.vue` source-file invalidation for imported type sources, static key sources, and deleted source files.
- Added Vue 3 `defineModel()` prop-side indexing so `v-model` participates in both prop and `update:*` event relationships.
- Improved Vue 3 composable forwarded-ref handling when a composable has an external return type but returns a statically readable object.
- Reduced the VSIX bundle size by loading VS Code's built-in TypeScript runtime instead of bundling a full TypeScript copy into `extension.js`.
- Updated README documentation for the 2.0 runtime split, Vue 3 language-core indexing, and current static-analysis boundaries.

#### Fixed

- Fixed stale Vue 3 relationships after `.vue` type/key source updates or deletions.
- Fixed missed forwarded ref methods for patterns such as `defineExpose(useForwardListRef(listRef))` when the helper return type is imported from another file.
- Fixed missing prop reverse references for default `defineModel()` / `v-model` usage.

### 中文

#### 变更

- 围绕隔离的 Vue 2 / Vue 3 运行时重建索引器。一个 workspace 现在只运行匹配其 Vue 主版本的一套运行时。
- 将旧的 Vue 3 script parser 路径替换为基于 `@vue/language-core` 的 SFC 与宏感知索引。
- Vue SFC block 解析改为使用 `@vue/compiler-sfc`。
- Vue 2 和 Vue 3 的缓存状态、反向索引、source relations 和增量重建规则保持隔离。

#### 改进

- 扩展 Vue 3 类型感知组件契约索引，覆盖 `defineProps`、`defineEmits`、`defineModel`、`defineSlots`、`defineExpose`、typed refs、composable 返回成员和静态 provide/inject key。
- 新增 Vue 3 `.vue` 源文件失效处理，覆盖导入类型源、静态 key 源和源文件删除场景。
- 新增 Vue 3 `defineModel()` 的 prop 侧索引，让 `v-model` 同时参与 prop 和 `update:*` event 关系。
- 改进 Vue 3 composable 转发 ref 的处理：当 helper 使用外部返回类型但返回静态可读对象时，也能识别转发方法。
- 通过加载 VS Code 内置 TypeScript runtime，而不是把完整 TypeScript 打进 `extension.js`，降低 VSIX 包体积。
- 更新 README 文档，说明 2.0 运行时隔离、Vue 3 language-core 索引和当前静态分析边界。

#### 修复

- 修复 `.vue` 类型/key 源文件更新或删除后 Vue 3 关系残留的问题。
- 修复 `defineExpose(useForwardListRef(listRef))` 这类 helper 返回类型来自外部文件时，转发 ref 方法漏命中的问题。
- 修复默认 `defineModel()` / `v-model` 缺失 prop 反向引用的问题。

## 1.3.0 - 2026-06-30

### English

#### Added

- Added Vue 3 `defineModel()` / `defineModel('name')` relationships to parent `v-model` / `v-model:name` usages.
- Added Vue 3 `defineSlots<{ ... }>()` relationships to parent `#name` / `v-slot:name` usages, including definition, hover, and references.
- Added Vue 3 `defineExpose({ method })` reverse references from exposed methods to parent template-ref calls such as `childRef.value?.open()`.
- Added Vue 3 static dynamic component map support for `<component :is="componentMap[type]" />`.
- Added Vue 3 composable / hook return-member reverse references from source definitions to destructured consumer usages.
- Added Vue 2 slot relationships from child `<slot name="...">` definitions to parent legacy `slot="..."` usages.

#### Improved

- Reused the shared slot usage index for Vue 2 and Vue 3 while keeping their definition sources separate.
- Improved slot usage parsing so nested component slots are attributed only to their direct parent component.
- Reduced unnecessary slot scanning for components with no slot-related markers.

### 中文

#### 新增

- 新增 Vue 3 `defineModel()` / `defineModel('name')` 与父组件 `v-model` / `v-model:name` 使用之间的关系。
- 新增 Vue 3 `defineSlots<{ ... }>()` 与父组件 `#name` / `v-slot:name` 使用之间的关系，支持 definition、hover 和 references。
- 新增 Vue 3 `defineExpose({ method })` 暴露方法到父组件 `childRef.value?.open()` 这类 template ref 调用的反向引用。
- 新增 Vue 3 `<component :is="componentMap[type]" />` 静态动态组件 map 支持。
- 新增 Vue 3 composable / hook 返回成员从源码定义到消费端解构使用的反向引用。
- 新增 Vue 2 子组件 `<slot name="...">` 定义到父组件 legacy `slot="..."` 使用的关系。

#### 改进

- Vue 2 和 Vue 3 复用统一的 slot usage 索引，同时保持各自的 slot 定义来源独立。
- 改进 slot 使用解析，嵌套组件的 slot 只归属到它的直接父组件。
- 减少没有 slot 相关标记的组件上的无用 slot 扫描。

## 1.2.1 - 2026-06-29

### English

#### Changed

- Replaced component usage inlay hints with component usage CodeLens so usage counts work without enabling editor Inlay Hints.

### 中文

#### 变更

- 将组件用法 inlay hint 替换为组件用法 CodeLens，无需开启编辑器 Inlay Hints 也能看到用法数量。

## 1.2.0 - 2026-06-20

### English

#### Added

- Added Vue 3 workspace support for static component navigation, `defineProps` type usage, `defineEmits` event relationships, and Composition API `provide` / `inject` relationships.
- Added component usage inlay hints on component `<template>` tags, with hover details and click-through usage navigation for template tags and static `.vue` imports.
- Added Vue 2 fallthrough prop and listener navigation through `v-bind="$attrs"` / `v-on="$listeners"` wrappers, including statically resolved dynamic component candidates.
- Added Vue 3 `v-bind="$attrs"` listener fallthrough navigation to child `defineEmits` declarations.

#### Improved

- Improved Vue workspace detection so Vue 2 and Vue 3 projects use separate indexing behavior.
- Improved Vue 3 source-file indexing performance with source relation tracking, cached static key parsing, and direct-consumer rebuilds.
- Improved Vue 2 dynamic component candidate detection for static `data()` maps used by `<component :is="...">`.
- Improved component event matching across camelCase and kebab-case usage.

#### Fixed

- Fixed fallthrough propagation so Vue 2 wrapper props and Vue 3 declared emits are treated as consumed by the wrapper before forwarding `$attrs`.

### 中文

#### 新增

- 新增 Vue 3 workspace 支持，覆盖静态组件导航、`defineProps` 类型使用、`defineEmits` 事件关系，以及 Composition API `provide` / `inject` 关系。
- 新增组件 `<template>` 标签处的组件用法 inlay hint，支持 template 标签和静态 `.vue` import 用法的 hover 详情与点击跳转。
- 新增 Vue 2 通过 `v-bind="$attrs"` / `v-on="$listeners"` wrapper 透传的 prop 和 listener 导航，包括可静态解析的动态组件候选。
- 新增 Vue 3 通过 `v-bind="$attrs"` 透传 listener 到子组件 `defineEmits` 声明的导航关系。

#### 改进

- 改进 Vue workspace 识别，让 Vue 2 和 Vue 3 项目分别使用对应索引行为。
- 改进 Vue 3 source 文件索引性能，通过 source relation 跟踪、静态 key 缓存和直接依赖文件重建减少不必要扫描。
- 改进 Vue 2 `<component :is="...">` 对 `data()` 中静态映射的动态组件候选识别。
- 改进组件事件在 camelCase 和 kebab-case 写法之间的匹配。

#### 修复

- 修复透传关系中 wrapper 已消费的内容仍继续下传的问题：Vue 2 已声明 props 和 Vue 3 已声明 emits 现在会在 wrapper 层停止 `$attrs` 透传。

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

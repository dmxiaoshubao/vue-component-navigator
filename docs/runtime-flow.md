# Vue Component Navigator 运行流程

本文从扩展实际运行链路说明 Vue2 / Vue3 如何分流，以及 provider 如何基于索引结果提供跳转、悬浮、引用、补全和 CodeLens。

## 总览

扩展不会执行用户项目的 Vue 代码。它在 VS Code 扩展进程中读取源码，构建静态索引，然后各个 provider 查询这些索引。

```mermaid
flowchart TD
  A[VS Code 激活扩展] --> B[activate 创建 WorkspaceIndex]
  B --> C[扫描 workspace package.json]
  C --> D{找到 Vue 项目 root?}
  D -- 否 --> E[不注册/不刷新索引]
  D -- 是 --> F[识别 Vue 主版本]
  F --> G[indexWorkspace(root, version)]
  G --> H{version}
  H -- Vue2 --> I[Vue2 runtime]
  H -- Vue3 --> J[Vue3 language-core runtime]
  I --> K[生成 VueFileIndex]
  J --> K
  K --> L[WorkspaceIndex 建反向索引]
  L --> M[Definition / Hover / Reference / Completion / CodeLens 查询]
```

## 启动与建索引

入口在 `src/extension.ts`。

1. `activate()` 创建一个共享的 `WorkspaceIndex`。
2. 扫描 workspace 下的 `package.json`，最多跳过 `node_modules`、`.git`、`dist` 等目录。
3. 从依赖中判断 Vue 主版本。
4. 对每个 Vue project root 调用 `index.indexWorkspace(root, token, entryConfig, version)`。
5. 索引完成后用 `index.replaceWith(nextIndex)` 原子替换当前索引。

```mermaid
flowchart TD
  A[activate] --> B[new WorkspaceIndex]
  B --> C[indexWorkspaceFolders]
  C --> D[workspaceVuePackages]
  D --> E{每个 package root}
  E --> F[读取 entry 配置]
  F --> G[nextIndex.indexWorkspace(root, version)]
  G --> H{取消?}
  H -- 是 --> I[状态: cancelled]
  H -- 否 --> J[index.replaceWith(nextIndex)]
  J --> K[状态: ready]
```

## WorkspaceIndex 分流

`WorkspaceIndex` 是统一入口，但内部保存了两个 runtime：

- Vue2：`vue2Runtime`
- Vue3：`Vue3LanguageCoreRuntime`

每个 root 的版本记录在 `workspaceVueVersions` 中。单个文件索引时，会先根据文件 URI 找到所属 root，再选择 runtime。

```mermaid
flowchart TD
  A[indexContent(uri, content)] --> B[parseSfc / parseIndexableContent]
  B --> C[vueVersionForUri(uri)]
  C --> D{Vue 主版本}
  D -- 2 --> E[vue2Runtime.indexContent]
  D -- 3 --> F[vue3Runtime.indexContent]
  E --> G[files.set(uri, file)]
  F --> G
  G --> H[addSourceRelations]
  H --> I[addRelationshipUsages]
  I --> J[addEventBusUsages / addInjectUsages]
  J --> K{关系影响父子/透传?}
  K -- 是 --> L[rebuildReverseIndexes]
  K -- 否 --> M[结束]
```

## Vue2 运行链路

Vue2 使用 Options API 静态解析。它重点处理 `components`、`mixins`、`extends`、`props`、`methods`、`data`、`computed`、`provide/inject`、EventBus 和 `$refs`。

```mermaid
flowchart TD
  A[vue2Runtime.indexContent] --> B[parseScript]
  B --> C[解析 imports / components / mixins / extends]
  C --> D[解析 props / methods / data / computed]
  D --> E[解析 emits / provide / inject / EventBus]
  E --> F{存在静态 mixin / extends?}
  F -- 是 --> G[解析 mixin 源文件并合并成员]
  F -- 否 --> H[保持当前 scriptIndex]
  G --> H
  H --> I[parseTemplate]
  I --> J[识别组件标签、props、events、slots、refs]
  J --> K[识别静态可证明动态组件候选]
  K --> L[mergeTemplateRelations]
  L --> M[生成 VueFileIndex]
```

### Vue2 组件解析规则

Vue2 普通静态组件只接受可证明来源：

- `components: { Child }`
- 静态全局注册 `Vue.component('Child', Child)`
- mixin / extends 中静态注册的 `components`

动态组件只有在 `templateParser` 能产出 `dynamicTags` 时参与解析。`dynamicTags` 的候选必须来自局部注册、全局静态注册或 mixin / extends 注册，不会仅凭 import 进入组件关系。

```mermaid
flowchart TD
  A[template component usage] --> B{有 dynamicTags?}
  B -->|否: 静态标签| C[resolveComponent]
  C --> D{局部/全局/ mixin 注册?}
  D -- 是 --> E[返回组件 uri]
  D -- 否 --> F[不建立组件关系]
  B -->|是: 动态组件候选| G[逐个候选 tag]
  G --> H[resolveComponent]
  H --> I{命中?}
  I -- 是 --> E
  I -- 否 --> F
```

这意味着普通静态标签不会仅凭 import 建关系：

```vue
<template>
  <BusinessChannelDialog />
</template>

<script>
import BusinessChannelDialog from './BusinessChannelDialog.vue'

export default {}
</script>
```

上面没有 `components: { BusinessChannelDialog }`，所以不会解析为真实组件关系。

### Vue2 mixin 运行方式

```mermaid
flowchart TD
  A[父组件 parseScript] --> B[parseMixins]
  B --> C{mixin 是静态 import?}
  C -- 否 --> D[忽略动态 mixin]
  C -- 是 --> E[resolveImportPathWithExtensions]
  E --> F[读取 mixin 源文件]
  F --> G[parseScript(mixin)]
  G --> H[缓存 Vue2Runtime mixin index]
  H --> I[合并 components / props / methods / data / computed]
  I --> J[template 实例成员可跳到当前组件或 mixin sourceLocation]
```

template 中的 `screenBannerList`、`buttonFormatArr` 这类成员，会从合并后的 `optionMembers` 查定义位置。hover 只展示 JSDoc 注释和定义位置，不展示完整实现。

### Vue2 不处理的动态场景

```mermaid
flowchart TD
  A[动态注册或运行时值] --> B{是否静态可证明?}
  B -- 是 --> C[进入索引]
  B -- 否 --> D[忽略]
  D --> E[不猜测、不适配]
```

典型不处理：

- `require.context(...)` 动态全局注册。
- 运行时拼接组件名。
- 从接口、store、复杂函数返回得到的组件名。
- 普通静态标签只 import 但未注册。

## Vue3 运行链路

Vue3 使用 `@vue/language-core` 做 SFC 和宏感知索引。它重点处理 `<script setup>`、宏、类型源、typed refs 和 composable。

```mermaid
flowchart TD
  A[vue3Runtime.indexContent] --> B[createVue3LanguageCoreContext]
  B --> C[解析 script / script setup / template]
  C --> D[collectComponents]
  D --> E[收集 defineProps / defineEmits / defineModel]
  E --> F[收集 defineSlots / defineExpose]
  F --> G[收集 provide / inject 静态 key]
  G --> H[收集 typed template refs / TSX refs]
  H --> I[收集 composable return usages]
  I --> J[parseTemplate]
  J --> K[生成 VueFileIndex]
```

### Vue3 类型源和缓存

Vue3 会读取导入的类型源和 key 源，并缓存结果。文件保存时，只重建直接消费者。

```mermaid
flowchart TD
  A[Vue3 文件索引] --> B{引用外部类型或 key?}
  B -- 否 --> C[直接生成索引]
  B -- 是 --> D[resolveImportPathWithExtensions]
  D --> E[读取 .ts / .tsx / .js / .jsx / .vue 源]
  E --> F[typeSourceCache / staticKeyCache]
  F --> G[记录 sourceRelations]
  G --> H[源文件保存]
  H --> I[invalidate source cache]
  I --> J[只重建直接消费者]
```

### Vue3 组件和 ref 关系

```mermaid
flowchart TD
  A[Vue3 parent] --> B[script setup import Child]
  B --> C[language-core 收集组件]
  C --> D[template Child 标签建组件关系]
  D --> E[prop/event/slot 使用进入反向索引]
  A --> F[template ref / useTemplateRef / TSX ref]
  F --> G[resolve ref child]
  G --> H[defineExpose 或组件公开方法]
  H --> I[ref.value?.method 跳到定义]
```

Vue3 不使用 Vue2 的全局组件、mixin、EventBus 逻辑作为目标能力。

## Provider 查询链路

以 definition 为例，运行时不会重新全量扫描 workspace，只会同步当前打开文件，然后查询已有索引。

```mermaid
flowchart TD
  A[用户触发 Go to Definition] --> B[VueDefinitionProvider.provideDefinition]
  B --> C{file scheme?}
  C -- 否 --> D[返回 undefined]
  C -- 是 --> E{Vue 文档?}
  E -- 是 --> F{在 indexed workspace 内?}
  F -- 否 --> D
  F -- 是 --> G[index.syncContent 当前内容]
  E -- 否 --> H{有 source relation context?}
  H -- 否 --> D
  H -- 是 --> I[index.syncDocumentContent]
  G --> J[计算 offset]
  I --> J
  J --> K[按关系类型查询 WorkspaceIndex]
  K --> L[返回 vscode.Location]
```

definition 的查询顺序大致是：

1. Vue3 prop type / prop usage。
2. `$refs` / template ref 方法调用。
3. EventBus。
4. template 组件标签 / prop / event / slot。
5. template 实例成员。
6. emit / method / prop 定义处的反向引用。
7. provide / inject。

Hover、Reference、Completion、CodeLens 使用同一份索引，只是返回的 VS Code 类型不同。

## Vue2 + Vue3 共存

同一个 VS Code workspace 可以包含多个 Vue project root。

```mermaid
flowchart TD
  A[VS Code workspace] --> B[package A: Vue2]
  A --> C[package B: Vue3]
  B --> D[indexWorkspace(rootA, 2)]
  C --> E[indexWorkspace(rootB, 3)]
  D --> F[Vue2 runtime 索引]
  E --> G[Vue3 language-core runtime 索引]
  F --> H[WorkspaceIndex.files]
  G --> H
  H --> I[反向索引按 uri / root / sourceLocation 区分]
  I --> J[provider 查询当前文件所属 root]
```

边界规则：

- workspace 外文件不会被 provider 同步进索引。
- root 为空时不会放开所有 Vue 文件。
- Vue2 专属能力只在 Vue2 root 生效。
- Vue3 专属能力只在 Vue3 root 生效。
- source 文件保存时，只按已记录的 source relations 重建消费者。

## 增量更新

```mermaid
flowchart TD
  A[文件变化或保存] --> B{文件类型}
  B -->|.vue| C[indexFile / syncContent]
  B -->|global entry / js / ts| D[syncGlobalComponentFile]
  B -->|tsconfig/jsconfig| E[清理路径别名缓存并重建 workspace]
  C --> F[移除旧反向索引]
  F --> G[重新索引当前文件]
  G --> H{影响父子/透传/source relations?}
  H -- 是 --> I[重建相关反向索引]
  H -- 否 --> J[结束]
  D --> K[刷新 Vue2 全局组件/EventBus 或 Vue3 source consumers]
  K --> I
```

这个设计的目标是：用户正在编辑时只同步当前文件，source 变化时只重建直接消费者，避免每次 provider 触发都做全量扫描。

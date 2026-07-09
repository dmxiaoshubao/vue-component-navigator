# vue-component-navigator

VS Code navigation helpers for Vue 2 Options API projects and Vue 3 `<script setup>` static relationships.

> 中文文档: [README.zh-CN.md](./README.zh-CN.md)

This extension focuses on static relationships that are easy to miss in Vue codebases. It complements the official Vue tooling instead of replacing it, so local component tag definitions are intentionally left to the Vue language extension to avoid duplicate results.

Current documented feature set: `2.0.0`.

## 2.0 Runtime Split

Version `2.0.0` rebuilds the indexer around isolated Vue major-version runtimes. A Vue 2 workspace and a Vue 3 workspace can be supported by the same extension codebase, but only the matching runtime is used for a given project.

- Vue 2 keeps the Options API feature set, including mixins, Event Bus, global components, and third-party `$refs` helpers.
- Vue 2 SFC blocks are parsed through `@vue/compiler-sfc`.
- Vue 3 uses `@vue/language-core` for SFC structure and macro-aware script ranges instead of the old Vue 3 script parser path.
- Vue 3 relationship indexing is focused on static component contracts: `defineProps`, `defineEmits`, `defineModel`, `defineSlots`, `defineExpose`, typed template refs, composable return members, and static provide/inject keys.
- Vue 2 and Vue 3 caches, reverse indexes, and incremental rebuild rules are intentionally separated.
- The VSIX reuses VS Code's built-in TypeScript runtime for Vue 3 indexing instead of bundling a full TypeScript copy into `extension.js`.

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

## Feature Matrix

| Area                       | Supported relationships                                                                                             | Vue 2                                                                          | Vue 3                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Editor actions             | Definitions, references, hover, completion, and CodeLens where the indexed relationship supports them.              | Supported                                                                      | Supported for indexed static relationships                                                                                    |
| Component usage            | Static component imports, async component imports, simple aliases, usage CodeLens, and static `.vue` import usages. | Supported                                                                      | Supported for `<script setup>` local imports and static dynamic component maps                                                |
| Props                      | Template prop usage to child prop definitions, including fallthrough through `$attrs` wrappers.                     | Supported                                                                      | `defineProps` inline, named, imported, and generic named type members; internal prop usages; `$attrs` / `useAttrs()` / `mergeProps()` fallthrough; static object `v-bind` |
| Events / emits             | Template listeners to component emit declarations and emit call sites.                                              | `this.$emit(...)` and listener fallthrough through `$listeners` wrappers       | `defineEmits` inline object/array, call signatures, named/imported/generic type members, and emit calls                       |
| Models                     | Model usage to component model contracts.                                                                           | Covered through event and prop relationships where statically visible          | `defineModel()` and `defineModel('name')` to both model props and `update:*` events from `v-model` / `v-model:name`           |
| Slots                      | Slot definitions to parent slot usages.                                                                             | Legacy `<slot name>` and `slot="..."` relationships                            | `defineSlots` inline, named, imported, and generic type members to `#name` / `v-slot:name`                                    |
| Template refs              | Ref method calls to child component methods.                                                                        | `this.$refs.name.method()` with completion, hover, definitions, and references | `ref.value?.method()`, non-null assertions, type assertions, TSX/h refs, and `useTemplateRef<T>()`                            |
| Exposed methods            | Exposed public methods to parent ref calls.                                                                         | Component methods exposed through `$refs`                                      | `defineExpose` local functions, object methods, async methods, function expressions, inline arrows, and composable forwarding |
| Composables                | Return members to destructured consumer usages.                                                                     | Not applicable                                                                 | Static composable / hook return-member reverse references                                                                     |
| Provide / inject           | Static provider keys to consumers.                                                                                  | Static string keys                                                             | Static strings, static `Symbol` keys, and `InjectionKey` relationships                                                        |
| Mixins                     | Static imported mixin members from workspace files.                                                                 | Supported for `.js`, `.ts`, and `.vue` files                                   | Not targeted                                                                                                                  |
| Event Bus                  | Static event-name navigation, completion, hover, and references.                                                    | Supported after a bus is found from configured entry files                     | Not targeted                                                                                                                  |
| Global components          | Static global registrations to component usages.                                                                    | `Vue.component(...)`                                                           | Not targeted                                                                                                                  |
| Third-party component refs | Known library ref methods.                                                                                          | Element UI and Vant ref methods such as form validation and input focus        | Not targeted                                                                                                                  |
| Type-aware navigation      | Component contract members found through TypeScript declarations.                                                   | Limited to static Options API patterns                                         | `defineProps`, `defineEmits`, `defineModel`, `defineSlots`, `defineExpose`, typed template refs, and imported type declarations |
| Path aliases               | Workspace aliases read from the nearest `jsconfig.json` or `tsconfig.json`.                                         | Supported                                                                      | Supported                                                                                                                     |

## Vue 3 Static Prop Relationships

Vue 3 prop navigation links parent template prop usage to child `defineProps` declarations when the relationship can be proven statically.

Supported template forms include:

- Direct props such as `<Child :title="title" />` and kebab/camel case variants.
- `v-model` / `v-model:name`, indexed as both model prop usage and `update:*` event usage.
- Wrapper fallthrough through `<Child v-bind="$attrs" />`.
- `useAttrs()` aliases passed with `v-bind`, including simple `computed(() => ({ ...attrs }))` wrappers.
- `mergeProps($attrs, props)` when each argument can be resolved statically.
- Static object `v-bind`, including object literals and objects wrapped in `ref`, `shallowRef`, `reactive`, `shallowReactive`, `readonly`, `markRaw`, or simple `computed` arrow returns.
- Top-level aliases to `defineProps()` / `withDefaults(defineProps(), ...)`.
- Top-level rest bindings such as `const { title, ...forwardedProps } = props`, including type annotations on the destructuring pattern.
- Multiple declarators in one statement, such as `const ignored = {}, childProps = { title: 'ok' }`.

The scanner only follows top-level bindings in the component script blocks. It does not evaluate runtime branches, imported object values, dynamic property names, or complex TypeScript type expansion.

## Event Bus Entry

Event Bus names are detected from Vue prototype registrations in entry files.

Default entry files:

- `src/main.js`
- `src/index.js`
- `src/main.ts`
- `src/index.ts`

If your project uses different bootstrap files, set `vueComponentNavigator.entry` to a workspace-relative path, an alias path, or an array of paths. Configured entries support aliases from `compilerOptions.baseUrl` / `compilerOptions.paths` in `jsconfig.json` or `tsconfig.json`.

The scanner only checks the entry file and one layer of literal `import`, `import()`, or `require()` targets. It does not recursively crawl the whole project.

Event Bus usage is ignored until the bus name is found from these entry files. There is no built-in fallback for `$bus`.

## Commands

| Command                                      | Description                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `Vue Component Navigator: Show Status`       | Shows index status and whether the active file is indexed.                    |
| `Vue Component Navigator: Reindex Workspace` | Rebuilds the workspace index. Use it after large refactors or config changes. |

## Configuration

| Setting                       | Description                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `vueComponentNavigator.entry` | Event Bus registration entry file or files. Accepts a string or string array. |

## Boundaries

- Vue 2 and Vue 3 workspaces are indexed by detected Vue major version; their feature sets are intentionally separated.
- Files outside the workspace are ignored.
- Dynamic component names, computed `provide` / `inject` keys, runtime-only event names, and dynamic Event Bus names are out of scope.
- Route lazy component imports and `<router-view>` slot components are route configuration relationships, not template parent-child component usages.
- Runtime-only `<component :is="...">` variables are ignored unless a static map can prove the candidate components.
- Complex TypeScript expansion such as conditional, mapped, or intersection type evaluation is intentionally limited.
- Static object `v-bind` support is intentionally conservative. When the value comes from runtime control flow, an imported object, or a function return that cannot be resolved locally, it is ignored.

The parser is deliberately conservative. When a relationship cannot be proven statically, the extension avoids returning a misleading result.

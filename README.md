# vue-component-navigator

A VS Code extension that improves Vue 2 Options API component navigation, references, hover, and completions for statically provable component relationships.

> 中文文档: [README.zh-CN.md](./README.zh-CN.md)

## Feature Coverage

| Area | Supported | Notes |
| --- | --- | --- |
| `$refs` method definition | Yes | Navigate from `this.$refs.child.method()` to the child component method. Optional chaining like `this.$refs.child?.method()` and `this.$refs?.child?.method()` is supported. |
| `$refs` name completion | Yes | Completes template `ref` names after `this.$refs`, `this.$refs.`, and `this.$refs?.`, including refs from Vue files that statically consume the current mixin source. Ref completion items are prioritized in the suggestion list. |
| `$refs` method completion | Yes | Completes methods from the statically resolved child component and gives them higher sort priority. |
| `$refs` method hover | Yes | Shows method signature, JSDoc summary, params, and definition link when available. |
| `$emit` to template listeners | Yes | Navigate from `this.$emit('event')` or `$emit('event')` inside template expressions to parent template listeners. Multiple listeners are returned when found. |
| Template event to child emits | Yes | Navigate from `@event` / `v-on:event` to matching `this.$emit('event')` calls in the child component. Event modifiers like `.once` and `.stop` are supported. |
| Template prop to child prop | Yes | Navigate from `:prop`, `v-bind:prop`, static props, and `.sync` props to the child prop definition. |
| Template prop / prop definition hover | Yes | Shows prop definition detail, JSDoc summary, definition links, and template usage summaries for prop definitions. |
| Template event hover | Yes | Shows emit definition links for template listeners and usage summaries for emit sites. |
| Prop / event / ref reverse references | Yes | Finds parent template prop usages, event listeners, and `$refs` method calls through the indexed relationship graph. |
| `provide` / `inject` navigation | Yes | Navigate from static `inject` keys to matching `provide` keys, and from `provide` keys back to static inject consumers. Matching is scoped to the statically known parent chain and prefers the nearest provider per chain. |
| `provide` / `inject` hover and references | Yes | Shows provider/consumer summaries and returns inject references for static provide keys. |
| `inject` key completion | Yes | Completes known static `provide` keys inside `inject: ['']`, object-form local keys, and object-form `from: ''` values, scoped by the current component or static mixin consumers. |
| Local component relationships | Yes | Resolves static default imports, static aliases, and async component registrations such as `() => import('./Child.vue')` or `resolve => require(['./Child.vue'], resolve)` in the `components` option. Component tag definition jumps for local components are intentionally left to the official Vue tooling to avoid duplicate definitions. |
| Static dynamic component usage | Yes | Supports finite statically provable candidates in `<component :is="Current">`, `<component :is="cond ? 'A' : 'B'">`, object/array maps, component-object identifiers, and static `is="Child"`. Candidate components participate in prop, event, `$refs`, mixin-source navigation, hover, references, and completions. |
| Static mixin relationships | Yes | Merges statically imported `mixins: [foo]` from workspace `.js`, `.ts`, or `.vue` files, including `export default { ... }` and `export const foo = { ... }` object-literal mixins. Mixin props, methods, emits, provide/inject, local components, and `$refs` calls participate in navigation, hover, references, and completions where a static consumer can be found. |
| Global component relationships | Yes | Resolves static `Vue.component(...)` / `app.component(...)` style registrations when the tag and imported component can be proven statically. Global components participate in template prop, event, and `$refs` method providers. |
| `Component.name` global registration | Yes | Supports `Vue.component(Component.name, Component)` by reading the imported `.vue` component `name`. |
| Constant tag global registration | Yes | Supports patterns like `const name = 'MyComponent'; Vue.component(name, MyComponent)`. |
| `require.context` global registration | Partial | Supports conservative Vue 2 auto-registration patterns like `require.context('./components', true, /\.vue$/)` and reads each `.vue` component `name`. |
| `@/` alias imports | Yes | Resolves aliases from the nearest `tsconfig.json` or `jsconfig.json` using `compilerOptions.baseUrl` and `compilerOptions.paths`. No alias is guessed without config. |
| Vue 2 workspace gating | Yes | Language providers and indexing are enabled only when a workspace `package.json` declares a Vue 2.x `vue` dependency. Vue 3 or non-Vue workspaces stay inactive except for extension commands. |
| Workspace reindexing | Yes | Provides a `Vue Component Navigator: Reindex Workspace` command and keeps an in-memory index for fast provider responses. |
| Incremental updates | Yes | Updates `.vue` file indexes on edit/save and refreshes global component mappings when related `.js`, `.ts`, or global component source files change. |

## Scope And Limits

| Area | Status | Reason |
| --- | --- | --- |
| Vue version | Vue 2 Options API | The parser is optimized for Vue 2 Options API SFCs. |
| Vue 3 / `<script setup>` | Not supported | Official Vue tooling already covers most modern Vue navigation better. |
| Dynamic component registrations or composed paths | Not supported | Component registrations and paths like `import('./' + type + '.vue')` that cannot be proven statically are skipped instead of guessed. Static dynamic component usage and static async imports are supported. |
| Dynamic or global mixins | Not supported | Only statically imported local `mixins: [...]` entries are merged. `Vue.mixin(...)`, spread, conditional mixins, and package mixins are ignored. |
| Dynamic refs / prop names / event names | Not supported | Only static relationships are indexed. |
| Dynamic provide / inject keys | Not supported | Only static string/object keys are indexed; runtime ancestor/descendant scope is not inferred. |
| Local component tag definition jump | Intentionally not handled | Avoids duplicate definitions with the official Vue extension. Other relationships for local components are still supported. |
| Third-party package components | Ignored | Components resolved to `node_modules` are filtered out, even when globally registered by a plugin such as Element UI. |
| External component source outside workspace | Ignored | Keeps indexing safe and bounded to the workspace. |
| Complex JavaScript parsing | Best effort | Uses lightweight static parsing. Unsupported syntax is ignored rather than guessed. |

## Commands

| Command | Description |
| --- | --- |
| `Vue Component Navigator: Show Status` | Shows index status and current file coverage. |
| `Vue Component Navigator: Reindex Workspace` | Rebuilds the workspace index manually. Use this after large refactors or when opening an already-running extension host. |

## Design Principles

- Prefer static proof over guessing.
- Avoid duplicating official Vue tooling, especially for local component tag definitions.
- Keep indexing lightweight enough for large Vue 2 workspaces.
- Keep unsafe or ambiguous dynamic patterns out of the result set.

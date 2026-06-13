# vue-component-navigator

VS Code navigation helpers for Vue 2 projects that still use the Options API.

> 中文文档: [README.zh-CN.md](./README.zh-CN.md)

This extension focuses on relationships that are easy to miss in older Vue 2 codebases: `$refs`, component props and events, `provide` / `inject`, mixins, global components, and common Event Bus usage.

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
- Vue 2 Event Bus navigation for static string event names.
- Static `provide` / `inject` key navigation and completion.
- Static local component imports, async component imports, and simple aliases.
- Static mixins imported from workspace `.js`, `.ts`, or `.vue` files.
- Static global component registrations such as `Vue.component(...)`.
- Third-party `$refs` methods for supported libraries, such as Element UI `el-form.validate()` and Vant `van-field.focus()`.
- `@/` style aliases from the nearest `jsconfig.json` or `tsconfig.json`.

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

- Vue 2 Options API only.
- Vue 3 and `<script setup>` are not targeted.
- Dynamic names and composed paths are skipped, for example `import('./' + type + '.vue')`.
- Dynamic refs, prop names, event names, Event Bus names, and `provide` / `inject` keys are skipped.
- Global mixins, spread mixins, conditional mixins, and package mixins are skipped.
- Template prop/event relationships for package components in `node_modules` are ignored. `$refs` method support reads only known, directly mapped component type files for supported libraries such as Element UI and Vant.
- Files outside the workspace are ignored.

The parser is deliberately conservative. When a relationship cannot be proven statically, the extension avoids returning a misleading result.

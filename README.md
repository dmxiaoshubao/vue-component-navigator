# vue-component-navigator

A VS Code extension that improves Vue 2 component navigation for local `.vue` Options API components.

MVP features:

- Navigate from `this.$refs.child.method()` to the child component method.
- Navigate between `this.$emit('event')` and parent template event listeners.
- Navigate from child component props used in templates to the child prop definition.
- Show hover information and references only when a static component relationship proves the link.

MVP scope and limits:

- Supports Vue 2 `.vue` single-file components using Options API.
- Resolves only local static imports registered in `components`.
- Supports static template props/events and static `ref="name"` relationships.
- Does not support Vue 3 Composition API, `<script setup>`, global components, dynamic refs, dynamic prop/event names, external `.js/.ts` component definitions, or component auto-registration.
- Uses lightweight parsing for Vue 2 Options API. Complex JavaScript or template syntax outside the static patterns above may be ignored instead of guessed.

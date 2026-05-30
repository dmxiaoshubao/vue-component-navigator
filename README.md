# vue-component-navigator

A VS Code extension that improves Vue 2 component navigation for local `.vue` Options API components.

MVP features:

- Navigate from `this.$refs.child.method()` to the child component method.
- Navigate between `this.$emit('event')` and parent template event listeners.
- Navigate from child component props used in templates to the child prop definition.
- Show hover information and references only when a static component relationship proves the link.

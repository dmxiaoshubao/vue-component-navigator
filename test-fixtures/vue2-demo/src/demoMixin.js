export const panelMixin = {
  props: {
    mixinTitle: {
      type: String,
      default: 'Mixin title',
    },
  },
  inject: {
    serviceFromMixin: {
      from: 'demoService',
      default: null,
    },
  },
  methods: {
    mixedOpen(source = 'mixin') {
      this.$emit('mixin-save', source)
    },
    mixedFocus() {
      this.$refs.innerInput?.focus()
    },
  },
}

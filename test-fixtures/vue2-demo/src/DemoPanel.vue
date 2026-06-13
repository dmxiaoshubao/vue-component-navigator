<script>
import { panelMixin } from '@/demoMixin'

export default {
  name: 'DemoPanel',
  mixins: [panelMixin],
  inject: {
    demoService: {
      from: 'demoService',
      default: null,
    },
  },
  props: {
    title: {
      type: String,
      default: 'Demo panel',
    },
    userId: {
      type: Number,
      required: true,
    },
  },
  methods: {
    open(source = 'parent') {
      this.$emit('save', { source, userId: this.userId })
    },
    close() {
      this.$emit('close')
    },
    focusInnerInput() {
      this.$refs.innerInput?.focus()
    },
    refreshFromService() {
      return this.demoService?.refresh?.()
    },
  },
}
</script>

<template>
  <section class="demo-panel">
    <input ref="innerInput" :value="title">
    <button type="button" @click="open('button')">Save</button>
    <button type="button" @click="mixedOpen('button')">Mixin Save</button>
  </section>
</template>

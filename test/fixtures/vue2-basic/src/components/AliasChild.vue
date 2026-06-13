<template>
  <div>{{ originUrl }}</div>
</template>

<script>
export default {
  name: 'AliasChild',
  props: {
    /**
     * @description Source image URL.
     */
    originUrl: {
      type: String,
      default: '',
    },
  },
  methods: {
    notifyLoaded() {
      this.$emit('onLoadSuccess', this.originUrl)
    },
  },
}
</script>

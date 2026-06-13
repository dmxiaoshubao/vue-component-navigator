<template>
  <div>{{ title }}</div>
</template>

<script>
export default {
  name: 'GlobalDialog',
  props: {
    title: String,
  },
  methods: {
    open() {
      this.$emit('confirm')
    },
  },
}
</script>

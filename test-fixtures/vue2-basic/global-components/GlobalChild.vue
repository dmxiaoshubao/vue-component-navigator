<template>
  <div>{{ label }}</div>
</template>

<script>
export default {
  name: 'GlobalChild',
  props: {
    label: String,
  },
  methods: {
    focus() {
      this.$emit('ready')
    },
  },
}
</script>

<template>
  <section>{{ title }}</section>
</template>

<script>
export default {
  name: 'AutoWidget',
  props: {
    title: String,
  },
  methods: {
    refresh() {
      return true
    },
  },
}
</script>

<template>
  <button>{{ title }}</button>
</template>

<script>
export default {
  name: 'OtherChild',
  props: ['title'],
  methods: {
    open() {},
  },
}
</script>

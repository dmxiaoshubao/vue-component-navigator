<template>
  <Child ref="another" @save="onSave" />
</template>

<script>
import Child from './Child.vue'

export default {
  name: 'AnotherParent',
  components: { Child },
  methods: {
    callChild() {
      this.$refs.another.open()
    },
    onSave() {},
  },
}
</script>

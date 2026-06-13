<template>
  <MixinVueConsumer ref="vueMixinChild" :vue-mixed-title="title" />
</template>

<script>
import MixinVueConsumer from './MixinVueConsumer.vue'

export default {
  components: { MixinVueConsumer },
  data() {
    return {
      title: 'hello',
    }
  },
  methods: {
    callVueMixinChild() {
      this.$refs.vueMixinChild.vueMixedMethod()
    },
  },
}
</script>

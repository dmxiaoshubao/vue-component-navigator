<template>
  <MixinChild
    ref="mixinChild"
    :mixed-title="title"
    :nested-title="title"
    @mixed-save="onMixedSave"
  />
</template>

<script>
import MixinChild from './MixinChild.vue'

export default {
  components: { MixinChild },
  provide: {
    sharedService: true,
  },
  data() {
    return {
      title: 'hello',
    }
  },
  methods: {
    callMixinChild() {
      this.$refs.mixinChild.mixedMethod()
      this.$refs.mixinChild.namedMethod()
      this.$refs.mixinChild.nestedMethod()
    },
    onMixedSave() {},
  },
}
</script>

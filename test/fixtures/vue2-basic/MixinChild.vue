<template>
  <div>
    <MixinInner ref="inner" />
  </div>
</template>

<script>
import baseMixin from './mixin-default'
import { namedMixin as aliasedMixin } from './mixin-named'
import MixinInner from './MixinInner.vue'

export default {
  name: 'MixinChild',
  components: { MixinInner },
  mixins: [baseMixin, aliasedMixin],
  methods: {
    ownMethod() {},
  },
}
</script>

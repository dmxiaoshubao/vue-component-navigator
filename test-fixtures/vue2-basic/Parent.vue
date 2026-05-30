<template>
  <div>
    <Child
      ref="child"
      :title="pageTitle"
      :user-id.sync="userId"
      title-text="static title"
      class="box"
      style="color: red"
      key="child-a"
      v-if="visible"
      @save="onSave"
    >
      <template #default>
        <span>{{ pageTitle }}</span>
      </template>
    </Child>
    <OtherChild :title="pageTitle" @save="onOtherSave" />
    <AliasChild :origin-url="pageTitle" @onLoadSuccess="onAliasLoad" />
  </div>
</template>

<script>
import Child from './Child.vue'
import OtherChild from './OtherChild.vue'
import AliasChild from '@/components/AliasChild.vue'

export default {
  name: 'Parent',
  components: { Child, OtherChild, AliasChild },
  data() {
    return {
      pageTitle: 'hello',
      visible: true,
    }
  },
  methods: {
    callChild() {
      this.$refs.child.open()
      this.$refs.child?.close()
      this.$refs?.child?.load()
      this.open()
    },
    open() {},
    onSave() {},
    onOtherSave() {},
    onAliasLoad() {},
  },
}
</script>

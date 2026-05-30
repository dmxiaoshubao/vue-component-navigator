<template>
  <div>
    <Child
      ref="child"
      :title="pageTitle"
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
  </div>
</template>

<script>
import Child from './Child.vue'
import OtherChild from './OtherChild.vue'

export default {
  name: 'Parent',
  components: { Child, OtherChild },
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
      this.open()
    },
    open() {},
    onSave() {},
    onOtherSave() {},
  },
}
</script>

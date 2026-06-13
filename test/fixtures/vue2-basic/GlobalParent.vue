<template>
  <div>
    <GlobalChild ref="globalChild" :label="label" @ready="onReady" />
    <GlobalDialog ref="dialog" :title="label" @confirm="onConfirm" />
    <NamedOnlyDialog ref="namedOnlyDialog" :title="label" />
    <AutoWidget ref="autoWidget" :title="label" />
  </div>
</template>

<script>
export default {
  methods: {
    callGlobal() {
      this.$refs.globalChild.focus()
      this.$refs.dialog.open()
      this.$refs.namedOnlyDialog.show()
      this.$refs.autoWidget.refresh()
    },
    onReady() {},
    onConfirm() {},
  },
}
</script>

<template>
  <button @click="notify">{{ title }}</button>
</template>

<script>
export default {
  name: 'Child',
  props: {
    title: String,
    titleText: {
      type: String,
      required: false,
    },
    userId: Number,
  },
  methods: {
    /**
     * @description Open child dialog.
     * @param {string} source trigger source
     */
    open(source) {
      this.$emit('save')
    },
    close: function () {
      this.$emit('close')
    },
    async load() {
      return true
    },
    // command 这个词不应该被识别为方法
    notify() {
      this.$emit('save')
    },
  },
}
</script>

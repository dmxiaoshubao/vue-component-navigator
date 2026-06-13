export default {
  provide: {
    sharedService: true,
  },
  props: {
    mixedTitle: String,
  },
  methods: {
    mixedMethod() {
      this.$emit('mixed-save')
      this.$refs?.inner?.focus?.()
    },
  },
}

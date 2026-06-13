<script>
export default {
  name: 'DemoBusListener',
  data() {
    return {
      lastStatus: 'idle',
    }
  },
  created() {
    this.$bus.$on('demo:refresh', this.handleRefresh)
    this.$bus.$once('demo:refresh-once', this.handleRefreshOnce)
  },
  beforeDestroy() {
    this.$bus.$off('demo:refresh', this.handleRefresh)
    this.$bus.$off('demo:refresh-once', this.handleRefreshOnce)
  },
  methods: {
    handleRefresh(payload) {
      this.lastStatus = payload.status
    },
    handleRefreshOnce(payload) {
      this.lastStatus = payload.status
    },
  },
}
</script>

<template>
  <aside class="demo-bus-listener">
    {{ lastStatus }}
  </aside>
</template>

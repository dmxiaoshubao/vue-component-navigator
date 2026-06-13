
<template>
  <main class="demo-workspace">
    <DemoPanel
      ref="panel"
      :title="dashboardTitle"
      :user-id="userId"
      mixin-title="From mixin prop"
      @save="handlePanelSave"
      @mixin-save="handleMixinSave"
    />

    <component
      :is="DYNAMIC_PANELS[dynamicIndex]"
      ref="dynamicPanel"
      :title="dashboardTitle"
      :user-id="userId"
      @save="handlePanelSave"
    />

    <GlobalDemoPanel
      ref="globalPanel"
      title="Registered globally"
      :user-id="userId"
      @save="handlePanelSave"
    />

    <DemoBusListener />

    <el-form ref="profileForm" />
    <van-field ref="keywordField" />

    <button type="button" @click="openPanel">Open panel</button>
    <button type="button" @click="publishOneShotRefresh">Publish once</button>
  </main>
</template>

<script>
import DemoPanel from '@/DemoPanel.vue'
import DemoBusListener from '@/DemoBusListener.vue'

const DYNAMIC_PANELS = ['DemoPanel']

export default {
  name: 'DemoWorkspace',
  components: {
    DemoPanel,
    DemoBusListener,
  },
  provide() {
    return {
      demoService: this.demoService,
    }
  },
  data() {
    return {
      dashboardTitle: 'Customer profile',
      userId: 42,
      DYNAMIC_PANELS,
      dynamicIndex: 0,
      demoService: {
        refresh: () => 'refreshed',
      },
    }
  },
  methods: {
    openPanel() {
      this.$refs.dynamicPanel.close()
      this.$refs.panel.open('toolbar')
      this.$refs.dynamicPanel.mixedOpen('dynamic')
      this.$refs.globalPanel.close()
    },
    validateExternalRefs() {
      this.$refs.profileForm.validate()
      this.$refs?.keywordField?.focus()
    },
    handlePanelSave(payload) {
      this.$bus.$emit('demo:refresh', { status: payload.source })
    },
    publishOneShotRefresh() {
      this.$bus.$emit('demo:refresh-once', { status: 'once' })
    },
    handleMixinSave(source) {
      this.$bus.$emit('demo:refresh', { status: source })
    },
  },
}
</script>

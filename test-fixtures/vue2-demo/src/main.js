import Vue from 'vue'
import DemoWorkspace from '@/DemoWorkspace.vue'
import DemoPanel from '@/DemoPanel.vue'

Vue.prototype.$bus = new Vue()
Vue.component('GlobalDemoPanel', DemoPanel)

new Vue({
  render: h => h(DemoWorkspace),
}).$mount('#app')

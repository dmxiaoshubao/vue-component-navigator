import Vue from 'vue'
import GlobalChild from './global-components/GlobalChild.vue'
import GlobalDialog from './global-components/dialog/index.vue'

const dialogName = 'GlobalDialog'

Vue.component('GlobalChild', GlobalChild)
Vue.component(dialogName, GlobalDialog)

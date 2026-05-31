import CustomDialog from './global-components/dialog/index.vue'
import NamedOnlyDialog from './global-components/NamedOnlyDialog.vue'

export default {
  install(vue) {
    vue.component(CustomDialog.name, CustomDialog)
    vue.component(NamedOnlyDialog.name, NamedOnlyDialog)
  },
}

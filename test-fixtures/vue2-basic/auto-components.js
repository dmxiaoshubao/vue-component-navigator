import Vue from 'vue'

const files = require.context('./global-components', true, /\.vue$/)
for (const key of files.keys()) {
  const component = files(key).default
  Vue.component(component.name, component)
}

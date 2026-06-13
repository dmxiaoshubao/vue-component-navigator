import nestedMixin from './mixin-nested'

export const namedMixin = {
  mixins: [nestedMixin],
  inject: ['sharedService'],
  methods: {
    namedMethod() {},
  },
}

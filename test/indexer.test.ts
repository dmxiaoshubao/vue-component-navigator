import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceIndex, findRefMethodAccess } from '../src/indexer/workspaceIndex'
import { findEmit, findProp, findRefComponent, findRefMethodUsages, findRegisteredComponent, findTemplateEventUsages, findTemplatePropUsages } from '../src/indexer/relationResolver'

const fixtureRoot = path.resolve(__dirname, '../test-fixtures/vue2-basic')

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureRoot, name), 'utf8')
}

async function buildIndex(): Promise<WorkspaceIndex> {
  const index = new WorkspaceIndex()
  await index.indexWorkspace(fixtureRoot)
  return index
}

describe('Vue2 indexer', () => {
  it('解析 SFC、imports、components、props、methods 和 emits', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const child = index.getFile(path.join(fixtureRoot, 'Child.vue'))!
    const other = index.getFile(path.join(fixtureRoot, 'OtherChild.vue'))!

    expect(parent.template?.content).toContain('<OtherChild')
    expect(parent.script).toBeTruthy()
    expect(parent.scriptIndex.imports).toContainEqual({ localName: 'Child', source: './Child.vue' })
    expect(parent.scriptIndex.components.map((item) => item.localName)).toContain('Child')
    expect(child.scriptIndex.componentName).toBe('Child')
    expect(child.scriptIndex.props.map((prop) => prop.name)).toEqual(['title', 'titleText', 'userId'])
    expect(other.scriptIndex.props.map((prop) => prop.name)).toEqual(['title'])
    expect(child.scriptIndex.methods.map((method) => method.name)).toEqual(['open', 'close', 'load', 'notify'])
    expect(child.scriptIndex.emits.filter((emit) => emit.eventName === 'save')).toHaveLength(2)
  })

  it('解析 template 中组件 ref、props、event 并过滤内置属性', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const childUsage = parent.templateIndex.components.find((component) => component.tag === 'Child')!

    expect(childUsage.attrs.some((attr) => attr.kind === 'ref' && attr.name === 'child')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'title')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'prop' && attr.name === 'title-text' && attr.normalizedName === 'titleText')).toBe(true)
    expect(childUsage.attrs.some((attr) => attr.kind === 'event' && attr.name === 'save')).toBe(true)
    expect(childUsage.attrs.some((attr) => ['class', 'style', 'key', 'v-if'].includes(attr.name))).toBe(false)
  })
})

describe('Vue2 relation resolver', () => {
  it('解析 ref 到子组件方法关系', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const childUri = path.join(fixtureRoot, 'Child.vue')
    const openOffset = parent.content.indexOf('open()')
    const closeOffset = parent.content.indexOf('close()')

    expect(findRefComponent(parent, 'child')).toBe(childUri)
    expect(findRefMethodAccess(parent.content, openOffset + 1)?.methodName).toBe('open')
    expect(findRefMethodAccess(parent.content, closeOffset + 1)?.methodName).toBe('close')
  })

  it('解析 template props 到子组件 props', async () => {
    const index = await buildIndex()
    const parent = index.getFile(path.join(fixtureRoot, 'Parent.vue'))!
    const child = index.getFile(path.join(fixtureRoot, 'Child.vue'))!
    const childUsage = parent.templateIndex.components.find((component) => component.tag === 'Child')!
    const titleText = childUsage.attrs.find((attr) => attr.kind === 'prop' && attr.name === 'title-text')!

    expect(findRegisteredComponent(parent, 'Child')).toBe(child.uri)
    expect(findProp(child, titleText.normalizedName)?.name).toBe('titleText')
  })

  it('只返回真实 props、emit、ref 方法引用', async () => {
    const index = await buildIndex()
    const files = index.getAllFiles()
    const childUri = path.join(fixtureRoot, 'Child.vue')

    expect(findTemplatePropUsages(files, childUri, 'title')).toHaveLength(1)
    expect(findTemplateEventUsages(files, childUri, 'save')).toHaveLength(2)
    expect(findRefMethodUsages(files, childUri, 'open')).toHaveLength(2)
    expect(findRefMethodUsages(files, childUri, 'missing')).toHaveLength(0)
  })

  it('同名事件或 prop 但组件不同不算引用', async () => {
    const index = await buildIndex()
    const files = index.getAllFiles()
    const otherUri = path.join(fixtureRoot, 'OtherChild.vue')

    expect(findTemplatePropUsages(files, otherUri, 'title')).toHaveLength(1)
    expect(findTemplateEventUsages(files, otherUri, 'save')).toHaveLength(1)
  })
})

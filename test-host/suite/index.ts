import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import * as vscode from 'vscode'

const extensionId = 'dmxiaoshubao.vue-component-navigator'
const insertedText = 'VCN Host 编辑文案'
const sampleIntervalMs = 5
const settleDurationMs = 350
const typingIntervalMs = 15

interface ChangeSummary {
  eventCount: number
  insertedCharacters: number
  deletedCharacters: number
}

interface TimingSummary {
  count: number
  totalMs: number
  averageMs: number
  p95Ms: number
  maxMs: number
}

interface MutationMetrics extends ChangeSummary {
  action: 'insert' | 'delete'
  characters: number
  documentVersionBefore: number
  documentVersionAfter: number
  edit: TimingSummary
  provider: 'codeLens' | 'completion'
  providerTiming: TimingSummary
  maxCommandResultItemCount: number
  indexedSnapshotChecks: number
  maxEventLoopLagMs: number
  heapUsedBeforeBytes: number
  heapUsedAfterBytes: number
  maxHeapUsedBytes: number
}

interface ExternalReindexMetrics {
  reindexMs: number
  indexedFileCountBefore: number
  indexedFileCountAfter: number
  hoverMatched: boolean
  definitionMatched: boolean
  codeLensCount: number
}

interface HostDiagnosticResult {
  vscodeVersion: string
  extensionVersion: string
  workspacePath: string
  targetPath: string
  vueFileCount: number
  indexedFileCount: number
  vueSourceBytes: number
  targetBytes: number
  reindexMs: number
  externalReindex: ExternalReindexMetrics
  insert: MutationMetrics
  delete: MutationMetrics
  diskContentUnchanged: boolean
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`缺少环境变量：${name}`)
  }
  return value
}

function roundDuration(value: number): number {
  return Number(value.toFixed(2))
}

function summarizeTimings(durations: number[]): TimingSummary {
  const sorted = [...durations].sort((left, right) => left - right)
  const totalMs = durations.reduce((total, duration) => total + duration, 0)
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return {
    count: durations.length,
    totalMs: roundDuration(totalMs),
    averageMs: roundDuration(totalMs / durations.length),
    p95Ms: roundDuration(sorted[p95Index] ?? 0),
    maxMs: roundDuration(sorted[sorted.length - 1] ?? 0),
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function contentHash(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function replaceRequired(content: string, search: string, replacement: string, label: string): string {
  if (!content.includes(search)) {
    throw new Error(`无法构造外部 Reindex 场景：${label}`)
  }
  return content.replace(search, replacement)
}

function hoverText(hovers: readonly vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((hover) => Array.isArray(hover.contents) ? hover.contents : [hover.contents])
    .map((content) => typeof content === 'string' ? content : content.value)
    .join('\n')
}

async function waitForDocumentContent(uri: vscode.Uri, expectedContent: string, timeoutMs = 5000): Promise<vscode.TextDocument> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const document = await vscode.workspace.openTextDocument(uri)
    if (document.getText() === expectedContent) {
      return document
    }
    await delay(50)
  }
  throw new Error(`VS Code 未在 ${timeoutMs}ms 内加载外部写盘内容：${uri.fsPath}`)
}

function insertionOffset(content: string): number {
  const templateStart = content.indexOf('<template')
  const templateTagEnd = templateStart === -1 ? -1 : content.indexOf('>', templateStart)
  if (templateTagEnd === -1) {
    throw new Error('目标文件没有可编辑的 <template> 根标签')
  }
  return templateTagEnd + 1
}

async function executeProvider(
  provider: MutationMetrics['provider'],
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<number> {
  if (provider === 'codeLens') {
    const result = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', document.uri)
    return result?.length ?? 0
  }
  const result = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position)
  return result?.items.length ?? 0
}

async function measureMutation(
  action: MutationMetrics['action'],
  provider: MutationMetrics['provider'],
  document: vscode.TextDocument,
  characters: number,
  performStep: (index: number) => PromiseLike<{ applied: boolean, position: vscode.Position }>,
  verifySavedSnapshot: () => void,
): Promise<MutationMetrics> {
  const documentVersionBefore = document.version
  const heapUsedBeforeBytes = process.memoryUsage().heapUsed
  let maxHeapUsedBytes = heapUsedBeforeBytes
  const editDurations: number[] = []
  const providerDurations: number[] = []
  let maxCommandResultItemCount = 0
  let indexedSnapshotChecks = 0
  const changeSummary: ChangeSummary = {
    eventCount: 0,
    insertedCharacters: 0,
    deletedCharacters: 0,
  }
  const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() !== document.uri.toString()) {
      return
    }
    changeSummary.eventCount += 1
    for (const change of event.contentChanges) {
      changeSummary.insertedCharacters += change.text.length
      changeSummary.deletedCharacters += change.rangeLength
    }
  })

  let maxEventLoopLagMs = 0
  let expectedTickAt = performance.now() + sampleIntervalMs
  const timer = setInterval(() => {
    const now = performance.now()
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - expectedTickAt)
    maxHeapUsedBytes = Math.max(maxHeapUsedBytes, process.memoryUsage().heapUsed)
    expectedTickAt = now + sampleIntervalMs
  }, sampleIntervalMs)

  try {
    for (let index = 0; index < characters; index += 1) {
      const editStartedAt = performance.now()
      const { applied, position } = await performStep(index)
      editDurations.push(performance.now() - editStartedAt)
      if (!applied) {
        throw new Error(`${action} 第 ${index + 1} 次文本编辑未应用`)
      }

      const providerStartedAt = performance.now()
      const providerItemCount = await executeProvider(provider, document, position)
      providerDurations.push(performance.now() - providerStartedAt)
      // executeCompletionItemProvider 会合并 VS Code 内置补全，结果数仅用于诊断。
      maxCommandResultItemCount = Math.max(maxCommandResultItemCount, providerItemCount)
      verifySavedSnapshot()
      indexedSnapshotChecks += 1
      await delay(typingIntervalMs)
    }
    await delay(settleDurationMs)
    // 等待时间覆盖旧实现的输入防抖窗口，用于确认后台也没有延迟同步。
    verifySavedSnapshot()
    indexedSnapshotChecks += 1

    if (changeSummary.eventCount === 0) {
      throw new Error(`${action} 文本没有触发 onDidChangeTextDocument`)
    }

    const heapUsedAfterBytes = process.memoryUsage().heapUsed
    maxHeapUsedBytes = Math.max(maxHeapUsedBytes, heapUsedAfterBytes)

    return {
      action,
      characters,
      documentVersionBefore,
      documentVersionAfter: document.version,
      edit: summarizeTimings(editDurations),
      provider,
      providerTiming: summarizeTimings(providerDurations),
      maxCommandResultItemCount,
      indexedSnapshotChecks,
      maxEventLoopLagMs: roundDuration(maxEventLoopLagMs),
      heapUsedBeforeBytes,
      heapUsedAfterBytes,
      maxHeapUsedBytes,
      ...changeSummary,
    }
  } finally {
    clearInterval(timer)
    changeDisposable.dispose()
  }
}

async function measureExternalReindex(
  targetPath: string,
  originalDiskContent: Buffer,
  extensionApi: {
    getIndexStatus: () => string
    getIndexedFileCount: () => number
    isIndexedContentCurrent: (filePath: string, content: string) => boolean
  },
): Promise<ExternalReindexMetrics> {
  const originalText = originalDiskContent.toString('utf8')
  const generatedPath = path.join(path.dirname(targetPath), 'ExternalReindexPanel.vue')
  if (fs.existsSync(generatedPath)) {
    throw new Error(`外部 Reindex 测试文件已存在：${generatedPath}`)
  }

  const generatedContent = `
<template><section>{{ externalLabel }}</section></template>
<script>
export default {
  name: 'ExternalReindexPanel',
  props: {
    externalLabel: String,
  },
}
</script>
`
  let changedTargetContent = replaceRequired(
    originalText,
    '    <DemoBusListener />',
    '    <DemoBusListener />\n    <ExternalReindexPanel :external-label="dashboardTitle" />',
    '找不到模板插入位置',
  )
  changedTargetContent = replaceRequired(
    changedTargetContent,
    "import DemoBusListener from '@/DemoBusListener.vue'",
    "import DemoBusListener from '@/DemoBusListener.vue'\nimport ExternalReindexPanel from '@/ExternalReindexPanel.vue'",
    '找不到 import 插入位置',
  )
  changedTargetContent = replaceRequired(
    changedTargetContent,
    '    DemoBusListener,',
    '    DemoBusListener,\n    ExternalReindexPanel,',
    '找不到 components 插入位置',
  )

  const indexedFileCountBefore = extensionApi.getIndexedFileCount()
  try {
    // 直接写磁盘，模拟 AI/CLI；没有保存事件时索引必须保持旧快照。
    fs.writeFileSync(generatedPath, generatedContent)
    fs.writeFileSync(targetPath, changedTargetContent)
    const targetUri = vscode.Uri.file(targetPath)
    const targetDocument = await waitForDocumentContent(targetUri, changedTargetContent)
    if (extensionApi.isIndexedContentCurrent(generatedPath, generatedContent)) {
      throw new Error('外部新增文件在 Reindex 前意外进入索引')
    }
    if (extensionApi.isIndexedContentCurrent(targetPath, changedTargetContent)) {
      throw new Error('外部修改文件在 Reindex 前意外进入索引')
    }

    const reindexStartedAt = performance.now()
    await vscode.commands.executeCommand('vueComponentNavigator.reindexWorkspace')
    const reindexMs = roundDuration(performance.now() - reindexStartedAt)
    if (extensionApi.getIndexStatus() !== 'ready') {
      throw new Error(`外部写盘后的 Reindex 未就绪：${extensionApi.getIndexStatus()}`)
    }
    if (!extensionApi.isIndexedContentCurrent(generatedPath, generatedContent)) {
      throw new Error('Reindex 后没有索引外部新增组件')
    }
    if (!extensionApi.isIndexedContentCurrent(targetPath, changedTargetContent)) {
      throw new Error('Reindex 后没有同步外部修改文件')
    }

    const generatedUri = vscode.Uri.file(generatedPath)
    const generatedDocument = await vscode.workspace.openTextDocument(generatedUri)
    const propOffset = generatedDocument.getText().indexOf('externalLabel:') + 2
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      generatedUri,
      generatedDocument.positionAt(propOffset),
    )
    const hoverMatched = hoverText(hovers).includes('Used by 1 prop usage')
    if (!hoverMatched) {
      throw new Error('Reindex 后新增 prop 定义没有 usage hover')
    }

    const usageOffset = targetDocument.getText().indexOf('external-label') + 2
    const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
      'vscode.executeDefinitionProvider',
      targetUri,
      targetDocument.positionAt(usageOffset),
    )
    const definitionMatched = (definitions ?? []).some((definition) =>
      'targetUri' in definition
        ? definition.targetUri.fsPath === generatedPath
        : definition.uri.fsPath === generatedPath)
    if (!definitionMatched) {
      throw new Error('Reindex 后新增 prop usage 无法跳转到组件定义')
    }

    const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', generatedUri)
    const codeLensCount = codeLenses?.length ?? 0
    if (codeLensCount !== 1) {
      throw new Error(`Reindex 后新增组件 CodeLens 数量异常：${codeLensCount}`)
    }

    return {
      reindexMs,
      indexedFileCountBefore,
      indexedFileCountAfter: extensionApi.getIndexedFileCount(),
      hoverMatched,
      definitionMatched,
      codeLensCount,
    }
  } finally {
    fs.writeFileSync(targetPath, originalDiskContent)
    if (fs.existsSync(generatedPath)) {
      fs.unlinkSync(generatedPath)
    }
    await vscode.commands.executeCommand('vueComponentNavigator.reindexWorkspace')
    if (extensionApi.getIndexedFileCount() !== indexedFileCountBefore) {
      throw new Error('外部 Reindex 测试清理后索引文件数没有恢复')
    }
  }
}

export async function run(): Promise<void> {
  const workspacePath = requiredEnvironmentValue('VCN_HOST_WORKSPACE_PATH')
  const targetPath = requiredEnvironmentValue('VCN_HOST_TARGET_PATH')
  const resultPath = requiredEnvironmentValue('VCN_HOST_RESULT_PATH')
  const originalDiskContent = fs.readFileSync(targetPath)
  const originalText = originalDiskContent.toString('utf8')
  const originalDiskHash = contentHash(originalDiskContent)

  const extension = vscode.extensions.getExtension(extensionId)
  if (!extension) {
    throw new Error(`未加载待测试扩展：${extensionId}`)
  }
  const extensionApi = await extension.activate() as {
    waitForInitialIndex: () => Promise<void>
    getIndexStatus: () => string
    getIndexedFileCount: () => number
    isIndexedContentCurrent: (filePath: string, content: string) => boolean
  }
  await extensionApi.waitForInitialIndex()
  if (extensionApi.getIndexStatus() !== 'ready') {
    throw new Error(`初始索引未就绪：${extensionApi.getIndexStatus()}`)
  }

  const reindexStartedAt = performance.now()
  await vscode.commands.executeCommand('vueComponentNavigator.reindexWorkspace')
  const reindexMs = roundDuration(performance.now() - reindexStartedAt)

  const vueFiles = await vscode.workspace.findFiles('**/*.vue', '**/{node_modules,dist,build}/**')
  const vueSourceBytes = vueFiles.reduce((total, uri) => total + fs.statSync(uri.fsPath).size, 0)
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath))
  const editor = await vscode.window.showTextDocument(document, { preview: false })
  const offset = insertionOffset(document.getText())
  const characters = Array.from(insertedText)

  if (!extensionApi.isIndexedContentCurrent(targetPath, originalText)) {
    throw new Error('Host 测试开始前目标文件索引不是磁盘上的已保存版本')
  }

  const verifySavedSnapshot = () => {
    if (!document.isDirty) {
      throw new Error('文本编辑后文档没有进入未保存状态')
    }
    if (!extensionApi.isIndexedContentCurrent(targetPath, originalText)) {
      throw new Error('未保存编辑期间索引内容发生了变化')
    }
  }

  try {
    let cursorOffset = offset
    const insert = await measureMutation(
      'insert',
      'codeLens',
      document,
      characters.length,
      async (index) => {
        const character = characters[index]
        const position = document.positionAt(cursorOffset)
        const applied = await editor.edit((builder) => builder.insert(position, character))
        cursorOffset += character.length
        return { applied, position: document.positionAt(cursorOffset) }
      },
      verifySavedSnapshot,
    )

    if (document.getText().slice(offset, offset + insertedText.length) !== insertedText) {
      throw new Error('插入文案后无法定位待删除文本')
    }
    const reversedCharacters = [...characters].reverse()
    const deletion = await measureMutation(
      'delete',
      'completion',
      document,
      reversedCharacters.length,
      async (index) => {
        const character = reversedCharacters[index]
        const startOffset = cursorOffset - character.length
        const start = document.positionAt(startOffset)
        const range = new vscode.Range(start, document.positionAt(cursorOffset))
        const applied = await editor.edit((builder) => builder.delete(range))
        cursorOffset = startOffset
        return { applied, position: start }
      },
      verifySavedSnapshot,
    )

    await vscode.commands.executeCommand('workbench.action.files.revert')
    if (document.isDirty) {
      throw new Error('Host 测试结束后目标文档仍处于未保存状态')
    }

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    const externalReindex = await measureExternalReindex(targetPath, originalDiskContent, extensionApi)

    const diskContentUnchanged = contentHash(fs.readFileSync(targetPath)) === originalDiskHash
    if (!diskContentUnchanged) {
      throw new Error('Host 测试意外修改了磁盘文件')
    }

    const result: HostDiagnosticResult = {
      vscodeVersion: vscode.version,
      extensionVersion: String(extension.packageJSON.version),
      workspacePath,
      targetPath: path.relative(workspacePath, targetPath),
      vueFileCount: vueFiles.length,
      indexedFileCount: extensionApi.getIndexedFileCount(),
      vueSourceBytes,
      targetBytes: originalDiskContent.length,
      reindexMs,
      externalReindex,
      insert,
      delete: deletion,
      diskContentUnchanged,
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`VCN_HOST_DIAGNOSTIC=${JSON.stringify(result)}`)
  } finally {
    if (document.isDirty) {
      await vscode.commands.executeCommand('workbench.action.files.revert')
    }
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => import('./vscodeMock'))

class TestDocument {
  uri: { fsPath: string, scheme: string }
  languageId = 'vue'

  constructor(public filePath: string, private readonly content: string) {
    this.uri = { fsPath: filePath, scheme: 'file' }
  }

  getText(): string {
    return this.content
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function writeVue(filePath: string, name: string): void {
  fs.writeFileSync(filePath, `<template><div /></template>\n<script>export default { name: '${name}' }</script>\n`)
}

describe('Extension lifecycle indexing', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('reindex 失败时保留旧索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-reindex-'))
    const keepFile = path.join(root, 'Keep.vue')
    writeVue(keepFile, 'Keep')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    vscode.window.activeTextEditor = { document: new TestDocument(keepFile, fs.readFileSync(keepFile, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')

    const missingRoot = path.join(root, 'missing')
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(missingRoot) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()

    expect(vscode.warningMessages.at(-1)).toContain('indexing failed')
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })

  it('rename 和未保存 change 会同步索引', async () => {
    const vscode = await import('vscode') as any
    vscode.resetMockState()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcn-events-'))
    const oldFile = path.join(root, 'Old.vue')
    const newFile = path.join(root, 'New.vue')
    writeVue(oldFile, 'Old')
    writeVue(newFile, 'New')
    vscode.workspace.workspaceFolders = []

    const { activate } = await import('../src/extension')
    activate({ subscriptions: [] } as any)
    await flushPromises()
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }]
    await vscode.registeredCommands.get('vueComponentNavigator.reindexWorkspace')?.()

    const renameListener = vscode.renameListeners.find((listener) => typeof listener === 'function')
    expect(renameListener).toBeDefined()
    await renameListener!({ files: [{ oldUri: vscode.Uri.file(oldFile), newUri: vscode.Uri.file(newFile) }] })
    vscode.window.activeTextEditor = { document: new TestDocument(oldFile, fs.readFileSync(oldFile, 'utf8')) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: no')

    const changed = fs.readFileSync(newFile, 'utf8').replace('New', 'Changed')
    vscode.changeTextListeners[0]({ document: new TestDocument(newFile, changed) })
    vscode.window.activeTextEditor = { document: new TestDocument(newFile, changed) }
    await vscode.registeredCommands.get('vueComponentNavigator.showStatus')?.()
    expect(vscode.informationMessages.at(-1)).toContain('Current file indexed: yes')
  })
})

import fs from 'node:fs'
import path from 'node:path'
import { runTests } from '@vscode/test-electron'

const defaultVSCodeExecutablePath = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'

function resolveInputPath(input: string | undefined, baseDirectory: string, fallback: string): string {
  const value = input || fallback
  return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value)
}

function assertExistingPath(targetPath: string, label: string): void {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label}不存在：${targetPath}`)
  }
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..')
  const workspacePath = resolveInputPath(process.argv[2], extensionDevelopmentPath, 'test-fixtures/vue2-demo')
  const targetPath = resolveInputPath(process.argv[3], workspacePath, 'src/DemoWorkspace.vue')
  const vscodeExecutablePath = process.env.VCN_VSCODE_EXECUTABLE_PATH || defaultVSCodeExecutablePath
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js')
  const resultPath = path.resolve(__dirname, 'host-result.json')

  assertExistingPath(workspacePath, '测试工作区')
  assertExistingPath(targetPath, '目标文件')
  assertExistingPath(vscodeExecutablePath, 'VS Code 可执行文件')
  fs.rmSync(resultPath, { force: true })

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-gpu',
    ],
    extensionTestsEnv: {
      VCN_HOST_WORKSPACE_PATH: workspacePath,
      VCN_HOST_TARGET_PATH: targetPath,
      VCN_HOST_RESULT_PATH: resultPath,
    },
  })

  assertExistingPath(resultPath, 'Host 测试结果')
  const result = fs.readFileSync(resultPath, 'utf8')
  console.log(`VCN_HOST_RESULT=${result}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

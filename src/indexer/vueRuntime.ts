import type { IndexCancellationToken, ParsedSfc, VueFileIndex, VueMajorVersion } from './types'

export interface VueRuntimeEngine {
  readonly version: VueMajorVersion
  indexContent: (uri: string, sfc: ParsedSfc) => VueFileIndex
  indexWorkspace: (root: string, vueFiles: string[], scriptFiles: string[], token?: IndexCancellationToken) => Promise<void>
}

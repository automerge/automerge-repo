export { DocKeyhive } from "./DocKeyhive.js"
export { keyhive, type KeyhiveMembers, type KeyhiveSpec } from "./extension.js"
export {
  KeyhiveBackend,
  type KeyhiveBackendOptions,
  type KeyhiveExtensions,
} from "./KeyhiveBackend.js"
export type { KeyhiveSession } from "./KeyhiveSession.js"
export type { LocalKeyhive } from "./LocalKeyhive.js"
export { setKeyhiveLogLevel, type KeyhiveLogLevel } from "./logging.js"
export { peerIdFromVerifyingKey } from "./utilities.js"
export { initKeyhiveWasm } from "./wasm.js"

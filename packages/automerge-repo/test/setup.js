import * as WASM from 'automerge-wasm-pack'
import * as Automerge from 'automerge-js'

Automerge.use(await WASM.init())

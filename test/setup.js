import * as Automerge from 'automerge-js'
import WASM from 'automerge-wasm-pack'

Automerge.use(await WASM())

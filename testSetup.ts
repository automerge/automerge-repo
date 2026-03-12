import { next as Automerge } from "@automerge/automerge"
import * as subduction from "@automerge/automerge-subduction"

const s = new subduction.MemorySigner()

const doc = Automerge.init({})

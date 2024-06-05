import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe } from "vitest"
import { runStorageAdapterTests } from "../../automerge-repo/src/helpers/tests/storage-adapter-tests"
import { NodeFSStorageAdapter } from "../src"

describe("NodeFSStorageAdapter", () => {
  const setup = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))
    const teardown = () => {
      fs.rmSync(dir, { force: true, recursive: true })
    }
    const adapter = new NodeFSStorageAdapter(dir)
    return { adapter, teardown }
  }

  runStorageAdapterTests(setup)
})

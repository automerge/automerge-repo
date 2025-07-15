import * as A from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import assert from "assert"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { DummySedimentree } from "../src/sedimentree.js"
import { Repo } from "../src/Repo.js"

describe("Repo sedimentree integration", () => {
  it("should find documents from sedimentree", async () => {
    const url = generateAutomergeUrl()
    const { documentId } = parseAutomergeUrl(url)
    const doc = A.from({ foo: "bar" })
    const repo = new Repo({
      sedimentreeImplementation: new DummySedimentree(
        new Map([[documentId, doc]])
      ),
    })
    const handle = await repo.find(url)
    assert.deepEqual(handle.doc().foo, "bar")
  })
})

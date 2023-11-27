import { expect } from "vitest"
import { eventPromise } from "../../src/eventPromise.js"
import { UserStuff, TestDoc } from "./setup.js"

export const synced = async (a: UserStuff, b: UserStuff) => {
  // a makes a document
  const aHandle = a.repo.create<TestDoc>()
  aHandle.change(d => {
    d.foo = "bar"
  })

  // b receives a's document
  const bHandle = b.repo.find<TestDoc>(aHandle.documentId)
  const bDoc = await bHandle.doc()

  expect(bDoc.foo).toBe("bar")

  // b makes a change
  bHandle.change(d => {
    d.foo = "baz"
  })

  // a receives the change
  await eventPromise(aHandle, "change")
  const aDoc = await aHandle.doc()
  expect(aDoc.foo).toBe("baz")

  return true
}

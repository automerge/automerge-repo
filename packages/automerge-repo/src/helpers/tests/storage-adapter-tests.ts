import { describe, expect, it } from "vitest"

import type { StorageAdapterInterface } from "../../storage/StorageAdapterInterface.js"

export function runStorageAdapterTests(_setup: SetupFn, title?: string): void {
  const setup = async () => {
    const { adapter, teardown = NO_OP } = await _setup()
    return { adapter, teardown }
  }

  describe(`Network adapter acceptance tests ${
    title ? `(${title})` : ""
  }`, () => {
    describe("load", () => {
      it("should return undefined if there is no data", async () => {
        const { adapter, teardown } = await setup()
        expect(
          await adapter.load([
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ])
        ).toStrictEqual(undefined)
        teardown()
      })
    })

    describe("save and load", () => {
      it("should return data that was saved", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          ["storage-adapter-id"],
          new Uint8Array([
            56, 97, 51, 53, 99, 57, 98, 52, 45, 49, 48, 57, 101, 45, 52, 97, 55,
            102, 45, 97, 51, 53, 101, 45, 97, 53, 52, 54, 52, 49, 50, 49, 98,
            54, 100, 100,
          ])
        )

        const actual = await adapter.load(["storage-adapter-id"])

        expect(actual).toStrictEqual(
          new Uint8Array([
            56, 97, 51, 53, 99, 57, 98, 52, 45, 49, 48, 57, 101, 45, 52, 97, 55,
            102, 45, 97, 51, 53, 101, 45, 97, 53, 52, 54, 52, 49, 50, 49, 98,
            54, 100, 100,
          ])
        )
        teardown()
      })

      it("should work with composed keys", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "pSq9fP9ekr1zembLzBJkgHTo7Wn",
            "sync-state",
            "3761c9f0-bb1d-44b6-88ac-f85072fc3273",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        const actual = await adapter.load([
          "pSq9fP9ekr1zembLzBJkgHTo7Wn",
          "sync-state",
          "3761c9f0-bb1d-44b6-88ac-f85072fc3273",
        ])
        expect(actual).toStrictEqual(new Uint8Array([0, 1, 127, 99, 154, 235]))
        teardown()
      })
    })

    describe("loadRange", () => {
      it("should return empty array if there is no data", async () => {
        const { adapter, teardown } = await setup()
        expect(
          await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
        ).toStrictEqual([])
        teardown()
      })
    })

    describe("save and loadRange", () => {
      it("should return all the data that is present", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "snapshot",
            "7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870",
          ],
          new Uint8Array([1, 76, 160, 53, 57, 10, 230])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
          ],
          new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193])
        )

        expect(
          await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
        ).toStrictEqual(
          expect.arrayContaining([
            {
              data: new Uint8Array([0, 1, 127, 99, 154, 235]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "sync-state",
                "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
              ],
            },
            {
              data: new Uint8Array([1, 76, 160, 53, 57, 10, 230]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "snapshot",
                "7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870",
              ],
            },
            {
              data: new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "sync-state",
                "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
              ],
            },
          ])
        )

        expect(
          await adapter.loadRange([
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
          ])
        ).toStrictEqual(
          expect.arrayContaining([
            {
              data: new Uint8Array([0, 1, 127, 99, 154, 235]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "sync-state",
                "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
              ],
            },
            {
              data: new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "sync-state",
                "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
              ],
            },
          ])
        )
      })

      it("does not includes values which shouldn't be there", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiD",
            "sync-state",
            "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
          ],
          new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193])
        )

        const actual = await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
        expect(actual).toStrictEqual(
          expect.arrayContaining([
            {
              data: new Uint8Array([0, 1, 127, 99, 154, 235]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
                "sync-state",
                "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
              ],
            },
          ])
        )
        expect(actual).toStrictEqual(
          expect.not.arrayContaining([
            {
              data: new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]),
              key: [
                "3xuJ5sVKdBaYS6uGgGJH1cGhBLiD",
                "sync-state",
                "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
              ],
            },
          ])
        )
        teardown()
      })
    })

    describe("save and remove", () => {
      it("should be no data", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "snapshot",
            "090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.remove([
          "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
          "snapshot",
          "090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056",
        ])

        expect(
          await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
        ).toStrictEqual([])
        expect(
          await adapter.load([
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "snapshot",
            "090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056",
          ])
        ).toStrictEqual(undefined)
        teardown()
      })
    })

    describe("save and save", () => {
      it("should override the data", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([1, 76, 160, 53, 57, 10, 230])
        )

        expect(
          await adapter.loadRange([
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
          ])
        ).toStrictEqual([
          {
            data: new Uint8Array([1, 76, 160, 53, 57, 10, 230]),
            key: [
              "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
              "sync-state",
              "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
            ],
          },
        ])
        teardown()
      })
    })

    describe("removeRange", () => {
      it("should remove set of records", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "snapshot",
            "7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870",
          ],
          new Uint8Array([1, 76, 160, 53, 57, 10, 230])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
          ],
          new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193])
        )

        await adapter.removeRange([
          "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
          "sync-state",
        ])

        expect(
          await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
        ).toStrictEqual([
          {
            data: new Uint8Array([1, 76, 160, 53, 57, 10, 230]),
            key: [
              "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
              "snapshot",
              "7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870",
            ],
          },
        ])
        teardown()
      })

      it("should not remove set of records that doesn't match", async () => {
        const { adapter, teardown } = await setup()
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiC",
            "sync-state",
            "d99d4820-fb1f-4f3a-a40f-d5997b2012cf",
          ],
          new Uint8Array([0, 1, 127, 99, 154, 235])
        )
        await adapter.save(
          [
            "3xuJ5sVKdBaYS6uGgGJH1cGhBLiD",
            "sync-state",
            "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
          ],
          new Uint8Array([1, 76, 160, 53, 57, 10, 230])
        )

        await adapter.removeRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])

        const actual = await adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiD"])
        expect(actual).toStrictEqual([
          {
            data: new Uint8Array([1, 76, 160, 53, 57, 10, 230]),
            key: [
              "3xuJ5sVKdBaYS6uGgGJH1cGhBLiD",
              "sync-state",
              "0e05ed0c-41f5-4785-b27a-7cf334c1b741",
            ],
          },
        ])
        teardown()
      })
    })
  })
}

const NO_OP = () => {}

export type SetupFn = () => Promise<{
  adapter: StorageAdapterInterface
  teardown?: () => void
}>

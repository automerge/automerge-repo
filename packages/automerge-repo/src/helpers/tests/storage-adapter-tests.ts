import { describe, expect, it } from "vitest"

import type { StorageAdapterInterface } from "../../storage/StorageAdapterInterface.js"

export function runStorageAdapterTests(sut: {adapter: StorageAdapterInterface}) {

  describe('load', () => {
    it('should return undefined if there is no data', async () => {
      expect(
        await sut.adapter.load(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"])
      ).toStrictEqual(undefined)
    })
  })

  describe('save and load', () => {
    it('should be possible to save and load', async () => {
      await sut.adapter.save(["storage-adapter-id"], new TextEncoder().encode('8a35c9b4-109e-4a7f-a35e-a5464121b6dd'))
      const actual = await sut.adapter.load(["storage-adapter-id"])
      expect(actual).toStrictEqual(new TextEncoder().encode('8a35c9b4-109e-4a7f-a35e-a5464121b6dd'))
    })

    it('should work with composed keys', async () => {
      await sut.adapter.save(["pSq9fP9ekr1zembLzBJkgHTo7Wn","sync-state","3761c9f0-bb1d-44b6-88ac-f85072fc3273"], new Uint8Array([0, 1, 127, 99, 154, 235 ]))
      const actual = await sut.adapter.load(["pSq9fP9ekr1zembLzBJkgHTo7Wn","sync-state","3761c9f0-bb1d-44b6-88ac-f85072fc3273"])
      expect(actual).toStrictEqual(new Uint8Array([0, 1, 127, 99, 154, 235 ]))
    })
  })

  describe('loadRange', () => {
    it('should return empty array if there is no data', async () => {
      expect(
        await sut.adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
      ).toStrictEqual([])
    })
  })

  describe('save and loadRange', () => {
    it('should return all the data that is present', async () => {
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"], new Uint8Array([0, 1, 127, 99, 154, 235 ]))
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","snapshot","7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870"], new Uint8Array([1, 76, 160, 53, 57, 10, 230]))
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","0e05ed0c-41f5-4785-b27a-7cf334c1b741"], new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]))

      expect(
        await sut.adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
      ).toStrictEqual([
        {"data":new Uint8Array([0, 1, 127, 99, 154, 235 ]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"]},
        {"data":new Uint8Array([1, 76, 160, 53, 57, 10, 230]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","snapshot","7848c74d260d060ee02e12d69d43a21348fedf4f4a4783ac6aaaa2e338bca870"]},
        {"data":new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","0e05ed0c-41f5-4785-b27a-7cf334c1b741"]}
      ])

      expect(
        await sut.adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state"])
      ).toStrictEqual([
        {"data":new Uint8Array([0, 1, 127, 99, 154, 235 ]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"]},
        {"data":new Uint8Array([2, 111, 74, 131, 236, 96, 142, 193]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","0e05ed0c-41f5-4785-b27a-7cf334c1b741"]}
      ])
    })
  })

  describe('save and remove', () => {
    it('should be no data', async () => {
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","snapshot","090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056"], new Uint8Array([0, 1, 127, 99, 154, 235 ]))
      await sut.adapter.remove(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","snapshot","090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056"])

      expect(
        await sut.adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC"])
      ).toStrictEqual([])
      expect(
        await sut.adapter.load(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","snapshot","090144be3cabe2848d4af81ebf6c3f0c93dfcf814fd34a43cdc93d8564fda056"])
      ).toStrictEqual(undefined)
    })
  })

  describe('save and save', () => {
    it('should override the data', async () => {
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"], new Uint8Array([0, 1, 127, 99, 154, 235 ]))
      await sut.adapter.save(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"], new Uint8Array([1, 76, 160, 53, 57, 10, 230]))

      expect(
        await sut.adapter.loadRange(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state"])
      ).toStrictEqual([
        {"data":new Uint8Array([1, 76, 160, 53, 57, 10, 230]),"key":["3x","uJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"]},
      ])
    })
  })
}

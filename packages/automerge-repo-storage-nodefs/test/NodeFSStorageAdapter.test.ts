import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { runStorageAdapterTests } from "@automerge/automerge-repo/src/helpers/tests/storage-adapter-tests"
import { NodeFSStorageAdapter } from "../src"

function cleanDir(dir: string) {
  try {
    fs.rmSync(dir, { force: true, recursive: true })
  } catch (e) {}
}

describe('NodeFSStorageAdapter', () => {
  let baseDirectory: string = path.join(os.tmpdir(), crypto.randomUUID());
  let sut: {adapter: NodeFSStorageAdapter} = {adapter: new NodeFSStorageAdapter(baseDirectory)}

  beforeEach(async () => {
    baseDirectory = path.join(os.tmpdir(), crypto.randomUUID())
    sut.adapter = new NodeFSStorageAdapter(baseDirectory)
  })

  afterAll(async() => {
    cleanDir(baseDirectory);
  })

  describe('getFilePath', () => {
    it('should compose keys correctly', () => {
      // @ts-ignore
      const actual = sut.adapter.getFilePath(["3xuJ5sVKdBaYS6uGgGJH1cGhBLiC","sync-state","d99d4820-fb1f-4f3a-a40f-d5997b2012cf"])
      expect(actual).toStrictEqual(path.join(baseDirectory) + '/3x/uJ5sVKdBaYS6uGgGJH1cGhBLiC/sync-state/d99d4820-fb1f-4f3a-a40f-d5997b2012cf')
    })
  })

  runStorageAdapterTests(sut);
})

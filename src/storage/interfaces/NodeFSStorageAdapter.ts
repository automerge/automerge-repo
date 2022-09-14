import * as fs from "fs"
import { StorageAdapter } from "../StorageSubsystem"

export class NodeFSStorageAdapter implements StorageAdapter {
  directory: string

  constructor(directory = ".amrg") {
    this.directory = directory
  }

  fileName(docId: string) {
    return `${this.directory}/${docId}.amrg`
  }

  load(docId: string): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve) => {
      fs.readFile(this.fileName(docId), (err, data) => {
        if (err) resolve(null)
        else resolve(data)
      })
    })
  }

  save(docId: string, binary: Uint8Array): void {
    fs.writeFile(this.fileName(docId), binary, (err) => {
      // TODO: race condition if a load happens before the save is complete.
      // use an in-memory cache while save is in progress
      if (err) throw err
    })
  }

  remove(docId: string): void {
    fs.rm(this.fileName(docId), (err) => {
      if (err) throw err
    })
  }
}

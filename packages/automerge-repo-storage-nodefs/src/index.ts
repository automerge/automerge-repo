import * as fs from "fs"
import { StorageAdapter } from "@automerge/automerge-repo"

export class NodeFSStorageAdapter implements StorageAdapter {
  directory: string

  constructor(directory = "automerge-repo") {
    this.directory = directory
  }
  loadRange(keyPrefix: string[]): Promise<Uint8Array[]> {
    const keyString = keyPrefix.join(".")
    return new Promise<Uint8Array[]>(resolve => {
      fs.readdir(this.directory, (err, files) => {
        files
          .filter(file => file.startsWith(keyString))
          .map(file => {
            fs.readFile(`${this.directory}/${file}.amrg`, (err, data) => {
              if (err) throw err
              resolve([data])
            })
          })
      })
    })
  }
  removeRange(keyPrefix: string[]): void {
    const keyString = keyPrefix.join(".")
    fs.readdir(this.directory, (err, files) => {
      files
        .filter(file => file.startsWith(keyString))
        .map(file => {
          fs.rm(`${this.directory}/${file}.amrg`, err => {
            if (err) throw err
          })
        })
    })
  }

  fileName(key: string[]) {
    const keyString = key.join(".")
    return `${this.directory}/${keyString}.amrg`
  }

  load(key: string[]): Promise<Uint8Array | undefined> {
    return new Promise<Uint8Array | null>(resolve => {
      fs.readFile(this.fileName(key), (err, data) => {
        if (err) resolve(null)
        else resolve(data)
      })
    })
  }

  save(key: string[], binary: Uint8Array): void {
    fs.writeFile(this.fileName(key), binary, err => {
      // TODO: race condition if a load happens before the save is complete.
      // use an in-memory cache while save is in progress
      if (err) throw err
    })
  }

  remove(key: string[]): void {
    fs.rm(this.fileName(key), err => {
      if (err) console.log("removed a file that does not exist: " + key)
    })
  }
}

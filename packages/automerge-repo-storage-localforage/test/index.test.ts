import { expect } from "chai"
import { LocalForageStorageAdapter } from "../src"
import { localforageMock } from "./localforage.mock"

import * as localforage from "localforage";

describe("localforage tests", () => {
  it("can be instantiated", async () => {
    const adapter = new LocalForageStorageAdapter();
    
    expect(adapter).to.be.an.instanceof(LocalForageStorageAdapter);
    
    expect(adapter.load).to.be.a("function");
    expect(adapter.localforage).to.equal(localforage);
  })

  it("can be instantiated with options", async () => {
    const data = {
      'test': new Uint8Array([1,2,3])
    };
    
    const mock = localforageMock(data)
    
    const adapter = new LocalForageStorageAdapter({
      localforage: mock
    });

    const val = await adapter.load("test");
    expect(val).to.deep.equal(new Uint8Array([1,2,3]));

    adapter.save("test2", new Uint8Array([4,5,6]));
    expect(data['test2']).to.deep.equal(new Uint8Array([4, 5, 6]));
    
    adapter.remove("test");
    expect(data['test']).to.be.undefined;

    expect(adapter.localforage).not.to.equal(localforage);
  })
})

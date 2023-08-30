import { NetworkAdapter } from "../../src/index.js"

export class DummyNetworkAdapter extends NetworkAdapter {
  send() {}
  connect(_: string) {}
  join() {}
  leave() {}
}

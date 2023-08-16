import { NetworkAdapter } from "../../src"

export class DummyNetworkAdapter extends NetworkAdapter {
  send() {}
  connect(_: string) {}
  join() {}
  leave() {}
}

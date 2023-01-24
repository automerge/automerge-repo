import { NetworkAdapter } from "../../src"

export class DummyNetworkAdapter extends NetworkAdapter {
  sendMessage() {}
  connect(_: string) {}
  join(_: string) {}
  leave(_: string) {}
}

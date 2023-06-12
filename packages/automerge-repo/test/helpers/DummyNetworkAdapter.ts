import { NetworkAdapter } from "../../src"

export class DummyNetworkAdapter extends NetworkAdapter {
  sendMessage() {}
  connect(_: string) {}
}

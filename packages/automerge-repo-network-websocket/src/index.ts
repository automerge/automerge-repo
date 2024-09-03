/**
 * A `NetworkAdapter` which connects to a remote host via WebSockets
 *
 * The websocket protocol requires a server to be listening and a client to
 * connect to the server. To that end the {@link WebSocketServerAdapter} does not
 * make outbound connections and instead listens on the provided socket for
 * new connections whilst the {@link WebSocketClientAdapter} makes an
 * outbound connection to the provided socket.
 *
 * Note that the "browser" and "node" naming is a bit misleading, both
 * implementations work in both the browser and on node via `isomorphic-ws`.
 *
 * @module
 * */
export { WebSocketClientAdapter } from "./WebSocketClientAdapter.js"
export { WebSocketServerAdapter } from "./WebSocketServerAdapter.js"

/** @hidden */
export { WebSocketClientAdapter as BrowserWebSocketClientAdapter } from "./WebSocketClientAdapter.js"

/** @hidden */
export { WebSocketServerAdapter as NodeWSServerAdapter } from "./WebSocketServerAdapter.js"

export type {
  FromClientMessage,
  FromServerMessage,
  JoinMessage,
  ErrorMessage,
  PeerMessage,
} from "./messages.js"
export type { ProtocolVersion } from "./protocolVersion.js"
export { ProtocolV1 } from "./protocolVersion.js"

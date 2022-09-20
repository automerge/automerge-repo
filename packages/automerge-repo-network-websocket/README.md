# Automerge-Repo Network: Websocket

Includes two implementations, a Websocket client and a Websocket server. These are used by the example sync-server.

The package uses isomorphic-ws to share code between node and the browser, but the server code is node only due to lack of browser support.
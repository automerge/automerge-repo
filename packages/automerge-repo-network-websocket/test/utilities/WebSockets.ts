import http from "http"
import { createWebSocketServer } from "./CreateWebSocketServer"
import WebSocket from "ws"

function startServer(port: number) {
  const server = http.createServer()
  const socket = createWebSocketServer(server)
  return new Promise<{
    socket: WebSocket.Server
    server: http.Server
  }>(resolve => {
    server.listen(port, () => resolve({ socket, server }))
  })
}

type WebSocketState =
  | typeof WebSocket.CONNECTING
  | typeof WebSocket.OPEN
  | typeof WebSocket.CLOSING
  | typeof WebSocket.CLOSED

function waitForSocketState(socket: WebSocket, state: WebSocketState) {
  return new Promise<void>(function (resolve) {
    setTimeout(function () {
      if (socket.readyState === state) {
        resolve()
      } else {
        waitForSocketState(socket, state).then(resolve)
      }
    }, 5)
  })
}

export { startServer, waitForSocketState }

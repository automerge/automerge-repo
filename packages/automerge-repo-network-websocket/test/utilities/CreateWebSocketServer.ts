import http from "http"
import WebSocket from "ws"

function createWebSocketServer(server: http.Server) {
  return new WebSocket.Server({ server })
}

export { createWebSocketServer }

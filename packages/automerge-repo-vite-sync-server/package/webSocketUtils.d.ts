/// <reference types="node" />
/// <reference types="node" />
/// <reference types="node" />
import type { Server, WebSocket as WebSocketBase } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
export declare const GlobalThisWSS: unique symbol;
export interface ExtendedWebSocket extends WebSocketBase {
    socketId: string;
}
export type ExtendedWebSocketServer = Server<ExtendedWebSocket>;
export type ExtendedGlobal = typeof globalThis & {
    [GlobalThisWSS]: ExtendedWebSocketServer;
};
export declare const onHttpServerUpgrade: (req: IncomingMessage, sock: Duplex, head: Buffer) => void;
export declare const createWSSGlobalInstance: () => ExtendedWebSocketServer;
export declare const websocket: () => {
    name: string;
    configureServer(server: any): void;
    configurePreviewServer(server: any): void;
};

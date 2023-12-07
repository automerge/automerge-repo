import { parse } from "url";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
export const GlobalThisWSS = Symbol.for("sveltekit.wss");
export const onHttpServerUpgrade = (req, sock, head) => {
    const pathname = req.url ? parse(req.url).pathname : null;
    if (pathname !== "/websocket")
        return;
    const wss = globalThis[GlobalThisWSS];
    wss.handleUpgrade(req, sock, head, ws => {
        console.log("[handleUpgrade] creating new connecttion");
        wss.emit("connection", ws, req);
    });
};
export const createWSSGlobalInstance = () => {
    const wss = new WebSocketServer({ noServer: true });
    globalThis[GlobalThisWSS] = wss;
    wss.on("connection", ws => {
        ws.socketId = nanoid();
        console.log(`[wss:global] client connected (${ws.socketId})`);
        ws.on("close", () => {
            console.log(`[wss:global] client disconnected (${ws.socketId})`);
        });
    });
    return wss;
};
export const websocket = () => {
    return {
        name: "integratedWebsocketServer",
        configureServer(server) {
            createWSSGlobalInstance();
            server.httpServer?.on("upgrade", onHttpServerUpgrade);
        },
        configurePreviewServer(server) {
            createWSSGlobalInstance();
            server.httpServer?.on("upgrade", onHttpServerUpgrade);
        },
    };
};

import type { Handle } from "@sveltejs/kit";
import { ExtendedWebSocketServer, onHttpServerUpgrade, createWSSGlobalInstance } from "./webSocketUtils.js";
export { onHttpServerUpgrade, createWSSGlobalInstance };
export declare function SvelteKitAutomergeRepoSyncServer(): Handle;
declare global {
    namespace App {
        interface Locals {
            wss: ExtendedWebSocketServer | null;
        }
    }
}

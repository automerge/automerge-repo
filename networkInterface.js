import { Client } from "./Client.js";

export default function networkInterface(url, onPeer, onMessage) {
    const client = new Client({ userName: `user-${Math.round(Math.random() * 1000)}`, url });

    client.addEventListener('peer.connect', (ev) => {
        const { documentId, userName, socket } = ev.detail;
        socket.binaryType = 'arraybuffer';
        onPeer(userName, documentId, {
            isOpen: () => socket.readyState === WebSocket.OPEN,
            send: (msg) => socket.send(msg.buffer)
        });

        // listen for messages
        socket.onmessage = (e) => {
            console.log(e.data);
            const message = new Uint8Array(e.data);
            onMessage(userName, documentId, message);
        };
    });

    return {
        join: (docId) => { client.join(docId); },
    };
}

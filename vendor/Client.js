const  version  = "1.0";
const HEARTBEAT = JSON.stringify({ type: 'Heartbeat' });
const HEARTBEAT_INTERVAL = 55000; // 55 seconds

const uuid = Crypto.randomUuid

/**
 * This is a client for `relay` that keeps track of all peers that the server connects you to, and
 * for each peer it keeps track of each documentId (aka discoveryKey, aka channel) that you're
 * working with that peer on.
 *
 * The peers are WebSocket instances
 *
 * The simplest workflow is something like this:
 *
 * ```ts
 * client = new Client({ userName: 'my-peer-userName', url })
 *   .join('my-document-userName')
 *   .on('peer.connect', ({documentId, userName, socket}) => {
 *     // send a message
 *     socket.send('Hello!')
 *
 *     // listen for messages
 *     socket.onmessage = (e) => {
 *       const { data } = e
 *       console.log(data)
 *     }
 *   })
 * ```
 */
export class Client extends EventTarget {
    userName;
    /** The base URL of the relay server */
    url;
    /** All the document IDs we're interested in */
    documentIds = new Set();
    /** All the peers we're connected to. (A 'peer' in this case is actually just a bunch of sockets -
     * one per documentId that we have in common.) */
    peers = new Map();
    /** When disconnected, the delay in milliseconds before the next retry */
    retryDelay;
    /** Is the connection to the server currently open? */
    open;
    _log;
    serverConnection;
    /** If the connection is closed, do we want to reopen it? */
    shouldReconnectIfClosed = true;
    minRetryDelay;
    maxRetryDelay;
    backoffFactor;
    heartbeat;
    serverConnectionQueue = [];
    /**
     * @param userName a string that identifies you uniquely, defaults to a UUID
     * @param url the url of the `relay`, e.g. `http://myrelay.mydomain.com`
     * @param documentIds one or more document IDs that you're interested in
     */
    constructor({ userName = uuid(), url, documentIds = [], minRetryDelay = 10, backoffFactor = 1.5, maxRetryDelay = 30000, }) {
        super();
        this.log = console.log // debug(`lf:relay:client:${userName}`);
        this.log('version', version);
        this.userName = userName;
        this.url = url;
        this.minRetryDelay = minRetryDelay;
        this.maxRetryDelay = maxRetryDelay;
        this.backoffFactor = backoffFactor;
        // start out at the initial retry delay
        this.retryDelay = minRetryDelay;
        this.connectToServer();
        documentIds.forEach(id => this.join(id));
    }
    /**
     * Connects to the relay server, lets it know what documents we're interested in
     * @param documentIds array of IDs of documents we're interested in
     * @returns the socket connecting us to the server
     */
    connectToServer() {
        const url = `${this.url}/introduction/${this.userName}`;
        console.log('connecting to relay server', url);
        const serverConnection = new WebSocket(url);
        serverConnection.onopen = async () => {
            await isReady(serverConnection);
            this.retryDelay = this.minRetryDelay;
            this.shouldReconnectIfClosed = true;
            this.drainQueue();
            this.dispatchEvent(new Event('server.connect'));
            this.open = true;
            this.heartbeat = setInterval(() => serverConnection.send(HEARTBEAT), HEARTBEAT_INTERVAL);
        };
        serverConnection.onmessage = messageEvent => {
            const { data } = messageEvent;
            const message = JSON.parse(data.toString());

            console.log("message", message)
            // The only kind of message that we receive from the relay server is an introduction, which tells
            // us that someone else is interested in the same thing we are.
            if (message.type !== 'Introduction')
                throw new Error(`Invalid message type '${message.type}'`);
            // When we receive that message, we respond by requesting a "direct" connection to the peer
            // (via piped sockets on the relay server) for each document ID that we have in common
            const connectToPeer = (documentId, userName) => {
                const peer = this.get(userName);
                if (peer.has(documentId))
                    return; // don't add twice
                peer.set(documentId, null);
                const url = `${this.url}/connection/${this.userName}/${userName}/${documentId}`;
                const peerConnection = new WebSocket(url);
                peerConnection.onopen = async () => {
                    // make sure the socket is actually in READY state
                    await isReady(peerConnection);
                    // add the socket to the map for this peer
                    peer.set(documentId, peerConnection);
                    this.dispatchEvent(new CustomEvent('peer.connect', { detail: {
                        userName,
                        documentId,
                        socket: peerConnection,
                    }}));
                };
                // if the other end disconnects, we disconnect
                peerConnection.onclose = () => {
                    this.closeSocket(userName, documentId);
                    this.dispatchEvent(new CustomEvent('peer.disconnect', { detail: {
                        userName,
                        documentId,
                        socket: peerConnection,
                    }}));
                };
            };
            const { userName, documentIds = [] } = message;
            documentIds.forEach(documentId => connectToPeer(documentId, userName));
        };
        serverConnection.onclose = () => {
            this.open = false;
            this.dispatchEvent(new Event('server.disconnect'));
            // stop heartbeat
            clearInterval(this.heartbeat);
            if (this.shouldReconnectIfClosed)
                this.tryToReopen();
        };
        serverConnection.onerror = (ev) => {
            this.dispatchEvent(new CustomEvent('error', ev));
        };
        this.serverConnection = serverConnection;
        return this.serverConnection;
    }
    /** Try to reconnect after a delay  */
    tryToReopen() {
        setTimeout(() => {
            this.connectToServer();
            this.documentIds.forEach(id => this.join(id));
        }, this.retryDelay);
        // increase the delay for next time
        if (this.retryDelay < this.maxRetryDelay)
            this.retryDelay *= this.backoffFactor + Math.random() * 0.1 - 0.05; // randomly vary the delay
        this.log(`Relay connection closed. Retrying in ${Math.floor(this.retryDelay / 1000)}s`);
    }
    /**
     * Lets the server know that you're interested in a document. If there are other peers who have
     * joined the same DocumentId, you and the remote peer will both receive an introduction message,
     * inviting you to connect.
     * @param documentId
     */
    join(documentId) {
        this.log('joining', documentId);
        this.documentIds.add(documentId);
        const message = { type: 'Join', documentIds: [documentId] };
        this.send(message);
        return this;
    }
    /**
     * Leaves a documentId and closes any connections related to it
     * @param documentId
     */
    leave(documentId) {
        this.log('leaving', documentId);
        this.documentIds.delete(documentId);
        for (const [userName] of this.peers) {
            this.closeSocket(userName, documentId);
        }
        const message = { type: 'Leave', documentIds: [documentId] };
        this.send(message);
        return this;
    }
    /**
     * Disconnects from one peer
     * @param peerUserName Name of the peer to disconnect. If none is provided, we disconnect all peers.
     */
    disconnectPeer(peerUserName) {
        this.log(`disconnecting from ${peerUserName}`);
        const peer = this.get(peerUserName);
        for (const [documentId] of peer) {
            this.closeSocket(peerUserName, documentId);
        }
        return this;
    }
    /**
     * Disconnects from all peers and from the relay server
     */
    disconnectServer() {
        this.log(`disconnecting from all peers`);
        // Don't automatically try to reconnect after deliberately disconnecting
        this.shouldReconnectIfClosed = false;
        const peersToDisconnect = Array.from(this.peers.keys()); // all of them
        for (const userName of peersToDisconnect) {
            this.disconnectPeer(userName);
        }
        this.removeAllListeners();
        this.serverConnection.close();
    }
    has(peerUserName, documentId) {
        if (documentId !== undefined) {
            return this.has(peerUserName) && this.peers.get(peerUserName).has(documentId);
        }
        else {
            return this.peers.has(peerUserName);
        }
    }
    get(peerUserName, documentId) {
        if (documentId !== undefined) {
            return this.get(peerUserName)?.get(documentId);
        }
        else {
            // create an entry for this peer if there isn't already one
            if (!this.has(peerUserName))
                this.peers.set(peerUserName, new Map());
            return this.peers.get(peerUserName);
        }
    }
    drainQueue() {
        while (this.serverConnectionQueue.length) {
            let message = this.serverConnectionQueue.shift();
            this.send(message);
        }
    }
    async send(message) {
        await isReady(this.serverConnection);
        try {
            this.serverConnection.send(JSON.stringify(message));
        }
        catch (err) {
            this.serverConnectionQueue.push(message);
        }
    }
    closeSocket(userName, documentId) {
        const peer = this.get(userName);
        if (peer.has(documentId)) {
            const socket = peer.get(documentId);
            if (socket && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING)
                socket.close();
            peer.delete(documentId);
        }
    }
}
/* Util functions */
const pause = (t = 100) => new Promise(resolve => setTimeout(() => resolve(), t));
const isReady = async (socket) => new Promise(async (resolve, reject) => {
    while (socket.readyState !== WebSocket.OPEN)
        await pause(100);
    resolve();
});
//# sourceMappingURL=Client.js.map
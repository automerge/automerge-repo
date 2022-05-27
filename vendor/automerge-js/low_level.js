export function UseApi(api) {
    for (const k in api) {
        ApiHandler[k] = api[k];
    }
}
/* eslint-disable */
export const ApiHandler = {
    create(actor) { throw new RangeError("Automerge.use() not called"); },
    load(data, actor) { throw new RangeError("Automerge.use() not called"); },
    encodeChange(change) { throw new RangeError("Automerge.use() not called"); },
    decodeChange(change) { throw new RangeError("Automerge.use() not called"); },
    initSyncState() { throw new RangeError("Automerge.use() not called"); },
    encodeSyncMessage(message) { throw new RangeError("Automerge.use() not called"); },
    decodeSyncMessage(msg) { throw new RangeError("Automerge.use() not called"); },
    encodeSyncState(state) { throw new RangeError("Automerge.use() not called"); },
    decodeSyncState(data) { throw new RangeError("Automerge.use() not called"); },
    exportSyncState(state) { throw new RangeError("Automerge.use() not called"); },
    importSyncState(state) { throw new RangeError("Automerge.use() not called"); },
};
/* eslint-enable */

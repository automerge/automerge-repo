//export { uuid } from './uuid.js';
import { rootProxy, listProxy, textProxy, mapProxy } from "./proxies.js";
import { STATE, HEADS, OBJECT_ID, READ_ONLY, FROZEN } from "./constants.js";
import { Counter } from "./types.js";
export { Text, Counter, Int, Uint, Float64 } from "./types.js";
import { ApiHandler, UseApi } from "./low_level.js";
export function use(api) {
    UseApi(api);
}
function _state(doc) {
    const state = Reflect.get(doc, STATE);
    if (state == undefined) {
        throw new RangeError("must be the document root");
    }
    return state;
}
function _frozen(doc) {
    return Reflect.get(doc, FROZEN) === true;
}
function _heads(doc) {
    return Reflect.get(doc, HEADS);
}
function _obj(doc) {
    return Reflect.get(doc, OBJECT_ID);
}
function _readonly(doc) {
    return Reflect.get(doc, READ_ONLY) === true;
}
export function init(actor) {
    if (typeof actor !== "string") {
        actor = undefined;
    }
    const state = ApiHandler.create(actor);
    return rootProxy(state, true);
}
export function clone(doc) {
    const state = _state(doc).clone();
    return rootProxy(state, true);
}
export function free(doc) {
    return _state(doc).free();
}
export function from(initialState, actor) {
    return change(init(actor), (d) => Object.assign(d, initialState));
}
export function change(doc, options, callback) {
    if (typeof options === 'function') {
        return _change(doc, {}, options);
    }
    else if (typeof callback === 'function') {
        if (typeof options === "string") {
            options = { message: options };
        }
        return _change(doc, options, callback);
    }
    else {
        throw RangeError("Invalid args for change");
    }
}
function _change(doc, options, callback) {
    if (typeof callback !== "function") {
        throw new RangeError("invalid change function");
    }
    if (doc === undefined || _state(doc) === undefined || _obj(doc) !== "_root") {
        throw new RangeError("must be the document root");
    }
    if (_frozen(doc) === true) {
        throw new RangeError("Attempting to use an outdated Automerge document");
    }
    if (!!_heads(doc) === true) {
        throw new RangeError("Attempting to change an out of date document");
    }
    if (_readonly(doc) === false) {
        throw new RangeError("Calls to Automerge.change cannot be nested");
    }
    const state = _state(doc);
    const heads = state.getHeads();
    try {
        Reflect.set(doc, HEADS, heads);
        Reflect.set(doc, FROZEN, true);
        const root = rootProxy(state);
        callback(root);
        if (state.pendingOps() === 0) {
            Reflect.set(doc, FROZEN, false);
            Reflect.set(doc, HEADS, undefined);
            return doc;
        }
        else {
            state.commit(options.message, options.time);
            return rootProxy(state, true);
        }
    }
    catch (e) {
        //console.log("ERROR: ",e)
        Reflect.set(doc, FROZEN, false);
        Reflect.set(doc, HEADS, undefined);
        state.rollback();
        throw e;
    }
}
export function emptyChange(doc, options) {
    if (options === undefined) {
        options = {};
    }
    if (typeof options === "string") {
        options = { message: options };
    }
    if (doc === undefined || _state(doc) === undefined || _obj(doc) !== "_root") {
        throw new RangeError("must be the document root");
    }
    if (_frozen(doc) === true) {
        throw new RangeError("Attempting to use an outdated Automerge document");
    }
    if (_readonly(doc) === false) {
        throw new RangeError("Calls to Automerge.change cannot be nested");
    }
    const state = _state(doc);
    state.commit(options.message, options.time);
    return rootProxy(state, true);
}
export function load(data, actor) {
    const state = ApiHandler.load(data, actor);
    return rootProxy(state, true);
}
export function save(doc) {
    const state = _state(doc);
    return state.save();
}
export function merge(local, remote) {
    if (!!_heads(local) === true) {
        throw new RangeError("Attempting to change an out of date document");
    }
    const localState = _state(local);
    const heads = localState.getHeads();
    const remoteState = _state(remote);
    const changes = localState.getChangesAdded(remoteState);
    localState.applyChanges(changes);
    Reflect.set(local, HEADS, heads);
    return rootProxy(localState, true);
}
export function getActorId(doc) {
    const state = _state(doc);
    return state.getActorId();
}
function conflictAt(context, objectId, prop) {
    const values = context.getAll(objectId, prop);
    if (values.length <= 1) {
        return;
    }
    const result = {};
    for (const fullVal of values) {
        switch (fullVal[0]) {
            case "map":
                result[fullVal[1]] = mapProxy(context, fullVal[1], [prop], true);
                break;
            case "list":
                result[fullVal[1]] = listProxy(context, fullVal[1], [prop], true);
                break;
            case "text":
                result[fullVal[1]] = textProxy(context, fullVal[1], [prop], true);
                break;
            //case "table":
            //case "cursor":
            case "str":
            case "uint":
            case "int":
            case "f64":
            case "boolean":
            case "bytes":
            case "null":
                result[fullVal[2]] = fullVal[1];
                break;
            case "counter":
                result[fullVal[2]] = new Counter(fullVal[1]);
                break;
            case "timestamp":
                result[fullVal[2]] = new Date(fullVal[1]);
                break;
            default:
                throw RangeError(`datatype ${fullVal[0]} unimplemented`);
        }
    }
    return result;
}
export function getConflicts(doc, prop) {
    const state = _state(doc);
    const objectId = _obj(doc);
    return conflictAt(state, objectId, prop);
}
export function getLastLocalChange(doc) {
    const state = _state(doc);
    try {
        return state.getLastLocalChange();
    }
    catch (e) {
        return;
    }
}
export function getObjectId(doc) {
    return _obj(doc);
}
export function getChanges(oldState, newState) {
    const o = _state(oldState);
    const n = _state(newState);
    const heads = _heads(oldState);
    return n.getChanges(heads || o.getHeads());
}
export function getAllChanges(doc) {
    const state = _state(doc);
    return state.getChanges([]);
}
export function applyChanges(doc, changes) {
    if (doc === undefined || _obj(doc) !== "_root") {
        throw new RangeError("must be the document root");
    }
    if (_frozen(doc) === true) {
        throw new RangeError("Attempting to use an outdated Automerge document");
    }
    if (_readonly(doc) === false) {
        throw new RangeError("Calls to Automerge.change cannot be nested");
    }
    const state = _state(doc);
    const heads = state.getHeads();
    state.applyChanges(changes);
    Reflect.set(doc, HEADS, heads);
    return [rootProxy(state, true)];
}
export function getHistory(doc) {
    const history = getAllChanges(doc);
    return history.map((change, index) => ({
        get change() {
            return decodeChange(change);
        },
        get snapshot() {
            const [state] = applyChanges(init(), history.slice(0, index + 1));
            return state;
        }
    }));
}
// FIXME : no tests
export function equals(val1, val2) {
    if (!isObject(val1) || !isObject(val2))
        return val1 === val2;
    const keys1 = Object.keys(val1).sort(), keys2 = Object.keys(val2).sort();
    if (keys1.length !== keys2.length)
        return false;
    for (let i = 0; i < keys1.length; i++) {
        if (keys1[i] !== keys2[i])
            return false;
        if (!equals(val1[keys1[i]], val2[keys2[i]]))
            return false;
    }
    return true;
}
export function encodeSyncState(state) {
    return ApiHandler.encodeSyncState(ApiHandler.importSyncState(state));
}
export function decodeSyncState(state) {
    return ApiHandler.exportSyncState(ApiHandler.decodeSyncState(state));
}
export function generateSyncMessage(doc, inState) {
    const state = _state(doc);
    const syncState = ApiHandler.importSyncState(inState);
    const message = state.generateSyncMessage(syncState);
    const outState = ApiHandler.exportSyncState(syncState);
    return [outState, message];
}
export function receiveSyncMessage(doc, inState, message) {
    const syncState = ApiHandler.importSyncState(inState);
    if (doc === undefined || _obj(doc) !== "_root") {
        throw new RangeError("must be the document root");
    }
    if (_frozen(doc) === true) {
        throw new RangeError("Attempting to use an outdated Automerge document");
    }
    if (!!_heads(doc) === true) {
        throw new RangeError("Attempting to change an out of date document");
    }
    if (_readonly(doc) === false) {
        throw new RangeError("Calls to Automerge.change cannot be nested");
    }
    const state = _state(doc);
    const heads = state.getHeads();
    state.receiveSyncMessage(syncState, message);
    Reflect.set(doc, HEADS, heads);
    const outState = ApiHandler.exportSyncState(syncState);
    return [rootProxy(state, true), outState, null];
}
export function initSyncState() {
    return ApiHandler.exportSyncState(ApiHandler.initSyncState());
}
export function encodeChange(change) {
    return ApiHandler.encodeChange(change);
}
export function decodeChange(data) {
    return ApiHandler.decodeChange(data);
}
export function encodeSyncMessage(message) {
    return ApiHandler.encodeSyncMessage(message);
}
export function decodeSyncMessage(message) {
    return ApiHandler.decodeSyncMessage(message);
}
export function getMissingDeps(doc, heads) {
    const state = _state(doc);
    return state.getMissingDeps(heads);
}
export function getHeads(doc) {
    const state = _state(doc);
    return _heads(doc) || state.getHeads();
}
export function dump(doc) {
    const state = _state(doc);
    state.dump();
}
// FIXME - return T?
export function toJS(doc) {
    const state = _state(doc);
    const heads = _heads(doc);
    return state.materialize("_root", heads);
}
function isObject(obj) {
    return typeof obj === 'object' && obj !== null;
}

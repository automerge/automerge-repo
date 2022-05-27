/* tslint:disable */
/* eslint-disable */
/**
* @param {string | undefined} actor
* @returns {Automerge}
*/
export function create(actor?: string): Automerge;
/**
* @param {Uint8Array} data
* @param {string | undefined} actor
* @returns {Automerge}
*/
export function loadDoc(data: Uint8Array, actor?: string): Automerge;
/**
* @param {any} change
* @returns {Uint8Array}
*/
export function encodeChange(change: any): Uint8Array;
/**
* @param {Uint8Array} change
* @returns {any}
*/
export function decodeChange(change: Uint8Array): any;
/**
* @returns {SyncState}
*/
export function initSyncState(): SyncState;
/**
* @param {any} state
* @returns {SyncState}
*/
export function importSyncState(state: any): SyncState;
/**
* @param {SyncState} state
* @returns {any}
*/
export function exportSyncState(state: SyncState): any;
/**
* @param {any} message
* @returns {Uint8Array}
*/
export function encodeSyncMessage(message: any): Uint8Array;
/**
* @param {Uint8Array} msg
* @returns {any}
*/
export function decodeSyncMessage(msg: Uint8Array): any;
/**
* @param {SyncState} state
* @returns {Uint8Array}
*/
export function encodeSyncState(state: SyncState): Uint8Array;
/**
* @param {Uint8Array} data
* @returns {SyncState}
*/
export function decodeSyncState(data: Uint8Array): SyncState;
/**
*/
export class Automerge {
  free(): void;
/**
* @param {string | undefined} actor
* @returns {Automerge}
*/
  static new(actor?: string): Automerge;
/**
* @param {string | undefined} actor
* @returns {Automerge}
*/
  clone(actor?: string): Automerge;
/**
* @param {string | undefined} actor
* @returns {Automerge}
*/
  fork(actor?: string): Automerge;
/**
* @param {any} heads
* @param {string | undefined} actor
* @returns {Automerge}
*/
  forkAt(heads: any, actor?: string): Automerge;
/**
*/
  free(): void;
/**
* @returns {any}
*/
  pendingOps(): any;
/**
* @param {string | undefined} message
* @param {number | undefined} time
* @returns {any}
*/
  commit(message?: string, time?: number): any;
/**
* @param {Automerge} other
* @returns {Array<any>}
*/
  merge(other: Automerge): Array<any>;
/**
* @returns {number}
*/
  rollback(): number;
/**
* @param {any} obj
* @param {Array<any> | undefined} heads
* @returns {Array<any>}
*/
  keys(obj: any, heads?: Array<any>): Array<any>;
/**
* @param {any} obj
* @param {Array<any> | undefined} heads
* @returns {string}
*/
  text(obj: any, heads?: Array<any>): string;
/**
* @param {any} obj
* @param {number} start
* @param {number} delete_count
* @param {any} text
*/
  splice(obj: any, start: number, delete_count: number, text: any): void;
/**
* @param {any} obj
* @param {any} value
* @param {any} datatype
*/
  push(obj: any, value: any, datatype: any): void;
/**
* @param {any} obj
* @param {any} value
* @returns {string | undefined}
*/
  pushObject(obj: any, value: any): string | undefined;
/**
* @param {any} obj
* @param {number} index
* @param {any} value
* @param {any} datatype
*/
  insert(obj: any, index: number, value: any, datatype: any): void;
/**
* @param {any} obj
* @param {number} index
* @param {any} value
* @returns {string | undefined}
*/
  insertObject(obj: any, index: number, value: any): string | undefined;
/**
* @param {any} obj
* @param {any} prop
* @param {any} value
* @param {any} datatype
*/
  put(obj: any, prop: any, value: any, datatype: any): void;
/**
* @param {any} obj
* @param {any} prop
* @param {any} value
* @returns {any}
*/
  putObject(obj: any, prop: any, value: any): any;
/**
* @param {any} obj
* @param {any} prop
* @param {any} value
*/
  increment(obj: any, prop: any, value: any): void;
/**
* @param {any} obj
* @param {any} prop
* @param {Array<any> | undefined} heads
* @returns {Array<any> | undefined}
*/
  get(obj: any, prop: any, heads?: Array<any>): Array<any> | undefined;
/**
* @param {any} obj
* @param {any} arg
* @param {Array<any> | undefined} heads
* @returns {Array<any>}
*/
  getAll(obj: any, arg: any, heads?: Array<any>): Array<any>;
/**
* @param {any} enable
*/
  enablePatches(enable: any): void;
/**
* @returns {Array<any>}
*/
  popPatches(): Array<any>;
/**
* @param {any} obj
* @param {Array<any> | undefined} heads
* @returns {number}
*/
  length(obj: any, heads?: Array<any>): number;
/**
* @param {any} obj
* @param {any} prop
*/
  delete(obj: any, prop: any): void;
/**
* @returns {Uint8Array}
*/
  save(): Uint8Array;
/**
* @returns {Uint8Array}
*/
  saveIncremental(): Uint8Array;
/**
* @param {Uint8Array} data
* @returns {number}
*/
  loadIncremental(data: Uint8Array): number;
/**
* @param {any} changes
*/
  applyChanges(changes: any): void;
/**
* @param {any} have_deps
* @returns {Array<any>}
*/
  getChanges(have_deps: any): Array<any>;
/**
* @param {any} hash
* @returns {any}
*/
  getChangeByHash(hash: any): any;
/**
* @param {Automerge} other
* @returns {Array<any>}
*/
  getChangesAdded(other: Automerge): Array<any>;
/**
* @returns {Array<any>}
*/
  getHeads(): Array<any>;
/**
* @returns {string}
*/
  getActorId(): string;
/**
* @returns {Uint8Array}
*/
  getLastLocalChange(): Uint8Array;
/**
*/
  dump(): void;
/**
* @param {Array<any> | undefined} heads
* @returns {Array<any>}
*/
  getMissingDeps(heads?: Array<any>): Array<any>;
/**
* @param {SyncState} state
* @param {Uint8Array} message
*/
  receiveSyncMessage(state: SyncState, message: Uint8Array): void;
/**
* @param {SyncState} state
* @returns {any}
*/
  generateSyncMessage(state: SyncState): any;
/**
* @returns {any}
*/
  toJS(): any;
/**
* @param {any} obj
* @param {Array<any> | undefined} heads
* @returns {any}
*/
  materialize(obj: any, heads?: Array<any>): any;
}
/**
*/
export class SyncState {
  free(): void;
/**
* @returns {SyncState}
*/
  clone(): SyncState;
/**
* @returns {any}
*/
  lastSentHeads: any;
/**
* @param {any} hashes
*/
  sentHashes: any;
/**
* @returns {any}
*/
  readonly sharedHeads: any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_automerge_free: (a: number) => void;
  readonly automerge_new: (a: number, b: number, c: number) => void;
  readonly automerge_clone: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_fork: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_forkAt: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_free: (a: number) => void;
  readonly automerge_pendingOps: (a: number) => number;
  readonly automerge_commit: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly automerge_merge: (a: number, b: number, c: number) => void;
  readonly automerge_rollback: (a: number) => number;
  readonly automerge_keys: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_text: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_splice: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly automerge_push: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_pushObject: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_insert: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly automerge_insertObject: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_put: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly automerge_putObject: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_increment: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_get: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_getAll: (a: number, b: number, c: number, d: number, e: number) => void;
  readonly automerge_enablePatches: (a: number, b: number, c: number) => void;
  readonly automerge_popPatches: (a: number, b: number) => void;
  readonly automerge_length: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_delete: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_save: (a: number) => number;
  readonly automerge_saveIncremental: (a: number) => number;
  readonly automerge_loadIncremental: (a: number, b: number, c: number) => void;
  readonly automerge_applyChanges: (a: number, b: number, c: number) => void;
  readonly automerge_getChanges: (a: number, b: number, c: number) => void;
  readonly automerge_getChangeByHash: (a: number, b: number, c: number) => void;
  readonly automerge_getChangesAdded: (a: number, b: number, c: number) => void;
  readonly automerge_getHeads: (a: number) => number;
  readonly automerge_getActorId: (a: number, b: number) => void;
  readonly automerge_getLastLocalChange: (a: number, b: number) => void;
  readonly automerge_dump: (a: number) => void;
  readonly automerge_getMissingDeps: (a: number, b: number, c: number) => void;
  readonly automerge_receiveSyncMessage: (a: number, b: number, c: number, d: number) => void;
  readonly automerge_generateSyncMessage: (a: number, b: number, c: number) => void;
  readonly automerge_toJS: (a: number) => number;
  readonly automerge_materialize: (a: number, b: number, c: number, d: number) => void;
  readonly create: (a: number, b: number, c: number) => void;
  readonly loadDoc: (a: number, b: number, c: number, d: number) => void;
  readonly encodeChange: (a: number, b: number) => void;
  readonly decodeChange: (a: number, b: number) => void;
  readonly initSyncState: () => number;
  readonly importSyncState: (a: number, b: number) => void;
  readonly exportSyncState: (a: number) => number;
  readonly encodeSyncMessage: (a: number, b: number) => void;
  readonly decodeSyncMessage: (a: number, b: number) => void;
  readonly encodeSyncState: (a: number, b: number) => void;
  readonly decodeSyncState: (a: number, b: number) => void;
  readonly __wbg_syncstate_free: (a: number) => void;
  readonly syncstate_sharedHeads: (a: number) => number;
  readonly syncstate_lastSentHeads: (a: number) => number;
  readonly syncstate_set_lastSentHeads: (a: number, b: number, c: number) => void;
  readonly syncstate_set_sentHashes: (a: number, b: number, c: number) => void;
  readonly syncstate_clone: (a: number) => number;
  readonly __wbindgen_malloc: (a: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
}

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;

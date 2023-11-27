// ignore file coverage
import _debug from "debug"

const originalFormatArgs = _debug.formatArgs

_debug.formatArgs = function (args: any[]) {
  for (let i = 0; i < args.length; i++) {
    args[i] = truncateHashes(args[i])
  }
  originalFormatArgs.call(this, args)
}

// ignore coverage
export function truncateHashes<T>(arg: T): T {
  if (typeof arg === "string") {
    return omitByteArraysInString(truncateHashesInString(arg)) as T
  }

  if (Array.isArray(arg)) {
    return arg.map(truncateHashes) as T
  }

  if (typeof arg === "object") {
    const object = {} as any
    for (const prop in arg) {
      const value = arg[prop]
      object[truncateHashes(prop)] = truncateHashes(value)
    }

    return object
  }

  return arg
}

const truncateHashesInString = (s: string) => {
  const hashRx = /(?:[A-Za-z\d+/=]{32,9999})?/g
  return s.replaceAll(hashRx, s => s.slice(0, 5))
}

const omitByteArraysInString = (s: string) => {
  const byteArrayRx = /(Uint8Array\(\d+\)) \[.+\]/g
  return s.replaceAll(byteArrayRx, "$1")
}

export const debug = _debug("automerge-repo")

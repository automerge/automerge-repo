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
    const transforms: [RegExp, string | RegexReplacer][] = [
      // strip ANSI color codes
      [/\x1B\[\d+m/g, ""],
      // strip line feeds
      [/\\n/g, ""],
      // strip contents of Uint8Arrays
      [/(Uint8Array\(\d+\)) \[.+\]/g, s => `${s.slice(0, 20)}...]`],
      // strip contents of Uint8Arrays expressed as objects
      [/(\{ ('\d+': \d+,?\s*)+\})/g, s => `${s.slice(0, 20)}...}`],
      // strip buffers
      [/<(Buffer) ([a-f0-9\s]+)>/g, s => `${s.slice(0, 20)}...>`],
      [
        /\{"type":"Buffer","data":\[(\d+,?\s*)+\]\}/g,
        s => `${s.slice(0, 40)}...]}`,
      ],
    ]

    return transforms.reduce(
      // @ts-ignore
      (acc, [rx, replacement]) => acc.replaceAll(rx, replacement),
      arg as string
    ) as T
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

export const debug = _debug("automerge-repo:auth-localfirst-syncserver")

type RegexReplacer = (substring: string, ...args: any[]) => string

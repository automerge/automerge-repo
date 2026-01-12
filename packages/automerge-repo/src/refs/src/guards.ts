import type { Segment, Pattern, CursorMarker, RefUrl } from "./types";
import { CURSOR_MARKER, KIND } from "./types";
import { parseRefUrl } from "./parser";

function isObject(val: unknown): val is object {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

export function isSegment(val: unknown): val is Segment {
  return isObject(val) && KIND in val;
}

export function isCursorMarker(val: unknown): val is CursorMarker {
  return isObject(val) && CURSOR_MARKER in val;
}

export function isPattern(val: unknown): val is Pattern {
  return isObject(val) && !isSegment(val) && !isCursorMarker(val);
}

export function isValidRefUrl(str: unknown): str is RefUrl {
  if (typeof str !== "string" || !str || !str.startsWith("automerge:")) {
    return false;
  }

  try {
    parseRefUrl(str as RefUrl);
    return true;
  } catch {
    return false;
  }
}

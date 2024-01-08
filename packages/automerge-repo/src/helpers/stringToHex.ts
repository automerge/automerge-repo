export function stringToHex(str: string) {
  return str
    .split("")
    .map(c => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
}

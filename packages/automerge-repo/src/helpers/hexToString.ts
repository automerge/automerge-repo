export function hexToString(hex: string) {
  var string = ""
  for (var i = 0; i < hex.length; i += 2) {
    string += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
  }
  return string
}

export function mergeArrays(myArrays: Uint8Array[]) {
  // Get the total length of all arrays.
  let length = 0
  myArrays.forEach(item => {
    length += item.length
  })

  // Create a new array with total length and merge all source arrays.
  const mergedArray = new Uint8Array(length)
  let offset = 0
  myArrays.forEach(item => {
    mergedArray.set(item, offset)
    offset += item.length
  })

  return mergedArray
}

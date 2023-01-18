export const getRandomItem = <T>(iterable: Record<string, T>) => {
  const keys = Object.keys(iterable)
  const index = Math.floor(Math.random() * keys.length)
  return iterable[keys[index]]
}

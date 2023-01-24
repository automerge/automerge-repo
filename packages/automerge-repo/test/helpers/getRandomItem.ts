export const getRandomItem = <T>(obj: T[]) => {
  const index = Math.floor(Math.random() * obj.length)
  return obj[index] as T
}

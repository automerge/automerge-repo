export default async function pause(millis: number) {
  return new Promise(resolve => setTimeout(resolve, millis))
}

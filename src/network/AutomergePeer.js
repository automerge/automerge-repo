/**
 * AutomergeNetwork
 * peers are:
 * {
 *   id: string,
 *   isOpen(): bool, // are we still connected?
 *   send(msg): transmit a message to a peer
 * }
 *
 */
export default class AutomergePeer extends EventTarget {
  id
  isOpen
  send

  constructor(id, isOpen, send) {
    super()

    this.id = id
    this.isOpen = isOpen
    this.send = send
  }
}

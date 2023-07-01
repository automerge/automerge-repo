import { useRepo } from "automerge-repo-react-hooks";
import { useEffect } from "react";
import useStateRef from "react-usestateref";
import EventEmitter from "eventemitter3";

// Add this to the beginning of every channel ID to help prevent collisions
export const CHANNEL_ID_PREFIX = "aw\n";

// Emits new_peer event when a new peer is seen
export const peerEvents = new EventEmitter();

/**
 *
 * This hook returns read-only state for remote clients.
 * It also returns their heartbeat status.
 * It is intended to be used alongside useLocalAwareness.
 *
 * @param {string} channelId Which channel to send messages on. This *must* be unique.
 * @param {object?} options
 * @param {string?} options.localUserId Automerge BroadcastChannel sometimes sends us our own messages; optionally filters them
 * @param {number?30000} options.offlineTimeout How long to wait (in ms) before marking a peer as offline
 * @param {function?} options.getTime Function to provide current epoch time (used for testing)
 * @returns [ peerStates: { [userId]: state, ... }, { [userId]: heartbeatEpochTime, ...} ]
 */
export const useRemoteAwareness = (
  channelIdUnprefixed,
  {
    localUserId,
    offlineTimeout = 30000,
    getTime = () => new Date().getTime(),
  } = {}
) => {
  // TODO: You should be able to use multiple instances of this hook on the same channelID (write test)
  const channelId = CHANNEL_ID_PREFIX + channelIdUnprefixed;
  const [peerStates, setPeerStates, peerStatesRef] = useStateRef({});
  const [heartbeats, setHeartbeats, heartbeatsRef] = useStateRef({});
  const { ephemeralData } = useRepo(); // EphemeralData API lets us send messages to peers on the automerge document
  useEffect(() => {
    // Receive incoming message
    const handleIncomingUpdate = (event) => {
      try {
        if (event.channelId !== channelId) return;
        const [userId, state] = event.data;
        if (userId === localUserId) return;
        if (!heartbeatsRef.current[userId]) peerEvents.emit("new_peer", event); // Let useRemoteAwareness know we've seen a new peer
        setPeerStates({
          ...peerStatesRef.current,
          [userId]: state,
        });
        setHeartbeats({
          ...heartbeatsRef.current,
          [userId]: getTime(),
        });
      } catch (e) {
        return;
      }
    };
    // Remove peers we haven't seen recently
    const pruneOfflinePeers = () => {
      const peerStates = peerStatesRef.current;
      const heartbeats = heartbeatsRef.current;
      const time = getTime();
      for (const key in heartbeats) {
        if (time - heartbeats[key] > offlineTimeout) {
          delete peerStates[key];
          delete heartbeats[key];
        }
      }
      setPeerStates(peerStates);
      setHeartbeats(heartbeats);
    };
    ephemeralData.on("data", handleIncomingUpdate);
    // Check for offline peers every `offlineTimeout` ms
    const pruneOfflinePeersIntervalId = setInterval(
      pruneOfflinePeers,
      offlineTimeout
    );
    return () => {
      ephemeralData.removeListener("data", handleIncomingUpdate);
      clearInterval(pruneOfflinePeersIntervalId);
    };
  }, [channelId, localUserId, offlineTimeout, getTime, ephemeralData]);
  return [peerStates, heartbeats];
};

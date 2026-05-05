// Map of active peer connections: userId -> RTCPeerConnection (on frontend)
// This backend only relays signaling messages, no WebRTC logic.

// In-memory room state (shared with main server)
const rooms = new Map();   // room -> Set of { ws, userId, username, avatar }

// Find a client by userId in a room
function findClientInRoom(roomCode, targetUserId) {
  const r = rooms.get(roomCode);
  if (!r) return null;
  for (const c of r) {
    if (c.userId === targetUserId) return c;
  }
  return null;
}

function handleVoiceSignaling(ws, data, userId, username) {
  const { type, room, target, sdp, candidate } = data;

  if (type === 'voice_room_start') {
    // Broadcast "voice_room_started" to all in room
    const r = rooms.get(room);
    if (r) {
      broadcastToRoom(room, {
        type: 'voice_room_started',
        initiator: userId,
        members: Array.from(r).map(c => ({ userId: c.userId, username: c.username })),
      }, ws);
    }
  }
  else if (['voice_offer', 'voice_answer', 'voice_ice'].includes(type)) {
    if (!target) return;
    const targetClient = findClientInRoom(room, target);
    if (targetClient && targetClient.ws.readyState === targetClient.ws.OPEN) {
      targetClient.ws.send(JSON.stringify({
        type,
        sender: userId,
        sdp,
        candidate,
      }));
    }
  }
  else if (type === 'voice_room_leave') {
    broadcastToRoom(room, { type: 'voice_user_left', userId }, ws);
    // Optionally remove from room? (handled in main leave)
  }
  else if (type === 'voice_room_end') {
    broadcastToRoom(room, { type: 'voice_room_ended', initiator: userId }, ws);
  }
}

// Set rooms reference (called from server.js)
function setRooms(roomsMap) {
  // Re-assign the rooms reference to the one in server memory
  rooms.clear();
  for (const [key, value] of roomsMap) {
    rooms.set(key, value);
  }
}

module.exports = { handleVoiceSignaling, setRooms };
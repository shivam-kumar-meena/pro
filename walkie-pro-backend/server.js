require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const connectDB = require('./config/db');
const cloudinary = require('./config/cloudinary');
const User = require('./models/User');
const Message = require('./models/Message');
const Room = require('./models/Room');

const { generateId } = require('./websocket/utils');
const {
  handleMessage, handleDelete, handleReaction, handleTyping,
  setBroadcast, loadPendingTimers
} = require('./websocket/chatHandlers');

const { handleVoiceSignaling, setRooms } = require('./websocket/voiceHandlers');

// ─────────────── Express setup ───────────────
const app = express();
const server = http.createServer(app);

// 🔥 IMPORTANT: attach WS to SAME server
const wss = new WebSocket.Server({ server });

// ─────────────── State ───────────────
const rooms = new Map();
const clients = new Map();

// ─────────────── Broadcast helper ───────────────
function broadcastToRoom(roomCode, data, exclude = null) {
  const r = rooms.get(roomCode);
  if (!r) return;

  for (const c of r) {
    if (c.ws !== exclude && c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(JSON.stringify(data));
      } catch (err) {
        console.error("Send error:", err.message);
      }
    }
  }
}

setBroadcast(broadcastToRoom);
setRooms(rooms);

// ─────────────── WebSocket ───────────────
wss.on('connection', (ws) => {
  console.log("✅ Client connected");

  let currentRoom = null;
  let currentUserId = generateId();
  let currentUsername = null;
  let userAvatar = '';

  clients.set(ws, currentUserId);

  ws.send(JSON.stringify({ type: 'welcome', userId: currentUserId }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, room, username, ...payload } = msg;

    // JOIN
    if (type === 'join') {
      if (!room || !username) return;

      if (currentRoom) leaveRoom(ws, currentRoom, currentUserId, currentUsername);

      await User.findOneAndUpdate(
        { userId: currentUserId },
        { username, name: payload.name || username, avatar: payload.avatar || '' },
        { upsert: true, new: true }
      );

      userAvatar = payload.avatar || '';
      currentRoom = room;
      currentUsername = username;

      if (!rooms.has(room)) rooms.set(room, new Set());
      const r = rooms.get(room);

      if (r.size >= 4) {
        ws.send(JSON.stringify({ type: 'error', data: 'Room full (max 4)' }));
        return;
      }

      r.add({ ws, userId: currentUserId, username, avatar: userAvatar });

      const history = await Message.find({ room, deleted: false })
        .sort({ timestamp: -1 }).limit(100);

      ws.send(JSON.stringify({
        type: 'joined',
        room,
        userId: currentUserId,
        members: Array.from(r),
        history: history.reverse()
      }));

      broadcastToRoom(room, {
        type: 'user_joined',
        userId: currentUserId,
        username,
        avatar: userAvatar,
      }, ws);
    }

    // PROFILE UPDATE
    else if (type === 'profile_update') {
      if (!currentRoom) return;

      await User.findOneAndUpdate(
        { userId: currentUserId },
        { name: payload.name, avatar: payload.avatar }
      );

      userAvatar = payload.avatar;

      broadcastToRoom(currentRoom, {
        type: 'profile_updated',
        userId: currentUserId,
        avatar: payload.avatar,
        name: payload.name,
      }, ws);
    }

    // LEAVE
    else if (type === 'leave') {
      leaveRoom(ws, currentRoom, currentUserId, currentUsername);
      currentRoom = null;
      currentUsername = null;
    }

    // CHAT TYPES
    else if (['chat', 'voice', 'image', 'file'].includes(type)) {
      if (!currentRoom) return;
      await handleMessage(ws, {
        ...msg,
        room: currentRoom,
        userId: currentUserId,
        username: currentUsername,
        avatar: userAvatar
      });
    }

    else if (type === 'delete_message') {
      if (!currentRoom) return;
      await handleDelete(ws, { ...msg, room: currentRoom }, currentUserId);
    }

    else if (type === 'reaction') {
      if (!currentRoom) return;
      await handleReaction(ws, { ...msg, room: currentRoom }, currentUserId);
    }

    else if (type === 'typing' || type === 'speaking') {
      if (!currentRoom) return;
      handleTyping(ws, { ...msg, room: currentRoom });
    }

    // VOICE
    else if (type?.startsWith('voice_')) {
      if (!currentRoom) return;
      handleVoiceSignaling(ws, { ...msg, room: currentRoom }, currentUserId, currentUsername);
    }
  });

  ws.on('close', () => {
    console.log("❌ Client disconnected");

    clients.delete(ws);
    if (currentRoom) {
      leaveRoom(ws, currentRoom, currentUserId, currentUsername);
    }
  });

  ws.on('error', (err) => {
    console.error("❌ WS Error:", err.message);
  });
});

// ─────────────── Leave Room ───────────────
function leaveRoom(ws, room, userId, username) {
  if (!room) return;

  const r = rooms.get(room);
  if (!r) return;

  for (const c of r) {
    if (c.ws === ws) {
      r.delete(c);
      break;
    }
  }

  if (r.size === 0) rooms.delete(room);
  else {
    broadcastToRoom(room, {
      type: 'user_left',
      userId,
      username
    });
  }
}

// ─────────────── Health Route ───────────────
app.get('/', (req, res) => {
  res.send("🚀 Walkie Pro Backend Running");
});

// ─────────────── HEARTBEAT (IMPORTANT) ───────────────
function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ─────────────── Start Server ───────────────
const PORT = process.env.PORT || 8080;

connectDB().then(() => {
  loadPendingTimers().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  });
});

server.on('error', (err) => {
  console.error("❌ Server Error:", err);
});

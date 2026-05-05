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
const wss = new WebSocket.Server({ server });

// ─────────────── State ───────────────
const rooms = new Map();   // roomCode -> Set<{ ws, userId, username, avatar }>
const clients = new Map(); // ws -> userId

// ─────────────── Broadcast helper ───────────────
function broadcastToRoom(roomCode, data, exclude = null) {
  const r = rooms.get(roomCode);
  if (!r) return;
  for (const c of r) {
    if (c.ws !== exclude && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify(data));
    }
  }
}

// Make broadcast available to chat handlers
setBroadcast(broadcastToRoom);
// Share rooms reference with voice handlers
setRooms(rooms);

// ─────────────── WebSocket connection ───────────────
wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentUserId = null;
  let currentUsername = null;
  let userAvatar = '';

  // Generate unique userId for this connection (persisted if user previously joined)
  currentUserId = generateId();
  clients.set(ws, currentUserId);

  // Send userId to client
  ws.send(JSON.stringify({ type: 'welcome', userId: currentUserId }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, room, username, ...payload } = msg;

    // ─── JOIN ────────────────────────────
    if (type === 'join') {
      if (!room || !username) return;
      if (currentRoom) leaveRoom(ws, currentRoom, currentUserId, currentUsername);

      // Store / update user profile
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

      // Send joined confirmation with history
      const history = await Message.find({ room, deleted: false })
        .sort({ timestamp: -1 }).limit(100);
      ws.send(JSON.stringify({
        type: 'joined',
        room,
        userId: currentUserId,
        members: Array.from(r).map(c => ({
          userId: c.userId, username: c.username, avatar: c.avatar
        })),
        history: history.reverse().map(m => ({
          type: m.type,
          userId: m.userId,
          username: m.username,
          avatar: m.avatar,
          data: m.text || m.mediaUrl,
          fileName: m.fileName,
          fileSize: m.fileSize,
          timestamp: m.timestamp,
          messageId: m.messageId,
          replyTo: m.replyTo,
          expiresAt: m.expiresAt,
          timer: m.expiresAt ? calcTimerLabel(m.expiresAt) : null,
        })),
      }));

      broadcastToRoom(room, {
        type: 'user_joined',
        userId: currentUserId,
        username,
        avatar: userAvatar,
        members: Array.from(r).map(c => ({
          userId: c.userId, username: c.username, avatar: c.avatar
        })),
      }, ws);
    }

    // ─── PROFILE UPDATE ────────────────
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

    // ─── LEAVE ──────────────────────────
    else if (type === 'leave') {
      leaveRoom(ws, currentRoom, currentUserId, currentUsername);
      currentRoom = null;
      currentUsername = null;
    }

    // ─── MESSAGES ───────────────────────
    else if (['chat', 'voice', 'image', 'file'].includes(type)) {
      if (!currentRoom) return;
      await handleMessage(ws, { ...msg, room: currentRoom, userId: currentUserId, username: currentUsername, avatar: userAvatar });
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

    // ─── VOICE SIGNALING ──────────────
    else if (type?.startsWith('voice_')) {
      if (!currentRoom) return;
      handleVoiceSignaling(ws, { ...msg, room: currentRoom }, currentUserId, currentUsername);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (currentRoom) {
      leaveRoom(ws, currentRoom, currentUserId, currentUsername);
      // Also clean up voice room if needed
      broadcastToRoom(currentRoom, { type: 'voice_user_left', userId: currentUserId });
    }
  });
});

function leaveRoom(ws, room, userId, username) {
  if (!room) return;
  const r = rooms.get(room);
  if (r) {
    for (const c of r) {
      if (c.ws === ws) { r.delete(c); break; }
    }
    if (r.size === 0) rooms.delete(room);
    else {
      broadcastToRoom(room, {
        type: 'user_left',
        userId,
        username,
        members: Array.from(r).map(c => ({
          userId: c.userId, username: c.username, avatar: c.avatar
        })),
      });
    }
  }
}

function calcTimerLabel(expiry) {
  const diff = expiry - new Date();
  const hours = Math.floor(diff / 3600000);
  if (hours <= 24) return '24h';
  if (hours <= 168) return '7d';
  return '30d';
}

// ─────────────── Start server ───────────────
const PORT = process.env.PORT || 8080;

connectDB().then(() => {
  loadPendingTimers().then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Walkie Pro server running on port ${PORT}`);
    });
  });
});
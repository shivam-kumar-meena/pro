const Message = require('../models/Message');
const cloudinary = require('../config/cloudinary');
const { generateId } = require('./utils');

// Upload base64 to Cloudinary
async function uploadToCloudinary(base64Data, resourceType, filename) {
  try {
    const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
    const base64 = matches ? matches[2] : base64Data;
    const mime = matches ? matches[1] : 'application/octet-stream';
    const res = await cloudinary.uploader.upload(`data:${mime};base64,${base64}`, {
      resource_type: resourceType || 'auto',
      public_id: `walkie/${Date.now()}_${filename?.slice(0, 20) || 'file'}`,
    });
    return res.secure_url;
  } catch (err) {
    console.error('Cloudinary upload error:', err);
    throw err;
  }
}

// Calculate expiry date for timer
function calcExpiry(timer) {
  const now = Date.now();
  if (timer === '24h') return new Date(now + 86400000);
  if (timer === '7d') return new Date(now + 604800000);
  if (timer === '30d') return new Date(now + 2592000000);
  return null;
}

// Main message handler
async function handleMessage(ws, data, userId, username, avatar) {
  const { type, room, messageId, fileName, fileSize, timer, replyTo } = data;
  if (!room) return;

  const id = messageId || generateId();
  let expiresAt = calcExpiry(timer);
  let mediaUrl = data.data; // for chat, it's the text; for media it's base64

  if (type !== 'chat') {
    // Validate and upload
    const base64Size = (data.data.length * 3) / 4;
    if (base64Size > 5 * 1024 * 1024)
      return ws.send(JSON.stringify({ type: 'error', data: 'File too large (max 5MB)' }));

    try {
      const mime = data.data.match(/^data:(.+);base64,/)?.[1];
      if (!mime)
        return ws.send(JSON.stringify({ type: 'error', data: 'Invalid base64' }));
      if (type === 'image' && !mime.startsWith('image/'))
        return ws.send(JSON.stringify({ type: 'error', data: 'Invalid image format' }));
      if (type === 'voice' && !mime.startsWith('audio/'))
        return ws.send(JSON.stringify({ type: 'error', data: 'Invalid audio format' }));

      mediaUrl = await uploadToCloudinary(
        data.data,
        type === 'voice' ? 'video' : 'image',
        fileName || 'file'
      );
    } catch (err) {
      return ws.send(JSON.stringify({ type: 'error', data: 'Upload failed' }));
    }
  }

  try {
    const message = await Message.create({
      room,
      userId,
      username,
      avatar,
      type,
      text: type === 'chat' ? data.data : '',
      mediaUrl,
      fileName,
      fileSize,
      messageId: id,
      replyTo,
      expiresAt,
    });

    // Broadcast to room
    broadcastToRoom(room, {
      type,
      userId,
      username,
      avatar,
      data: mediaUrl,
      fileName,
      fileSize,
      timestamp: message.timestamp,
      messageId: id,
      replyTo,
      expiresAt,
      timer,
    });

    // Schedule auto-delete if timer set
    if (expiresAt) {
      scheduleExpiry(room, id, expiresAt);
    }
  } catch (err) {
    console.error('Message save error:', err);
    ws.send(JSON.stringify({ type: 'error', data: 'Database error' }));
  }
}

// Delete message handler
async function handleDelete(ws, data, userId) {
  const { messageId } = data;
  if (!messageId) return;
  await Message.updateOne({ messageId }, { deleted: true });

  // Cancel any pending expiry
  clearExpiryTimer(messageId);

  broadcastToRoom(data.room, { type: 'delete_message', messageId });
}

// Reaction handler
async function handleReaction(ws, data, userId) {
  const { room, messageId, emoji, username } = data;
  broadcastToRoom(room, { type: 'reaction', messageId, emoji, username }, ws);
}

// Typing indicator
function handleTyping(ws, data) {
  broadcastToRoom(data.room, { type: 'typing', username: data.username, isTyping: data.isTyping }, ws);
}

// ─── Expiry scheduling (global map) ───
const expiryTimers = new Map();
const roomForMsg = new Map();   // messageId -> room

function scheduleExpiry(room, messageId, expiresAt) {
  const delay = expiresAt.getTime() - Date.now();
  if (delay <= 0) return;

  if (expiryTimers.has(messageId)) clearTimeout(expiryTimers.get(messageId));

  const timer = setTimeout(async () => {
    await Message.updateOne({ messageId }, { deleted: true });
    broadcastToRoom(room, { type: 'delete_message', messageId });
    expiryTimers.delete(messageId);
    roomForMsg.delete(messageId);
  }, delay);

  expiryTimers.set(messageId, timer);
  roomForMsg.set(messageId, room);
}

function clearExpiryTimer(messageId) {
  if (expiryTimers.has(messageId)) {
    clearTimeout(expiryTimers.get(messageId));
    expiryTimers.delete(messageId);
  }
  roomForMsg.delete(messageId);
}

// Load pending timers on startup
async function loadPendingTimers() {
  const pending = await Message.find({ deleted: false, expiresAt: { $gt: new Date() } });
  pending.forEach(msg => {
    scheduleExpiry(msg.room, msg.messageId, msg.expiresAt);
  });
}

// Broadcast helper – defined in main server, referenced here
let broadcastToRoom;
function setBroadcast(fn) {
  broadcastToRoom = fn;
}

module.exports = {
  handleMessage,
  handleDelete,
  handleReaction,
  handleTyping,
  setBroadcast,
  loadPendingTimers,
};
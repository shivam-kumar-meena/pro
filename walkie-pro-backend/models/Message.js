const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  userId: String,
  username: String,
  avatar: String,
  type: { type: String, enum: ['chat', 'voice', 'image', 'file'] },
  text: String,        // used for chat messages
  mediaUrl: String,    // Cloudinary URL
  fileName: String,
  fileSize: Number,
  timestamp: { type: Date, default: Date.now },
  expiresAt: Date,
  messageId: { type: String, unique: true, required: true },
  replyTo: {
    messageId: String,
    username: String,
    text: String,
  },
  deleted: { type: Boolean, default: false },
});

messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Message', messageSchema);
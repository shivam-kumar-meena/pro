const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  roomCode: { type: String, unique: true },
  members: [String],   // userIds
});

module.exports = mongoose.model('Room', roomSchema);
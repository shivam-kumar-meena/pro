const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: String,
  name: String,
  avatar: String,   // base64 or URL
});

module.exports = mongoose.model('User', userSchema);
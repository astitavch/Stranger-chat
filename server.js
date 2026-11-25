const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MONGODB SETUP ---
const MONGO_URI = process.env.MONGO_URI || '';
let isDbConnected = false;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => {
      isDbConnected = true;
      console.log('✅ MongoDB Connected');
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
} else {
  console.warn('⚠️ MONGO_URI not set. Running without database persistence.');
}

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const SuggestionSchema = new mongoose.Schema({
  socketId: String,
  username: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});

const ReportSchema = new mongoose.Schema({
  reporterName: String,
  reportedName: String,
  roomType: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Suggestion = mongoose.model('Suggestion', SuggestionSchema);
const Report = mongoose.model('Report', ReportSchema);

// --- MODERATION ---
const badWords = [
  'sex', 'nude', 'nudes', 'porn', 'vulgar',
  'fuck', 'shit', 'dick', 'pussy', 'boobs',
  'lund', 'chut', 'choot', 'gand', 'fuddi', 'mc', 'bc'
];

function containsBadWord(message) {
  const lowerMsg = message.toLowerCase();
  return badWords.some(word => lowerMsg.includes(word));
}

app.use(express.static('public'));

let waitingUsers = [];
const warnings = {};
const privateRooms = new Map(); // roomCode -> { host: socket, guest: socket | null }

function broadcastOnlineCount() {
  io.emit('onlineCount', { count: io.engine.clientsCount });
}

function leaveCurrentChat(socket, notifyPartner = true) {
  if (socket.privateRoomCode) {
    const code = socket.privateRoomCode;
    if (privateRooms.has(code)) {
      privateRooms.delete(code);
    }
    socket.leave(code);
    socket.privateRoomCode = null;
  }

  if (socket.partner) {
    const partner = socket.partner;
    if (notifyPartner) {
      partner.emit('strangerLeft', {
        message: '👋 Stranger left.',
        strangerName: socket.username
      });
    }
    partner.partner = null;
    if (partner.room) {
      partner.leave(partner.room);
      partner.room = null;
    }
    partner.privateRoomCode = null;
  }

  if (socket.room) {
    socket.leave(socket.room);
    socket.room = null;
  }
  socket.partner = null;
}

function matchUsers(socket) {
  waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

  const interests = socket.interests || [];
  let matchIndex = -1;

  if (interests.length > 0) {
    matchIndex = waitingUsers.findIndex(u =>
      u.id !== socket.id &&
      u.interests && u.interests.some(i => interests.includes(i))
    );
  }

  if (matchIndex === -1 && waitingUsers.length > 0) {
    matchIndex = waitingUsers.findIndex(u => u.id !== socket.id);
  }

  if (matchIndex !== -1) {
    const partner = waitingUsers.splice(matchIndex, 1)[0];
    const room = socket.id + '#' + partner.id;

    socket.join(room);
    partner.join(room);

    socket.room = room;
    partner.room = room;
    socket.partner = partner;
    partner.partner = socket;

    const commonInterests = interests.filter(i => partner.interests && partner.interests.includes(i));

    socket.emit('matched', {
      message: '✅ Stranger found! Say hello 👋',
      strangerName: partner.username || 'Anonymous',
      strangerInterests: partner.interests || [],
      commonInterests,
      isPrivate: false
    });

    partner.emit('matched', {
      message: '✅ Stranger found! Say hello 👋',
      strangerName: socket.username || 'Anonymous',
      strangerInterests: socket.interests || [],
      commonInterests,
      isPrivate: false
    });
  } else {
    waitingUsers.push(socket);
    socket.emit('waiting', { message: '🔍 Looking for a stranger...' });
  }
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  warnings[socket.id] = 0;
  broadcastOnlineCount();

  // --- AUTH: REGISTER ---
  socket.on('register', async ({ username, password }) => {
    if (!isDbConnected) {
      return socket.emit('authError', { message: 'Database not connected yet.' });
    }
    const cleanUser = (username || '').trim();
    if (!cleanUser || !password || password.length < 4) {
      return socket.emit('authError', { message: 'Enter username & password (min 4 chars).' });
    }
    try {
      const existing = await User.findOne({ username: cleanUser });
      if (existing) {
        return socket.emit('authError', { message: 'Username already taken. Click Login instead.' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await User.create({ username: cleanUser, passwordHash });
      socket.username = cleanUser;
      socket.emit('authSuccess', { username: cleanUser, message: 'Account created!' });
    } catch (err) {
      console.error('Register error:', err);
      socket.emit('authError', { message: 'Registration failed. Try again.' });
    }
  });

  // --- AUTH: LOGIN ---
  socket.on('login', async ({ username, password }) => {
    if (!isDbConnected) {
      return socket.emit('authError', { message: 'Database not connected yet.' });
    }
    const cleanUser = (username || '').trim();
    if (!cleanUser || !password) {
      return socket.emit('authError', { message: 'Enter both username and password.' });
    }
    try {
      const user = await User.findOne({ username: cleanUser });
      if (!user) {
        return socket.emit('authError', { message: 'Account not found. Click Register first.' });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return socket.emit('authError', { message: 'Incorrect password.' });
      }
      socket.username = user.username;
      socket.emit('authSuccess', { username: user.username, message: 'Logged in!' });
    } catch (err) {
      console.error('Login error:', err);
      socket.emit('authError', { message: 'Login failed. Try again.' });
    }
  });

  // --- RANDOM QUEUE JOIN ---
  socket.on('join', (data) => {
    leaveCurrentChat(socket, false);
    socket.username = data.username || socket.username || 'Anonymous';
    socket.interests = data.interests || [];
    matchUsers(socket);
  });

  // --- CREATE PRIVATE ROOM ---
  socket.on('createPrivateRoom', (data) => {
    leaveCurrentChat(socket, false);
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

    socket.username = data?.username || socket.username || 'Anonymous';
    socket.interests = data?.interests || [];

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    privateRooms.set(code, { host: socket, guest: null });
    socket.join(code);
    socket.room = code;
    socket.privateRoomCode = code;

    socket.emit('privateRoomCreated', {
      roomCode: code,
      message: `🔒 Private room created! Share code ${code} with your friend.`
    });
  });

  // --- JOIN PRIVATE ROOM ---
  socket.on('joinPrivateRoom', (data) => {
    const code = (data?.roomCode || '').trim().toUpperCase();
    if (!code || !privateRooms.has(code)) {
      socket.emit('roomError', { message: '❌ Invalid or expired room code.' });
      return;
    }

    const roomData = privateRooms.get(code);
    if (roomData.guest) {
      socket.emit('roomError', { message: '❌ This private room is already full.' });
      return;
    }

    leaveCurrentChat(socket, false);
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

    socket.username = data?.username || socket.username || 'Anonymous';
    socket.interests = data?.interests || [];

    const host = roomData.host;
    roomData.guest = socket;

    socket.join(code);
    socket.room = code;
    socket.privateRoomCode = code;
    socket.partner = host;
    host.partner = socket;

    const commonInterests = (socket.interests || []).filter(i => (host.interests || []).includes(i));

    socket.emit('matched', {
      message: `🔒 Connected to Private Room (${code})!`,
      strangerName: host.username || 'Anonymous',
      strangerInterests: host.interests || [],
      commonInterests,
      isPrivate: true,
      roomCode: code
    });

    host.emit('matched', {
      message: `🔒 Friend joined Private Room (${code})!`,
      strangerName: socket.username || 'Anonymous',
      strangerInterests: socket.interests || [],
      commonInterests,
      isPrivate: true,
      roomCode: code
    });
  });

  // --- MESSAGING ---
  socket.on('message', (data) => {
    if (containsBadWord(data.text)) {
      warnings[socket.id]++;
      socket.emit('warning', {
        message: `⚠️ Warning ${warnings[socket.id]}/3: Vulgar language not allowed!`
      });
      if (warnings[socket.id] >= 3) {
        socket.emit('banned', { message: '🚫 Disconnected for violating rules!' });
        socket.disconnect();
      }
      return;
    }
    if (socket.room) {
      socket.to(socket.room).emit('message', { text: data.text });
    }
  });

  // --- TYPING INDICATORS ---
  socket.on('typing', () => {
    if (socket.room) {
      socket.to(socket.room).emit('typing');
    }
  });

  socket.on('stopTyping', () => {
    if (socket.room) {
      socket.to(socket.room).emit('stopTyping');
    }
  });

  // --- REPORT -> MONGODB ---
  socket.on('report', async () => {
    if (socket.partner) {
      warnings[socket.partner.id] = (warnings[socket.partner.id] || 0) + 2;
      socket.emit('reported', { message: '🚩 Stranger reported!' });

      if (isDbConnected) {
        try {
          await Report.create({
            reporterName: socket.username || 'Anonymous',
            reportedName: socket.partner.username || 'Anonymous',
            roomType: socket.privateRoomCode ? 'private' : 'random'
          });
        } catch (err) {
          console.error('Failed to save report to MongoDB:', err);
        }
      }
    }
  });

  // --- SUGGESTION BOX -> MONGODB ---
  socket.on('suggestion', async (data) => {
    const text = (data && data.text ? String(data.text) : '').trim().slice(0, 500);
    if (!text) return;

    const username = (data && data.username) || socket.username || 'Anonymous';
    console.log('💡 New suggestion from', username, ':', text);

    if (isDbConnected) {
      try {
        await Suggestion.create({ socketId: socket.id, username, text });
      } catch (err) {
        console.error('Failed to save suggestion to MongoDB:', err);
      }
    }

    socket.emit('suggestionReceived', { message: 'Saved to database! Thanks!' });
  });

  // --- SKIP / NEXT ---
  socket.on('next', () => {
    const wasPrivate = Boolean(socket.privateRoomCode);
    const oldPartner = socket.partner;

    leaveCurrentChat(socket, true);

    if (oldPartner && !wasPrivate) {
      matchUsers(oldPartner);
    }

    matchUsers(socket);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete warnings[socket.id];

    const wasPrivate = Boolean(socket.privateRoomCode);
    const oldPartner = socket.partner;

    leaveCurrentChat(socket, true);
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

    if (oldPartner && !wasPrivate) {
      matchUsers(oldPartner);
    }

    broadcastOnlineCount();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
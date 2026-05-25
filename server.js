const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ──────────────────────────────
//  Data directories & files
// ──────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_DIR = path.join(__dirname, 'database');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PINS_FILE = path.join(DB_DIR, 'pins.json');
const SESSIONS_FILE = path.join(DB_DIR, 'sessions.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(DB_DIR);

// ──────────────────────────────
//  Helpers
// ──────────────────────────────
function readJson(file, defaultVal = []) {
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return defaultVal;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ──────────────────────────────
//  File storage for profile pics
// ──────────────────────────────
const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/profiles';
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const uploadProfile = multer({ storage: profileStorage });

// ──────────────────────────────
//  File storage for books (PDF)
// ──────────────────────────────
const bookStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/books';
    ensureDir(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `temp-${Date.now()}.pdf`);
  }
});
const uploadBook = multer({
  storage: bookStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'), false);
  }
});

// ──────────────────────────────
//  API: Generate PIN (Admin)
// ──────────────────────────────
app.post('/api/admin/generate-pin', (req, res) => {
  try {
    const pins = readJson(PINS_FILE);
    let pin;
    let attempts = 0;
    do {
      pin = generatePin();
      attempts++;
    } while (pins.some(p => p.pin === pin) && attempts < 100);
    
    if (attempts >= 100) return res.status(500).json({ success: false, message: 'Could not generate unique PIN' });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const pinRecord = {
      pin,
      used: false,
      deviceId: null,
      username: null,
      email: null,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      attempts: 0,
      lockedUntil: null
    };

    pins.push(pinRecord);
    writeJson(PINS_FILE, pins);

    res.json({ success: true, pin, expiresAt: pinRecord.expiresAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Get all PINs (Admin)
// ──────────────────────────────
app.get('/api/admin/pins', (req, res) => {
  try {
    const pins = readJson(PINS_FILE);
    res.json(pins);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Reset Device (Admin)
// ──────────────────────────────
app.post('/api/admin/reset-device', (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ success: false, message: 'PIN required' });

    const pins = readJson(PINS_FILE);
    const pinIndex = pins.findIndex(p => p.pin === pin);
    if (pinIndex === -1) return res.status(404).json({ success: false, message: 'PIN not found' });

    pins[pinIndex].deviceId = null;
    pins[pinIndex].used = false;
    pins[pinIndex].username = null;
    pins[pinIndex].email = null;
    pins[pinIndex].attempts = 0;
    pins[pinIndex].lockedUntil = null;
    
    writeJson(PINS_FILE, pins);
    res.json({ success: true, message: 'Device reset successfully. PIN is now available for reuse.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Verify PIN
// ──────────────────────────────
app.post('/api/verify-pin', (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid 6-digit PIN' });
    }

    const pins = readJson(PINS_FILE);
    const pinRecord = pins.find(p => p.pin === pin);

    if (!pinRecord) {
      return res.json({ success: false, message: 'Incorrect PIN. Please contact admin to get your access PIN.' });
    }

    if (pinRecord.lockedUntil && new Date(pinRecord.lockedUntil) > new Date()) {
      const waitSeconds = Math.ceil((new Date(pinRecord.lockedUntil) - new Date()) / 1000);
      return res.status(429).json({ success: false, message: `PIN locked. Please wait ${waitSeconds}s before trying again.` });
    }

    if (pinRecord.expiresAt && new Date(pinRecord.expiresAt) < new Date()) {
      return res.json({ success: false, message: 'This PIN has expired. Please contact admin for a new PIN.' });
    }

    if (pinRecord.used) {
      return res.json({ success: false, message: 'This PIN has already been used. Please contact admin to reset your device or get a new PIN.' });
    }

    pinRecord.attempts = 0;
    writeJson(PINS_FILE, pins);

    res.json({ success: true, message: 'PIN verified successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Register (with PIN & device lock)
// ──────────────────────────────
app.post('/api/register', uploadProfile.single('profilePic'), (req, res) => {
  try {
    const { fullName, phoneNumber, age, classLevel, schoolName, location, pin, username, email, deviceInfo } = req.body;
    
    if (!fullName || !phoneNumber || !age || !classLevel || !schoolName || !location || !pin || !username || !email || !deviceInfo) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const pins = readJson(PINS_FILE);
    const pinIndex = pins.findIndex(p => p.pin === pin);
    if (pinIndex === -1) {
      return res.status(400).json({ success: false, message: 'Invalid PIN. Please contact admin to get your access PIN.' });
    }

    const pinRecord = pins[pinIndex];
    if (pinRecord.used) {
      return res.status(400).json({ success: false, message: 'PIN already used. Contact admin for device reset.' });
    }
    if (pinRecord.expiresAt && new Date(pinRecord.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, message: 'PIN expired.' });
    }

    const users = readJson(USERS_FILE);
    if (users.some(u => u.username === username)) {
      return res.status(400).json({ success: false, message: 'Username already taken.' });
    }
    if (users.some(u => u.email === email)) {
      return res.status(400).json({ success: false, message: 'Email already registered.' });
    }
    if (users.some(u => u.deviceId === deviceInfo)) {
      return res.status(400).json({ success: false, message: 'This device is already registered. Please contact admin.' });
    }

    const userId = uuidv4();
    const profilePic = req.file ? `/uploads/profiles/${req.file.filename}` : null;

    const newUser = {
      id: userId,
      fullName,
      phoneNumber,
      age,
      classLevel,
      schoolName,
      location,
      profilePic,
      username,
      email,
      pin,
      deviceId: deviceInfo,
      book: null,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    writeJson(USERS_FILE, users);

    pins[pinIndex].used = true;
    pins[pinIndex].deviceId = deviceInfo;
    pins[pinIndex].username = username;
    pins[pinIndex].email = email;
    writeJson(PINS_FILE, pins);

    const token = generateToken();
    const sessions = readJson(SESSIONS_FILE);
    sessions.push({
      token,
      userId,
      username,
      createdAt: new Date().toISOString()
    });
    writeJson(SESSIONS_FILE, sessions);

    res.json({ success: true, userId, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Login
// ──────────────────────────────
app.post('/api/login', (req, res) => {
  try {
    const { username, email, pin, deviceInfo } = req.body;
    if (!pin || !deviceInfo || (!username && !email)) {
      return res.status(400).json({ success: false, message: 'Username/Email, PIN and device info are required' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => {
      const matchUser = username ? u.username === username : true;
      const matchEmail = email ? u.email === email : true;
      return matchUser && matchEmail;
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.pin !== pin) {
      return res.status(400).json({ success: false, message: 'Incorrect PIN. Please contact admin to get your access PIN.' });
    }

    if (user.deviceId !== deviceInfo) {
      return res.status(403).json({ success: false, message: 'Device mismatch. This PIN is locked to another device. Please contact admin for a device reset.' });
    }

    const token = generateToken();
    const sessions = readJson(SESSIONS_FILE);
    sessions.push({
      token,
      userId: user.id,
      username: user.username,
      createdAt: new Date().toISOString()
    });
    writeJson(SESSIONS_FILE, sessions);

    res.json({ success: true, token, userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Verify Session
// ──────────────────────────────
app.get('/api/session', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.slice(7);
    const sessions = readJson(SESSIONS_FILE);
    const session = sessions.find(s => s.token === token);

    if (!session) {
      return res.status(401).json({ success: false, message: 'Invalid session' });
    }

    const users = readJson(USERS_FILE);
    const user = users.find(u => u.id === session.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, user: { id: user.id, fullName: user.fullName, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ──────────────────────────────
//  API: Upload Book (PDF) — requires session
// ──────────────────────────────
app.post('/api/upload/:userId', uploadBook.single('bookPdf'), (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const token = authHeader.slice(7);
    const sessions = readJson(SESSIONS_FILE);
    const session = sessions.find(s => s.token === token);
    if (!session) {
      return res.status(401).json({ success: false, message: 'Invalid session' });
    }

    const { userId } = req.params;
    if (session.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Session does not match user' });
    }

    const { bookTitle } = req.body;
    const users = readJson(USERS_FILE);
    const userIndex = users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!bookTitle || !req.file) {
      return res.status(400).json({ success: false, message: 'Book title and PDF are required' });
    }

    const studentName = users[userIndex].fullName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const safeBookTitle = bookTitle.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
    const ext = path.extname(req.file.filename);
    const newFilename = `${studentName}-${safeBookTitle}${ext}`;
    const newPath = path.join('uploads', 'books', newFilename);

    fs.renameSync(req.file.path, newPath);

    users[userIndex].book = {
      title: bookTitle,
      pdfPath: `/uploads/books/${newFilename}`,
      originalName: req.file.originalname
    };
    writeJson(USERS_FILE, users);

    res.json({ success: true, pdfPath: `/uploads/books/${newFilename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ──────────────────────────────
//  API: Get all users (for admin)
// ──────────────────────────────
app.get('/api/users', (req, res) => {
  const users = readJson(USERS_FILE);
  res.json(users);
});

// ──────────────────────────────
//  Start server
// ──────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

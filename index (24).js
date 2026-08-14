const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const chalk = require('chalk');

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 21158;

// Server start time for uptime tracking
const SERVER_START_TIME = Date.now();

// Reconnect config
const RECONNECT_MAX = 6;
const RECONNECT_DELAY_MS = 4000; // 4 seconds
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Prune config
const MAX_PREKEY_FILES = parseInt(process.env.MAX_PREKEY_FILES || '20', 10);
const MAX_SENDER_KEY_FILES = parseInt(process.env.MAX_SENDER_KEY_FILES || '5', 10);
const MAX_SESSION_FILES = parseInt(process.env.MAX_SESSION_FILES || '10', 10);
const PRUNE_DEBOUNCE_MS = parseInt(process.env.PRUNE_DEBOUNCE_MS || '2000', 10);
const GLOBAL_PRUNE_INTERVAL_MS = parseInt(process.env.GLOBAL_PRUNE_INTERVAL_MS || (60 * 60 * 1000).toString(), 10);

// Directories
const uploadsDir = path.join(process.cwd(), 'uploads');
const sessionsRoot = path.join(process.cwd(), 'uploaded_sessions');
const usersFilePath = path.join(process.cwd(), 'users.json');
const approvalFilePath = path.join(process.cwd(), 'approval.txt');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsRoot)) fs.mkdirSync(sessionsRoot, { recursive: true });

// Initialize approval file if not exists
if (!fs.existsSync(approvalFilePath)) {
  fs.writeFileSync(approvalFilePath, '', 'utf8');
  console.log(chalk.yellow('✓ approval.txt file created'));
}

// Initialize users file with admin
function initializeUsers() {
  if (!fs.existsSync(usersFilePath)) {
    const users = {
      admin: {
        username: 'WALEED khan',
        password: hashPassword('WALEED khan786'),
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
    console.log(chalk.green('✓ Admin user created: WALEED KHAN / WALEED KHAN786'));
  }
}

// Password hashing
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Load users from file
function loadUsers() {
  try {
    if (fs.existsSync(usersFilePath)) {
      return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
    }
  } catch (e) {
    logger.error('Failed to load users', e?.message || e);
  }
  return {};
}

// Save users to file
function saveUsers(users) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    logger.error('Failed to save users', e?.message || e);
  }
}

// Load approved keys from approval.txt
function loadApprovedKeys() {
  try {
    if (fs.existsSync(approvalFilePath)) {
      const content = fs.readFileSync(approvalFilePath, 'utf8');
      return content.split('\n').map(line => line.trim()).filter(Boolean);
    }
  } catch (e) {
    logger.error('Failed to load approval keys', e?.message || e);
  }
  return [];
}

// Check if key is approved
function isKeyApproved(key) {
  const approvedKeys = loadApprovedKeys();
  return approvedKeys.includes(key);
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + file.originalname.replace(/\s+/g, ''))
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const SESSIONS = Object.create(null); // sessionId -> session object
const CREDS_HASH_TO_SESSION = Object.create(null); // credsHash -> sessionId

// Watcher bookkeeping
const DIR_WATCHERS = Object.create(null);

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeSessionId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function makeSessionDir(sessionId) {
  const dir = path.join(sessionsRoot, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Logging with colors
function appendSessionLog(sessionId, rawMsg) {
  const time = new Date().toISOString();
  const msg = String(rawMsg || '');
  const s = SESSIONS[sessionId];

  if (s) {
    s.logs = s.logs || [];
    s.logs.push({ time, msg });
    if (s.logs.length > 1000) s.logs = s.logs.slice(-1000);
  }

  const lower = msg.toLowerCase();
  let kind = 'other';
  if (/(\bsent\b|\bsuccessful\b|\bsuccess\b|\breconnect successful\b|\bstarted\b|\bopen\b|\bcreated\b|\bstarted loop\b)/.test(lower)) {
    kind = 'success';
  } else if (/(\berror\b|\bfailed\b|\bdeleted\b|\blogged out\b|\binvalid\b|\bunauthorized\b|\b401\b|\bdisconnect\b|\bclose\b|\bfailed to\b|\bexpired\b|\bremoved\b)/.test(lower)) {
    kind = 'error';
  } else {
    kind = 'other';
  }

  const timeStr = chalk.yellow(`[${time}]`);
  let symbol = 'i';
  let symbolColored = chalk.cyan(`[${symbol}]`);
  let messageColored = chalk.cyan(msg);

  if (kind === 'success') {
    symbol = '✓';
    symbolColored = chalk.greenBright(`[${symbol}]`);
    messageColored = chalk.green(msg);
  } else if (kind === 'error') {
    symbol = '✗';
    symbolColored = chalk.redBright(`[${symbol}]`);
    messageColored = chalk.red(msg);
  } else {
    symbol = 'i';
    symbolColored = chalk.cyan(`[${symbol}]`);
    messageColored = chalk.cyan(msg);
  }

  const sessionIdStr = sessionId ? chalk.magenta(`[${sessionId}]`) : '';
  const line = `${timeStr} ${symbolColored} ${messageColored} ${sessionIdStr}`;
  console.log(line);
  console.log(chalk.gray('─'.repeat(80)));

  logger.info({ sessionId, kind, time }, msg);
}

// Session metadata save
function persistSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  try {
    const sessionMeta = {
      sessionId: s.sessionId,
      username: s.username,
      contacts: s.contacts,
      messages: s.messages,
      prefixName: s.prefixName,
      delayMs: s.delayMs,
      target: s.target,
      groupId: s.groupId,
      sessionType: s.sessionType || 'message',
      mediaFiles: (s.mediaFiles || []).map(p => path.basename(p)),
      createdAt: s.createdAt || new Date().toISOString(),
      credsHash: s.credsHash || null,
      stopped: s.stopped || false
    };
    fs.writeFileSync(path.join(s.sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');
    fs.writeFileSync(path.join(s.sessionDir, 'messages.txt'), (s.messages || []).join('\n'), 'utf8');
  } catch (e) {
    appendSessionLog(sessionId, 'persistSessionFiles error: ' + (e?.message || e));
  }
}

// Enhanced prune helper
function pruneAuthFiles(sessionDir, sessionId = null) {
  try {
    const PROTECTED_FILES = ['session.json', 'messages.txt', 'creds.json'];

    const patterns = [
      { regex: /^pre-?key.*\.json$/i, max: MAX_PREKEY_FILES, name: 'pre-key' },
      { regex: /^prekeys.*\.json$/i, max: MAX_PREKEY_FILES, name: 'prekeys' },
      { regex: /^signedprekey.*\.json$/i, max: MAX_PREKEY_FILES, name: 'signedprekey' },
      { regex: /^sender-key-.*\.json$/i, max: MAX_SENDER_KEY_FILES, name: 'sender-key' },
      { regex: /^session-[0-9]+.*\.json$/i, max: MAX_SESSION_FILES, name: 'session-numbered' },
      { regex: /^key-.*\.json$/i, max: MAX_PREKEY_FILES, name: 'key' }
    ];

    const files = fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter(f => f.isFile())
      .map(f => f.name)
      .filter(fname => !PROTECTED_FILES.includes(fname));

    let totalRemoved = 0;
    const stats = {};

    for (const pattern of patterns) {
      let candidates = [];

      for (const fname of files) {
        if (pattern.regex.test(fname)) {
          const full = path.join(sessionDir, fname);
          let stat;
          try { stat = fs.statSync(full); } catch (e) { stat = null; }
          candidates.push({ name: fname, full, mtime: stat ? stat.mtimeMs : 0 });
        }
      }

      if (!candidates.length) continue;

      candidates.sort((a, b) => b.mtime - a.mtime);
      const toRemove = candidates.slice(pattern.max);

      if (!toRemove.length) continue;

      let removedCount = 0;
      for (const rem of toRemove) {
        try {
          fs.rmSync(rem.full, { force: true });
          removedCount++;
        } catch (e) {}
      }

      if (removedCount > 0) {
        stats[pattern.name] = removedCount;
        totalRemoved += removedCount;
      }
    }

    // Check keys subdirectory
    const keysDir = path.join(sessionDir, 'keys');
    if (fs.existsSync(keysDir) && fs.statSync(keysDir).isDirectory()) {
      const kfiles = fs.readdirSync(keysDir, { withFileTypes: true })
        .filter(f => f.isFile())
        .map(f => f.name);

      for (const pattern of patterns) {
        let candidates = [];

        for (const kf of kfiles) {
          if (pattern.regex.test(kf)) {
            const full = path.join(keysDir, kf);
            let stat;
            try { stat = fs.statSync(full); } catch (e) { stat = null; }
            candidates.push({ name: path.join('keys', kf), full, mtime: stat ? stat.mtimeMs : 0 });
          }
        }

        if (!candidates.length) continue;

        candidates.sort((a, b) => b.mtime - a.mtime);
        const toRemove = candidates.slice(pattern.max);

        if (!toRemove.length) continue;

        let removedCount = 0;
        for (const rem of toRemove) {
          try {
            fs.rmSync(rem.full, { force: true });
            removedCount++;
          } catch (e) {}
        }

        if (removedCount > 0) {
          const key = `keys/${pattern.name}`;
          stats[key] = (stats[key] || 0) + removedCount;
          totalRemoved += removedCount;
        }
      }
    }

    if (totalRemoved > 0 && sessionId) {
      const summary = Object.entries(stats).map(([type, count]) => `${count} ${type}`).join(', ');
      appendSessionLog(sessionId, `🧹 Cleaned up: ${summary} files`);
    }

    return totalRemoved;
  } catch (e) {
    return 0;
  }
}

// Start file-system watchers
function startSessionWatch(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  const sessionDir = s.sessionDir;
  if (!sessionDir || !fs.existsSync(sessionDir)) return;

  if (DIR_WATCHERS[sessionId]) return;

  const watchers = { dirWatcher: null, keysWatcher: null, debounceTimer: null };

  const schedulePrune = () => {
    if (watchers.debounceTimer) clearTimeout(watchers.debounceTimer);
    watchers.debounceTimer = setTimeout(() => {
      try {
        const removed = pruneAuthFiles(sessionDir, sessionId);
        if (removed && removed > 0) {
          logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files after fs event');
        }
      } catch (e) {}
      watchers.debounceTimer = null;
    }, PRUNE_DEBOUNCE_MS);
  };

  try {
    watchers.dirWatcher = fs.watch(sessionDir, (eventType, filename) => {
      if (!filename) return;
      // Ignore changes inside media/ subfolder
      if (String(filename).startsWith('media')) return;
      schedulePrune();
    });
  } catch (e) {}

  try {
    const keysDir = path.join(sessionDir, 'keys');
    if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });
    watchers.keysWatcher = fs.watch(keysDir, (eventType, filename) => {
      if (!filename) return;
      schedulePrune();
    });
  } catch (e) {}

  DIR_WATCHERS[sessionId] = watchers;
}

// Stop watchers
function stopSessionWatch(sessionId) {
  const w = DIR_WATCHERS[sessionId];
  if (!w) return;
  try { if (w.dirWatcher) w.dirWatcher.close(); } catch (e) {}
  try { if (w.keysWatcher) w.keysWatcher.close(); } catch (e) {}
  try { if (w.debounceTimer) clearTimeout(w.debounceTimer); } catch (e) {}
  delete DIR_WATCHERS[sessionId];
}

// Complete session cleanup (delete all files and folder)
function completeSessionCleanup(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;

  try {
    appendSessionLog(sessionId, '🗑️ Complete cleanup: removing session folder');

    // Stop watchers first
    stopSessionWatch(sessionId);

    // Remove entire session directory
    if (fs.existsSync(s.sessionDir)) {
      fs.rmSync(s.sessionDir, { recursive: true, force: true });
      appendSessionLog(sessionId, '✅ Session folder completely removed');
    }

    // Remove from memory
    if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) {
      delete CREDS_HASH_TO_SESSION[s.credsHash];
    }
    delete SESSIONS[sessionId];

  } catch (e) {
    appendSessionLog(sessionId, '❌ Cleanup error: ' + (e?.message || e));
  }
}

// Cleanup session files (keeps session.json, messages.txt, creds.json)
function cleanupSessionFiles(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;

  const PROTECTED_FILES = ['session.json', 'messages.txt', 'creds.json'];
  let deletedCount = 0;

  try {
    appendSessionLog(sessionId, '🗑️ Starting cleanup of session files...');

    const files = fs.readdirSync(s.sessionDir, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && !PROTECTED_FILES.includes(file.name)) {
        try {
          fs.unlinkSync(path.join(s.sessionDir, file.name));
          deletedCount++;
        } catch (e) {}
      }
    }

    const keysDir = path.join(s.sessionDir, 'keys');
    if (fs.existsSync(keysDir)) {
      try {
        fs.rmSync(keysDir, { recursive: true, force: true });
        appendSessionLog(sessionId, '✅ Deleted keys/ subdirectory');
      } catch (e) {}
    }

    // Also delete media/ subdirectory (images/stickers)
    const mediaDir = path.join(s.sessionDir, 'media');
    if (fs.existsSync(mediaDir)) {
      try {
        fs.rmSync(mediaDir, { recursive: true, force: true });
        appendSessionLog(sessionId, '✅ Deleted media/ subdirectory');
      } catch (e) {}
    }

    appendSessionLog(sessionId, `✅ Cleanup complete: ${deletedCount} files deleted, protected files preserved`);
  } catch (e) {
    appendSessionLog(sessionId, '❌ Cleanup error: ' + (e?.message || e));
  }
}

// Check if credentials are invalid/logged out/expired - FIXED VERSION
function isLoggedOutUpdate(update) {
  const last = update?.lastDisconnect;
  if (!last) return false;

  const error = last.error;
  const statusCode = error?.output?.statusCode;
  const msg = (error && (error.message || String(error))) || String(error || '');

  if (!msg && !statusCode) return false;

  const lower = msg.toLowerCase();

  const actualLoggedOutPatterns = [
    'logged out',
    'logged-out',
    'device not found',
    'invalid mac',
    'qr refs attempts ended',
    'restart required'
  ];

  if (statusCode === 401 || statusCode === 403) {
    appendSessionLog(null, `Detected auth failure with status code: ${statusCode}`);
    return true;
  }

  for (const pattern of actualLoggedOutPatterns) {
    if (lower.includes(pattern)) {
      appendSessionLog(null, `Detected logged out pattern: "${pattern}" in message: "${msg}"`);
      return true;
    }
  }

  return false;
}

// Check if creds are actually logged in to WhatsApp
async function checkIfLoggedIn(sock, sessionId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timeout: Failed to verify login status'));
      }
    }, timeoutMs);

    const connectionHandler = (update) => {
      if (resolved) return;

      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          sock.ev.off('connection.update', connectionHandler);
          resolve(true);
        }
        return;
      }

      if (connection === 'close') {
        if (isLoggedOutUpdate(update)) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            sock.ev.off('connection.update', connectionHandler);
            const errorMsg = lastDisconnect?.error?.message || 'Credentials expired or logged out';
            reject(new Error(errorMsg));
          }
        }
      }
    };

    sock.ev.on('connection.update', connectionHandler);
  });
}

// Validate creds.json structure
function validateCredsJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);

    if (!json.noiseKey || !json.signedIdentityKey || !json.signedPreKey) {
      return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

// Helper: rebuild full media file paths from session dir
function loadMediaFiles(sessionDir) {
  const mediaDir = path.join(sessionDir, 'media');
  if (!fs.existsSync(mediaDir)) return [];
  try {
    return fs.readdirSync(mediaDir)
      .filter(f => !f.startsWith('.'))
      .map(f => path.join(mediaDir, f))
      .filter(f => {
        try { return fs.statSync(f).isFile(); } catch (e) { return false; }
      })
      .sort();
  } catch (e) {
    return [];
  }
}

// Restart a session
async function restartSession(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) {
    appendSessionLog(sessionId, 'restartSession: no in-memory session found');
    return;
  }

  if (s.stopped) {
    appendSessionLog(sessionId, 'Session was manually stopped - will not restart');
    return;
  }

  const dir = s.sessionDir;
  if (!dir || !fs.existsSync(dir)) {
    appendSessionLog(sessionId, 'restartSession: session folder missing, cannot restart');
    return;
  }

  appendSessionLog(sessionId, 'Restarting session from disk: ' + dir);

  try {
    const sessionJsonPath = path.join(dir, 'session.json');
    if (fs.existsSync(sessionJsonPath)) {
      const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
      s.contacts = meta.contacts || s.contacts;
      s.messages = meta.messages || s.messages;
      s.prefixName = meta.prefixName || s.prefixName || 'Bot';
      s.delayMs = meta.delayMs || s.delayMs || 5000;
      s.target = meta.target || s.target;
      s.groupId = meta.groupId || s.groupId;
      s.createdAt = meta.createdAt || s.createdAt;
      s.credsHash = meta.credsHash || s.credsHash;
      s.username = meta.username || s.username;
      s.stopped = meta.stopped || false;
      s.sessionType = meta.sessionType || s.sessionType || 'message';
      s.mediaFiles = loadMediaFiles(dir);
      if (s.credsHash) CREDS_HASH_TO_SESSION[s.credsHash] = sessionId;
    }
  } catch (e) {
    appendSessionLog(sessionId, 'Failed to read session.json during restart: ' + (e?.message || e));
  }

  s.runningLoop = false;
  s.reconnectAttempts = 0;
  s.reconnectLock = false;
  s.firstReconnectTime = null;

  try {
    s.sock = await createOrGetSocket(dir, sessionId);
    appendSessionLog(sessionId, '✅ Session restarted successfully');

  } catch (e) {
    appendSessionLog(sessionId, 'Restart: socket creation failed: ' + (e?.message || e));
    return;
  }

  try {
    await startSendingLoop(sessionId);
    appendSessionLog(sessionId, 'Session restarted and sending loop started');
  } catch (e) {
    appendSessionLog(sessionId, 'restart startSendingLoop failed: ' + (e?.message || e));
  }
}

// Attempt reconnect with 1-hour timeout
async function attemptReconnect(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;

  if (s.stopped) {
    appendSessionLog(sessionId, 'Session was manually stopped - will not reconnect');
    return;
  }

  if (s.reconnectLock) {
    appendSessionLog(sessionId, 'Reconnect attempt already in progress, skipping duplicate call');
    return;
  }

  s.reconnectLock = true;
  s.reconnectAttempts = s.reconnectAttempts || 0;

  if (!s.firstReconnectTime) {
    s.firstReconnectTime = Date.now();
  }

  for (let i = 0; i < RECONNECT_MAX; i++) {
    s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;

    const timeSinceFirstReconnect = Date.now() - (s.firstReconnectTime || Date.now());
    if (timeSinceFirstReconnect >= SESSION_TIMEOUT_MS) {
      appendSessionLog(sessionId, `❌ Session timeout: Failed to reconnect for 1 hour. Removing session completely.`);
      completeSessionCleanup(sessionId);
      s.reconnectLock = false;
      return;
    }

    appendSessionLog(sessionId, `Reconnect attempt ${s.reconnectAttempts}/${RECONNECT_MAX} (waiting ${RECONNECT_DELAY_MS}ms before trying)`);
    await sleep(RECONNECT_DELAY_MS);

    if (!SESSIONS[sessionId]) {
      appendSessionLog(sessionId, 'Session removed during reconnect attempts, aborting attempts');
      s.reconnectLock = false;
      return;
    }

    try {
      const newSock = await createOrGetSocket(s.sessionDir, sessionId);
      if (newSock) {
        s.sock = newSock;
        appendSessionLog(sessionId, '✅ Reconnect successful - Socket recreated');
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
        s.reconnectLock = false;
        return;
      }
    } catch (e) {
      const errorMsg = e?.message || e;
      appendSessionLog(sessionId, 'Reconnect try failed: ' + errorMsg);

      if (String(errorMsg).toLowerCase().includes('logged out') ||
          String(errorMsg).toLowerCase().includes('invalid mac') ||
          String(errorMsg).toLowerCase().includes('device not found')) {
        appendSessionLog(sessionId, '❌ Detected actual authentication failure during reconnect. Removing session.');
        completeSessionCleanup(sessionId);
        s.reconnectLock = false;
        return;
      }
    }
  }

  s.reconnectLock = false;

  const timeSinceFirstReconnect = Date.now() - (s.firstReconnectTime || Date.now());
  if (timeSinceFirstReconnect >= SESSION_TIMEOUT_MS) {
    appendSessionLog(sessionId, `❌ Session timeout: Failed to reconnect for 1 hour. Removing session completely.`);
    completeSessionCleanup(sessionId);
    return;
  }

  appendSessionLog(sessionId, `Max reconnect attempts (${RECONNECT_MAX}) reached. Restarting session immediately.`);
  try {
    await restartSession(sessionId);
  } catch (e) {
    appendSessionLog(sessionId, 'restartSession failed after max reconnects: ' + (e?.message || e));
  }
}

// Restore sessions from disk
function restoreSessionsFromDisk() {
  const entries = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot, { withFileTypes: true }) : [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sessionId = e.name;
    const dir = path.join(sessionsRoot, sessionId);
    const sessionJsonPath = path.join(dir, 'session.json');
    const credsPath = path.join(dir, 'creds.json');

    if (fs.existsSync(sessionJsonPath) && fs.existsSync(credsPath)) {
      try {
        if (!validateCredsJson(credsPath)) {
          appendSessionLog(sessionId, '❌ Invalid creds.json format detected. Removing session.');
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch (cleanupErr) {}
          continue;
        }

        const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));

        if (meta.stopped) {
          appendSessionLog(sessionId, 'Session was stopped - skipping restore');
          continue;
        }

        const sess = {
          sessionId: meta.sessionId || sessionId,
          sessionDir: dir,
          username: meta.username || 'unknown',
          credsHash: meta.credsHash || null,
          contacts: meta.contacts || [],
          messages: meta.messages || [],
          prefixName: meta.prefixName || 'Bot',
          delayMs: meta.delayMs || 5000,
          runningLoop: false,
          sock: null,
          target: meta.target || 'contacts',
          groupId: meta.groupId || null,
          sessionType: meta.sessionType || 'message',
          mediaFiles: loadMediaFiles(dir),
          logs: [],
          createdAt: meta.createdAt || new Date().toISOString(),
          startedAt: meta.startedAt || Date.now(),
          reconnectAttempts: 0,
          reconnectLock: false,
          firstReconnectTime: null,
          deleting: false,
          stopped: false
        };

        SESSIONS[sess.sessionId] = sess;

        if (fs.existsSync(credsPath)) {
          try {
            const hash = sha256File(credsPath);
            sess.credsHash = hash;
            CREDS_HASH_TO_SESSION[hash] = sess.sessionId;
          } catch (e) {}
        }

        appendSessionLog(sess.sessionId, `Restored session from disk (type=${sess.sessionType}, media=${sess.mediaFiles.length}), reconnecting...`);

        try { startSessionWatch(sess.sessionId); } catch (e) {}

        (async () => {
          try {
            SESSIONS[sess.sessionId].sock = await createOrGetSocket(sess.sessionDir, sess.sessionId);
            appendSessionLog(sess.sessionId, '✅ Socket created successfully on restore');
          } catch (e) {
            appendSessionLog(sess.sessionId, 'Socket create failed on restore: ' + (e?.message || e));
            return;
          }

          try {
            await startSendingLoop(sess.sessionId);
          } catch (err) {
            appendSessionLog(sess.sessionId, 'startSendingLoop on restore failed: ' + (err?.message || err));
          }
        })();
      } catch (err) {
        logger.warn('Failed to restore session', sessionId, err?.message || err);
      }
    }
  }
}

// Baileys socket creation
async function createOrGetSocket(sessionDir, sessionId) {
  let baileys;
  try {
    baileys = await import('@whiskeysockets/baileys');
  } catch (e) {
    logger.error('Please npm install @whiskeysockets/baileys', e?.message || e);
    throw e;
  }

  const {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion
  } = baileys;

  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const keysDir = path.join(sessionDir, 'keys');
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (e) {
    appendSessionLog(sessionId, '❌ useMultiFileAuthState failed - Invalid credentials: ' + (e?.message || e));
    throw e;
  }

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    logger.warn('fetchLatestBaileysVersion failed');
  }

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Safari'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino().child({ level: 'fatal' })) },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
  });

  if (sock?.ev?.on) {
    sock.ev.on('creds.update', async () => {
      try {
        if (typeof saveCreds === 'function') await saveCreds();
        fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(state.creds || {}, null, 2), 'utf8');

        try {
          const removed = pruneAuthFiles(sessionDir, sessionId);
          if (removed && removed > 0) {
            logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files after creds.update');
          }
        } catch (e) {}
      } catch (e) {
        appendSessionLog(sessionId, 'creds.update handler error: ' + (e?.message || e));
      }
    });
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown';
      appendSessionLog(sessionId, 'Socket closed: ' + errorMsg);

      if (isLoggedOutUpdate(update)) {
        appendSessionLog(sessionId, '❌ Detected ACTUAL logged out/invalid credentials (not just stream error). Removing session completely.');
        completeSessionCleanup(sessionId);
        return;
      } else {
        appendSessionLog(sessionId, '⚠️ Connection closed but not a logged out condition. Will attempt reconnection...');
      }

      const s = SESSIONS[sessionId];
      if (s && !s.stopped) {
        appendSessionLog(sessionId, 'Socket closed, starting reconnect attempts...');
        attemptReconnect(sessionId).catch(err => appendSessionLog(sessionId, 'attemptReconnect error: ' + (err?.message || err)));
      }
    }

    if (connection === 'open') {
      appendSessionLog(sessionId, '✅ Socket open and connected to WhatsApp');

      const s = SESSIONS[sessionId];
      if (s) {
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
      }

      try { startSessionWatch(sessionId); } catch (e) {}

      try {
        const removed = pruneAuthFiles(sessionDir, sessionId);
        if (removed && removed > 0) logger.debug && logger.debug({ sessionId, removed }, 'Pruned auth files on socket open');
      } catch (e) {}
    }
  });

  return sock;
}

// Wait for socket open
async function waitForSocketOpen(sessionId, timeoutMs = 20000) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sock) throw new Error('No session or socket');
  const sock = s.sock;
  if (sock?.authState?.creds?.registered || (sock.user && Object.keys(sock.user || {}).length)) return;

  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('timeout'));
      }
    }, timeoutMs);

    const handler = (update) => {
      const { connection } = update;
      if (connection === 'open') {
        if (!done) {
          done = true;
          clearTimeout(to);
          sock.ev.off('connection.update', handler);
          resolve();
        }
      }
    };
    sock.ev.on('connection.update', handler);
  });
}

// Always-on sender loop (message / image / sticker based on sessionType)
async function startSendingLoop(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) throw new Error('Session not found');
  if (s.runningLoop) return;
  s.runningLoop = true;

  const sessionType = s.sessionType || 'message';
  appendSessionLog(sessionId, `🚀 Started sending loop (type=${sessionType})`);

  let index = 0;
  while (SESSIONS[sessionId]) {
    try {
      if (s.deleting || s.stopped) {
        appendSessionLog(sessionId, 'startSendingLoop: session is deleting/stopped, exiting loop');
        break;
      }

      if (!s.sock) {
        try {
          s.sock = await createOrGetSocket(s.sessionDir, sessionId);
        } catch (e) {
          appendSessionLog(sessionId, 'Socket creation failed in loop: ' + (e?.message || e));
          await sleep(5000);
          continue;
        }
      }

      try {
        await waitForSocketOpen(sessionId, 20000);
      } catch (e) {
        appendSessionLog(sessionId, 'Socket not open yet');
      }

      const contacts = s.contacts || [];
      const messages = s.messages || [];
      const mediaFiles = s.mediaFiles || [];
      const prefixName = s.prefixName || 'Bot';
      const target = s.target;
      const groupId = s.groupId;

      const contact = (contacts.length) ? contacts[index % contacts.length] : null;

      try {
        const baileys = await import('@whiskeysockets/baileys');
        let jid;

        if (target === 'gc') {
          jid = (groupId + '@g.us');
        } else {
          jid = contact ? baileys.jidNormalizedUser(contact + '@s.whatsapp.net') : null;
        }

        if (!jid) throw new Error('Invalid JID');

        if (sessionType === 'sticker') {
          // Sticker mode: no prefix, no text. Just send sticker one-by-one in loop.
          if (!mediaFiles.length) {
            appendSessionLog(sessionId, '❌ No sticker files available, waiting...');
            await sleep(5000);
            continue;
          }
          const stickerPath = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(stickerPath)) {
            appendSessionLog(sessionId, `❌ Sticker file missing: ${path.basename(stickerPath)}`);
            index++;
            await sleep(s.delayMs);
            continue;
          }
          const stickerBuffer = fs.readFileSync(stickerPath);
          await s.sock.sendMessage(jid, { sticker: stickerBuffer });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `✅ Sticker sent to ${jid} [${path.basename(stickerPath)}]`);

        } else if (sessionType === 'image') {
          // Image mode: prefix + message[i] as caption, cycle through images one-by-one.
          if (!mediaFiles.length) {
            appendSessionLog(sessionId, '❌ No image files available, waiting...');
            await sleep(5000);
            continue;
          }
          const imagePath = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(imagePath)) {
            appendSessionLog(sessionId, `❌ Image file missing: ${path.basename(imagePath)}`);
            index++;
            await sleep(s.delayMs);
            continue;
          }
          const imageBuffer = fs.readFileSync(imagePath);
          const messageToSend = (messages.length) ? messages[index % messages.length] : '';
          const fullCaption = (prefixName + (messageToSend ? ' ' + messageToSend : '')).trim();
          await s.sock.sendMessage(jid, { image: imageBuffer, caption: fullCaption });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `✅ Image sent to ${jid} [${path.basename(imagePath)}]`);

        } else {
          // Default: text message mode (same as before)
          const messageToSend = (messages.length) ? messages[index % messages.length] : '';
          const fullMessage = prefixName + ' ' + messageToSend;
          await s.sock.sendMessage(jid, { text: fullMessage });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          appendSessionLog(sessionId, `✅ Message sent to ${jid}`);
        }

      } catch (err) {
        appendSessionLog(sessionId, '❌ Send failed: ' + String(err?.message || err));
        s.consecutiveSendErrors = (s.consecutiveSendErrors || 0) + 1;
        const MAX_CONSEC_SEND_FAIL = 10;

        if (s.consecutiveSendErrors >= MAX_CONSEC_SEND_FAIL) {
          appendSessionLog(sessionId, `Reached ${MAX_CONSEC_SEND_FAIL} consecutive send failures. Restarting session.`);
          s.consecutiveSendErrors = 0;
          try {
            await restartSession(sessionId);
          } catch (e) {
            appendSessionLog(sessionId, 'Failed to restart after consecutive send errors: ' + (e?.message || e));
          }
        }
      }

      index++;
      persistSessionFiles(sessionId);
      await sleep(s.delayMs);

    } catch (e) {
      appendSessionLog(sessionId, 'Error in sending loop: ' + (e?.message || e));
      await sleep(2000);
    }
  }

  if (SESSIONS[sessionId]) SESSIONS[sessionId].runningLoop = false;
}

// ========== API ROUTES ==========

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

// Get server uptime with daily reset
app.get('/api/uptime', (req, res) => {
  const uptimeMs = Date.now() - SERVER_START_TIME;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  res.json({
    ok: true,
    uptimeMs,
    uptimeFormatted: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
    startTime: new Date(SERVER_START_TIME).toISOString()
  });
});

// Generate approval key (browser-based)
app.post('/api/generate-approval-key', (req, res) => {
  try {
    const { userAgent, language, platform, screenResolution, timezone } = req.body;

    // Create unique fingerprint from browser data
    const fingerprint = `${userAgent}-${language}-${platform}-${screenResolution}-${timezone}-${Date.now()}`;
    const approvalKey = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 16).toUpperCase();

    res.json({ ok: true, approvalKey });
  } catch (e) {
    logger.error('Generate approval key error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to generate approval key' });
  }
});

// Check if approval key is approved
app.post('/api/check-approval', (req, res) => {
  try {
    const { approvalKey } = req.body;

    if (!approvalKey) {
      return res.status(400).json({ ok: false, error: 'Approval key required' });
    }

    const isApproved = isKeyApproved(approvalKey);

    res.json({ ok: true, approved: isApproved });
  } catch (e) {
    logger.error('Check approval error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to check approval' });
  }
});

// Get total users count (admin only)
app.post('/api/total-users', (req, res) => {
  try {
    const { role } = req.body || {};

    if (role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Admin access required' });
    }

    const users = loadUsers();
    const totalUsers = Object.keys(users).length;

    res.json({ ok: true, totalUsers });
  } catch (e) {
    logger.error('Total users error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to get total users' });
  }
});

// Get total sessions count
app.post('/api/total-sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};

    if (!username) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    let sessions = Object.values(SESSIONS);

    // Filter by username unless admin
    if (role !== 'admin' && username !== 'SAHIL123') {
      sessions = sessions.filter(s => s.username === username);
    }

    res.json({ ok: true, totalSessions: sessions.length });
  } catch (e) {
    logger.error('Total sessions error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Failed to get total sessions' });
  }
});

// User signup (requires approval)
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;

    if (!approvalKey) {
      return res.status(403).json({ ok: false, error: 'Approval required. Please get your key approved first.' });
    }

    if (!isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    }

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password required' });
    }

    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Username min 3 chars, password min 6 chars' });
    }

    const users = loadUsers();

    const existingUser = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      return res.status(409).json({ ok: false, error: 'Username already exists' });
    }

    const userId = 'user_' + Date.now();
    users[userId] = {
      username: username,
      password: hashPassword(password),
      role: 'user',
      approvalKey: approvalKey,
      createdAt: new Date().toISOString()
    };

    saveUsers(users);

    res.json({ ok: true, message: 'User created successfully', username });
  } catch (e) {
    logger.error('Signup error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Signup failed' });
  }
});

// User login (requires approval)
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;

    if (!approvalKey) {
      return res.status(403).json({ ok: false, error: 'Approval required. Please get your key approved first.' });
    }

    if (!isKeyApproved(approvalKey)) {
      return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    }

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password required' });
    }

    const users = loadUsers();
    const hashedPassword = hashPassword(password);

    const user = Object.values(users).find(u =>
      u.username === username && u.password === hashedPassword
    );

    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    res.json({
      ok: true,
      username: user.username,
      role: user.role
    });
  } catch (e) {
    logger.error('Login error', e?.message || e);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// Create session (protected - requires username and approval)
// Supports sessionType: 'message' | 'image' | 'sticker'
app.post('/send-message', upload.fields([
  { name: 'creds', maxCount: 1 },
  { name: 'messageFile', maxCount: 1 },
  { name: 'mediaFiles', maxCount: 100 }
]), async (req, res) => {
  try {
    const files = req.files || {};
    const credsFileObj = (files.creds && files.creds[0]) || null;
    const messageFileObj = (files.messageFile && files.messageFile[0]) || null;
    const mediaFileObjs = files.mediaFiles || [];
    const { name: prefixName, type, targetID, delayTime, username, approvalKey } = req.body || {};
    const sessionType = (req.body.sessionType || 'message').toLowerCase();

    // Helper to remove uploaded temp files
    const cleanupUploads = () => {
      try { if (credsFileObj) fs.unlinkSync(credsFileObj.path); } catch (e) {}
      try { if (messageFileObj) fs.unlinkSync(messageFileObj.path); } catch (e) {}
      for (const mf of mediaFileObjs) { try { fs.unlinkSync(mf.path); } catch (e) {} }
    };

    if (!username) {
      cleanupUploads();
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    if (!approvalKey || !isKeyApproved(approvalKey)) {
      cleanupUploads();
      return res.status(403).json({ ok: false, error: 'Valid approval required to create session' });
    }

    if (!['message', 'image', 'sticker'].includes(sessionType)) {
      cleanupUploads();
      return res.status(400).json({ ok: false, error: 'Invalid sessionType. Must be message, image, or sticker.' });
    }

    const delaySeconds = parseInt(delayTime || '5', 10) || 5;
    const delayMs = delaySeconds * 1000;

    if (!credsFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No creds.json uploaded' }); }
    if (!type || !targetID) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Missing type or targetID' }); }

    // Validate per-type requirements
    if (sessionType === 'message') {
      if (!messageFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No message file uploaded' }); }
      if (!prefixName || !String(prefixName).trim()) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Prefix name is required for message sessions' }); }
    } else if (sessionType === 'image') {
      if (!mediaFileObjs.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'At least one image file required' }); }
      if (!messageFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No message file uploaded (image caption source)' }); }
      if (!prefixName || !String(prefixName).trim()) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Prefix name is required for image sessions' }); }
    } else if (sessionType === 'sticker') {
      if (!mediaFileObjs.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'At least one sticker file required' }); }
      // Sticker mode: prefix & messageFile ignored (sticker doesn't support text)
    }

    const uploadedPath = credsFileObj.path;

    if (!validateCredsJson(uploadedPath)) {
      cleanupUploads();
      return res.status(400).json({ ok: false, error: 'Invalid creds.json format. Please upload valid WhatsApp credentials.' });
    }

    let contacts = [];
    if (type === 'gc') {
      contacts = [targetID.trim()];
    } else {
      const raw = String(targetID || '');
      const parts = raw.split(/[,\r\n]+/).map(x => x.trim()).filter(Boolean);
      contacts = parts.map(p => p.replace(/[^\d+]/g, '').replace(/^\+/, ''));
      if (!contacts.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No valid contact numbers provided' }); }
    }

    // Build messages array (only for message/image modes)
    let messages = [];
    if (messageFileObj) {
      const txt = fs.readFileSync(messageFileObj.path, 'utf8');
      const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      messages = lines.length ? lines : [txt.trim()];
      if (sessionType !== 'sticker' && (!messages.length || !messages[0])) {
        cleanupUploads();
        return res.status(400).json({ ok: false, error: 'No message content' });
      }
    }

    const credsHash = sha256File(uploadedPath);
    if (CREDS_HASH_TO_SESSION[credsHash]) {
      cleanupUploads();
      return res.status(409).json({ ok: false, error: 'Duplicate credentials. Only one active session allowed per creds.json.' });
    }

    const sessionId = makeSessionId();
    const sessionDir = makeSessionDir(sessionId);

    fs.copyFileSync(uploadedPath, path.join(sessionDir, 'creds.json'));
    try { fs.writeFileSync(path.join(sessionDir, 'messages.txt'), messages.join('\n'), 'utf8'); } catch (e) {}

    // Move media files (images/stickers) into sessionDir/media/
    const mediaDir = path.join(sessionDir, 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const savedMediaPaths = [];
    for (const mf of mediaFileObjs) {
      try {
        const safeName = mf.originalname.replace(/[^\w.\-]+/g, '_');
        const targetPath = path.join(mediaDir, Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + safeName);
        fs.copyFileSync(mf.path, targetPath);
        savedMediaPaths.push(targetPath);
      } catch (e) {
        logger.warn('Failed to save media file: ' + (e?.message || e));
      }
    }

    const sessionMeta = {
      sessionId,
      username,
      contacts,
      messages,
      prefixName: sessionType === 'sticker' ? '' : prefixName,
      delayMs,
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      sessionType,
      mediaFiles: savedMediaPaths.map(p => path.basename(p)),
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      credsHash,
      stopped: false
    };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');

    // Cleanup uploaded temp files
    cleanupUploads();

    SESSIONS[sessionId] = {
      sessionId,
      sessionDir,
      username,
      credsHash,
      contacts,
      messages,
      prefixName: sessionType === 'sticker' ? '' : prefixName,
      delayMs,
      runningLoop: false,
      sock: null,
      target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      sessionType,
      mediaFiles: savedMediaPaths,
      createdAt: sessionMeta.createdAt,
      startedAt: Date.now(),
      logs: [],
      reconnectAttempts: 0,
      reconnectLock: false,
      firstReconnectTime: null,
      deleting: false,
      stopped: false
    };
    CREDS_HASH_TO_SESSION[credsHash] = sessionId;

    appendSessionLog(sessionId, `Session created by user: ${username} [type=${sessionType}, media=${savedMediaPaths.length}]`);

    try { startSessionWatch(sessionId); } catch (e) {}

    (async () => {
      try {
        SESSIONS[sessionId].sock = await createOrGetSocket(sessionDir, sessionId);
        appendSessionLog(sessionId, '✅ Socket created - Session starting');
      } catch (e) {
        appendSessionLog(sessionId, 'Socket create failed: ' + (e?.message || e));
        return;
      }

      try {
        await startSendingLoop(sessionId);
      } catch (e) {
        appendSessionLog(sessionId, 'startSendingLoop error: ' + (e?.message || e));
      }
    })();

    res.json({ ok: true, sessionId });
  } catch (err) {
    logger.error('send-message failed', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Stop session
app.post('/stop-session/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username } = req.body || {};

    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });

    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

    if (username !== 'SAHIL123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized to stop this session' });
    }

    appendSessionLog(sessionId, `🛑 Stop session requested by: ${username}`);

    s.stopped = true;
    persistSessionFiles(sessionId);

    try {
      const sock = s.sock;
      if (sock) {
        try {
          if (sock.ws && typeof sock.ws.close === 'function') sock.ws.close();
          else if (sock.socket && typeof sock.socket.close === 'function') sock.socket.close();
          else if (typeof sock.end === 'function') sock.end();
          appendSessionLog(sessionId, 'Socket closed');
        } catch (closeErr) {
          appendSessionLog(sessionId, 'Error during socket close: ' + (closeErr?.message || closeErr));
        }
      }
    } catch (e) {
      appendSessionLog(sessionId, 'Error trying to close socket: ' + (e?.message || e));
    }

    try { stopSessionWatch(sessionId); } catch (e) {}

    cleanupSessionFiles(sessionId);

    try {
      if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) {
        delete CREDS_HASH_TO_SESSION[s.credsHash];
      }
      delete SESSIONS[sessionId];
      appendSessionLog(sessionId, '✅ Session stopped successfully');
    } catch (e) {
      appendSessionLog(sessionId, 'Error removing from memory: ' + (e?.message || e));
    }

    return res.json({ ok: true, message: `Session ${sessionId} stopped and cleaned up` });

  } catch (e) {
    logger.error('stop-session err', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Error stopping session' });
  }
});

// List sessions (filtered by username, admin sees all)
app.post('/api/sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};

    if (!username) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    let sessions = Object.values(SESSIONS);

    if (role !== 'admin' && username !== 'SAHIL123') {
      sessions = sessions.filter(s => s.username === username);
    }

    const list = sessions.map(s => {
      const uptime = s.startedAt ? Date.now() - s.startedAt : 0;
      const uptimeSeconds = Math.floor(uptime / 1000);
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      return {
        sessionId: s.sessionId,
        username: s.username,
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
        uptimeMs: uptime,
        target: s.target,
        groupId: s.groupId,
        sessionType: s.sessionType || 'message',
        mediaCount: (s.mediaFiles || []).length,
        stopped: s.stopped || false
      };
    });

    return res.json({ ok: true, sessions: list });
  } catch (e) {
    logger.error('sessions list error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Get single session details
app.post('/api/session/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};

    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });

    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }

    const uptime = s.startedAt ? Date.now() - s.startedAt : 0;
    const uptimeSeconds = Math.floor(uptime / 1000);
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;

    return res.json({
      ok: true,
      session: {
        sessionId: s.sessionId,
        username: s.username,
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${days} day ${hours} hour ${minutes} minute ${seconds} seconds`,
        uptimeMs: uptime,
        target: s.target,
        groupId: s.groupId,
        sessionType: s.sessionType || 'message',
        mediaCount: (s.mediaFiles || []).length,
        stopped: s.stopped || false
      }
    });
  } catch (e) {
    logger.error('session details error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Logs API
app.post('/api/logs/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};

    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });

    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });

    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) {
      return res.status(403).json({ ok: false, error: 'Not authorized' });
    }

    const lines = (s.logs || []).map(l => `[${l.time}] ${l.msg}`);
    return res.json({ ok: true, logs: lines });
  } catch (e) {
    logger.error('api/logs error', e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Initialize admin user
initializeUsers();

// Restore sessions on startup
restoreSessionsFromDisk();

// Global periodic prune
setInterval(() => {
  try {
    const sessionIds = Object.keys(SESSIONS);
    for (const sid of sessionIds) {
      try {
        const s = SESSIONS[sid];
        if (s && s.sessionDir) {
          const removed = pruneAuthFiles(s.sessionDir, sid);
          if (removed && removed > 0) logger.debug && logger.debug({ sid, removed }, 'Global prune removed files');
        }
      } catch (e) {}
    }
  } catch (e) {}
}, GLOBAL_PRUNE_INTERVAL_MS);

// Error protection - don't crash server
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException: ' + (err?.message || err));
  appendSessionLog(null, '⚠️ uncaughtException (server continues): ' + (err?.message || err));
});

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection: ' + (err?.message || err));
  appendSessionLog(null, '⚠️ unhandledRejection (server continues): ' + (err?.message || err));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.bgBlue.white.bold(` ✅ WALEED KHAN Khan Ofline WhatsApp Server running on http://0.0.0.0:${PORT} `));
  logger.info('Server started on 0.0.0.0:' + PORT);
  appendSessionLog(null, `✅ Server started on 0.0.0.0:${PORT}`);
});

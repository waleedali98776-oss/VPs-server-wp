const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https'); // ✅ NEW: GitHub approval fetch
const http = require('http');   // ✅ NEW: Keep-alive ping
const pino = require('pino');
const chalk = require('chalk');
const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const PORT = process.env.PORT || 3000;

// Server start time for uptime tracking
const SERVER_START_TIME = Date.now();

// Reconnect config
const RECONNECT_MAX = 6;
const RECONNECT_DELAY_MS = 4000; // 4 seconds

// 100 days timeout
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS || String(100 * 24 * 60 * 60 * 1000), 10);

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

// ════════════════════════════════════════════════════════════════
// 🐙 GITHUB APPROVAL SYSTEM
//
// 👇👇👇 APNA GITHUB APPROVAL.TXT KA RAW LINK YAHAN DALLEIN 👇👇👇
// ════════════════════════════════════════════════════════════════
const GITHUB_APPROVAL_URL = 'https://raw.githubusercontent.com/waleedali98776-oss/VPs-server-wp/refs/heads/main/approval.txt%E2%80%89';
// ════════════════════════════════════════════════════════════════
// ☝️ APNA_USER/APNA_REPO ki jagah apna GitHub username + repo likhein
// Example:
// 'https://raw.githubusercontent.com/danishkhan/wa-keys/main/approval.txt'
// ════════════════════════════════════════════════════════════════

const configFilePath = path.join(process.cwd(), 'config.json');
const APPROVAL_REFRESH_MS = parseInt(process.env.APPROVAL_REFRESH_MS || '60000', 10); // 60 sec
let GITHUB_APPROVED_KEYS = new Set();
let GITHUB_LAST_SYNC = null;

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(sessionsRoot)) fs.mkdirSync(sessionsRoot, { recursive: true });

// Initialize approval file if not exists
if (!fs.existsSync(approvalFilePath)) {
  fs.writeFileSync(approvalFilePath, '', 'utf8');
  console.log(chalk.yellow('✓ approval.txt file created'));
}

// ========== Config file helpers ==========
function loadConfig() {
  try { if (fs.existsSync(configFilePath)) return JSON.parse(fs.readFileSync(configFilePath, 'utf8')); } catch (e) { logger.error('Failed to load config', e?.message || e); }
  return {};
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configFilePath, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { logger.error('Failed to save config', e?.message || e); }
}

// Priority: Admin Panel URL > Env Variable > Hardcoded constant
function getApprovalUrl() {
  const cfg = loadConfig();
  return (cfg.approvalUrl || process.env.APPROVAL_GITHUB_URL || GITHUB_APPROVAL_URL || '').trim();
}

// Fetch text from any URL (GitHub raw file)
function fetchUrlText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'WA-Approval-Bot' }, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchUrlText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
  });
}

// Sync approved keys from GitHub approval.txt
async function syncGithubApprovals() {
  const url = getApprovalUrl();
  if (!url || url.includes('APNA_USER/APNA_REPO')) {
    return { synced: false, count: 0, reason: '⚠️ GitHub link set nahi hua — new1.js mein GITHUB_APPROVAL_URL edit karein' };
  }
  try {
    const text = await fetchUrlText(url);
    const keys = text.split('\n')
      .map(l => l.trim().toUpperCase())
      .filter(Boolean)
      .filter(l => !l.startsWith('#') && !l.startsWith('//'));
    GITHUB_APPROVED_KEYS = new Set(keys);
    GITHUB_LAST_SYNC = new Date().toISOString();
    console.log(chalk.green(`🐙 GitHub approvals synced: ${keys.length} keys`));
    return { synced: true, count: keys.length, lastSync: GITHUB_LAST_SYNC };
  } catch (e) {
    logger.warn('GitHub approval sync failed: ' + (e?.message || e));
    return { synced: false, count: GITHUB_APPROVED_KEYS.size, error: String(e?.message || e) };
  }
}

// Initialize users file with admin
function initializeUsers() {
  if (!fs.existsSync(usersFilePath)) {
    const users = {
      admin: {
        username: 'Danishkhan',
        password: hashPassword('Danishkhan786'),
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2), 'utf8');
    console.log(chalk.green('✓ Admin user created: Danishkhan / Danishkhan786'));
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

// Load approved keys from local approval.txt
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

// ✅ UPDATED: Check key in GitHub keys FIRST, then local file
function isKeyApproved(key) {
  const k = String(key || '').trim().toUpperCase();
  if (!k) return false;
  if (GITHUB_APPROVED_KEYS.has(k)) return true; // 🐙 GitHub check
  const approvedKeys = loadApprovedKeys().map(x => String(x).trim().toUpperCase());
  return approvedKeys.includes(k); // 📁 Local check
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + '' + Math.random().toString(36).slice(2, 8) + '' + file.originalname.replace(/\s+/g, ''))
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
  const s = sessionId ? SESSIONS[sessionId] : null;
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
  }
  const timeStr = chalk.yellow(`[${time}]`);
  let symbolColored, messageColored;
  if (kind === 'success') {
    symbolColored = chalk.greenBright('[✓]');
    messageColored = chalk.green(msg);
  } else if (kind === 'error') {
    symbolColored = chalk.redBright('[✗]');
    messageColored = chalk.red(msg);
  } else {
    symbolColored = chalk.cyan('[i]');
    messageColored = chalk.cyan(msg);
  }
  const sessionIdStr = sessionId ? chalk.magenta(`[${sessionId}]`) : '';
  console.log(`${timeStr} ${symbolColored} ${messageColored} ${sessionIdStr}`);
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
      stopped: s.stopped || false,
      paused: s.paused || false,
      messagesSent: s.messagesSent || 0
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
        try { fs.rmSync(rem.full, { force: true }); removedCount++; } catch (e) {}
      }
      if (removedCount > 0) { stats[pattern.name] = removedCount; totalRemoved += removedCount; }
    }
    const keysDir = path.join(sessionDir, 'keys');
    if (fs.existsSync(keysDir) && fs.statSync(keysDir).isDirectory()) {
      const kfiles = fs.readdirSync(keysDir, { withFileTypes: true }).filter(f => f.isFile()).map(f => f.name);
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
          try { fs.rmSync(rem.full, { force: true }); removedCount++; } catch (e) {}
        }
        if (removedCount > 0) { const key = `keys/${pattern.name}`; stats[key] = (stats[key] || 0) + removedCount; totalRemoved += removedCount; }
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
      try { pruneAuthFiles(sessionDir, sessionId); } catch (e) {}
      watchers.debounceTimer = null;
    }, PRUNE_DEBOUNCE_MS);
  };
  try { watchers.dirWatcher = fs.watch(sessionDir, (eventType, filename) => { if (!filename || String(filename).startsWith('media')) return; schedulePrune(); }); } catch (e) {}
  try {
    const keysDir = path.join(sessionDir, 'keys');
    if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });
    watchers.keysWatcher = fs.watch(keysDir, (eventType, filename) => { if (!filename) return; schedulePrune(); });
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

// Complete session cleanup
function completeSessionCleanup(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s || !s.sessionDir) return;
  try {
    appendSessionLog(sessionId, '🗑️ Complete cleanup: removing session folder');
    stopSessionWatch(sessionId);
    if (fs.existsSync(s.sessionDir)) {
      fs.rmSync(s.sessionDir, { recursive: true, force: true });
      appendSessionLog(sessionId, '✅ Session folder completely removed');
    }
    if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) delete CREDS_HASH_TO_SESSION[s.credsHash];
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
        try { fs.unlinkSync(path.join(s.sessionDir, file.name)); deletedCount++; } catch (e) {}
      }
    }
    const keysDir = path.join(s.sessionDir, 'keys');
    if (fs.existsSync(keysDir)) { try { fs.rmSync(keysDir, { recursive: true, force: true }); } catch (e) {} }
    const mediaDir = path.join(s.sessionDir, 'media');
    if (fs.existsSync(mediaDir)) { try { fs.rmSync(mediaDir, { recursive: true, force: true }); } catch (e) {} }
    appendSessionLog(sessionId, `✅ Cleanup complete: ${deletedCount} files deleted`);
  } catch (e) {
    appendSessionLog(sessionId, '❌ Cleanup error: ' + (e?.message || e));
  }
}

// Check if credentials are invalid/logged out
function isLoggedOutUpdate(update) {
  const last = update?.lastDisconnect;
  if (!last) return false;
  const error = last.error;
  const statusCode = error?.output?.statusCode;
  const msg = (error && (error.message || String(error))) || String(error || '');
  if (!msg && !statusCode) return false;
  const lower = msg.toLowerCase();
  const actualLoggedOutPatterns = ['logged out', 'logged-out', 'device not found', 'invalid mac', 'qr refs attempts ended', 'restart required'];
  if (statusCode === 401 || statusCode === 403) return true;
  for (const pattern of actualLoggedOutPatterns) { if (lower.includes(pattern)) return true; }
  return false;
}

// Validate creds.json structure
function validateCredsJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    if (!json.noiseKey || !json.signedIdentityKey || !json.signedPreKey) return false;
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
      .filter(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } })
      .sort();
  } catch (e) {
    return [];
  }
}

// Restart a session
async function restartSession(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) { appendSessionLog(sessionId, 'restartSession: no in-memory session found'); return; }
  if (s.stopped) { appendSessionLog(sessionId, 'Session was manually stopped - will not restart'); return; }
  const dir = s.sessionDir;
  if (!dir || !fs.existsSync(dir)) { appendSessionLog(sessionId, 'restartSession: session folder missing'); return; }
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
      s.paused = meta.paused || false;
      s.sessionType = meta.sessionType || s.sessionType || 'message';
      s.mediaFiles = loadMediaFiles(dir);
      s.messagesSent = meta.messagesSent || s.messagesSent || 0;
      if (s.credsHash) CREDS_HASH_TO_SESSION[s.credsHash] = sessionId;
    }
  } catch (e) { appendSessionLog(sessionId, 'Failed to read session.json during restart: ' + (e?.message || e)); }
  s.runningLoop = false;
  s.reconnectAttempts = 0;
  s.reconnectLock = false;
  s.firstReconnectTime = null;
  try {
    s.sock = await createOrGetSocket(dir, sessionId);
    appendSessionLog(sessionId, '✅ Session restarted successfully');
  } catch (e) { appendSessionLog(sessionId, 'Restart: socket creation failed: ' + (e?.message || e)); return; }
  try {
    await startSendingLoop(sessionId);
    appendSessionLog(sessionId, 'Session restarted and sending loop started');
  } catch (e) { appendSessionLog(sessionId, 'restart startSendingLoop failed: ' + (e?.message || e)); }
}

// Attempt reconnect
async function attemptReconnect(sessionId) {
  const s = SESSIONS[sessionId];
  if (!s) return;
  if (s.stopped) { appendSessionLog(sessionId, 'Session was manually stopped - will not reconnect'); return; }
  if (s.reconnectLock) { appendSessionLog(sessionId, 'Reconnect attempt already in progress'); return; }
  s.reconnectLock = true;
  s.reconnectAttempts = s.reconnectAttempts || 0;
  if (!s.firstReconnectTime) s.firstReconnectTime = Date.now();
  for (let i = 0; i < RECONNECT_MAX; i++) {
    s.reconnectAttempts = (s.reconnectAttempts || 0) + 1;
    const timeSinceFirstReconnect = Date.now() - (s.firstReconnectTime || Date.now());
    if (timeSinceFirstReconnect >= SESSION_TIMEOUT_MS) {
      appendSessionLog(sessionId, `❌ Session timeout after ${Math.floor(SESSION_TIMEOUT_MS / 86400000)} days. Removing session.`);
      completeSessionCleanup(sessionId);
      s.reconnectLock = false;
      return;
    }
    appendSessionLog(sessionId, `Reconnect attempt ${s.reconnectAttempts}/${RECONNECT_MAX}`);
    await sleep(RECONNECT_DELAY_MS);
    if (!SESSIONS[sessionId]) { s.reconnectLock = false; return; }
    try {
      const newSock = await createOrGetSocket(s.sessionDir, sessionId);
      if (newSock) {
        s.sock = newSock;
        appendSessionLog(sessionId, '✅ Reconnect successful');
        s.reconnectAttempts = 0;
        s.firstReconnectTime = null;
        s.reconnectLock = false;
        return;
      }
    } catch (e) {
      const errorMsg = e?.message || e;
      appendSessionLog(sessionId, 'Reconnect try failed: ' + errorMsg);
      if (String(errorMsg).toLowerCase().includes('logged out') || String(errorMsg).toLowerCase().includes('invalid mac') || String(errorMsg).toLowerCase().includes('device not found')) {
        appendSessionLog(sessionId, '❌ Auth failure during reconnect. Removing session.');
        completeSessionCleanup(sessionId);
        s.reconnectLock = false;
        return;
      }
    }
  }
  s.reconnectLock = false;
  appendSessionLog(sessionId, `Max reconnect attempts reached. Restarting session.`);
  try { await restartSession(sessionId); } catch (e) { appendSessionLog(sessionId, 'restartSession failed: ' + (e?.message || e)); }
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
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (cleanupErr) {}
          continue;
        }
        const meta = JSON.parse(fs.readFileSync(sessionJsonPath, 'utf8'));
        if (meta.stopped) { appendSessionLog(sessionId, 'Session was stopped - skipping restore'); continue; }
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
          stopped: false,
          paused: meta.paused || false,
          messagesSent: meta.messagesSent || 0
        };
        SESSIONS[sess.sessionId] = sess;
        if (fs.existsSync(credsPath)) {
          try { const hash = sha256File(credsPath); sess.credsHash = hash; CREDS_HASH_TO_SESSION[hash] = sess.sessionId; } catch (e) {}
        }
        appendSessionLog(sess.sessionId, `Restored session from disk (type=${sess.sessionType}, media=${sess.mediaFiles.length})`);
        try { startSessionWatch(sess.sessionId); } catch (e) {}
        (async () => {
          try {
            SESSIONS[sess.sessionId].sock = await createOrGetSocket(sess.sessionDir, sess.sessionId);
          } catch (e) { appendSessionLog(sess.sessionId, 'Socket create failed on restore: ' + (e?.message || e)); return; }
          try { await startSendingLoop(sess.sessionId); } catch (err) { appendSessionLog(sess.sessionId, 'startSendingLoop on restore failed: ' + (err?.message || err)); }
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
  const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } = baileys;
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const keysDir = path.join(sessionDir, 'keys');
  if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir, { recursive: true });
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
  } catch (e) {
    appendSessionLog(sessionId, '❌ useMultiFileAuthState failed: ' + (e?.message || e));
    throw e;
  }
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { logger.warn('fetchLatestBaileysVersion failed'); }
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
        try { pruneAuthFiles(sessionDir, sessionId); } catch (e) {}
      } catch (e) { appendSessionLog(sessionId, 'creds.update handler error: ' + (e?.message || e)); }
    });
  }
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const errorMsg = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown';
      appendSessionLog(sessionId, 'Socket closed: ' + errorMsg);
      if (isLoggedOutUpdate(update)) {
        appendSessionLog(sessionId, '❌ Logged out / invalid credentials. Removing session.');
        completeSessionCleanup(sessionId);
        return;
      } else {
        appendSessionLog(sessionId, '⚠️ Connection closed. Will attempt reconnection...');
      }
      const s = SESSIONS[sessionId];
      if (s && !s.stopped) {
        attemptReconnect(sessionId).catch(err => appendSessionLog(sessionId, 'attemptReconnect error: ' + (err?.message || err)));
      }
    }
    if (connection === 'open') {
      appendSessionLog(sessionId, '✅ Socket open and connected to WhatsApp');
      const s = SESSIONS[sessionId];
      if (s) { s.reconnectAttempts = 0; s.firstReconnectTime = null; }
      try { startSessionWatch(sessionId); } catch (e) {}
      try { pruneAuthFiles(sessionDir, sessionId); } catch (e) {}
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
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, timeoutMs);
    const handler = (update) => {
      if (update.connection === 'open') {
        if (!done) { done = true; clearTimeout(to); sock.ev.off('connection.update', handler); resolve(); }
      }
    };
    sock.ev.on('connection.update', handler);
  });
}

// Always-on sender loop (message/image/sticker/video)
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
        appendSessionLog(sessionId, 'Loop: session stopped/deleted, exiting');
        break;
      }
      if (s.paused) {
        appendSessionLog(sessionId, '⏸️ Session paused. Waiting...');
        await sleep(5000);
        continue;
      }
      if (!s.sock) {
        try { s.sock = await createOrGetSocket(s.sessionDir, sessionId); } catch (e) {
          appendSessionLog(sessionId, 'Socket creation failed in loop: ' + (e?.message || e));
          await sleep(5000);
          continue;
        }
      }
      try { await waitForSocketOpen(sessionId, 20000); } catch (e) { appendSessionLog(sessionId, 'Socket not open yet'); }
      const contacts = s.contacts || [];
      const messages = s.messages || [];
      const mediaFiles = s.mediaFiles || [];
      const prefixName = s.prefixName || 'Bot';
      const target = s.target;
      const groupId = s.groupId;
      const contact = contacts.length ? contacts[index % contacts.length] : null;
      try {
        const baileys = await import('@whiskeysockets/baileys');
        let jid;
        if (target === 'gc') {
          jid = groupId + '@g.us';
        } else {
          jid = contact ? baileys.jidNormalizedUser(contact + '@s.whatsapp.net') : null;
        }
        if (!jid) throw new Error('Invalid JID');
        if (sessionType === 'sticker') {
          if (!mediaFiles.length) { appendSessionLog(sessionId, '❌ No sticker files, waiting...'); await sleep(5000); continue; }
          const stickerPath = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(stickerPath)) { index++; await sleep(s.delayMs); continue; }
          const stickerBuffer = fs.readFileSync(stickerPath);
          await s.sock.sendMessage(jid, { sticker: stickerBuffer });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          s.messagesSent = (s.messagesSent || 0) + 1;
          appendSessionLog(sessionId, `✅ Sticker sent to ${jid} [${path.basename(stickerPath)}] | Total: ${s.messagesSent}`);
        } else if (sessionType === 'image') {
          if (!mediaFiles.length) { appendSessionLog(sessionId, '❌ No image files, waiting...'); await sleep(5000); continue; }
          const imagePath = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(imagePath)) { index++; await sleep(s.delayMs); continue; }
          const imageBuffer = fs.readFileSync(imagePath);
          const messageToSend = messages.length ? messages[index % messages.length] : '';
          const fullCaption = (prefixName + (messageToSend ? ' ' + messageToSend : '')).trim();
          await s.sock.sendMessage(jid, { image: imageBuffer, caption: fullCaption });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          s.messagesSent = (s.messagesSent || 0) + 1;
          appendSessionLog(sessionId, `✅ Image sent to ${jid} [${path.basename(imagePath)}] | Total: ${s.messagesSent}`);
        } else if (sessionType === 'video') {
          if (!mediaFiles.length) { appendSessionLog(sessionId, '❌ No video files, waiting...'); await sleep(5000); continue; }
          const videoPath = mediaFiles[index % mediaFiles.length];
          if (!fs.existsSync(videoPath)) { index++; await sleep(s.delayMs); continue; }
          const videoBuffer = fs.readFileSync(videoPath);
          const messageToSend = messages.length ? messages[index % messages.length] : '';
          const fullCaption = (prefixName + (messageToSend ? ' ' + messageToSend : '')).trim();
          await s.sock.sendMessage(jid, { video: videoBuffer, caption: fullCaption });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          s.messagesSent = (s.messagesSent || 0) + 1;
          appendSessionLog(sessionId, `✅ Video sent to ${jid} [${path.basename(videoPath)}] | Total: ${s.messagesSent}`);
        } else {
          const messageToSend = messages.length ? messages[index % messages.length] : '';
          const fullMessage = prefixName + ' ' + messageToSend;
          await s.sock.sendMessage(jid, { text: fullMessage });
          s.lastUsed = Date.now();
          s.consecutiveSendErrors = 0;
          s.messagesSent = (s.messagesSent || 0) + 1;
          appendSessionLog(sessionId, `✅ Message sent to ${jid} | Total: ${s.messagesSent}`);
        }
      } catch (err) {
        appendSessionLog(sessionId, '❌ Send failed: ' + String(err?.message || err));
        s.consecutiveSendErrors = (s.consecutiveSendErrors || 0) + 1;
        if (s.consecutiveSendErrors >= 10) {
          appendSessionLog(sessionId, `10 consecutive send failures. Restarting session.`);
          s.consecutiveSendErrors = 0;
          try { await restartSession(sessionId); } catch (e) { appendSessionLog(sessionId, 'Failed to restart: ' + (e?.message || e)); }
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
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check / keep-alive ping
app.get('/ping', (req, res) => {
  res.json({ ok: true, message: 'pong', time: new Date().toISOString() });
});

// Get server uptime
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
    startTime: new Date(SERVER_START_TIME).toISOString(),
    activeSessions: Object.keys(SESSIONS).length
  });
});

// Generate approval key
app.post('/api/generate-approval-key', (req, res) => {
  try {
    const { userAgent, language, platform, screenResolution, timezone } = req.body;
    const fingerprint = `${userAgent}-${language}-${platform}-${screenResolution}-${timezone}-${Date.now()}`;
    const approvalKey = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 16).toUpperCase();
    res.json({ ok: true, approvalKey });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to generate approval key' });
  }
});

// Check if approval key is approved
app.post('/api/check-approval', (req, res) => {
  try {
    const { approvalKey } = req.body;
    if (!approvalKey) return res.status(400).json({ ok: false, error: 'Approval key required' });
    res.json({ ok: true, approved: isKeyApproved(approvalKey) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to check approval' });
  }
});

// Admin — Add approval key (local)
app.post('/api/admin/add-approval-key', (req, res) => {
  try {
    const { role, key } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    if (!key || !key.trim()) return res.status(400).json({ ok: false, error: 'Key is required' });
    const trimmedKey = key.trim();
    const existing = loadApprovedKeys();
    if (existing.includes(trimmedKey)) return res.status(409).json({ ok: false, error: 'Key already exists' });
    existing.push(trimmedKey);
    fs.writeFileSync(approvalFilePath, existing.join('\n') + '\n', 'utf8');
    res.json({ ok: true, message: `Key "${trimmedKey}" added successfully` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to add key' });
  }
});

// Admin — Remove approval key (local)
app.post('/api/admin/remove-approval-key', (req, res) => {
  try {
    const { role, key } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    if (!key || !key.trim()) return res.status(400).json({ ok: false, error: 'Key is required' });
    const trimmedKey = key.trim();
    const existing = loadApprovedKeys();
    const updated = existing.filter(k => k !== trimmedKey);
    if (updated.length === existing.length) return res.status(404).json({ ok: false, error: 'Key not found' });
    fs.writeFileSync(approvalFilePath, updated.join('\n') + (updated.length ? '\n' : ''), 'utf8');
    res.json({ ok: true, message: `Key "${trimmedKey}" removed successfully` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to remove key' });
  }
});

// Admin — List all approval keys (local)
app.post('/api/admin/list-approval-keys', (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    const keys = loadApprovedKeys();
    res.json({ ok: true, keys, total: keys.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to list keys' });
  }
});

// ✅ NEW: Admin — Set GitHub approval URL (runtime override)
app.post('/api/admin/set-approval-url', async (req, res) => {
  try {
    const { role, url } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    if (!url || !/^https?:\/\/.+/.test(url.trim())) return res.status(400).json({ ok: false, error: 'Valid URL required (https://...)' });
    const cfg = loadConfig();
    cfg.approvalUrl = url.trim();
    saveConfig(cfg);
    const result = await syncGithubApprovals();
    res.json({
      ok: result.synced,
      message: result.synced
        ? `URL saved & ${result.count} keys synced from GitHub ✅`
        : 'URL saved but sync failed: ' + (result.error || result.reason),
      ...result
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to set approval URL' });
  }
});

// ✅ NEW: Admin — Get approval config/status
app.post('/api/admin/approval-config', (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    res.json({
      ok: true,
      url: getApprovalUrl(),
      lastSync: GITHUB_LAST_SYNC,
      githubKeys: GITHUB_APPROVED_KEYS.size,
      localKeys: loadApprovedKeys().length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to get config' });
  }
});

// ✅ NEW: Admin — Force sync GitHub approvals now
app.post('/api/admin/sync-approvals', async (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    const result = await syncGithubApprovals();
    res.json({ ok: result.synced, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Sync failed' });
  }
});

// Get total users count (admin only)
app.post('/api/total-users', (req, res) => {
  try {
    const { role } = req.body || {};
    if (role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
    const users = loadUsers();
    res.json({ ok: true, totalUsers: Object.keys(users).length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to get total users' });
  }
});

// Get total sessions count
app.post('/api/total-sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    let sessions = Object.values(SESSIONS);
    if (role !== 'admin' && username !== 'SAHIL123') sessions = sessions.filter(s => s.username === username);
    res.json({ ok: true, totalSessions: sessions.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to get total sessions' });
  }
});

// ✅ NEW: Dashboard stats
app.post('/api/stats', (req, res) => {
  try {
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    let sessions = Object.values(SESSIONS);
    if (role !== 'admin' && username !== 'SAHIL123') sessions = sessions.filter(s => s.username === username);
    const totalMessages = sessions.reduce((a, s) => a + (s.messagesSent || 0), 0);
    const totalMedia = sessions.reduce((a, s) => a + (s.mediaFiles?.length || 0), 0);
    const paused = sessions.filter(s => s.paused).length;
    res.json({ ok: true, totalSessions: sessions.length, totalMessages, totalMedia, paused, active: sessions.length - paused });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Stats failed' });
  }
});

// User signup
app.post('/api/signup', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    if (!approvalKey) return res.status(403).json({ ok: false, error: 'Approval required.' });
    if (!isKeyApproved(approvalKey)) return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required' });
    if (username.length < 3 || password.length < 6) return res.status(400).json({ ok: false, error: 'Username min 3 chars, password min 6 chars' });
    const users = loadUsers();
    const existingUser = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) return res.status(409).json({ ok: false, error: 'Username already exists' });
    const userId = 'user_' + Date.now();
    users[userId] = { username, password: hashPassword(password), role: 'user', approvalKey, createdAt: new Date().toISOString() };
    saveUsers(users);
    res.json({ ok: true, message: 'User created successfully', username });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Signup failed' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, approvalKey } = req.body;
    if (!approvalKey) return res.status(403).json({ ok: false, error: 'Approval required.' });
    if (!isKeyApproved(approvalKey)) return res.status(403).json({ ok: false, error: 'Your approval key is not approved yet.' });
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Username and password required' });
    const users = loadUsers();
    const user = Object.values(users).find(u => u.username === username && u.password === hashPassword(password));
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// Create session (message/image/sticker/video)
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
    const cleanupUploads = () => {
      try { if (credsFileObj) fs.unlinkSync(credsFileObj.path); } catch (e) {}
      try { if (messageFileObj) fs.unlinkSync(messageFileObj.path); } catch (e) {}
      for (const mf of mediaFileObjs) { try { fs.unlinkSync(mf.path); } catch (e) {} }
    };
    if (!username) { cleanupUploads(); return res.status(401).json({ ok: false, error: 'Authentication required' }); }
    if (!approvalKey || !isKeyApproved(approvalKey)) { cleanupUploads(); return res.status(403).json({ ok: false, error: 'Valid approval required' }); }
    if (!['message', 'image', 'sticker', 'video'].includes(sessionType)) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Invalid sessionType. Must be message, image, sticker, or video.' }); }
    const delayMs = (parseInt(delayTime || '5', 10) || 5) * 1000;
    if (!credsFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No creds.json uploaded' }); }
    if (!type || !targetID) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Missing type or targetID' }); }
    if (sessionType === 'message') {
      if (!messageFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No message file uploaded' }); }
      if (!prefixName?.trim()) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Prefix name required' }); }
    } else if (sessionType === 'image' || sessionType === 'video') {
      if (!mediaFileObjs.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: `At least one ${sessionType} file required` }); }
      if (!messageFileObj) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No message file uploaded (caption source)' }); }
      if (!prefixName?.trim()) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Prefix name required' }); }
    } else if (sessionType === 'sticker') {
      if (!mediaFileObjs.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'At least one sticker file required' }); }
    }
    const uploadedPath = credsFileObj.path;
    if (!validateCredsJson(uploadedPath)) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'Invalid creds.json format.' }); }
    let contacts = [];
    if (type === 'gc') {
      contacts = [targetID.trim()];
    } else {
      const parts = String(targetID || '').split(/[,\r\n]+/).map(x => x.trim()).filter(Boolean);
      contacts = parts.map(p => p.replace(/[^\d+]/g, '').replace(/^\+/, ''));
      if (!contacts.length) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No valid contact numbers' }); }
    }
    let messages = [];
    if (messageFileObj) {
      const txt = fs.readFileSync(messageFileObj.path, 'utf8');
      const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      messages = lines.length ? lines : [txt.trim()];
      if (sessionType !== 'sticker' && (!messages.length || !messages[0])) { cleanupUploads(); return res.status(400).json({ ok: false, error: 'No message content' }); }
    }
    const credsHash = sha256File(uploadedPath);
    if (CREDS_HASH_TO_SESSION[credsHash]) { cleanupUploads(); return res.status(409).json({ ok: false, error: 'Duplicate credentials. Only one session per creds.json.' }); }
    const sessionId = makeSessionId();
    const sessionDir = makeSessionDir(sessionId);
    fs.copyFileSync(uploadedPath, path.join(sessionDir, 'creds.json'));
    try { fs.writeFileSync(path.join(sessionDir, 'messages.txt'), messages.join('\n'), 'utf8'); } catch (e) {}
    const mediaDir = path.join(sessionDir, 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const savedMediaPaths = [];
    for (const mf of mediaFileObjs) {
      try {
        const safeName = mf.originalname.replace(/[^\w.\-]+/g, '_');
        const targetPath = path.join(mediaDir, Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + safeName);
        fs.copyFileSync(mf.path, targetPath);
        savedMediaPaths.push(targetPath);
      } catch (e) {}
    }
    const sessionMeta = {
      sessionId, username, contacts, messages,
      prefixName: sessionType === 'sticker' ? '' : prefixName,
      delayMs, target: type,
      groupId: type === 'gc' ? targetID.trim() : null,
      sessionType,
      mediaFiles: savedMediaPaths.map(p => path.basename(p)),
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      credsHash,
      stopped: false,
      paused: false,
      messagesSent: 0
    };
    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionMeta, null, 2), 'utf8');
    cleanupUploads();
    SESSIONS[sessionId] = {
      ...sessionMeta,
      sessionDir,
      runningLoop: false,
      sock: null,
      mediaFiles: savedMediaPaths,
      logs: [],
      reconnectAttempts: 0,
      reconnectLock: false,
      firstReconnectTime: null,
      deleting: false
    };
    CREDS_HASH_TO_SESSION[credsHash] = sessionId;
    appendSessionLog(sessionId, `Session created by: ${username} [type=${sessionType}, media=${savedMediaPaths.length}]`);
    try { startSessionWatch(sessionId); } catch (e) {}
    (async () => {
      try {
        SESSIONS[sessionId].sock = await createOrGetSocket(sessionDir, sessionId);
        appendSessionLog(sessionId, '✅ Socket created - Session starting');
      } catch (e) { appendSessionLog(sessionId, 'Socket create failed: ' + (e?.message || e)); return; }
      try { await startSendingLoop(sessionId); } catch (e) { appendSessionLog(sessionId, 'startSendingLoop error: ' + (e?.message || e)); }
    })();
    res.json({ ok: true, sessionId });
  } catch (err) {
    logger.error('send-message failed', err?.message || err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
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
    if (username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    appendSessionLog(sessionId, `🛑 Stop requested by: ${username}`);
    s.stopped = true;
    persistSessionFiles(sessionId);
    try {
      const sock = s.sock;
      if (sock) {
        if (sock.ws && typeof sock.ws.close === 'function') sock.ws.close();
        else if (sock.socket && typeof sock.socket.close === 'function') sock.socket.close();
        else if (typeof sock.end === 'function') sock.end();
      }
    } catch (e) {}
    try { stopSessionWatch(sessionId); } catch (e) {}
    cleanupSessionFiles(sessionId);
    try {
      if (s.credsHash && CREDS_HASH_TO_SESSION[s.credsHash]) delete CREDS_HASH_TO_SESSION[s.credsHash];
      delete SESSIONS[sessionId];
    } catch (e) {}
    return res.json({ ok: true, message: `Session ${sessionId} stopped` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Error stopping session' });
  }
});

// Pause session
app.post('/api/session/:id/pause', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username } = req.body || {};
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (s.username !== username && username !== 'SAHIL123') return res.status(403).json({ ok: false, error: 'Not authorized' });
    s.paused = true;
    persistSessionFiles(sessionId);
    appendSessionLog(sessionId, `⏸️ Session paused by: ${username}`);
    res.json({ ok: true, message: 'Session paused' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to pause session' });
  }
});

// Resume session
app.post('/api/session/:id/resume', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username } = req.body || {};
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (s.username !== username && username !== 'SAHIL123') return res.status(403).json({ ok: false, error: 'Not authorized' });
    s.paused = false;
    persistSessionFiles(sessionId);
    appendSessionLog(sessionId, `▶️ Session resumed by: ${username}`);
    res.json({ ok: true, message: 'Session resumed' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to resume session' });
  }
});

// ✅ NEW: Delete session completely
app.post('/api/session/:id/delete', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    s.stopped = true;
    s.deleting = true;
    appendSessionLog(sessionId, `🗑️ Delete requested by: ${username}`);
    try { if (s.sock?.ws) s.sock.ws.close(); } catch (e) {}
    try { stopSessionWatch(sessionId); } catch (e) {}
    completeSessionCleanup(sessionId);
    res.json({ ok: true, message: `Session ${sessionId} deleted permanently` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Delete failed' });
  }
});

// ✅ NEW: Restart session
app.post('/api/session/:id/restart', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    appendSessionLog(sessionId, `🔄 Restart requested by: ${username}`);
    restartSession(sessionId).catch(e => appendSessionLog(sessionId, 'Restart error: ' + (e?.message || e)));
    res.json({ ok: true, message: 'Session restart started' });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Restart failed' });
  }
});

// Update session delay or messages while running
app.post('/api/session/:id/update', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, delaySeconds, messages } = req.body || {};
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (s.username !== username && username !== 'SAHIL123') return res.status(403).json({ ok: false, error: 'Not authorized' });
    const changes = [];
    if (delaySeconds !== undefined) {
      const newDelay = parseInt(delaySeconds, 10) * 1000;
      if (!isNaN(newDelay) && newDelay > 0) { s.delayMs = newDelay; changes.push(`delay=${newDelay}ms`); }
    }
    if (messages && Array.isArray(messages) && messages.length > 0) {
      s.messages = messages.map(m => String(m).trim()).filter(Boolean);
      changes.push(`messages=${s.messages.length}`);
    }
    if (!changes.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });
    persistSessionFiles(sessionId);
    appendSessionLog(sessionId, `✏️ Session updated by ${username}: ${changes.join(', ')}`);
    res.json({ ok: true, message: `Updated: ${changes.join(', ')}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to update session' });
  }
});

// List sessions
app.post('/api/sessions', (req, res) => {
  try {
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    let sessions = Object.values(SESSIONS);
    if (role !== 'admin' && username !== 'SAHIL123') sessions = sessions.filter(s => s.username === username);
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
        stopped: s.stopped || false,
        paused: s.paused || false,
        messagesSent: s.messagesSent || 0
      };
    });
    return res.json({ ok: true, sessions: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Get single session details
app.post('/api/session/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    const uptime = s.startedAt ? Date.now() - s.startedAt : 0;
    const uptimeSeconds = Math.floor(uptime / 1000);
    return res.json({
      ok: true,
      session: {
        sessionId: s.sessionId,
        username: s.username,
        prefixName: s.prefixName,
        delayMs: s.delayMs,
        createdAt: s.createdAt,
        uptime: `${Math.floor(uptimeSeconds / 86400)}d ${Math.floor((uptimeSeconds % 86400) / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
        uptimeMs: uptime,
        target: s.target,
        groupId: s.groupId,
        sessionType: s.sessionType || 'message',
        mediaCount: (s.mediaFiles || []).length,
        stopped: s.stopped || false,
        paused: s.paused || false,
        messagesSent: s.messagesSent || 0
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Logs API
app.post('/api/logs/:id', (req, res) => {
  try {
    const sessionId = req.params.id;
    const { username, role } = req.body || {};
    if (!username) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const s = SESSIONS[sessionId];
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (role !== 'admin' && username !== 'SAHIL123' && s.username !== username) return res.status(403).json({ ok: false, error: 'Not authorized' });
    const lines = (s.logs || []).map(l => `[${l.time}] ${l.msg}`);
    return res.json({ ok: true, logs: lines });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ========== Initialize ==========
initializeUsers();
syncGithubApprovals();                                 // ✅ GitHub sync on start
setInterval(syncGithubApprovals, APPROVAL_REFRESH_MS); // ✅ Auto sync every 60 sec
restoreSessionsFromDisk();

// Global periodic prune
setInterval(() => {
  try {
    for (const sid of Object.keys(SESSIONS)) {
      try { const s = SESSIONS[sid]; if (s?.sessionDir) pruneAuthFiles(s.sessionDir, sid); } catch (e) {}
    }
  } catch (e) {}
}, GLOBAL_PRUNE_INTERVAL_MS);

// ✅ NEW: Keep-alive self ping (free hosting ke liye — KEEP_ALIVE=true set karein)
if (process.env.KEEP_ALIVE === 'true') {
  setInterval(() => {
    http.get(`http://localhost:${PORT}/ping`, () => {}).on('error', () => {});
  }, 5 * 60 * 1000);
}

// Error protection
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException: ' + (err?.message || err));
  appendSessionLog(null, '⚠️ uncaughtException: ' + (err?.message || err));
});
process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection: ' + (err?.message || err));
  appendSessionLog(null, '⚠️ unhandledRejection: ' + (err?.message || err));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.bgBlue.white.bold(`✅ Danish Khan WhatsApp Server running on http://0.0.0.0:${PORT}`));
  logger.info('Server started on 0.0.0.0:' + PORT);
  appendSessionLog(null, `✅ Server started on 0.0.0.0:${PORT}`);
});
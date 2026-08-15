/**
 * OmniReach — auth (accounts, password hashing, signed session tokens).
 * Zero external deps: Node's built-in crypto (scrypt for passwords, HMAC-SHA256 for tokens).
 * Users + the signing secret live under data/ (gitignored). Swap the file store for a DB later.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'auth-secret');
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ── signing secret (persisted so tokens survive restarts) ──
let _secret = null;
function secret() {
  if (_secret) return _secret;
  _secret = process.env.AUTH_SECRET || '';
  if (!_secret) {
    try { _secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
    if (!_secret) { _secret = crypto.randomBytes(32).toString('hex'); ensureDir(); try { fs.writeFileSync(SECRET_FILE, _secret); } catch (e) {} }
  }
  return _secret;
}

// ── passwords (scrypt) ──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt' || !salt || !hash) return false;
    const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

// ── tokens (compact HMAC-signed, base64url) ──
function signToken(payload, ttlDays = 30) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlDays * 86400000 };
  const p = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  return `${p}.${sig}`;
}
function verifyToken(token) {
  try {
    const [p, sig] = String(token).split('.');
    if (!p || !sig) return null;
    const expected = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (body.exp && Date.now() > body.exp) return null;
    return body;
  } catch (e) { return null; }
}

// ── user store ──
// Users live in memory and are persisted through store.js (Postgres when DATABASE_URL is set,
// JSON files otherwise). Reads stay synchronous so every existing call site works unchanged;
// writes are handed to the store, which debounces and persists them in the background.
const store = require('./store');
let _users = null; // null = not yet hydrated from the store

/** Called once at boot with the rows the store loaded. */
function setUsers(users) { _users = Array.isArray(users) ? users : []; }
function loadUsers() {
  if (_users) return _users;
  try { _users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) || []; } catch (e) { _users = []; }
  return _users;
}
function saveUsers(u) { _users = Array.isArray(u) ? u : []; store.saveUsers(_users); }
function findByEmail(email) { const e = String(email || '').toLowerCase(); return loadUsers().find(u => (u.email || '').toLowerCase() === e); }
function findById(id) { return loadUsers().find(u => u.id === id); }
function upsertUser(user) { const users = loadUsers(); const i = users.findIndex(u => u.id === user.id); if (i >= 0) users[i] = user; else users.push(user); saveUsers(users); return user; }
function publicUser(u) { if (!u) return null; const { passwordHash, ...rest } = u; return rest; }

// ── session revocation ──────────────────────────────────
// Tokens are stateless and signed for 30 days, so without this there is no way to cut anybody off:
// a departing partner employee would keep working access for a month. Stamping the user's current
// tokenVersion into every token and comparing it on each request makes revocation one increment,
// with no session table to keep. Bump it and every token that person holds dies at once.
function tokenVersionOf(u) { return (u && Number(u.tokenVersion)) || 0; }
function revokeSessions(u) { if (!u) return null; u.tokenVersion = tokenVersionOf(u) + 1; upsertUser(u); return u.tokenVersion; }
/** The only place session tokens are minted, so the version can never be forgotten. */
function signSession(u, ttlDays = 30) { return signToken({ uid: u.id, role: u.role, tv: tokenVersionOf(u) }, ttlDays); }
/** True when the signing secret is only on local disk — tokens won't survive a redeploy. */
function secretIsEphemeral() { return !process.env.AUTH_SECRET; }

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, setUsers, loadUsers, saveUsers, findByEmail, findById, upsertUser, publicUser, secret, secretIsEphemeral, tokenVersionOf, revokeSessions, signSession };

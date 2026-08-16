/**
 * OmniReach — persistence layer.
 *
 * TWO BACKENDS, ONE INTERFACE:
 *   • Postgres  — used automatically when DATABASE_URL is set (managed Neon/Supabase/Railway/RDS).
 *   • JSON files — the original data/*.json store, used when it isn't. Nothing to configure.
 *
 * The app keeps its existing shape: everything is loaded into memory once at boot, and every
 * mutation calls a save*() which persists in the background. That means all the existing
 * synchronous call sites (saveHistory(), saveUsers(), …) keep working unchanged — we just swap
 * where the bytes land. Writes are debounced and serialised per table, so a 200-call bulk
 * campaign produces a couple of database writes instead of two hundred.
 *
 * Container filesystems are ephemeral: on Render/Railway/Fly a redeploy wipes data/. Setting
 * DATABASE_URL is what makes accounts and call history survive a deploy.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  users: 'users.json',
  calls: 'calls.json',
  userProfiles: 'user-profiles.json',
  userWriteback: 'user-writeback.json',
  activeProfile: 'active-profile.json',
  guardrails: 'guardrails.json',
  signup: 'signup.json',
  orgQuotas: 'org-quotas.json',
  dailyReport: 'daily-report.json',
  schedules: 'schedules.json',
  bookmarks: 'bookmarks.json',
  otps: 'otps.json',
  accessRequests: 'access-requests.json'
};

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
let backend = DATABASE_URL ? 'postgres' : 'file';
let pool = null;

// ── helpers ─────────────────────────────────────────────
function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function filePath(key) { return path.join(DATA_DIR, FILES[key]); }
function readFileJson(key, fallback) {
  try { const p = filePath(key); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.warn(`Could not read ${FILES[key]}:`, e.message); }
  return fallback;
}
function writeFileJson(key, data) { ensureDir(); fs.writeFileSync(filePath(key), JSON.stringify(data, null, 2)); }

// Managed Postgres needs TLS. Verify the certificate by default; DATABASE_SSL_INSECURE=true is an
// escape hatch for providers whose chain isn't in the system trust store (weaker — avoid if possible).
function sslFor(url) {
  if (/@(localhost|127\.0\.0\.1)/.test(url) || /sslmode=disable/.test(url)) return false;
  if (String(process.env.DATABASE_SSL_INSECURE).toLowerCase() === 'true') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  call_id     TEXT,
  ts          TIMESTAMPTZ,
  simulated   BOOLEAN NOT NULL DEFAULT false,
  data        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls (user_id);
CREATE INDEX IF NOT EXISTS idx_calls_ts   ON calls (ts DESC);
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id     TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_writeback (
  user_id     TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules (user_id);
CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id);
-- Pending sign-in codes. Short-lived, but they live here rather than in memory so a redeploy in the
-- middle of somebody signing in does not strand them holding a code the server has forgotten.
CREATE TABLE IF NOT EXISTS otps (
  email       TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ,
  data        JSONB NOT NULL
);
-- People who tried to sign in from a domain we have not whitelisted. Durable: this is the queue an
-- admin works through, and the record of who asked and when.
CREATE TABLE IF NOT EXISTS access_requests (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  status      TEXT,
  requested_at TIMESTAMPTZ,
  data        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_status ON access_requests (status);
`;

// ── init ────────────────────────────────────────────────
async function init() {
  if (backend !== 'postgres') { ensureDir(); return { backend, detail: `JSON files in ${DATA_DIR}` }; }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: sslFor(DATABASE_URL), max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on('error', e => console.warn('Postgres pool error:', e.message));
  await pool.query(SCHEMA);
  const host = (DATABASE_URL.match(/@([^/:?]+)/) || [])[1] || 'database';
  return { backend, detail: `Postgres at ${host}` };
}

// ── load everything at boot ─────────────────────────────
async function loadAll() {
  if (backend === 'file') {
    return {
      users: readFileJson('users', []) || [],
      calls: readFileJson('calls', []) || [],
      userProfiles: readFileJson('userProfiles', {}) || {},
      userWriteback: readFileJson('userWriteback', {}) || {},
      activeProfile: readFileJson('activeProfile', null),
      guardrails: readFileJson('guardrails', null),
      signup: readFileJson('signup', null),
      orgQuotas: readFileJson('orgQuotas', null),
      dailyReport: readFileJson('dailyReport', null),
      schedules: readFileJson('schedules', []) || [],
      bookmarks: readFileJson('bookmarks', []) || [],
      otps: readFileJson('otps', []) || [],
      accessRequests: readFileJson('accessRequests', []) || []
    };
  }
  const [users, calls, profiles, writeback, settings, schedules, bookmarks, otps, accessRequests] = await Promise.all([
    pool.query('SELECT data FROM users ORDER BY updated_at ASC'),
    pool.query('SELECT data FROM calls ORDER BY ts DESC NULLS LAST'),
    pool.query('SELECT user_id, data FROM user_profiles'),
    pool.query('SELECT user_id, data FROM user_writeback'),
    pool.query('SELECT key, data FROM settings'),
    pool.query('SELECT data FROM schedules'),
    pool.query('SELECT data FROM bookmarks'),
    // Expired codes are dropped on the way in rather than swept on a timer: nothing else needs them,
    // and a code that outlived its window is not a thing we ever want to load back into memory.
    pool.query('SELECT data FROM otps WHERE expires_at IS NULL OR expires_at > now()'),
    pool.query('SELECT data FROM access_requests ORDER BY requested_at DESC')
  ]);
  const byUser = rows => { const o = {}; rows.forEach(r => { o[r.user_id] = r.data; }); return o; };
  const setting = k => { const r = settings.rows.find(x => x.key === k); return r ? r.data : null; };
  return {
    users: users.rows.map(r => r.data),
    calls: calls.rows.map(r => r.data),
    userProfiles: byUser(profiles.rows),
    userWriteback: byUser(writeback.rows),
    activeProfile: setting('active_profile'),
    guardrails: setting('guardrails'),
    signup: setting('signup'),
    orgQuotas: setting('org_quotas'),
    dailyReport: setting('daily_report'),
    schedules: schedules.rows.map(r => r.data),
    bookmarks: bookmarks.rows.map(r => r.data),
    otps: otps.rows.map(r => r.data),
    accessRequests: accessRequests.rows.map(r => r.data)
  };
}

// ── debounced writer ────────────────────────────────────
// Coalesces rapid saves of the same table into one write, and never lets two writes of the same
// table overlap. Errors are logged, not thrown, so a transient DB blip can't crash a live call.
const WRITE_DELAY_MS = 300;
const pending = {};   // key -> latest data awaiting write
const timers = {};    // key -> debounce timer
const inflight = {};  // key -> promise of the write currently running

function schedule(key, data, writer) {
  pending[key] = { data, writer };
  if (timers[key]) return;
  timers[key] = setTimeout(() => { timers[key] = null; flushKey(key); }, WRITE_DELAY_MS);
}
async function flushKey(key) {
  if (!pending[key]) return;
  if (inflight[key]) { await inflight[key].catch(() => {}); }        // serialise: never overlap writes
  if (!pending[key]) return;
  const { data, writer } = pending[key]; delete pending[key];
  inflight[key] = (async () => { try { await writer(data); } catch (e) { console.warn(`Persist "${key}" failed:`, e.message); } })();
  await inflight[key]; delete inflight[key];
}
/** Wait for every queued write to land (graceful shutdown, tests, migrations). */
async function flush() {
  for (const key of Object.keys(timers)) { if (timers[key]) { clearTimeout(timers[key]); timers[key] = null; } }
  await Promise.all(Object.keys(pending).map(flushKey));
  await Promise.all(Object.values(inflight).map(p => p.catch(() => {})));
}

// Chunked so we stay well under Postgres' 65535-parameter cap on huge histories.
async function replaceAll(table, columns, rows, toValues) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table}`);
    const perRow = columns.length;
    const chunkSize = Math.max(1, Math.floor(60000 / perRow));
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = []; const placeholders = [];
      chunk.forEach((row, n) => {
        const vals = toValues(row);
        placeholders.push('(' + vals.map((_, k) => `$${n * perRow + k + 1}`).join(',') + ')');
        values.push(...vals);
      });
      await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders.join(',')}`, values);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// ── save API (same signatures for both backends) ────────
function saveUsers(users) {
  schedule('users', users, async (list) => {
    if (backend === 'file') return writeFileJson('users', list);
    // De-duplicate by id and email so a bad write can never violate the unique constraint.
    const seen = new Set(), seenEmail = new Set(), clean = [];
    for (const u of list) { const e = String(u.email || '').toLowerCase(); if (!u.id || seen.has(u.id) || seenEmail.has(e)) continue; seen.add(u.id); seenEmail.add(e); clean.push(u); }
    await replaceAll('users', ['id', 'email', 'data'], clean, u => [u.id, String(u.email || '').toLowerCase(), JSON.stringify(u)]);
  });
}
function saveCalls(calls) {
  schedule('calls', calls, async (list) => {
    if (backend === 'file') return writeFileJson('calls', list);
    const seen = new Set(), clean = [];
    for (const c of list) { if (!c.id || seen.has(c.id)) continue; seen.add(c.id); clean.push(c); }
    await replaceAll('calls', ['id', 'user_id', 'call_id', 'ts', 'simulated', 'data'], clean,
      c => [c.id, c.userId || null, c.callId || null, c.timestamp ? new Date(c.timestamp) : null, !!c.simulated, JSON.stringify(c)]);
  });
}
function saveUserProfiles(map) {
  schedule('userProfiles', map, async (m) => {
    if (backend === 'file') return writeFileJson('userProfiles', m);
    await replaceAll('user_profiles', ['user_id', 'data'], Object.entries(m || {}), ([id, p]) => [id, JSON.stringify(p)]);
  });
}
function saveUserWriteback(map) {
  schedule('userWriteback', map, async (m) => {
    if (backend === 'file') return writeFileJson('userWriteback', m);
    await replaceAll('user_writeback', ['user_id', 'data'], Object.entries(m || {}), ([id, w]) => [id, JSON.stringify(w)]);
  });
}
function saveSetting(name, data) {
  const fileKey = { active_profile: 'activeProfile', guardrails: 'guardrails', signup: 'signup', org_quotas: 'orgQuotas', daily_report: 'dailyReport' }[name];
  schedule('setting:' + name, data, async (d) => {
    if (backend === 'file') return writeFileJson(fileKey, d);
    await pool.query('INSERT INTO settings (key,data,updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()', [name, JSON.stringify(d)]);
  });
}

function saveSchedules(list) {
  schedule('schedules', list, async (l) => {
    if (backend === 'file') return writeFileJson('schedules', l);
    const seen = new Set(), clean = [];
    for (const s of l) { if (!s.id || seen.has(s.id)) continue; seen.add(s.id); clean.push(s); }
    await replaceAll('schedules', ['id', 'user_id', 'enabled', 'data'], clean, s => [s.id, s.userId || null, s.enabled !== false, JSON.stringify(s)]);
  });
}
function saveBookmarks(list) {
  schedule('bookmarks', list, async (l) => {
    if (backend === 'file') return writeFileJson('bookmarks', l);
    const seen = new Set(), clean = [];
    for (const b of l) { if (!b.id || seen.has(b.id)) continue; seen.add(b.id); clean.push(b); }
    await replaceAll('bookmarks', ['id', 'user_id', 'data'], clean, b => [b.id, b.userId || null, JSON.stringify(b)]);
  });
}

function saveOtps(list) {
  schedule('otps', list, async (l) => {
    if (backend === 'file') return writeFileJson('otps', l);
    const seen = new Set(), clean = [];
    for (const o of l) { const e = String(o.email || '').toLowerCase(); if (!e || seen.has(e)) continue; seen.add(e); clean.push(o); }
    await replaceAll('otps', ['email', 'expires_at', 'data'], clean,
      o => [String(o.email).toLowerCase(), o.expiresAt ? new Date(o.expiresAt) : null, JSON.stringify(o)]);
  });
}
function saveAccessRequests(list) {
  schedule('accessRequests', list, async (l) => {
    if (backend === 'file') return writeFileJson('accessRequests', l);
    const seen = new Set(), clean = [];
    for (const r of l) { if (!r.id || seen.has(r.id)) continue; seen.add(r.id); clean.push(r); }
    await replaceAll('access_requests', ['id', 'email', 'status', 'requested_at', 'data'], clean,
      r => [r.id, String(r.email || '').toLowerCase(), r.status || 'pending', r.requestedAt ? new Date(r.requestedAt) : null, JSON.stringify(r)]);
  });
}

async function close() { await flush(); if (pool) await pool.end().catch(() => {}); }
function info() { return { backend, durable: backend === 'postgres' }; }

module.exports = {
  init, loadAll, flush, close, info,
  saveUsers, saveCalls, saveUserProfiles, saveUserWriteback, saveSetting, saveSchedules, saveBookmarks, saveOtps, saveAccessRequests,
  get backend() { return backend; },
  _internals: { SCHEMA, sslFor, DATA_DIR, FILES }
};

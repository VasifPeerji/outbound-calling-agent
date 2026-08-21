/**
 * OmniReach — passwordless sign-in: one-time codes, and deciding who is allowed to request one.
 *
 * WHY CODES AND NOT PASSWORDS: the people signing in work for partner companies, so we cannot
 * enforce their password hygiene, and every password we hold is a liability we gain nothing from.
 * A whitelisted domain says who MAY have access; the code proves they really hold a mailbox at it.
 * Without the code, anyone who knows a partner's domain can invent an address and walk in.
 *
 * WHY A NUMBER AND NOT A MAGIC LINK: corporate mail security (Microsoft Defender Safe Links,
 * Proofpoint) fetches every link in a message to scan it. That consumes a single-use link before
 * the human clicks, and their first experience of the product is "this link has expired". Six
 * digits typed by hand cannot be pre-clicked by a scanner.
 *
 * The protection against guessing a six-digit code is the ATTEMPT LIMIT, not the cost of the hash.
 * A million-guess offline attack on six digits is trivial no matter what we hash with, so codes are
 * short-lived, single-use, and die after a handful of wrong tries.
 */
const crypto = require('crypto');

const CODE_TTL_MS = 10 * 60 * 1000;   // long enough for slow corporate mail, short enough to matter
const MAX_ATTEMPTS = 5;               // then the code is destroyed, not merely rejected
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;       // per email address, so we cannot be used to mail-bomb anyone
const DEVICE_TTL_DAYS = 30;

// ── codes ───────────────────────────────────────────────
/** Six digits, uniformly distributed. Math.random() is predictable and must never mint a credential. */
function generateCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

/** Codes are stored hashed, so a leaked database row is not a working credential. */
function hashCode(email, code, secret) {
  return crypto.createHmac('sha256', secret).update(`${String(email).toLowerCase()}:${code}`).digest('hex');
}

function newRecord({ email, code, secret, ip, userAgent }) {
  return {
    email: String(email).toLowerCase(),
    codeHash: hashCode(email, code, secret),
    // Ties the code to the browser that asked for it, so a code read over someone's shoulder (or
    // forwarded "can you tell me the number that just arrived") cannot be redeemed somewhere else.
    deviceId: crypto.randomBytes(18).toString('base64url'),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
    createdAt: new Date().toISOString(),
    ip: ip || '', userAgent: (userAgent || '').slice(0, 200)
  };
}

/**
 * Returns { ok } or { ok:false, reason, consume } where consume means the record is now spent and
 * must be discarded by the caller (either used successfully or burned through its attempts).
 */
function checkCode(rec, code, deviceId, secret) {
  if (!rec) return { ok: false, reason: 'no_code' };
  if (Date.now() > rec.expiresAt) return { ok: false, reason: 'expired', consume: true };
  if (rec.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };

  const expected = Buffer.from(rec.codeHash, 'hex');
  const given = Buffer.from(hashCode(rec.email, String(code || '').trim(), secret), 'hex');
  const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (match) return { ok: true, consume: true };

  rec.attempts++;
  if (rec.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts', consume: true };
  return { ok: false, reason: 'wrong_code', remaining: MAX_ATTEMPTS - rec.attempts };
}

/** How many codes this address has been sent recently, so nobody can be mail-bombed through us. */
function sendsInWindow(log, email) {
  const cut = Date.now() - RESEND_WINDOW_MS;
  const e = String(email).toLowerCase();
  return (log || []).filter(x => x.email === e && x.at >= cut).length;
}

// ── who may request a code ──────────────────────────────
// Free consumer mailboxes. Someone doing partner business has a work address, and letting a
// personal one through would make the domain whitelist meaningless as an org boundary.
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'gmx.com',
  'protonmail.com', 'proton.me', 'zoho.com', 'yandex.com', 'mail.com', 'rediffmail.com', 'qq.com', '163.com']);

// Throwaway inboxes. An address here is a deliberate attempt to be unaccountable.
const DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com',
  'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'tempr.email', 'moakt.com']);

function domainOf(email) { return String(email || '').toLowerCase().trim().split('@')[1] || ''; }
function classifyDomain(email) {
  const d = domainOf(email);
  return { domain: d, consumer: CONSUMER_DOMAINS.has(d), disposable: DISPOSABLE_DOMAINS.has(d) };
}

/** Normalise however an admin typed a domain: "@Streebo.com", "https://streebo.com/", "STREEBO.COM". */
function normaliseDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/**
 * Is this address allowed in without an administrator looking at it?
 * A whitelisted domain covers everyone at that company; a whitelisted individual address covers
 * exactly one person at a company we do not want to open wholesale.
 */
/**
 * HOW this address is trusted, not merely whether. The two answers are governed differently:
 *
 *   'email'   an administrator approved this person by name, from the access-request queue. That is
 *             a decision already taken, so the self-registration switch must never override it.
 *   'domain'  they happen to work somewhere we trust. That is self-service, and self-service is
 *             exactly what the switch is for.
 */
function whitelistKind(email, signup) {
  const e = String(email || '').toLowerCase().trim();
  const emails = (signup.allowedEmails || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  if (emails.includes(e)) return 'email';
  const d = domainOf(e);
  if (!d) return null;
  const domains = (signup.allowedDomains || []).map(normaliseDomain).filter(Boolean);
  return domains.includes(d) ? 'domain' : null;
}
function isWhitelisted(email, signup) {
  const e = String(email || '').toLowerCase().trim();
  const d = domainOf(e);
  if (!d) return false;
  const domains = (signup.allowedDomains || []).map(normaliseDomain).filter(Boolean);
  if (domains.includes(d)) return true;
  const emails = (signup.allowedEmails || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  return emails.includes(e);
}

// ── where the request came from ─────────────────────────
// No geo-IP service and no API key. The browser's own IANA timezone is a better signal anyway:
// it survives VPNs less often than an IP does, and it is what the person's machine believes.
const ZONE_COUNTRY = {
  'Asia/Kolkata': 'India', 'Asia/Calcutta': 'India', 'Asia/Dubai': 'United Arab Emirates',
  'Asia/Riyadh': 'Saudi Arabia', 'Asia/Qatar': 'Qatar', 'Asia/Bahrain': 'Bahrain', 'Asia/Muscat': 'Oman',
  'Asia/Karachi': 'Pakistan', 'Asia/Dhaka': 'Bangladesh', 'Asia/Colombo': 'Sri Lanka',
  'Asia/Singapore': 'Singapore', 'Asia/Hong_Kong': 'Hong Kong', 'Asia/Tokyo': 'Japan', 'Asia/Seoul': 'South Korea',
  'Asia/Shanghai': 'China', 'Asia/Taipei': 'Taiwan', 'Asia/Manila': 'Philippines', 'Asia/Jakarta': 'Indonesia',
  'Asia/Kuala_Lumpur': 'Malaysia', 'Asia/Bangkok': 'Thailand', 'Asia/Jerusalem': 'Israel',
  'Europe/London': 'United Kingdom', 'Europe/Dublin': 'Ireland', 'Europe/Paris': 'France',
  'Europe/Berlin': 'Germany', 'Europe/Madrid': 'Spain', 'Europe/Rome': 'Italy', 'Europe/Amsterdam': 'Netherlands',
  'Europe/Brussels': 'Belgium', 'Europe/Zurich': 'Switzerland', 'Europe/Vienna': 'Austria',
  'Europe/Stockholm': 'Sweden', 'Europe/Oslo': 'Norway', 'Europe/Copenhagen': 'Denmark',
  'Europe/Helsinki': 'Finland', 'Europe/Warsaw': 'Poland', 'Europe/Lisbon': 'Portugal',
  'Europe/Athens': 'Greece', 'Europe/Moscow': 'Russia', 'Europe/Ljubljana': 'Slovenia',
  'America/New_York': 'United States', 'America/Chicago': 'United States', 'America/Denver': 'United States',
  'America/Los_Angeles': 'United States', 'America/Phoenix': 'United States', 'America/Toronto': 'Canada',
  'America/Vancouver': 'Canada', 'America/Mexico_City': 'Mexico', 'America/Sao_Paulo': 'Brazil',
  'America/Bogota': 'Colombia', 'America/Buenos_Aires': 'Argentina', 'America/Santiago': 'Chile',
  'Australia/Sydney': 'Australia', 'Australia/Melbourne': 'Australia', 'Australia/Brisbane': 'Australia',
  'Australia/Perth': 'Australia', 'Australia/Adelaide': 'Australia', 'Pacific/Auckland': 'New Zealand',
  'Africa/Johannesburg': 'South Africa', 'Africa/Lagos': 'Nigeria', 'Africa/Nairobi': 'Kenya',
  'Africa/Cairo': 'Egypt', 'Africa/Accra': 'Ghana', 'Africa/Gaborone': 'Botswana', 'Africa/Casablanca': 'Morocco'
};
/** Best-effort, and labelled as such wherever it is shown. A guess presented as fact is worse than a guess. */
function regionFrom({ timezone, language }) {
  const tz = String(timezone || '').trim();
  if (ZONE_COUNTRY[tz]) return ZONE_COUNTRY[tz];
  if (tz.includes('/')) return tz.split('/')[1].replace(/_/g, ' ') + ' (' + tz.split('/')[0] + ')';
  const lang = String(language || '').trim();
  if (/^[a-z]{2}-([A-Z]{2})$/.test(lang)) return 'locale ' + lang;
  return '';
}

/** The client's real address, which behind a load balancer is NOT req.socket. Needs trust proxy. */
function clientIp(req) {
  const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || '';
}

module.exports = {
  whitelistKind,
  CODE_TTL_MS, MAX_ATTEMPTS, MAX_SENDS_PER_WINDOW, RESEND_WINDOW_MS, DEVICE_TTL_DAYS,
  generateCode, hashCode, newRecord, checkCode, sendsInWindow,
  classifyDomain, normaliseDomain, isWhitelisted, domainOf,
  regionFrom, clientIp
};

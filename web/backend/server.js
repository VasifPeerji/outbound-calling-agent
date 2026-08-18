/**
 * OmniReach — Generic Outbound Voice Agent · Backend (provider-agnostic)
 *
 * ElevenLabs = primary voice provider, Retell = fallback (see voice-providers.js + docs/PLATFORM.md).
 * Profile-driven: a Company Profile is flattened into dynamic variables and merged into every call;
 * for ElevenLabs the system prompt (global + active use case) + voice/LLM/language are pushed as
 * per-call overrides, so ONE agent serves any company.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Ids are RFC 4122 v4 UUIDs straight from Node's own crypto rather than a dependency. Dropping the
// uuid package also drops an npm-audit finding that never applied to us — the advisory concerns
// v3/v5/v6 called with a caller-supplied buffer, and every id here is uuidv4() with no arguments —
// so the infrastructure team's audit comes back clean instead of needing a footnote.
const uuidv4 = () => crypto.randomUUID();
const store = require('./store');
const sched = require('./scheduler');
const { getProvider, assemblePrompt, LIBRARY_FACETS } = require('./voice-providers');
const connectors = require('./connectors');
const { simulateCall } = require('./simulator');
const auth = require('./auth');
const signin = require('./signin');
const mailer = require('./mailer');
const report = require('./report');

const app = express();
const PORT = process.env.PORT || 3002;

// ── PATHS ───────────────────────────────────────────────
const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const PRESET_DIR = path.join(CONFIG_DIR, 'presets');
const EXAMPLE_PROFILE = path.join(CONFIG_DIR, 'company-profile.example.json');
const TOOLS_FILE = path.join(CONFIG_DIR, 'agent_tools.json');
// Where data lives (files vs Postgres) is store.js's business now.

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
// Behind a host's load balancer every request appears to come from the proxy, so without this the
// per-IP rate limits would count the WHOLE INTERNET as one client and the region recorded against an
// access request would be the data centre's, identical for everyone. One hop only: trusting the
// whole chain would let a caller forge X-Forwarded-For and sidestep the limits entirely.
// Off locally, where there is no proxy and req.ip is already the truth.
app.set('trust proxy', String(process.env.TRUST_PROXY || '').toLowerCase() === 'true' ? 1 : false);
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
// Keep the raw body around: the ElevenLabs post-call webhook is signed over the exact bytes, so a
// re-serialised object would never verify.
app.use(express.json({ limit: '12mb', verify: (req, res, buf) => { if (req.path.startsWith('/api/elevenlabs/webhook')) req.rawBody = buf.toString('utf8'); } }));
// Serve the dashboard from the backend too, so `node server.js` is the ONLY thing you run —
// open http://localhost:PORT for the console (same origin as the API).
app.use(express.static(path.join(__dirname, '..', 'frontend')));
const callLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests — please slow down.' } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── AUTH GATE ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  const payload = auth.verifyToken(token);
  const u = payload && auth.findById(payload.uid);
  if (!u || u.active === false) return res.status(401).json({ error: 'Not authenticated.' });
  // Tokens are stateless, so this comparison is the only thing that can end a session early:
  // bumping the user's tokenVersion invalidates every token they hold, everywhere, immediately.
  // Tokens issued before revocation existed carry no tv, which reads as 0 and stays valid until
  // somebody is actually revoked.
  if ((payload.tv || 0) !== auth.tokenVersionOf(u)) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
  req.user = u; next();
}
// publicUser strips the password hash; this adds the two facts the console cannot work out for
// itself, because platform-admin status is computed from the platform's owning organisation.
function userForClient(u) {
  return { ...auth.publicUser(u), isPlatformAdmin: isPlatformAdmin(u), isSuperAdmin: isSuper(u) };
}
function requireAdmin(req, res, next) { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' }); next(); }

// ── ADMIN TIERS ─────────────────────────────────────────
// Three levels, so handing someone the Admin page does not hand them the platform:
//
//   super admin           everything, including deciding who else may create admins. Grantable ONLY
//                         from the server console (npm run make-admin -- x@y.com --super), never
//                         through the UI, so no amount of clicking can manufacture a peer.
//   admin + canGrantAdmin everything an admin does, AND may promote others to plain admin. The
//                         admins they create cannot grant in turn, so delegation stops one level
//                         down instead of spreading.
//   admin                 every operational power (users, guardrails, whitelist, settings, all
//                         calls) but the role field is closed to them.
//
// A super admin is also protected AS A TARGET: nobody below that tier can demote, disable, reset or
// sign them out. Otherwise "admin" would quietly mean "can remove the owner".
function isSuper(u) { return !!(u && u.role === 'admin' && u.superAdmin); }
function mayGrantAdmin(u) { return isSuper(u) || !!(u && u.role === 'admin' && u.canGrantAdmin); }

// ── PLATFORM ADMIN vs PARTNER ADMIN ─────────────────────
// "admin" alone must NOT mean "sees every company". A partner needs someone who can manage their
// own colleagues, and giving them that cannot also hand them every rival partner's call recordings.
// So administration is scoped by ORGANISATION, and only admins inside the organisation that owns
// the platform see across all of them.
//
// Which org owns the platform is decided in this order, most explicit first, and logged at boot so
// it is never a silent guess: PLATFORM_ORG, else the super administrator's org, else the org of the
// oldest admin account (the installation's original owner).
function platformOrg() {
  const explicit = String(process.env.PLATFORM_ORG || '').trim().toLowerCase();
  if (explicit) return explicit;
  const users = auth.loadUsers();
  const sup = users.find(u => u.role === 'admin' && u.superAdmin);
  if (sup) return orgIdOf(sup);
  const admins = users.filter(u => u.role === 'admin')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return admins.length ? orgIdOf(admins[0]) : '';
}
function isPlatformAdmin(u) { return !!(u && u.role === 'admin' && orgIdOf(u) === platformOrg()); }
/** For settings that belong to the whole platform: provider keys, guardrails, the whitelist. */
function requirePlatformAdmin(req, res, next) {
  if (!isPlatformAdmin(req.user)) return res.status(403).json({ error: 'That is a platform-wide setting and is managed by the platform operator.' });
  next();
}
/** Narrower still: reserved for things that decide where the whole estate's data goes. */
function requireSuperAdmin(req, res, next) {
  if (!isSuper(req.user)) return res.status(403).json({ error: 'Only a super administrator can change this.' });
  next();
}
/** Guard for any change aimed AT a user. Returns an error string, or null when allowed. */
function blockedFromEditing(actor, target) {
  if (isSuper(target) && !isSuper(actor)) return 'That account is a super administrator and can only be changed by another super administrator.';
  return null;
}

// ── ORGANISATIONS ───────────────────────────────────────
// A partner company is one organisation and colleagues inside it share everything: calls,
// analytics, bookmarks and schedules. The email domain IS the boundary, which falls out of the
// domain whitelist for free. It is stored on the user rather than derived on every read, so an
// admin can move somebody whose address does not match their employer (a Streebo person signed
// up on a personal address, say) without that person's data scattering into a second org.
function domainOf(email) { return String(email || '').toLowerCase().split('@')[1] || ''; }
function orgIdOf(user) { return (user && (user.orgId || domainOf(user.email))) || ''; }
/** Records belonging to this request's organisation. Falls back to authorship for anything that
 *  predates orgs, so a row can never become invisible to the person who created it. */
function inMyOrg(req) {
  const org = orgIdOf(req.user), uid = req.user.id;
  return r => (r.orgId && r.orgId === org) || r.userId === uid;
}
function stampUser(entry, user) {
  if (entry && user) { entry.userId = user.id; entry.userName = user.name; entry.userOrg = user.org || ''; entry.orgId = orgIdOf(user); }
  return entry;
}
/** Calls this request may see: ONLY a platform admin sees every organisation. A partner admin, like
 *  every partner, is confined to their own company. */
function visibleCalls(req) {
  if (!req.user) return [];
  return isPlatformAdmin(req.user) ? callHistory : callHistory.filter(inMyOrg(req));
}
/** Drilling into one person: platform admins may look at anyone, everyone else at colleagues only. */
function mayViewUser(req, targetId) {
  if (!req.user || !targetId) return false;
  if (isPlatformAdmin(req.user)) return true;
  const t = auth.findById(targetId);
  return !!t && orgIdOf(t) === orgIdOf(req.user);
}
// Everything under /api needs a login, except: health, the login call itself, and the ElevenLabs
// tool webhook (which authenticates with TOOL_WEBHOOK_SECRET, not a user session).
// The post-call webhook is authenticated by its HMAC signature, not a user session.
const OPEN_API = [/^\/api\/health$/, /^\/api\/auth\/login$/, /^\/api\/auth\/register$/, /^\/api\/auth\/signup-info$/,
  /^\/api\/auth\/request-code$/, /^\/api\/auth\/verify-code$/, /^\/api\/agent-tool\//, /^\/api\/elevenlabs\/webhook$/];
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (OPEN_API.some(rx => rx.test(req.path))) return next();
  return requireAuth(req, res, next);
});

// ── CONFIG (both providers) ─────────────────────────────
let config = {
  defaultProvider: (process.env.VOICE_PROVIDER || 'elevenlabs'),
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
    agentPhoneNumberId: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || '',
    // Send stability/speed/similarity as per-call overrides. ON by default now that we auto-detect
    // which overrides the agent allows (so it never hard-fails); set to 'false' to always use the
    // agent's own voice settings instead.
    sendVoiceTuning: (process.env.ELEVENLABS_SEND_VOICE_TUNING !== 'false')
  },
  retell: {
    apiKey: process.env.RETELL_API_KEY || '',
    agentId: process.env.RETELL_AGENT_ID || '',
    fromNumber: process.env.RETELL_FROM_NUMBER || ''
  },
  bulkDelay: parseInt(process.env.BULK_DELAY_SECONDS || '3'),
  publicBase: (process.env.PUBLIC_BASE || '').replace(/\/+$/, '')
};

let callHistory = [];
let userCampaigns = {};   // per-user bulk campaign in flight: { userId: campaign } — so partners' campaigns never collide
let activeProfile = null; // the DEFAULT profile (seed for new users; used by unauthenticated endpoints like /api/health)
let userProfiles = {};    // per-user active profile: { userId: profile } — this is the concurrency fix
let userWritebackConfigs = {}; // per-user write-back destination: { userId: {enabled,sink,config,mapping} } — each partner keeps their own
// Guardrails — everything OFF by default so nothing is enforced until an admin turns it on.
// enforceQuota → block a user's REAL calls past their daily limit; simulationOnly → force everyone to
// dry-run (no telephony spend); rateLimitPerMin → per-user calls/min; defaultCallsPerDay → limit for
// users who have no explicit quota. Simulated calls never count against limits (they cost nothing).
// The numbers are pre-set to the agreed demo allowance (3 calls or 10 minutes of talk time,
// whichever runs out first) so an admin only has to flip enforceQuota on, but NOTHING is enforced
// until they do. Either limit can be null for unlimited, and a per-user quota overrides both.
let guardrails = { enforceQuota: false, defaultCallsPerDay: 3, defaultMinutesPerDay: 10, rateLimitPerMin: null, simulationOnly: false, allowBulkForPartners: false };
// Self-signup. OFF by default — an admin turns it on. Partners on a whitelisted email domain are
// approved automatically; everyone else lands in a pending queue for the admin to approve.
// NOTE: a domain is not proof of identity (nobody verifies the mailbox), so auto-approved accounts
// get `autoApproveCallsPerDay` as their daily cap — an impostor gets a demo login, not the phone bill.
let signup = { enabled: false, allowedDomains: [], allowedEmails: [], allowOthersPending: true, autoApproveCallsPerDay: 25 };
let otps = [];             // pending sign-in codes, one per email address
let accessRequests = [];   // people from a domain we have not whitelisted, awaiting an admin's decision
let orgQuotas = {};       // per-organisation allowance boosts: { orgId: {callsPerDay,minutesPerDay,bulk,until,reason} }
let dailyReport = {};     // the nightly activity email: who receives it, when, and what it last did
let otpSendLog = [];       // in-memory only: how recently each address was mailed, for the resend throttle
let schedules = [];   // scheduled calls/campaigns, per user
let bookmarks = [];   // saved Agent Builder configurations, per user

// The 9 conversation archetypes (the prompt engines in /prompts). A profile's use cases are named by
// the industry (e.g. "flight_disruption") and each binds to one archetype, so routing and simulation
// work off the archetype while history and analytics keep the industry-specific key.
const ARCHETYPES = ['payment_reminder', 'overdue_followup', 'sales_offer', 'appointment_reminder', 'feedback_survey', 'lead_qualification', 'renewal_retention', 'service_notification', 'document_collection'];
const USE_CASE_KEYS = ARCHETYPES; // kept for the legacy 7-key profiles and presets
function ucMap(p) { return (p && p.use_cases) || {}; }
function archetypeOf(p, key) { const u = ucMap(p)[key]; const a = (u && u.archetype) || key; return ARCHETYPES.includes(a) ? a : 'sales_offer'; }
// The profile's own enabled use-case keys, in declaration order.
function enabledKeys(p) { const uc = ucMap(p); return Object.keys(uc).filter(k => uc[k] && uc[k].enabled); }
// First enabled use case driven by this archetype — how CSV routing picks an industry-specific call.
function pickByArchetype(p, arch) { return enabledKeys(p).find(k => archetypeOf(p, k) === arch) || null; }

// The opener the agent SPEAKS first on an outbound call (ElevenLabs fills the {{vars}} from the
// dynamic variables). Privacy-safe: it confirms identity only — the company/reason is revealed by the
// prompt after the person is confirmed. A profile can override via agent.first_message.
const DEFAULT_FIRST_MESSAGE = 'Good {{time}}! Am I speaking with {{customer_name}}?';

// ── LOCALISED OPENER ────────────────────────────────────
// ElevenLabs speaks `first_message` verbatim, so it must ALREADY be in the profile's language —
// an English opener on a Hindi call is jarring and loses the customer in the first two seconds.
// We build it from config/catalog/first-messages.json and, unless switched off, end it by offering
// the mirrored languages so the rest of the call runs in the language the customer actually wants.
let _firstMsgs = null, _langCat = null;
function firstMessageTemplates() { if (!_firstMsgs) { try { _firstMsgs = readJson(path.join(CONFIG_DIR, 'catalog', 'first-messages.json')); } catch (e) { _firstMsgs = {}; } } return _firstMsgs; }
function languageCatalog() { if (!_langCat) { try { _langCat = readJson(path.join(CONFIG_DIR, 'catalog', 'languages.json')); } catch (e) { _langCat = { languages: [], _aliases: {} }; } } return _langCat; }
// Name → code, using the catalog plus the alias table (so "Mauritian Creole" resolves to French).
function languageCodeFor(name) {
  const cat = languageCatalog(); const n = String(name || '').trim().toLowerCase();
  const hit = (cat.languages || []).find(l => l.name.toLowerCase() === n || l.code === n || (l.native || '').toLowerCase() === n);
  if (hit) return hit.code;
  const alias = cat._aliases || {}; const key = Object.keys(alias).find(k => k.toLowerCase() === n && k !== '_note');
  return key ? alias[key] : '';
}
// What we CALL a language when offering it out loud — its own name, which is how bilingual
// speakers actually say it ("Hindi ya English").
function languageDisplayName(nameOrCode) {
  const cat = languageCatalog(); const n = String(nameOrCode || '').trim().toLowerCase();
  const hit = (cat.languages || []).find(l => l.code === n || l.name.toLowerCase() === n);
  if (hit) return hit.native || hit.name;
  return String(nameOrCode || '').trim();
}
function buildFirstMessage(profile, timeOfDay) {
  const p = profile || {};
  const agent = p.agent || {}, locale = p.locale || {};
  if (agent.first_message) return agent.first_message;              // explicit override always wins
  const T = firstMessageTemplates();
  const code = (p.voice && p.voice.language) || languageCodeFor(locale.primary_language) || 'en';
  const t = T[code] || T[String(code).split('-')[0]] || T.en;
  if (!t) return DEFAULT_FIRST_MESSAGE;
  const greet = (t.greet && (t.greet[timeOfDay] || t.greet.afternoon)) || '';
  let msg = [greet, t.confirm].filter(Boolean).join(' ');
  // Ask which language to continue in (default ON; off when you already know, or when there is
  // nothing to offer because no mirror languages are configured).
  const askEnabled = agent.ask_language_preference !== false;
  const mirrors = Array.isArray(locale.mirror_languages) ? locale.mirror_languages.filter(Boolean) : [];
  if (askEnabled && mirrors.length && t.ask) {
    const names = [languageDisplayName(locale.primary_language || code), ...mirrors.map(languageDisplayName)];
    const uniq = [...new Set(names.filter(Boolean))];
    if (uniq.length > 1) {
      const joiner = ` ${t.or || 'or'} `;
      const list = uniq.length === 2 ? uniq.join(joiner) : uniq.slice(0, -1).join(', ') + joiner + uniq[uniq.length - 1];
      msg += ' ' + t.ask.replace('{langs}', list);
    }
  }
  return msg;
}

// Appended to the system prompt only when the profile's voice.audio_tags is on (ElevenLabs v3).
// Appended only while the action tools are not attached. Everything else about the call works; the
// one thing that does not is the agent's ability to file anything, so it must not say that it has.
const NO_TOOLS_GUIDANCE = `## WHAT YOU CANNOT DO ON THIS CALL — READ THIS BEFORE PROMISING ANYTHING

On this call you have **no ability to record, book, log, update or file anything**. Nothing you say
is written into any system. Earlier instructions describe recording an outcome or booking a
callback: on this call, those cannot happen.

That changes nothing about how you talk to the customer. Be just as warm, just as useful, listen
just as well, agree next steps just as clearly. What it changes is **how you word a commitment**.

**Never say, or imply, that something has been entered anywhere.** Not "I've booked that", not
"I've made a note", not "that's now logged", not "I've put you on the do-not-call list", not "I'll
make sure someone calls you at half past seven". Every one of those is a promise you cannot keep,
and the customer will find out you did not keep it.

**Say what is actually true instead** — that you will pass it on, and be honest that a colleague
will confirm:
- Instead of "I've booked that callback": *"I'll pass that on and someone will come back to you to
  confirm a time — is this the best number for that?"*
- Instead of "I've noted your complaint": *"I'll make sure this is raised. If you'd like it on
  record right away, {{support_number_spoken}} will log it while you're on the phone."*
- Instead of "I've added you to do-not-call": *"I'll pass that request on. To be certain it's
  actioned today, please call {{support_number_spoken}} and they can do it immediately."* — a
  do-not-call request especially must never be treated as done when it is not.

If the customer needs certainty on anything, point them to {{support_number_spoken}}. Being straight
about what you can and cannot do reads as competence. Claiming an action you did not take does not.`;

const AUDIO_TAG_GUIDANCE = `## EXPRESSIVE AUDIO TAGS (v3 voice) — HOW TO ACTUALLY SOUND ALIVE

This voice renders performance cues written in square brackets immediately before the words they
colour. They are stage directions, not words: never say a tag out loud, never explain one, never
put one at the very start of your first sentence, and never stack two together.

### THE LIST BELOW IS CLOSED. IT IS THE COMPLETE SET.
Only these exact tags exist. **Anything else in square brackets is not a tag — it is text, and the
voice will read it out to the customer, along with everything you write after it.** Do not invent a
new one, do not adapt one, do not use brackets for a note, a plan, a thought or a tool. In
particular there is no \`[thought]\`, \`[thinking]\`, \`[note]\`, \`[plan]\` or \`[internal]\`: writing one of
those means the customer hears your reasoning read aloud. If what you want to express is not on this
list, express it in your words and your pacing instead.

Used well, these are the difference between "a very good TTS voice" and "a person". Used badly —
especially laughter in the wrong moment — they are worse than using none at all. The rule is the
same one a real professional follows: **express what you would genuinely be feeling, and nothing
you would not.**

**Warmth and rapport** — [warmly], [smiling], [friendly], [cheerfully]
**Care and sensitivity** — [gently], [softly], [empathetically], [sympathetically], [reassuringly], [sincerely]
**Regret** — [apologetic], [regretful]
**Thinking and interest** — [thoughtful], [curious], [hesitates], [surprised]
**Emphasis and pace** — [slowly], [deliberately], [quietly], [excited]
**Seriousness** — [professional], [firmly], [serious]
**Real human sounds** — [laughs], [chuckles], [sighs], [exhales], [clears throat], [short pause]

### WHEN TO LAUGH (and when it would be awful)
Yes, this voice really does laugh, and a genuine [chuckles] at the right moment is the single most
human thing you can do. But laughter is a *response*, never a performance:
- **Do** react with [chuckles] or a light [laughs] when the CUSTOMER makes a joke, teases you, says
  something self-deprecating, or when you both hit an obviously absurd moment. That is warmth.
- **Never** laugh at your own line. Nothing sounds more artificial than a voice amused by itself.
- **Never** laugh on a call about arrears, a disruption, a complaint, a claim, a medical matter, a
  bereavement, or anyone in difficulty — not once, not lightly. It reads as mockery.
- One laugh in a call is plenty. Two is a personality. Three is a problem.

### MATCH THE TAG TO THE MOMENT
- **Opening a friendly call** — [warmly] or [smiling] on the greeting; then drop them.
- **Delivering good news** — [smiling], and a measured [excited] only if it is genuinely good.
- **Someone says money is tight, they have lost a job, they are unwell, someone has died** —
  [gently] or [sympathetically], and slow down. Never [cheerfully] anywhere near this.
- **Apologising for something that is our fault** — [apologetic] ONCE, sincerely, then be useful.
- **Delivering a disruption, outage, delay or recall** — [serious] or [professional] and calm.
  Never [smiling].
- **A safety or security matter** — [serious], measured, unhurried.
- **Saying a number, a date, a reference or an address** — [slowly] or [deliberately]. This is the
  most practical use of a tag on a phone call: it makes you genuinely easier to write down.
- **They are angry** — no tags at all for a turn. Flat, steady, human. Warmth here reads as
  patronising.
- **A heartfelt thank-you at the end** — [warmly] or [sincerely].
- **Considering something they have just said** — [thoughtful], or a [short pause] before you
  answer, then go straight into the answer itself. The tag alone conveys that you weighed it. Never
  write out what you were weighing.

### DENSITY
Aim for roughly one tag every four or five sentences, and none at all through neutral, factual
stretches. If you have used two tags in a row, use none for the next several turns. A call with
three or four well-placed tags sounds human; a call with twenty sounds theatrical.

If a tag ever seems not to render, simply carry on — never comment on it, and never repeat it.`;

// The register a call needs depends entirely on WHY you are ringing. The same [smiling] that warms
// a renewal call is offensive on an arrears call. This is appended per call so the agent gets the
// exact palette for the conversation it is actually having, not a general-purpose list.
const AUDIO_TAGS_BY_ARCHETYPE = {
  payment_reminder: `**Register for this call: light and friendly.** Nothing is wrong yet — this is a helpful nudge, so keep it easy.
Reach for: [warmly] and [smiling] on the greeting, [slowly] on the amount and the date, [reassuringly] if they sound anxious.
A light [chuckles] is fine ONLY if they joke first. If they say money is tight, drop every warm tag immediately and switch to [gently] — the moment it becomes about hardship it stops being a friendly call.
Avoid: [serious], [firmly], [excited].`,

  overdue_followup: `**Register for this call: straight, calm and respectful. This is the one to get right.**
Money is late and they may feel embarrassed, defensive or frightened. Warmth here must never tip into brightness, and lightness reads as mockery.
Reach for: [gently], [empathetically], [sincerely], [professional], [slowly] on figures and dates, and a [short pause] after they explain themselves.
**Never use, under any circumstance: [laughs], [chuckles], [smiling], [cheerfully], [excited], [friendly].** Not once, not to lighten the mood, not even if they joke — a laugh on a debt call is the single worst sound this agent could make.
If they become upset or angry: no tags at all for a turn. Flat, steady and human.`,

  sales_offer: `**Register for this call: warm and genuinely pleased, never salesy.**
Reach for: [smiling] and [warmly] throughout, a measured [excited] only where the news is honestly good, [slowly] on prices and dates, [thoughtful] when you consider their objection.
A [chuckles] is welcome if they joke — this is the call type where a little lightness works best.
Avoid: [serious], and any [excited] that outruns the actual offer. Over-brightness is what makes a sales call feel like a script.
If they say no: warmth stays, enthusiasm goes.`,

  appointment_reminder: `**Register for this call: brief, easy and unremarkable.** You are doing them a small favour.
Reach for: [warmly] on the greeting, [slowly] on the date, time and address, [reassuringly] if they seem worried about the appointment itself.
A [chuckles] is fine if they joke. Keep tags to two or three in the whole call — this should feel like a thirty-second courtesy, not a performance.
Avoid: [serious], [excited], [apologetic] unless we have actually changed something on them.`,

  feedback_survey: `**Register for this call: interested and genuinely listening.**
Reach for: [warmly] opening, [curious] when you ask, a [short pause] after their answer so it does not feel like a form being filled, [sincerely] on the thank-you.
If they give a low score or a complaint: switch immediately to [empathetically] and drop all warmth-brightness. Never sound pleased while someone is telling you they had a bad experience.
A [chuckles] is fine if they joke.
Avoid: [excited] at any point — enthusiasm about their feedback sounds insincere.`,

  lead_qualification: `**Register for this call: curious and unhurried, never pushy.**
Reach for: [curious] and [thoughtful] as you ask and listen, [warmly] on the greeting and close, [slowly] when confirming a time or a detail back to them.
A [chuckles] is fine if they joke — this call benefits from feeling like a conversation between two people, not an intake form.
Avoid: [excited] (it reads as commission-hungry) and [firmly].`,

  renewal_retention: `**Register for this call: warm, appreciative and unpressured.**
Reach for: [warmly] and [sincerely] — you are thanking someone for their business — [thoughtful] when they weigh it up, [slowly] on dates and amounts.
If they are cancelling or unhappy: switch to [gently] and [empathetically]. Never chase a leaving customer with brightness.
A [chuckles] is fine if they joke.
Avoid: [excited], [firmly], and anything that sounds like you are closing them.`,

  service_notification: `**Register for this call: calm, serious and accountable.** Something has gone wrong or changed, and they did not ask for this call.
Reach for: [serious] or [professional] on the news itself, [apologetic] exactly ONCE if it is our doing, [sincerely] when you acknowledge the inconvenience, [slowly] on new times, dates and reference numbers.
**Never use: [smiling], [cheerfully], [laughs], [chuckles], [excited].** Brightness while delivering bad news reads as not caring.
If they are angry: no tags for a turn. Let them finish, then answer flat and steady.
For a safety, security or recall matter: [serious] throughout, measured and unhurried — never alarmed, never casual.`,

  document_collection: `**Register for this call: helpful and easy-going.** You are removing an obstacle, not chasing paperwork.
Reach for: [warmly] on the greeting, [reassuringly] when they worry it is a problem, [slowly] when you list what is needed or read out a link — this is the call where being easy to write down matters most.
A light [chuckles] is fine if they joke.
If they are frustrated at being asked again: [apologetic] once, then be useful.
Avoid: [serious] and [firmly] — this is not a grave matter and treating it as one makes people anxious.`
};

// Only added when the profile asks for it (Agent Builder: "Fill in realistic details"). Turn it OFF
// for a production deployment where a placeholder detail could mislead a real customer.
const DEMO_REALISM_GUIDANCE = `## THE EVERYDAY DETAILS A REAL COLLEAGUE WOULD SIMPLY KNOW

A receptionist knows which doctor is in on Tuesday. A branch officer knows which counter to send
someone to. A dispatcher knows the driver's first name. If you answer that kind of ordinary
question with "I don't have that information", you stop sounding like a colleague and start
sounding like a system — and on this call that is the worst thing you can be.

So: when someone asks for a **small, everyday operational detail that a person in your role would
obviously have in front of them**, and it was not supplied to you, give a specific, natural answer
that genuinely fits {{country}} and {{industry}} — the way someone reading their own screen would.
Then **keep it consistent for the rest of the call.**

- Pick names, titles and places that actually belong to {{country}}. A doctor in Dubai is not
  named like one in Dublin. Get this right; it is the detail people notice.
- Say it once, plainly, without flourish. Do not offer extra detail nobody asked for.
- **Remember what you said and never contradict yourself later in the call.**

**If they push back on it** — *"that's not right, I think it's Doctor Ahmed"* — do not fold and do
not apologise for being wrong. You are reading the record; they are going from memory, and people
misremember. Do exactly what a competent colleague does: pause, check again, and confirm calmly.

> *"Let me just double-check… [short pause] No, I've got Doctor Mahmoud down for that slot. If you
> think there's been a mix-up, the desk can confirm it when you arrive."*

Hold the detail, stay friendly, and offer the genuine route to sort out a real discrepancy. An
agent that changes its answer the moment someone pushes is far less trustworthy than one that
calmly stands by its own record.

**Never fill in these, even here — the rules elsewhere in this prompt still apply in full:**
- Anything they could act on to their harm: a diagnosis, a medicine, a dosage, a medical
  instruction, a legal position, a tax or investment view.
- Anything that binds the company financially: an amount owed, a balance, a fee, a rate, an
  eligibility decision, a refund, a settlement figure.
- Legal or regulatory deadlines, penalties, or consequences.
- Anything you WERE given in your call variables — those are real. Use them exactly as supplied
  and never improvise over the top of them.

For all of those, "the edge of what you know" and the commitment ladder govern, without exception.`;

const DEFAULT_PROFILE = {
  platform: { product_name: 'OmniReach', tagline: 'AI Voice Outreach' },
  company: { name: 'Acme Corporation', short_name: 'Acme', industry: 'Services', country: 'United States', market: 'customers worldwide', about: 'Acme is a trusted provider serving customers with care.', website: 'www.acme.example', trust_markers: ['Trusted by customers worldwide'] },
  locale: { currency_code: 'USD', currency_symbol: '$', currency_spoken: 'dollars', money_scale: 'western', primary_language: 'English', mirror_languages: [], timezone: 'UTC', phone_format_hint: '+1 XXX XXX XXXX' },
  agent: { name: 'Alex', role: 'Customer Care Executive', tone: 'warm, professional, and human', honorific_style: 'first_name', persona_notes: '', llm: 'gemini-2.0-flash' },
  voice: { provider: 'elevenlabs', voice_id: '', voice_label: '', accent: 'american', gender: 'female', language: 'en', model: 'eleven_flash_v2_5', stability: 0.6, similarity_boost: 0.85, speed: 1.0, audio_tags: false },
  contact: { support_number: '1800 000 0000', support_number_spoken: 'one eight hundred, triple zero, triple zero', whatsapp_number: '', email: 'care@acme.example', hours: 'Monday to Friday, 9 to 6', portal: 'www.acme.example' },
  compliance: { framework: 'local telemarketing and data-protection rules', calling_hours: '9:00 AM to 8:00 PM local time', recording_disclosure: true, dnd_respect: true, notes: ['Never ask for OTPs, PINs, or passwords', 'Honour opt-out immediately'] },
  offerings: [{ name: 'Our Service', benefit: 'help whenever you need it', category: 'general' }],
  use_cases: { payment_reminder: { enabled: true }, overdue_followup: { enabled: true, consequences: ['late fee'] }, sales_offer: { enabled: true }, appointment_reminder: { enabled: true, appointment_noun: 'appointment' }, feedback_survey: { enabled: true, scale: '1 to 5' }, lead_qualification: { enabled: true }, renewal_retention: { enabled: true, renewal_noun: 'plan' } }
};

// ── PROFILE LOADING ─────────────────────────────────────
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
function listPresets() {
  try {
    return fs.readdirSync(PRESET_DIR).filter(f => f.endsWith('.json')).map(f => {
      const id = f.replace(/\.json$/, '');
      try { const p = readJson(path.join(PRESET_DIR, f)); return { id, label: p._preset || (p.company && p.company.name) || id, company: p.company ? p.company.name : id, industry: p.company ? p.company.industry : '', country: p.company ? p.company.country : '' }; }
      catch (e) { return { id, label: id, company: id, industry: '', country: '' }; }
    });
  } catch (e) { return []; }
}
function loadPreset(id) { const safe = String(id).replace(/[^a-z0-9_-]/gi, ''); return readJson(path.join(PRESET_DIR, safe + '.json')); }
// `stored` is the active profile the store loaded (if any); otherwise fall back to env preset → example → first preset.
function loadInitialProfile(stored) {
  if (stored && stored.company) return stored;
  const envPreset = (process.env.ACTIVE_PROFILE || '').trim();
  if (envPreset) { try { return loadPreset(envPreset); } catch (e) { console.warn('ACTIVE_PROFILE preset not found:', envPreset); } }
  try { if (fs.existsSync(EXAMPLE_PROFILE)) return readJson(EXAMPLE_PROFILE); } catch (e) {}
  const presets = listPresets();
  if (presets.length) { try { return loadPreset(presets[0].id); } catch (e) {} }
  return DEFAULT_PROFILE;
}
function saveActiveProfile() { store.saveSetting('active_profile', activeProfile); }
// Per-user profile: each logged-in user has their own active company; new users inherit the default.
function saveUserProfiles() { store.saveUserProfiles(userProfiles); }
function getProfile(req) { const id = req && req.user && req.user.id; return (id && userProfiles[id]) || activeProfile; }
function setProfile(req, p) { if (req && req.user) { userProfiles[req.user.id] = p; saveUserProfiles(); } else { activeProfile = p; saveActiveProfile(); } }
// Guardrail config persistence (data/guardrails.json). Merge over defaults so new keys are picked up.
function saveGuardrails() { store.saveSetting('guardrails', guardrails); }
// Per-user write-back config (persisted). Each partner has their own destination; unset = disabled default.
function saveUserWriteback() { store.saveUserWriteback(userWritebackConfigs); }
function getWriteback(userId) { return userWritebackConfigs[userId] || { enabled: false, sink: 'echo', config: {}, mapping: null }; }
function setWriteback(userId, cfg) { userWritebackConfigs[userId] = cfg; saveUserWriteback(); }
// Signup config persistence.
function saveSignup() { store.saveSetting('signup', signup); }
function emailDomain(email) { const m = String(email || '').toLowerCase().match(/@([^@\s]+)$/); return m ? m[1] : ''; }
// A domain is whitelisted if it matches exactly, or is a subdomain of a listed domain.
function domainWhitelisted(email) {
  const d = emailDomain(email); if (!d) return false;
  return (signup.allowedDomains || []).map(x => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    .some(allowed => d === allowed || d.endsWith('.' + allowed));
}

// ── USAGE METERING + GUARDRAIL CHECK ────────────────────
// Usage is computed straight from call history (the source of truth) so counters never drift.
function sameLocalDay(ts, ref) { try { const a = new Date(ts); return a.getFullYear() === ref.getFullYear() && a.getMonth() === ref.getMonth() && a.getDate() === ref.getDate(); } catch (e) { return false; } }
function realCallsToday(userId) { const now = new Date(); return callHistory.filter(c => c.userId === userId && !c.simulated && c.timestamp && sameLocalDay(c.timestamp, now)).length; }
function realCallsLastMinute(userId) { const cut = Date.now() - 60000; return callHistory.filter(c => c.userId === userId && !c.simulated && c.timestamp && new Date(c.timestamp).getTime() >= cut).length; }
function realCallsTotal(userId) { return callHistory.filter(c => c.userId === userId && !c.simulated).length; }
// ── TEMPORARY ALLOWANCE BOOSTS ──────────────────────────
// A partner sometimes needs more than the standard allowance for one demo, or for a week of
// testing. Raising their permanent limit and hoping to remember to lower it again is how a "just
// for today" exception quietly becomes forever, so a boost carries its own expiry and simply stops
// applying when it lapses. Nothing has to be undone by hand.
//
// Resolution order, most specific first: an active per-USER boost, an active per-ORGANISATION boost,
// the account's own permanent limit, then the platform default.
function overrideActive(o) { return !!o && (!o.until || new Date(o.until).getTime() > Date.now()); }
function activeBoost(user) {
  if (!user) return null;
  if (overrideActive(user.quotaOverride)) return user.quotaOverride;
  const og = orgQuotas[orgIdOf(user)];
  return overrideActive(og) ? og : null;
}
/** Turn the admin's choice of "one day / one week / permanent" into a concrete expiry. */
function boostExpiry(duration) {
  if (duration === 'day') return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  if (duration === 'week') return new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  return null;   // permanent
}

// Talk time only becomes known once a call ends and its duration syncs back, so a call still in
// flight contributes nothing here. That is precisely why placeCall caps each call at whatever
// budget remains: the cap makes overshoot impossible rather than merely unlikely.
function realSecondsToday(userId) {
  const now = new Date();
  return callHistory
    .filter(c => c.userId === userId && !c.simulated && c.timestamp && sameLocalDay(c.timestamp, now))
    .reduce((sum, c) => sum + Math.max(0, Math.round((c.durationMs || 0) / 1000)), 0);
}
// A user's effective daily limits: an active boost, else their own permanent quota, else the
// platform default (null at any level = unlimited).
function effectiveLimit(user) {
  const b = activeBoost(user);
  if (b && b.callsPerDay !== undefined && b.callsPerDay !== null) return b.callsPerDay;
  const q = user && user.quota ? user.quota.callsPerDay : undefined;
  return (q === null || q === undefined) ? guardrails.defaultCallsPerDay : q;
}
function effectiveMinuteLimit(user) {
  const b = activeBoost(user);
  if (b && b.minutesPerDay !== undefined && b.minutesPerDay !== null) return b.minutesPerDay;
  const q = user && user.quota ? user.quota.minutesPerDay : undefined;
  return (q === null || q === undefined) ? guardrails.defaultMinutesPerDay : q;
}
// ── BULK CALLING ────────────────────────────────────────
// Off for partners by default. Someone on a three-call allowance who uploads five hundred contacts
// gets a queue of refusals rather than a demo, and if their allowance were ever raised, one careless
// upload becomes real money and five hundred real people's phones ringing. So bulk is something we
// hand over deliberately, per partner, and it can be granted for a day or a week like any boost.
function mayBulkCall(u) {
  if (isPlatformAdmin(u)) return true;
  const b = activeBoost(u);
  if (b && b.bulk) return true;
  return !!guardrails.allowBulkForPartners;
}
/** The message a partner sees. Polite, explains itself, and says exactly how to get it enabled. */
function bulkBlockedMessage(u) {
  const c = effectiveLimit(u), m = effectiveMinuteLimit(u);
  const allowance = [c != null ? `${c} call${c === 1 ? '' : 's'}` : null, m != null ? `${m} minutes of talk time` : null].filter(Boolean).join(' or ');
  return `Bulk campaigns aren't switched on for your account just yet.${allowance ? ` Your daily allowance is ${allowance}, so calls are placed one at a time from the Single Call page.` : ''} If you'd like to run a larger campaign, just ask your Streebo contact and we'll be glad to arrange it.`;
}
function requireBulk(req, res, next) {
  if (mayBulkCall(req.user)) return next();
  return res.status(403).json({ error: bulkBlockedMessage(req.user), code: 'bulk_not_enabled' });
}
// Below this, a call is not worth placing: it would be cut off mid-sentence seconds after the
// customer says hello, which is a worse experience for them than never being rung at all.
const MIN_USEFUL_CALL_SECONDS = 30;
/** Seconds of talk time left today, or null when no minute budget applies to this user. */
function remainingSecondsToday(user) {
  if (!user || user.role === 'admin' || !guardrails.enforceQuota) return null;
  const mins = effectiveMinuteLimit(user);
  if (mins == null) return null;
  return Math.max(0, mins * 60 - realSecondsToday(user.id));
}
// Returns {ok:true} unless a guardrail that is switched ON would block this call. Admins are exempt;
// simulated calls only ever hit the simulation-only gate (which permits them). Off by default → never blocks.
function guardCheck(req, simulate) {
  // Only a PLATFORM admin is exempt from the budget. A partner admin manages their own colleagues
  // but still spends Streebo's telephony money, so promoting someone at a partner company must not
  // quietly hand them unlimited calls.
  const u = req && req.user; if (!u || isPlatformAdmin(u)) return { ok: true };
  if (guardrails.simulationOnly && !simulate) return { ok: false, code: 'sim_only', error: 'Live calling is turned off by your administrator. Use Simulation mode to run the demo.' };
  if (simulate) return { ok: true }; // dry-runs cost nothing — never limited
  if (guardrails.enforceQuota) {
    const lim = effectiveLimit(u);
    if (lim != null && realCallsToday(u.id) >= lim) return { ok: false, code: 'quota', error: `Daily call limit reached (${lim} calls). It resets tomorrow, or an administrator can raise your limit.` };
    // Two budgets, whichever runs out first. A near-empty minute budget counts as spent, because a
    // call cut off after twenty seconds helps nobody.
    const mins = effectiveMinuteLimit(u);
    if (mins != null) {
      const left = Math.max(0, mins * 60 - realSecondsToday(u.id));
      if (left < MIN_USEFUL_CALL_SECONDS) {
        const usedMin = Math.floor(realSecondsToday(u.id) / 60), usedSec = realSecondsToday(u.id) % 60;
        return { ok: false, code: 'minutes', error: `Daily talk-time limit reached (${mins} minutes; ${usedMin}m ${usedSec}s used). It resets tomorrow, or an administrator can raise your limit.` };
      }
    }
  }
  if (guardrails.rateLimitPerMin && realCallsLastMinute(u.id) >= guardrails.rateLimitPerMin) return { ok: false, code: 'rate', error: `Too many calls in the last minute (limit ${guardrails.rateLimitPerMin}). Please slow down and try again shortly.` };
  return { ok: true };
}

function flattenProfile(p) {
  p = p || {};
  const c = p.company || {}, l = p.locale || {}, a = p.agent || {}, ct = p.contact || {}, cm = p.compliance || {}, uc = p.use_cases || {};
  const join = (arr, sep) => Array.isArray(arr) ? arr.join(sep || ', ') : (arr || '');
  const offerings = Array.isArray(p.offerings) ? p.offerings.map(o => `${o.name} — ${o.benefit}`).join('; ') : '';
  return {
    company_name: c.name || '', company_short: c.short_name || c.name || '', industry: c.industry || '', country: c.country || '', market: c.market || '', company_about: c.about || '', website: c.website || '',
    trust_markers: join(c.trust_markers, '; '), offerings_summary: offerings,
    agent_name: a.name || 'the agent', agent_role: a.role || '', agent_tone: a.tone || 'warm and professional', honorific_style: a.honorific_style || 'first_name', persona_notes: a.persona_notes || '',
    currency_word: l.currency_spoken || 'the local currency', money_scale: l.money_scale || 'western', primary_language: l.primary_language || 'English', mirror_languages: join(l.mirror_languages, ', '),
    support_number: ct.support_number || '', support_number_spoken: ct.support_number_spoken || ct.support_number || '', whatsapp_number: ct.whatsapp_number || '', support_email: ct.email || '', hours: ct.hours || '', portal: ct.portal || c.website || '',
    compliance_framework: cm.framework || 'local rules', compliance_notes: join(cm.notes, '; '), recording_disclosure: String(cm.recording_disclosure !== false),
    consequences: join((uc.overdue_followup || {}).consequences, ', ') || 'applicable charges',
    appointment_type: (uc.appointment_reminder || {}).appointment_noun || 'appointment',
    scale: (uc.feedback_survey || {}).scale || '1 to 5',
    renewal_item: (uc.renewal_retention || {}).renewal_noun || 'plan',
    ...(p.custom_variables && typeof p.custom_variables === 'object' ? p.custom_variables : {})
  };
}
// {key: enabled} across whatever use cases the profile defines (industry-specific or legacy archetypes).
function enabledUseCases(p) { const uc = ucMap(p); const out = {}; Object.keys(uc).forEach(k => { out[k] = !!(uc[k] && uc[k].enabled); }); return out; }

// ── HISTORY PERSISTENCE ─────────────────────────────────
function saveHistory() { store.saveCalls(callHistory); }

// Pull everything the store has into memory. From here on the app reads memory and persists on write.
async function hydrate() {
  const d = await store.loadAll();
  callHistory = d.calls || [];
  userProfiles = d.userProfiles || {};
  userWritebackConfigs = d.userWriteback || {};
  if (d.guardrails) guardrails = { ...guardrails, ...d.guardrails };
  if (d.signup) signup = { ...signup, ...d.signup };
  orgQuotas = d.orgQuotas || {};
  dailyReport = report.withDefaults(d.dailyReport);
  schedules = d.schedules || [];
  bookmarks = d.bookmarks || [];
  otps = (d.otps || []).filter(o => o && o.expiresAt > Date.now());
  accessRequests = d.accessRequests || [];
  auth.setUsers(d.users || []);
  activeProfile = loadInitialProfile(d.activeProfile);
  backfillOrgs();
}

// Idempotent backfill: everything created before organisations existed carries no orgId, and without
// one it would be visible to its author alone, so a team would silently see nothing of each other.
//
// Accounts that predate orgs all join the FIRST ADMIN's organisation rather than getting one derived
// from their own address. That is deliberate: a Streebo colleague who signed up on a personal address
// would otherwise land alone in a "gmail.com" org and lose sight of the team's work. Only legacy rows
// are treated this way; every account created from here on derives its org from its email domain.
function backfillOrgs() {
  const users = auth.loadUsers();
  if (!users.length) return;
  const admin = users.find(u => u.role === 'admin') || users[0];
  const legacyOrg = domainOf(admin.email) || 'default';

  let nUsers = 0;
  users.forEach(u => { if (!u.orgId) { u.orgId = legacyOrg; nUsers++; } });
  if (nUsers) auth.saveUsers(users);

  // Rows inherit the org of whoever created them, read AFTER the users above are stamped.
  const stamp = rows => {
    let n = 0;
    (rows || []).forEach(r => {
      if (r.orgId) return;
      const owner = auth.findById(r.userId);
      if (owner) { r.orgId = orgIdOf(owner); n++; }
    });
    return n;
  };
  const nCalls = stamp(callHistory), nMarks = stamp(bookmarks), nSched = stamp(schedules);
  if (nCalls) saveHistory();
  if (nMarks) store.saveBookmarks(bookmarks);
  if (nSched) store.saveSchedules(schedules);

  if (nUsers || nCalls || nMarks || nSched) {
    console.log(`\n🏢  Organisations backfilled: ${nUsers} account(s) → "${legacyOrg}", ${nCalls} call(s), ${nMarks} bookmark(s), ${nSched} schedule(s).`);
  }
}

// Seed a first admin login if there are no users yet.
// SECURITY: never fall back to a hard-coded password. If ADMIN_PASSWORD isn't set we generate a
// strong random one and print it ONCE, so a public deployment can't ship with a guessable default.
// Either way the account must change its password at first sign-in.
function seedAdmin() {
  if (auth.loadUsers().length) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@streebo.com').toLowerCase();
  const supplied = process.env.ADMIN_PASSWORD || '';
  const pw = supplied || crypto.randomBytes(12).toString('base64url');
  auth.upsertUser({ id: uuidv4(), email, name: 'Administrator', org: 'Streebo', orgId: domainOf(email), role: 'admin', passwordHash: auth.hashPassword(pw), active: true, mustChangePassword: true, createdAt: new Date().toISOString(), quota: { callsPerDay: null }, usage: { calls: 0 } });
  console.log(`\n👤  Seeded the first admin login`);
  console.log(`    email:     ${email}`);
  console.log(`    password:  ${pw}${supplied ? '   (from ADMIN_PASSWORD)' : '   ← generated once, copy it now; it is not stored anywhere in plain text'}`);
  console.log(`    You'll be asked to set a new password at first sign-in.\n`);
}

// Loud, actionable warnings for anything that is fine locally but unsafe on a public URL.
function securityAudit() {
  const warn = [];
  if (auth.secretIsEphemeral()) warn.push('AUTH_SECRET is not set — the token signing key lives in data/auth-secret, so everyone is signed out on redeploy (and multiple instances reject each other\'s logins). Set AUTH_SECRET to a long random string.');
  if (!store.info().durable) warn.push('DATABASE_URL is not set — data is in JSON files under data/. Most hosts wipe that on every deploy. Set DATABASE_URL to a managed Postgres before going live.');
  const stillDefault = auth.loadUsers().filter(u => u.mustChangePassword);
  if (stillDefault.length) warn.push(`${stillDefault.length} account(s) still have their initial password and must change it at next sign-in.`);
  if ((process.env.ADMIN_PASSWORD || '') === 'ChangeMe123!') warn.push('ADMIN_PASSWORD is set to the old documented default "ChangeMe123!" — change it.');
  // The two routes that answer without a session. They are open by design, because the caller is
  // ElevenLabs' cloud rather than a person, but each has its own shared secret and BOTH default to
  // not checking. Left unset on a public URL, anyone who finds the address can post fabricated
  // outcomes into real call records or mark a customer do-not-call. Harmless on a laptop, which is
  // why this is tied to PUBLIC_BASE being set rather than shouted at every developer.
  const publicNow = !!(process.env.PUBLIC_BASE || '').trim();
  if (publicNow && !(process.env.TOOL_WEBHOOK_SECRET || '').trim()) {
    warn.push('TOOL_WEBHOOK_SECRET is not set, and PUBLIC_BASE is. /api/agent-tool/* answers WITHOUT a session by design (the voice agent calls it), so until this is set anyone who finds the URL can write outcomes into real call records. Set it, then re-sync the tools from Settings so ElevenLabs sends the header.');
  }
  if (publicNow && !(process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim()) {
    warn.push('ELEVENLABS_WEBHOOK_SECRET is not set, and PUBLIC_BASE is. The post-call webhook accepts unsigned payloads until it is, so a forged POST could overwrite a real conversation transcript and outcome. Copy the signing secret from the ElevenLabs webhook settings.');
  }
  if (warn.length) { console.log('\n⚠️   Before exposing this on a public URL:'); warn.forEach(w => console.log('    • ' + w)); console.log(''); }
}

// ── AGENT TOOLS SPEC ────────────────────────────────────
let agentTools = { tools: [] };
let toolsByName = {};
function loadTools() { try { agentTools = readJson(TOOLS_FILE); toolsByName = {}; (agentTools.tools || []).forEach(t => { toolsByName[t.name] = t; }); } catch (e) { console.warn('Could not load agent tools:', e.message); } }
loadTools();

// ── PROVIDER RESOLUTION ─────────────────────────────────
function activeProviderName(profile) { const p = profile || activeProfile; return (p && p.voice && p.voice.provider) || config.defaultProvider || 'elevenlabs'; }
function providerConfigured(name) { try { return getProvider(name).isConfigured(config); } catch (e) { return false; } }

// Place one call using the given user's profile. Returns { providerName, providerCallId }.
// `user` is optional; when given, the call is capped at whatever talk-time budget that person has
// left today, so a 10-minute daily allowance cannot be overspent by a single long call. Because
// duration is only known once a call ENDS, a check at dial time alone would let the last call of
// the day run to the agent's global limit; the cap is what makes the budget actually hold.
async function placeCall(toNumber, callVars, profile, user) {
  profile = profile || activeProfile;
  const providerName = activeProviderName(profile);
  const adapter = getProvider(providerName);
  const merged = { ...flattenProfile(profile), ...callVars };
  const dynamicVars = {};
  for (const [k, v] of Object.entries(merged)) dynamicVars[k] = (v === null || v === undefined) ? '' : String(v);
  if (!dynamicVars.time) dynamicVars.time = autoTimeOfDay();
  // A short, speakable noun phrase for what this call is about ("your flight disruption"), used by
  // the global prompt when steering an off-topic caller back without sounding robotic.
  if (!dynamicVars.use_case_short) {
    const ucCfg = ucMap(profile)[callVars.use_case] || {};
    const label = (ucCfg.label || callVars.use_case || '').replace(/[_-]+/g, ' ').trim();
    dynamicVars.use_case_short = label ? `your ${label.toLowerCase()}` : 'what I called about';
  }
  const voice = (profile && profile.voice) || {};
  const llm = (profile && profile.agent && profile.agent.llm) || '';
  const language = voice.language || '';
  let prompt = providerName === 'elevenlabs' ? assemblePrompt(callVars.use_case, profile) : '';
  if (prompt && voice.audio_tags) {
    prompt += '\n\n\n' + '='.repeat(60) + '\n\n\n' + AUDIO_TAG_GUIDANCE;
    // The palette for THIS call type. Warmth that suits a renewal is offensive on an arrears call.
    const perCall = AUDIO_TAGS_BY_ARCHETYPE[archetypeOf(profile, callVars.use_case)];
    if (perCall) prompt += '\n\n### TAGS FOR THIS PARTICULAR CALL\n\n' + perCall;
  }
  // ON unless explicitly disabled: a demo agent that says "I have no information" about a detail
  // any real colleague would know reads as broken. Turn it off for production deployments.
  if (prompt && (profile.agent || {}).demo_realism !== false) prompt += '\n\n\n' + '='.repeat(60) + '\n\n\n' + DEMO_REALISM_GUIDANCE;
  // Until the tools are attached the agent has no way to record anything, and the prompt above still
  // talks about recording outcomes and booking callbacks. That mismatch is what produced "I'll make
  // sure a specialist calls you at seven thirty" for a callback that was written down nowhere.
  // Calls work perfectly well without tools — but the agent must stop claiming it has filed things.
  if (prompt && toolsLive.known && !toolsLive.ok) prompt += '\n\n\n' + '='.repeat(60) + '\n\n\n' + NO_TOOLS_GUIDANCE;
  const firstMessage = providerName === 'elevenlabs' ? buildFirstMessage(profile, dynamicVars.time) : '';
  // null when this user has no minute budget, in which case the agent's own limit applies unchanged.
  const maxDurationSeconds = remainingSecondsToday(user);
  const result = await adapter.createCall({ toNumber, dynamicVars, prompt, firstMessage, llm, language, voice, config, maxDurationSeconds });
  return { providerName, providerCallId: result.providerCallId };
}

// Build a simulated (dry-run) call entry — realistic transcript + outcome, no telephony.
function makeSimulatedEntry(toNumber, vars, profile) {
  vars = vars || {}; profile = profile || activeProfile;
  const sim = simulateCall(vars, profile);
  const entry = {
    id: uuidv4(), toNumber: toNumber || '', customerName: vars.customer_name || '', useCase: vars.use_case || sim.useCase || '',
    company: (profile.company || {}).name || '', industry: (profile.company || {}).industry || '',
    provider: 'simulator', callId: 'sim_' + uuidv4().slice(0, 8),
    status: 'ended', simulated: true, timestamp: new Date().toISOString(), variables: vars,
    callStatus: 'ended', hasAudio: false, transcript: sim.transcript, durationMs: sim.durationMs,
    userSentiment: sim.userSentiment, callSuccessful: sim.callSuccessful, disposition: sim.disposition,
    outcomeSummary: sim.outcomeSummary, summary: sim.summary,
    outcomes: (sim.outcomesTimeline || []).map(t => ({ tool: t.tool, params: t.params, at: new Date().toISOString(), simulated: true }))
  };
  Object.assign(entry, sim.apply || {});
  return entry;
}

// ── GENERIC INTELLIGENCE ENGINE (7 use cases) ───────────
function analyseCustomer(row, profile) {
  const data = {};
  for (const [k, v] of Object.entries(row)) data[k.toLowerCase().replace(/\s+/g, '_').trim()] = (v || '').toString().trim();
  const enabled = enabledUseCases(profile);
  const scale = profile.locale && profile.locale.money_scale === 'indian' ? 'indian' : 'western';
  const today = new Date();
  const result = { customer_name: data.customer_name || data.name || data.full_name || '', to_number: data.to_number || data.phone || data.phone_number || data.mobile || '', time: autoTimeOfDay(), use_case: null, variables: {}, intelligence_reason: '', intelligence_signals: [] };
  const dueDate = parseDate(data.due_date || data.payment_due_date || '');
  const daysUntilDue = dueDate ? daysDiff(today, dueDate) : null;
  const daysOverdue = data.days_overdue ? parseInt(data.days_overdue) : (dueDate && dueDate < today ? daysDiff(dueDate, today) : null);
  const signals = [];
  // An explicit use_case column wins if it names one of THIS profile's use cases; otherwise we infer
  // an archetype from the data and pick the industry's own use case for it (e.g. an overdue signal on
  // an airline profile lands on that airline's collections-shaped call, not a generic one).
  const pick = (arch) => pickByArchetype(profile, arch);
  let uc = null;
  const explicit = (data.use_case || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (explicit && enabled[explicit]) { uc = explicit; signals.push('📌 explicit use_case'); }
  if (!uc) { const a = normaliseUseCase(data.use_case); const k = a && pick(a); if (k) { uc = k; signals.push('📌 explicit use_case'); } }
  if (!uc) {
    if (daysOverdue !== null && daysOverdue > 0 && pick('overdue_followup')) { uc = pick('overdue_followup'); signals.push(`⚠️ ${daysOverdue} day(s) overdue`); }
    else if (daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 7 && pick('payment_reminder')) { uc = pick('payment_reminder'); signals.push(`🔔 due in ${daysUntilDue} day(s)`); }
    else if ((data.event_type || data.event_detail) && pick('service_notification')) { uc = pick('service_notification'); signals.push('🔔 service event on file'); }
    else if ((data.missing_items || data.process_name) && pick('document_collection')) { uc = pick('document_collection'); signals.push('📄 documents pending'); }
    else if ((data.appointment_date || data.appointment_time) && pick('appointment_reminder')) { uc = pick('appointment_reminder'); signals.push('📅 appointment on file'); }
    else if ((data.renewal_date || data.renewal_item) && pick('renewal_retention')) { uc = pick('renewal_retention'); signals.push('🔁 renewal due'); }
    else if ((data.interaction_date || data.interaction_type) && pick('feedback_survey')) { uc = pick('feedback_survey'); signals.push('⭐ recent interaction'); }
    else if ((data.lead_source || data.interest) && pick('lead_qualification')) { uc = pick('lead_qualification'); signals.push('🧲 new lead'); }
    else if (pick('sales_offer')) { uc = pick('sales_offer'); signals.push('💼 general outreach'); }
    else { uc = enabledKeys(profile)[0] || 'sales_offer'; signals.push('• default'); }
  }
  result.use_case = uc; result.intelligence_signals = signals;
  const ucCfg = ucMap(profile)[uc] || {};
  const money = (raw) => formatAmount(raw, scale);
  switch (archetypeOf(profile, uc)) {
    case 'overdue_followup':
      result.variables = { product_name: data.product_name || data.product || 'account', amount_overdue: money(data.amount_overdue || data.amount_due), original_due_date: formatDateSpoken(dueDate || today), days_overdue: (daysOverdue || 0).toString(), outstanding_balance: money(data.outstanding_balance) };
      result.intelligence_reason = `Overdue by ${daysOverdue || 0} day(s) on their ${result.variables.product_name}.`; break;
    case 'payment_reminder':
      result.variables = { product_name: data.product_name || data.product || 'payment', amount_due: money(data.amount_due), due_date: formatDateSpoken(dueDate), outstanding_balance: money(data.outstanding_balance) };
      result.intelligence_reason = `Payment due in ${daysUntilDue} day(s) — reminder call appropriate.`; break;
    case 'appointment_reminder':
      result.variables = { appointment_type: data.appointment_type || ucCfg.appointment_noun || 'appointment', appointment_date: data.appointment_date ? formatDateSpoken(parseDate(data.appointment_date)) : '', appointment_time: data.appointment_time || '', location: data.location || '', reference: data.reference || '', prep_notes: data.prep_notes || '' };
      result.intelligence_reason = `Upcoming ${result.variables.appointment_type} — confirmation call.`; break;
    case 'renewal_retention':
      result.variables = { renewal_item: data.renewal_item || ucCfg.renewal_noun || 'plan', renewal_date: data.renewal_date ? formatDateSpoken(parseDate(data.renewal_date)) : '', renewal_amount: money(data.renewal_amount) };
      result.intelligence_reason = `${result.variables.renewal_item} due for renewal — retention call.`; break;
    case 'feedback_survey':
      result.variables = { interaction_type: data.interaction_type || 'your recent experience', interaction_date: data.interaction_date || 'recently', scale: data.scale || ucCfg.scale || '1 to 5' };
      result.intelligence_reason = `Recent ${result.variables.interaction_type} — feedback/CSAT call.`; break;
    case 'lead_qualification':
      result.variables = { lead_source: data.lead_source || 'your recent enquiry', interest: data.interest || 'our products' };
      result.intelligence_reason = `New lead from ${result.variables.lead_source} — qualification call.`; break;
    case 'service_notification':
      result.variables = { event_type: data.event_type || ucCfg.event_noun || 'an update to your service', event_detail: data.event_detail || '', event_time: data.event_time || '', impact: data.impact || '', options: data.options || '', resolution_eta: data.resolution_eta || '', reference: data.reference || '' };
      result.intelligence_reason = `Proactive notification — ${result.variables.event_type}.`; break;
    case 'document_collection':
      result.variables = { process_name: data.process_name || ucCfg.process_noun || 'your application', missing_items: data.missing_items || 'the outstanding documents', deadline: data.deadline || '', consequence: data.consequence || '', submission_channel: data.submission_channel || (profile.contact && profile.contact.portal) || '', reference: data.reference || '' };
      result.intelligence_reason = `Pending documents on ${result.variables.process_name}.`; break;
    case 'sales_offer':
    default:
      result.variables = { offer_type: data.offer_type || 'a special offer', offer_detail: data.offer_detail || 'benefits tailored to you', pre_approved: (data.pre_approved || 'FALSE').toString().toUpperCase().startsWith('T') ? 'TRUE' : 'FALSE', eligible_amount: money(data.eligible_amount), expiry_date: data.expiry_date || endOfNextMonth() };
      result.intelligence_reason = `Marketing outreach — ${result.variables.offer_type}.`; break;
  }
  return result;
}
function normaliseUseCase(v) {
  if (!v) return null;
  const s = v.toString().toLowerCase().replace(/[\s-]+/g, '_');
  if (USE_CASE_KEYS.includes(s)) return s;
  if (/overdue|collection|follow/.test(s)) return 'overdue_followup';
  if (/reminder|due|payment|emi|bill/.test(s)) return 'payment_reminder';
  if (/sales|offer|market|promo|upsell|cross|winback|win_back/.test(s)) return 'sales_offer';
  if (/appoint|booking|delivery|visit/.test(s)) return 'appointment_reminder';
  if (/feedback|survey|csat|nps/.test(s)) return 'feedback_survey';
  if (/notif|disrupt|outage|delay|recall|alert|advisory|cancel/.test(s)) return 'service_notification';
  if (/document|kyc|paperwork|verification|pending_doc/.test(s)) return 'document_collection';
  if (/lead|qualif|prospect/.test(s)) return 'lead_qualification';
  if (/renew|retention|subscription/.test(s)) return 'renewal_retention';
  return null;
}

// ── SMART QUEUE (order + skip logic for bulk) ───────────
// Urgency by ARCHETYPE: a disruption notice or an overdue account outranks a marketing call.
const UC_PRIORITY = { service_notification: 1, overdue_followup: 2, payment_reminder: 3, appointment_reminder: 4, document_collection: 5, renewal_retention: 6, feedback_survey: 7, lead_qualification: 8, sales_offer: 9 };
function isTruthy(v) { return /^(1|true|yes|y)$/i.test(String(v == null ? '' : v).trim()); }
// Order the queue by urgency and drop rows we shouldn't call (missing data, do-not-call, duplicates).
function annotateQueue(list, profile) {
  const seen = new Set();
  const dncNumbers = new Set(callHistory.filter(c => c.dnc && c.toNumber).map(c => (c.toNumber || '').replace(/\s+/g, '')));
  const out = list.map(c => {
    const num = (c.to_number || '').replace(/\s+/g, '');
    const raw = c.raw || {};
    let skip = '';
    if (!c.ready) skip = 'missing data';
    else if (isTruthy(raw.do_not_call) || isTruthy(raw.dnc) || isTruthy(raw.opt_out)) skip = 'do-not-call (data)';
    else if (num && dncNumbers.has(num)) skip = 'do-not-call (prior call)';
    else if (num && seen.has(num)) skip = 'duplicate number';
    if (num && !skip) seen.add(num);
    return { ...c, priority: UC_PRIORITY[archetypeOf(profile, c.use_case)] || 9, skip: !!skip, skipReason: skip };
  });
  out.sort((a, b) => (Number(a.skip) - Number(b.skip)) || (a.priority - b.priority));
  out.forEach((c, i) => { c.callOrder = i + 1; });
  return out;
}
function analyseRows(rows, profile) {
  profile = profile || activeProfile;
  const analysed = rows.map((row, i) => { const intel = analyseCustomer(row, profile); return { rowIndex: i, raw: row, ...intel, ready: !!(intel.to_number && intel.customer_name && intel.use_case) }; });
  const queued = annotateQueue(analysed, profile);
  // Tally by the profile's own use-case keys (industry-named), not the archetypes.
  const byUseCase = {}; Object.keys(ucMap(profile)).forEach(k => { byUseCase[k] = queued.filter(r => r.use_case === k && !r.skip).length; });
  const summary = { total: queued.length, ready: queued.filter(r => r.ready).length, queued: queued.filter(r => r.ready && !r.skip).length, skipped: queued.filter(r => r.skip).length, byUseCase };
  return { customers: queued, summary };
}

// ── HELPERS ─────────────────────────────────────────────
function parseDate(str) { if (!str) return null; const m = str.toString().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); if (m) { const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`); return isNaN(d.getTime()) ? null : d; } const d = new Date(str); return isNaN(d.getTime()) ? null : d; }
function daysDiff(a, b) { return Math.round((b - a) / (1000 * 60 * 60 * 24)); }
function formatAmount(raw, scale) { if (!raw) return ''; const n = parseFloat(raw.toString().replace(/[^0-9.]/g, '')); if (!n || isNaN(n)) return ''; return Math.round(n).toLocaleString(scale === 'indian' ? 'en-IN' : 'en-US'); }
function formatDateSpoken(date) { if (!date) return 'the scheduled date'; const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']; const day = date.getDate(); const suffix = ['th', 'st', 'nd', 'rd'][(day % 10 > 3 || Math.floor(day / 10) === 1) ? 0 : day % 10] || 'th'; return `${days[date.getDay()]}, the ${day}${suffix} of ${months[date.getMonth()]}`; }
function autoTimeOfDay() { const hr = new Date().getHours(); return hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'; }
function endOfNextMonth() { const d = new Date(); d.setMonth(d.getMonth() + 1); const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']; return `end of ${months[d.getMonth()]}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function futureDate(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0]; }
function maskKey(k) { return k ? k.substring(0, 6) + '••••••••' : ''; }
function providerPublicConfig() {
  return {
    defaultProvider: config.defaultProvider,
    activeProvider: activeProviderName(),
    bulkDelay: config.bulkDelay,
    publicBase: config.publicBase,
    providers: {
      elevenlabs: { apiKeySet: !!config.elevenlabs.apiKey, apiKeyPreview: maskKey(config.elevenlabs.apiKey), agentId: config.elevenlabs.agentId, agentPhoneNumberId: config.elevenlabs.agentPhoneNumberId, sendVoiceTuning: !!config.elevenlabs.sendVoiceTuning, configured: providerConfigured('elevenlabs') },
      retell: { apiKeySet: !!config.retell.apiKey, apiKeyPreview: maskKey(config.retell.apiKey), agentId: config.retell.agentId, fromNumber: config.retell.fromNumber, configured: providerConfigured('retell') }
    }
  };
}
// ── LEAK DETECTOR ───────────────────────────────────────
// The prompt is the only lever we have at generation time, so this is the net underneath it: scan
// every synced transcript for the agent thinking out loud. It happened once on a live client call
// (an invented `[thought]` tag, with the whole reasoning paragraph read aloud), and the way we found
// out was the client. Finding out from the console instead is the entire point of this.
const APPROVED_AUDIO_TAGS = ['warmly', 'smiling', 'friendly', 'cheerfully', 'gently', 'softly', 'empathetically',
  'sympathetically', 'reassuringly', 'sincerely', 'apologetic', 'regretful', 'thoughtful', 'curious', 'hesitates',
  'surprised', 'slowly', 'deliberately', 'quietly', 'excited', 'professional', 'firmly', 'serious',
  'laughs', 'chuckles', 'sighs', 'exhales', 'clears throat', 'short pause'];
const LEAK_TELLS = [
  [/\[(?!(?:$|\s))([a-z_ ]{2,20})\]/gi, 'bracket'],                       // any bracketed token, filtered below
  [/\b(?:the user|the customer) (?:has|is|wants|provided|said|mentioned)\b/gi, 'reasoning about the caller'],
  // Narration only counts when it names the MACHINERY. "I need to check that with a specialist" is
  // ordinary, decent speech and must never trip this; "I need to confirm and then use the tool" is
  // the agent reading its own plan aloud.
  [/\bI (?:need to|should|will|must|am going to|am now going to)\b[^.!?]{0,80}\b(?:tool|function|the call outcome|record the outcome|end the call|the system|my instructions|next step)\b/gi, 'narrating its next step'],
  [/\blet me think\b|\bthinking:|\bmy reasoning\b|\bstep \d[:.]/gi, 'thinking out loud'],
  [/\b(?:book_appointment|record_call_outcome|schedule_callback|mark_do_not_call|transfer_to_human|capture_lead|log_promise_to_pay|flag_dispute|end_call)\b/g, 'tool name spoken'],
  [/\{\{[a-z_]+\}\}/gi, 'unfilled variable spoken']
];
function detectPromptLeak(transcript) {
  if (!transcript) return null;
  const agentLines = String(transcript).split('\n').filter(l => /^Agent:/i.test(l)).join('\n');
  if (!agentLines) return null;
  const found = [];
  LEAK_TELLS.forEach(([rx, label]) => {
    const hits = agentLines.match(rx);
    if (!hits) return;
    if (label === 'bracket') {
      // Only an UNAPPROVED bracket is a leak. [warmly] is doing its job.
      const bad = [...new Set(hits.map(h => h.replace(/[[\]]/g, '').trim().toLowerCase())
        .filter(t => !APPROVED_AUDIO_TAGS.includes(t)))];
      if (bad.length) found.push(`unapproved bracket: ${bad.slice(0, 4).map(b => '[' + b + ']').join(', ')}`);
    } else found.push(label);
  });
  return found.length ? [...new Set(found)] : null;
}

function enrichEntryFromCall(entry, norm, recordingUrl) {
  if (!entry || !norm) return;
  if (norm.call_status) entry.callStatus = norm.call_status;
  if (norm.has_audio !== undefined) entry.hasAudio = norm.has_audio;
  if (recordingUrl) entry.recordingUrl = recordingUrl;
  else if (norm.recording_url) entry.recordingUrl = norm.recording_url;
  if (norm.transcript) {
    entry.transcript = norm.transcript;
    const leak = detectPromptLeak(norm.transcript);
    if (leak) {
      entry.promptLeak = leak;
      console.log(`⚠️  PROMPT LEAK on call ${entry.callId}: the agent spoke ${leak.join('; ')} — review the transcript.`);
    } else if (entry.promptLeak) delete entry.promptLeak;
  }
  if (norm.disconnection_reason) entry.disconnectionReason = norm.disconnection_reason;
  if (norm.duration_ms) entry.durationMs = norm.duration_ms;
  if (norm.summary) entry.summary = norm.summary;
  if (norm.user_sentiment) entry.userSentiment = norm.user_sentiment;
  if (norm.call_successful !== undefined) entry.callSuccessful = norm.call_successful;
  if (norm.public_log_url) entry.publicLogUrl = norm.public_log_url;
  saveHistory();
}
function adapterForEntry(entry) { return getProvider(entry && entry.provider ? entry.provider : activeProviderName()); }

// ── BACKGROUND CALL-STATUS SYNC ─────────────────────────
// A provider never tells us a call has finished — it has to be asked. Without this, an entry kept
// whatever status it was created with until somebody happened to open it, which is why a finished
// call sat on "in progress" until you clicked play, and why analytics counted it as still pending.
const SETTLED_STATUS = new Set(['ended', 'completed', 'failed', 'error', 'no_answer', 'no-answer', 'busy', 'canceled', 'cancelled']);
function callSettled(c) { return SETTLED_STATUS.has(String(c.callStatus || '').toLowerCase()); }
function needsStatusSync(c) {
  if (!c || !c.callId || c.simulated) return false;
  if (c.status === 'failed') return false;                       // never left the building
  if (callSettled(c) && (c.transcript || c.durationMs)) return false;
  const age = Date.now() - Date.parse(c.timestamp || 0);
  return age >= 0 && age < 6 * 60 * 60 * 1000;                   // stop chasing after six hours
}
let _statusSyncBusy = false;
async function syncPendingCalls() {
  if (_statusSyncBusy) return;
  _statusSyncBusy = true;
  try {
    const targets = callHistory.filter(needsStatusSync).slice(0, 25);
    for (const c of targets) {
      const adapter = adapterForEntry(c);
      if (!adapter.isConfigured(config)) continue;
      try {
        const norm = await adapter.getCall(c.callId, config);
        // No request here, so no proxy URL to build; hasAudio still gets set and the detail view
        // fills the playable URL in when it is opened.
        enrichEntryFromCall(c, norm, norm.recording_url || '');
      } catch (e) { /* a transient provider error just means we try again on the next tick */ }
    }
  } finally { _statusSyncBusy = false; }
}
function audioProxyUrl(req, callId) { return `${req.protocol}://${req.get('host')}/api/call/${encodeURIComponent(callId)}/audio`; }

// Put every call in exactly one bucket for connect-rate math. Real ElevenLabs calls usually have NO
// `disposition` (that only comes from the record_call_outcome tool or the simulator), so we fall back
// to provider signals — callStatus, callSuccessful, duration — instead of scoring them as "not connected".
//   failed    → never placed, or the provider/agent errored out
//   noReach   → placed but nobody was reached (voicemail / no answer / wrong person / instant drop)
//   connected → a real conversation happened
//   pending   → placed, but its outcome hasn't been synced back yet (don't count against the rate)
function classifyCall(c) {
  const dur = c.durationMs || 0;
  const cs = (c.callStatus || '').toLowerCase();
  const disp = c.disposition || '';
  if (c.status === 'failed' || cs === 'failed' || cs === 'error') return 'failed';
  if (disp === 'no_answer_voicemail' || disp === 'wrong_person') return 'noReach';
  if (disp) return 'connected';                       // any real disposition means a person was reached
  if (c.callSuccessful === true) return 'connected';
  if (cs === 'ended') return dur >= 10000 ? 'connected' : 'noReach'; // ended: talked vs quick drop / VM
  return 'pending';                                   // placed, awaiting outcome sync
}

// ── AGENT-TOOL OUTCOMES (mid-call webhook actions) ──────
// The voice agent calls a tool (e.g. log_promise_to_pay) via ElevenLabs; we attach the structured
// outcome to the matching call in history and hand back a natural line for the agent to speak.
function findCallEntry(convId) {
  if (convId) { const m = callHistory.find(c => c.callId === convId || c.id === convId); if (m) return m; }
  return callHistory.length ? callHistory[0] : null; // demo fallback: the most recent call
}
function fillTemplate(tpl, params) { return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined && params[k] !== null && params[k] !== '') ? params[k] : ''); }
function toolMessage(spec, params) { const m = fillTemplate(spec && spec.say, params).replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim(); return m || 'Done.'; }
function applyOutcome(entry, tool, p) {
  switch (tool) {
    case 'record_call_outcome': entry.disposition = p.disposition || entry.disposition; entry.outcomeSummary = p.summary || entry.outcomeSummary; if (p.sentiment) entry.userSentiment = p.sentiment; break;
    case 'schedule_callback': entry.callback = { time: p.callback_time || '', reason: p.reason || '' }; break;
    case 'mark_do_not_call': entry.dnc = true; entry.dncReason = p.reason || ''; entry.dncScope = p.scope || 'all'; break;
    case 'transfer_to_human': entry.transferred = { department: p.department || '', reason: p.reason || '' }; break;
    case 'update_contact_info': entry.contactUpdates = entry.contactUpdates || []; entry.contactUpdates.push({ field: p.field || '', value: p.value || '' }); break;
    case 'send_followup': entry.followups = entry.followups || []; entry.followups.push({ channel: p.channel || '', content: p.content_type || '' }); break;
    case 'log_promise_to_pay': entry.promiseToPay = { amount: p.amount || '', date: p.promised_date || '', method: p.method || '' }; break;
    case 'flag_dispute': entry.dispute = { about: p.about || '', details: p.details || '' }; break;
    case 'capture_survey_response': entry.survey = { score: p.score || '', scale: p.scale || '', sentiment: p.sentiment || '', verbatim: p.verbatim || '', would_recommend: p.would_recommend || '' }; if (p.sentiment) entry.userSentiment = p.sentiment; break;
    case 'book_appointment': entry.appointment = { status: 'booked', date: p.date || '', time: p.time || '', type: p.type || '', location: p.location || '' }; break;
    case 'reschedule_appointment': entry.appointment = { status: 'rescheduled', date: p.new_date || '', time: p.new_time || '' }; break;
    case 'cancel_appointment': entry.appointment = { status: 'cancelled', reason: p.reason || '' }; break;
    case 'capture_lead': entry.lead = { qualified: p.qualified || '', interest: p.interest || '', budget: p.budget || '', timeline: p.timeline || '', notes: p.notes || '' }; break;
    case 'log_renewal_decision': entry.renewal = { decision: p.decision || '', reason: p.reason || '', offer_accepted: p.offer_accepted || '' }; break;
  }
}
// Push completed-call outcomes back to the configured system of record (CRM/DB/sheet/webhook).
async function runWritebackForEntries(entries, cfg, ownerId) {
  const sinkName = cfg.sink || 'echo';
  const sink = connectors.sinks[sinkName];
  if (!sink) throw new Error(`Unknown sink: ${sinkName}`);
  const rows = entries.map(e => connectors.buildWritebackRow(e, cfg.mapping));
  const result = await sink.push(rows, { ...(cfg.config || {}), _ownerId: ownerId || null });
  const at = new Date().toISOString();
  entries.forEach(e => { e.writeback = { ok: !!result.ok, sink: sinkName, detail: result.detail, at }; });
  saveHistory();
  return { ...result, rows, sink: sinkName };
}

// ── SCHEDULER ───────────────────────────────────────────
// Runs scheduled calls and campaigns without anyone at a keyboard. Each schedule carries its own
// agent profile snapshot, so several different agents can be dialling different markets at once,
// each in its own timezone and calling window.
function saveSchedules() { store.saveSchedules(schedules); }
// Org-wide like everything else, so a colleague covering for someone can see what is queued to
// dial. Pausing or deleting a schedule remains the owner's, checked at each mutating endpoint.
function ownSchedules(req) { return isPlatformAdmin(req.user) ? schedules : schedules.filter(inMyOrg(req)); }
function scheduleView(s) {
  return { ...s, agentProfile: undefined, company: ((s.agentProfile || {}).company || {}).name || '',
    describe: sched.describe(s), nextRunAt: sched.nextRunAt(s), state: sched.evaluate(s).reason,
    targetCount: s.target && Array.isArray(s.target.customers) ? s.target.customers.length : 1 };
}
function noteRun(s, entry) {
  s.runs = s.runs || [];
  s.runs.unshift({ at: new Date().toISOString(), ...entry });
  if (s.runs.length > 25) s.runs.length = 25;
  s.lastRunAt = new Date().toISOString();
}

// Place everything a schedule is meant to place. Reuses the same paths as a manual call, so
// guardrails, per-user attribution, write-back and analytics all behave identically.
async function runSchedule(s, opts = {}) {
  const user = auth.findById(s.userId);
  if (!user || user.active === false) { noteRun(s, { ok: false, note: 'owner account is inactive' }); s.enabled = false; return; }
  const fakeReq = { user };                       // guardrails + stamping expect a req-like object
  const profile = s.agentProfile || userProfiles[s.userId] || activeProfile;
  const simulate = !!s.simulate;
  const gate = guardCheck(fakeReq, simulate);
  if (!gate.ok) { noteRun(s, { ok: false, note: `blocked by guardrails: ${gate.error}` }); return; }
  if (!simulate && !providerConfigured(activeProviderName(profile))) { noteRun(s, { ok: false, note: 'voice provider not configured' }); return; }

  const targets = (s.target && Array.isArray(s.target.customers) && s.target.customers.length)
    ? s.target.customers
    : [{ to_number: (s.target || {}).toNumber, customer_name: (s.target || {}).customerName, variables: (s.target || {}).variables || {} }];
  // Stamped onto every call, not looked up later: a partner who re-skins their agent for a different
  // industry tomorrow must not retroactively relabel what they demonstrated today.
  const company = (profile.company || {}).name || '', industry = (profile.company || {}).industry || '';
  let placed = 0, failed = 0;
  const delayMs = simulate ? 150 : Math.max(1, (s.delaySeconds || config.bulkDelay || 3)) * 1000;

  for (let i = 0; i < targets.length; i++) {
    if (s._cancelRun) break;
    const t = targets[i];
    if (!t || !t.to_number) { failed++; continue; }
    // Re-check guardrails per call so a daily cap stops a long campaign part-way rather than after.
    if (!simulate && !guardCheck(fakeReq, false).ok) { noteRun(s, { ok: false, note: 'stopped part-way: guardrail limit reached' }); break; }
    const vars = { customer_name: t.customer_name, use_case: t.use_case || s.useCase, time: autoTimeOfDay(), ...(t.variables || {}) };
    try {
      let entry;
      if (simulate) {
        entry = makeSimulatedEntry(t.to_number, vars, profile);
      } else {
        const { providerName, providerCallId } = await placeCall(t.to_number, vars, profile, fakeReq.user);
        entry = { id: uuidv4(), toNumber: t.to_number, customerName: t.customer_name || '', useCase: vars.use_case || '', company, industry, provider: providerName, callId: providerCallId, status: 'initiated', timestamp: new Date().toISOString(), variables: vars };
      }
      entry.scheduleId = s.id; entry.scheduleName = s.name;
      stampUser(entry, user); callHistory.unshift(entry); placed++;
      const wb = getWriteback(s.userId);
      if (simulate && wb.enabled) { try { await runWritebackForEntries([entry], wb, s.userId); } catch (e) { /* keep going */ } }
    } catch (err) {
      const entry = { id: uuidv4(), toNumber: t.to_number, customerName: t.customer_name || '', useCase: vars.use_case || '', company, industry, provider: activeProviderName(profile), status: 'failed', error: err.message, timestamp: new Date().toISOString(), variables: vars, scheduleId: s.id, scheduleName: s.name };
      stampUser(entry, user); callHistory.unshift(entry); failed++;
    }
    if (i < targets.length - 1 && !s._cancelRun) await sleep(delayMs);
  }
  saveHistory();
  noteRun(s, { ok: placed > 0, placed, failed, simulated: simulate, note: opts.manual ? 'run manually' : 'ran on schedule' });
  if ((s.when || {}).mode === 'once') s.status = 'completed';
}

// One tick: fire everything that is due. Schedules run concurrently, so a long campaign in one
// timezone never delays a different agent's slot in another.
let _tickBusy = false;
async function schedulerTick() {
  if (_tickBusy) return; _tickBusy = true;
  try {
    const now = new Date();
    const due = schedules.filter(s => { const e = sched.evaluate(s, now); if (!e.due) return false; s._slot = e.slotKey; return true; });
    if (!due.length) return;
    due.forEach(s => { s.ranSlots = [...(s.ranSlots || []), s._slot].slice(-60); s.status = 'running'; });
    saveSchedules();
    await Promise.all(due.map(async s => {
      try { await runSchedule(s); } catch (e) { noteRun(s, { ok: false, note: 'error: ' + e.message }); }
      if (s.status === 'running') s.status = 'scheduled';
    }));
    saveSchedules();
  } catch (e) { console.warn('Scheduler tick failed:', e.message); }
  finally { _tickBusy = false; }
}

// ── API ROUTES ──────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), provider: activeProviderName(), configured: providerConfigured(activeProviderName()), company: (activeProfile.company || {}).name || '' }));

// ── AUTH ────────────────────────────────────────────────
// Password sign-in is the ONE route that bypasses every protection on the code flow: no five-attempt
// lockout, no device binding, no per-address throttle. It had no rate limit whatsoever, and the only
// accounts holding passwords are administrators, who can see every organisation's calls and the
// Settings page with the provider key. So: an IP ceiling, plus a per-ACCOUNT lockout, because
// rotating IP addresses defeats an IP limit on its own.
// Sized for a shared office, like the code endpoints: a whole company arrives from one NAT address,
// and the per-ACCOUNT lockout below is what actually bounds guessing. This ceiling only stops one
// address spraying many accounts.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, message: { error: 'Too many sign-in attempts from this network. Please wait a few minutes and try again.' } });
const LOGIN_MAX_FAILS = 8, LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map();   // email -> { count, until } — in memory; a restart clearing it is fine
function loginLockedMinutes(email) {
  const f = loginFailures.get(email);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function noteLoginFailure(email) {
  const f = loginFailures.get(email) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= LOGIN_MAX_FAILS) { f.until = Date.now() + LOGIN_LOCK_MS; f.count = 0; }
  loginFailures.set(email, f);
}

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const key = String(email || '').toLowerCase();
  const locked = loginLockedMinutes(key);
  // Deliberately says "this account", not "this account exists": the same message would be returned
  // for an address that was never real, so it still reveals nothing.
  if (locked) return res.status(429).json({ error: `Too many failed attempts on this account. Try again in ${locked} minute${locked === 1 ? '' : 's'}, or sign in with an emailed code instead.` });
  const u = auth.findByEmail(email || '');
  // Check the password FIRST, then explain the account state — so we never reveal whether an
  // email exists to someone who doesn't know its password.
  if (!u || !auth.verifyPassword(password || '', u.passwordHash)) { noteLoginFailure(key); return res.status(401).json({ error: 'Invalid email or password.' }); }
  loginFailures.delete(key);
  if (u.active === false) return res.status(403).json({ error: u.pending ? 'Your account is awaiting approval by an administrator.' : 'This account has been disabled. Please contact your administrator.', pending: !!u.pending });
  u.lastLogin = new Date().toISOString(); auth.upsertUser(u);
  res.json({ token: auth.signSession(u), user: userForClient(u) });
});

// What the login screen needs to know before anyone signs in: is self-signup open?
app.get('/api/auth/signup-info', (req, res) => res.json({ enabled: !!signup.enabled, codeSignIn: true }));

// ══ PASSWORDLESS SIGN-IN ════════════════════════════════
// Enter a work email, receive a six-digit code, type it in. The whitelist decides WHO may ask for a
// code; the code proves they actually hold that mailbox. See signin.js for why it is a number and
// not a link, and why the attempt limit rather than the hash is what protects it.
function saveOtps() { store.saveOtps(otps); }
function saveAccessRequests() { store.saveAccessRequests(accessRequests); }
function findOtp(email) { const e = String(email).toLowerCase(); return otps.find(o => o.email === e); }
function dropOtp(email) { const e = String(email).toLowerCase(); otps = otps.filter(o => o.email !== e); saveOtps(); }

// Per-IP ceilings, which do a DIFFERENT job from the per-address throttle further down: that one
// stops one person being mail-bombed, this one stops somebody spraying many addresses at once.
//
// Sized for a shared office, not for one user. A whole partner company sits behind a single NAT
// address, so a tight per-IP limit does not inconvenience an attacker (who changes IP) while it
// locks out the eleventh colleague to arrive on Monday morning. Sixty new addresses in a quarter
// of an hour from one office is clearly abuse; ten people signing in is not. Verifying sends no
// mail and is already capped at five tries per code, so it can be looser still.
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { error: 'Too many sign-in requests from this network. Please wait a few minutes and try again.' } });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, message: { error: 'Too many attempts. Please wait a few minutes and try again.' } });

app.post('/api/auth/request-code', codeLimiter, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  // A device that has already proved this mailbox once skips the code. This matters more than it
  // sounds: without it, somebody about to demo to their prospect is standing there waiting on an
  // email. Revocation still applies, because the device token carries the same tokenVersion.
  if (b.deviceToken) {
    const p = auth.verifyToken(b.deviceToken);
    if (p && p.purpose === 'device' && p.email === email) {
      const u = auth.findByEmail(email);
      if (u && u.active !== false && (p.tv || 0) === auth.tokenVersionOf(u)) {
        return res.json({ ok: true, signedIn: true, token: auth.signSession(u), user: userForClient(u) });
      }
    }
  }

  const existing = auth.findByEmail(email);
  if (existing && existing.active === false) {
    return res.status(403).json({ error: existing.pending ? 'Your account is awaiting approval by an administrator.' : 'This account has been disabled. Please contact your administrator.' });
  }

  // An existing active account keeps working even if its domain later leaves the whitelist: it was
  // approved once, and silently locking somebody out because a list changed is its own outage.
  if (!existing && !signin.isWhitelisted(email, signup)) {
    recordAccessRequest(req, email, b);
    // Told plainly rather than left waiting for a code that will never arrive. This does reveal
    // whether a DOMAIN is approved, which is a deliberate trade: knowing "streebo.com is allowed"
    // is worth little without the mailbox, whereas the account list stays private either way.
    return res.json({ ok: true, pending: true, message: 'That email is not on an approved company domain. Your request has been sent to an administrator for review.' });
  }

  const sends = signin.sendsInWindow(otpSendLog, email);
  if (sends >= signin.MAX_SENDS_PER_WINDOW) {
    return res.status(429).json({ error: `A code has already been sent to that address ${sends} times recently. Please wait a few minutes, and check your junk folder.` });
  }

  const code = signin.generateCode();
  const rec = signin.newRecord({ email, code, secret: auth.secret(), ip: signin.clientIp(req), userAgent: req.get('user-agent') });
  const mins = Math.round(signin.CODE_TTL_MS / 60000);
  try {
    await mailer.send({
      to: email,
      subject: `Your OmniReach sign-in code: ${code}`,
      text: `Your OmniReach sign-in code is ${code}\n\nIt expires in ${mins} minutes and can only be used once.\n\nIf you did not try to sign in, you can ignore this message. The code is useless without it.\n`
    });
  } catch (e) {
    // The real reason goes to the log, never to the browser: it can name the mailbox and the tenant.
    console.warn(`Could not send a sign-in code to ${email}: ${e.message}`);
    return res.status(502).json({ error: 'We could not send the code just now. Please try again in a moment, or contact your administrator.' });
  }

  dropOtp(email);                    // one live code per address; asking again replaces the old one
  otps.push(rec); saveOtps();
  otpSendLog = otpSendLog.filter(x => x.at >= Date.now() - signin.RESEND_WINDOW_MS).concat([{ email, at: Date.now() }]);
  res.json({ ok: true, sent: true, deviceId: rec.deviceId, expiresInMinutes: mins, devMode: !mailer.status().delivers });
});

app.post('/api/auth/verify-code', verifyLimiter, (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const rec = findOtp(email);
  const r = signin.checkCode(rec, b.code, b.deviceId, auth.secret());
  if (r.consume) dropOtp(email); else if (rec) saveOtps();   // persist the incremented attempt count

  if (!r.ok) {
    const messages = {
      no_code: 'That code has expired or was already used. Please request a new one.',
      expired: 'That code has expired. Please request a new one.',
      wrong_device: 'Please enter the code in the same browser window that requested it.',
      too_many_attempts: 'Too many incorrect attempts. That code is no longer valid; please request a new one.',
      wrong_code: `That code is not correct.${r.remaining ? ` ${r.remaining} attempt${r.remaining === 1 ? '' : 's'} remaining.` : ''}`
    };
    return res.status(401).json({ error: messages[r.reason] || 'That code is not correct.', code: r.reason });
  }

  // First sign-in on an approved domain creates the account, which is what "no manual invites"
  // means: nobody at Streebo has to provision a colleague of a partner one at a time.
  let u = auth.findByEmail(email);
  if (!u) {
    // Normally the email domain IS the organisation. But an individually approved address often is
    // not: a colleague on a personal address, or a contractor. If the admin named an organisation
    // when approving them, honour it — otherwise that person lands alone in a "gmail.com" org and
    // cannot see their own team's calls, which is precisely the confusion this is meant to prevent.
    const approved = accessRequests.find(r => r.email === email && r.status === 'approved' && r.orgId);
    const orgId = approved ? approved.orgId : signin.domainOf(email);
    if (approved) console.log(`👥  ${email} placed in "${orgId}" as decided when their request was approved.`);
    u = {
      id: uuidv4(), email, name: String(b.name || '').trim() || email.split('@')[0],
      org: String(b.company || '').trim(), orgId, role: 'user',
      passwordHash: '', active: true, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(),
      signInMethod: 'code', approvedByDomain: true,
      // No per-user quota: the platform default applies, so one admin change moves everybody.
      quota: { callsPerDay: null, minutesPerDay: null }, usage: { calls: 0 }
    };
    auth.upsertUser(u);
    console.log(`👤  New account created by verified email: ${email} (org ${u.orgId})`);
  } else {
    u.lastSignInAt = new Date().toISOString();
    if (!u.verifiedAt) u.verifiedAt = u.lastSignInAt;
    auth.upsertUser(u);
  }

  res.json({
    ok: true, token: auth.signSession(u), user: userForClient(u),
    // Remembers this browser so the next sign-in needs no email at all.
    deviceToken: auth.signToken({ email, purpose: 'device', tv: auth.tokenVersionOf(u) }, signin.DEVICE_TTL_DAYS)
  });
});

/** Log somebody we would not let in, so an admin can decide. Deduplicated per address. */
function recordAccessRequest(req, email, b) {
  const cls = signin.classifyDomain(email);
  const existing = accessRequests.find(r => r.email === email && r.status === 'pending');
  const seen = {
    lastAttemptAt: new Date().toISOString(),
    ip: signin.clientIp(req),
    timezone: String(b.timezone || '').slice(0, 64),
    language: String(b.language || '').slice(0, 32),
    userAgent: String(req.get('user-agent') || '').slice(0, 200)
  };
  seen.region = signin.regionFrom({ timezone: seen.timezone, language: seen.language });
  if (existing) {
    existing.attempts = (existing.attempts || 1) + 1;
    Object.assign(existing, seen);
  } else {
    accessRequests.unshift({
      id: uuidv4(), email, name: String(b.name || '').trim(), company: String(b.company || '').trim(),
      domain: cls.domain, consumerDomain: cls.consumer, disposableDomain: cls.disposable,
      requestedAt: new Date().toISOString(), attempts: 1, status: 'pending', ...seen
    });
    if (accessRequests.length > 2000) accessRequests.length = 2000;
  }
  saveAccessRequests();
}

// Self-registration. Always creates a plain 'user'; role/quota/active can never be set by the caller.
app.post('/api/auth/register', callLimiter, (req, res) => {
  if (!signup.enabled) return res.status(403).json({ error: 'Self-registration is turned off. Please ask your administrator for an account.' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (auth.findByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  const trusted = domainWhitelisted(email);
  if (!trusted && !signup.allowOthersPending) return res.status(403).json({ error: 'Registration is limited to approved company email domains. Please ask your administrator for an account.' });
  const u = {
    id: uuidv4(), email, name: b.name || email, org: b.org || '', orgId: domainOf(email), role: 'user',
    passwordHash: auth.hashPassword(password),
    active: trusted, pending: !trusted, selfRegistered: true, approvedByDomain: trusted || undefined,
    createdAt: new Date().toISOString(),
    // Auto-approved accounts get a conservative cap (domain is not identity proof); pending ones inherit the default.
    quota: { callsPerDay: trusted ? (signup.autoApproveCallsPerDay != null ? signup.autoApproveCallsPerDay : null) : null },
    usage: { calls: 0 }
  };
  auth.upsertUser(u);
  if (!trusted) return res.json({ success: true, pending: true, message: 'Account created. An administrator needs to approve it before you can sign in.' });
  u.lastLogin = new Date().toISOString(); auth.upsertUser(u);
  res.json({ success: true, pending: false, token: auth.signSession(u), user: userForClient(u) });
});
app.get('/api/auth/me', (req, res) => res.json({ user: userForClient(req.user) }));

// Change your OWN password. Requires the current one, so a hijacked open tab can't lock the owner out.
app.post('/api/auth/password', callLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = req.user;
  if (!auth.verifyPassword(currentPassword || '', u.passwordHash)) return res.status(401).json({ error: 'Your current password is not correct.' });
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: 'The new password must be different from the current one.' });
  u.passwordHash = auth.hashPassword(newPassword);
  u.mustChangePassword = false;
  u.passwordChangedAt = new Date().toISOString();
  // Changing a password is often a response to "somebody may have my credentials", so it has to end
  // the other sessions too. That includes this one, hence the fresh token below.
  auth.revokeSessions(u);
  res.json({ success: true, user: userForClient(u), token: auth.signSession(u) });
});
// Current user's own usage + the limits that apply to them (for the console's usage chip).
app.get('/api/usage', (req, res) => {
  const u = req.user, lim = effectiveLimit(u);
  const exempt = isPlatformAdmin(u);
  const secsUsed = realSecondsToday(u.id), minLim = exempt ? null : effectiveMinuteLimit(u);
  res.json({
    today: realCallsToday(u.id), total: realCallsTotal(u.id), limit: (exempt ? null : lim),
    // Talk time alongside the call count, since either can be what actually stops you.
    minutesLimit: minLim, secondsUsedToday: secsUsed, secondsLeftToday: remainingSecondsToday(u),
    enforced: !!guardrails.enforceQuota, simulationOnly: !!guardrails.simulationOnly,
    isAdmin: u.role === 'admin', isPlatformAdmin: isPlatformAdmin(u), isSuperAdmin: isSuper(u),
    mayBulkCall: mayBulkCall(u), boost: activeBoost(u) || null, bulkMessage: mayBulkCall(u) ? null : bulkBlockedMessage(u)
  });
});

// ── ADMIN · user management ─────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  // A partner admin manages their own colleagues. Listing every account would leak the whole
  // customer base: who else is on the platform, and which companies Streebo works with.
  const all = auth.loadUsers();
  const users = (isPlatformAdmin(req.user) ? all : all.filter(u => orgIdOf(u) === orgIdOf(req.user))).map(auth.publicUser);
  users.forEach(u => {
    const calls = callHistory.filter(c => c.userId === u.id);
    u.stats = { calls: calls.length, today: realCallsToday(u.id), secondsToday: realSecondsToday(u.id), lastCall: calls[0] ? calls[0].timestamp : null };
    u.effectiveLimit = effectiveLimit(u); u.effectiveMinuteLimit = effectiveMinuteLimit(u); u.orgId = orgIdOf(u);
    u.activeBoost = activeBoost(u) || null; u.mayBulkCall = mayBulkCall(u);
  });
  // The console needs to know what THIS admin is allowed to do, so it can hide controls that would
  // only 403. Showing a button that always fails is worse than not showing it.
  res.set('X-Admin-Tier', isSuper(req.user) ? 'super' : (mayGrantAdmin(req.user) ? 'granting' : 'admin'));
  res.json({ users, scope: isPlatformAdmin(req.user) ? 'platform' : orgIdOf(req.user) });
});
// Guardrail config (admin): read + update. Everything defaults OFF; saving persists to data/guardrails.json.
app.get('/api/admin/guardrails', requirePlatformAdmin, (req, res) => res.json({ guardrails }));
app.post('/api/admin/guardrails', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  if (b.enforceQuota !== undefined) guardrails.enforceQuota = !!b.enforceQuota;
  if (b.simulationOnly !== undefined) guardrails.simulationOnly = !!b.simulationOnly;
  if (b.defaultCallsPerDay !== undefined) guardrails.defaultCallsPerDay = (b.defaultCallsPerDay === null || b.defaultCallsPerDay === '') ? null : parseInt(b.defaultCallsPerDay);
  if (b.defaultMinutesPerDay !== undefined) guardrails.defaultMinutesPerDay = (b.defaultMinutesPerDay === null || b.defaultMinutesPerDay === '') ? null : parseInt(b.defaultMinutesPerDay);
  if (b.allowBulkForPartners !== undefined) guardrails.allowBulkForPartners = !!b.allowBulkForPartners;
  if (b.rateLimitPerMin !== undefined) guardrails.rateLimitPerMin = (b.rateLimitPerMin === null || b.rateLimitPerMin === '') ? null : parseInt(b.rateLimitPerMin);
  saveGuardrails();
  res.json({ success: true, guardrails });
});
// Self-signup config (admin): enable, whitelist domains, cap auto-approved accounts.
app.get('/api/admin/signup', requirePlatformAdmin, (req, res) => res.json({ signup }));
app.post('/api/admin/signup', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  if (b.enabled !== undefined) signup.enabled = !!b.enabled;
  if (b.allowOthersPending !== undefined) signup.allowOthersPending = !!b.allowOthersPending;
  if (b.autoApproveCallsPerDay !== undefined) signup.autoApproveCallsPerDay = (b.autoApproveCallsPerDay === null || b.autoApproveCallsPerDay === '') ? null : parseInt(b.autoApproveCallsPerDay);
  if (b.allowedDomains !== undefined) {
    const raw = Array.isArray(b.allowedDomains) ? b.allowedDomains : String(b.allowedDomains).split(/[\s,;\n]+/);
    signup.allowedDomains = [...new Set(raw.map(signin.normaliseDomain).filter(Boolean))];
  }
  // Individually approved addresses, for a company we do not want to open wholesale.
  if (b.allowedEmails !== undefined) {
    const raw = Array.isArray(b.allowedEmails) ? b.allowedEmails : String(b.allowedEmails).split(/[\s,;\n]+/);
    signup.allowedEmails = [...new Set(raw.map(x => String(x).trim().toLowerCase()).filter(x => x.includes('@')))];
  }
  saveSignup();
  res.json({ success: true, signup });
});
// ── ADMIN · access requests ─────────────────────────────
// People who tried to sign in from a domain that is not whitelisted. Nobody gets in this way
// without an explicit decision here.
app.get('/api/admin/access-requests', requirePlatformAdmin, (req, res) => {
  const status = req.query.status;
  const list = status ? accessRequests.filter(r => r.status === status) : accessRequests;
  res.json({
    requests: list.slice(0, 500),
    counts: accessRequests.reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o; }, {})
  });
});
app.post('/api/admin/access-requests/:id/approve', requirePlatformAdmin, (req, res) => {
  const r = accessRequests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'pending') return res.status(409).json({ error: `That request was already ${r.status}.` });

  // Approving whitelists the ADDRESS, not the domain. Approving one person at a company must never
  // silently open the door to everybody who shares their email suffix; widening to a whole domain
  // stays a separate, deliberate act in the signup settings.
  const email = String(r.email).toLowerCase();
  if (!(signup.allowedEmails || []).includes(email)) { signup.allowedEmails = [...(signup.allowedEmails || []), email]; saveSignup(); }

  // No account is created here. They still have to prove the mailbox with a code, which is the
  // whole point: approval grants permission to try, not access.
  r.status = 'approved'; r.decidedBy = req.user.id; r.decidedByEmail = req.user.email; r.decidedAt = new Date().toISOString();
  // Which organisation they join. Matters most for an address whose domain is not their employer,
  // where the default would strand them in an org of one.
  const chosen = signin.normaliseDomain((req.body || {}).orgId);
  if (chosen) r.orgId = chosen;
  saveAccessRequests();
  res.json({
    success: true, request: r,
    message: `${email} can now request a sign-in code${r.orgId ? `, and will join "${r.orgId}"` : ''}.`
  });
});
app.post('/api/admin/access-requests/:id/reject', requirePlatformAdmin, (req, res) => {
  const r = accessRequests.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found.' });
  if (r.status !== 'pending') return res.status(409).json({ error: `That request was already ${r.status}.` });
  r.status = 'rejected'; r.decidedBy = req.user.id; r.decidedByEmail = req.user.email;
  r.decidedAt = new Date().toISOString(); r.reason = String((req.body || {}).reason || '').slice(0, 300);
  saveAccessRequests();
  res.json({ success: true, request: r });
});

// Approve (or reject) a pending self-registered account.
app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  const u = auth.findById(req.params.id); if (!u) return res.status(404).json({ error: 'User not found.' });
  if (!isPlatformAdmin(req.user) && orgIdOf(u) !== orgIdOf(req.user)) return res.status(403).json({ error: 'That account is not in your organisation.' });
  u.active = true; u.pending = false; u.approvedBy = req.user.id; u.approvedAt = new Date().toISOString();
  auth.upsertUser(u);
  res.json({ success: true, user: userForClient(u) });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.email) return res.status(400).json({ error: 'An email address is required.' });
  if (auth.findByEmail(b.email)) return res.status(409).json({ error: 'A user with that email already exists.' });
  // A password is OPTIONAL. Everyone signs in with a code sent to their mailbox, and an account
  // created here is active, so it can request one even from a domain that is not whitelisted. Set a
  // password only when a fallback is genuinely wanted; if one is set, it must be replaced at first use.
  // orgId defaults to the email domain, but an admin can override it so somebody whose address does
  // not match their employer still lands with their colleagues rather than alone in their own org.
  const email = String(b.email).toLowerCase();
  if (b.role === 'admin' && !mayGrantAdmin(req.user)) return res.status(403).json({ error: 'You cannot create administrator accounts. Ask a super administrator to grant you that.' });
  // A partner admin can only add colleagues to their OWN company, whatever they put in the form.
  // Otherwise "add a user" would be a way to plant an account inside another partner's org and read
  // its calls from the inside.
  const orgId = isPlatformAdmin(req.user)
    ? String(b.orgId || domainOf(email)).toLowerCase()
    : orgIdOf(req.user);
  const u = { id: uuidv4(), email, name: b.name || b.email, org: b.org || '', orgId, role: b.role === 'admin' ? 'admin' : 'user', active: true, createdAt: new Date().toISOString(), createdBy: req.user.id, quota: { callsPerDay: b.callsPerDay != null && b.callsPerDay !== '' ? parseInt(b.callsPerDay) : null }, usage: { calls: 0 } };
  if (b.password) { u.passwordHash = auth.hashPassword(b.password); u.mustChangePassword = true; }
  auth.upsertUser(u);
  console.log(`👤  ${req.user.email} created ${email} in "${orgId}"${b.password ? ' with a temporary password' : ' (code sign-in only)'}.`);
  res.json({ success: true, user: userForClient(u), message: b.password ? `Created ${email}. They must change the temporary password at first sign-in.` : `Created ${email}. They sign in with a code sent to that mailbox.` });
});
app.post('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = auth.findById(req.params.id); if (!u) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};

  // Who may touch this account at all, before working out which fields may change.
  const blocked = blockedFromEditing(req.user, u);
  if (blocked) return res.status(403).json({ error: blocked });
  // A partner admin administers their own company only, and cannot move anyone into or out of it.
  if (!isPlatformAdmin(req.user)) {
    if (orgIdOf(u) !== orgIdOf(req.user)) return res.status(403).json({ error: 'That account is not in your organisation.' });
    if (b.orgId !== undefined && String(b.orgId).toLowerCase().trim() !== orgIdOf(req.user)) {
      return res.status(403).json({ error: 'You cannot move an account into another organisation.' });
    }
  }
  if (b.role !== undefined && !mayGrantAdmin(req.user)) return res.status(403).json({ error: 'You cannot change roles. Ask a super administrator to grant you that.' });
  // Only a super administrator decides who may go on to create further administrators; an admin
  // with the power granted cannot hand it onward, so delegation stops one level down.
  if (b.canGrantAdmin !== undefined && !isSuper(req.user)) return res.status(403).json({ error: 'Only a super administrator can change who may create administrators.' });
  // superAdmin is not settable over HTTP at any tier: it comes from the server console alone, so a
  // stolen admin session can never mint a peer that outranks the owner.
  if (b.superAdmin !== undefined) return res.status(403).json({ error: 'Super administrator can only be granted from the server console: npm run make-admin -- <email> --super' });
  // Losing your own admin rights mid-session is a self-inflicted lockout, and if you are the last
  // super administrator nobody could undo it from the console UI at all.
  if (b.role !== undefined && b.role !== 'admin' && u.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own administrator access.' });

  if (b.name !== undefined) u.name = b.name;
  if (b.org !== undefined) u.org = b.org;
  if (b.role !== undefined) {
    u.role = b.role === 'admin' ? 'admin' : 'user';
    if (u.role !== 'admin') delete u.canGrantAdmin;   // the power is meaningless off the admin tier
  }
  if (b.canGrantAdmin !== undefined) u.canGrantAdmin = !!b.canGrantAdmin;
  if (b.active !== undefined) { u.active = !!b.active; if (u.active) u.pending = false; } // enabling also clears "awaiting approval"
  if (b.callsPerDay !== undefined) u.quota = { ...(u.quota || {}), callsPerDay: (b.callsPerDay === null || b.callsPerDay === '') ? null : parseInt(b.callsPerDay) };
  if (b.minutesPerDay !== undefined) u.quota = { ...(u.quota || {}), minutesPerDay: (b.minutesPerDay === null || b.minutesPerDay === '') ? null : parseInt(b.minutesPerDay) };
  if (b.orgId !== undefined) u.orgId = String(b.orgId || '').toLowerCase().trim() || domainOf(u.email);
  if (b.password) { u.passwordHash = auth.hashPassword(b.password); u.mustChangePassword = true; } // admin-set password is temporary

  // Disabling an account or resetting its password has to end the sessions it already holds.
  // Without this, `active: false` only stops the NEXT sign-in while a token in someone's browser
  // keeps working for up to thirty days, which is the opposite of what "disable" means.
  if (b.password || (b.active !== undefined && !u.active)) auth.revokeSessions(u);

  auth.upsertUser(u);
  res.json({ success: true, user: userForClient(u) });
});
// ── ALLOWANCE BOOSTS ────────────────────────────────────
// Raise the allowance for one person or a whole partner company, for a day, a week, or until
// revoked. Platform admins only: a partner admin who could raise their own company's limit would
// make the budget advisory rather than real.
function readBoost(b) {
  const num = v => (v === '' || v === null || v === undefined || isNaN(parseInt(v))) ? undefined : parseInt(v);
  return {
    callsPerDay: num(b.callsPerDay), minutesPerDay: num(b.minutesPerDay), bulk: !!b.bulk,
    until: boostExpiry(b.duration), reason: String(b.reason || '').slice(0, 200),
    grantedAt: new Date().toISOString()
  };
}
function describeBoost(o) {
  if (!o) return 'none';
  const bits = [];
  if (o.callsPerDay != null) bits.push(`${o.callsPerDay} calls`);
  if (o.minutesPerDay != null) bits.push(`${o.minutesPerDay} minutes`);
  if (o.bulk) bits.push('bulk calling');
  return `${bits.join(', ') || 'no change'}, ${o.until ? 'until ' + new Date(o.until).toLocaleString() : 'until revoked'}`;
}
app.post('/api/admin/users/:id/boost', requirePlatformAdmin, (req, res) => {
  const u = auth.findById(req.params.id); if (!u) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};
  if (b.duration === 'clear') {
    delete u.quotaOverride; auth.upsertUser(u);
    return res.json({ success: true, cleared: true, message: `${u.email} is back on the standard allowance.` });
  }
  u.quotaOverride = { ...readBoost(b), grantedBy: req.user.email };
  auth.upsertUser(u);
  console.log(`📈  ${req.user.email} boosted ${u.email}: ${describeBoost(u.quotaOverride)}`);
  res.json({ success: true, boost: u.quotaOverride, message: `${u.email}: ${describeBoost(u.quotaOverride)}` });
});
app.get('/api/admin/org-quotas', requirePlatformAdmin, (req, res) => {
  // Lapsed entries are separated rather than deleted, so who was granted what stays on the record.
  const active = {}, expired = {};
  Object.entries(orgQuotas).forEach(([k, v]) => { (overrideActive(v) ? active : expired)[k] = v; });
  res.json({ orgQuotas: active, expired });
});
app.post('/api/admin/org-quotas', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  const orgId = signin.normaliseDomain(b.orgId);
  if (!orgId) return res.status(400).json({ error: 'Which organisation? Use the email domain, for example bigriver.com.au' });
  if (b.duration === 'clear') {
    delete orgQuotas[orgId]; store.saveSetting('org_quotas', orgQuotas);
    return res.json({ success: true, cleared: true, message: `${orgId} is back on the standard allowance.` });
  }
  orgQuotas[orgId] = { ...readBoost(b), grantedBy: req.user.email };
  store.saveSetting('org_quotas', orgQuotas);
  console.log(`📈  ${req.user.email} boosted all of ${orgId}: ${describeBoost(orgQuotas[orgId])}`);
  res.json({ success: true, orgId, boost: orgQuotas[orgId], message: `Everyone at ${orgId}: ${describeBoost(orgQuotas[orgId])}` });
});

// Sign somebody out everywhere without touching their account: the "they lost their laptop" button.
app.post('/api/admin/users/:id/revoke-sessions', requireAdmin, (req, res) => {
  const u = auth.findById(req.params.id); if (!u) return res.status(404).json({ error: 'User not found.' });
  const blocked = blockedFromEditing(req.user, u);
  if (blocked) return res.status(403).json({ error: blocked });
  if (!isPlatformAdmin(req.user) && orgIdOf(u) !== orgIdOf(req.user)) return res.status(403).json({ error: 'That account is not in your organisation.' });
  const v = auth.revokeSessions(u);
  res.json({ success: true, tokenVersion: v, message: `${u.email} has been signed out of every device.` });
});

// Profiles
app.get('/api/profiles', (req, res) => res.json({ presets: listPresets() }));

// Catalog (industry + country templates that power the Agent Builder's auto-fill)
app.get('/api/catalog', (req, res) => {
  try {
    const industries = readJson(path.join(CONFIG_DIR, 'catalog', 'industries.json'));
    const countries = readJson(path.join(CONFIG_DIR, 'catalog', 'countries.json'));
    let useCases = {}, languages = { languages: [], _aliases: {} };
    try { useCases = readJson(path.join(CONFIG_DIR, 'catalog', 'use-cases.json')); } catch (e) { console.warn('use-cases catalog missing:', e.message); }
    try { languages = readJson(path.join(CONFIG_DIR, 'catalog', 'languages.json')); } catch (e) { console.warn('languages catalog missing:', e.message); }
    // What the agent can ANSWER about, per industry, as a starting point for the builder's
    // knowledge fields. Missing is survivable: those two fields simply stay blank.
    let knowledge = {};
    try { knowledge = readJson(path.join(CONFIG_DIR, 'catalog', 'knowledge.json')); } catch (e) { console.warn('knowledge catalog missing:', e.message); }
    delete knowledge._README;
    return res.json({ industries, countries, useCases, knowledge, archetypes: ARCHETYPES, languages: languages.languages || [], languageAliases: languages._aliases || {}, firstMessages: firstMessageTemplates() });
  } catch (e) { res.status(500).json({ error: 'Catalog not found: ' + e.message }); }
});
app.get('/api/profile', (req, res) => { const p = getProfile(req); res.json({ profile: p, variables: flattenProfile(p), enabled: enabledUseCases(p), provider: activeProviderName(p) }); });
app.post('/api/profile', (req, res) => {
  const p = req.body && req.body.profile ? req.body.profile : req.body;
  if (!p || !p.company || !p.company.name) return res.status(400).json({ error: 'A profile with company.name is required.' });
  setProfile(req, p);
  res.json({ success: true, profile: p, variables: flattenProfile(p), enabled: enabledUseCases(p), provider: activeProviderName(p) });
});
app.post('/api/profile/preset/:id', (req, res) => {
  try { const p = loadPreset(req.params.id); setProfile(req, p); res.json({ success: true, profile: p, variables: flattenProfile(p), enabled: enabledUseCases(p), provider: activeProviderName(p) }); }
  catch (e) { res.status(404).json({ error: 'Preset not found: ' + req.params.id }); }
});

// Config (both providers)
app.get('/api/config', requirePlatformAdmin, (req, res) => res.json(providerPublicConfig()));
app.post('/api/config', requirePlatformAdmin, (req, res) => {
  const b = req.body || {};
  if (b.defaultProvider) config.defaultProvider = b.defaultProvider;
  if (b.bulkDelay !== undefined) config.bulkDelay = parseInt(b.bulkDelay) || 3;
  if (b.publicBase !== undefined) config.publicBase = String(b.publicBase || '').replace(/\/+$/, '');
  if (b.elevenlabs) Object.assign(config.elevenlabs, clean(b.elevenlabs, ['apiKey', 'agentId', 'agentPhoneNumberId', 'sendVoiceTuning']));
  if (b.retell) Object.assign(config.retell, clean(b.retell, ['apiKey', 'agentId', 'fromNumber']));
  // Backward-compat: flat {apiKey, agentId, fromNumber} apply to the ACTIVE provider
  if (b.apiKey !== undefined || b.agentId !== undefined || b.fromNumber !== undefined) {
    const name = activeProviderName();
    if (name === 'retell') { if (b.apiKey !== undefined) config.retell.apiKey = b.apiKey; if (b.agentId !== undefined) config.retell.agentId = b.agentId; if (b.fromNumber !== undefined) config.retell.fromNumber = b.fromNumber; }
    else { if (b.apiKey !== undefined) config.elevenlabs.apiKey = b.apiKey; if (b.agentId !== undefined) config.elevenlabs.agentId = b.agentId; if (b.fromNumber !== undefined) config.elevenlabs.agentPhoneNumberId = b.fromNumber; }
  }
  res.json({ success: true, ...providerPublicConfig() });
});
function clean(obj, keys) { const out = {}; keys.forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; }); return out; }

// Test connection (active provider, or ?provider=)
app.get('/api/test-connection', requirePlatformAdmin, async (req, res) => {
  const name = req.query.provider || activeProviderName();
  const adapter = getProvider(name);
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: `${name} is not fully configured.` });
  try { const r = await adapter.ping(config); res.json({ success: true, provider: name, detail: r.detail }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Go-live readiness check — what's configured, what's reachable, what still needs a manual step
app.get('/api/preflight', requirePlatformAdmin, async (req, res) => {
  const el = config.elevenlabs || {};
  const checks = [];
  checks.push({ key: 'el_key', label: 'ElevenLabs API key set', ok: !!el.apiKey });
  checks.push({ key: 'el_agent', label: 'Agent ID set', ok: !!el.agentId });
  checks.push({ key: 'el_phone', label: 'Agent Phone Number ID set (Twilio number connected)', ok: !!el.agentPhoneNumberId });
  let reachable = { ok: false, detail: 'API key not set' };
  if (el.apiKey) { try { const r = await getProvider('elevenlabs').ping(config); reachable = { ok: true, detail: r.detail }; } catch (e) { reachable = { ok: false, detail: e.message }; } }
  checks.push({ key: 'el_reachable', label: 'ElevenLabs API reachable (key valid)', ok: reachable.ok, detail: reachable.detail });
  checks.push({ key: 'public_base', label: 'Public base URL set (tools + webhooks reachable from the cloud)', ok: !!config.publicBase, detail: config.publicBase || 'not set — expose the backend with a tunnel (ngrok) or a deploy' });
  checks.push({ key: 'overrides', label: 'Per-call overrides enabled in the agent Security tab', manual: true, detail: 'Enable overrides for system prompt, first message, language, voice and LLM — otherwise per-call voice/language/LLM silently will not apply' });
  // No longer a manual step, and no longer something to take on trust: ask the agent what is
  // actually attached. An unattached tool means the agent promises actions it cannot perform.
  const expected = (agentTools.tools || []).length;
  let toolCheck = { ok: false, detail: 'ElevenLabs not configured' };
  if (providerConfigured('elevenlabs')) {
    try {
      const [existing, attached] = await Promise.all([getProvider('elevenlabs').listTools(config), getProvider('elevenlabs').getAttachedTools(config)]);
      const ours = existing.filter(t => toolsByName[t.name]);
      const live = ours.filter(t => attached.toolIds.includes(t.id)).length;
      toolCheck = live >= expected
        ? { ok: true, detail: `${live} of ${expected} attached and callable` }
        : { ok: false, detail: live === 0
            ? `None attached — the agent cannot record outcomes, book callbacks or honour do-not-call requests. Sync them in Settings.`
            : `Only ${live} of ${expected} attached. Sync them in Settings.` };
    } catch (e) { toolCheck = { ok: false, detail: e.message }; }
  }
  checks.push({ key: 'tools', label: `Action tools attached to the agent (${expected})`, ok: toolCheck.ok, detail: toolCheck.detail });
  const ready = checks.filter(c => !c.manual).every(c => c.ok);
  res.json({ provider: activeProviderName(), configured: providerConfigured('elevenlabs'), ready, checks });
});

// Tool-registration manifest — everything needed to add each webhook tool on the ElevenLabs agent
app.get('/api/tools/manifest', requirePlatformAdmin, (req, res) => {
  const base = String(req.query.base || config.publicBase || '').replace(/\/+$/, '') || '{PUBLIC_BASE}';
  const secretSet = !!(process.env.TOOL_WEBHOOK_SECRET || '');
  const tools = (agentTools.tools || []).map(t => ({
    name: t.name, description: t.description, type: 'webhook', method: 'POST',
    url: `${base}${agentTools.webhook_base}/${t.name}`,
    headers: secretSet ? { 'x-tool-secret': '<your TOOL_WEBHOOK_SECRET>' } : {},
    parameters: t.parameters, required: t.required || []
  }));
  res.json({ base: base === '{PUBLIC_BASE}' ? null : base, webhook_base: agentTools.webhook_base, secret_required: secretSet, system_tools: agentTools.system_tools, tools });
});

// Voices (ElevenLabs) for the accent/gender/voice pickers
app.get('/api/voices', async (req, res) => {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: 'ElevenLabs is not configured.' });
  try {
    const voices = await adapter.listVoices(config, { gender: req.query.gender, accent: req.query.accent, q: req.query.q });
    // Every accent/gender/use-case actually present on the account, so the pickers list what exists
    // rather than a hard-coded set that silently goes stale.
    const facet = (key) => [...new Set(voices.map(v => (v[key] || '').trim()).filter(Boolean))].sort();
    res.json({ success: true, voices, facets: { accents: facet('accent'), genders: facet('gender'), ages: facet('age'), useCases: facet('use_case'), languages: facet('language') } });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ACTION TOOLS: STATUS AND SYNC ───────────────────────
// A tool the agent cannot call is a promise it cannot keep. Ours were never created in ElevenLabs,
// so record_call_outcome, book_appointment and mark_do_not_call have all been silently no-ops.
function toolPublicBase() {
  const base = (config.publicBase || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'No public URL is set. ElevenLabs has to reach this server from the internet, so set PUBLIC_BASE (Settings, or the .env) to a tunnel URL for testing or your deployed HTTPS address.' };
  if (!/^https:\/\//i.test(base)) return { ok: false, base, reason: 'The public URL must start with https:// — ElevenLabs will not call an insecure endpoint.' };
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0|:\/\/192\.168\.|:\/\/10\./i.test(base)) return { ok: false, base, reason: 'That address is only reachable from this machine. ElevenLabs calls in from the internet, so it needs a public URL (a tunnel while testing, or your deployed host).' };
  return { ok: true, base };
}
app.get('/api/elevenlabs/tools/status', requirePlatformAdmin, async (req, res) => {
  const adapter = getProvider('elevenlabs');
  const specs = agentTools.tools || [];
  const pub = toolPublicBase();
  if (!adapter.isConfigured(config)) return res.json({ configured: false, expected: specs.length, publicBase: pub });
  try {
    const [existing, attached] = await Promise.all([adapter.listTools(config), adapter.getAttachedTools(config)]);
    const byName = Object.fromEntries(existing.map(t => [t.name, t]));
    const wantedBase = pub.ok ? pub.base : '';
    const rows = specs.map(s => {
      const t = byName[s.name];
      const url = wantedBase ? `${wantedBase}/api/agent-tool/${s.name}` : '';
      return { name: s.name, exists: !!t, attached: !!(t && attached.toolIds.includes(t.id)),
               urlCurrent: !!(t && url && t.url === url), url: t ? t.url : '' };
    });
    res.json({ configured: true, expected: specs.length, publicBase: pub,
      created: rows.filter(r => r.exists).length,
      attachedCount: rows.filter(r => r.attached).length,
      stale: rows.filter(r => r.exists && !r.urlCurrent).length,
      builtIn: attached.builtIn, tools: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Are the tools live right now? Cached, because placeCall consults it on every call and the answer
// changes about once a deployment.
let toolsLive = { known: false, ok: false, at: 0 };
async function refreshToolsLive() {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) { toolsLive = { known: true, ok: false, at: Date.now() }; return toolsLive; }
  try {
    const [existing, attached] = await Promise.all([adapter.listTools(config), adapter.getAttachedTools(config)]);
    const mine = existing.filter(t => toolsByName[t.name]).filter(t => attached.toolIds.includes(t.id));
    toolsLive = { known: true, ok: mine.length >= (agentTools.tools || []).length, at: Date.now() };
  } catch (e) { toolsLive = { known: true, ok: false, at: Date.now() }; }
  return toolsLive;
}

// On a hosted instance this is the difference between "it works" and "someone has to remember to
// press a button". Idempotent, so a restart is a no-op when everything is already correct.
// Set AUTO_SYNC_TOOLS=false if a second instance (staging) shares this ElevenLabs workspace, or the
// two will keep rewriting each other's webhook URLs.
async function autoSyncTools() {
  if (String(process.env.AUTO_SYNC_TOOLS || 'true').toLowerCase() === 'false') return;
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return;
  const pub = toolPublicBase();
  if (!pub.ok) {
    console.log(`🔧  Action tools are not attached, and cannot be until this server has a public URL.\n    ${pub.reason}`);
    await refreshToolsLive();
    return;
  }
  try {
    const specs = agentTools.tools || [];
    const sync = await adapter.syncTools(config, { specs, baseUrl: pub.base, secret: process.env.TOOL_WEBHOOK_SECRET || '' });
    const already = sync.unchanged.length === specs.length;
    const attach = await adapter.attachTools(config, sync.ids);
    await refreshToolsLive();
    if (already && attach.attached === specs.length) console.log(`🔧  Action tools: all ${attach.attached} already registered and attached.`);
    else console.log(`🔧  Action tools synced automatically: ${sync.created.length} created, ${sync.updated.length} re-pointed at ${pub.base}, ${attach.attached} attached.`);
    if (sync.failed.length) console.log(`    ⚠  ${sync.failed.length} failed: ${sync.failed.map(f => f.name + ' (' + f.error + ')').join('; ')}`);
  } catch (e) { console.log(`🔧  Automatic tool sync failed: ${e.message}\n    Sync them by hand from Settings.`); }
}

app.post('/api/elevenlabs/tools/sync', requirePlatformAdmin, async (req, res) => {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: 'ElevenLabs is not configured.' });
  const pub = toolPublicBase();
  if (!pub.ok) return res.status(400).json({ error: pub.reason });
  try {
    const specs = agentTools.tools || [];
    const sync = await adapter.syncTools(config, { specs, baseUrl: pub.base, secret: process.env.TOOL_WEBHOOK_SECRET || '' });
    if (sync.failed.length && !sync.ids.length) return res.status(500).json({ error: `None of the tools could be created: ${sync.failed[0].error}`, ...sync });
    const attach = await adapter.attachTools(config, sync.ids);
    await refreshToolsLive();   // so the very next call stops disclaiming what it can do
    console.log(`🔧  Tools synced by ${req.user.email}: ${sync.created.length} created, ${sync.updated.length} updated, ${sync.unchanged.length} unchanged, ${attach.attached} attached to the agent.`);
    if (sync.failed.length) console.log(`    ⚠  ${sync.failed.length} failed: ${sync.failed.map(f => f.name).join(', ')}`);
    res.json({ success: true, ...sync, attached: attach.attached, builtIn: attach.builtIn, base: pub.base });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LIVE LANGUAGE COVERAGE ──────────────────────────────
// The shipped catalogue was assembled from ElevenLabs' documentation, which is exactly how it fell
// 36 languages behind and lost Slovenian. When the key carries `models_read` we ask ElevenLabs
// directly instead, correct each language's engine flags from the answer, and shout about anything
// they support that we do not carry. Everything stays in memory: the file on disk is the fallback,
// not a cache to be overwritten behind the operator's back.
let modelCoverage = null;                      // { models: {model_id: [codes]}, names: {}, at }
let coverageState = { checked: false, live: false, reason: '' };
async function refreshLanguageCoverage(quiet) {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) { coverageState = { checked: true, live: false, reason: 'ElevenLabs is not configured.' }; return; }
  try {
    const cov = await adapter.getModelLanguages(config);
    modelCoverage = { ...cov, at: new Date().toISOString() };
    coverageState = { checked: true, live: true, reason: '' };

    const cat = languageCatalog();
    const ours = cat.languages || [];
    const tagFor = (id) => /v3/.test(id) ? 'v3' : /multilingual/.test(id) ? 'multi' : /flash|turbo/.test(id) ? 'flash' : null;
    let corrected = 0;
    ours.forEach(l => {
      const tags = new Set();
      Object.entries(cov.models).forEach(([id, codes]) => { const t = tagFor(id); if (t && codes.includes(l.code)) tags.add(t); });
      if (!tags.size) return;                                  // no model reports it: leave as shipped
      const next = ['flash', 'multi', 'v3'].filter(t => tags.has(t));
      if (next.join(',') !== (l.tts || []).join(',')) { l.tts = next; corrected++; }
    });
    const have = new Set(ours.map(l => l.code));
    const missing = Object.keys(cov.names).filter(c => !have.has(c));
    if (!quiet) {
      console.log(`🌐  Language coverage refreshed from ElevenLabs: ${cov.count} languages across ${Object.keys(cov.models).length} models` +
        (corrected ? `, ${corrected} engine flag(s) corrected` : ', flags already correct'));
      if (missing.length) {
        console.log(`    ⚠  ElevenLabs now supports ${missing.length} language(s) this build does not carry:`);
        console.log('       ' + missing.map(c => `${c} (${cov.names[c]})`).join(', '));
        console.log('       Add them to config/catalog/languages.json to make them selectable.');
      }
    }
  } catch (e) {
    coverageState = { checked: true, live: false, reason: e.code === 'models_read_missing'
      ? 'The API key does not have the "Models: Read" permission, so language coverage cannot self-update. Enable it in ElevenLabs (Settings → API Keys) and restart.'
      : e.message };
    if (!quiet) console.log(`🌐  Language coverage: using the shipped list. ${coverageState.reason}`);
  }
}
// Everything the console needs to reason about languages, live where possible.
//
// These two are reachable by a PARTNER, unlike the rest of the /api/elevenlabs/* family, because the
// builder needs them to warn that a language will not come out right. They are therefore also served
// under a neutral path, and the console calls that one: a partner watching the network tab should
// not be able to read our supplier's name off a URL. The vendor-named paths stay as aliases so
// nothing already pointed at them breaks.
async function languageCoverageHandler(req, res) {
  if (!coverageState.checked) await refreshLanguageCoverage(true);
  res.json({
    live: coverageState.live, reason: coverageState.reason,
    models: modelCoverage ? modelCoverage.models : null,
    checkedAt: modelCoverage ? modelCoverage.at : null,
    shipped: (languageCatalog().languages || []).length
  });
}
// What engine is the agent actually on? Any signed-in user may ask: it is one model id, it leaks
// nothing, and without it the language warning in the builder can only speak in generalities.
async function agentEngineHandler(req, res) {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return res.json({ success: false, model_id: '' });
  try { res.json({ success: true, ...(await adapter.getAgentEngine(config)) }); }
  catch (e) { res.json({ success: false, model_id: '', error: e.message }); }
}
app.get('/api/voice/languages', languageCoverageHandler);
app.get('/api/voice/engine', agentEngineHandler);
app.get('/api/elevenlabs/languages', languageCoverageHandler);
app.get('/api/elevenlabs/agent-engine', agentEngineHandler);

// The public Voice Library ("Explore" in ElevenLabs) — 15,000+ voices. Search, filtering and paging
// are all done by ElevenLabs, so the console holds one page at a time instead of the whole library.
app.get('/api/voices/library', async (req, res) => {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: 'ElevenLabs is not configured.' });
  try {
    const q = req.query;
    const page = await adapter.listLibraryVoices(config, {
      search: q.search, gender: q.gender, accent: q.accent, age: q.age, category: q.category,
      language: q.language, useCase: q.use_case, descriptive: q.descriptive,
      sort: q.sort, featured: q.featured, page: q.page, pageSize: q.page_size
    });
    res.json({ success: true, ...page, facets: LIBRARY_FACETS });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Copy a library voice into the workspace so it can actually be spoken. ElevenLabs rejects a library
// voice_id everywhere else, so this is the only route from "found it in Explore" to "used on a call".
app.post('/api/voices/library/add', async (req, res) => {
  const adapter = getProvider('elevenlabs');
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: 'ElevenLabs is not configured.' });
  const { public_owner_id, voice_id, name } = req.body || {};
  if (!voice_id) return res.status(400).json({ error: 'voice_id is required.' });
  try {
    const added = await adapter.addLibraryVoice(config, { publicOwnerId: public_owner_id, voiceId: voice_id, name });
    console.log(`🎙  voice added from library: ${name || voice_id} → ${added.voice_id} (by ${req.user.email})`);
    res.json({ success: true, voice_id: added.voice_id });
  }
  catch (e) { res.status(e.code === 'library_add_forbidden' ? 403 : 500).json({ error: e.message, code: e.code || '' }); }
});

// Single call
app.post('/api/call/single', callLimiter, async (req, res) => {
  const profile = getProfile(req);
  const name = activeProviderName(profile);
  const gate = guardCheck(req, false); if (!gate.ok) return res.status(429).json({ error: gate.error, code: gate.code });
  if (!providerConfigured(name)) return res.status(400).json({ error: `Voice provider "${name}" is not configured. Add its credentials in Settings.` });
  const { toNumber, variables } = req.body;
  if (!toNumber) return res.status(400).json({ error: 'toNumber is required.' });
  // Stamped onto every call, not looked up later: a partner who re-skins their agent for a different
  // industry tomorrow must not retroactively relabel what they demonstrated today.
  const company = (profile.company || {}).name || '', industry = (profile.company || {}).industry || '';
  try {
    const { providerName, providerCallId } = await placeCall(toNumber, variables || {}, profile, req.user);
    const entry = { id: uuidv4(), toNumber, customerName: (variables || {}).customer_name || '', useCase: (variables || {}).use_case || '', company, industry, provider: providerName, callId: providerCallId, status: 'initiated', timestamp: new Date().toISOString(), variables };
    stampUser(entry, req.user); callHistory.unshift(entry); saveHistory();
    res.json({ success: true, callId: providerCallId, entry });
  } catch (err) {
    const entry = { id: uuidv4(), toNumber, customerName: (variables || {}).customer_name || '', useCase: (variables || {}).use_case || '', company, industry, provider: name, status: 'failed', error: err.message, timestamp: new Date().toISOString(), variables };
    stampUser(entry, req.user); callHistory.unshift(entry); saveHistory();
    res.status(500).json({ error: err.message, entry });
  }
});

// Simulated single call (dry-run, no telephony) — demos the full flow without credentials
app.post('/api/call/simulate', async (req, res) => {
  const { toNumber, variables } = req.body || {};
  const entry = makeSimulatedEntry(toNumber || '+10000000000', variables || {}, getProfile(req));
  stampUser(entry, req.user); callHistory.unshift(entry); saveHistory();
  let writeback = null;
  const wb = getWriteback(req.user.id);
  if (wb.enabled) { try { const r = await runWritebackForEntries([entry], wb, req.user.id); writeback = { ok: true, sink: r.sink, detail: r.detail }; } catch (e) { writeback = { ok: false, detail: e.message }; } }
  res.json({ success: true, simulated: true, callId: entry.callId, entry, writeback });
});

// Analyse CSV
app.post('/api/analyse-csv', requireBulk, upload.single('file'), (req, res) => {
  if (!req.file && !req.body.csvText) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const text = req.file ? req.file.buffer.toString('utf-8') : req.body.csvText;
    const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
    res.json({ success: true, ...analyseRows(records, getProfile(req)) });
  } catch (err) { res.status(400).json({ error: 'CSV parse error: ' + err.message }); }
});

// Fetch customers from a data source (CSV/URL/Sheet/REST/CRM), then analyse + plan the smart queue
app.post('/api/source/fetch', requireBulk, async (req, res) => {
  const { type, config } = req.body || {};
  const src = connectors.sources[type];
  if (!src) return res.status(400).json({ error: `Unknown source type: ${type}` });
  try {
    const rows = await src.fetch(config || {});
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Source returned no rows.' });
    res.json({ success: true, source: type, rowCount: rows.length, ...analyseRows(rows, getProfile(req)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Connectors catalog (source + sink types + default field mapping) for the console
app.get('/api/connectors', (req, res) => res.json({ sources: connectors.SOURCE_META, sinks: connectors.SINK_META, mapping: connectors.DEFAULT_MAPPING }));

// Bulk campaign
app.post('/api/campaign/launch', callLimiter, requireBulk, async (req, res) => {
  const profile = getProfile(req);
  const name = activeProviderName(profile);
  // Stamped onto every call, not looked up later: a partner who re-skins their agent for a different
  // industry tomorrow must not retroactively relabel what they demonstrated today.
  const company = (profile.company || {}).name || '', industry = (profile.company || {}).industry || '';
  const simulate = !!req.body.simulate;
  const gate = guardCheck(req, simulate); if (!gate.ok) return res.status(429).json({ error: gate.error, code: gate.code });
  if (!simulate && !providerConfigured(name)) return res.status(400).json({ error: `Voice provider "${name}" is not configured.` });
  const { customers, campaignName, delay } = req.body;
  if (!customers || !Array.isArray(customers) || !customers.length) return res.status(400).json({ error: 'No customers provided.' });
  const campaignId = uuidv4();
  const delayMs = simulate ? 200 : (delay || config.bulkDelay) * 1000;
  const uid = req.user.id;
  const wb = getWriteback(uid);
  const camp = { id: campaignId, name: campaignName || `Campaign ${new Date().toLocaleDateString()}`, total: customers.length, processed: 0, success: 0, failed: 0, simulated: simulate, stopped: false, startedAt: new Date().toISOString(), entries: [] };
  userCampaigns[uid] = camp;
  res.json({ success: true, campaignId, simulated: simulate, message: `Campaign started for ${customers.length} customers.` });
  (async () => {
    for (let i = 0; i < customers.length; i++) {
      if (camp.stopped) break;
      // If a limit is switched on and this user hits it mid-campaign, stop cleanly (off by default).
      if (!simulate) { const g = guardCheck(req, false); if (!g.ok) { camp.stopped = true; camp.stopReason = g.error; break; } }
      const customer = customers[i];
      const vars = { customer_name: customer.customer_name, use_case: customer.use_case, time: customer.time || autoTimeOfDay(), ...customer.variables };
      try {
        let entry;
        if (simulate) {
          entry = makeSimulatedEntry(customer.to_number, vars, profile); entry.intelligenceReason = customer.intelligence_reason;
          stampUser(entry, req.user); callHistory.unshift(entry); camp.entries.push(entry); camp.success++;
          if (wb.enabled) { try { await runWritebackForEntries([entry], wb, uid); } catch (e) { /* keep going */ } }
        } else {
          const { providerName, providerCallId } = await placeCall(customer.to_number, vars, profile, req.user);
          entry = { id: uuidv4(), toNumber: customer.to_number, customerName: customer.customer_name, useCase: customer.use_case, company, industry, provider: providerName, callId: providerCallId, status: 'initiated', timestamp: new Date().toISOString(), variables: vars, intelligenceReason: customer.intelligence_reason };
          stampUser(entry, req.user); callHistory.unshift(entry); camp.entries.push(entry); camp.success++;
        }
      } catch (err) {
        const entry = { id: uuidv4(), toNumber: customer.to_number, customerName: customer.customer_name, useCase: customer.use_case, company, industry, provider: name, status: 'failed', error: err.message, timestamp: new Date().toISOString(), intelligenceReason: customer.intelligence_reason };
        stampUser(entry, req.user); callHistory.unshift(entry); camp.entries.push(entry); camp.failed++;
      }
      camp.processed++;
      if (i < customers.length - 1 && !camp.stopped) await sleep(delayMs);
    }
    camp.completedAt = new Date().toISOString(); camp.done = true; saveHistory();
  })();
});
app.get('/api/campaign/status', (req, res) => res.json(userCampaigns[req.user.id] || { done: true, processed: 0, total: 0 }));
app.post('/api/campaign/stop', (req, res) => { const c = userCampaigns[req.user.id]; if (c) c.stopped = true; res.json({ success: true }); });

// History. A user sees their whole organisation; an admin sees every organisation. ?userId= narrows
// to one person, which an admin may do for anyone and a partner only for a colleague.
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  let mine = visibleCalls(req);
  if (req.query.userId) {
    if (!mayViewUser(req, req.query.userId)) return res.status(403).json({ error: 'That user is not in your organisation.' });
    mine = mine.filter(c => c.userId === req.query.userId);
  }
  res.json({ calls: mine.slice(0, limit), total: mine.length });
});
// Deliberately narrower than the read scope: clearing history wipes your OWN calls, never a
// colleague's. Seeing the team's work and being able to delete it are different privileges.
// Deleting call history is the narrowest permission on the platform, deliberately narrower than
// reading it. A call log is the record of a real conversation with a real customer: it is evidence
// for a dispute, a do-not-call request, or a compliance question. So:
//   • ordinary users and partner admins cannot delete anything, not even their own
//   • a super administrator may delete THEIR OWN calls, and nobody else's
// Nobody, at any tier, can erase another person's record. There is no "clear everything" any more.
app.delete('/api/history', (req, res) => {
  if (!isSuper(req.user)) {
    return res.status(403).json({ error: 'Call records cannot be deleted. They are the record of a real conversation with a customer, and may be needed for a dispute or a compliance question.' });
  }
  const before = callHistory.length;
  callHistory = callHistory.filter(c => c.userId !== req.user.id);
  const removed = before - callHistory.length;
  saveHistory();
  console.log(`🗑️   ${req.user.email} deleted ${removed} of their own call record(s).`);
  res.json({ success: true, removed, message: `Removed ${removed} of your own call record${removed === 1 ? '' : 's'}. Nobody else's were touched.` });
});

// One record at a time, under exactly the same rule as clearing them all: a super administrator may
// delete THEIR OWN, and nobody else's. Deleting one is the common case (a test call, a wrong number
// dialled during a demo) and having only "delete everything I have ever placed" made that
// disproportionate — people either lived with the clutter or wiped far more than they meant to.
// The three refusals are deliberately distinct, because "you may not" and "that is not yours" and
// "it does not exist" are different situations and merging them makes the console lie about one.
app.delete('/api/history/:id', (req, res) => {
  if (!isSuper(req.user)) {
    return res.status(403).json({ error: 'Call records cannot be deleted. They are the record of a real conversation with a customer, and may be needed for a dispute or a compliance question.' });
  }
  const entry = callHistory.find(c => c.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'That call record no longer exists.' });
  if (entry.userId !== req.user.id) {
    return res.status(403).json({ error: `That call was placed by ${entry.userName || 'a colleague'}. You can only delete records you placed yourself.` });
  }
  callHistory = callHistory.filter(c => c.id !== req.params.id);
  saveHistory();
  console.log(`🗑️   ${req.user.email} deleted one of their own call records (${entry.customerName || entry.toNumber || entry.id}).`);
  res.json({ success: true, removed: 1, message: `Deleted the call to ${entry.customerName || entry.toNumber || 'that number'}.` });
});

// Campaign analytics — aggregate outcomes across all calls
//
// Everything here is scoped by visibleCalls(), so a partner sees their own company and a platform
// admin sees the estate. The trend and hour-of-day figures are cut in the VIEWER'S timezone, passed
// up from the browser: an Australian partner's "yesterday" is not an Indian admin's yesterday, and
// bucketing both on the server's clock would quietly mis-state one of them.
app.get('/api/analytics', (req, res) => {
  if (req.query.userId && !mayViewUser(req, req.query.userId)) return res.status(403).json({ error: 'That user is not in your organisation.' });
  const scope = visibleCalls(req);
  let calls = req.query.userId ? scope.filter(c => c.userId === req.query.userId) : scope;
  const tz = String(req.query.tz || dailyReport.timezone || 'Asia/Kolkata');
  // One range control governs the whole page. "all" still draws a 30-day trend, because a trend
  // needs a bounded axis to mean anything.
  const range = String(req.query.range || 'all');
  const rangeDays = /^\d+$/.test(range) ? Math.min(365, Math.max(1, parseInt(range))) : 0;
  if (rangeDays) {
    const cutoff = Date.now() - rangeDays * 86400000;
    calls = calls.filter(c => c.timestamp && new Date(c.timestamp).getTime() >= cutoff);
  }
  const days = Math.min(120, rangeDays || 30);
  const n = calls.length;
  const buckets = { connected: 0, noReach: 0, failed: 0, pending: 0 };
  calls.forEach(c => { buckets[classifyCall(c)]++; });
  const failed = buckets.failed, noReach = buckets.noReach, connected = buckets.connected, pending = buckets.pending;
  const resolved = connected + noReach + failed; // pending calls are excluded from the rate denominator
  const tally = (key) => { const o = {}; calls.forEach(c => { const val = c[key]; if (val) o[val] = (o[val] || 0) + 1; }); return o; };
  const sentiment = { positive: 0, neutral: 0, negative: 0 };
  calls.forEach(c => { const s = (c.userSentiment || '').toLowerCase(); if (sentiment[s] !== undefined) sentiment[s]++; });
  const surveys = calls.filter(c => c.survey && c.survey.score);
  const scores = surveys.map(c => parseFloat(c.survey.score)).filter(x => !isNaN(x));
  const durations = calls.filter(c => c.durationMs).map(c => c.durationMs);
  const talkSeconds = calls.reduce((s, c) => s + Math.max(0, Math.round((c.durationMs || 0) / 1000)), 0);

  // ── where, what and who ──
  // Country comes off the dialled number rather than a stored field, so it is answerable for every
  // call ever placed rather than only the ones made since the platform started recording it.
  const byCountry = {}, byIndustry = {}, byDestination = {}, byAgentBrand = {};
  const byUser = {}, byOrg = {};
  calls.forEach(c => {
    const country = report.countryOf(c.toNumber);
    byCountry[country] = (byCountry[country] || 0) + 1;
    const ind = c.industry || ((userProfiles[c.userId] || {}).company || {}).industry || '';
    if (ind) byIndustry[ind] = (byIndustry[ind] || 0) + 1;
    if (c.customerName) byDestination[c.customerName] = (byDestination[c.customerName] || 0) + 1;
    if (c.company) byAgentBrand[c.company] = (byAgentBrand[c.company] || 0) + 1;

    const secs = Math.max(0, Math.round((c.durationMs || 0) / 1000));
    const cls = classifyCall(c);
    const uid = c.userId || 'unknown';
    if (!byUser[uid]) byUser[uid] = { id: uid, name: c.userName || 'Unknown', orgId: c.orgId || '', calls: 0, connected: 0, talkSeconds: 0, simulated: 0 };
    byUser[uid].calls++; byUser[uid].talkSeconds += secs;
    if (cls === 'connected') byUser[uid].connected++;
    if (c.simulated) byUser[uid].simulated++;

    const org = c.orgId || 'unassigned';
    if (!byOrg[org]) byOrg[org] = { orgId: org, name: c.userOrg || org, calls: 0, connected: 0, talkSeconds: 0, people: {} };
    byOrg[org].calls++; byOrg[org].talkSeconds += secs;
    if (cls === 'connected') byOrg[org].connected++;
    byOrg[org].people[uid] = true;
  });
  Object.values(byOrg).forEach(o => { o.people = Object.keys(o.people).length; });

  // ── the last N days, and the hour of day ──
  const today = sched.zoneParts(new Date(), tz).dateKey;
  const trend = [];
  const byKey = {};
  for (let i = days - 1; i >= 0; i--) {
    const k = sched.zoneParts(new Date(Date.now() - i * 86400000), tz).dateKey;
    const row = { date: k, calls: 0, connected: 0, failed: 0, talkSeconds: 0, isToday: k === today };
    byKey[k] = row; trend.push(row);
  }
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0 }));
  calls.forEach(c => {
    if (!c.timestamp) return;
    const p = sched.zoneParts(new Date(c.timestamp), tz);
    const row = byKey[p.dateKey];
    if (row) {
      row.calls++;
      row.talkSeconds += Math.max(0, Math.round((c.durationMs || 0) / 1000));
      const cls = classifyCall(c);
      if (cls === 'connected') row.connected++;
      if (cls === 'failed') row.failed++;
    }
    if (byHour[p.hour]) byHour[p.hour].calls++;
  });

  // How long conversations actually run. An average hides the shape; the buckets show whether the
  // agent is being hung up on at ten seconds or holding real conversations.
  const talkBuckets = [
    { label: 'under 30s', min: 0, max: 30, n: 0 },
    { label: '30s – 1m', min: 30, max: 60, n: 0 },
    { label: '1 – 2m', min: 60, max: 120, n: 0 },
    { label: '2 – 5m', min: 120, max: 300, n: 0 },
    { label: 'over 5m', min: 300, max: Infinity, n: 0 }
  ];
  calls.filter(c => c.durationMs).forEach(c => {
    const s = c.durationMs / 1000;
    const b = talkBuckets.find(x => s >= x.min && s < x.max);
    if (b) b.n++;
  });

  res.json({
    total: n, failed, noReach, connected, pending, resolved,
    timezone: tz, days, range, scopeTotal: scope.length,
    talkSeconds, longestMs: durations.length ? Math.max(...durations) : null,
    live: calls.filter(c => !c.simulated).length,
    byCountry, byIndustry, byDestination, byAgentBrand, talkBuckets, trend, byHour,
    byUser: Object.values(byUser).sort((a, b) => b.calls - a.calls),
    byOrg: isPlatformAdmin(req.user) ? Object.values(byOrg).sort((a, b) => b.calls - a.calls) : [],
    scopeLabel: isPlatformAdmin(req.user) ? 'every organisation' : (orgIdOf(req.user) || 'your organisation'),
    connectRate: resolved ? Math.round(connected / resolved * 100) : 0,
    withOutcome: calls.filter(c => c.outcomes && c.outcomes.length).length,
    simulated: calls.filter(c => c.simulated).length,
    byDisposition: tally('disposition'), byUseCase: tally('useCase'),
    sentiment,
    actions: {
      promises: calls.filter(c => c.promiseToPay).length,
      callbacks: calls.filter(c => c.callback).length,
      appointments: calls.filter(c => c.appointment && c.appointment.status !== 'cancelled').length,
      leads: calls.filter(c => c.lead && c.lead.qualified === 'yes').length,
      renewals: calls.filter(c => c.renewal && c.renewal.decision === 'renewed').length,
      disputes: calls.filter(c => c.dispute).length,
      dnc: calls.filter(c => c.dnc).length,
      surveys: surveys.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10 : null,
      followups: calls.filter(c => c.followups && c.followups.length).length,
      transfers: calls.filter(c => c.transferred).length
    },
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null
  });
});

// ── THE DAILY ACTIVITY REPORT ───────────────────────────
// One email a day to Streebo covering every partner: what they called, where, for how long, and
// which allowances are open. It exists so nobody has to log in and page through the console to know
// whether the platform is being used.
//
// TWO PROPERTIES THIS CODE PROTECTS:
//   • It is a STREEBO report, never a partner one. It carries every partner's activity side by side,
//     so a single wrong recipient would hand one customer a view of all the others. Saving is
//     restricted to a super administrator, and an address on a partner's own domain is refused
//     outright rather than merely discouraged.
//   • No recordings are attached. The mail carries enough to decide which conversations are worth
//     hearing; the audio stays in the console behind the usual permissions, so a report sitting in
//     an inbox never becomes an unguarded copy of real customer conversations.
function saveDailyReport() { store.saveSetting('daily_report', dailyReport); }

/** Every organisation on the platform that is NOT the platform operator, i.e. every customer. */
function partnerDomains() {
  const platform = platformOrg();
  const out = new Set();
  auth.loadUsers().forEach(u => { const o = orgIdOf(u); if (o && o !== platform) out.add(o); });
  return out;
}
/**
 * Refuse a recipient list that would leak the estate to one of the companies inside it.
 *
 * Addresses ALREADY on the list are grandfathered: the day somebody at a Streebo sister company gets
 * an account, that domain starts counting as a partner, and without this an existing, deliberate
 * configuration would become impossible to re-save. New additions are still refused.
 */
function checkRecipients(list) {
  const partners = partnerDomains();
  const existing = new Set(dailyReport.recipients || []);
  const bad = list.filter(e => !existing.has(String(e).toLowerCase()) && partners.has(String(e).split('@')[1] || ''));
  if (bad.length) {
    return `This report contains every partner's activity, so it cannot be sent to a partner address. Remove: ${bad.join(', ')}.`;
  }
  return null;
}

/** Build the report for one day from the live state. Pure read; safe to call for a preview. */
function buildDailyReport(dateKey, partial) {
  return report.buildReport(
    { calls: callHistory, users: auth.loadUsers(), orgQuotas, userProfiles },
    {
      dateKey, timezone: dailyReport.timezone,
      includeSimulated: dailyReport.includeSimulated !== false,
      includeQuietPartners: dailyReport.includeQuietPartners !== false,
      maxCallRowsPerCompany: dailyReport.maxCallRowsPerCompany,
      partial: !!partial
    }
  );
}

async function sendDailyReport(dateKey, opts = {}) {
  const r = buildDailyReport(dateKey, opts.partial);
  const to = (opts.to && opts.to.length) ? opts.to : dailyReport.recipients;
  const subject = (opts.partial ? '[part day] ' : '') + report.subjectFor(r);
  const sent = await mailer.send({ to, subject, text: report.renderText(r), html: report.renderHtml(r) });
  return { report: r, to, subject, detail: sent.detail, provider: sent.provider };
}

// Retry state lives in memory on purpose: a restart is itself a fix worth retrying after.
let reportFailures = {};
let reportSending = false;
// How late a MISSED report may still go out. Inside this window the send is a catch-up (the process
// was not alive at the send time, which is exactly what the tick exists to survive). Outside it, on
// an instance that has never sent one, we are almost certainly looking at a fresh deployment rather
// than a missed run, and a report for a day that closed many hours ago arriving out of the blue is
// a surprise, not a service.
const REPORT_CATCHUP_GRACE_MIN = 120;

async function reportTick() {
  const cfg = dailyReport;
  // Async, and the interval keeps firing while a send is in flight. Without this guard two ticks can
  // both pass the "already gone out" check and both send the same report.
  if (!cfg || !cfg.enabled || reportSending) return;
  const now = new Date();
  const parts = sched.zoneParts(now, cfg.timezone);
  const target = sched.parseHHMM(cfg.sendAt, 15);
  // The report always covers the day that has just finished, whatever hour it is sent at. That way
  // "midnight to midnight" stays true even if somebody moves the send time to 8am.
  const due = report.previousDateKey(now, cfg.timezone);
  if ((reportFailures[due] || 0) >= 5) return;     // stop hammering a broken mailbox

  const decision = report.tickDecision({
    nowMinutes: parts.minutes, sendAtMinutes: target, dueKey: due,
    lastSentDateKey: cfg.lastSentDateKey, graceMinutes: REPORT_CATCHUP_GRACE_MIN
  });
  if (decision === 'wait') return;
  // Arm: record the day as handled without sending, and say so, so it is never a silent gap.
  // "Send to everyone now" in the console still posts it on demand.
  if (decision === 'arm') {
    dailyReport.lastSentDateKey = due;
    saveDailyReport();
    console.log(`📊  Daily report armed for ${cfg.sendAt} ${cfg.timezone}. ${due} was NOT sent: this instance was not running when that day closed, and it is now ${sched.hhmm(parts.minutes)} there. Use Admin → Daily report → Send to everyone now if you want it.`);
    return;
  }

  reportSending = true;
  const previous = cfg.lastSentDateKey;
  try {
    // Claim the day and make the claim durable BEFORE sending. A restart in the seconds around a
    // send would otherwise come back up, see the day unsent, and post it a second time.
    dailyReport.lastSentDateKey = due;
    saveDailyReport();
    await store.flush();

    const out = await sendDailyReport(due);
    dailyReport.lastResult = { at: new Date().toISOString(), dateKey: due, ok: true, detail: out.detail, recipients: out.to, calls: out.report.totals.calls };
    saveDailyReport();
    delete reportFailures[due];
    console.log(`📊  Daily report for ${due} sent to ${out.to.join(', ')} — ${out.report.totals.calls} call(s) across ${out.report.totals.activeCompanies} partner(s).`);
  } catch (e) {
    // The send failed, so give the day back: the next tick should try again, up to five times.
    dailyReport.lastSentDateKey = previous;
    reportFailures[due] = (reportFailures[due] || 0) + 1;
    dailyReport.lastResult = { at: new Date().toISOString(), dateKey: due, ok: false, detail: e.message, recipients: cfg.recipients };
    saveDailyReport();
    console.warn(`⚠️   Daily report for ${due} failed (attempt ${reportFailures[due]} of 5): ${e.message}`);
  } finally {
    reportSending = false;
  }
}

// Reading the configuration is open to any platform admin — knowing a report exists is not a risk.
app.get('/api/admin/report', requirePlatformAdmin, (req, res) => {
  const now = new Date();
  res.json({
    settings: dailyReport,
    mail: mailer.status(),
    canEdit: isSuper(req.user),
    today: report.currentDateKey(now, dailyReport.timezone),
    yesterday: report.previousDateKey(now, dailyReport.timezone),
    serverTime: now.toISOString(),
    localTime: sched.hhmm(sched.zoneParts(now, dailyReport.timezone).minutes),
    partnerDomains: [...partnerDomains()]
  });
});

app.post('/api/admin/report', requireSuperAdmin, (req, res) => {
  const b = req.body || {};
  // A malformed time falls back to what is already saved, not to the shipped default. Otherwise a
  // typo in the box would silently move a carefully chosen 07:30 back to midnight.
  const sendAt = /^\d{1,2}:\d{2}$/.test(String(b.sendAt || '').trim()) ? String(b.sendAt).trim() : dailyReport.sendAt;
  const merged = report.withDefaults(Object.assign({}, dailyReport, {
    enabled: b.enabled !== undefined ? !!b.enabled : dailyReport.enabled,
    timezone: b.timezone || dailyReport.timezone,
    sendAt,
    recipients: b.recipients !== undefined ? b.recipients : dailyReport.recipients,
    includeQuietPartners: b.includeQuietPartners !== undefined ? !!b.includeQuietPartners : dailyReport.includeQuietPartners,
    includeSimulated: b.includeSimulated !== undefined ? !!b.includeSimulated : dailyReport.includeSimulated,
    maxCallRowsPerCompany: b.maxCallRowsPerCompany ? Math.min(300, Math.max(5, parseInt(b.maxCallRowsPerCompany) || 40)) : dailyReport.maxCallRowsPerCompany
  }));
  // A bad timezone would silently redraw every day boundary, so prove it resolves before saving it.
  try { new Intl.DateTimeFormat('en-US', { timeZone: merged.timezone }); }
  catch (e) { return res.status(400).json({ error: `"${merged.timezone}" is not a timezone this server recognises. Use an IANA name such as Asia/Kolkata.` }); }
  const bad = checkRecipients(merged.recipients);
  if (bad) return res.status(400).json({ error: bad });

  // Changing WHEN it goes out should not resend a day that has already been reported.
  dailyReport = merged;
  saveDailyReport();
  reportFailures = {};
  console.log(`📊  Daily report settings updated by ${req.user.email}: ${dailyReport.enabled ? `ON at ${dailyReport.sendAt} ${dailyReport.timezone}` : 'OFF'} → ${dailyReport.recipients.join(', ')}`);
  res.json({ settings: dailyReport, message: dailyReport.enabled ? `Saved. The report goes out at ${dailyReport.sendAt} ${dailyReport.timezone} to ${dailyReport.recipients.length} recipient${dailyReport.recipients.length === 1 ? '' : 's'}.` : 'Saved. The daily report is switched off.' });
});

// Preview renders the real thing rather than a mock-up, so what you approve is what lands.
app.get('/api/admin/report/preview', requirePlatformAdmin, (req, res) => {
  const now = new Date();
  const dateKey = String(req.query.dateKey || report.previousDateKey(now, dailyReport.timezone));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return res.status(400).json({ error: 'dateKey must look like 2026-08-15.' });
  const partial = dateKey === report.currentDateKey(now, dailyReport.timezone);
  const r = buildDailyReport(dateKey, partial);
  res.json({
    dateKey, partial, subject: report.subjectFor(r), html: report.renderHtml(r), text: report.renderText(r),
    summary: { calls: r.totals.calls, partners: r.totals.activeCompanies, talkSeconds: r.totals.talkSeconds, countries: r.topCountries.length }
  });
});

app.post('/api/admin/report/send-now', requireSuperAdmin, async (req, res) => {
  const b = req.body || {};
  const now = new Date();
  const dateKey = String(b.dateKey || report.previousDateKey(now, dailyReport.timezone));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return res.status(400).json({ error: 'dateKey must look like 2026-08-15.' });
  // "Send me a test" should reach the person asking, not the whole distribution list.
  const to = b.onlyMe ? [req.user.email] : mailer.recipientList(b.to && b.to.length ? b.to : dailyReport.recipients);
  const bad = checkRecipients(to);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const out = await sendDailyReport(dateKey, { to, partial: dateKey === report.currentDateKey(now, dailyReport.timezone) });
    // Recorded like any other run, so Delivery answers "what happened last time" whether that was
    // the schedule or somebody pressing the button. lastSentDateKey is deliberately NOT touched: a
    // test send must not cancel the real one.
    dailyReport.lastResult = { at: new Date().toISOString(), dateKey, ok: true, detail: out.detail, recipients: to, calls: out.report.totals.calls, manual: true, by: req.user.email };
    saveDailyReport();
    console.log(`📊  Daily report for ${dateKey} sent on demand by ${req.user.email} to ${to.join(', ')}.`);
    res.json({ success: true, dateKey, to, provider: out.provider, detail: out.detail, message: `Sent to ${to.join(', ')}.${out.provider === 'dev' ? ' (MAIL_PROVIDER is "dev", so it was printed to the server log rather than delivered.)' : ''}` });
  } catch (e) {
    dailyReport.lastResult = { at: new Date().toISOString(), dateKey, ok: false, detail: e.message, recipients: to, manual: true, by: req.user.email };
    saveDailyReport();
    res.status(500).json({ error: e.message });
  }
});

// ── ELEVENLABS: AUTOMATIC ANALYSIS ──────────────────────
// Two capabilities that turn the platform from "it made the call" into "it knows what happened":
//   • evaluation criteria  — ElevenLabs scores every conversation against goals we define
//   • data collection      — it extracts named fields straight out of the transcript
// Both are derived from the profile's own use cases, so an airline gets airline criteria.
function analysisSpecForProfile(profile) {
  const uc = ucMap(profile);
  const keys = enabledKeys(profile);
  const criteria = keys.slice(0, 20).map(k => {
    const u = uc[k] || {};
    const arch = archetypeOf(profile, k);
    const goal = {
      payment_reminder: 'the customer acknowledged the amount due and either confirmed payment or gave a specific date they will pay',
      overdue_followup: 'the customer engaged with the arrears and either committed to a payment date, raised a genuine dispute, or was referred for hardship support',
      sales_offer: 'the offer was clearly explained and the customer gave a clear yes, no, or a follow-up commitment',
      appointment_reminder: 'the appointment was confirmed, rescheduled to a specific new time, or cancelled',
      feedback_survey: 'a satisfaction score was captured, and at least one specific comment was given',
      lead_qualification: 'the lead was qualified or disqualified against need, timeline and authority, and a next step was agreed',
      renewal_retention: 'the customer confirmed renewal, declined with a reason, or agreed a follow-up before expiry',
      service_notification: 'the customer understood what changed and either chose an option or was told exactly what happens next and when',
      document_collection: 'the customer knows precisely which items are outstanding and how to send them, or a genuine blocker was captured'
    }[arch] || 'the purpose of the call was achieved and the customer was left clear on what happens next';
    return {
      id: `uc_${k}`.slice(0, 60),
      name: (u.label || k).slice(0, 60),
      type: 'prompt',
      conversation_goal_prompt: `This call was a "${u.label || k}" call. Mark it successful only if ${goal}. ${u.playbook ? 'Context: ' + String(u.playbook).slice(0, 400) : ''} If the customer was never reached, or the agent did not get to the point, mark it unsuccessful.`,
      use_knowledge_base: false
    };
  });
  // Fields worth having on EVERY call, whatever the industry, plus the money/date ones that make
  // the write-back row useful without relying on a tool firing mid-call.
  const dataCollection = {
    call_outcome: { type: 'string', description: 'One of: promised_payment, already_paid, callback_requested, appointment_set, lead_qualified, renewed, resolved, not_interested, dispute_raised, escalated_to_human, do_not_call, no_answer_voicemail, wrong_person. Choose the single best fit for how this call ended.' },
    customer_sentiment: { type: 'string', description: 'positive, neutral or negative — how the customer sounded overall.' },
    commitment_date: { type: 'string', description: 'Any date or time the customer committed to (a payment date, an appointment, a callback). Empty if none was given.' },
    commitment_amount: { type: 'string', description: 'Any amount the customer committed to pay, as a plain number. Empty if none.' },
    objection: { type: 'string', description: 'The main objection or blocker the customer raised, in their own words. Empty if none.' },
    do_not_call: { type: 'boolean', description: 'True only if the customer explicitly asked not to be contacted again.' },
    language_used: { type: 'string', description: 'The language the conversation actually ran in, after any language preference was agreed.' }
  };
  return { criteria, dataCollection };
}
// ── ELEVENLABS: CALL-ENDING SETTINGS ────────────────────
// Whether a call can end at all is decided on the AGENT, not in the prompt. Two failure modes:
//   • end_call disabled  → the agent can never hang up, and calls run to the duration cap
//   • an auto-ender on   → something hangs up FOR it, which is how a call drops mid-sentence
// This surfaces both, and applies the safe combination.
const RECOMMENDED_SILENCE_END = 60;   // a genuinely dead line, not someone fetching a pen
app.get('/api/elevenlabs/call-ending', requirePlatformAdmin, async (req, res) => {
  try {
    const cfg = await getProvider('elevenlabs').getCallEndingConfig(config);
    const issues = [];
    if (!cfg.endCallEnabled) issues.push({ level: 'critical', text: 'The end_call tool is OFF, so the agent physically cannot hang up. Every call will run until the duration limit even after a proper goodbye.' });
    if (cfg.voicemailDetection) issues.push({ level: 'warning', text: 'Automatic voicemail detection is ON. It can end a call on its own — this is the usual cause of a call dropping when nobody has spoken. The prompt already handles voicemail; safer to leave this off.' });
    if (cfg.skipTurn) issues.push({ level: 'warning', text: 'skip_turn is ON, which lets the agent pass its turn automatically and can make it appear to abandon the conversation.' });
    if (cfg.silenceEndCallTimeout === -1 || cfg.silenceEndCallTimeout == null) issues.push({ level: 'warning', text: `Silence never ends a call. If a line goes dead it stays open until the duration cap. A backstop of about ${RECOMMENDED_SILENCE_END} seconds is long enough that nobody fetching a pen gets cut off.` });
    else if (cfg.silenceEndCallTimeout > 0 && cfg.silenceEndCallTimeout < 20) issues.push({ level: 'critical', text: `Silence ends the call after only ${cfg.silenceEndCallTimeout}s. That is short enough to hang up on someone who paused to think or check something.` });
    res.json({ success: true, config: cfg, issues, recommended: { enableEndCall: true, disableAutoEnders: true, silenceEndCallTimeout: RECOMMENDED_SILENCE_END } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/elevenlabs/call-ending/fix', requirePlatformAdmin, async (req, res) => {
  const b = req.body || {};
  try {
    const cfg = await getProvider('elevenlabs').updateCallEndingConfig(config, {
      enableEndCall: true, disableAutoEnders: true,
      silenceEndCallTimeout: b.silenceEndCallTimeout != null ? parseInt(b.silenceEndCallTimeout) : RECOMMENDED_SILENCE_END
    });
    res.json({ success: true, config: cfg, message: 'The agent can now hang up when the prompt says so, and nothing can hang up on its own.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/elevenlabs/analysis', requirePlatformAdmin, async (req, res) => {
  try { const cfg = await getProvider('elevenlabs').getAnalysisConfig(config); res.json({ success: true, ...cfg, proposed: analysisSpecForProfile(getProfile(req)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/elevenlabs/analysis/sync', requirePlatformAdmin, async (req, res) => {
  const profile = getProfile(req);
  const spec = analysisSpecForProfile(profile);
  try {
    const r = await getProvider('elevenlabs').updateAnalysis(config, spec);
    res.json({ success: true, ...r, message: `Agent now scores every call against ${r.criteria} criteria and extracts ${r.fields} fields automatically.` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── ELEVENLABS: POST-CALL WEBHOOK ───────────────────────
// ElevenLabs pushes the finished conversation here — transcript, summary, success evaluation,
// extracted fields. That replaces polling: outcomes land seconds after the call ends, even for
// calls placed by a schedule while nobody was watching the console.
function verifyElevenLabsSignature(req) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET || '';
  if (!secret) return { ok: true, note: 'no secret set — signature not checked' };
  const header = req.get('elevenlabs-signature') || req.get('ElevenLabs-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=').map(s => s.trim())).filter(a => a.length === 2));
  const ts = parts.t, sig = parts.v0;
  if (!ts || !sig || !req.rawBody) return { ok: false, note: 'missing signature' };
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${req.rawBody}`).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, note: 'bad signature' };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 1800) return { ok: false, note: 'stale timestamp' };
  return { ok: true };
}
app.post('/api/elevenlabs/webhook', (req, res) => {
  const check = verifyElevenLabsSignature(req);
  if (!check.ok) return res.status(401).json({ error: 'Invalid signature: ' + check.note });
  const body = req.body || {};
  const data = body.data || body;
  const convId = data.conversation_id || data.conversationId || '';
  const entry = convId ? callHistory.find(c => c.callId === convId) : null;
  // Always 200: a webhook that errors gets retried forever and we never want to block their queue.
  if (!entry) { console.warn('Post-call webhook for an unknown conversation:', convId); return res.json({ success: true, matched: false }); }

  const analysis = data.analysis || {};
  const meta = data.metadata || {};
  if (analysis.transcript_summary) { entry.summary = analysis.transcript_summary; entry.outcomeSummary = entry.outcomeSummary || analysis.transcript_summary; }
  if (analysis.call_successful !== undefined) entry.callSuccessful = analysis.call_successful === true || analysis.call_successful === 'success';
  if (meta.call_duration_secs) entry.durationMs = meta.call_duration_secs * 1000;
  if (data.transcript) entry.transcript = data.transcript;
  entry.callStatus = 'ended';
  entry.hasAudio = entry.hasAudio !== false;

  // Success criteria → a per-goal verdict we can report on.
  const crit = analysis.evaluation_criteria_results || {};
  if (Object.keys(crit).length) {
    entry.evaluation = Object.entries(crit).map(([k, v]) => ({ id: k, name: (v && v.criteria_id) || k, result: (v && v.result) || '', rationale: (v && v.rationale) || '' }));
    const goals = entry.evaluation.filter(e => /success|failure/i.test(e.result));
    if (goals.length) entry.goalsMet = goals.filter(e => /success/i.test(e.result)).length + '/' + goals.length;
  }
  // Extracted fields → fill the outcome columns without needing a tool call.
  const dc = analysis.data_collection_results || {};
  const valOf = k => { const v = dc[k]; return v && typeof v === 'object' ? (v.value !== undefined ? v.value : v.result) : v; };
  if (Object.keys(dc).length) {
    entry.extracted = Object.fromEntries(Object.keys(dc).map(k => [k, valOf(k)]));
    const outcome = valOf('call_outcome'); if (outcome && !entry.disposition) entry.disposition = String(outcome);
    const sentiment = valOf('customer_sentiment'); if (sentiment && !entry.userSentiment) entry.userSentiment = String(sentiment).toLowerCase();
    const amt = valOf('commitment_amount'), when = valOf('commitment_date');
    if ((amt || when) && !entry.promiseToPay && /pay/i.test(String(outcome || ''))) entry.promiseToPay = { amount: amt || '', date: when || '', method: '' };
    if (when && !entry.callback && /callback/i.test(String(outcome || ''))) entry.callback = { time: when, reason: 'agreed on the call' };
    if (valOf('do_not_call') === true && !entry.dnc) { entry.dnc = true; entry.dncReason = 'requested on the call'; }
    if (valOf('language_used')) entry.languageUsed = String(valOf('language_used'));
  }
  entry.analysedAt = new Date().toISOString();
  saveHistory();

  // Auto write-back the moment the analysis lands, using the call owner's destination.
  const wb = getWriteback(entry.userId);
  if (wb.enabled) { runWritebackForEntries([entry], wb, entry.userId).catch(e => console.warn('Post-call write-back failed:', e.message)); }
  res.json({ success: true, matched: true });
});

// ── SCHEDULES ───────────────────────────────────────────
app.get('/api/schedules', (req, res) => res.json({ schedules: ownSchedules(req).map(scheduleView), serverTime: new Date().toISOString() }));
app.get('/api/schedules/:id', (req, res) => {
  const s = ownSchedules(req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found.' });
  res.json({ schedule: { ...s, describe: sched.describe(s), nextRunAt: sched.nextRunAt(s) } });
});
app.post('/api/schedules', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Give the schedule a name.' });
  const when = b.when || {};
  if (!['once', 'daily', 'weekdays', 'weekly', 'monthly'].includes(when.mode || 'once')) return res.status(400).json({ error: 'Unknown repeat mode.' });
  if (!/^\d{1,2}:\d{2}$/.test(when.at || '')) return res.status(400).json({ error: 'Time must look like 09:30.' });
  if ((when.mode || 'once') === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(when.date || '')) return res.status(400).json({ error: 'Pick a date for a one-off schedule.' });
  const hasList = Array.isArray((b.target || {}).customers) && b.target.customers.length;
  if (!hasList && !((b.target || {}).toNumber)) return res.status(400).json({ error: 'Add a phone number, or a list of customers.' });
  // Snapshot the agent profile now, so editing the live profile later cannot silently change what
  // a scheduled campaign will say.
  const profile = b.agentProfile || getProfile(req);
  const s = {
    id: uuidv4(), userId: req.user.id, orgId: orgIdOf(req.user), name: b.name, enabled: b.enabled !== false,
    agentProfile: profile, useCase: b.useCase || enabledKeys(profile)[0] || 'sales_offer',
    target: b.target || {}, simulate: !!b.simulate, delaySeconds: parseInt(b.delaySeconds) || config.bulkDelay || 3,
    when: { mode: when.mode || 'once', at: when.at, date: when.date || '', days: when.days || [], dayOfMonth: when.dayOfMonth || 1, timezone: when.timezone || (profile.locale || {}).timezone || 'UTC' },
    window: { start: (b.window || {}).start || '09:00', end: (b.window || {}).end || '20:00', respect: (b.window || {}).respect !== false },
    status: 'scheduled', ranSlots: [], runs: [], createdAt: new Date().toISOString()
  };
  schedules.unshift(s); saveSchedules();
  res.json({ success: true, schedule: scheduleView(s) });
});
// Reading a colleague's schedule is sharing; rewriting or firing one is not. Anything that changes
// what gets dialled stays with the owner (or an admin), even though the whole org can see it.
function writableSchedule(req, id) {
  const s = schedules.find(x => x.id === id);
  if (!s) return null;
  return (req.user.role === 'admin' || s.userId === req.user.id) ? s : null;
}
app.post('/api/schedules/:id', (req, res) => {
  const s = writableSchedule(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found, or it belongs to a colleague.' });
  const b = req.body || {};
  ['name', 'useCase', 'simulate'].forEach(k => { if (b[k] !== undefined) s[k] = b[k]; });
  if (b.enabled !== undefined) { s.enabled = !!b.enabled; if (s.enabled && s.status === 'completed' && (s.when || {}).mode !== 'once') s.status = 'scheduled'; }
  if (b.when) s.when = { ...s.when, ...b.when };
  if (b.window) s.window = { ...s.window, ...b.window };
  if (b.target) s.target = b.target;
  if (b.agentProfile) s.agentProfile = b.agentProfile;
  if (b.delaySeconds !== undefined) s.delaySeconds = parseInt(b.delaySeconds) || 3;
  // Re-arming a schedule clears the fired-slot memory so it can run again today.
  if (b.rearm) { s.ranSlots = []; s.status = 'scheduled'; }
  saveSchedules();
  res.json({ success: true, schedule: scheduleView(s) });
});
app.delete('/api/schedules/:id', (req, res) => {
  const before = schedules.length;
  if (!writableSchedule(req, req.params.id)) return res.status(404).json({ error: 'Schedule not found, or it belongs to a colleague.' });
  schedules = schedules.filter(x => x.id !== req.params.id); saveSchedules();
  res.json({ success: true, removed: before - schedules.length });
});
// Fire it right now, ignoring the clock (but never the guardrails).
app.post('/api/schedules/:id/run-now', async (req, res) => {
  const s = writableSchedule(req, req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found, or it belongs to a colleague.' });
  if (s.status === 'running') return res.status(409).json({ error: 'That schedule is already running.' });
  s.status = 'running'; saveSchedules();
  res.json({ success: true, message: `Running "${s.name}" now.` });
  try { await runSchedule(s, { manual: true }); } catch (e) { noteRun(s, { ok: false, note: 'error: ' + e.message }); }
  if (s.status === 'running') s.status = 'scheduled';
  saveSchedules();
});
// Deliberately the one write a colleague MAY perform. Stopping a run that is dialling real people
// reduces harm, and making someone hunt down the owner while a bad campaign is mid-flight would be
// the worse failure. Starting is restricted; the emergency brake is not.
app.post('/api/schedules/:id/stop', (req, res) => {
  const s = ownSchedules(req).find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found.' });
  s._cancelRun = true; setTimeout(() => { delete s._cancelRun; }, 5000);
  res.json({ success: true });
});

// ── BOOKMARKS (saved Agent Builder configurations) ──────
function saveBookmarksNow() { store.saveBookmarks(bookmarks); }
// Visible to the whole organisation, so colleagues work from one library of saved agents rather
// than each rebuilding the same prospect. `shared` now means platform-wide (a template every org
// can see), not merely "not private". Editing and deleting stay with the author on purpose: seeing
// a colleague's work and being able to overwrite it are different privileges.
function ownBookmarks(req) {
  if (isPlatformAdmin(req.user)) return bookmarks;
  const mine = inMyOrg(req);
  return bookmarks.filter(b => mine(b) || b.shared);
}
app.get('/api/bookmarks', (req, res) => res.json({ bookmarks: ownBookmarks(req) }));
app.post('/api/bookmarks', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Give this configuration a name.' });
  if (!b.config || typeof b.config !== 'object') return res.status(400).json({ error: 'Nothing to save.' });
  const existing = bookmarks.find(x => x.userId === req.user.id && x.name.toLowerCase() === String(b.name).toLowerCase());
  if (existing) { existing.config = b.config; existing.shared = !!b.shared; existing.updatedAt = new Date().toISOString(); saveBookmarksNow(); return res.json({ success: true, bookmark: existing, replaced: true }); }
  const bm = { id: uuidv4(), userId: req.user.id, orgId: orgIdOf(req.user), userName: req.user.name || '', name: b.name, note: b.note || '', shared: !!b.shared, config: b.config, createdAt: new Date().toISOString() };
  bookmarks.unshift(bm); saveBookmarksNow();
  res.json({ success: true, bookmark: bm });
});
app.post('/api/bookmarks/:id', (req, res) => {
  const bm = bookmarks.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!bm) return res.status(404).json({ error: 'Bookmark not found.' });
  const b = req.body || {};
  if (b.name !== undefined) bm.name = b.name;
  if (b.note !== undefined) bm.note = b.note;
  if (b.shared !== undefined) bm.shared = !!b.shared;
  if (b.config) bm.config = b.config;
  bm.updatedAt = new Date().toISOString(); saveBookmarksNow();
  res.json({ success: true, bookmark: bm });
});
app.delete('/api/bookmarks/:id', (req, res) => {
  const bm = bookmarks.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (!bm) return res.status(404).json({ error: 'Bookmark not found.' });
  bookmarks = bookmarks.filter(x => x.id !== bm.id); saveBookmarksNow();
  res.json({ success: true });
});

// Agent tools: spec (for the console/docs) + webhook receiver the voice agent calls mid-conversation
app.get('/api/tools', (req, res) => res.json(agentTools));
app.post('/api/agent-tool/:tool', async (req, res) => {
  const secret = process.env.TOOL_WEBHOOK_SECRET || '';
  if (secret && req.get('x-tool-secret') !== secret) return res.status(401).json({ error: 'Unauthorized tool call.' });
  const spec = toolsByName[req.params.tool];
  if (!spec) return res.status(404).json({ error: `Unknown tool: ${req.params.tool}` });
  const params = (req.body && typeof req.body === 'object') ? req.body : {};
  const convId = req.get('elevenlabs-conversation-id') || req.get('x-conversation-id') || params.conversation_id || params.system__conversation_id || req.query.conversation_id || '';
  const missing = (spec.required || []).filter(k => params[k] === undefined || params[k] === null || params[k] === '');
  const entry = findCallEntry(convId);
  let recorded = false, writeback = null;
  if (entry) {
    entry.outcomes = entry.outcomes || [];
    const clean = {}; Object.keys(params).forEach(k => { if (!/^conversation_id$|^system__/.test(k)) clean[k] = params[k]; });
    entry.outcomes.push({ tool: spec.name, params: clean, at: new Date().toISOString() });
    applyOutcome(entry, spec.name, params);
    saveHistory();
    recorded = true;
    // On the final wrap-up, auto-push the outcome using the CALL OWNER's write-back config
    // (this webhook is authenticated by TOOL_WEBHOOK_SECRET, not a user session, so we key off entry.userId).
    const wb = getWriteback(entry.userId);
    if (spec.name === 'record_call_outcome' && wb.enabled) {
      try { const r = await runWritebackForEntries([entry], wb, entry.userId); writeback = { ok: true, sink: r.sink, detail: r.detail }; }
      catch (e) { writeback = { ok: false, detail: e.message }; entry.writeback = { ok: false, detail: e.message, at: new Date().toISOString() }; saveHistory(); }
    }
  }
  res.json({ success: true, message: toolMessage(spec, params), recorded, callId: entry ? (entry.callId || entry.id) : null, missing_params: missing, writeback });
});

// ── WRITE-BACK (push post-call outcomes to the system of record) ──
app.get('/api/writeback/config', (req, res) => res.json(getWriteback(req.user.id)));
app.post('/api/writeback/config', (req, res) => {
  const b = req.body || {};
  setWriteback(req.user.id, { enabled: !!b.enabled, sink: b.sink || 'echo', config: b.config || {}, mapping: b.mapping || null });
  res.json({ success: true, ...getWriteback(req.user.id) });
});
app.get('/api/writeback/preview', (req, res) => {
  const wb = getWriteback(req.user.id);
  const entries = visibleCalls(req).filter(c => c.outcomes && c.outcomes.length);
  res.json({ count: entries.length, mapping: wb.mapping || connectors.DEFAULT_MAPPING, rows: entries.map(e => connectors.buildWritebackRow(e, wb.mapping)) });
});
app.post('/api/writeback/run', requireBulk, async (req, res) => {
  const b = req.body || {};
  const wb = getWriteback(req.user.id);
  const cfg = { sink: b.sink || wb.sink, config: b.config || wb.config, mapping: b.mapping || wb.mapping };
  let entries = visibleCalls(req).filter(c => c.outcomes && c.outcomes.length);
  if (Array.isArray(b.callIds) && b.callIds.length) entries = entries.filter(c => b.callIds.includes(c.callId) || b.callIds.includes(c.id));
  if (!entries.length) return res.status(400).json({ error: 'No calls with recorded outcomes to write back.' });
  try { const r = await runWritebackForEntries(entries, cfg, req.user.id); res.json({ success: true, count: entries.length, ...r }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/writeback/log', (req, res) => res.json({ log: connectors.getEchoLog(req.user.role === 'admin' ? null : req.user.id) }));

// Call details (status + recording + transcript) via the entry's provider
app.get('/api/call/:callId', async (req, res) => {
  const entry = callHistory.find(c => c.callId === req.params.callId);
  if (entry && req.user.role !== 'admin' && entry.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized for this call.' });
  const adapter = adapterForEntry(entry);
  if (!adapter.isConfigured(config)) return res.status(400).json({ error: 'Voice provider not configured.' });
  try {
    const norm = await adapter.getCall(req.params.callId, config);
    let recording_url = norm.recording_url;
    if (!recording_url && norm.has_audio) recording_url = audioProxyUrl(req, req.params.callId);
    if (entry) enrichEntryFromCall(entry, norm, recording_url);
    res.json({ success: true, call: { ...norm, recording_url } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recording audio proxy (ElevenLabs) / redirect (Retell)
app.get('/api/call/:callId/audio', async (req, res) => {
  const entry = callHistory.find(c => c.callId === req.params.callId);
  if (entry && req.user.role !== 'admin' && entry.userId !== req.user.id) return res.status(403).json({ error: 'Not authorized for this call.' });
  const adapter = adapterForEntry(entry);
  try {
    if (adapter.name === 'retell') {
      const norm = await adapter.getCall(req.params.callId, config);
      if (norm.recording_url) return res.redirect(norm.recording_url);
      return res.status(404).json({ error: 'No recording available.' });
    }
    const { contentType, stream } = await adapter.getAudio(req.params.callId, config);
    res.setHeader('Content-Type', contentType);
    stream.pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sync recent calls' status/recording from the provider
app.post('/api/history/sync', async (req, res) => {
  const limit = Math.min(parseInt(req.body && req.body.limit) || 30, 50);
  // Scoped to what this user may see. This read the GLOBAL history, so a partner pressing Sync
  // both synced and RECEIVED every other tenant's calls — the one place the isolation work missed.
  const targets = visibleCalls(req).filter(c => c.callId).slice(0, limit);
  let updated = 0;
  for (const c of targets) {
    const adapter = adapterForEntry(c);
    if (!adapter.isConfigured(config)) continue;
    try { const norm = await adapter.getCall(c.callId, config); let rec = norm.recording_url; if (!rec && norm.has_audio) rec = audioProxyUrl(req, c.callId); enrichEntryFromCall(c, norm, rec); updated++; } catch (e) { /* skip */ }
  }
  res.json({ success: true, updated, calls: visibleCalls(req).slice(0, 200) });
});

// CRM template (live dates)
app.get('/api/template/crm', (req, res) => {
  const csv = `customer_name,to_number,use_case,product_name,amount_due,due_date,days_overdue,amount_overdue,outstanding_balance,offer_type,offer_detail,expiry_date,appointment_type,appointment_date,appointment_time,location,interaction_type,interaction_date,lead_source,interest,renewal_item,renewal_date,notes
John Carter,+14155550142,,credit card bill,240,${futureDate(5)},,,1850,,,,,,,,,,,,,,Payment reminder (inferred)
Maria Garcia,+34655550188,,mobile plan,,,12,45,90,,,,,,,,,,,,,,Overdue follow-up
Wei Chen,+6591230145,sales_offer,,,,,,,Fibre Broadband Upgrade,double the speed for six months,end of the month,,,,,,,,,,,Sales offer (explicit)
Aisha Al-Rashid,+971501230177,,,,,,,,,,,home service visit,${futureDate(3)},between 2 and 4 in the afternoon,your registered address,,,,,,,Appointment reminder
David Okafor,+2348031230155,,,,,,,,,,,,,,,your recent support call,yesterday,,,,,Feedback survey
Priya Nair,+919812340155,,,,,,,,,,,,,,,,,your enquiry on our website,a home loan,,,Lead qualification
Sofia Rossi,+390612340188,,,,,,,,,,,,,,,,,,,annual membership,${futureDate(9)},Renewal / retention`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="omnireach-crm-template.csv"');
  res.send(csv);
});

// ── START ───────────────────────────────────────────────
// Connect the store, pull everything into memory, seed the first admin, then listen.
async function start() {
  let where;
  try { where = await store.init(); }
  catch (e) { console.error(`\n❌  Could not reach the database: ${e.message}\n    Check DATABASE_URL, or unset it to fall back to local JSON files.\n`); process.exit(1); }
  await hydrate();
  seedAdmin();
  app.listen(PORT, () => {
    console.log(`\n📞  OmniReach is running.`);
    console.log(`    ▶  Open the console:  http://localhost:${PORT}`);
    console.log(`    Storage:         ${where.detail}`);
    console.log(`    Active profile:  ${(activeProfile.company || {}).name || 'default'}  (${(activeProfile.company || {}).country || ''})`);
    console.log(`    Voice provider:  ${activeProviderName()}  (configured: ${providerConfigured(activeProviderName())})`);
    // Say out loud which organisation owns the platform. Everything about who can see whose calls
    // hangs off this one value, so it must never be a silent guess.
    const po = platformOrg();
    const why = process.env.PLATFORM_ORG ? 'from PLATFORM_ORG'
      : (auth.loadUsers().some(u => u.superAdmin) ? "the super administrator's organisation"
        : 'the oldest admin account — set a super admin to make this explicit');
    console.log(`    Platform owner:  ${po || '(none yet)'}  (${why})`);
    const supers = auth.loadUsers().filter(u => u.superAdmin && u.role === 'admin');
    console.log(`    Super admins:    ${supers.length ? supers.map(u => u.email).join(', ') : 'none — run: npm run make-admin -- you@company.com super'}`);
    // Say who receives the estate-wide report out loud. It is the one thing that leaves the platform
    // carrying every partner's data, so it should never be a setting nobody has read.
    console.log(`    Daily report:    ${dailyReport.enabled ? `${dailyReport.sendAt} ${dailyReport.timezone} → ${dailyReport.recipients.join(', ')}` : 'off'}${dailyReport.enabled && !mailer.status().delivers ? '  ⚠️  MAIL_PROVIDER=dev, so it will only print to this log' : ''}\n`);
    securityAudit();
    const active = schedules.filter(s => s.enabled !== false && s.status !== 'completed').length;
    if (active) console.log(`⏰  Scheduler running — ${active} active schedule(s).\n`);
    // Tick every 30s: fine-grained enough to hit a minute-accurate slot, cheap enough to ignore.
    setInterval(schedulerTick, 30000);
    setTimeout(schedulerTick, 3000);   // catch anything that came due while we were down
    // Chase call outcomes on their own clock, so a finished call stops showing as in progress
    // whether or not anyone has the console open.
    setInterval(syncPendingCalls, 20000);
    setTimeout(syncPendingCalls, 5000);
    // The daily report checks once a minute rather than firing on a timer set at boot, so a restart,
    // a deploy or an overnight outage cannot make a day's report disappear: whenever the process is
    // next alive past the send time, the day it owes still goes out.
    setInterval(reportTick, 60000);
    setTimeout(reportTick, 25000);
    // Ask ElevenLabs what it speaks, shortly after boot and twice a day. Cheap, and it means a new
    // language on their side turns up in the log rather than in a demo.
    setTimeout(() => refreshLanguageCoverage(), 8000);
    setInterval(() => refreshLanguageCoverage(true), 12 * 60 * 60 * 1000);
    // Register and attach the action tools on boot, so a deployed instance needs no button press.
    setTimeout(() => autoSyncTools(), 12000);
  });
}
// Don't lose queued writes when the host stops the process (deploys, Ctrl+C).
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`\n${sig} received — flushing pending writes…`);
  try { await store.close(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) start();

module.exports = app;
module.exports.start = start;

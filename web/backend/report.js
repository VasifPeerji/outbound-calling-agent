/**
 * OmniReach — the daily activity report.
 *
 * One email, once a day, that tells Streebo what every partner did with the platform yesterday.
 * It is the only place the whole estate is visible in one view, so it is written to be read on a
 * phone at 8am rather than mined: headline numbers first, one row per COMPANY, then the detail.
 *
 * THREE DECISIONS WORTH KNOWING ABOUT:
 *
 *  1. THE UNIT IS THE COMPANY, NOT THE ACCOUNT. What we need to know is how much a partner is
 *     using the platform; which of their staff placed which call is a detail, not the headline.
 *     So each row is one organisation, with its accounts named underneath so the shape of the
 *     team is still visible.
 *
 *  2. NO RECORDINGS ARE ATTACHED. A busy day across every partner would be tens of megabytes and
 *     Graph's simple send would silently refuse it. The report carries everything needed to decide
 *     WHICH conversations are worth listening to; the recordings themselves stay in the console,
 *     behind the same permissions as always. That also keeps a mail sitting in an inbox from
 *     becoming an unguarded copy of real customer conversations.
 *
 *  3. THE DAY IS A REAL DAY IN A REAL PLACE. Midnight to midnight in the report's own timezone
 *     (India by default), never the host's clock — otherwise moving the server to a machine in a
 *     different region would silently redraw every day boundary in the report.
 *
 * Pure module: it reads a snapshot of state and returns strings. No I/O, no timers, no mailer.
 */
const scheduler = require('./scheduler');

// ── settings ────────────────────────────────────────────
// Everything here is editable by the super administrator from the console, because "who gets it"
// and "when" are exactly the things that change once a rollout is real.
const DEFAULTS = {
  enabled: true,
  timezone: 'Asia/Kolkata',
  sendAt: '00:15',                  // just after the day closes, so the day it covers is complete
  recipients: [
    'vasif.peerji@streebo.com',
    'presales@streebo.com',
    'vibhuti.ramanuj@streebosolutions.com'
  ],
  includeQuietPartners: true,       // name the partners who did nothing; silence is information too
  includeSimulated: true,           // demo calls are real usage, they are just not real spend
  maxCallRowsPerCompany: 40,
  lastSentDateKey: '',              // the day whose report last went out, in the report's timezone
  lastResult: null                  // { at, dateKey, ok, detail, recipients }
};

/** Merge saved settings over the defaults so a key added later is picked up without a migration. */
function withDefaults(saved) {
  const s = Object.assign({}, DEFAULTS, saved || {});
  s.recipients = (Array.isArray(s.recipients) ? s.recipients : String(s.recipients || '').split(/[,;\s]+/))
    .map(x => String(x || '').trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  if (!s.recipients.length) s.recipients = DEFAULTS.recipients.slice();
  if (!/^\d{1,2}:\d{2}$/.test(String(s.sendAt || ''))) s.sendAt = DEFAULTS.sendAt;
  return s;
}

// ── where a call went ───────────────────────────────────
// Derived from the dialled number rather than stored, so it works on every call ever placed
// including the ones made before the platform thought to record a destination country.
// Longest prefix wins, which is what makes +1 and +1868 both resolve correctly.
const DIAL_CODES = {
  '1': 'United States / Canada', '7': 'Russia / Kazakhstan', '20': 'Egypt', '27': 'South Africa',
  '30': 'Greece', '31': 'Netherlands', '32': 'Belgium', '33': 'France', '34': 'Spain',
  '36': 'Hungary', '39': 'Italy', '40': 'Romania', '41': 'Switzerland', '43': 'Austria',
  '44': 'United Kingdom', '45': 'Denmark', '46': 'Sweden', '47': 'Norway', '48': 'Poland',
  '49': 'Germany', '51': 'Peru', '52': 'Mexico', '54': 'Argentina', '55': 'Brazil',
  '56': 'Chile', '57': 'Colombia', '58': 'Venezuela', '60': 'Malaysia', '61': 'Australia',
  '62': 'Indonesia', '63': 'Philippines', '64': 'New Zealand', '65': 'Singapore', '66': 'Thailand',
  '81': 'Japan', '82': 'South Korea', '84': 'Vietnam', '86': 'China', '90': 'Türkiye',
  '91': 'India', '92': 'Pakistan', '93': 'Afghanistan', '94': 'Sri Lanka', '95': 'Myanmar',
  '98': 'Iran', '211': 'South Sudan', '212': 'Morocco', '213': 'Algeria', '216': 'Tunisia',
  '218': 'Libya', '220': 'Gambia', '221': 'Senegal', '223': 'Mali', '225': "Côte d'Ivoire",
  '226': 'Burkina Faso', '227': 'Niger', '228': 'Togo', '229': 'Benin', '230': 'Mauritius',
  '231': 'Liberia', '232': 'Sierra Leone', '233': 'Ghana', '234': 'Nigeria', '235': 'Chad',
  '236': 'Central African Republic', '237': 'Cameroon', '238': 'Cape Verde', '240': 'Equatorial Guinea',
  '241': 'Gabon', '243': 'DR Congo', '244': 'Angola', '250': 'Rwanda', '251': 'Ethiopia',
  '252': 'Somalia', '254': 'Kenya', '255': 'Tanzania', '256': 'Uganda', '257': 'Burundi',
  '258': 'Mozambique', '260': 'Zambia', '261': 'Madagascar', '263': 'Zimbabwe', '264': 'Namibia',
  '265': 'Malawi', '266': 'Lesotho', '267': 'Botswana', '268': 'Eswatini', '291': 'Eritrea',
  '350': 'Gibraltar', '351': 'Portugal', '352': 'Luxembourg', '353': 'Ireland', '354': 'Iceland',
  '355': 'Albania', '356': 'Malta', '357': 'Cyprus', '358': 'Finland', '359': 'Bulgaria',
  '370': 'Lithuania', '371': 'Latvia', '372': 'Estonia', '373': 'Moldova', '374': 'Armenia',
  '375': 'Belarus', '376': 'Andorra', '377': 'Monaco', '380': 'Ukraine', '381': 'Serbia',
  '382': 'Montenegro', '383': 'Kosovo', '385': 'Croatia', '386': 'Slovenia', '387': 'Bosnia and Herzegovina',
  '389': 'North Macedonia', '420': 'Czechia', '421': 'Slovakia', '423': 'Liechtenstein',
  '500': 'Falkland Islands', '501': 'Belize', '502': 'Guatemala', '503': 'El Salvador',
  '504': 'Honduras', '505': 'Nicaragua', '506': 'Costa Rica', '507': 'Panama', '509': 'Haiti',
  '590': 'Guadeloupe', '591': 'Bolivia', '593': 'Ecuador', '595': 'Paraguay', '598': 'Uruguay',
  '673': 'Brunei', '675': 'Papua New Guinea', '679': 'Fiji', '682': 'Cook Islands',
  '850': 'North Korea', '852': 'Hong Kong', '853': 'Macau', '855': 'Cambodia', '856': 'Laos',
  '880': 'Bangladesh', '886': 'Taiwan', '960': 'Maldives', '961': 'Lebanon', '962': 'Jordan',
  '963': 'Syria', '964': 'Iraq', '965': 'Kuwait', '966': 'Saudi Arabia', '967': 'Yemen',
  '968': 'Oman', '970': 'Palestine', '971': 'United Arab Emirates', '972': 'Israel',
  '973': 'Bahrain', '974': 'Qatar', '975': 'Bhutan', '976': 'Mongolia', '977': 'Nepal',
  '992': 'Tajikistan', '993': 'Turkmenistan', '994': 'Azerbaijan', '995': 'Georgia',
  '996': 'Kyrgyzstan', '998': 'Uzbekistan'
};
function countryOf(number) {
  const digits = String(number || '').replace(/[^\d]/g, '');
  if (!digits) return 'Unknown';
  for (let len = 4; len >= 1; len--) {
    const hit = DIAL_CODES[digits.slice(0, len)];
    if (hit) return hit;
  }
  return 'Unknown';
}

// ── the day window ──────────────────────────────────────
/**
 * Midnight to midnight in the report's timezone, expressed as UTC instants so it can be compared
 * against the ISO timestamps on call records. `dateKey` is the local calendar day being covered.
 */
function dayWindow(dateKey, timezone) {
  // Find the UTC instant of local midnight by probing: start from the UTC midnight of that date and
  // correct by whatever the zone's offset turns out to be. Two passes settles DST edges.
  const [y, m, d] = dateKey.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const p = scheduler.zoneParts(new Date(guess), timezone);
    const driftDays = (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(y, m - 1, d)) / 86400000;
    const driftMins = driftDays * 1440 + p.minutes;
    guess -= driftMins * 60000;
  }
  const from = new Date(guess);
  const to = new Date(guess + 86400000);
  return { dateKey, timezone, fromIso: from.toISOString(), toIso: to.toISOString(), from, to };
}

/** The calendar day, in the report's timezone, that has most recently finished. */
function previousDateKey(now, timezone) {
  const p = scheduler.zoneParts(new Date(now.getTime() - 86400000), timezone);
  return p.dateKey;
}
function currentDateKey(now, timezone) { return scheduler.zoneParts(now, timezone).dateKey; }

// ── formatting ──────────────────────────────────────────
function hms(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(n, d) { return d ? Math.round(n / d * 100) : 0; }
function prettyDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${days[dt.getUTCDay()]} ${d} ${months[m - 1]} ${y}`;
}
function localTime(iso, timezone) {
  const p = scheduler.zoneParts(new Date(iso), timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
/** Top entries of a tally, as "Name (n)" text — used everywhere a cell needs a short distribution. */
function topOf(tally, limit) {
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, limit || 3).map(([k, v]) => ({ key: k, n: v }));
}
function titleise(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ── the report ──────────────────────────────────────────
/**
 * Build the whole picture for one day.
 *
 * @param state  { calls, users, orgQuotas, userProfiles }
 * @param opts   { dateKey, timezone, includeSimulated, maxCallRowsPerCompany, partial }
 */
function buildReport(state, opts) {
  const o = opts || {};
  const timezone = o.timezone || DEFAULTS.timezone;
  const dateKey = o.dateKey;
  const win = dayWindow(dateKey, timezone);
  const users = state.users || [];
  const profiles = state.userProfiles || {};
  const orgQuotas = state.orgQuotas || {};
  const maxRows = o.maxCallRowsPerCompany || DEFAULTS.maxCallRowsPerCompany;

  const userById = {};
  users.forEach(u => { userById[u.id] = u; });
  const orgIdOf = u => (u && (u.orgId || (String(u.email || '').split('@')[1] || ''))) || '';

  // Every call that started inside the window. A call still running at midnight belongs to the day
  // it was placed, which is the only reading that keeps a call in exactly one report.
  const inWindow = (state.calls || []).filter(c => {
    if (!c.timestamp) return false;
    const t = new Date(c.timestamp).getTime();
    return t >= win.from.getTime() && t < win.to.getTime();
  });
  const calls = o.includeSimulated === false ? inWindow.filter(c => !c.simulated) : inWindow;

  // Industry is stamped on new calls; older records fall back to whatever the caller's profile says
  // today, which is right far more often than it is wrong for a partner who demos one industry.
  const industryOf = c => c.industry || ((profiles[c.userId] || {}).company || {}).industry || '';

  const classify = c => {
    const dur = c.durationMs || 0;
    const cs = (c.callStatus || '').toLowerCase();
    if (c.status === 'failed' || cs === 'failed' || cs === 'error') return 'failed';
    if (c.disposition === 'no_answer_voicemail' || c.disposition === 'wrong_person') return 'noReach';
    if (c.disposition) return 'connected';
    if (c.callSuccessful === true) return 'connected';
    if (cs === 'ended') return dur >= 10000 ? 'connected' : 'noReach';
    return 'pending';
  };

  // ── group by company ──────────────────────────────────
  const companies = {};
  const companyFor = (orgId) => {
    if (!companies[orgId]) {
      // Display name: whatever the people in that org call themselves, most common answer wins.
      const members = users.filter(u => orgIdOf(u) === orgId);
      const names = {};
      members.forEach(u => { const n = String(u.org || '').trim(); if (n) names[n] = (names[n] || 0) + 1; });
      const label = topOf(names, 1)[0];
      companies[orgId] = {
        orgId, name: label ? label.key : (orgId || 'Unassigned'),
        memberCount: members.length,
        accounts: {}, calls: [], countries: {}, industries: {}, useCases: {},
        agentBrands: {}, dispositions: {}, sentiment: { positive: 0, neutral: 0, negative: 0 },
        totals: { calls: 0, live: 0, simulated: 0, connected: 0, noReach: 0, failed: 0, pending: 0, talkSeconds: 0, longest: 0 },
        boost: null
      };
    }
    return companies[orgId];
  };

  // Seed every known organisation so a partner with a quiet day is still nameable.
  users.forEach(u => { if (orgIdOf(u)) companyFor(orgIdOf(u)); });

  const global = {
    calls: 0, live: 0, simulated: 0, connected: 0, noReach: 0, failed: 0, pending: 0,
    talkSeconds: 0, countries: {}, industries: {}, useCases: {}, activeCompanies: 0, activeAccounts: 0
  };

  calls.forEach(c => {
    const u = userById[c.userId];
    const orgId = c.orgId || (u ? orgIdOf(u) : '') || 'unassigned';
    const co = companyFor(orgId);
    const cls = classify(c);
    const secs = Math.max(0, Math.round((c.durationMs || 0) / 1000));
    const country = countryOf(c.toNumber);
    const industry = industryOf(c);

    co.calls.push(c);
    co.totals.calls++;
    co.totals[cls]++;
    co.totals.talkSeconds += secs;
    co.totals.longest = Math.max(co.totals.longest, secs);
    if (c.simulated) co.totals.simulated++; else co.totals.live++;
    co.countries[country] = (co.countries[country] || 0) + 1;
    if (industry) co.industries[industry] = (co.industries[industry] || 0) + 1;
    if (c.useCase) co.useCases[c.useCase] = (co.useCases[c.useCase] || 0) + 1;
    if (c.company) co.agentBrands[c.company] = (co.agentBrands[c.company] || 0) + 1;
    if (c.disposition) co.dispositions[c.disposition] = (co.dispositions[c.disposition] || 0) + 1;
    const sent = String(c.userSentiment || '').toLowerCase();
    if (co.sentiment[sent] !== undefined) co.sentiment[sent]++;

    const aid = c.userId || 'unknown';
    if (!co.accounts[aid]) {
      co.accounts[aid] = {
        id: aid,
        name: (u && u.name) || c.userName || 'Unknown',
        email: (u && u.email) || '',
        calls: 0, talkSeconds: 0, connected: 0, simulated: 0
      };
    }
    const acc = co.accounts[aid];
    acc.calls++; acc.talkSeconds += secs;
    if (cls === 'connected') acc.connected++;
    if (c.simulated) acc.simulated++;

    global.calls++; global[cls]++; global.talkSeconds += secs;
    if (c.simulated) global.simulated++; else global.live++;
    global.countries[country] = (global.countries[country] || 0) + 1;
    if (industry) global.industries[industry] = (global.industries[industry] || 0) + 1;
    if (c.useCase) global.useCases[c.useCase] = (global.useCases[c.useCase] || 0) + 1;
  });

  // ── allowance boosts, both company-wide and personal ──
  const stillActive = b => !!b && (!b.until || new Date(b.until).getTime() > Date.now());
  const boosts = [];
  Object.entries(orgQuotas || {}).forEach(([orgId, b]) => {
    if (!b) return;
    boosts.push({
      scope: 'Company', who: (companies[orgId] || {}).name || orgId, orgId,
      callsPerDay: b.callsPerDay, minutesPerDay: b.minutesPerDay, bulk: !!b.bulk,
      until: b.until || null, reason: b.reason || '', grantedBy: b.grantedByEmail || b.grantedBy || '',
      grantedAt: b.grantedAt || null, active: stillActive(b)
    });
    if (companies[orgId]) companies[orgId].boost = { scope: 'company', active: stillActive(b), until: b.until || null };
  });
  users.forEach(u => {
    const b = u.quotaOverride;
    if (!b) return;
    boosts.push({
      scope: 'Person', who: u.name || u.email, orgId: orgIdOf(u), email: u.email,
      callsPerDay: b.callsPerDay, minutesPerDay: b.minutesPerDay, bulk: !!b.bulk,
      until: b.until || null, reason: b.reason || '', grantedBy: b.grantedByEmail || b.grantedBy || '',
      grantedAt: b.grantedAt || null, active: stillActive(b)
    });
    const co = companies[orgIdOf(u)];
    if (co && stillActive(b) && !co.boost) co.boost = { scope: 'person', active: true, until: b.until || null };
  });
  // Newest grant first, and anything expired sinks below anything live.
  boosts.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')));

  // ── shape the company list ────────────────────────────
  const list = Object.values(companies).map(co => {
    const accounts = Object.values(co.accounts).sort((a, b) => b.calls - a.calls);
    return Object.assign(co, {
      accountList: accounts,
      topCountries: topOf(co.countries, 6),
      topIndustries: topOf(co.industries, 3),
      topUseCases: topOf(co.useCases, 4),
      topBrands: topOf(co.agentBrands, 2),
      topDispositions: topOf(co.dispositions, 4),
      avgSeconds: co.totals.calls ? Math.round(co.totals.talkSeconds / co.totals.calls) : 0,
      connectRate: pct(co.totals.connected, co.totals.connected + co.totals.noReach + co.totals.failed),
      // Newest first reads oddly in a daily log; the day is easier to follow forwards.
      callRows: co.calls.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))),
      truncated: Math.max(0, co.calls.length - maxRows)
    });
  });
  const active = list.filter(c => c.totals.calls > 0).sort((a, b) => b.totals.calls - a.totals.calls || b.totals.talkSeconds - a.totals.talkSeconds);
  const quiet = list.filter(c => c.totals.calls === 0 && c.memberCount > 0).sort((a, b) => a.name.localeCompare(b.name));
  global.activeCompanies = active.length;
  global.activeAccounts = active.reduce((s, c) => s + c.accountList.length, 0);

  return {
    generatedAt: new Date().toISOString(),
    window: win, dateKey, timezone, partial: !!o.partial,
    label: prettyDate(dateKey),
    totals: Object.assign({}, global, {
      connectRate: pct(global.connected, global.connected + global.noReach + global.failed),
      avgSeconds: global.calls ? Math.round(global.talkSeconds / global.calls) : 0,
      partners: list.filter(c => c.memberCount > 0).length,
      accounts: users.length
    }),
    topCountries: topOf(global.countries, 12),
    topIndustries: topOf(global.industries, 10),
    topUseCases: topOf(global.useCases, 10),
    companies: active, quiet: o.includeQuietPartners === false ? [] : quiet, boosts,
    maxCallRowsPerCompany: maxRows
  };
}

// ── HTML rendering ──────────────────────────────────────
// Table layout with inline styles on purpose: Outlook strips <style> blocks and has never supported
// flexbox or grid, and this mail has to survive Outlook desktop as well as a phone.
const C = {
  ink: '#191B2A', dim: '#5A6072', muted: '#888FA2', line: '#E5E7EF', soft: '#F8F9FC',
  brand: '#4F46E5', brandDark: '#3730A3', green: '#12996B', amber: '#C4790C', red: '#E0475A', blue: '#2D6BD6'
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function kpi(label, value, note, colour) {
  return `<td width="20%" style="padding:0 5px 0 0;vertical-align:top">
    <div style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;padding:11px 10px">
      <div style="font:600 9.5px ${FONT};color:${C.muted};letter-spacing:.06em;text-transform:uppercase;white-space:nowrap">${esc(label)}</div>
      <div style="font:700 19px ${FONT};color:${colour || C.ink};margin-top:5px;line-height:1.15;white-space:nowrap">${value}</div>
      <div style="font:400 10.5px ${FONT};color:${C.dim};margin-top:3px;line-height:1.35">${note || '&nbsp;'}</div>
    </div></td>`;
}
function th(text, align) {
  return `<th align="${align || 'left'}" style="font:600 10px ${FONT};color:${C.muted};letter-spacing:.05em;text-transform:uppercase;padding:8px 9px;border-bottom:2px solid ${C.line};white-space:nowrap">${esc(text)}</th>`;
}
function td(html, align, extra) {
  return `<td align="${align || 'left'}" style="font:400 12px ${FONT};color:${C.ink};padding:8px 9px;border-bottom:1px solid ${C.line};vertical-align:top;${extra || ''}">${html}</td>`;
}
/** Tighter row for the plain two-and-a-bar tables, which are long and want to stay scannable. */
function tdSlim(html, align, extra) {
  return `<td align="${align || 'left'}" style="font:400 12px ${FONT};color:${C.ink};padding:5px 9px;border-bottom:1px solid ${C.line};vertical-align:middle;${extra || ''}">${html}</td>`;
}
function chip(text, colour, bg) {
  return `<span style="display:inline-block;font:600 10.5px ${FONT};color:${colour};background:${bg};border-radius:20px;padding:2px 8px;margin:1px 2px 1px 0;white-space:nowrap">${esc(text)}</span>`;
}
function distribution(items, total) {
  if (!items.length) return `<span style="color:${C.muted}">—</span>`;
  return items.map(i => {
    const share = total ? Math.round(i.n / total * 100) : 0;
    return `<div style="font:400 11.5px ${FONT};color:${C.ink};margin-bottom:3px;white-space:nowrap">${esc(titleise(i.key))}
      <span style="color:${C.muted}">· ${i.n}${share ? ` (${share}%)` : ''}</span></div>`;
  }).join('');
}
/** A bar drawn with a nested table, because a div with a width is the one thing Outlook does render. */
function bar(n, max, colour) {
  const w = max ? Math.max(2, Math.round(n / max * 100)) : 0;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:150px">
    <tr><td style="background:${C.line};border-radius:3px;height:7px;line-height:7px;font-size:0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${w}%" style="height:7px">
        <tr><td style="background:${colour};border-radius:3px;height:7px;line-height:7px;font-size:0">&nbsp;</td></tr>
      </table></td></tr></table>`;
}

function renderHtml(r) {
  const t = r.totals;
  const outcomeChips = c => [
    c.totals.connected ? chip(`${c.totals.connected} connected`, C.green, 'rgba(18,153,107,0.12)') : '',
    c.totals.noReach ? chip(`${c.totals.noReach} no answer`, C.amber, 'rgba(196,121,12,0.13)') : '',
    c.totals.failed ? chip(`${c.totals.failed} failed`, C.red, 'rgba(224,71,90,0.10)') : '',
    c.totals.pending ? chip(`${c.totals.pending} in flight`, C.blue, 'rgba(45,107,214,0.11)') : ''
  ].filter(Boolean).join('');

  // ── one row per company ──
  const companyRows = r.companies.map((c, i) => {
    const accounts = c.accountList.map(a =>
      `<div style="font:400 11.5px ${FONT};color:${C.dim};margin-top:3px">↳ ${esc(a.name)}
        <span style="color:${C.muted}">· ${a.calls} call${a.calls === 1 ? '' : 's'} · ${hms(a.talkSeconds)}</span></div>`).join('');
    // Industry sits under the company name rather than in a column of its own: a partner almost
    // always demonstrates one industry, and a sixth column pushes the table past the width an email
    // client will show without a horizontal scrollbar.
    const inds = c.topIndustries.length ? c.topIndustries : c.topUseCases;
    return `<tr style="background:${i % 2 ? C.soft : '#FFFFFF'}">
      ${td(`<div style="font:700 13px ${FONT};color:${C.ink}">${esc(c.name)}</div>
        <div style="font:400 10.5px ${FONT};color:${C.muted};margin-top:2px">${esc(c.orgId)} · ${c.accountList.length} of ${c.memberCount} account${c.memberCount === 1 ? '' : 's'} active</div>
        ${inds.length ? `<div style="font:600 11px ${FONT};color:${C.blue};margin-top:3px">${esc(inds.map(x => titleise(x.key)).join(' · '))}</div>` : ''}
        ${accounts}
        ${c.boost && c.boost.active ? `<div style="margin-top:5px">${chip('allowance boost active', C.brand, 'rgba(79,70,229,0.10)')}</div>` : ''}`, 'left', 'width:38%')}
      ${td(`<div style="font:700 17px ${FONT}">${c.totals.calls}</div>
        <div style="font:400 10.5px ${FONT};color:${C.muted};margin-top:2px">${c.totals.live} live${c.totals.simulated ? `<br>${c.totals.simulated} sim` : ''}</div>`, 'right')}
      ${td(`<div style="font:700 14px ${FONT};color:${c.connectRate >= 50 ? C.green : C.ink}">${c.connectRate}%</div>
        <div style="margin-top:4px">${outcomeChips(c)}</div>`, 'left', 'width:20%')}
      ${td(`<div style="font:700 13px ${FONT}">${hms(c.totals.talkSeconds)}</div>
        <div style="font:400 10.5px ${FONT};color:${C.muted};margin-top:2px">avg ${hms(c.avgSeconds)}<br>max ${hms(c.totals.longest)}</div>`, 'right', 'white-space:nowrap')}
      ${td(distribution(c.topCountries, c.totals.calls), 'left', 'width:24%')}
    </tr>`;
  }).join('');

  // ── per-company call detail ──
  const detail = r.companies.map(c => {
    const rows = c.callRows.slice(0, r.maxCallRowsPerCompany).map(call => {
      const secs = Math.round((call.durationMs || 0) / 1000);
      const cls = call.status === 'failed' ? 'failed' : (call.disposition || (call.callStatus === 'ended' ? 'ended' : 'in flight'));
      const colour = call.status === 'failed' ? C.red : (call.disposition ? C.green : C.dim);
      return `<tr>
        ${tdSlim(`<span style="color:${C.dim}">${esc(localTime(call.timestamp, r.timezone))}</span>`, 'left')}
        ${tdSlim(`<strong>${esc(call.customerName || '—')}</strong>
          <div style="font:400 10.5px ${FONT};color:${C.muted}">${esc(call.toNumber || '')} · ${esc(countryOf(call.toNumber))}</div>`, 'left', 'width:34%')}
        ${tdSlim(esc(titleise(call.useCase) || '—'), 'left', 'width:20%')}
        ${tdSlim(secs ? hms(secs) : '<span style="color:' + C.muted + '">—</span>', 'right')}
        ${tdSlim(`<span style="color:${colour};font-weight:600">${esc(titleise(cls))}</span>${call.simulated ? ' ' + chip('sim', C.dim, C.line) : ''}`, 'left', 'width:20%')}
        ${tdSlim(esc((call.userName || '').split(' ')[0] || '—'), 'left')}
      </tr>`;
    }).join('');
    return `<div style="margin-top:22px">
      <div style="font:700 13.5px ${FONT};color:${C.ink};padding-bottom:6px">${esc(c.name)}
        <span style="font:400 11.5px ${FONT};color:${C.muted}">· ${c.totals.calls} call${c.totals.calls === 1 ? '' : 's'} · ${hms(c.totals.talkSeconds)} talk time${c.topBrands.length ? ` · calling as ${esc(c.topBrands.map(b => b.key).join(', '))}` : ''}</span></div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:10px">
        <thead><tr style="background:${C.soft}">${th('Time')}${th('Called')}${th('Use case')}${th('Talk', 'right')}${th('Outcome')}${th('By')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${c.truncated ? `<div style="font:400 11.5px ${FONT};color:${C.amber};padding:7px 2px">${c.truncated} further call${c.truncated === 1 ? '' : 's'} not listed here. The full record is in the console under Call History.</div>` : ''}
    </div>`;
  }).join('');

  const maxCountry = r.topCountries.length ? r.topCountries[0].n : 0;
  const countryRows = r.topCountries.map(x => `<tr>
    ${tdSlim(esc(x.key), 'left')}
    ${tdSlim(`<strong>${x.n}</strong>`, 'right')}
    ${tdSlim(`<span style="color:${C.dim}">${pct(x.n, t.calls)}%</span>`, 'right')}
    ${tdSlim(bar(x.n, maxCountry, C.brand), 'left', 'width:170px')}
  </tr>`).join('');

  const maxInd = r.topIndustries.length ? r.topIndustries[0].n : 0;
  const industryRows = r.topIndustries.map(x => `<tr>
    ${tdSlim(esc(titleise(x.key)), 'left')}
    ${tdSlim(`<strong>${x.n}</strong>`, 'right')}
    ${tdSlim(`<span style="color:${C.dim}">${pct(x.n, t.calls)}%</span>`, 'right')}
    ${tdSlim(bar(x.n, maxInd, C.blue), 'left', 'width:170px')}
  </tr>`).join('');

  // Calls, minutes and bulk share one cell: three near-empty numeric columns cost more width than
  // the information in them is worth.
  const boostRows = r.boosts.map(b => `<tr>
    ${td(`<strong>${esc(b.who)}</strong><div style="font:400 10.5px ${FONT};color:${C.muted}">${esc(b.email || b.orgId || '')}</div>`, 'left')}
    ${td(b.scope, 'left')}
    ${td([
      b.callsPerDay == null ? '' : `${b.callsPerDay} calls/day`,
      b.minutesPerDay == null ? '' : `${b.minutesPerDay} min/day`,
      b.bulk ? 'bulk on' : ''
    ].filter(Boolean).join('<br>') || '<span style="color:' + C.muted + '">standard</span>', 'left')}
    ${td(b.until ? esc(new Date(b.until).toISOString().slice(0, 10)) : '<span style="color:' + C.muted + '">no expiry</span>', 'left')}
    ${td(b.active ? chip('active', C.green, 'rgba(18,153,107,0.12)') : chip('expired', C.muted, C.line), 'left')}
    ${td(`<span style="color:${C.dim}">${esc(b.reason || '—')}</span>`, 'left')}
  </tr>`).join('');

  const section = (title, sub, inner) => `
    <div style="margin-top:30px">
      <div style="font:700 15px ${FONT};color:${C.ink}">${esc(title)}</div>
      ${sub ? `<div style="font:400 12px ${FONT};color:${C.dim};margin-top:3px">${esc(sub)}</div>` : ''}
      <div style="margin-top:11px">${inner}</div>
    </div>`;
  const emptyNote = text => `<div style="font:400 12.5px ${FONT};color:${C.muted};padding:14px;background:${C.soft};border:1px solid ${C.line};border-radius:10px">${esc(text)}</div>`;

  return `<div style="background:#EEF0F7;padding:22px 12px;font-family:${FONT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:860px;margin:0 auto">
   <tr><td>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.brandDark};background-image:linear-gradient(135deg,${C.brand},${C.brandDark});border-radius:14px 14px 0 0">
      <tr><td style="padding:22px 26px">
        <div style="font:700 19px ${FONT};color:#FFFFFF;letter-spacing:-.01em">OmniReach · Daily activity</div>
        <div style="font:400 13px ${FONT};color:#C9C6F5;margin-top:5px">${esc(r.label)} · midnight to midnight, ${esc(r.timezone)}${r.partial ? ' · <strong>part-day, sent early</strong>' : ''}</div>
      </td></tr>
    </table>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFFFFF;border-radius:0 0 14px 14px;border:1px solid ${C.line};border-top:0">
      <tr><td style="padding:22px 26px 28px">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          ${kpi('Calls placed', String(t.calls), `${t.live} live${t.simulated ? ` · ${t.simulated} simulated` : ''}`)}
          ${kpi('Talk time', hms(t.talkSeconds), `avg ${hms(t.avgSeconds)} a call`, C.brand)}
          ${kpi('Connect rate', `${t.connectRate}%`, `${t.connected} reached a person`, C.green)}
          ${kpi('Partners', `${t.activeCompanies}<span style="font-size:14px;color:${C.muted}"> / ${t.partners}</span>`, `${t.activeAccounts} account${t.activeAccounts === 1 ? '' : 's'} active`, C.blue)}
          ${kpi('Countries', String(r.topCountries.length), r.topCountries.length ? `led by ${esc(r.topCountries[0].key)}` : 'no calls today', C.amber)}
        </tr></table>

        ${section('By partner', 'One row per company. The people underneath each name are the accounts that actually placed calls.',
          r.companies.length
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:10px">
                <thead><tr style="background:${C.soft}">${th('Company · accounts · industry')}${th('Calls', 'right')}${th('Outcome')}${th('Talk time', 'right')}${th('Called to')}</tr></thead>
                <tbody>${companyRows}</tbody></table>`
            : emptyNote('No calls were placed by any partner on this day.'))}

        ${r.topCountries.length ? section('Where the calls went', 'Country resolved from the number dialled.',
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:10px">
            <thead><tr style="background:${C.soft}">${th('Country')}${th('Calls', 'right')}${th('Share', 'right')}${th('')}</tr></thead>
            <tbody>${countryRows}</tbody></table>`) : ''}

        ${r.topIndustries.length ? section('Industries demonstrated', 'Taken from the agent profile each call was placed with.',
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:10px">
            <thead><tr style="background:${C.soft}">${th('Industry')}${th('Calls', 'right')}${th('Share', 'right')}${th('')}</tr></thead>
            <tbody>${industryRows}</tbody></table>`) : ''}

        ${section('Allowance boosts', 'Every raised limit on the platform, live or lapsed.',
          r.boosts.length
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:10px">
                <thead><tr style="background:${C.soft}">${th('Who')}${th('Scope')}${th('Raised to')}${th('Until')}${th('State')}${th('Reason')}</tr></thead>
                <tbody>${boostRows}</tbody></table>`
            : emptyNote('No allowance boosts are in place. Everyone is on the standard limit.'))}

        ${r.companies.length ? section('Call by call', `Every call of the day, grouped by partner${r.companies.some(c => c.truncated) ? `, capped at ${r.maxCallRowsPerCompany} rows per company` : ''}.`, detail) : ''}

        ${r.quiet.length ? section('Partners with no activity', 'Accounts exist, nothing was called.',
          `<div style="padding:12px 13px;background:${C.soft};border:1px solid ${C.line};border-radius:10px">
            ${r.quiet.map(c => chip(`${c.name} (${c.memberCount})`, C.dim, '#FFFFFF')).join(' ')}</div>`) : ''}

        <div style="margin-top:30px;padding-top:16px;border-top:1px solid ${C.line};font:400 11.5px ${FONT};color:${C.muted};line-height:1.7">
          Recordings and transcripts are deliberately not attached. Open the console and use Call History for any company above to play a conversation or read its transcript.<br>
          Generated ${esc(new Date(r.generatedAt).toISOString().replace('T', ' ').slice(0, 16))} UTC · covers ${esc(r.window.fromIso.slice(0, 16).replace('T', ' '))} to ${esc(r.window.toIso.slice(0, 16).replace('T', ' '))} UTC.
        </div>

      </td></tr>
    </table>
   </td></tr>
  </table>
</div>`;
}

/** Plain-text twin. Some clients never render the HTML, and this is also what the dev mailer logs. */
function renderText(r) {
  const t = r.totals;
  const L = [];
  L.push(`OMNIREACH · DAILY ACTIVITY`);
  L.push(`${r.label} — midnight to midnight, ${r.timezone}${r.partial ? ' (part day, sent early)' : ''}`);
  L.push('');
  L.push(`Calls placed    ${t.calls}   (${t.live} live, ${t.simulated} simulated)`);
  L.push(`Talk time       ${hms(t.talkSeconds)}   (avg ${hms(t.avgSeconds)})`);
  L.push(`Connect rate    ${t.connectRate}%   (${t.connected} reached a person)`);
  L.push(`Partners active ${t.activeCompanies} of ${t.partners}   (${t.activeAccounts} accounts)`);
  L.push('');
  L.push('BY PARTNER');
  if (!r.companies.length) L.push('  Nothing was called today.');
  r.companies.forEach(c => {
    L.push(`  ${c.name} (${c.orgId}) — ${c.totals.calls} calls, ${hms(c.totals.talkSeconds)} talk time, ${c.connectRate}% connect`);
    c.accountList.forEach(a => L.push(`      ${a.name} <${a.email}> — ${a.calls} calls, ${hms(a.talkSeconds)}`));
    if (c.topCountries.length) L.push(`      to: ${c.topCountries.map(x => `${x.key} (${x.n})`).join(', ')}`);
    if (c.topIndustries.length) L.push(`      industry: ${c.topIndustries.map(x => `${titleise(x.key)} (${x.n})`).join(', ')}`);
  });
  if (r.boosts.length) {
    L.push('');
    L.push('ALLOWANCE BOOSTS');
    r.boosts.forEach(b => L.push(`  ${b.active ? '[active] ' : '[expired] '}${b.who} (${b.scope}) — ${b.callsPerDay == null ? 'calls unchanged' : b.callsPerDay + '/day'}, ${b.minutesPerDay == null ? 'minutes unchanged' : b.minutesPerDay + ' min/day'}${b.bulk ? ', bulk on' : ''}${b.until ? ', until ' + b.until.slice(0, 10) : ', no expiry'}${b.reason ? ' — ' + b.reason : ''}`));
  }
  if (r.quiet.length) {
    L.push('');
    L.push(`NO ACTIVITY: ${r.quiet.map(c => c.name).join(', ')}`);
  }
  L.push('');
  L.push('Recordings and transcripts are not attached. Open the console and use Call History for any company above.');
  return L.join('\n');
}

function subjectFor(r) {
  const t = r.totals;
  const head = t.calls
    ? `${t.calls} call${t.calls === 1 ? '' : 's'} · ${t.activeCompanies} partner${t.activeCompanies === 1 ? '' : 's'} · ${hms(t.talkSeconds)}`
    : 'no calls placed';
  return `OmniReach daily · ${r.dateKey} · ${head}`;
}

module.exports = {
  DEFAULTS, withDefaults, buildReport, renderHtml, renderText, subjectFor,
  countryOf, dayWindow, previousDateKey, currentDateKey, hms, prettyDate,
  _internals: { DIAL_CODES, topOf, titleise }
};

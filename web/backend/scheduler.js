/**
 * OmniReach — schedule timing engine (pure; no I/O, no telephony).
 *
 * Answers one question per tick: "is this schedule due right now, and if not, when next?"
 *
 * Two decisions worth knowing about:
 *  1. TIMEZONES ARE REAL. A 9am call means 9am where the CUSTOMER is, and calling someone at 3am
 *     is both a terrible demo and, in most of our markets, a compliance breach. Every comparison is
 *     done in the schedule's own timezone using Intl, which handles DST for us.
 *  2. WE FIRE ON A SLOT, NOT A TIMESTAMP. Each occurrence gets a slot key (e.g. "2026-08-05"); once
 *     a slot has run it can never run again. That makes double-firing impossible even if the tick
 *     runs twice, the process restarts mid-run, or the clock jumps — which is exactly the kind of
 *     bug that would otherwise call a customer twice.
 */

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Wall-clock parts in a given IANA timezone. Falls back to the host clock for a bad zone. */
function zoneParts(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    });
    const p = {};
    fmt.formatToParts(date).forEach(x => { p[x.type] = x.value; });
    const dowIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +(p.hour === '24' ? '00' : p.hour), minute: +p.minute,
      dow: dowIdx < 0 ? date.getUTCDay() : dowIdx,
      dateKey: `${p.year}-${p.month}-${p.day}`,
      minutes: +(p.hour === '24' ? '00' : p.hour) * 60 + (+p.minute)
    };
  } catch (e) {
    const d = date;
    const pad = n => String(n).padStart(2, '0');
    return {
      year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
      hour: d.getHours(), minute: d.getMinutes(), dow: d.getDay(),
      dateKey: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      minutes: d.getHours() * 60 + d.getMinutes()
    };
  }
}

function parseHHMM(s, dflt) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return dflt;
  const h = Math.min(23, Math.max(0, +m[1])), mi = Math.min(59, Math.max(0, +m[2]));
  return h * 60 + mi;
}
function hhmm(mins) { return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; }

/** Does this schedule's recurrence pattern include the given local day? */
function dayMatches(when, parts) {
  const mode = when.mode || 'once';
  if (mode === 'daily') return true;
  if (mode === 'weekdays') return parts.dow >= 1 && parts.dow <= 5;
  if (mode === 'weekly') {
    const days = (when.days || []).map(d => (typeof d === 'string' ? DOW.indexOf(d.toLowerCase()) : d));
    return days.includes(parts.dow);
  }
  if (mode === 'monthly') {
    const dom = +(when.dayOfMonth || 1);
    // Clamp so "31st" still fires in a 30-day month rather than silently skipping it.
    const last = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
    return parts.day === Math.min(dom, last);
  }
  if (mode === 'once') return when.date === parts.dateKey;
  return false;
}

/**
 * Is the schedule due, and why/why not?
 * Returns { due, reason, slotKey, localTime, withinWindow }.
 * `graceMinutes` lets a schedule still fire if the server was briefly down over its minute.
 */
function evaluate(schedule, now = new Date(), graceMinutes = 10) {
  const when = schedule.when || {};
  const tz = when.timezone || 'UTC';
  const parts = zoneParts(now, tz);
  const target = parseHHMM(when.at, 9 * 60);
  const slotKey = (when.mode === 'once') ? `once:${when.date || parts.dateKey}` : `${schedule.id}:${parts.dateKey}`;
  const out = { slotKey, localTime: hhmm(parts.minutes), localDate: parts.dateKey, timezone: tz, due: false, reason: '', withinWindow: true };

  if (schedule.enabled === false) { out.reason = 'paused'; return out; }
  if (schedule.status === 'completed') { out.reason = 'already completed'; return out; }
  if ((schedule.ranSlots || []).includes(slotKey)) { out.reason = 'already ran in this slot'; return out; }
  if (!dayMatches(when, parts)) { out.reason = 'not scheduled for today'; return out; }

  // A "once" schedule whose moment has long passed should not fire days later.
  if (when.mode === 'once' && when.date && when.date < parts.dateKey) { out.reason = 'missed (date passed)'; return out; }

  const delta = parts.minutes - target;
  if (delta < 0) { out.reason = `waiting until ${hhmm(target)} ${tz}`; return out; }
  if (delta > graceMinutes) { out.reason = `missed today's ${hhmm(target)} slot`; return out; }

  // Calling-window guard: never place a call outside the permitted local hours.
  const w = schedule.window || {};
  if (w.respect !== false) {
    const start = parseHHMM(w.start, 9 * 60), end = parseHHMM(w.end, 20 * 60);
    if (parts.minutes < start || parts.minutes >= end) {
      out.withinWindow = false;
      out.reason = `outside the calling window (${hhmm(start)}–${hhmm(end)} ${tz})`;
      return out;
    }
  }
  out.due = true; out.reason = 'due now';
  return out;
}

/** Next time this schedule will fire, as an ISO string (or null if it never will again). */
function nextRunAt(schedule, from = new Date()) {
  const when = schedule.when || {};
  if (schedule.enabled === false || schedule.status === 'completed') return null;
  const tz = when.timezone || 'UTC';
  const target = parseHHMM(when.at, 9 * 60);
  // Walk forward day by day (cheap, and immune to DST arithmetic mistakes).
  for (let i = 0; i <= 400; i++) {
    const probe = new Date(from.getTime() + i * 86400000);
    const parts = zoneParts(probe, tz);
    if (!dayMatches(when, parts)) continue;
    if (when.mode === 'once' && when.date && when.date < parts.dateKey) return null;
    const slotKey = (when.mode === 'once') ? `once:${when.date || parts.dateKey}` : `${schedule.id}:${parts.dateKey}`;
    if ((schedule.ranSlots || []).includes(slotKey)) continue;
    if (i === 0 && parts.minutes > target + 10) continue;   // today's slot already gone
    // Build the wall-clock moment. Approximate to the minute, which is all the UI needs.
    const offsetMs = (target - parts.minutes) * 60000;
    return new Date(probe.getTime() + offsetMs).toISOString();
  }
  return null;
}

function describe(schedule) {
  const w = schedule.when || {};
  const at = w.at || '09:00', tz = w.timezone || 'UTC';
  switch (w.mode) {
    case 'daily': return `Every day at ${at} (${tz})`;
    case 'weekdays': return `Weekdays at ${at} (${tz})`;
    case 'weekly': return `Every ${(w.days || []).map(d => (typeof d === 'number' ? DOW[d] : d)).map(s => s[0].toUpperCase() + s.slice(1, 3)).join(', ') || '—'} at ${at} (${tz})`;
    case 'monthly': return `Day ${w.dayOfMonth || 1} of each month at ${at} (${tz})`;
    default: return `Once on ${w.date || '—'} at ${at} (${tz})`;
  }
}

module.exports = { evaluate, nextRunAt, describe, zoneParts, parseHHMM, hhmm, DOW };

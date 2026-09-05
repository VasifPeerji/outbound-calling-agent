/**
 * OmniReach — data connectors (sources in, write-back out).
 *
 * SOURCES  pull customer rows from anywhere → a common array-of-objects shape (then analysed).
 * SINKS    push post-call outcomes back to anywhere (CRM/DB/sheet/webhook).
 * Same plug-and-play pattern as the voice providers: one interface, many adapters.
 * Fully-working adapters run locally; CRM/DB adapters are interface-ready (add credentials).
 */
const fetch = require('node-fetch');
const { parse } = require('csv-parse/sync');

// ── helpers ──
/**
 * Read a delimited file the way it was actually written, not the way we would have written it.
 *
 * Excel on a machine whose locale uses the comma as a decimal separator writes CSV with semicolons,
 * which is most of Europe and Latin America; exports out of reporting tools are often tab
 * separated; and a report saved from a dashboard frequently carries its own title on line one. Each
 * of those parsed as a single column or took the title as the header, and the partner saw a file
 * they consider perfectly ordinary come back with nothing in it.
 */
function sniffDelimiter(firstLines) {
  const counts = [',', ';', '\t', '|'].map(d => {
    // Count only separators OUTSIDE quotes, or a quoted "Smith, John" votes for the comma.
    const per = firstLines.map(line => {
      let n = 0, inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === d && !inQ) n++;
      }
      return n;
    });
    // A real delimiter appears the SAME number of times on every line. Consistency beats frequency:
    // prose in one cell can out-count the true separator on a single row.
    const consistent = per.length > 1 && per.every(x => x === per[0]) && per[0] > 0;
    return { d, min: Math.min(...per), consistent };
  });
  const best = counts.filter(c => c.min > 0).sort((a, b) => (Number(b.consistent) - Number(a.consistent)) || (b.min - a.min))[0];
  return best ? best.d : ',';
}

/**
 * Skip anything above the real header row. A header row is the first line whose cells are mostly
 * non-empty and mostly not numbers: a title line has one cell and a run of empties, and a data row
 * that slipped to the top has figures in it.
 */
function findHeaderLine(lines, delimiter) {
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const cells = lines[i].split(delimiter).map(c => c.replace(/^"|"$/g, '').trim());
    const filled = cells.filter(Boolean);
    if (filled.length < 2) continue;                                   // a title, or a stray note
    if (filled.length / cells.length < 0.6) continue;                  // mostly empty padding cells
    if (filled.filter(c => /^[\d.,%+-]+$/.test(c)).length > filled.length / 2) continue;   // data
    return i;
  }
  return 0;
}

function parseCsv(text) {
  let body = String(text || '').replace(/^\uFEFF/, '');
  if (!body.trim()) return [];
  const lines = body.split(/\r?\n/).filter(l => l.trim() !== '');
  const delimiter = sniffDelimiter(lines.slice(0, 5));
  const start = findHeaderLine(lines, delimiter);
  if (start > 0) body = lines.slice(start).join('\n');
  return parse(body, {
    columns: true, skip_empty_lines: true, trim: true, delimiter,
    relax_column_count: true,      // a stray trailing separator must not abort the whole upload
    relax_quotes: true,            // nor an unescaped quote inside a free-text note
    bom: true
  });
}
function flattenRow(o) { const out = {}; for (const [k, v] of Object.entries(o || {})) out[k] = (v && typeof v === 'object') ? JSON.stringify(v) : v; return out; }
function parseHeaders(h) { if (!h) return {}; if (typeof h === 'object') return h; try { return JSON.parse(h); } catch (e) { return {}; } }
function pickArray(j, path) {
  let arr = j;
  if (path) path.split('.').forEach(p => { arr = arr ? arr[p] : arr; });
  if (!Array.isArray(arr)) { arr = j.data || j.records || j.results || j.rows || j.items; }
  if (!Array.isArray(arr)) throw new Error('JSON source did not contain an array — set config.path to the array field.');
  return arr.map(flattenRow);
}

// ── SOURCES: fetch(config) → [rowObject, ...] ──
const sources = {
  csv: { label: 'CSV upload / paste', live: true, fields: [{ key: 'text', label: 'CSV text', type: 'textarea' }], async fetch(c) { return parseCsv(c.text); } },
  url: {
    label: 'URL (CSV or JSON)', live: true, fields: [{ key: 'url', label: 'File URL' }, { key: 'format', label: 'Format (auto/csv/json)' }, { key: 'path', label: 'JSON array path (optional)' }],
    async fetch(c) {
      if (!c.url) throw new Error('A URL is required.');
      const r = await fetch(c.url, { headers: parseHeaders(c.headers) });
      if (!r.ok) throw new Error(`Source fetch failed (${r.status}).`);
      const body = await r.text();
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const looksJson = body.trim().startsWith('[') || body.trim().startsWith('{');
      const fmt = (c.format && c.format !== 'auto') ? c.format : ((ct.includes('json') || looksJson) ? 'json' : 'csv');
      return fmt === 'json' ? pickArray(JSON.parse(body), c.path) : parseCsv(body);
    }
  },
  rest: {
    label: 'REST API (JSON)', live: true, fields: [{ key: 'url', label: 'API endpoint' }, { key: 'headers', label: 'Headers JSON (e.g. auth)' }, { key: 'path', label: 'JSON array path (optional)' }],
    async fetch(c) {
      if (!c.url) throw new Error('An API endpoint is required.');
      const r = await fetch(c.url, { headers: parseHeaders(c.headers) });
      if (!r.ok) throw new Error(`REST fetch failed (${r.status}).`);
      return pickArray(await r.json(), c.path);
    }
  },
  sheet: { label: 'Google Sheet (published CSV)', live: true, fields: [{ key: 'url', label: 'Published CSV URL' }], async fetch(c) { if (!c.url) throw new Error('A published-CSV URL is required.'); const r = await fetch(c.url); if (!r.ok) throw new Error(`Sheet fetch failed (${r.status}).`); return parseCsv(await r.text()); } },
  postgres: sourceStub('PostgreSQL / MySQL', 'Add a driver (pg / mysql2), run config.query, and alias columns to customer_name, to_number, due_date, etc.'),
  salesforce: sourceStub('Salesforce', 'Run a SOQL query via the REST API with an OAuth token; map SObject fields to the row schema.'),
  hubspot: sourceStub('HubSpot', 'GET /crm/v3/objects/contacts with a private-app token; map properties to the row schema.'),
  zoho: sourceStub('Zoho CRM', 'Use the Zoho CRM records API with an OAuth token; map fields to the row schema.')
};
function sourceStub(label, how) { return { label, live: false, fields: [], async fetch() { throw new Error(`${label} source is interface-ready but needs credentials. ${how}`); } }; }

// ── SINKS: push(rows, config) → { ok, detail, data? } ──
const echoStore = [];
const sinks = {
  echo: { label: 'Preview in-app (no external write)', live: true, fields: [], async push(rows, c) { const owner = (c && c._ownerId) || null; rows.forEach(r => echoStore.unshift({ at: new Date().toISOString(), row: r, ownerId: owner })); if (echoStore.length > 400) echoStore.length = 400; return { ok: true, detail: `${rows.length} row(s) captured for preview` }; } },
  webhook: {
    label: 'Webhook (POST JSON)', live: true, fields: [{ key: 'url', label: 'POST URL' }, { key: 'headers', label: 'Headers JSON (optional)' }],
    async push(rows, c) { if (!c.url) throw new Error('A POST URL is required.'); const r = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...parseHeaders(c.headers) }, body: JSON.stringify({ updates: rows }) }); if (!r.ok) throw new Error(`Webhook sink failed (${r.status}).`); return { ok: true, detail: `${rows.length} row(s) posted` }; }
  },
  csv: { label: 'Enriched CSV (download)', live: true, fields: [], async push(rows) { return { ok: true, detail: `${rows.length} row(s) ready to download`, data: toCsv(rows) }; } },
  salesforce: sinkStub('Salesforce', 'PATCH sObject rows by Id / External Id with the mapped fields.'),
  hubspot: sinkStub('HubSpot', 'PATCH /crm/v3/objects/contacts/{id} with the mapped properties.'),
  zoho: sinkStub('Zoho CRM', 'PUT records with the mapped fields.'),
  postgres: sinkStub('PostgreSQL / MySQL', 'UPDATE rows by key column with the mapped values.')
};
function sinkStub(label, how) { return { label, live: false, fields: [], async push() { throw new Error(`${label} write-back is interface-ready but needs credentials. ${how}`); } }; }
function toCsv(rows) { if (!rows.length) return ''; const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]; const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'); }
// ownerId null/undefined = admin (see all); otherwise only this user's own pushed rows.
function getEchoLog(ownerId) { const list = ownerId ? echoStore.filter(e => e.ownerId === ownerId) : echoStore; return list.slice(0, 100); }
function clearEchoLog() { echoStore.length = 0; }

// ── FIELD MAPPING: a completed call (history entry) → a source-row update ──
//
// The rule here is that a row should be able to stand in for the call. Whatever the agent captured
// -- a promise, a dispute, a transfer, a corrected phone number, which documents are still owed --
// belongs in the system of record, because a CRM that only ever hears about payments is why people
// end up listening to recordings.

/**
 * A few things worth writing back are not stored on the entry in a shape a column can take: the
 * duration is in milliseconds, the contact updates and follow-ups are arrays, and "what happens
 * next" is spread across whichever outcome happened to fire. Compute them once, then the mapping
 * below stays a plain list of paths that a partner can edit.
 */
function entryView(entry) {
  const e = entry || {};
  const contactUpdates = (e.contactUpdates || []).map(u => `${u.field || ''}: ${u.value || ''}`.trim()).filter(x => x !== ':').join('; ');
  const followups = (e.followups || []).map(f => `${f.content || 'message'} via ${f.channel || ''}`.trim()).join('; ');
  return {
    ...e,
    _d: {
      duration_seconds: e.durationMs ? String(Math.round(e.durationMs / 1000)) : '',
      contact_updates: contactUpdates,
      followups_sent: followups,
      next_step: nextStep(e),
      connected: e.callSuccessful === true ? 'yes' : (e.callSuccessful === false ? 'no' : ''),
      simulated: e.simulated ? 'yes' : ''
    }
  };
}

/**
 * One column that always says what happens next, in the order a person would care about it.
 *
 * Every other column answers "what did the agent capture"; this answers "so what do I do now",
 * which is the question anyone opening the CRM record is actually asking.
 */
/**
 * "by Friday" but "on the 20th" -- a customer's own words often already carry the preposition, and
 * prefixing another produces "by on the 20th". Leave theirs alone when they supplied one.
 */
function whenPhrase(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  return /^(by|on|before|after|this|next|tomorrow|today|tonight|within|in|around|end of|first thing)\b/i.test(v) ? v : 'by ' + v;
}
function nextStep(e) {
  const a = e.appointment || {}, p = e.promiseToPay || {}, d = e.documents || {}, o = e.offer || {}, sv = e.service || {};
  if (e.dnc) return 'Do not call again';
  if (p.date) return `Pay ${p.amount ? p.amount + ' ' : ''}${whenPhrase(p.date)}`.replace(/\s+/g, ' ').trim();
  if (a.status === 'cancelled') return 'Appointment cancelled';
  if (a.date) return `${a.status === 'rescheduled' ? 'Rescheduled' : 'Booked'} for ${a.date}${a.time ? ' at ' + a.time : ''}`;
  if (d.promised_by) return `Documents ${whenPhrase(d.promised_by)}`;
  if (d.blocker) return `Blocked: ${d.blocker}`;
  if ((e.callback || {}).time) return `Call back ${e.callback.time}`;
  if (e.transferred) return `Transferred to ${e.transferred.department || 'a colleague'}`;
  if (o.decision) return `Offer ${o.decision}`;
  if ((e.renewal || {}).decision) return `Renewal ${e.renewal.decision}`;
  if (sv.follow_up_needed && /^(y|true|1)/i.test(String(sv.follow_up_needed))) return 'Service follow-up needed';
  if (e.dispute) return 'Dispute logged for review';
  if ((e.lead || {}).qualified) return `Lead ${e.lead.qualified}`;
  const x = e.extracted || {};
  if (x.commitment_date) return `Committed: ${x.commitment_date}`;
  return '';
}

// Columns written on every row even when empty, so the file or table has a stable spine.
const CORE_COLUMNS = ['customer_name', 'to_number', 'use_case', 'call_status', 'call_summary',
  'call_sentiment', 'next_step', 'last_called_at', 'call_id'];

const DEFAULT_MAPPING = {
  key: 'to_number',
  fields: {
    // ── the shape of the call itself ──
    call_status: 'disposition', call_summary: 'outcomeSummary', call_sentiment: 'userSentiment',
    next_step: '_d.next_step', last_called_at: 'timestamp', call_id: 'callId',
    call_duration_seconds: '_d.duration_seconds', call_connected: '_d.connected',
    call_simulated: '_d.simulated', goals_met: 'goalsMet',

    // ── outcomes any call can produce ──
    callback_time: 'callback.time', callback_reason: 'callback.reason',
    do_not_call: 'dnc', do_not_call_reason: 'dncReason', do_not_call_scope: 'dncScope',
    transferred_to: 'transferred.department', transfer_reason: 'transferred.reason',
    contact_updates: '_d.contact_updates', followups_sent: '_d.followups_sent',

    // ── money ──
    promise_amount: 'promiseToPay.amount', promise_date: 'promiseToPay.date', promise_method: 'promiseToPay.method',
    dispute_about: 'dispute.about', dispute_details: 'dispute.details',

    // ── appointments ──
    appointment_status: 'appointment.status', appointment_date: 'appointment.date',
    appointment_time: 'appointment.time', appointment_type: 'appointment.type', appointment_location: 'appointment.location',

    // ── feedback ──
    survey_score: 'survey.score', survey_scale: 'survey.scale',
    survey_comment: 'survey.verbatim', would_recommend: 'survey.would_recommend',

    // ── leads and offers ──
    lead_qualified: 'lead.qualified', lead_interest: 'lead.interest',
    lead_budget: 'lead.budget', lead_timeline: 'lead.timeline', lead_notes: 'lead.notes',
    offer_decision: 'offer.decision', offer_reason: 'offer.reason', offer_reference: 'offer.reference',

    // ── renewals ──
    renewal_decision: 'renewal.decision', renewal_reason: 'renewal.reason', renewal_offer_accepted: 'renewal.offer_accepted',

    // ── service notifications ──
    service_acknowledged: 'service.acknowledged', service_option_chosen: 'service.option_chosen',
    service_follow_up_needed: 'service.follow_up_needed', service_reference: 'service.reference',

    // ── documents ──
    documents_outstanding: 'documents.outstanding', documents_promised_by: 'documents.promised_by',
    documents_channel: 'documents.channel', documents_blocker: 'documents.blocker',

    // ── what the post-call analysis extracted, on every call, whether or not a tool fired ──
    analysis_outcome: 'extracted.call_outcome', analysis_sentiment: 'extracted.customer_sentiment',
    analysis_commitment_date: 'extracted.commitment_date', analysis_commitment_amount: 'extracted.commitment_amount',
    analysis_objection: 'extracted.objection', analysis_do_not_call: 'extracted.do_not_call',
    language_used: 'extracted.language_used'
  }
};

function dig(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function cell(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : '';
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object') ? Object.values(x).filter(Boolean).join(' ') : String(x)).join('; ');
  if (typeof v === 'object') return Object.values(v).filter(Boolean).join(' ');
  return v;
}

/**
 * Build the row for one finished call.
 *
 * Core columns are always present so the file has a stable spine; everything else appears only when
 * the call actually produced it, which keeps a documents call about documents rather than burying
 * it under forty empty payment columns. A custom mapping is honoured exactly as written -- if a
 * partner asked for a column, they get it whether or not it has a value.
 */
function buildWritebackRow(entry, mapping) {
  const custom = !!mapping;
  mapping = mapping || DEFAULT_MAPPING;
  const view = entryView(entry);
  const row = {
    customer_name: (entry && entry.customerName) || '',
    to_number: (entry && entry.toNumber) || '',
    use_case: (entry && entry.useCase) || ''
  };
  for (const [col, path] of Object.entries(mapping.fields || {})) {
    const v = cell(dig(view, path));
    if (v !== '' || custom || CORE_COLUMNS.includes(col)) row[col] = v;
  }
  return row;
}

function meta(map) { const out = {}; for (const [k, v] of Object.entries(map)) out[k] = { label: v.label, live: v.live, fields: v.fields || [] }; return out; }

module.exports = {
  parseCsv, sources, sinks, getEchoLog, clearEchoLog, DEFAULT_MAPPING, buildWritebackRow, SOURCE_META: meta(sources), SINK_META: meta(sinks) };

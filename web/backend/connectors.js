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
function parseCsv(text) { return parse(text || '', { columns: true, skip_empty_lines: true, trim: true }); }
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
const DEFAULT_MAPPING = {
  key: 'to_number',
  fields: {
    call_status: 'disposition', call_summary: 'outcomeSummary', call_sentiment: 'userSentiment',
    promise_amount: 'promiseToPay.amount', promise_date: 'promiseToPay.date',
    callback_time: 'callback.time', do_not_call: 'dnc',
    appointment_status: 'appointment.status', appointment_date: 'appointment.date',
    survey_score: 'survey.score', lead_qualified: 'lead.qualified', renewal_decision: 'renewal.decision',
    last_called_at: 'timestamp', call_id: 'callId'
  }
};
function dig(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function buildWritebackRow(entry, mapping) {
  mapping = mapping || DEFAULT_MAPPING;
  const row = { customer_name: entry.customerName || '', to_number: entry.toNumber || '', use_case: entry.useCase || '' };
  for (const [col, path] of Object.entries(mapping.fields || {})) { const v = dig(entry, path); row[col] = (v == null) ? '' : (typeof v === 'boolean' ? (v ? 'yes' : '') : v); }
  return row;
}
function meta(map) { const out = {}; for (const [k, v] of Object.entries(map)) out[k] = { label: v.label, live: v.live, fields: v.fields || [] }; return out; }

module.exports = { sources, sinks, getEchoLog, clearEchoLog, DEFAULT_MAPPING, buildWritebackRow, SOURCE_META: meta(sources), SINK_META: meta(sinks) };

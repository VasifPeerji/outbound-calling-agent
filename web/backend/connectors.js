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

module.exports = {
  parseCsv, sources, sinks, getEchoLog, clearEchoLog, DEFAULT_MAPPING, buildWritebackRow, SOURCE_META: meta(sources), SINK_META: meta(sinks) };

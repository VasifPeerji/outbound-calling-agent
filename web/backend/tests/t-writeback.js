/**
 * EVERY USE CASE RECORDS ITS OWN OUTCOME, AND ALL OF IT REACHES THE SYSTEM OF RECORD.
 *
 * Vasif: "only a limited amount of use cases can use the write back properly... I want each and
 * every use case to perfectly write back everything so that we can perfectly record the outcome."
 *
 * Measured before changing anything. Across the nine archetypes the row pushed to the CRM was
 * dropping `transferred`, `contactUpdates`, `followups`, `dncReason`/`dncScope` on ALL NINE, and
 * `dispute` on the three that can raise one -- so a customer saying "I already paid on the 3rd", or
 * asking to be put through to a person, or giving a corrected phone number, left no trace at all.
 * Every one of the seven fields the post-call analysis extracts was likewise going nowhere.
 *
 * And two archetypes had no tool of their own: service_notification and document_collection, which
 * between them carry 46 of the 198 catalogue use cases. The actual point of those calls -- did they
 * understand the disruption and what did they choose, which documents are still owed and when --
 * could not be recorded at all.
 *
 * The three structural checks at the end are the ones that matter most, because they cannot drift:
 * every tool must be handled in code, named in the prompt that is allowed to call it, and reachable
 * by a write-back column.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../..');
const CONN = require('../connectors.js');
const { simulateCall } = require('../simulator.js');
const TOOLS = require(path.join(SRC, 'config/agent_tools.json')).tools;
const CATALOG = require(path.join(SRC, 'config/catalog/use-cases.json'));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };

const ARCHETYPES = ['payment_reminder', 'overdue_followup', 'sales_offer', 'appointment_reminder',
  'feedback_survey', 'lead_qualification', 'renewal_retention', 'service_notification', 'document_collection'];

// The outcome object each archetype exists to produce. A call of this kind that records none of
// these told the system of record nothing about why it was made.
const OWN_OUTCOME = {
  payment_reminder: ['promiseToPay', 'callback', 'dispute', 'dnc'],
  overdue_followup: ['promiseToPay', 'dispute', 'transferred', 'callback'],
  sales_offer: ['offer', 'lead', 'callback', 'dnc'],
  appointment_reminder: ['appointment', 'callback'],
  feedback_survey: ['survey'],
  lead_qualification: ['lead', 'appointment', 'callback'],
  renewal_retention: ['renewal'],
  service_notification: ['service'],
  document_collection: ['documents']
};

function profileFor(industry) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, archetype: u.archetype, playbook: u.playbook || '', fields: u.fields || [], trigger: u.trigger };
  return { company: { name: 'Test ' + industry, industry }, locale: {}, agent: {}, contact: {}, compliance: {}, offerings: {}, use_cases };
}
// An industry that has a use case for every archetype, so one profile can exercise all nine.
function useCaseFor(arch) {
  for (const industry of Object.keys(CATALOG).filter(k => !k.startsWith('_'))) {
    const u = (CATALOG[industry] || []).find(x => x.archetype === arch);
    if (u) return { industry, key: u.key };
  }
  return null;
}
const VARS = {
  customer_name: 'Test Person', product_name: 'home loan', amount_due: '48500', due_date: 'the 11th',
  amount_overdue: '12500', days_overdue: '23', offer_type: 'a fibre upgrade', offer_detail: 'double the speed',
  appointment_type: 'scan', appointment_date: 'Tuesday', appointment_time: '10:30', location: 'the clinic',
  interaction_type: 'your recent visit', scale: '1 to 5', lead_source: 'the website', interest: 'a home loan',
  renewal_item: 'your policy', renewal_date: 'the 30th', event_type: 'a delivery exception',
  event_detail: 'customs hold', impact: 'a two-day delay', options: 'a new slot on Thursday',
  resolution_eta: 'Thursday', reference: 'REF-99120', process_name: 'your application',
  missing_items: 'proof of address and a payslip', deadline: 'Friday', submission_channel: 'the secure link'
};

// Run the same archetype several times: the simulator picks a branch at random, and every branch
// must record something, not just the happy one.
function runMany(arch, times) {
  const uc = useCaseFor(arch);
  const profile = profileFor(uc.industry);
  const out = [];
  for (let i = 0; i < times; i++) {
    const sim = simulateCall({ ...VARS, use_case: uc.key }, profile);
    const entry = { customerName: 'Test Person', toNumber: '+919820011001', useCase: uc.key, timestamp: new Date().toISOString(), callId: 'conv_' + i, durationMs: 132000, callSuccessful: sim.callSuccessful, disposition: sim.disposition, outcomeSummary: sim.outcomeSummary, userSentiment: sim.userSentiment };
    Object.assign(entry, sim.apply || {});
    out.push(entry);
  }
  return out;
}

// Nobody picked up, or it was the wrong person: there is no outcome to record and inventing one
// would be worse than leaving it blank.
const UNREACHED = ['no_answer_voicemail', 'wrong_person'];
// The disposition IS the whole answer here; there is no further structure to fill.
const SELF_DESCRIBING = ['already_paid', 'not_interested', 'resolved', 'refused'];
const reached = e => !UNREACHED.includes(e.disposition);

console.log('\nEVERY ARCHETYPE RECORDS THE OUTCOME IT EXISTS TO PRODUCE:');
for (const arch of ARCHETYPES) {
  const entries = runMany(arch, 40).filter(reached);
  const wanted = OWN_OUTCOME[arch];
  const bare = entries.filter(e =>
    !wanted.some(f => e[f] !== undefined && e[f] !== null && e[f] !== false) &&
    !SELF_DESCRIBING.includes(e.disposition));
  ok(bare.length === 0, `${arch}: all ${entries.length} answered calls recorded one of ${wanted.join('/')}` + (bare.length ? ` — ${bare.length} recorded NOTHING (dispositions: ${[...new Set(bare.map(b => b.disposition))].join(', ')})` : ''));
}
{
  // And the unreached ones still say so, rather than looking like a call that simply achieved nothing.
  const all = ARCHETYPES.flatMap(a => runMany(a, 8));
  const missed = all.filter(e => !reached(e));
  ok(missed.length > 0 && missed.every(e => CONN.buildWritebackRow(e).call_status === e.disposition),
    `a call nobody answered is written back as exactly that (${missed.length} of ${all.length} runs)`);
}

console.log('\n…and the two that had no tool of their own now do:');
{
  const svc = runMany('service_notification', 40).filter(reached);
  ok(svc.every(e => e.service && e.service.acknowledged), `every answered service-notification call records whether the customer understood it (${svc.length} runs)`);
  ok(svc.some(e => /^y/i.test(e.service.follow_up_needed || '')), 'and flags when somebody has to come back to them');
  ok(svc.some(e => e.service.option_chosen), 'and which option they took when options were offered');
  const doc = runMany('document_collection', 40).filter(reached);
  ok(doc.every(e => e.documents), `every answered documents call records where the paperwork stands (${doc.length} runs)`);
  ok(doc.some(e => e.documents.promised_by), 'including when the customer said they would send it');
  ok(doc.some(e => e.documents.blocker), 'and what is stopping them when something is');
  ok(doc.some(e => !e.documents.outstanding), 'and an empty outstanding list is how a chase that WORKED is recorded');
  const off = runMany('sales_offer', 40).filter(reached);
  const decided = off.filter(e => e.offer);
  ok(decided.length > 0 && decided.every(e => /accepted|declined|considering/.test(e.offer.decision)), `an offer call records the answer to the offer itself (${decided.length}/${off.length} reached a decision)`);
}

console.log('\nNOTHING CAPTURED IS DROPPED ON THE WAY TO THE SYSTEM OF RECORD:');
{
  // A call that produced a great deal at once: the write-back must carry all of it.
  const busy = {
    customerName: 'Fatima Al-Zahra', toNumber: '+971501230011', useCase: 'emi_overdue',
    timestamp: '2026-09-06T10:00:00Z', callId: 'conv_busy', durationMs: 240000, callSuccessful: true,
    disposition: 'promised_payment', outcomeSummary: 'Will pay Friday; disputes the late fee.', userSentiment: 'neutral',
    promiseToPay: { amount: '12500', date: 'Friday', method: 'upi' },
    dispute: { about: 'a late fee', details: 'says the payment cleared on the 3rd' },
    transferred: { department: 'collections', reason: 'wants a hardship plan' },
    contactUpdates: [{ field: 'phone', value: '+971501230099' }],
    followups: [{ channel: 'whatsapp', content: 'payment_link' }],
    callback: { time: 'Monday morning', reason: 'to confirm the plan' },
    dnc: false, goalsMet: '2/3',
    extracted: { call_outcome: 'promised_payment', customer_sentiment: 'neutral', commitment_date: 'Friday', commitment_amount: '12500', objection: 'the late fee', do_not_call: false, language_used: 'Arabic' }
  };
  const row = CONN.buildWritebackRow(busy);
  const must = {
    promise_amount: '12500', promise_date: 'Friday', promise_method: 'upi',
    dispute_about: 'a late fee', transferred_to: 'collections', transfer_reason: 'wants a hardship plan',
    contact_updates: 'phone: +971501230099', followups_sent: 'payment_link via whatsapp',
    callback_time: 'Monday morning', call_duration_seconds: '240', call_connected: 'yes',
    analysis_objection: 'the late fee', language_used: 'Arabic', analysis_commitment_amount: '12500'
  };
  const missing = Object.entries(must).filter(([k, v]) => row[k] !== v);
  ok(missing.length === 0, `all ${Object.keys(must).length} captured details reach the row` + (missing.length ? ' — wrong or missing: ' + missing.map(([k, v]) => `${k} (want ${JSON.stringify(v)}, got ${JSON.stringify(row[k])})`).join('; ') : ''));
  ok(row.next_step === 'Pay 12500 by Friday', 'and one column says plainly what happens next: ' + JSON.stringify(row.next_step));
}
{
  // The core spine is present even on a call where almost nothing happened.
  const thin = { customerName: 'No One', toNumber: '+911111111111', useCase: 'bill_due', timestamp: '2026-09-06T10:00:00Z', callId: 'c1', disposition: 'no_answer_voicemail' };
  const row = CONN.buildWritebackRow(thin);
  for (const c of ['customer_name', 'to_number', 'use_case', 'call_status', 'call_summary', 'call_sentiment', 'next_step', 'last_called_at', 'call_id']) {
    if (row[c] === undefined) { ok(false, `core column ${c} is missing from a sparse row`); break; }
  }
  ok(['customer_name', 'call_status', 'next_step', 'call_id'].every(c => row[c] !== undefined), 'a call where nothing happened still produces the full core spine');
  ok(Object.keys(row).length < 20, `and is not padded out with fifty empty columns (${Object.keys(row).length} columns)`);
}

console.log('\nEVERY ARCHETYPE PRODUCES A USABLE ROW, NOT JUST A NAME AND A NUMBER:');
for (const arch of ARCHETYPES) {
  const entries = runMany(arch, 12);
  const rows = entries.map(e => CONN.buildWritebackRow(e));
  const thin = rows.filter(r => Object.values(r).filter(v => v !== '' && v != null).length < 8);
  const avg = Math.round(rows.reduce((n, r) => n + Object.values(r).filter(v => v !== '' && v != null).length, 0) / rows.length);
  ok(thin.length === 0, `${arch}: every row carries at least 8 filled columns (average ${avg})`);
}

console.log('\nTHE NEXT-STEP COLUMN IS RIGHT, NOT MERELY PRESENT:');
// A ratio would be the wrong test. A satisfied customer who gave a score has no next step, and
// inventing one would put noise in the CRM. What must hold is that a call which DID produce a
// commitment always says so.
const COMMITMENTS = [
  ['promiseToPay', e => (e.promiseToPay || {}).date],
  ['appointment', e => (e.appointment || {}).date || (e.appointment || {}).status === 'cancelled'],
  ['documents', e => (e.documents || {}).promised_by || (e.documents || {}).blocker],
  ['callback', e => (e.callback || {}).time],
  ['renewal', e => (e.renewal || {}).decision],
  ['offer', e => (e.offer || {}).decision],
  ['transferred', e => !!e.transferred],
  ['dnc', e => e.dnc === true],
  // These three are next steps too: somebody has to look at a dispute, chase a qualified lead, and
  // come back to a customer whose service problem is not finished.
  ['dispute', e => !!e.dispute],
  ['lead', e => (e.lead || {}).qualified],
  ['service follow-up', e => /^y/i.test(((e.service || {}).follow_up_needed) || '')]
];
{
  const all = ARCHETYPES.flatMap(a => runMany(a, 20));
  const withCommitment = all.filter(e => COMMITMENTS.some(([, f]) => f(e)));
  const silent = withCommitment.filter(e => !CONN.buildWritebackRow(e).next_step);
  ok(withCommitment.length > 100 && silent.length === 0,
    `every one of the ${withCommitment.length} calls that produced a commitment states the next step` + (silent.length ? ` — ${silent.length} did not` : ''));

  const noCommitment = all.filter(e => !COMMITMENTS.some(([, f]) => f(e)) && !(e.extracted || {}).commitment_date);
  const invented = noCommitment.filter(e => CONN.buildWritebackRow(e).next_step);
  ok(invented.length === 0, `and none of the ${noCommitment.length} calls without one had a next step invented for it`);

  // Each kind of commitment must produce its own wording, not a generic placeholder.
  for (const [name, f] of COMMITMENTS) {
    const sample = all.filter(f)[0];
    if (!sample) continue;
    const step = CONN.buildWritebackRow(sample).next_step;
    ok(!!step && step.length > 3, `a ${name} outcome reads as: "${step}"`);
  }
}

console.log('\nSTRUCTURAL — these cannot drift as tools are added:');
{
  // 1. Every tool is handled in code. Read applyOutcome from the source so the check is against
  //    the implementation, not a copy of it that could fall out of date.
  const server = fs.readFileSync(path.join(SRC, 'web/backend/server.js'), 'utf8');
  const fn = server.slice(server.indexOf('function applyOutcome('), server.indexOf('// Push completed-call outcomes back'));
  const handled = [...fn.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
  const unhandled = TOOLS.map(t => t.name).filter(n => !handled.includes(n));
  ok(unhandled.length === 0, `all ${TOOLS.length} tools are handled in applyOutcome` + (unhandled.length ? ' — missing: ' + unhandled.join(', ') : ''));

  // 2. Every tool is named in the prompt of each archetype allowed to call it. A tool the prompt
  //    never mentions is a tool that never fires, which is how you ship a fix that changes nothing.
  const unnamed = [];
  for (const t of TOOLS) {
    for (const arch of (t.applies_to || []).filter(a => a !== 'all')) {
      const p = path.join(SRC, 'prompts', arch + '.txt');
      if (!fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes(t.name)) unnamed.push(`${t.name} in ${arch}`);
    }
  }
  ok(unnamed.length === 0, 'every archetype-specific tool is named in the prompt that may call it' + (unnamed.length ? ' — missing: ' + unnamed.join(', ') : ''));

  // 3. Every field a tool writes is reachable by a write-back column. This is the check that would
  //    have caught the original defect.
  const fields = new Set();
  for (const m of fn.matchAll(/entry\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) fields.add(m[1]);
  const paths = Object.values(CONN.DEFAULT_MAPPING.fields);
  const derived = { contactUpdates: 'contact_updates', followups: 'followups_sent' };
  const unreachable = [...fields].filter(f => {
    if (paths.some(p => p === f || p.startsWith(f + '.'))) return false;
    if (derived[f] && paths.includes('_d.' + derived[f])) return false;   // carried by a derived column
    return true;
  });
  ok(unreachable.length === 0, `every one of the ${fields.size} fields a tool can write reaches a column` + (unreachable.length ? ' — unreachable: ' + unreachable.join(', ') : ''));

  // 4. And the analysis fields, which fill on every call whether or not a tool fires.
  const analysis = ['call_outcome', 'customer_sentiment', 'commitment_date', 'commitment_amount', 'objection', 'do_not_call', 'language_used'];
  const missed = analysis.filter(f => !paths.includes('extracted.' + f));
  ok(missed.length === 0, 'all 7 post-call analysis fields reach a column' + (missed.length ? ' — missing: ' + missed.join(', ') : ''));
}

console.log('\nA CUSTOM MAPPING IS STILL HONOURED EXACTLY AS WRITTEN:');
{
  const custom = { key: 'to_number', fields: { Outcome: 'disposition', WhenPaid: 'promiseToPay.date', Nothing: 'survey.score' } };
  const row = CONN.buildWritebackRow({ customerName: 'A', toNumber: '+9111', useCase: 'x', disposition: 'promised_payment', promiseToPay: { date: 'Friday' } }, custom);
  ok(row.Outcome === 'promised_payment' && row.WhenPaid === 'Friday', 'the columns a partner asked for are filled');
  ok(row.Nothing === '', 'and a column they asked for is present even when empty, because they asked for it');
  ok(!('call_status' in row), 'while the default columns they did not ask for stay out of it');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

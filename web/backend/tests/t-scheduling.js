/**
 * AGREEING A TIME, MISSED MEETINGS, AND THE INDUSTRIES THAT DEPEND ON THEM.
 *
 * A reminder that has to move, a no-show that has to be rebooked and an enquiry that has to become
 * a meeting all end the same way: a day and a time. The rule is the same in every industry. Offer
 * the times we know we can do; if there are none, or none suit, take theirs down as a REQUEST and
 * say it will be checked. The failure this guards against is an agent telling a prospect "that's
 * booked" for a time nobody on our side has agreed to.
 *
 * Plain Node, no server: the catalogue, the router, the prompts, the tool definition, the outcome
 * mapping and the simulator are all checked directly.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../..');
const R = require('../router.js');
const CONN = require('../connectors.js');
const { simulateCall } = require('../simulator.js');
const CATALOG = require(path.join(SRC, 'config/catalog/use-cases.json'));
const INDUSTRIES_JSON = require(path.join(SRC, 'config/catalog/industries.json'));
const KNOWLEDGE = require(path.join(SRC, 'config/catalog/knowledge.json'));
const TOOLS = require(path.join(SRC, 'config/agent_tools.json')).tools;
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };

const NOW = new Date(2026, 8, 22, 10, 0, 0);
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const iso = n => { const x = new Date(NOW); x.setDate(x.getDate() + n); return isoLocal(x); };
const INDUSTRIES = Object.keys(CATALOG).filter(k => !k.startsWith('_'));

// Built exactly the way the console builds a profile from the catalogue.
function profileFor(industry) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, archetype: u.archetype, playbook: u.playbook || '', fields: u.fields || [], ...(u.trigger ? { trigger: u.trigger } : {}) };
  return { company: { name: 'Test ' + industry, industry }, locale: {}, agent: {}, contact: {}, use_cases };
}
const route = (rows, profile) => { const resolved = R.resolveColumns(rows); return rows.map(r => R.routeRow(r, resolved, profile, { now: NOW })); };
const one = (row, profile) => route([row], profile)[0];

// ═══════════════════════════════════════════════════════
console.log('\nTHE NEW INDUSTRIES ARE COMPLETE:');
const NEW = ['B2B Sales & Marketing', 'Property Management & Rentals', 'Heavy Equipment & Machinery', 'Facility Management', 'Wholesale & Distribution', 'Solar & Renewable Energy', 'Beauty & Personal Care'];
for (const ind of NEW) {
  const t = INDUSTRIES_JSON[ind] || {}, k = KNOWLEDGE[ind] || {}, u = CATALOG[ind] || [];
  ok(t.agent_name && t.agent_role && /\{company\}/.test(t.about || '') && (t.offerings || []).length >= 3 && u.length >= 7 && (k.facts || []).length >= 5 && (k.faqs || []).length >= 4,
    `${ind}: persona, offerings, ${u.length} use cases, knowledge`);
}
ok(Object.keys(INDUSTRIES_JSON).length === INDUSTRIES.length && INDUSTRIES.every(i => INDUSTRIES_JSON[i] && KNOWLEDGE[i]), 'every industry in the use-case catalogue has a persona and knowledge, and nothing extra');

console.log('\nEVERY VARIABLE THE CATALOGUE DECLARES CAN ARRIVE FROM A FILE:');
// A variable the router does not know is silently dropped from every uploaded row.
const unknown = new Set();
for (const ind of INDUSTRIES) for (const u of CATALOG[ind]) for (const f of u.fields || []) if (!R.FIELD[f.var] && !Object.values(R.FIELD).some(d => d.aliases.includes(f.var))) unknown.add(`${ind}/${u.key}: ${f.var}`);
ok(unknown.size === 0, 'all declared variables are in the router vocabulary' + (unknown.size ? ': ' + [...unknown].join(', ') : ''));
const keysOk = INDUSTRIES.every(ind => new Set(CATALOG[ind].map(u => u.key)).size === CATALOG[ind].length);
ok(keysOk, 'no industry repeats a use-case key');
const dashes = INDUSTRIES.flatMap(ind => CATALOG[ind].filter(u => NEW.includes(ind) && /—/.test(u.playbook + u.desc)).map(u => u.key));
ok(dashes.length === 0, 'the new playbooks read like our own writing, with no em dashes');

// ═══════════════════════════════════════════════════════
console.log('\nA MISSED MEETING IS NOT A REMINDER:');
const missedUcs = INDUSTRIES.flatMap(ind => CATALOG[ind].filter(u => u.trigger === 'missed').map(u => ({ ind, u })));
ok(missedUcs.length >= 2, `${missedUcs.length} missed-appointment use cases in the catalogue`);
ok(missedUcs.every(({ u }) => u.archetype === 'appointment_reminder' && /MISSED/.test(u.playbook)), 'each is an appointment call whose brief says, in capitals, that it was missed (the prompt switches flow on that)');
ok(read('web/frontend/index.html').includes('...(u.trigger ? { trigger: u.trigger } : {})'), 'the console carries the trigger into the profile, where the router reads it');

const sm = profileFor('B2B Sales & Marketing');
const meeting = { contact_name: 'Amara Okafor', mobile: '+2348012345678', meeting: 'Solution walkthrough', meeting_time: '11:00', agenda: 'agree the pilot scope', available_slots: `${iso(3)} 10:00; ${iso(4)} 15:00` };
let r = one({ ...meeting, meeting_date: iso(2) }, sm);
ok(r.use_case === 'meeting_reminder', 'a meeting two days away is a reminder: ' + r.use_case);
r = one({ ...meeting, meeting_date: iso(-1) }, sm);
ok(r.use_case === 'meeting_no_show', 'the same meeting yesterday is a missed-meeting call: ' + r.use_case);
ok(/^\w+day, the \d+\w\w of \w+, 10:00; \w+day, the \d+\w\w of \w+, 15:00$/.test(r.variables.suggested_slots || ''), 'and the offered times are spoken like a diary, not as ISO strings: "' + r.variables.suggested_slots + '"');
ok(r.variables.agenda === 'agree the pilot scope', 'the agenda reaches the call');

const rows = [
  { ...meeting, meeting_date: iso(-3), attendance: 'No-show' },
  { ...meeting, meeting_date: iso(-3), attendance: 'Attended' },
];
const [noShow, attended] = route(rows, sm);
ok(noShow.use_case === 'meeting_no_show', 'an attendance column saying "No-show" is rebooked');
ok(attended.use_case !== 'meeting_no_show', 'one saying "Attended" is never told "we missed you": ' + attended.use_case);
ok(!attended.callable || R.archetypeOf(sm.use_cases[attended.use_case], attended.use_case) !== 'appointment_reminder', 'nor reminded about a meeting that has already happened');
const past = one({ patient_name: 'Aisha Rahman', mobile: '+447700900001', appt_date: iso(-4), appt_time: '09:30', department: 'Cardiology' }, profileFor('Banking'));
ok(!(past.callable && past.archetype === 'appointment_reminder'), 'and no industry reminds anyone about an appointment in the past: ' + past.use_case + (past.callable ? '' : ' (held)'));
const [flag] = route([{ ...meeting, meeting_date: iso(-3), no_show: 'TRUE' }], sm);
ok(flag.use_case === 'meeting_no_show', 'a no_show column holding TRUE means they did not come');
const [flag2] = route([{ ...meeting, meeting_date: iso(-3), no_show: 'FALSE' }], sm);
ok(flag2.use_case !== 'meeting_no_show', 'and FALSE means they did');
ok(!('attendance' in noShow.variables) && !('_attendanceHeader' in noShow.variables), 'attendance is evidence only, never read out');

const beauty = profileFor('Beauty & Personal Care');
r = one({ client: 'Li Wei', phone: '+85291234567', treatment: 'Facial', appointment_date: iso(-1), appointment_time: '15:00' }, beauty);
ok(r.use_case === 'missed_appointment', 'a salon booking that has passed becomes a missed appointment: ' + r.use_case);
r = one({ client: 'Li Wei', phone: '+85291234567', treatment: 'Facial', appointment_date: iso(1), appointment_time: '15:00' }, beauty);
ok(r.use_case === 'appointment_reminder', 'and tomorrow\'s is a reminder: ' + r.use_case);
const hc = profileFor('Healthcare');
r = one({ patient_name: 'Aisha Rahman', mobile: '+447700900001', appt_date: iso(-2), appt_time: '09:30', department: 'Cardiology', attendance: 'DNA' }, hc);
ok(R.archetypeOf(hc.use_cases[r.use_case], r.use_case) !== 'feedback_survey', 'an industry with no missed-appointment call never asks a no-show for feedback on a visit they did not make: ' + r.use_case);

// ═══════════════════════════════════════════════════════
console.log('\nSIBLING CALLS ARE TOLD APART BY THE ROW\'S OWN WORDS:');
const lead = (source, interest) => ({ contact_name: 'Daniel Mensah', mobile: '+233201234567', lead_source: source, interest });
const cases = [
  ['Webinar: AI in customer service', 'voice automation', 'event_followup'],
  ['Benchmark report download', 'response times', 'content_download_followup'],
  ['Book a demo form', 'the reporting dashboard', 'demo_request'],
  ['Proposal sent on the 3rd', '12 month support', 'proposal_followup'],
  ['Website contact form', 'automating support', 'inquiry_acknowledgement'],
];
for (const [src, int, want] of cases) { const x = one(lead(src, int), sm); ok(x.use_case === want, `"${src}" -> ${want}${x.use_case === want ? '' : ' (got ' + x.use_case + ')'}`); }
r = one({ ...lead('Website contact form', 'automating support'), inputs_needed: 'team size; current tools; target go-live' }, sm);
ok(r.variables.information_needed === 'team size, current tools, target go-live', 'the inputs we need are read from the file and spoken as a list: "' + r.variables.information_needed + '"');
const pm = profileFor('Property Management & Rentals');
r = one({ tenant_name: 'Sofia Martins', phone: '+351912345678', appointment_type: 'Routine inspection', appointment_date: iso(5), appointment_time: '10:00' }, pm);
ok(r.use_case === 'routine_inspection', 'a property inspection is not a viewing: ' + r.use_case);
const he = profileFor('Heavy Equipment & Machinery');
r = one({ customer: 'Tariq Al Mansoori', mobile: '+971501234567', machine: '20t excavator, fleet 14', appointment_type: '500 hour service', service_date: iso(6), site: 'North quarry' }, he);
ok(r.use_case === 'service_due_hours' && /excavator/.test(r.variables.equipment || ''), 'a machine service reaches the service call with the machine named: ' + r.use_case);

// ═══════════════════════════════════════════════════════
console.log('\nTHE PROMPTS SAY HOW TO AGREE A TIME:');
const g = read('prompts/global_prompt.txt'), ap = read('prompts/appointment_reminder.txt'), lq = read('prompts/lead_qualification.txt');
ok(/## SETTING A DATE AND TIME/.test(g) && /\{\{suggested_slots\}\}/.test(g), 'the global prompt has one scheduling rule for every industry, built on the suggested slots');
ok(/REQUEST, not a booking/.test(g) && /\*\*Never\*\* say it is\s+booked/.test(g), 'a time the customer proposes is a request, never called booked');
ok(/exact \*\*day and time\*\*/.test(g) && /Sometime next week/i.test(g), 'and "sometime next week" is followed up for a day and a time');
ok(/THE MISSED APPOINTMENT FLOW/.test(ap) && /never say no-show|No "you failed to attend", no "no-show"/i.test(ap), 'the appointment prompt has a missed flow that never blames');
ok(/\{\{agenda\}\}/.test(ap) && /\{\{suggested_slots\}\}/.test(ap), 'and knows the agenda and the times it may offer');
ok(/propose_appointment_slot/.test(ap) && /propose_appointment_slot/.test(lq), 'both appointment and enquiry calls can log a proposed time');
ok(/\{\{information_needed\}\}/.test(lq), 'an enquiry call asks for the inputs the team needs');

console.log('\nA PROPOSED TIME IS RECORDED AS ONE:');
const tool = TOOLS.find(t => t.name === 'propose_appointment_slot');
ok(tool && ['appointment_reminder', 'lead_qualification'].every(a => tool.applies_to.includes(a)) && tool.required.includes('proposed_date'), 'the tool exists for both kinds of call and needs a day');
ok(tool && /check/i.test(tool.say) && !/booked|confirmed/i.test(tool.say), 'and what it says out loud promises a check, not a booking: "' + (tool && tool.say) + '"');
const server = read('web/backend/server.js');
ok(/case 'propose_appointment_slot': entry\.appointment = \{ status: 'proposed'/.test(server), 'the server records it as a proposal on the call');
ok(/\|propose_appointment_slot\|/.test(server), 'and catches the agent saying the tool name out loud');
const entry = { appointment: { status: 'proposed', date: 'Thursday', time: 'half past three' } };
const row = CONN.buildWritebackRow({ id: 'x', customerName: 'A', toNumber: '+1', ...entry }, CONN.DEFAULT_MAPPING);
const cells = Object.values(row).map(String);
ok(cells.includes('Check and confirm their proposed time: Thursday at half past three'), 'the write-back tells the team what to do next, as the next step');
ok(cells.includes('proposed'), 'and the status reaches the system of record as proposed');

console.log('\nEVERY {{VARIABLE}} REACHES THE CALL, EVEN WHEN BLANK:');
const src = server.slice(server.indexOf('function fillReferencedVars'), server.indexOf('// Place one call using'));
const fillReferencedVars = new Function(src + '; return fillReferencedVars;')();
const vars = fillReferencedVars({ customer_name: 'Amara' }, 'Offer {{suggested_slots}} to {{customer_name}} about {{ agenda }}', 'Hello {{customer_name}}, {{system__time}}');
ok(vars.suggested_slots === '' && vars.agenda === '', 'a row with no slots or agenda sends them as blank, which the prompt speaks around');
ok(vars.customer_name === 'Amara' && !('system__time' in vars), 'without touching real values or the provider\'s own system variables');
ok(/fillReferencedVars\(dynamicVars, prompt, firstMessage\)/.test(server), 'and placeCall does this before every dial');

// ═══════════════════════════════════════════════════════
console.log('\nTHE DRY RUN BEHAVES THE SAME WAY:');
const smSim = { ...sm, agent: { name: 'Nadia' } };
let missedOk = true, proposedOk = true, sawProposal = false, sawSlot = false;
for (let i = 0; i < 200; i++) {
  const s = simulateCall({ use_case: 'meeting_no_show', customer_name: 'Amara Okafor', variables: { appointment_type: 'product demo', appointment_date: 'Tuesday', agenda: 'walk through pricing', suggested_slots: 'Thursday at 10; Friday at 2' } }, smSim);
  if (!/Voicemail|Reached someone else/.test(s.summary)) {
    if (!/missed you/.test(s.transcript) || /reminder about/.test(s.transcript) || !s.apply.appointment) missedOk = false;
  }
  const a = s.apply.appointment || {};
  if (a.status === 'proposed') { sawProposal = true; if (/booked/i.test(s.transcript.split('\n').pop())) proposedOk = false; if (!s.outcomesTimeline.some(t => t.tool === 'propose_appointment_slot')) proposedOk = false; }
  if (a.status === 'rescheduled' && /Thursday at 10|Friday at 2/.test(a.date)) sawSlot = true;
}
ok(missedOk, 'a missed-meeting call opens with "we missed you", never as a reminder, and always records an outcome');
ok(sawSlot, 'it offers the suggested times and books the one chosen');
ok(sawProposal && proposedOk, 'when none suit it takes their time as a proposal, logs it, and never calls it booked');

console.log('\nWHAT WE PUBLISH MATCHES THE CATALOGUE:');
const nUc = INDUSTRIES.reduce((n, i) => n + CATALOG[i].length, 0);
const manual = read('docs/USER-GUIDE.html'), guide = read('web/frontend/guide/index.html');
ok(new RegExp(`<b>${INDUSTRIES.length}</b><span>industries supported`).test(manual) && new RegExp(`<b>${nUc}</b><span>ready-made call types`).test(manual), `the manual states ${INDUSTRIES.length} industries and ${nUc} call types`);
ok(guide.includes(`<span>${INDUSTRIES.length} industries</span><span>${nUc} call types</span>`), 'and so does the quick guide');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

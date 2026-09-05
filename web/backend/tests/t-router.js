/**
 * THE RIGHT CALL, FROM THE PARTNER'S OWN DATA.
 *
 * Vasif's ask: whatever industry a prospect is in, whatever their export looks like, each row should
 * reach the right use case with the right values, and a gap in the data should be handled rather
 * than either faked or fatal.
 *
 * The engine this replaces read a fixed set of column names that were, in fact, the headers of our
 * own sample_crm.csv. It scored 0/10 on five realistic non-banking exports: every row lost its name
 * and phone number and fell through to a marketing call with empty variables.
 *
 * The centrepiece here is the round trip: for all 198 use cases in the catalogue, build the row that
 * use case says it needs, and check the router hands that use case back. It is the strongest
 * available statement that the thing is generic, because nothing in it is industry-specific.
 */
const path = require('path');
const R = require('../router.js');
const CATALOG = require('../../../config/catalog/use-cases.json');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };
const INDUSTRIES = Object.keys(CATALOG).filter(k => !k.startsWith('_'));

// Fixed "today" so a date six days out is always a date six days out.
const NOW = new Date('2026-09-06T10:00:00');
const iso = d => { const x = new Date(NOW); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

function profileFor(industry, opts) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, emoji: u.emoji, archetype: u.archetype, desc: u.desc, playbook: u.playbook, fields: u.fields || [] };
  return { company: { name: 'Test ' + industry, industry }, locale: (opts && opts.locale) || {}, contact: {}, use_cases };
}
const analyse = (rows, profile) => {
  const resolved = R.resolveColumns(rows);
  return { resolved, out: rows.map(r => R.routeRow(r, resolved, profile, { now: NOW })) };
};
const one = (row, profile) => analyse([row], profile).out[0];

// ═══════════════════════════════════════════════════════
console.log('\nTHE ROUND TRIP \u2014 every use case in the catalogue, asked for by its own declared data:');
// Values chosen by the field's TYPE and the call's meaning, never by its industry.
function valueFor(v, archetype) {
  const t = (R.FIELD[v] || {}).type || 'text';
  if (v === 'due_date') return archetype === 'overdue_followup' ? iso(-14) : iso(9);
  if (v === 'days_overdue') return '14';
  if (v === 'appointment_date') return iso(4);
  if (v === 'renewal_date') return iso(21);
  if (v === 'interaction_date') return iso(-3);
  if (v === 'deadline' || v === 'expiry_date') return iso(12);
  if (v === 'scale') return '1 to 5';
  if (v === 'pre_approved') return 'TRUE';
  switch (t) {
    case 'money': return '12500';
    case 'date': return iso(7);
    case 'time': return '10:30';
    case 'int': return '14';
    case 'list': return 'Proof of address; Photo ID';
    case 'id': return 'REF-99120';
    case 'bool': return 'TRUE';
    default: return v.replace(/_/g, ' ');
  }
}
function rowFor(uc) {
  const row = { customer_name: 'Test Person', to_number: '+911234567890' };
  for (const f of (uc.fields || [])) row[f.var] = valueFor(f.var, uc.archetype);
  return row;
}

let rt = { total: 0, exactKey: 0, sameArchetype: 0, callable: 0 };
const rtMisses = [];
for (const industry of INDUSTRIES) {
  const profile = profileFor(industry);
  for (const uc of CATALOG[industry]) {
    rt.total++;
    const r = one(rowFor(uc), profile);
    if (r.use_case === uc.key) rt.exactKey++;
    else rtMisses.push(`${industry}/${uc.key} -> ${r.use_case}`);
    if (r.archetype === uc.archetype) rt.sameArchetype++;
    if (r.callable) rt.callable++;
  }
}
console.log(`  ${rt.total} use cases across ${INDUSTRIES.length} industries`);
ok(rt.sameArchetype === rt.total, `every one came back as the right KIND of call (${rt.sameArchetype}/${rt.total})`);
ok(rt.callable === rt.total, `and every one was callable, with no missing essentials (${rt.callable}/${rt.total})`);
ok(rt.exactKey / rt.total >= 0.92, `${rt.exactKey}/${rt.total} came back as the exact same use case (${Math.round(rt.exactKey / rt.total * 100)}%)`);
if (rtMisses.length) console.log('       near-misses (same kind of call, sibling use case): ' + rtMisses.slice(0, 6).join(' | ') + (rtMisses.length > 6 ? ' \u2026' : ''));

// ═══════════════════════════════════════════════════════
console.log('\nA PARTNER\'S OWN HEADERS \u2014 nothing named the way we name things:');
{
  const hc = profileFor('Healthcare');
  const r = one({ patient_name: 'Aisha Rahman', mobile: '+447700900001', appt_date: iso(6), appt_time: '09:30', clinician: 'Dr Patel', department: 'Cardiology', prep_instructions: 'Nil by mouth from midnight' }, hc);
  ok(r.customer_name === 'Aisha Rahman', '`patient_name` was read as the customer name');
  ok(r.to_number === '+447700900001', '`mobile` was read as the phone number');
  ok(R.archetypeOf(hc.use_cases[r.use_case], r.use_case) === 'appointment_reminder', '`appt_date` reached an appointment call, not a marketing one');
  ok(r.variables.appointment_type === 'Cardiology', '`department` became the appointment type');
  ok(/12th|September/.test(r.variables.appointment_date || ''), 'the date is spoken, not an ISO string: "' + r.variables.appointment_date + '"');
  ok(r.callable === true, 'and the row is callable');
}
{
  const tel = profileFor('Telecom');
  const r = one({ subscriber_name: 'Chidi Okafor', msisdn: '+2348030000001', plan_name: 'Unlimited 5G', bill_amount: '14500', bill_due_date: iso(5) }, tel);
  ok(r.to_number === '+2348030000001', '`msisdn` was recognised as the phone number');
  ok(r.archetype === 'payment_reminder', '`bill_due_date` five days out is a reminder, not a collection');
  ok(r.variables.amount_due === '14,500', 'the amount is grouped for speech: ' + r.variables.amount_due);
}
{
  const log = profileFor('Logistics');
  const r = one({ consignee: 'Ravi Menon', contact_no: '+971500000002', shipment_ref: 'SHP-88124', exception_reason: 'Customs hold', eta: iso(4) }, log);
  ok(r.customer_name === 'Ravi Menon', '`consignee` was read as the customer name');
  ok(r.archetype === 'service_notification', 'an exception reason routes to a service notification');
  ok(r.variables.event_detail === 'Customs hold', 'and the reason is what the agent will actually say');
}

console.log('\n\u2026including a column whose NAME tells us nothing, recognised from its values:');
{
  const r = one({ full_name: 'Sofia Alvarez', crm_field_7: '+15551230001', order_date: iso(-3) }, profileFor('Retail'));
  ok(r.to_number === '+15551230001', '`crm_field_7` was recognised as the phone number from the data itself');
}
{
  // "Account Holder" shares the word "account" with a reference number, which was enough for a weak
  // name match to claim the column and lose every customer name in the file.
  const rows = [
    { 'Account Holder': 'Rohan Desai', 'Mobile No': '+919820011001', 'Product': 'Home loan' },
    { 'Account Holder': 'Priya Raghavan', 'Mobile No': '+919820011002', 'Product': 'Credit card' }
  ];
  const { resolved, out } = analyse(rows, profileFor('Banking'));
  ok(resolved.map.customer_name && resolved.map.customer_name.header === 'Account Holder', 'a column of people beats a shared word with a reference number');
  ok(out.every(r => r.customer_name), 'so every row keeps its name: ' + out.map(r => r.customer_name).join(', '));
}
console.log('\n…without mistaking a phrase for a person:');
{
  // The guard that rescues "Account Holder" must not fire on ordinary text, or it takes the product
  // and incident columns away from the fields whose headers correctly named them.
  const people = ['Rohan Desai', 'Fatima Al-Zahra', "James O'Connor", 'Chen Wei', 'ROHAN DESAI', 'Ana da Silva'];
  const notPeople = ['Home loan', 'Line fault in Sandton', 'Motor policy', 'Proof of address', 'between 10 and 12', 'Unlimited 5G'];
  ok(people.every(R.looksLikePersonName), 'names of every shape are recognised: ' + people.join(', '));
  ok(!notPeople.some(R.looksLikePersonName), 'and ordinary phrases are not: ' + notPeople.join(', '));
}
{
  // End to end: the same file must keep BOTH the names and the product and incident columns.
  const rows = [
    { 'Account Holder': 'Rohan Desai', 'Mobile No': '+919820011001', 'Product': 'Home loan', 'Bill Amount': '48500', 'Payment Due On': iso(5) },
    { 'Account Holder': 'Thandiwe Mokoena', 'Mobile No': '+27821230011', 'Product': 'Fibre', 'Issue Reported': 'Line fault in Sandton', 'Fix By': iso(1) }
  ];
  const { out } = analyse(rows, profileFor('Telecom'));
  ok(out.every(r => r.customer_name), 'both rows keep their names');
  const bill = out.find(r => r.customer_name === 'Rohan Desai');
  ok(bill.variables.product_name === 'Home loan', '"Home loan" stayed the product: ' + bill.variables.product_name);
  const fault = out.find(r => r.customer_name === 'Thandiwe Mokoena');
  ok(fault.archetype === 'service_notification', 'and the reported issue still reaches a service notification');
  ok(out.every(r => r.callable), 'both are callable');
}
{
  // The opposite guard: digits that are not a phone number must not be taken for one.
  const rows = [{ customer_name: 'A B', to_number: '+15551230001', invoice_no: '900012345' }, { customer_name: 'C D', to_number: '+15551230002', invoice_no: '900012346' }];
  const { resolved } = analyse(rows, profileFor('Retail'));
  ok(resolved.map.to_number.header === 'to_number', 'a nine-digit invoice number did not steal the phone slot');
}

// ═══════════════════════════════════════════════════════
console.log('\nTHE SAME FILE, TWO INDUSTRIES \u2014 the call follows the industry, the data does not change:');
{
  const row = { customer_name: 'Sam Lee', to_number: '+6591230001', amount_due: '4200', due_date: iso(6), product_name: 'account' };
  const a = one(row, profileFor('Banking')), b = one(row, profileFor('Utilities'));
  ok(a.archetype === 'payment_reminder' && b.archetype === 'payment_reminder', 'both are payment reminders');
  ok(a.use_case !== b.use_case, `but each is that industry's own call: ${a.use_case} vs ${b.use_case}`);
}

// ═══════════════════════════════════════════════════════
console.log('\nWHEN A VALUE IS MISSING \u2014 work it out, leave it out, or say what is needed:');
{
  const b = profileFor('Banking');
  const r = one({ customer_name: 'Meera Iyer', to_number: '+919820000001', product_name: 'home loan', amount_due: '12500', due_date: iso(-12) }, b);
  ok(r.archetype === 'overdue_followup', 'a due date twelve days past routes to collections, not a reminder');
  ok(r.variables.days_overdue === '12', 'days overdue was WORKED OUT from the due date: ' + r.variables.days_overdue);
  ok(r.derived.includes('days_overdue'), 'and the row says so, so nobody thinks it came from the file');
}
{
  const r = one({ customer_name: 'Meera Iyer', to_number: '+919820000001', product_name: 'card', amount_due: '2500', due_date: iso(4) }, profileFor('Banking'));
  ok(r.variables.outstanding_balance === undefined, 'a balance we do not have is LEFT OUT, not guessed at');
  ok(!Object.values(r.variables).some(v => v === ''), 'and no variable is sent as an empty string');
  ok(r.omitted.includes('outstanding_balance'), 'the omission is reported rather than silent');
}
{
  const r = one({ customer_name: 'Nobody', to_number: '+911111111111' }, profileFor('Banking'));
  ok(r.callable === false, 'a row with nothing but a name and number is NOT callable');
  ok(r.needs.length > 0, 'and it names what is missing: ' + r.needs.join(', '));
}
console.log('\n\u2026and it steps DOWN to a call the row can actually support:');
{
  // A fee reminder with no amount and no date, but documents outstanding, is a documents call.
  const r = one({ student_name: 'Arjun Shah', guardian_phone: '+919820000002', pending_documents: 'Transfer certificate; Migration certificate' }, profileFor('Education'));
  ok(r.archetype === 'document_collection', 'outstanding documents beat an empty fee column');
  ok(r.variables.missing_items === 'Transfer certificate, Migration certificate', 'the list is read out as a list, not with a semicolon');
  ok(r.callable === true, 'and the call goes ahead');
}
{
  // Stepping down must never be a way to reach a marketing call by process of elimination.
  const r = one({ customer_name: 'Quiet Row', to_number: '+911111111112', notes: 'nothing useful' }, profileFor('Retail'));
  ok(r.callable === false, 'an empty row does NOT become a sales call just because sales needs least');
}

console.log('\n\u2026and it never invents a fact about the customer:');
{
  const r = one({ customer_name: 'Test', to_number: '+911111111113', offer_type: 'summer sale' }, profileFor('Retail'));
  const spoken = Object.entries(r.variables).filter(([k]) => ['amount_due', 'amount_overdue', 'eligible_amount', 'outstanding_balance', 'expiry_date', 'due_date', 'renewal_amount'].includes(k));
  ok(spoken.length === 0, 'no amount and no date appeared from nowhere' + (spoken.length ? ': ' + JSON.stringify(spoken) : ''));
}
{
  // The category CAN be filled from the use case, because we chose the use case and it is true.
  const r = one({ consignee: 'Nadia Haddad', contact_no: '+971500000001', delivery_window: iso(2) + ' 10:00-13:00' }, profileFor('Logistics'));
  ok(!!r.variables.appointment_type, 'the kind of appointment is supplied from the call itself: "' + r.variables.appointment_type + '"');
  ok(r.variables.appointment_time === '10:00 to 13:00', 'and a slot is spoken as a range: ' + r.variables.appointment_time);
  ok(r.derived.includes('appointment_date'), 'the date inside that same slot was split back out');
}

// ═══════════════════════════════════════════════════════
console.log('\nWHEN THE FILE SAYS WHICH CALL IT WANTS, THE FILE WINS:');
{
  const b = profileFor('Banking');
  const key = Object.keys(b.use_cases).find(k => b.use_cases[k].archetype === 'feedback_survey');
  const r = one({ customer_name: 'Ada Musa', to_number: '+2348030000003', use_case: key, amount_due: '5000', due_date: iso(3) }, b);
  ok(r.use_case === key, 'an explicit use_case column overrides what the other columns suggest');
  ok(r.confidence === 'certain', 'and the router says it is certain rather than guessing');
}
{
  const r = one({ customer_name: 'Ada Musa', to_number: '+2348030000003', call_type: 'collections', amount_overdue: '5000', days_overdue: '20' }, profileFor('Banking'));
  ok(r.archetype === 'overdue_followup', 'a partner\'s own word ("collections") maps to our archetype');
}

console.log('\nDO-NOT-CALL IS HONOURED WHATEVER IT IS CALLED:');
// This is the one mapping where being wrong means ringing somebody who asked us not to. It was the
// strictest matcher in the engine until a sample file spelled it "Opted Out" and that person was
// queued for a call, so it is now the most generous, and these hold it there.
{
  const spellings = ['opt_out', 'Opted Out', 'DNC', 'do_not_call', 'Do Not Contact', 'DND',
    'unsubscribed', 'Unsubscribe', 'consent_withdrawn', 'Consent Revoked', 'Suppressed', 'Blacklisted'];
  const missed = [];
  for (const h of spellings) {
    const row = { customer_name: 'X', to_number: '+911111111114', amount_due: '100', due_date: iso(3), product_name: 'card' };
    row[h] = 'yes';
    if (one(row, profileFor('Banking')).dnc !== true) missed.push(h);
  }
  ok(missed.length === 0, `all ${spellings.length} ways of writing it are honoured` + (missed.length ? ' \u2014 MISSED: ' + missed.join(', ') : ''));
}
{
  // And it must actually stop the call, not merely be noticed.
  const rows = [
    { 'Account Holder': 'Will Be Called', 'Mobile No': '+911111111116', 'Product': 'card', 'Bill Amount': '100', 'Payment Due On': iso(3), 'Opted Out': '' },
    { 'Account Holder': 'Asked Us Not To', 'Mobile No': '+911111111117', 'Product': 'card', 'Bill Amount': '100', 'Payment Due On': iso(3), 'Opted Out': 'yes' }
  ];
  const { resolved, out } = analyse(rows, profileFor('Banking'));
  ok(resolved.control.do_not_call === 'Opted Out', '"Opted Out" is recognised as the consent column');
  ok(out.find(r => r.customer_name === 'Asked Us Not To').dnc === true, 'and the person who opted out is flagged');
  ok(out.find(r => r.customer_name === 'Will Be Called').dnc === false, 'while the one who did not is left alone');
}
{
  // A blank or a "no" is not consent withdrawn.
  for (const v of ['', 'no', 'false', '0', 'N']) {
    const r = one({ customer_name: 'X', to_number: '+911111111118', do_not_call: v, amount_due: '100', due_date: iso(3), product_name: 'card' }, profileFor('Banking'));
    ok(r.dnc === false, `"${v || '(blank)'}" does not suppress the call`);
  }
}

// ═══════════════════════════════════════════════════════
console.log('\nTHE LIVE BANKING DEMO STILL WORKS \u2014 legacy profile, no catalogue fields at all:');
{
  const legacy = { company: { name: 'Bank', industry: 'Banking' }, locale: { money_scale: 'indian' }, contact: {}, use_cases: {
    payment_reminder: { enabled: true }, overdue_followup: { enabled: true }, sales_offer: { enabled: true },
    appointment_reminder: { enabled: true }, feedback_survey: { enabled: true }, lead_qualification: { enabled: true }, renewal_retention: { enabled: true }
  } };
  const rows = [
    { customer_name: 'John Carter', to_number: '+14155550142', product_name: 'credit card bill', amount_due: '240', due_date: iso(15), outstanding_balance: '1850' },
    { customer_name: 'Maria Garcia', to_number: '+34655550188', product_name: 'mobile plan', days_overdue: '12', amount_overdue: '45', outstanding_balance: '90' },
    { customer_name: 'Yuki Tanaka', to_number: '+819012345678', appointment_type: 'branch visit', appointment_date: iso(3), appointment_time: '11:00' }
  ];
  const { out } = analyse(rows, legacy);
  ok(out[0].use_case === 'payment_reminder' && out[0].callable, 'a due date still produces a payment reminder');
  ok(out[1].use_case === 'overdue_followup' && out[1].callable, 'days overdue still produces a collections call');
  ok(out[2].use_case === 'appointment_reminder' && out[2].callable, 'an appointment still produces a confirmation');
  ok(out[0].variables.outstanding_balance === '1,850', 'and Indian grouping is still applied: ' + out[0].variables.outstanding_balance);
}
{
  const indian = profileFor('Banking', { locale: { money_scale: 'indian' } });
  const r = one({ customer_name: 'A', to_number: '+919820000009', product_name: 'loan', amount_due: '2500000', due_date: iso(5) }, indian);
  ok(r.variables.amount_due === '25,00,000', 'lakhs are grouped the Indian way: ' + r.variables.amount_due);
  const western = profileFor('Banking');
  const r2 = one({ customer_name: 'A', to_number: '+919820000009', product_name: 'loan', amount_due: '2500000', due_date: iso(5) }, western);
  ok(r2.variables.amount_due === '2,500,000', 'and the Western way elsewhere: ' + r2.variables.amount_due);
}

// ═══════════════════════════════════════════════════════
console.log('\nDATES ARE READ THE WAY THE WORLD WRITES THEM:');
ok(R.parseDate('12/09/2026').getMonth() === 8, '12/09/2026 is September, not December (day-first)');
ok(R.parseDate('2026-09-12').getMonth() === 8, 'and ISO parses as ISO');
ok(R.formatValue('due_date', '2026-09-12').includes('12th of September'), 'spoken out in full: ' + R.formatValue('due_date', '2026-09-12'));
ok(R.formatValue('resolution_eta', '2026-09-10') === 'Thursday, the 10th of September', 'a date in a free-text slot is spoken, not read out as digits');
ok(R.formatTimeSpoken('2026-09-07 morning') === 'morning', 'a worded slot survives: morning');

console.log('\nTHE CATALOGUE\'S OWN WORD IS USED, INCLUDING WHERE IT DISAGREES WITH ITSELF:');
{
  // Three use cases declare `consequences`, one declares `consequence`. The old engine filled only
  // `consequence`, so those three spoke a blank wherever the prompt referred to it.
  const hits = [];
  for (const industry of INDUSTRIES) for (const uc of CATALOG[industry]) for (const f of (uc.fields || [])) if (/^consequences?$/.test(f.var)) hits.push({ industry, uc, f });
  ok(hits.length >= 4, `${hits.length} use cases ask for a consequence, spelled both ways`);
  let filled = 0;
  for (const h of hits) {
    const profile = profileFor(h.industry);
    const row = rowFor(h.uc);
    row[h.f.var] = 'late fees apply';
    const r = one(row, profile);
    if (r.variables[h.f.var] === 'late fees apply') filled++;
  }
  ok(filled === hits.length, `all ${filled} are filled from the row, whichever spelling the catalogue used`);
}

// ═══════════════════════════════════════════════════════
console.log('\nEVERY INDUSTRY, END TO END \u2014 one realistic row each, none of them ours:');
const hasArchetype = (industry, arch) => CATALOG[industry].some(u => u.archetype === arch);
// Deliberately foreign headers throughout: nothing below is a canonical variable name.
{
  const want = ['payment_reminder', 'overdue_followup'];
  // A due date in the FUTURE needs a before-due reminder specifically; an industry that only ever
  // chases arrears has no call for it, and saying so is the correct answer.
  const applies = INDUSTRIES.filter(i => hasArchetype(i, 'payment_reminder'));
  let good = 0, bad = [];
  for (const industry of applies) {
    const r = one({ 'Client Name': 'Test Person', 'Mobile No': '+919820000001', 'Bill Amount': '4500', 'Payment Due On': iso(6) }, profileFor(industry));
    if (r.callable && want.includes(r.archetype)) good++; else bad.push(`${industry}: ${r.archetype}/${r.callable}`);
  }
  ok(good === applies.length, `an amount and a due date reach a payment call in all ${applies.length} industries that make payment calls` + (bad.length ? ' \u2014 except ' + bad.join(', ') : ''));
}
{
  const applies = INDUSTRIES.filter(i => hasArchetype(i, 'appointment_reminder'));
  let good = 0, bad = [];
  for (const industry of applies) {
    const r = one({ 'Customer': 'Test Person', 'Contact Number': '+919820000001', 'Scheduled On': iso(3), 'Time Slot': '10:30' }, profileFor(industry));
    if (r.callable && r.archetype === 'appointment_reminder') good++; else bad.push(`${industry}: ${r.archetype}/${r.callable}`);
  }
  ok(good === applies.length, `a date and a slot reach an appointment call in all ${applies.length} industries that book appointments` + (bad.length ? ' \u2014 not ' + bad.join(', ') : ''));
}

console.log('\n\u2026and where an industry simply does not make that kind of call, it says so rather than improvising:');
{
  // A clinic's catalogue has no payment call in it. An amount and a due date must not be forced
  // into whatever call happens to score least badly.
  const noPay = INDUSTRIES.filter(i => !['payment_reminder', 'overdue_followup'].some(a => hasArchetype(i, a)));
  ok(noPay.length > 0, `${noPay.length} industries make no payment calls at all (${noPay.slice(0, 3).join(', ')}\u2026)`);
  let honest = 0;
  for (const industry of noPay) {
    const r = one({ 'Client Name': 'Test Person', 'Mobile No': '+919820000001', 'Bill Amount': '4500', 'Payment Due On': iso(6) }, profileFor(industry));
    if (!r.callable && r.needs.length) honest++;
  }
  ok(honest === noPay.length, `all ${honest} refuse the row and name what they would need instead`);
}
{
  // Telecom books no appointments. A future date must not quietly become a feedback call about
  // something that has not happened yet.
  const r = one({ 'Customer': 'Test Person', 'Contact Number': '+919820000001', 'Scheduled On': iso(3), 'Time Slot': '10:30' }, profileFor('Telecom'));
  ok(r.callable === false, 'a booking three days OUT is not called at all by an agent that books nothing');
  ok(r.matched === false, 'and it is reported as matching no call, not as a survey');
  ok(/matches the calls this agent makes/.test(r.intelligence_reason), 'in plain words: "' + r.intelligence_reason + '"');
}
{
  // But a genuinely past visit still is one.
  const r = one({ 'Customer': 'Test Person', 'Contact Number': '+919820000001', 'Visit Date': iso(-4) }, profileFor('Telecom'));
  ok(r.archetype === 'feedback_survey' && r.callable, 'a visit four days AGO does reach a feedback call');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

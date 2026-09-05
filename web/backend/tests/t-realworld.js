/**
 * FILES AS THEY ACTUALLY ARRIVE.
 *
 * t-router proves the routing across every industry on tidy data. This is the opposite exercise:
 * the shapes real exports turn up in, so "it works on a partner's own file" is a measured claim.
 *
 * The first run of this scored 15 of 21, and three of the six failures were SILENT — a date read in
 * the wrong order, an Excel serial number read as a date literal, and a phone number Excel had
 * turned into scientific notation. A row we decline to call is a nuisance; a confident wrong date
 * spoken to a real customer is the thing worth most of the effort here.
 */
const path = require('path');
const R = require('../router.js');
const CONN = require('../connectors.js');
const CATALOG = require('../../../config/catalog/use-cases.json');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };

const NOW = new Date('2026-09-06T10:00:00');
// Local, not UTC. toISOString() is UTC, and the router counts days in local time, so the two
// disagree between midnight and the UTC offset -- which made this suite fail only at night.
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const iso = d => { const x = new Date(NOW); x.setDate(x.getDate() + d); return isoLocal(x); };
function profileFor(industry) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, archetype: u.archetype, fields: u.fields || [] };
  return { company: { industry }, locale: {}, contact: {}, use_cases };
}
function run(rows, industry) {
  const resolved = R.resolveColumns(rows);
  return { resolved, out: rows.map(r => R.routeRow(r, resolved, profileFor(industry || 'Banking'), { now: NOW })) };
}
const one = (row, industry) => run([row], industry).out[0];

console.log('\nHOW THE FILE ARRIVES');
{
  const rows = CONN.parseCsv('\ufeffcustomer_name,to_number,product_name,amount_due,due_date\nRohan Desai,+919820011001,Home loan,48500,' + iso(5));
  ok(run(rows).out[0].callable, 'a byte-order mark from Excel "CSV UTF-8" does not eat the first header');
}
{
  // Excel writes semicolons wherever the locale uses a comma for decimals: most of Europe and
  // Latin America. This parsed as ONE column, so every row lost its name and its number.
  const rows = CONN.parseCsv('customer_name;to_number;amount_due;due_date\nRohan Desai;+919820011001;48500;' + iso(5));
  ok(Object.keys(rows[0]).length === 4, 'a semicolon-separated file is read as four columns, not one');
  ok(run(rows).out[0].callable, 'and the row is callable');
}
{
  const rows = CONN.parseCsv('customer_name\tto_number\tamount_due\tdue_date\nRohan Desai\t+919820011001\t48500\t' + iso(5));
  ok(Object.keys(rows[0]).length === 4, 'so is a tab-separated one');
}
{
  const rows = CONN.parseCsv('Monthly Collections Report,,,\n,,,\ncustomer_name,to_number,amount_due,due_date\nRohan Desai,+919820011001,48500,' + iso(5));
  ok(Object.keys(rows[0])[0] === 'customer_name', 'a title above the headers is skipped, not taken as the header');
  ok(run(rows).out[0].callable, 'and the row underneath it still calls');
}
{
  // The guard on all of the above: a comma inside a quoted cell must not vote for the delimiter.
  const rows = CONN.parseCsv('customer_name,city\n"Smith, John",Mumbai');
  ok(rows[0].customer_name === 'Smith, John', 'a comma inside quotes stays part of the value');
}

console.log('\nHOW THE HEADERS ARE WRITTEN');
{
  const { resolved } = run([{ 'Customer Name': 'Rohan Desai', 'Mobile No.': '+919820011001', 'Amount (INR)': '48500', 'Due Date *': iso(5) }]);
  ok(['customer_name', 'to_number', 'amount_due', 'due_date'].every(f => resolved.map[f]), 'units and punctuation in a header do not stop it matching');
}
{
  const r = one({ 'CUSTOMER NAME ': 'Rohan Desai', ' MOBILE': '+919820011001', 'AMOUNT DUE': '48500', 'DUE DATE': iso(5) });
  ok(r.callable, 'nor do capitals and stray spaces');
}
{
  const r = one({ first_name: 'Rohan', last_name: 'Desai', mobile: '+919820011001', amount_due: '48500', due_date: iso(5) });
  ok(/Rohan/.test(r.customer_name || ''), 'a name split across two columns still yields a name to greet: ' + JSON.stringify(r.customer_name));
}
{
  const r = one({ nombre: 'Lucia Ferrari', telefono: '+34655550188', importe: '48500', fecha_vencimiento: iso(5) });
  ok(r.callable, 'a Spanish-language export routes and calls');
  ok(r.variables.amount_due === '48,500', 'with the amount read from `importe`: ' + r.variables.amount_due);
}
{
  const { resolved } = run([
    { customer_name: 'A B', mobile: '+919820011001', landline: '02212345678', amount_due: '4', due_date: iso(5) },
    { customer_name: 'C D', mobile: '+919820011002', landline: '02212345679', amount_due: '4', due_date: iso(5) }
  ]);
  ok(resolved.map.to_number.header === 'mobile', 'given a mobile and a landline, the mobile is dialled');
}

console.log('\nHOW THE VALUES ARE WRITTEN');
{
  // Excel turns a long number into 9.19820011001E+11 the moment it decides the column is numeric.
  // This resolved to an empty string, so the row silently lost its phone number.
  const { out } = run([
    { customer_name: 'Rohan Desai', mobile: '9.19820011001E+11', amount_due: '48500', due_date: iso(5) },
    { customer_name: 'Priya Raghavan', mobile: '9.19820011002E+11', amount_due: '12500', due_date: iso(4) }
  ]);
  ok(out[0].to_number === '919820011001', 'a phone mangled into scientific notation is put back: ' + out[0].to_number);
}
{
  ok(one({ customer_name: 'A B', phone: '09820011001', amount_due: '1', due_date: iso(5) }).to_number === '09820011001', 'a national number with a leading zero is kept verbatim');
}
{
  const r = one({ customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: 'INR 48,500.00', due_date: iso(5) });
  ok(r.variables.amount_due === '48,500', 'a currency symbol and decimals are stripped for speech: ' + r.variables.amount_due);
}
{
  const r = one({ customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '(48500)', due_date: iso(5) });
  ok(r.variables.amount_due === '48,500', 'so are accounting brackets: ' + r.variables.amount_due);
}
{
  const r = one({ customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '1', due_date: '11 Sep 2026' });
  ok(/11th of September/.test(r.variables.due_date), 'a date written in words is understood: ' + r.variables.due_date);
}
{
  const r = one({ customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '1', due_date: '2026-09-11 00:00:00' });
  ok(/11th of September/.test(r.variables.due_date), 'a timestamp is not read aloud: ' + r.variables.due_date);
}
{
  // 46272 is Excel writing a date as a serial count. Read as a date literal it became
  // "the 1st of January" -- a confident wrong answer rather than a visible failure.
  ok(R.excelSerialToDate('46272').getFullYear() === 2026, 'an Excel serial date resolves to the right year');
  ok(R.excelSerialToDate('12500') === null, 'while an ordinary five-digit amount is not mistaken for one');
  ok(R.excelSerialToDate('99999') === null, 'nor is a number outside any plausible date range');
}
{
  const r = one({ customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '48500', due_date: iso(5), outstanding_balance: 'NULL', location: 'N/A' });
  ok(r.variables.outstanding_balance === undefined && r.variables.location === undefined, 'the literal words NULL and N/A are never spoken');
}

console.log('\nTHE ONE THAT CANNOT BE SOLVED, ONLY DECLARED');
{
  // 09/11/2026 is September in Mumbai and November in Chicago, and one row cannot say which.
  // A column usually can: a single date past the 12th settles every other value in it.
  ok(R.detectDateOrder(['09/11/2026', '25/11/2026']) === 'dmy', 'one date past the 12th proves the column is day-first');
  ok(R.detectDateOrder(['09/11/2026', '11/25/2026']) === 'mdy', 'and the mirror image proves it is month-first');
  ok(R.detectDateOrder(['09/11/2026', '04/05/2026']) === 'ambiguous', 'a column where nothing passes the 12th is reported ambiguous, not guessed at');
}
{
  const { resolved, out } = run([
    { customer_name: 'A B', mobile: '+15551230001', product_name: 'loan', amount_due: '1', due_date: '09/11/2026' },
    { customer_name: 'C D', mobile: '+15551230002', product_name: 'loan', amount_due: '1', due_date: '11/25/2026' }
  ]);
  ok(resolved.map.due_date.dateOrder === 'mdy', 'a real American file is read the American way');
  ok(/11th of September/.test(out[0].variables.due_date), 'so 09/11 is the 11th of September: ' + out[0].variables.due_date);
}
{
  const { resolved, out } = run([
    { customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '1', due_date: '09/11/2026' },
    { customer_name: 'C D', mobile: '+919820011002', product_name: 'loan', amount_due: '1', due_date: '25/11/2026' }
  ]);
  ok(resolved.map.due_date.dateOrder === 'dmy', 'and an Indian one the Indian way');
  ok(/9th of November/.test(out[0].variables.due_date), 'so the very same string is the 9th of November: ' + out[0].variables.due_date);
}
{
  const { resolved } = run([
    { customer_name: 'A B', mobile: '+919820011001', product_name: 'loan', amount_due: '1', due_date: '09/11/2026' },
    { customer_name: 'C D', mobile: '+919820011002', product_name: 'loan', amount_due: '1', due_date: '04/05/2026' }
  ]);
  ok(resolved.map.due_date.dateOrder === 'ambiguous', 'and where the file genuinely does not say, the column is FLAGGED rather than quietly assumed');
}
{
  // 13 in the first position settles that value on its own, whatever the rest of the column said.
  const r = one({ customer_name: 'A B', mobile: '+15551230001', product_name: 'loan', amount_due: '1', due_date: '13/11/2026' });
  ok(/13th of November/.test(r.variables.due_date), 'there is no 13th month, so that value reads day-first regardless: ' + r.variables.due_date);
}

console.log('\nHOW BIG AND HOW MESSY');
{
  const row = { 'Account Holder': 'Rohan Desai', 'Mobile No': '+919820011001', 'Product': 'Home loan', 'Bill Amount': '48500', 'Payment Due On': iso(5) };
  for (let i = 0; i < 55; i++) row['internal_field_' + i] = 'x' + i;
  const r = one(row);
  ok(r.callable && r.variables.amount_due === '48,500', 'a 60-column export finds the five columns that matter');
}
{
  const rows = CONN.parseCsv('customer_name,to_number,amount_due,due_date\nRohan Desai,+919820011001,48500,' + iso(5) + '\n\nPriya Raghavan,+919820011002,12500,' + iso(4));
  const { out } = run(rows);
  ok(out.length === 2 && out.every(r => r.callable), 'a blank line in the middle does not end the file');
}
{
  const { out } = run([
    { 'Account Holder': 'A One', 'Mobile No': '+919820011001', 'Product': 'loan', 'Bill Amount': '48500', 'Payment Due On': iso(5) },
    { 'Account Holder': 'B Two', 'Mobile No': '+919820011002', 'Product': 'card', 'Days Late': '23' },
    { 'Account Holder': 'C Three', 'Mobile No': '+919820011003', 'Scheduled On': iso(3), 'Time Slot': '10:30' }
  ]);
  ok(new Set(out.map(r => r.archetype)).size === 3, 'three different kinds of call in one upload stay separate: ' + out.map(r => r.archetype).join(', '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

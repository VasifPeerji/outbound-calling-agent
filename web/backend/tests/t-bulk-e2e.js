/**
 * THE BULK PATH, THROUGH A REAL SERVER.
 *
 * t-router covers the decision; this covers everything wrapped around it — CSV upload, the queue
 * ordering and skips, and the campaign actually running the calls the analysis promised. It exists
 * because the router changed the shape of what /api/analyse-csv returns, and a green unit suite
 * says nothing about whether the endpoint still feeds the launcher.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const http = require('http');

const SRC = path.resolve(__dirname, '../../..');
const ISO = path.join(require('os').tmpdir(), 'omnireach-test-bulk');
const BE = path.join(ISO, 'web/backend');
const PORT = 3033;
let pass = 0, fail = 0, srv = null, log = '';
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };

function build() {
  try { execSync('cmd /c rmdir "' + path.join(BE, 'node_modules').replace(/\//g, '\\') + '"', { stdio: 'ignore' }); } catch (e) {}
  fs.rmSync(ISO, { recursive: true, force: true });
  fs.mkdirSync(path.join(BE, 'data'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'web/backend'))) {
    if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(SRC, 'web/backend', f), path.join(BE, f));
  }
  fs.cpSync(path.join(SRC, 'web/frontend'), path.join(ISO, 'web/frontend'), { recursive: true });
  fs.cpSync(path.join(SRC, 'web/backend/ui'), path.join(BE, 'ui'), { recursive: true });
  fs.cpSync(path.join(SRC, 'config'), path.join(ISO, 'config'), { recursive: true });
  fs.cpSync(path.join(SRC, 'prompts'), path.join(ISO, 'prompts'), { recursive: true });
  execSync('cmd /c mklink /J "' + path.join(BE, 'node_modules').replace(/\//g, '\\') + '" "' + path.join(SRC, 'web/backend/node_modules').replace(/\//g, '\\') + '"', { stdio: 'ignore' });

  const auth = require(path.join(BE, 'auth.js'));
  fs.writeFileSync(path.join(BE, 'data/users.json'), JSON.stringify([
    { id: 'u-super', email: 'vasif@streebo.com', name: 'Vasif', org: 'Streebo', orgId: 'streebo.com', role: 'admin', superAdmin: true, canGrantAdmin: true, passwordHash: auth.hashPassword('Pass!2026x'), active: true, createdAt: '2026-01-01T00:00:00Z', quota: {}, usage: {} }
  ], null, 1));
  fs.writeFileSync(path.join(BE, 'data/calls.json'), '[]');
  const env = fs.readFileSync(path.join(SRC, 'web/backend/.env'), 'utf8')
    .split(/\r?\n/).filter(l => !/^(DATABASE_URL|PORT|ADMIN_PASSWORD|AUTO_SYNC_TOOLS|MAIL_PROVIDER|GRAPH_|PLATFORM_ORG)/.test(l)).join('\n');
  fs.writeFileSync(path.join(BE, '.env'), env + '\nDATABASE_URL=\nPORT=' + PORT + '\nAUTO_SYNC_TOOLS=false\nMAIL_PROVIDER=dev\nPLATFORM_ORG=streebo.com\n');
  fs.writeFileSync(path.join(BE, 'start-iso.js'), 'process.chdir(__dirname);\nrequire("./server.js").start();\n');
}

const req = (method, p, token, body) => new Promise(resolve => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
  } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, body: s }); } }); });
  r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  if (data) r.write(data); r.end();
});
const wait = ms => new Promise(r => setTimeout(r, ms));

const CATALOG = require(path.join(SRC, 'config/catalog/use-cases.json'));
function useCasesFor(industry) {
  const out = {};
  for (const u of CATALOG[industry] || []) out[u.key] = { enabled: true, label: u.label, emoji: u.emoji || '\u2022', archetype: u.archetype || u.key, desc: u.desc || '', playbook: u.playbook || '', fields: u.fields || [] };
  return out;
}
const day = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

(async () => {
  build();
  srv = spawn(process.execPath, [path.join(BE, 'start-iso.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 40 && !/OmniReach is running/.test(log); i++) await wait(250);
  if (!/OmniReach is running/.test(log)) { console.log('server never started:\n' + log.slice(-1500)); process.exit(1); }
  const token = (await req('POST', '/api/auth/login', null, { email: 'vasif@streebo.com', password: 'Pass!2026x' })).body.token;
  await req('POST', '/api/profile', token, { profile: {
    company: { name: 'Test Telecom', industry: 'Telecom' }, locale: {}, agent: {}, contact: {}, compliance: {}, offerings: {},
    use_cases: useCasesFor('Telecom')
  } });

  console.log('\nA PARTNER UPLOADS THEIR OWN EXPORT:');
  const csv = [
    'subscriber_name,msisdn,plan_name,bill_amount,bill_due_date,outage_area,restoration_eta,opt_out',
    `Chidi Okafor,+2348030000001,Unlimited 5G,14500,${day(5)},,,`,
    `Amaka Eze,+2348030000002,Family 100GB,,,Ikeja GRA,${day(0)} 18:00,`,
    `Bisi Adeyemi,+2348030000003,Prepaid,9000,${day(-20)},,,`,
    `Tunde Bello,+2348030000004,Postpaid,3000,${day(4)},,,yes`,
    `Chidi Okafor,+2348030000001,Unlimited 5G,14500,${day(5)},,,`,
    'Ngozi Umeh,,Postpaid,1200,,,,'
  ].join('\n');
  const a = await req('POST', '/api/analyse-csv', token, { csvText: csv });
  ok(a.status === 200, 'the CSV is accepted');
  const rows = a.body.customers, byName = n => rows.find(r => r.customer_name === n);
  ok(rows.length === 6, `all ${rows.length} rows come back`);

  console.log('\nthe file is mapped, and the mapping is reported back:');
  const cols = a.body.columns || [];
  const col = f => (cols.find(c => c.field === f) || {}).header;
  ok(col('to_number') === 'msisdn', '`msisdn` is reported as the phone number');
  ok(col('customer_name') === 'subscriber_name', '`subscriber_name` as the customer name');
  ok(col('amount_due') === 'bill_amount' && col('due_date') === 'bill_due_date', 'the amount and the due date too');
  ok(cols.some(c => c.field === 'do_not_call' && c.header === 'opt_out'), 'and `opt_out` is flagged as a control column');

  console.log('\neach row reaches the call its own data asks for:');
  ok(byName('Chidi Okafor').archetype === 'payment_reminder', 'a bill due in five days \u2192 reminder');
  ok(byName('Amaka Eze').archetype === 'service_notification', 'an outage area \u2192 service notification');
  ok(byName('Bisi Adeyemi').archetype === 'overdue_followup', 'a bill twenty days past \u2192 collections');
  ok(byName('Bisi Adeyemi').variables.days_overdue === '20', 'with the days overdue worked out: ' + byName('Bisi Adeyemi').variables.days_overdue);

  console.log('\nand the queue prunes what should not be dialled:');
  ok(byName('Tunde Bello').skip && /do-not-call/.test(byName('Tunde Bello').skipReason), 'opt-out is skipped: ' + byName('Tunde Bello').skipReason);
  ok(rows.filter(r => r.customer_name === 'Chidi Okafor' && r.skip && /duplicate/.test(r.skipReason)).length === 1, 'the repeated number is skipped once, not twice');
  ok(byName('Ngozi Umeh').skip && /phone/.test(byName('Ngozi Umeh').skipReason), 'a row with no number says so: ' + byName('Ngozi Umeh').skipReason);

  console.log('\n\u2026urgency first:');
  const order = rows.filter(r => !r.skip).sort((x, y) => x.callOrder - y.callOrder).map(r => r.customer_name);
  ok(order[0] === 'Amaka Eze', 'the outage is called before the bills: ' + order.join(' \u2192 '));
  ok(order.indexOf('Bisi Adeyemi') < order.indexOf('Chidi Okafor'), 'and arrears before a courtesy reminder');

  console.log('\nTHE CAMPAIGN PLACES EXACTLY WHAT THE ANALYSIS PROMISED:');
  const ready = rows.filter(r => r.ready && !r.skip).sort((x, y) => x.callOrder - y.callOrder);
  ok(ready.length === 3, `${ready.length} rows are callable`);
  const launch = await req('POST', '/api/campaign/launch', token, {
    customers: ready.map(c => ({ to_number: c.to_number, customer_name: c.customer_name, use_case: c.use_case, time: c.time, variables: c.variables, intelligence_reason: c.intelligence_reason })),
    campaignName: 'Router check', delay: 0, simulate: true
  });
  ok(launch.status === 200, 'the campaign starts');
  let st = null;
  for (let i = 0; i < 60; i++) { st = (await req('GET', '/api/campaign/status', token)).body; if (st && st.processed >= ready.length) break; await wait(250); }
  ok(st && st.processed === ready.length, `all ${ready.length} were processed`);

  const hist = (await req('GET', '/api/history?scope=all&limit=50', token)).body.calls || [];
  ok(hist.length === ready.length, `${hist.length} calls are on record`);
  for (const c of ready) {
    const e = hist.find(h => (h.toNumber || '').replace(/\s/g, '') === c.to_number.replace(/\s/g, ''));
    ok(!!e && e.useCase === c.use_case, `${c.customer_name} was called with ${c.use_case}, as promised`);
    const spoken = Object.values((e && e.variables) || {});
    ok(!spoken.some(v => v === ''), `\u2026and no blank variable was sent for ${c.customer_name}`);
  }
  ok(hist.every(h => h.simulated === true), 'every one is marked simulated, so none counts as a real call');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})().catch(e => { console.error('ERROR', e); fail++; }).finally(async () => {
  if (srv) srv.kill();
  await wait(400);
  try { execSync('cmd /c rmdir "' + path.join(BE, 'node_modules').replace(/\//g, '\\') + '"', { stdio: 'ignore' }); } catch (e) {}
  fs.rmSync(ISO, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
});

/**
 * SAVED SETUPS: WHO MAY CHANGE ONE, AND SAVE UPDATING THE ONE YOU LOADED.
 *
 * Reproduced before fixing. Deleting your own setup worked; deleting one a colleague saved returned
 * "Bookmark not found." Setups are visible across the organisation but update and delete matched the
 * author only, and the console offered both buttons on every card. On live, 9 of the 15 setups were
 * saved from a second account belonging to the same person, so most of them refused to delete.
 *
 * The rule now: the author, an administrator of the author's organisation, or a platform
 * administrator may update or delete. Anyone else can see and load it, and save their own copy.
 *
 * Also covers the guide the app now serves at /guide/, since this suite already runs a server.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { linkModules, unlinkModules } = require('./harness.js');

const SRC = path.resolve(__dirname, '../../..');
const ISO = path.join(require('os').tmpdir(), 'omnireach-test-bookmarks');
const BE = path.join(ISO, 'web/backend');
const PORT = 3043;
let pass = 0, fail = 0, srv = null, log = '';
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

function build() {
  unlinkModules(path.join(BE, 'node_modules'));
  fs.rmSync(ISO, { recursive: true, force: true });
  fs.mkdirSync(path.join(BE, 'data'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'web/backend'))) {
    if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(SRC, 'web/backend', f), path.join(BE, f));
  }
  fs.cpSync(path.join(SRC, 'web/frontend'), path.join(ISO, 'web/frontend'), { recursive: true });
  fs.cpSync(path.join(SRC, 'web/backend/ui'), path.join(BE, 'ui'), { recursive: true });
  fs.cpSync(path.join(SRC, 'config'), path.join(ISO, 'config'), { recursive: true });
  fs.cpSync(path.join(SRC, 'prompts'), path.join(ISO, 'prompts'), { recursive: true });
  linkModules(path.join(BE, 'node_modules'), path.join(SRC, 'web/backend/node_modules'));

  const auth = require(path.join(SRC, 'web/backend/auth.js'));
  const u = (id, email, org, role, sup) => ({
    id, email, name: email.split('@')[0], org, orgId: org, role, superAdmin: !!sup, canGrantAdmin: !!sup,
    passwordHash: auth.hashPassword('Pass!2026x'), active: true, createdAt: '2026-01-01T00:00:00Z', quota: {}, usage: {}
  });
  fs.writeFileSync(path.join(BE, 'data/users.json'), JSON.stringify([
    u('u-plat', 'platform@streebo.test', 'streebo.test', 'admin', true),     // platform admin
    u('u-plat2', 'second@streebo.test', 'streebo.test', 'admin', false),     // same person, other account
    u('u-ann', 'ann@acme.test', 'acme.test', 'user'),                        // author
    u('u-bob', 'bob@acme.test', 'acme.test', 'user'),                        // colleague
    u('u-cat', 'cat@acme.test', 'acme.test', 'admin'),                       // Acme's own admin
    u('u-dan', 'dan@rival.test', 'rival.test', 'admin')                      // another company entirely
  ], null, 1));
  fs.writeFileSync(path.join(BE, 'data/calls.json'), '[]');
  const env = fs.readFileSync(path.join(SRC, 'web/backend/.env'), 'utf8')
    .split(/\r?\n/).filter(l => !/^(DATABASE_URL|PORT|AUTO_SYNC_TOOLS|MAIL_PROVIDER|GRAPH_|PLATFORM_ORG)/.test(l)).join('\n');
  fs.writeFileSync(path.join(BE, '.env'), env + '\nDATABASE_URL=\nPORT=' + PORT + '\nAUTO_SYNC_TOOLS=false\nMAIL_PROVIDER=dev\nPLATFORM_ORG=streebo.test\n');
  fs.writeFileSync(path.join(BE, 'start-iso.js'), 'process.chdir(__dirname);\nrequire("./server.js").start();\n');
}

const req = (method, p, token, body) => new Promise(resolve => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
  } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
    const raw = Buffer.concat(chunks); let b; try { b = JSON.parse(raw.toString('utf8')); } catch (e) { b = raw; }
    resolve({ status: res.statusCode, body: b, type: res.headers['content-type'] || '' }); }); });
  r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  if (data) r.write(data); r.end();
});
const login = async email => (await req('POST', '/api/auth/login', null, { email, password: 'Pass!2026x' })).body.token;
const list = async t => (await req('GET', '/api/bookmarks', t)).body.bookmarks || [];
const save = (t, name, company) => req('POST', '/api/bookmarks', t, { name, config: { fields: { 'ab-company': company } } });

(async () => {
  build();
  srv = spawn(process.execPath, [path.join(BE, 'start-iso.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 40 && !/OmniReach is running/.test(log); i++) await wait(250);
  if (!/OmniReach is running/.test(log)) { console.log('server never started:\n' + log.slice(-1500)); process.exit(1); }

  const T = {};
  for (const [k, e] of [['plat', 'platform@streebo.test'], ['plat2', 'second@streebo.test'], ['ann', 'ann@acme.test'],
    ['bob', 'bob@acme.test'], ['cat', 'cat@acme.test'], ['dan', 'dan@rival.test']]) T[k] = await login(e);
  ok(Object.values(T).every(Boolean), 'six accounts across three organisations are signed in');

  console.log('\nTHE AUTHOR:');
  const a1 = (await save(T.ann, 'Acme bank', 'Acme')).body.bookmark;
  ok(a1 && a1.canModify === true && a1.mine === true, 'a fresh setup comes back marked as yours, and yours to change');
  const upd = await req('POST', '/api/bookmarks/' + a1.id, T.ann, { config: { fields: { 'ab-company': 'Acme Bank Ltd' } } });
  ok(upd.status === 200, 'the author can update it');
  ok((await list(T.ann)).filter(b => b.name === 'Acme bank').length === 1, 'and updating by id changes that setup, it does not add a second one');

  console.log('\nA COLLEAGUE, SAME COMPANY, NOT AN ADMIN:');
  const seen = (await list(T.bob)).find(b => b.id === a1.id);
  ok(!!seen, "can see a colleague's setup, because the library is shared across the organisation");
  ok(seen && seen.canModify === false && seen.mine === false, 'and is told it is not theirs to change');
  ok(seen && seen.ownerName === 'ann', 'with the author named: ' + (seen && seen.ownerName));
  const bobDel = await req('DELETE', '/api/bookmarks/' + a1.id, T.bob);
  ok(bobDel.status === 403, 'deleting it is refused');
  ok(/belongs to ann/i.test(bobDel.body.error || '') && /copy/i.test(bobDel.body.error || ''), 'with a reason that names the owner and says how to keep a copy: "' + bobDel.body.error + '"');
  ok(!/not found/i.test(bobDel.body.error || ''), 'not the old "Bookmark not found", which was simply untrue');
  ok((await req('POST', '/api/bookmarks/' + a1.id, T.bob, { config: {} })).status === 403, 'nor can they overwrite it');
  const copy = (await save(T.bob, 'Acme bank', 'Acme copy')).body.bookmark;
  ok(copy && copy.id !== a1.id && copy.mine === true, 'but they can save a copy of their own, even under the same name');

  console.log('\nTHE COMPANY\'S OWN ADMINISTRATOR:');
  const catView = (await list(T.cat)).find(b => b.id === a1.id);
  ok(catView && catView.canModify === true, 'an admin of the author\'s organisation may change the team\'s setups');
  ok((await req('POST', '/api/bookmarks/' + a1.id, T.cat, { config: { fields: { 'ab-company': 'Acme (edited by admin)' } } })).status === 200, 'and can update one');

  console.log('\nANOTHER COMPANY ENTIRELY:');
  ok(!(await list(T.dan)).some(b => b.id === a1.id), "a rival company's admin cannot even see Acme's setups");
  ok((await req('DELETE', '/api/bookmarks/' + a1.id, T.dan)).status === 404, 'so deleting one reports it as not there, which from their side is true');

  console.log('\nTHE PLATFORM ADMINISTRATOR, INCLUDING ONE PERSON WITH TWO ACCOUNTS:');
  // The live case: nine setups saved from one of the person's accounts, deleted from the other.
  const other = (await save(T.plat2, 'Demo from my other account', 'Demo')).body.bookmark;
  const platView = (await list(T.plat)).find(b => b.id === other.id);
  ok(platView && platView.canModify === true, 'a setup saved from a second account is changeable from the first');
  ok((await req('DELETE', '/api/bookmarks/' + other.id, T.plat)).status === 200, 'and it deletes, where before it answered "Bookmark not found"');
  ok((await req('DELETE', '/api/bookmarks/' + copy.id, T.plat)).status === 200, 'a platform admin can tidy up any organisation\'s setups');
  ok((await req('DELETE', '/api/bookmarks/' + copy.id, T.plat)).status === 404, 'and deleting one twice says plainly it no longer exists');

  console.log('\nTHE AUTHOR CAN STILL DELETE THEIR OWN:');
  ok((await req('DELETE', '/api/bookmarks/' + a1.id, T.ann)).status === 200, 'deleted by its author');
  ok(!(await list(T.ann)).some(b => b.id === a1.id), 'and it is gone');

  console.log('\nTHE GUIDE AND THE MANUAL ARE SERVED BY THE APP:');
  const g = await req('GET', '/guide/');
  const html = Buffer.isBuffer(g.body) ? g.body.toString('utf8') : String(g.body);
  ok(g.status === 200 && /text\/html/.test(g.type), '/guide/ is served, with no sign-in needed, so it works from an email link');
  ok(/Place your first OmniReach call/.test(html), 'and it is the OmniReach quick guide');
  ok(/href="OmniReach-User-Manual\.pdf"/.test(html), 'which offers the user manual');
  const pdf = await req('GET', '/guide/OmniReach-User-Manual.pdf');
  const pdfBuf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(JSON.stringify(pdf.body));
  ok(pdf.status === 200 && /pdf/.test(pdf.type) && pdfBuf.slice(0, 5).toString() === '%PDF-', 'and the manual it links to is really there, as a PDF');
  const back = await req('GET', '/');
  ok(back.status === 200, 'the guide\'s "Open OmniReach" link, "../", lands on the console');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})().catch(e => { console.error('ERROR', e); fail++; }).finally(async () => {
  if (srv) srv.kill();
  await wait(400);
  unlinkModules(path.join(BE, 'node_modules'));
  try { fs.rmSync(ISO, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
});

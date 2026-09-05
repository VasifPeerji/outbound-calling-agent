/**
 * ONE AGENT, MANY PARTNERS, AT THE SAME MOMENT.
 *
 * The platform has a single ElevenLabs agent behind it, which raises a fair question: when two
 * partners run a campaign at the same time, what stops one of them re-configuring the agent out from
 * under the other and putting the wrong company, voice or script on a live call?
 *
 * The answer is meant to be that NOTHING about a call lives on the agent. Every call carries its own
 * prompt, first message, language, voice and variables in `conversation_config_override`, so the two
 * campaigns never touch the same mutable thing. This proves it rather than asserting it: two
 * partners in different industries, launched simultaneously, with every outbound request to
 * ElevenLabs intercepted and inspected.
 *
 * It runs the server IN-PROCESS so global.fetch can be replaced. Nothing leaves the machine.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { linkModules, unlinkModules } = require('./harness.js');

const SRC = path.resolve(__dirname, '../../..');
const ISO = path.join(require('os').tmpdir(), 'omnireach-test-concurrency');
const BE = path.join(ISO, 'web/backend');
const PORT = 3041;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── every request the platform makes of ElevenLabs ──
// The backend calls out through `node-fetch`, not the global fetch, so the interception has to
// replace that MODULE before server.js is loaded. Spying on global.fetch quietly caught nothing and
// let the run reach out to the real api.elevenlabs.io.
const placed = [];
const other = [];
function reply(obj, status) {
  const text = JSON.stringify(obj);
  return { ok: (status || 200) < 400, status: status || 200, json: async () => JSON.parse(text), text: async () => text };
}
function installFetchSpy(resolveFrom) {
  const nfPath = require.resolve('node-fetch', { paths: [resolveFrom] });
  const real = require(nfPath);
  const spy = async (url, opts) => {
    const u = String(url);
    if (!u.includes('api.elevenlabs.io')) return real(url, opts);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;

    if (u.includes('/convai/twilio/outbound-call')) {
      placed.push({ at: Date.now(), body });
      return reply({ success: true, conversation_id: 'conv_' + placed.length });
    }
    // Everything that is NOT a call is recorded separately, because a WRITE to the shared agent
    // while two partners are dialling is precisely the risk this test exists to rule out.
    other.push({ method, url: u });
    if (/\/convai\/agents\/[^/?]+$/.test(u) && method === 'GET') {
      // The agent as ElevenLabs would report it: every override permitted, so nothing is silently
      // dropped and the test sees exactly what the platform intended to send.
      return reply({ platform_settings: { overrides: { conversation_config_override: {
        agent: { prompt: { prompt: true, llm: true }, language: true, first_message: true },
        tts: { voice_id: true, stability: true, speed: true, similarity_boost: true },
        conversation: { max_duration_seconds: true }
      } } } });
    }
    return reply({});
  };
  require.cache[nfPath] = { id: nfPath, filename: nfPath, loaded: true, exports: spy, children: [], paths: [] };
}

function build() {
  fs.rmSync(ISO, { recursive: true, force: true });
  fs.mkdirSync(path.join(BE, 'data'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'web/backend'))) {
    if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(SRC, 'web/backend', f), path.join(BE, f));
  }
  fs.cpSync(path.join(SRC, 'web/frontend'), path.join(ISO, 'web/frontend'), { recursive: true });
  fs.cpSync(path.join(SRC, 'web/backend/ui'), path.join(BE, 'ui'), { recursive: true });
  fs.cpSync(path.join(SRC, 'config'), path.join(ISO, 'config'), { recursive: true });
  fs.cpSync(path.join(SRC, 'prompts'), path.join(ISO, 'prompts'), { recursive: true });
  // Link the real install rather than copying it, however this platform spells a directory link.
  linkModules(path.join(BE, 'node_modules'), path.join(SRC, 'web/backend/node_modules'));

  const auth = require(path.join(SRC, 'web/backend/auth.js'));
  const mk = (id, email, org) => ({
    id, email, name: email.split('@')[0], org, orgId: org, role: 'user',
    passwordHash: auth.hashPassword('Pass!2026x'), active: true,
    createdAt: '2026-01-01T00:00:00Z', quota: {}, usage: {}
  });
  fs.writeFileSync(path.join(BE, 'data/users.json'), JSON.stringify([
    mk('u-alpha', 'ana@alphabank.test', 'alphabank.test'),
    mk('u-beta', 'bo@betaclinic.test', 'betaclinic.test')
  ], null, 1));
  fs.writeFileSync(path.join(BE, 'data/calls.json'), '[]');
  // Bulk on for partners, no quota ceilings: the point here is concurrency, not the guardrails.
  fs.writeFileSync(path.join(BE, 'data/guardrails.json'), JSON.stringify({
    enforceQuota: false, simulationOnly: false, allowBulkForPartners: true, rateLimitPerMin: null
  }, null, 1));

  const env = fs.readFileSync(path.join(SRC, 'web/backend/.env'), 'utf8')
    .split(/\r?\n/).filter(l => !/^(DATABASE_URL|PORT|AUTO_SYNC_TOOLS|MAIL_PROVIDER|GRAPH_|PLATFORM_ORG|ELEVENLABS_)/.test(l)).join('\n');
  fs.writeFileSync(path.join(BE, '.env'), env +
    '\nDATABASE_URL=\nPORT=' + PORT +
    '\nAUTO_SYNC_TOOLS=false\nMAIL_PROVIDER=dev\nPLATFORM_ORG=streebo.test' +
    '\nELEVENLABS_API_KEY=test-key\nELEVENLABS_AGENT_ID=agent_shared\nELEVENLABS_AGENT_PHONE_NUMBER_ID=phone_shared\n');
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

const CATALOG = require(path.join(SRC, 'config/catalog/use-cases.json'));
function profileFor(company, industry, voiceId, language) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, emoji: u.emoji || '*', archetype: u.archetype, desc: u.desc || '', playbook: u.playbook || '', fields: u.fields || [] };
  return {
    company: { name: company, industry },
    locale: { money_scale: 'western' },
    agent: { name: company + ' Assistant', llm: 'gemini-2.0-flash', demo_realism: false },
    voice: { provider: 'elevenlabs', voice_id: voiceId, language },
    contact: {}, compliance: {}, offerings: {}, use_cases
  };
}
// Local, not UTC. toISOString() is UTC, and the router counts days in local time, so the two
// disagree between midnight and the UTC offset -- which made this suite fail only at night.
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = d => { const x = new Date(); x.setDate(x.getDate() + d); return isoLocal(x); };

(async () => {
  build();
  installFetchSpy(path.join(SRC, 'web/backend'));
  process.chdir(BE);
  const server = require(path.join(BE, 'server.js'));
  await server.start();
  for (let i = 0; i < 40; i++) { const h = await req('GET', '/api/health'); if (h.status === 200) break; await wait(200); }

  const alpha = (await req('POST', '/api/auth/login', null, { email: 'ana@alphabank.test', password: 'Pass!2026x' })).body.token;
  const beta = (await req('POST', '/api/auth/login', null, { email: 'bo@betaclinic.test', password: 'Pass!2026x' })).body.token;
  ok(!!alpha && !!beta, 'two partners in different organisations are signed in');

  // Deliberately opposite in every respect that reaches a call.
  await req('POST', '/api/profile', alpha, { profile: profileFor('Alpha Bank', 'Banking', 'voice_ALPHA', 'en') });
  await req('POST', '/api/profile', beta, { profile: profileFor('Beta Clinic', 'Healthcare', 'voice_BETA', 'hi') });

  const alphaUC = Object.keys((await req('GET', '/api/profile', alpha)).body.profile.use_cases)[0];
  const betaUC = Object.keys((await req('GET', '/api/profile', beta)).body.profile.use_cases)[0];
  ok(alphaUC !== betaUC, `and each has its own industry's playbooks (${alphaUC} vs ${betaUC})`);

  console.log('\nBOTH LAUNCH AT THE SAME MOMENT, INTERLEAVED ON PURPOSE:');
  const rows = n => Array.from({ length: n }, (_, i) => ({
    to_number: '+1555000' + (i + 1) + '00', customer_name: 'Person ' + (i + 1),
    use_case: null, variables: {}
  }));
  const alphaRows = rows(4).map(r => ({ ...r, use_case: alphaUC, customer_name: 'Alpha ' + r.customer_name, variables: { product_name: 'home loan', amount_due: '48500', due_date: day(5) } }));
  const betaRows = rows(4).map(r => ({ ...r, use_case: betaUC, customer_name: 'Beta ' + r.customer_name, variables: { appointment_type: 'scan', appointment_date: day(3), appointment_time: '10:30' } }));

  // delay 1s so the two campaigns genuinely overlap rather than running one after the other.
  const [ra, rb] = await Promise.all([
    req('POST', '/api/campaign/launch', alpha, { customers: alphaRows, campaignName: 'Alpha', delay: 1, simulate: false }),
    req('POST', '/api/campaign/launch', beta, { customers: betaRows, campaignName: 'Beta', delay: 1, simulate: false })
  ]);
  ok(ra.status === 200 && rb.status === 200, 'both campaigns start');

  for (let i = 0; i < 80 && placed.length < 8; i++) await wait(250);
  ok(placed.length === 8, `all ${placed.length} calls reached the provider`);

  const byName = n => placed.filter(p => ((p.body.conversation_initiation_client_data || {}).dynamic_variables || {}).customer_name === n)[0];
  const alphaCalls = placed.filter(p => /^Alpha /.test(((p.body.conversation_initiation_client_data || {}).dynamic_variables || {}).customer_name || ''));
  const betaCalls = placed.filter(p => /^Beta /.test(((p.body.conversation_initiation_client_data || {}).dynamic_variables || {}).customer_name || ''));
  ok(alphaCalls.length === 4 && betaCalls.length === 4, 'four each');

  // The proof that they really overlapped: the two campaigns are not in separate blocks.
  const order = placed.map(p => (/^Alpha /.test(((p.body.conversation_initiation_client_data || {}).dynamic_variables || {}).customer_name || '') ? 'A' : 'B')).join('');
  ok(/AB|BA/.test(order.replace(/^(A+|B+)/, '')) || /(AB|BA)/.test(order), 'and they really did interleave: ' + order);

  console.log('\nEVERY CALL CARRIED ITS OWN PARTNER, NOT THE OTHER ONE:');
  const cfg = p => (p.body.conversation_initiation_client_data || {}).conversation_config_override || {};
  const vars = p => (p.body.conversation_initiation_client_data || {}).dynamic_variables || {};

  // `[].every()` is true, so an empty set would sail through every check below. Each of these
  // therefore states the count as well as the condition: the first version of this file reported
  // nineteen passes while intercepting nothing at all.
  const all = (list, n2, fn, msg) => ok(list.length === n2 && list.every(fn), msg + ` (${list.length} of ${n2})`);
  const none = (list, n2, fn, msg) => ok(list.length === n2 && !list.some(fn), msg + ` (${list.length} of ${n2})`);

  all(alphaCalls, 4, p => (cfg(p).tts || {}).voice_id === 'voice_ALPHA', 'Alpha calls all used the Alpha voice');
  all(betaCalls, 4, p => (cfg(p).tts || {}).voice_id === 'voice_BETA', 'Beta calls all used the Beta voice');
  all(alphaCalls, 4, p => (cfg(p).agent || {}).language === 'en', 'Alpha calls all spoke English');
  all(betaCalls, 4, p => (cfg(p).agent || {}).language === 'hi', 'Beta calls all spoke Hindi');
  // The prompt is a template: the company arrives beside it in dynamic_variables, checked below.
  // What separates one partner's script from the other's is the PLAYBOOK the catalogue holds for
  // that use case, so that is what has to be present, and exclusively so.
  const promptOf = p => ((cfg(p).agent || {}).prompt || {}).prompt || '';
  const playbook = (industry, key) => (CATALOG[industry].find(u => u.key === key) || {}).playbook || '';
  const alphaPlay = playbook('Banking', alphaUC), betaPlay = playbook('Healthcare', betaUC);
  ok(!!alphaPlay && !!betaPlay && alphaPlay !== betaPlay, 'the two industries have genuinely different playbooks');
  all(alphaCalls, 4, p => promptOf(p).includes(alphaPlay), "every Alpha call carried the bank's own playbook");
  all(betaCalls, 4, p => promptOf(p).includes(betaPlay), "every Beta call carried the clinic's own playbook");
  none(alphaCalls, 4, p => promptOf(p).includes(betaPlay), 'and not one Alpha call carried the clinic script');
  none(betaCalls, 4, p => promptOf(p).includes(alphaPlay), 'nor one Beta call the bank script');
  ok(new Set(placed.map(promptOf)).size === 2, 'exactly two distinct prompts went out, one per partner');
  all(alphaCalls, 4, p => vars(p).company_name === 'Alpha Bank', 'the variables sent name the right company too');
  all(betaCalls, 4, p => vars(p).company_name === 'Beta Clinic', 'for both of them');
  all(alphaCalls, 4, p => vars(p).amount_due === '48500', 'and each row keeps its own values');
  all(betaCalls, 4, p => vars(p).appointment_time === '10:30', 'whichever kind of call it is');

  console.log('\nNOTHING WAS WRITTEN TO THE SHARED AGENT WHILE THEY RAN:');
  // The whole safety argument rests on this: a call configures itself, it does not configure the
  // agent. A PATCH here would be one partner changing the agent underneath the other, mid-call.
  const writes = other.filter(o => o.method !== 'GET');
  ok(writes.length === 0, 'no request other than the calls themselves modified the agent' + (writes.length ? ': ' + writes.map(w => w.method + ' ' + w.url).join(', ') : ''));
  ok(other.every(o => o.method === 'GET'), `the ${other.length} other requests were all reads`);

  console.log('\nWHAT IS WRITTEN TO THE SHARED AGENT BELONGS TO NOBODY IN PARTICULAR:');
  {
    // Post-call scoring lives on the agent, and the agent is shared. It used to be built from
    // whichever profile the administrator had open, so syncing on a banking profile scored the
    // clinic's appointment calls on whether the customer acknowledged an amount due.
    // Both partners are made platform admins for this section only, so each can read the spec the
    // platform would write, from their own very different profile.
    const store = require(path.join(BE, 'auth.js'));
    for (const id of ['u-alpha', 'u-beta']) {
      const u = store.findById(id);
      u.role = 'admin'; u.superAdmin = true; u.orgId = 'streebo.test'; u.org = 'streebo.test';
    }
    const a = await req('GET', '/api/elevenlabs/analysis', alpha);
    const b = await req('GET', '/api/elevenlabs/analysis', beta);
    ok(a.status === 200 && b.status === 200, 'both administrators can read the proposed analysis spec');

    const pa = a.body.proposed, pb = b.body.proposed;
    ok(!!pa && Array.isArray(pa.criteria) && pa.criteria.length === 9, `it is the nine archetypes, not one profile's use cases (${(pa.criteria || []).length})`);
    ok(JSON.stringify(pa) === JSON.stringify(pb), 'and it is IDENTICAL for a bank and a clinic \u2014 nothing of either tenant reaches it');

    const text = JSON.stringify(pa);
    ok(!/Alpha Bank|Beta Clinic/.test(text), 'no company name appears in what would be written to the agent');
    ok(!/emi_reminder|appointment_confirm/.test(text), 'nor any industry-specific use-case key');
    ok(pa.criteria.every(c => /^arch_/.test(c.id)), 'every criterion is named for an archetype: ' + pa.criteria.map(c => c.id).join(', '));

    // The second half of the fix: a criterion must not fail a call it does not apply to. The
    // webhook counts only success and failure toward goalsMet, so "unknown" is how a criterion
    // says "not my kind of call".
    ok(pa.criteria.every(c => /unknown/i.test(c.conversation_goal_prompt)), 'each criterion returns unknown for a call of a different kind');
    ok(pa.criteria.every(c => /applies ONLY to/i.test(c.conversation_goal_prompt)), 'and each one states the kind of call it covers');
    const pay = pa.criteria.find(c => c.id === 'arch_payment_reminder');
    ok(/amount due/i.test(pay.conversation_goal_prompt), 'the payment criterion still judges payment calls properly');
    ok(/not.*mark it\s*\n?\s*unsuccessful merely because it was a different kind of call/is.test(pay.conversation_goal_prompt.replace(/\s+/g, ' ')) || /do not mark it unsuccessful merely because/i.test(pay.conversation_goal_prompt.replace(/\s+/g, ' ')), 'and says plainly not to fail a call for being a different kind');
    // Put them back. A platform admin sees every organisation by design, which would quietly
    // invalidate the tenancy checks below and make them look like a leak.
    for (const [id, org] of [['u-alpha', 'alphabank.test'], ['u-beta', 'betaclinic.test']]) {
      const u = store.findById(id);
      u.role = 'user'; u.superAdmin = false; u.orgId = org; u.org = org;
    }
  }

  console.log('\nAND THE RECORDS STAY APART:');
  const ah = (await req('GET', '/api/history?limit=50', alpha)).body.calls || [];
  const bh = (await req('GET', '/api/history?limit=50', beta)).body.calls || [];
  ok(ah.length === 4 && bh.length === 4, `each partner sees only their own four calls (${ah.length} / ${bh.length})`);
  ok(ah.every(c => c.company === 'Alpha Bank'), 'stamped with the company as it was at launch');
  ok(!ah.some(c => /^Beta /.test(c.customerName || '')), 'and no trace of the other partner in the log');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})().catch(e => { console.error('ERROR', e); fail++; }).finally(async () => {
  await wait(200);
  unlinkModules(path.join(BE, 'node_modules'));
  try { fs.rmSync(ISO, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
});

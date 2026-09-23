/**
 * THE OFFER TO SWITCH LANGUAGE HAS TO BE REAL.
 *
 * A profile with Italian mirrored opened correctly ("English or Italiano?"), the customer chose
 * Italiano, and the agent answered, in Italian, that it could only speak English. The cause was not
 * the prompt and not the voice: ElevenLabs only lets `language_detection` switch into the agent's
 * own language or one listed in `language_presets`, and ours had none, so the tool replied "Invalid
 * language. Keep speaking English." and the agent obeyed.
 *
 * So before a call whose profile mirrors a language, that language has to be registered on the
 * agent. The registration carries nothing about the caller, which is what keeps it safe on an agent
 * three partners are using at once. This suite runs the server in-process against a fake ElevenLabs
 * that behaves like the real one: it refuses to switch into a language it was never told about.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { linkModules } = require('./harness.js');

const SRC = path.resolve(__dirname, '../../..');
const ISO = path.join(require('os').tmpdir(), 'omnireach-test-language');
const BE = path.join(ISO, 'web/backend');
const PORT = 3047;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── a fake agent that keeps state, so a PATCH actually changes what the next call sees ──
const agentState = {
  conversation_config: {
    agent: { language: 'en', prompt: { prompt: 'base agent prompt', built_in_tools: { language_detection: { name: 'language_detection' } } } },
    tts: { voice_id: 'voice_BASE', model_id: 'eleven_v3_conversational' },
    language_presets: { es: { overrides: {} } }      // another partner already speaks Spanish
  },
  platform_settings: { overrides: { conversation_config_override: {
    agent: { prompt: { prompt: true, llm: true }, language: true, first_message: true },
    tts: { voice_id: true, stability: true, speed: true, similarity_boost: true },
    conversation: { max_duration_seconds: true }
  } } }
};
const placed = [], patches = [];
let breakAgent = false;   // the provider having a bad day, flipped on at the end
function reply(obj, status) { const t = JSON.stringify(obj); return { ok: (status || 200) < 400, status: status || 200, json: async () => JSON.parse(t), text: async () => t }; }
function installFetchSpy(resolveFrom) {
  const nfPath = require.resolve('node-fetch', { paths: [resolveFrom] });
  const real = require(nfPath);
  const spy = async (url, opts) => {
    const u = String(url);
    if (!u.includes('api.elevenlabs.io')) return real(url, opts);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (u.includes('/convai/twilio/outbound-call')) { placed.push(body); return reply({ success: true, conversation_id: 'conv_' + placed.length }); }
    if (/\/convai\/agents\/[^/?]+$/.test(u) && breakAgent) return reply({ detail: 'agent unavailable' }, 500);
    if (/\/convai\/agents\/[^/?]+$/.test(u) && method === 'GET') return reply(agentState);
    if (/\/convai\/agents\/[^/?]+$/.test(u) && method === 'PATCH') {
      patches.push(body);
      agentState.conversation_config = { ...agentState.conversation_config, ...(body.conversation_config || {}) };
      return reply(agentState);
    }
    return reply({});
  };
  require.cache[nfPath] = { id: nfPath, filename: nfPath, loaded: true, exports: spy, children: [], paths: [] };
}
// What ElevenLabs does with a language the agent was never told about.
const canSwitchTo = code => code === agentState.conversation_config.agent.language
  || Object.keys(agentState.conversation_config.language_presets || {}).includes(code);
const switchResult = code => (canSwitchTo(code) ? `Switched to ${code}.` : 'Invalid language. Keep speaking English.');

function build() {
  fs.rmSync(ISO, { recursive: true, force: true });
  fs.mkdirSync(path.join(BE, 'data'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'web/backend'))) if (f.endsWith('.js') || f === 'package.json') fs.copyFileSync(path.join(SRC, 'web/backend', f), path.join(BE, f));
  fs.cpSync(path.join(SRC, 'web/frontend'), path.join(ISO, 'web/frontend'), { recursive: true });
  fs.cpSync(path.join(SRC, 'web/backend/ui'), path.join(BE, 'ui'), { recursive: true });
  fs.cpSync(path.join(SRC, 'config'), path.join(ISO, 'config'), { recursive: true });
  fs.cpSync(path.join(SRC, 'prompts'), path.join(ISO, 'prompts'), { recursive: true });
  linkModules(path.join(BE, 'node_modules'), path.join(SRC, 'web/backend/node_modules'));
  const auth = require(path.join(SRC, 'web/backend/auth.js'));
  const mk = (id, email, org, role) => ({ id, email, name: email.split('@')[0], org, orgId: org, role: role || 'user', superAdmin: role === 'admin', passwordHash: auth.hashPassword('Pass!2026x'), active: true, createdAt: '2026-01-01T00:00:00Z', quota: {}, usage: {} });
  fs.writeFileSync(path.join(BE, 'data/users.json'), JSON.stringify([
    mk('u-retail', 'rauf@liberty.test', 'liberty.test'),
    mk('u-admin', 'ops@streebo.test', 'streebo.test', 'admin')
  ], null, 1));
  fs.writeFileSync(path.join(BE, 'data/calls.json'), '[]');
  fs.writeFileSync(path.join(BE, 'data/guardrails.json'), JSON.stringify({ enforceQuota: false, simulationOnly: false, allowBulkForPartners: true, rateLimitPerMin: null }, null, 1));
  const env = fs.readFileSync(path.join(SRC, 'web/backend/.env'), 'utf8').split(/\r?\n/)
    .filter(l => !/^(DATABASE_URL|PORT|AUTO_SYNC_TOOLS|MAIL_PROVIDER|GRAPH_|PLATFORM_ORG|ELEVENLABS_)/.test(l)).join('\n');
  fs.writeFileSync(path.join(BE, '.env'), env + '\nDATABASE_URL=\nPORT=' + PORT +
    '\nAUTO_SYNC_TOOLS=false\nMAIL_PROVIDER=dev\nPLATFORM_ORG=streebo.test' +
    '\nELEVENLABS_API_KEY=test-key\nELEVENLABS_AGENT_ID=agent_shared\nELEVENLABS_AGENT_PHONE_NUMBER_ID=phone_shared\n');
}

const req = (method, p, token, body) => new Promise(resolve => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {})
  } }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(s) }); } catch (e) { resolve({ status: res.statusCode, body: s }); } }); });
  r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
  if (data) r.write(data); r.end();
});

const CATALOG = require(path.join(SRC, 'config/catalog/use-cases.json'));
function profileFor(company, industry, language, mirrors) {
  const use_cases = {};
  for (const u of CATALOG[industry]) use_cases[u.key] = { enabled: true, label: u.label, archetype: u.archetype, playbook: u.playbook || '', fields: u.fields || [] };
  return {
    company: { name: company, industry },
    locale: { money_scale: 'western', primary_language: language === 'en' ? 'English' : language, mirror_languages: mirrors || [] },
    agent: { name: 'Mia', llm: 'gemini-2.0-flash', demo_realism: false },
    voice: { provider: 'elevenlabs', voice_id: 'voice_' + company, language },
    contact: {}, compliance: {}, offerings: {}, use_cases
  };
}
const call = (token, ucKey, vars) => req('POST', '/api/call/single', token, { toNumber: '+393331234567', variables: { customer_name: 'Giulio Bianchi', use_case: ucKey, ...(vars || {}) } });

(async () => {
  build();
  installFetchSpy(path.join(SRC, 'web/backend'));
  process.chdir(BE);
  const server = require(path.join(BE, 'server.js'));
  await server.start();
  for (let i = 0; i < 40; i++) { const h = await req('GET', '/api/health'); if (h.status === 200) break; await wait(200); }

  const retail = (await req('POST', '/api/auth/login', null, { email: 'rauf@liberty.test', password: 'Pass!2026x' })).body.token;
  const admin = (await req('POST', '/api/auth/login', null, { email: 'ops@streebo.test', password: 'Pass!2026x' })).body.token;

  console.log('\nWHAT WENT WRONG ON THE LIVE CALL:');
  ok(!canSwitchTo('it'), 'an agent told about no languages cannot switch into Italian');
  ok(switchResult('it') === 'Invalid language. Keep speaking English.', 'the tool answers exactly as it did on the real call, and the agent then apologises and stays in English');

  console.log('\nA PROFILE THAT MIRRORS ITALIAN REGISTERS IT BEFORE DIALLING:');
  await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', ['Italian']) });
  const uc = Object.keys((await req('GET', '/api/profile', retail)).body.profile.use_cases)[0];
  const r1 = await call(retail, uc, { offer_type: 'a fibre upgrade', offer_detail: 'double the speed' });
  ok(r1.status === 200, 'the call is placed' + (r1.status === 200 ? '' : ': ' + JSON.stringify(r1.body).slice(0, 160)));
  ok(canSwitchTo('it'), 'and Italian is now a language the agent may switch into');
  ok(switchResult('it').startsWith('Switched'), 'so the customer asking for Italiano now gets Italian');
  ok(patches.length === 1, `one registration, not one per call (${patches.length})`);

  console.log('\nTHE REGISTRATION IS SAFE ON AN AGENT OTHERS ARE USING:');
  const sent = JSON.stringify(patches[0]);
  ok(/"it"\s*:/.test(sent) && /"es"\s*:/.test(sent), "it adds the new language and keeps the one another partner's calls rely on");
  ok(!/Liberty|Mia|voice_Liberty|fibre/.test(sent), 'and carries nothing about the caller: no company, no script, no voice');
  ok(/"language_presets"/.test(sent) && /"prompt"/.test(sent), 'the agent config is sent back whole, so nothing already on it is dropped');
  const base = agentState.conversation_config.agent.prompt.prompt;
  ok(base === 'base agent prompt' && agentState.conversation_config.tts.voice_id === 'voice_BASE', "the agent's own prompt and voice are untouched");
  const first = placed[0];
  const init = first.conversation_initiation_client_data || {};
  const ov = init.conversation_config_override || {};
  const dv = init.dynamic_variables || {};
  ok((ov.agent || {}).language === 'en' && (ov.tts || {}).voice_id === 'voice_Liberty Retail' && dv.company_name === 'Liberty Retail',
    'the call still carries its own language, voice and company, exactly as before');

  console.log('\nA SECOND CALL COSTS NOTHING, AND AN UNMIRRORED PROFILE NEVER TOUCHES THE AGENT:');
  await call(retail, uc, { offer_type: 'a fibre upgrade' });
  ok(patches.length === 1, 'the second Italian call registers nothing again');
  await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', []) });
  await call(retail, uc, { offer_type: 'a fibre upgrade' });
  ok(patches.length === 1, 'and a single-language campaign writes to the agent not at all');

  console.log('\nA NEW LANGUAGE ON AN EXISTING PROFILE IS PICKED UP:');
  await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', ['Italian', 'French']) });
  await call(retail, uc, { offer_type: 'a fibre upgrade' });
  ok(canSwitchTo('fr') && patches.length === 2, 'French is added the first time a call offers it');

  console.log('\nSAVING A PROFILE REGISTERS ITS LANGUAGES THERE AND THEN:');
  const patchesBefore = patches.length;
  await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', ['Italian', 'French', 'Portuguese']) });
  for (let i = 0; i < 20 && patches.length === patchesBefore; i++) await wait(100);
  ok(canSwitchTo('pt'), 'adding a language in the builder registers it without waiting for the first call');
  const saved = await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', ['Italian', 'French']) });
  ok(saved.status === 200 && saved.body.success, 'and saving still answers immediately, whatever ElevenLabs is doing');

  console.log('\nTHE RUNNING BUILD IS VISIBLE WITHOUT A SHELL ON THE SERVER:');
  const health = (await req('GET', '/api/health')).body;
  ok(typeof health.build === 'string', 'health reports the commit it is running: "' + health.build + '"');
  ok(Array.isArray(health.languages) && health.languages.includes('it'), 'and which languages the agent can switch into: ' + JSON.stringify(health.languages));

  console.log('\nADMINISTRATORS CAN SEE AND SYNC THE LOT:');
  const st = await req('GET', '/api/elevenlabs/languages/status', admin);
  ok(st.status === 200 && st.body.extra.includes('it') && st.body.extra.includes('fr'), 'status lists what the agent can switch into: ' + JSON.stringify(st.body.extra || st.body));
  const sync = await req('POST', '/api/elevenlabs/languages/sync', admin, { codes: ['de', 'it'] });
  ok(sync.status === 200 && sync.body.added.includes('de') && sync.body.already.includes('it'), 'sync adds what is missing and leaves what is there');
  const denied = await req('POST', '/api/elevenlabs/languages/sync', retail, { codes: ['ja'] });
  ok(denied.status === 403 || denied.status === 401, 'and a partner cannot reconfigure the shared agent (' + denied.status + ')');

  console.log('\nA FAILURE TO REGISTER NEVER STOPS THE CALL:');
  const before = placed.length;
  breakAgent = true;
  await req('POST', '/api/profile', retail, { profile: profileFor('Liberty Retail', 'Retail', 'en', ['Japanese']) });
  await wait(150);
  const r2 = await call(retail, uc, { offer_type: 'a fibre upgrade' });
  breakAgent = false;
  ok(!canSwitchTo('ja'), 'nothing was registered, since the agent could not be read');
  ok(r2.status === 200 && placed.length === before + 1, 'the call goes out even when the agent cannot be read, just without the switch');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });

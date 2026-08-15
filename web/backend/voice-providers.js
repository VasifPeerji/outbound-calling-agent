/**
 * Provider-agnostic voice layer.
 * ElevenLabs = primary (native voices/accents, multilingual, LLM choice, per-call overrides).
 * Retell     = fallback.
 * One interface: isConfigured, createCall, getCall, getAudio, listVoices, ping.
 * See ../../docs/PLATFORM.md for the verified API mapping.
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ── PROMPT ASSEMBLY (global + active use-case node → one system prompt) ──
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const _promptCache = {};
function readPrompt(file) {
  if (!file) return '';
  if (_promptCache[file] === undefined) {
    try { _promptCache[file] = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8'); }
    catch (e) { _promptCache[file] = ''; }
  }
  return _promptCache[file];
}
// The 9 conversation ARCHETYPES — the proven call shapes. An industry use case (e.g. Aviation's
// "flight_disruption") binds to one of these and adds its own playbook on top, so we get
// domain-specific calls without maintaining a prompt file per industry.
const USE_CASE_FILES = {
  payment_reminder: 'payment_reminder.txt',
  overdue_followup: 'overdue_followup.txt',
  sales_offer: 'sales_offer.txt',
  appointment_reminder: 'appointment_reminder.txt',
  feedback_survey: 'feedback_survey.txt',
  lead_qualification: 'lead_qualification.txt',
  renewal_retention: 'renewal_retention.txt',
  service_notification: 'service_notification.txt',
  document_collection: 'document_collection.txt'
};
// Which archetype drives this use case. Plain archetype keys (older profiles/presets) map to themselves.
function resolveArchetype(useCase, profile) {
  const uc = (profile && profile.use_cases && profile.use_cases[useCase]) || {};
  const arch = uc.archetype || useCase;
  return USE_CASE_FILES[arch] ? arch : (USE_CASE_FILES[useCase] ? useCase : 'sales_offer');
}
// Unlike Retell (where the transition is a separate graph edge), ElevenLabs drives ending from the
// system prompt + end_call tool — so we fold the node's end-call rule into the assembled prompt.
// Order matters: global rules → archetype mechanics → this industry's playbook → the end-call rule.
// The playbook sits after the node so it specialises the generic flow rather than being overridden.
function assemblePrompt(useCase, profile) {
  const sep = '\n\n\n' + '='.repeat(60) + '\n\n\n';
  const arch = resolveArchetype(useCase, profile);
  const g = readPrompt('global_prompt.txt');
  const n = readPrompt(USE_CASE_FILES[arch]);
  const t = readPrompt(USE_CASE_FILES[arch].replace(/\.txt$/, '_transition.txt'));
  const parts = [g, n];
  const uc = (profile && profile.use_cases && profile.use_cases[useCase]) || {};
  if (uc.playbook) {
    parts.push(`## THIS SPECIFIC CALL — ${uc.label || useCase}\n\n${uc.playbook}\n\n` +
      `This is the goal of THIS call. Where it differs from the general flow above, follow this.`);
  }
  const know = buildKnowledgeBlock(profile);
  if (know) parts.push(know);
  if (t) parts.push('## WHEN TO END THIS CALL (end_call rule)\n\n' + t);
  return parts.filter(Boolean).join(sep);
}

// What this company has authorised the agent to state as fact, and the boundary around it.
// Without this the agent can only deflect: a customer asking whether the plywood is FSC certified
// gets "I'll have a specialist call you", which on a sales call is the moment you lose them.
function buildKnowledgeBlock(profile) {
  const k = (profile && profile.knowledge) || {};
  const facts = (k.facts || []).filter(Boolean);
  const faqs = (k.faqs || []).filter(f => f && f.q && f.a);
  const company = ((profile || {}).company || {}).short_name || ((profile || {}).company || {}).name || 'the company';

  const out = [`## WHAT YOU KNOW, AND WHAT YOU MUST NOT INVENT`];

  if (facts.length) {
    out.push(`### Facts about ${company} you may state directly\n\n` +
      facts.map(f => '- ' + f).join('\n') +
      `\n\nThese are confirmed and current. Say them plainly and confidently, in your own words, the way a\n` +
      `colleague who knows the product would. Do not read them out as a list, do not say "according to my\n` +
      `information", and do not hedge on something that is written here.`);
  }
  if (faqs.length) {
    out.push(`### Questions you will be asked, and the approved answers\n\n` +
      faqs.map(f => `**They ask:** ${f.q}\n**You answer:** ${f.a}`).join('\n\n') +
      `\n\nThese are the company's own answers. Use them as the substance, but say them naturally and fit them\n` +
      `to how the person actually asked. Never recite one word for word if it does not match their question.`);
  }

  out.push(`### When you are asked something that is NOT covered above

Do not simply hand every question to a specialist. That is what makes an agent feel useless, and a
customer who has asked three questions and been deflected three times is a customer you have lost.

1. **Answer the part you do know.** If they ask about certification, thickness and wet-area
   suitability and you only hold the thicknesses, give them the thicknesses properly first.
2. **Then be straight about the rest.** "The exact treatment code I'd want to confirm rather than
   guess at" is honest and competent. "I don't have that information" is neither, and it is what a
   script says.
3. **Then make the handover worth something.** Offer the specialist with a reason and a time, not as
   a way of ending the topic. Tell them what the specialist will be able to confirm.
4. **Never invent a fact to fill the gap.** Not a certification, not a code, not a standard, not a
   lead time, not a price. A confident wrong answer about a building product is worse than no answer.

### The hard boundary — these ALWAYS go to a human, even if something above seems to cover it

- Whether a specific product is **safe or compliant for their particular job**: load, span, fire,
  weather exposure, structural or wet-area suitability. You may state what the specification says.
  You may never say it will be fine for what they are building.
- **Certification, standards or approval claims** you cannot see in the facts above.
- **Medical, legal, tax or regulatory positions.**
- Anything **financially binding**: a final price, a discount beyond the offer you were given, a
  credit decision, a settlement, a refund, an eligibility ruling.
- Anything a customer could **act on to their cost or their harm** if you were wrong.

Saying "that one I'd want our technical team to confirm for your specific job, because getting it
wrong on site is expensive" is not a weak answer. It is the answer a good professional gives, and
customers trust it more than false certainty.`);

  return (facts.length || faqs.length) ? out.join('\n\n') : out.join('\n\n');
}

function mapElStatus(s) {
  s = (s || '').toString().toLowerCase();
  if (['done', 'ended', 'completed', 'success'].includes(s)) return 'ended';
  if (['in-progress', 'in_progress', 'ongoing'].includes(s)) return 'ongoing';
  if (s === 'processing') return 'processing';
  if (['failed', 'error'].includes(s)) return 'error';
  if (['initiated', 'registered', 'queued'].includes(s)) return 'registered';
  return s;
}

// Read which overrides the agent actually allows, so we only send permitted fields and never trigger
// an "Override for field '…' is not allowed by config" failure. Cached briefly (config rarely changes).
const _allowedCache = {};
async function fetchAllowedOverrides(e) {
  if (!e || !e.apiKey || !e.agentId) return null;
  const c = _allowedCache[e.agentId];
  if (c && (Date.now() - c.ts) < 120000) return c.data;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    if (!r.ok) { _allowedCache[e.agentId] = { data: null, ts: Date.now() }; return null; }
    const d = await r.json();
    const data = ((d.platform_settings || {}).overrides || {}).conversation_config_override || null;
    _allowedCache[e.agentId] = { data, ts: Date.now() };
    return data;
  } catch (x) { return null; }
}
function digBool(o, path) { return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o) === true; }

// ── ELEVENLABS ADAPTER ──
const elevenlabs = {
  name: 'elevenlabs',
  isConfigured(config) { const e = config.elevenlabs || {}; return !!(e.apiKey && e.agentId && e.agentPhoneNumberId); },

  async createCall({ toNumber, dynamicVars, prompt, llm, language, firstMessage, voice, config, maxDurationSeconds }) {
    const e = config.elevenlabs || {};
    // Only send overrides the agent permits. Defaults (when the config can't be read) send the
    // essentials but not the fine tuning knobs, which is the safe combination.
    const allowed = await fetchAllowedOverrides(e);
    const ok = (path, dflt) => allowed ? digBool(allowed, path) : dflt;

    const agent = {};
    const ap = {};
    if (prompt && ok('agent.prompt.prompt', true)) ap.prompt = prompt;
    if (llm && ok('agent.prompt.llm', true)) ap.llm = llm;
    if (Object.keys(ap).length) agent.prompt = ap;
    if (language && ok('agent.language', true)) agent.language = language;
    if (firstMessage && ok('agent.first_message', true)) agent.first_message = firstMessage;

    const tts = {};
    if (voice && voice.voice_id && ok('tts.voice_id', true)) tts.voice_id = voice.voice_id;
    // Voice tuning: sent when enabled (Settings) AND the agent allows it — so it never hard-fails.
    if (e.sendVoiceTuning !== false) {
      if (voice && isNum(voice.stability) && ok('tts.stability', false)) tts.stability = voice.stability;
      if (voice && isNum(voice.speed) && ok('tts.speed', false)) tts.speed = voice.speed;
      if (voice && isNum(voice.similarity_boost) && ok('tts.similarity_boost', false)) tts.similarity_boost = voice.similarity_boost;
    }
    // Cap THIS call at the caller's remaining daily talk time. ElevenLabs enforces the limit itself
    // and ends the conversation there, so the budget holds without us having to watch the call or
    // reach for Twilio to hang it up. Default false: this override ships disabled on a fresh agent,
    // so until it is switched ON **and the agent republished** the cap is silently dropped and the
    // agent's own global max_duration_seconds applies instead.
    const conversation = {};
    if (isNum(maxDurationSeconds) && maxDurationSeconds > 0 && ok('conversation.max_duration_seconds', false)) {
      conversation.max_duration_seconds = Math.round(maxDurationSeconds);
    }

    const override = {};
    if (Object.keys(agent).length) override.agent = agent;
    if (Object.keys(tts).length) override.tts = tts;
    if (Object.keys(conversation).length) override.conversation = conversation;

    const body = {
      agent_id: e.agentId,
      agent_phone_number_id: e.agentPhoneNumberId,
      to_number: toNumber,
      call_recording_enabled: true,
      conversation_initiation_client_data: {
        dynamic_variables: dynamicVars || {},
        conversation_config_override: override
      }
    };
    const r = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.success === false) throw new Error(elErr(data) || `ElevenLabs error ${r.status}`);
    return { providerCallId: data.conversation_id, raw: data };
  },

  async getCall(callId, config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${callId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `ElevenLabs error ${r.status}`);
    const md = d.metadata || {};
    const an = d.analysis || {};
    const transcript = Array.isArray(d.transcript)
      ? d.transcript.map(t => `${t.role === 'agent' ? 'Agent' : 'User'}: ${t.message || t.text || ''}`).filter(x => x.length > 7).join('\n')
      : (typeof d.transcript === 'string' ? d.transcript : '');
    let successful;
    if (an.call_successful === 'success') successful = true;
    else if (an.call_successful === 'failure') successful = false;
    return {
      call_status: mapElStatus(d.status),
      has_audio: !!d.has_audio,
      recording_url: '',
      transcript,
      duration_ms: md.call_duration_secs ? md.call_duration_secs * 1000 : null,
      disconnection_reason: md.termination_reason || '',
      summary: an.transcript_summary || an.call_summary || '',
      user_sentiment: '',
      call_successful: successful
    };
  },

  async getAudio(callId, config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${callId}/audio`, { headers: { 'xi-api-key': e.apiKey } });
    if (!r.ok) throw new Error(`ElevenLabs audio error ${r.status}`);
    return { contentType: r.headers.get('content-type') || 'audio/mpeg', stream: r.body };
  },

  async listVoices(config, filters = {}) {
    const e = config.elevenlabs || {};
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `ElevenLabs error ${r.status}`);
    let voices = (d.voices || []).map(v => {
      const l = v.labels || {};
      return normaliseVoice({
        voice_id: v.voice_id, name: v.name,
        accent: l.accent, gender: l.gender, age: l.age,
        language: l.language || l.locale, locale: l.locale,
        use_case: l.use_case || l['use case'], descriptive: l.descriptive || l.description,
        category: v.category, preview_url: v.preview_url, description: v.description
      }, { library: false });
    });
    if (filters.gender) voices = voices.filter(v => (v.gender || '').toLowerCase() === filters.gender.toLowerCase());
    if (filters.accent) voices = voices.filter(v => (v.accent || '').toLowerCase().includes(filters.accent.toLowerCase()));
    if (filters.q) { const q = String(filters.q).toLowerCase(); voices = voices.filter(v => v.search.includes(q)); }
    return voices;
  },

  // The public Voice Library — 15,000+ voices, i.e. everything the ElevenLabs "Explore" tab shows.
  // It is far too large to hold in the browser, so search, filtering and paging all happen here and
  // the console asks for one page at a time, exactly like ElevenLabs' own picker.
  async listLibraryVoices(config, f = {}) {
    const e = config.elevenlabs || {};
    const qs = new URLSearchParams();
    qs.set('page_size', String(Math.min(Math.max(parseInt(f.pageSize, 10) || 30, 1), 100))); // API hard-caps at 100
    qs.set('page', String(Math.max(parseInt(f.page, 10) || 0, 0)));
    const pass = { search: 'search', gender: 'gender', accent: 'accent', age: 'age', category: 'category',
                   language: 'language', useCase: 'use_cases', descriptive: 'descriptives', sort: 'sort' };
    Object.entries(pass).forEach(([k, param]) => { if (f[k]) qs.set(param, String(f[k])); });
    if (f.featured === true || f.featured === 'true') qs.set('featured', 'true');
    const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${qs}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `ElevenLabs error ${r.status}`);
    return {
      voices: (d.voices || []).map(v => normaliseVoice(v, { library: true })),
      hasMore: !!d.has_more,
      total: typeof d.total_count === 'number' ? d.total_count : null
    };
  },

  // A library voice cannot be spoken until it lives in the workspace: ElevenLabs validates voice_id
  // against your own voices and rejects a library id outright ("voice_not_found"), both for calls and
  // for the agent config. So picking from Explore has to copy the voice across first.
  async addLibraryVoice(config, { publicOwnerId, voiceId, name }) {
    const e = config.elevenlabs || {};
    if (!publicOwnerId || !voiceId) throw new Error('That library voice is missing its owner id, so it cannot be added.');
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/add/${encodeURIComponent(publicOwnerId)}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: String(name || 'Library voice').slice(0, 100) })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = elErr(d) || `ElevenLabs error ${r.status}`;
      // The single most likely failure, and one nobody can diagnose from "401 unauthorized".
      if (/add_voice_from_voice_library/i.test(msg) || (r.status === 401 && /permission/i.test(msg))) {
        // Adding a library voice is a WRITE against Voices. A key set up only to LIST voices —
        // which is all this platform needed until now — is read-only and will fail here.
        const err = new Error('This ElevenLabs API key can read voices but not add them. In ElevenLabs go to Settings → API Keys, edit this key, and set Voices to "Write" (the options are No Access / Read / Write; Write is what grants add_voice_from_voice_library). Then reload voices here. Browsing and previewing need no change.');
        err.code = 'library_add_forbidden';
        throw err;
      }
      if (/limit|quota|slots/i.test(msg)) {
        const err = new Error(`ElevenLabs would not add the voice: ${msg}. Your plan's voice slots are full — remove a voice in ElevenLabs, or pick one from My Voices instead.`);
        err.code = 'voice_limit';
        throw err;
      }
      throw new Error(msg);
    }
    // The workspace copy gets its own id; the library id is not usable for calls.
    return { voice_id: d.voice_id || voiceId };
  },

  // ── ACTION TOOLS ──────────────────────────────────────
  // The agent can only DO something if the tool exists in ElevenLabs and is attached to the agent.
  // Ours were never created, so for months the agent has been promising callbacks and do-not-call
  // requests that went nowhere: it spoke the words and nothing was recorded. This creates them,
  // keeps their URLs current, and attaches them.
  async listTools(config) {
    const e = config.elevenlabs || {};
    const r = await fetch('https://api.elevenlabs.io/v1/convai/tools', { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not list tools (${r.status}).`);
    return (d.tools || []).map(t => ({ id: t.id || t.tool_id, name: (t.tool_config || {}).name || '', url: (((t.tool_config || {}).api_schema) || {}).url || '' }));
  },

  // Turn our own tool spec into the shape ElevenLabs wants.
  _toolBody(spec, url, secret) {
    const properties = {};
    Object.entries(spec.parameters || {}).forEach(([k, v]) => { properties[k] = { type: v.type || 'string', description: v.description || k }; });
    const api_schema = {
      url, method: 'POST',
      request_body_schema: { type: 'object', description: spec.description || spec.name, properties, required: spec.required || [] }
    };
    if (secret) api_schema.request_headers = { 'x-tool-secret': secret };
    return { tool_config: { type: 'webhook', name: spec.name, description: spec.description || spec.name, response_timeout_secs: 20, api_schema } };
  },

  // Idempotent: create what is missing, update what has drifted, leave the rest alone. Re-running
  // after a deploy is how all 14 URLs move to the new host in one click.
  async syncTools(config, { specs, baseUrl, secret }) {
    const e = config.elevenlabs || {};
    const H = { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' };
    const existing = await this.listTools(config);
    const byName = Object.fromEntries(existing.map(t => [t.name, t]));
    const result = { created: [], updated: [], unchanged: [], failed: [], ids: [] };

    for (const spec of specs) {
      const url = `${baseUrl.replace(/\/+$/, '')}/api/agent-tool/${spec.name}`;
      const body = this._toolBody(spec, url, secret);
      const found = byName[spec.name];
      try {
        if (!found) {
          const r = await fetch('https://api.elevenlabs.io/v1/convai/tools', { method: 'POST', headers: H, body: JSON.stringify(body) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(elErr(d) || `create failed (${r.status})`);
          result.created.push(spec.name); result.ids.push(d.id || d.tool_id);
        } else if (found.url !== url) {
          const r = await fetch(`https://api.elevenlabs.io/v1/convai/tools/${found.id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
          if (!r.ok) throw new Error(elErr(await r.json().catch(() => ({}))) || `update failed (${r.status})`);
          result.updated.push(spec.name); result.ids.push(found.id);
        } else { result.unchanged.push(spec.name); result.ids.push(found.id); }
      } catch (err) { result.failed.push({ name: spec.name, error: err.message }); }
    }
    return result;
  },

  // Attach by id. Read-modify-write the whole prompt block, because a bare PATCH of tool_ids would
  // drop built_in_tools (end_call, language_detection) and undo the call-ending fix.
  async attachTools(config, toolIds) {
    const e = config.elevenlabs || {};
    const H = { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' };
    const g = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: H });
    const agent = await g.json().catch(() => ({}));
    if (!g.ok) throw new Error(elErr(agent) || `Could not read the agent (${g.status}).`);
    const cc = agent.conversation_config || {};
    const prompt = (cc.agent || {}).prompt || {};
    // The agent carries a deprecated inline `tools` array alongside `tool_ids`, and ElevenLabs
    // rejects a payload containing both ("Cannot specify both tools and tool IDs"). Carrying the
    // whole prompt block forward is right for everything else, so drop just that one key.
    const { tools: _deprecatedInlineTools, ...promptRest } = prompt;
    const body = { conversation_config: { ...cc, agent: { ...(cc.agent || {}), prompt: { ...promptRest, tool_ids: toolIds } } } };
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not attach the tools (${r.status}).`);
    const after = (((d.conversation_config || {}).agent || {}).prompt) || {};
    return { attached: (after.tool_ids || []).length, builtIn: Object.keys(after.built_in_tools || {}).filter(k => after.built_in_tools[k]) };
  },

  async getAttachedTools(config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not read the agent (${r.status}).`);
    const p = (((d.conversation_config || {}).agent || {}).prompt) || {};
    return { toolIds: p.tool_ids || [], builtIn: Object.keys(p.built_in_tools || {}).filter(k => p.built_in_tools[k]) };
  },

  // Every model and the languages it can speak, straight from ElevenLabs. This is the one source
  // that cannot go stale: when they add a language or a model, this reports it without anyone
  // editing a catalogue. Needs `models_read` on the key; without it the shipped list stands in.
  async getModelLanguages(config) {
    const e = config.elevenlabs || {};
    const r = await fetch('https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const err = new Error(elErr(d) || `ElevenLabs error ${r.status}`); err.code = r.status === 401 ? 'models_read_missing' : 'models_error'; throw err; }
    const models = {}, names = {};
    (Array.isArray(d) ? d : d.models || []).forEach(m => {
      const langs = (m.languages || []).map(l => String(l.language_id || '').toLowerCase()).filter(Boolean);
      if (!langs.length) return;
      models[m.model_id] = langs;
      (m.languages || []).forEach(l => { if (l.language_id && l.name) names[String(l.language_id).toLowerCase()] = l.name; });
    });
    return { models, names, count: Object.keys(names).length };
  },

  // Which TTS engine the agent is actually running. There is no per-call override for it, so the
  // console can only report what is set — but reporting the real value beats warning in the
  // abstract, especially when a language the engine cannot speak fails silently on a live call.
  async getAgentEngine(config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not read the agent (${r.status}).`);
    const tts = (d.conversation_config || {}).tts || {};
    return { model_id: tts.model_id || '', voice_id: tts.voice_id || '', name: d.name || '' };
  },

  // Push automatic call scoring + structured extraction onto the agent.
  // ElevenLabs then evaluates EVERY conversation against these criteria and pulls the named fields
  // out of the transcript itself — so a call is scored and mined even when the agent forgot to call
  // a tool, which is the usual reason outcome data goes missing.
  async updateAnalysis(config, { criteria, dataCollection }) {
    const e = config.elevenlabs || {};
    if (!e.apiKey || !e.agentId) throw new Error('ElevenLabs is not configured.');
    const cur = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const curJson = await cur.json().catch(() => ({}));
    if (!cur.ok) throw new Error(elErr(curJson) || `Could not read the agent (${cur.status}).`);
    const platform = curJson.platform_settings || {};
    const body = {
      platform_settings: {
        ...platform,
        evaluation: { ...(platform.evaluation || {}), criteria: criteria || [] },
        data_collection: dataCollection || {}
      }
    };
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, {
      method: 'PATCH', headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Update failed (${r.status}).`);
    const saved = (d.platform_settings || {});
    return { criteria: ((saved.evaluation || {}).criteria || []).length, fields: Object.keys(saved.data_collection || {}).length };
  },

  // Read the settings that decide whether — and how — a call can actually end.
  // These live on the AGENT, not in the prompt, and they are the usual reason a call either hangs
  // open forever (end_call disabled) or drops unexpectedly (an auto-end tool firing on its own).
  async getCallEndingConfig(config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not read the agent (${r.status}).`);
    const conv = d.conversation_config || {};
    const built = ((conv.agent || {}).prompt || {}).built_in_tools || {};
    const on = (t) => !!built[t];
    return {
      endCallEnabled: on('end_call'),
      voicemailDetection: on('voicemail_detection'),
      languageDetection: on('language_detection'),
      skipTurn: on('skip_turn'),
      transferToNumber: on('transfer_to_number'),
      turnTimeout: (conv.turn || {}).turn_timeout,
      silenceEndCallTimeout: (conv.turn || {}).silence_end_call_timeout,
      maxDurationSeconds: (conv.conversation || {}).max_duration_seconds
    };
  },

  // Apply the settings that let the agent hang up properly, without letting anything hang up FOR it.
  async updateCallEndingConfig(config, opts = {}) {
    const e = config.elevenlabs || {};
    const cur = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await cur.json().catch(() => ({}));
    if (!cur.ok) throw new Error(elErr(d) || `Could not read the agent (${cur.status}).`);
    const conv = d.conversation_config || {};
    const agent = conv.agent || {};
    const prompt = agent.prompt || {};
    const built = { ...(prompt.built_in_tools || {}) };

    // end_call ON: without it the agent physically cannot hang up, whatever the prompt says.
    if (opts.enableEndCall !== false) built.end_call = built.end_call || { name: 'end_call', description: '' };
    // language_detection ON: the opener asks which language they'd prefer, and without this tool the
    // agent cannot actually switch — the offer would be hollow.
    if (opts.enableLanguageDetection !== false) built.language_detection = built.language_detection || { name: 'language_detection', description: '' };
    // Everything that can end or divert a call on its own stays OFF unless explicitly asked for —
    // an auto-trigger is what ends a call when nobody has spoken.
    if (opts.disableAutoEnders !== false) { built.voicemail_detection = null; built.skip_turn = null; }

    const body = {
      conversation_config: {
        ...conv,
        agent: { ...agent, prompt: { ...prompt, built_in_tools: built } },
        turn: { ...(conv.turn || {}), turn_timeout: opts.turnTimeout != null ? opts.turnTimeout : (conv.turn || {}).turn_timeout,
                silence_end_call_timeout: opts.silenceEndCallTimeout != null ? opts.silenceEndCallTimeout : (conv.turn || {}).silence_end_call_timeout },
        conversation: { ...(conv.conversation || {}), max_duration_seconds: opts.maxDurationSeconds != null ? opts.maxDurationSeconds : (conv.conversation || {}).max_duration_seconds }
      }
    };
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, {
      method: 'PATCH', headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(out) || `Update failed (${r.status}).`);
    return this.getCallEndingConfig(config);
  },

  // What the agent is currently configured to evaluate and extract.
  async getAnalysisConfig(config) {
    const e = config.elevenlabs || {};
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${e.agentId}`, { headers: { 'xi-api-key': e.apiKey } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(elErr(d) || `Could not read the agent (${r.status}).`);
    const p = d.platform_settings || {};
    return { criteria: (p.evaluation || {}).criteria || [], dataCollection: p.data_collection || {}, name: d.name || '' };
  },

  async ping(config) {
    const e = config.elevenlabs || {};
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': e.apiKey } });
    if (!r.ok) throw new Error(`Invalid ElevenLabs API key (${r.status}).`);
    const d = await r.json().catch(() => ({}));
    return { ok: true, detail: `${(d.voices || []).length} voice(s) available` };
  }
};
function isNum(x) { return typeof x === 'number' && !isNaN(x); }
function elErr(d) { if (!d) return ''; if (typeof d.detail === 'string') return d.detail; if (d.detail && d.detail.message) return d.detail.message; return d.message || ''; }

// Workspace voices and library voices arrive in two different shapes. One normaliser means the
// console renders a single kind of row and every filter behaves the same across both tabs.
const tidy = (s) => String(s || '').trim();
function normaliseVoice(v, { library }) {
  const useCase = tidy(v.use_case).replace(/_/g, ' ');
  const age = tidy(v.age).replace(/[_-]/g, ' '); // the library ships both middle_aged and middle-aged
  const langs = Array.isArray(v.verified_languages)
    ? [...new Set(v.verified_languages.map(l => tidy(l.language || l.locale)).filter(Boolean))]
    : [];
  return {
    voice_id: v.voice_id, name: tidy(v.name),
    accent: tidy(v.accent), gender: tidy(v.gender), age,
    language: tidy(v.language), locale: tidy(v.locale),
    use_case: useCase, descriptive: tidy(v.descriptive),
    category: tidy(v.category).replace(/_/g, ' '),
    description: tidy(v.description).slice(0, 400),
    preview_url: tidy(v.preview_url),
    library: !!library,
    public_owner_id: library ? tidy(v.public_owner_id) : '',
    // The library tells us which of its voices are already in the workspace, so Explore can show
    // "in your voices" instead of offering to add something twice.
    in_workspace: library ? !!v.is_added_by_user : true,
    cloned_by_count: typeof v.cloned_by_count === 'number' ? v.cloned_by_count : null,
    featured: !!v.featured,
    verified_languages: langs,
    // Conversational voices are the ones that hold up on a phone call; narration voices sound like
    // an audiobook. The console surfaces this so the right voice is easy to find.
    conversational: /conversational|customer|support|social/i.test(useCase + ' ' + tidy(v.name)),
    // One lowercase haystack so a search box can match on anything at all.
    search: [v.name, v.accent, v.gender, age, v.language, v.locale, useCase, v.descriptive, v.category, langs.join(' ')]
      .filter(Boolean).join(' ').toLowerCase()
  };
}

// The library's own filter vocabularies, measured from a 2,500-voice sample of the live library
// rather than guessed, with the counts that justified the ordering. Accent has a long tail of 141
// values, so the console lists the ones that actually carry voices and lets search reach the rest.
// The library's `language` filter only knows the languages the OLDER models were verified against
// (measured from verified_languages across 1,200 library voices). Filtering it by, say, Slovenian
// returns nothing at all - not because no voice can speak Slovenian, but because on v3 the ENGINE
// supplies the language and the library metadata predates it. The console needs this list so it
// never offers a filter that can only ever come back empty.
const LIBRARY_FILTERABLE_LANGUAGES = ['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fil', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'tr', 'uk', 'vi', 'zh'];

const LIBRARY_FACETS = {
  languages: LIBRARY_FILTERABLE_LANGUAGES,
  gender: ['male', 'female', 'neutral'],
  age: ['young', 'middle_aged', 'old'],
  category: ['professional', 'high_quality'],
  use_case: ['conversational', 'narrative_story', 'social_media', 'informative_educational', 'advertisement', 'characters_animation', 'entertainment_tv'],
  descriptive: ['calm', 'confident', 'casual', 'professional', 'pleasant', 'deep', 'upbeat', 'classy', 'chill', 'gentle', 'crisp', 'formal', 'excited', 'neutral', 'mature', 'serious', 'relaxed', 'soft', 'wise', 'cute', 'modulated', 'raspy', 'husky', 'whispery', 'meditative', 'sassy', 'intense', 'hyped'],
  accent: ['american', 'british', 'standard', 'indian', 'australian', 'canadian', 'irish', 'south african', 'nigerian', 'african american', 'us southern', 'us midwest', 'us northeast', 'received pronunciation', 'new zealand', 'scottish', 'welsh',
           'brazilian', 'latin american', 'mexican', 'peninsular', 'colombian', 'argentine', 'spanish', 'portuguese',
           'parisian', 'quebec', 'german', 'italian', 'dutch', 'swedish', 'polish', 'russian', 'moscow', 'ukrainian', 'turkish', 'istanbul', 'greek',
           'arabic', 'modern standard', 'egyptian', 'gulf', 'levantine', 'moroccan', 'jordanian', 'omani', 'kuwaiti',
           'seoul', 'kanto', 'beijing mandarin', 'taiwan mandarin', 'filipino', 'malay', 'indonesian',
           'marathi', 'gujarati', 'tamil', 'bengali', 'punjabi', 'african', 'creole', 'southern', 'northern']
};

// ── RETELL ADAPTER (fallback) ──
const retell = {
  name: 'retell',
  isConfigured(config) { const e = config.retell || {}; return !!(e.apiKey && e.agentId && e.fromNumber); },

  async createCall({ toNumber, dynamicVars, config }) {
    const e = config.retell || {};
    // Retell's prompt lives in its own Conversation Flow agent; we pass only dynamic variables.
    const body = { from_number: e.fromNumber, to_number: toNumber, override_agent_id: e.agentId, retell_llm_dynamic_variables: dynamicVars || {}, metadata: { source: 'omnireach_voice_console' } };
    const r = await fetch('https://api.retellai.com/v2/create-phone-call', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.apiKey}` }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || `Retell error ${r.status}`);
    return { providerCallId: d.call_id, raw: d };
  },

  async getCall(callId, config) {
    const e = config.retell || {};
    const r = await fetch(`https://api.retellai.com/v2/get-call/${callId}`, { headers: { Authorization: `Bearer ${e.apiKey}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || `Retell error ${r.status}`);
    const dur = (d.start_timestamp && d.end_timestamp) ? d.end_timestamp - d.start_timestamp : null;
    const an = d.call_analysis || {};
    return { call_status: d.call_status || '', has_audio: !!d.recording_url, recording_url: d.recording_url || '', transcript: d.transcript || '', duration_ms: dur, disconnection_reason: d.disconnection_reason || '', summary: an.call_summary || '', user_sentiment: an.user_sentiment || '', call_successful: an.call_successful, public_log_url: d.public_log_url || '' };
  },

  async getAudio() { throw new Error('Retell recordings are served via a direct URL, not the audio proxy.'); },
  async listVoices() { return []; },
  async listLibraryVoices() { return { voices: [], hasMore: false, total: 0 }; },
  async addLibraryVoice() { throw new Error('The voice library is an ElevenLabs feature. Switch the provider to ElevenLabs to use it.'); },
  async ping(config) {
    const e = config.retell || {};
    const r = await fetch('https://api.retellai.com/list-agents', { headers: { Authorization: `Bearer ${e.apiKey}` } });
    if (!r.ok) throw new Error(`Invalid Retell API key (${r.status}).`);
    const d = await r.json().catch(() => ([]));
    return { ok: true, detail: `${Array.isArray(d) ? d.length : 0} agent(s) found` };
  }
};

const ADAPTERS = { elevenlabs, retell };
function getProvider(name) { return ADAPTERS[name] || elevenlabs; }

module.exports = { getProvider, assemblePrompt, ADAPTERS, LIBRARY_FACETS };

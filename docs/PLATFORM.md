# Platform architecture — ElevenLabs-first, provider-agnostic

**Decision:** the voice layer is **provider-agnostic** behind one adapter interface. **ElevenLabs
Conversational AI is the primary provider** (native voices, region accents, multilingual, LLM
choice, expressiveness); **Retell is the fallback**. The whole config/composable layer (profiles,
presets, Agent Builder) is platform-neutral and drives either.

Verified against the ElevenLabs docs (July 2026) — see Sources at the bottom.

---

## Why ElevenLabs is primary

- **Native voices + region accents** — accent = the voice, and ElevenLabs *is* the voice engine, so the accent-drift we hit when Retell streamed to ElevenLabs disappears.
- **Multilingual** — language is set per call.
- **LLM choice** — Gemini (2.0 Flash, 3.1-flash-lite), Claude, OpenAI, or a **custom OpenAI-compatible** endpoint (Groq, Together, self-host).
- **Dynamic variables** — our Company-Profile → variables model passes straight through.
- **Per-call overrides** — one agent can *become* any company/voice/language/LLM at call time.

---

## The key unlock: one agent, everything overridden per call

We do **not** need one ElevenLabs agent per industry/company/voice. A **single** agent is
reconfigured per call through overrides, so the composable Agent Builder maps 1:1:

| Our config | ElevenLabs field (per call) |
|---|---|
| flattened Company Profile | `conversation_initiation_client_data.dynamic_variables` |
| assembled prompt (global + active use case) | `conversation_config_override.agent.prompt.prompt` |
| chosen LLM | `conversation_config_override.agent.prompt.llm` |
| language | `conversation_config_override.agent.language` |
| voice / accent / gender → `voice_id` | `conversation_config_override.tts.voice_id` |
| expressiveness | `conversation_config_override.tts.stability / speed / similarity_boost` |
| first line | `conversation_config_override.agent.first_message` |

---

## Verified API surface (auth: `xi-api-key` header)

**Outbound call** — `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call`
- Required: `agent_id`, `agent_phone_number_id`, `to_number`
- Optional: `conversation_initiation_client_data` { `dynamic_variables`, `conversation_config_override` { `agent`{ `prompt`{ `prompt`, `llm` }, `first_message`, `language` }, `tts`{ `voice_id`, `stability`, `speed`, `similarity_boost` } } }, `call_recording_enabled`, `telephony_call_config`{ `ringing_timeout_secs` }
- Returns: `success`, `message`, `conversation_id`, `callSid`

**Batch calling** — for bulk campaigns (Twilio/SIP), phone_number + dynamic-variable columns.

**Voices** — `GET /v1/voices` (filter by `accent`, `gender`, `language`, `age` labels); shared library `GET /v1/shared-voices`. Powers the accent / gender / voice pickers.

**Conversations (history + recordings)**
- `GET /v1/convai/conversations?agent_id=…` — list
- `GET /v1/convai/conversations/{conversation_id}` — status, metadata, transcript, `has_audio`
- `GET /v1/convai/conversations/{conversation_id}/audio` — the recording

---

## Provider adapter interface (backend)

```
createCall(toNumber, dynamicVars, overrides) -> { callId, providerCallId }
getCall(callId) -> { status, recordingUrl|audio, transcript, durationMs, summary }
listConversations(limit) -> [...]
listVoices({accent,gender,language}) -> [{ voice_id, name, labels }]
```
- `elevenlabsAdapter` — the endpoints above; overrides carry voice/language/llm/prompt.
- `retellAdapter` — the existing Retell logic (fallback).
The active provider is chosen by the profile (`voice.provider`) or a global setting.

---

## One-time setup (per Retell/ElevenLabs account)

**ElevenLabs:**
1. Create one Conversational AI **agent**; paste our global prompt as its system prompt (per-call override supplies the rest).
2. Connect a **Twilio phone number** → note the `agent_phone_number_id`.
3. In the agent's **Security / Overrides** settings, **enable overrides** for: system prompt, first message, language, voice, LLM, and TTS params. *(Overrides are OFF by default; without this, per-call voice/language/LLM won't apply.)*
4. Get the `xi-api-key`.
5. Put `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` in the backend `.env` (or the Settings screen).

---

## Use cases: 9 archetypes × 23 industries

An outbound call has a **shape** (the conversation mechanics) and a **subject** (what this industry
actually calls people about). We separate the two, so every industry gets calls that sound native to it
without maintaining a prompt file per industry.

- **9 archetypes** live in `/prompts` as full conversation nodes + end-call rules: `payment_reminder`,
  `overdue_followup`, `sales_offer`, `appointment_reminder`, `feedback_survey`, `lead_qualification`,
  `renewal_retention`, plus **`service_notification`** (a disruption, outage, recall or schedule change,
  with options and accountability) and **`document_collection`** (chasing what is blocking an
  application or claim).
- **143 industry use cases** live in `config/catalog/use-cases.json`, roughly six per industry. Each names
  a real call ("Flight Disruption", "Disconnection Warning", "Crop Advisory"), binds to one archetype,
  and carries its own `label`, `desc`, **`playbook`** and input `fields`.

`assemblePrompt(useCase, profile)` composes: **global rules → archetype node → this call's playbook →
end-call rule.** The playbook sits after the node so it specialises the generic flow rather than being
drowned by it.

The composed profile is **self-contained**: label, archetype, playbook and fields are copied into
`profile.use_cases`, so the backend and console never need the catalog at call time and a customised use
case travels with the profile. History and analytics key off the **industry** name
(`flight_disruption`), while routing, simulation and prompt assembly resolve the **archetype**.
Older profiles that use bare archetype keys keep working unchanged.

**Adding an industry or a use case is a JSON edit, no code.** The Agent Builder reads the catalog and
shows a tick-list of that industry's calls (all on by default), and the Single Call variable panel is
generated from each use case's own fields.

---

## Multi-tenant, roles & guardrails

The platform is shared: partners log in and each get their **own** workspace off one deployment.

- **Login & roles.** Zero-dependency auth (scrypt passwords + HMAC-signed tokens, `web/backend/auth.js`).
  Two roles: **admin** (Streebo) and **user** (partner). An admin login is seeded on first boot
  (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, default `admin@streebo.com` / `ChangeMe123!` — **change this before
  any public deploy**, and set `AUTH_SECRET` so tokens survive restarts and match across instances).
- **Getting accounts: self sign-up with a trusted-domain fast path** (`data/signup.json`, admin-controlled,
  **OFF by default**). When enabled, a "Create one" link appears on the login screen:
  - Email on a **trusted domain** (`allowedDomains`, exact match or subdomain) → approved instantly and
    signed straight in, capped at `autoApproveCallsPerDay`.
  - Any other domain → account created but **pending**; it cannot sign in until an admin approves it in
    the Admin dashboard (or is refused outright if `allowOthersPending` is off).
  Registration always forces `role: 'user'`; role, quota, and active state can never be set by the caller.
  **A domain is not proof of identity** (nobody verifies the mailbox), which is exactly why auto-approved
  accounts land on a conservative daily cap rather than an open line to your telephony spend. Email
  verification would close that gap and is a clean later addition.
- **Where accounts live.** `data/users.json` today (a plain file; passwords are one-way scrypt hashes,
  never returned to the browser). **Ephemeral on most container hosts**, so a real deployment needs a
  managed Postgres (Neon/Supabase/Railway) or a persistent disk. The store is already isolated behind six
  functions in `auth.js`, so swapping it is a contained change.
- **Per-user profile = the concurrency fix.** Each user has their own active Company Profile
  (`userProfiles[userId]`), so two partners building different companies at the same time never
  clobber each other. New users inherit the default profile.
- **Isolation.** Every call is stamped with its owner. History, analytics, and recordings are scoped:
  a partner sees only their own; an admin sees all and can filter to one user (`?userId=`). Cross-user
  access to a call detail/recording returns `403`.
- **No shared mutable state between partners.** Three things that were once global are now per-user, so
  one partner's actions never leak into another's live session:
  - **Active company profile** (`userProfiles[userId]`) — the core concurrency fix above.
  - **Write-back destination** (`userWritebackConfigs[userId]`, `data/user-writeback.json`) — each partner
    has their own sink/mapping; auto write-back keys off the **call owner**; the echo preview log is
    filtered to the caller (admin sees all).
  - **Bulk-campaign progress** (`userCampaigns[userId]`) — `/api/campaign/{status,stop}` act only on the
    caller's own campaign, so two partners can run campaigns side by side.
- **Settings is admin-only.** The shared provider credentials + go-live surface (`/api/config`,
  `/api/preflight`, `/api/test-connection`, `/api/tools/manifest`) require an admin; the Settings nav and
  header gear are hidden for partners. Partners cannot change the platform's ElevenLabs/Twilio config.
- **Admin Dashboard.** Overview tiles, user CRUD (create / enable-disable / set daily limit / reset
  password), per-user call totals + today's usage, and one-click **View calls** to inspect any partner's
  conversations and recordings.
- **Guardrails — configured centrally, OFF by default.** `GET/POST /api/admin/guardrails`
  (persisted to `data/guardrails.json`). Nothing is enforced until an admin switches it on:
  - `enforceQuota` + per-user `quota.callsPerDay` (or `defaultCallsPerDay`) — stop a partner's **real**
    calls once they hit their daily limit (a running campaign self-stops cleanly).
  - `rateLimitPerMin` — per-user calls/minute.
  - `simulationOnly` — force everyone into dry-run mode, so an open partner demo spends nothing.
  Admins are always exempt; **simulated calls never count against any limit** (they cost nothing).
  Usage is computed straight from call history, so counters never drift. `GET /api/usage` returns the
  signed-in user's own today/total and the limits that apply.

---

## Honest caveats

- **v3 / audio tags:** Eleven v3 is the most expressive model and supports audio tags (e.g. `[warmly]`), but real-time conversational calls favour low-latency models (Flash/Turbo v2.5). We expose the reliable per-call expressiveness knobs (`stability`, `speed`, `similarity_boost`) now, keep an **audio-tags toggle** for where it's supported, and stay forward-compatible as v3 opens up for real-time.
- **Overrides must be enabled** in the agent security settings or per-call voice/language/LLM silently won't take effect.
- ElevenLabs ships fast — reconfirm limits (batch size, model availability) on the live docs before a big client demo.

---

## Sources
- Twilio outbound call API — https://elevenlabs.io/docs/api-reference/twilio/outbound-call
- Overrides (per-call config) — https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides
- Batch calling — https://elevenlabs.io/docs/agents-platform/phone-numbers/batch-calls
- LLM / models (Gemini, custom) — https://elevenlabs.io/docs/eleven-agents/customization/llm
- List voices — https://elevenlabs.io/docs/api-reference/voices/search
- Get conversation details — https://elevenlabs.io/docs/api-reference/conversations/get
- Get conversation audio — https://elevenlabs.io/docs/api-reference/conversations/get-audio

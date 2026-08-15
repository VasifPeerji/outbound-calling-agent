# OmniReach — Setup & Wiring Guide (go live)

This takes you from the built project to a **real outbound call** placed by ElevenLabs, with the
action tools and write-back working. Retell fallback is at the end.

**The model:** ONE ElevenLabs Conversational-AI agent serves every company. The console pushes the
prompt, voice, LLM, language, and dynamic variables as **per-call overrides** — so there is nothing
to rebuild per prospect. The two things that must be true for that to work: **overrides are enabled**
on the agent, and (for the tools) **the backend is reachable from the internet**.

Use the **Settings → 🚀 Go-Live Readiness** panel in the console to track your progress; it checks
most of this automatically.

---

## 0. Prerequisites

- Node.js 18+
- An **ElevenLabs** account with Conversational AI
- A phone number to call *from* (via ElevenLabs' Twilio integration)
- A way to expose the backend publicly for the tool webhooks (a tunnel like **ngrok**, or a deploy)

---

## 1. Run the stack locally

```bash
cd "web/backend"
npm install
cp .env.example .env          # then edit .env (you can also enter creds in the console UI)
node server.js                # backend on http://localhost:3002
```

Serve the dashboard (any static server), e.g.:

```bash
cd "web/frontend"
python -m http.server 8791    # open http://localhost:8791
```

Open the console, go to **Settings**, and confirm the backend shows **connected**.

> You can demo the entire product right now with the **🧪 Simulation** toggle — no ElevenLabs needed.
> The steps below are only for **real** calls.

---

## 2. Create the ElevenLabs agent + API key

1. In the ElevenLabs dashboard → **Conversational AI → Agents → Create agent**. A blank/assistant
   template is fine — the console overrides its prompt/voice/LLM/language on every call.
2. Give it any default **voice** and **LLM** (these are the fallback when a call sends no override).
3. Copy the **Agent ID** (looks like `agent_…`).
4. **Profile → API Keys → Create key.** Copy it (used as the `xi-api-key` header).

---

## 3. Enable per-call overrides (the critical step)

In the agent's **Security** tab, under **Overrides**, turn **ON** the toggles the app pushes:

- **Required:** System prompt, LLM, Agent language, Voice, **First message** (the app sends a proper
  outbound opener — "Good {morning}! Am I speaking with {name}?" — so the agent starts the call
  instead of waiting or saying a generic greeting)
- **Optional (expressiveness):** Voice speed, Voice stability, Voice similarity — for per-call tuning.

The app **auto-detects which overrides your agent allows** and sends only those, so an unpublished or
partially-enabled toggle can never fail a call — it just uses the agent's own setting for that field.

> **Publish after you change overrides.** If your agent has a draft/branch, toggling overrides in the
> editor isn't enough — **Publish** so the live agent (the one the API calls) actually has them on.
> This is the #1 cause of `Override for field '…' is not allowed`.

(First message, Workflow start node, Text only, Tools, and Knowledge base may stay on but aren't
required.) If a **required** toggle is off, ElevenLabs silently ignores that per-call value and falls
back to the agent default — the most common setup mistake.

There is no override for the **voice engine/model** — set that on the agent's **Voice** tab (Step 3b).

### 3b. Voice engine (Flash / Turbo / Multilingual / v3)

On the agent's **Voice** tab, choose the TTS model. For live phone calls, **Flash v2.5** is the safe,
low-latency default. **v3** is the most expressive and supports audio tags, but confirm your plan
enables it for *real-time* conversations before relying on it for calls. Set the same engine in the
Agent Builder's **Voice engine** dropdown so your records match; ticking **Audio tags** there (v3)
adds emotive cues like `[warmly]` into the prompt for the sensitive moments.

---

## 4. Connect a phone number

1. ElevenLabs → **Phone Numbers → Import / connect** a Twilio number (you'll enter your Twilio SID +
   auth token, or use an ElevenLabs-native number where available).
2. Assign that number to your agent.
3. Copy the **Agent Phone Number ID** (looks like `phnum_…`). This is *not* the phone number itself —
   it's the ID the outbound-call API needs.

---

## 5. Expose the backend (for the action tools)

ElevenLabs calls the action-tool webhooks **from the cloud** during a conversation, so
`http://localhost:3002` is not reachable. Put a public URL in front of it:

```bash
ngrok http 3002
# → Forwarding  https://abc123.ngrok.app -> http://localhost:3002
```

Set that as the **Public base URL** in **Settings** (or `PUBLIC_BASE` in `.env`), with no trailing
slash. In production, use your deployed backend's URL instead.

> Optional hardening: set `TOOL_WEBHOOK_SECRET` in `.env`; the manifest then includes an
> `x-tool-secret` header to add to each tool, and the backend rejects tool calls without it.

---

## 6. Register the action tools + system tools

1. In **Settings → Public URL**, click **⬇ Tool registration manifest**. This downloads
   `omnireach-tools-manifest.json` — every action tool with its **name, description, POST URL, and
   parameters**, with the URLs already filled from your public base.
2. In the ElevenLabs agent → **Tools → Add tool → Webhook**, create one tool per manifest entry
   (name, description, method `POST`, the URL, and the parameters). There are 14.
3. **Enable the system tools** on the agent: `end_call`, `transfer_to_number`, `language_detection`,
   `voicemail_detection`.

See [TOOLS.md](TOOLS.md) for what each tool does and when the prompt calls it.

> The manifest is also at `GET /api/tools/manifest?base=<public-url>` if you prefer to script the
> registration against the ElevenLabs API.

---

## 7. Enter credentials + run the readiness check

In **Settings**, fill in (they stay on the backend, never in the browser):

- ElevenLabs **API Key**, **Agent ID**, **Agent Phone Number ID**
- **Public base URL**

Click **Save to Backend**, then **🚀 Go-Live Readiness → Check**. You want:

- ✓ API key set · Agent ID set · Phone Number ID set
- ✓ ElevenLabs API reachable (key valid)
- ✓ Public base URL set
- ◐ Overrides enabled *(manual — Step 3)*
- ◐ Action tools registered *(manual — Step 6)*

---

## 8. Place your first real call

1. Make sure **🧪 Simulation** is **OFF**.
2. **Single Call** → pick a use case, enter a real customer name + number (E.164, e.g. `+9198…`),
   launch.
3. In **Call History**, open the call → **Sync** to pull the status, recording, and transcript.
4. Confirm any outcome the agent captured appears (Outcome column + Actions-captured), and — if you
   enabled write-back — that it reached your destination.

---

## 9. Bulk + write-back, live

- **Bulk:** Smart Targeting → pick a source (CSV / URL / Sheet / REST / CRM) → the queue is ordered
  and de-duplicated → Bulk Campaign → Launch. See [DATA_INTEGRATION.md](DATA_INTEGRATION.md).
- **Write-back:** the **Write-back** page. For a live CRM push, use the **Webhook** sink pointing at
  your CRM/automation endpoint (that URL is *yours*, reachable from the backend — separate from
  `PUBLIC_BASE`, which is for ElevenLabs → your tool webhooks). Turn on **auto** to push each outcome
  the moment a call wraps up.

---

## 10. Retell fallback (optional)

Retell is the secondary provider. Its prompt lives in a Retell **Conversation Flow** agent (not
pushed per call), so you set it up once:

1. Create a Retell **Conversation Flow** agent. Paste `prompts/global_prompt.txt` as the global
   prompt, and each `prompts/<use_case>.txt` as a node, with a `{{use_case}}` logic split routing to
   the right node; add each `*_transition.txt` as that node's end-call condition.
2. Map the dynamic variables (the same `{{…}}` the profile flattens to).
3. In **Settings → Retell**, add the **API Key**, **Agent ID**, and **Caller ID** (E.164).
4. Set a profile's `voice.provider` to `retell`, or the default provider in Settings, to route calls
   there.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every company sounds the same / wrong voice or language | Overrides not enabled (Step 3) |
| Agent never logs outcomes; tools don't fire | Tools not registered, or `PUBLIC_BASE` wrong / not reachable |
| `401` on tool calls | `TOOL_WEBHOOK_SECRET` set but the `x-tool-secret` header missing on the tool |
| Call fails immediately | Wrong **Agent Phone Number ID** (using the number or Agent ID instead of `phnum_…`) |
| "ElevenLabs API reachable" ✕ | Invalid API key |
| Write-back does nothing | Webhook sink URL unreachable, or auto write-back left off |
| Recording/transcript empty right after a call | Still processing — hit **Sync** again shortly |

---

## Security notes

- Credentials live in the backend `.env` / in-memory config, never in the browser.
- Keep `.env` out of version control.
- Use `TOOL_WEBHOOK_SECRET` in production so only ElevenLabs can post outcomes.
- The tool webhook and write-back endpoints mutate call state; put them behind your tunnel's or
  deploy's auth if exposed beyond ElevenLabs.

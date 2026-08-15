# OmniReach — Generic AI Voice Outreach

A **single, reusable, white-label outbound voice-agent system** that can be deployed for
**any company, any industry, anywhere in the world**. Configure one **Company Profile**
(or load an industry **preset**), and the same voice agent + dashboard instantly become
that company's own outbound calling operation.

Built on the proven architecture behind our **Axis Finance** and **Forms Capital** demos —
generalised so nothing is hard-coded to a single client.

> **OmniReach** is just the internal/demo-shell name. Every prospect demo shows *their* brand
> (from the profile) — the platform name is one editable config value.

---

## Running it

**Locally**

```
cd web/backend
npm install
cp .env.example .env      # fill in the ElevenLabs and mail credentials
npm start                 # console + API on http://localhost:3002
```

One process serves both the API and the web console, so there is nothing else to start.

**Hosted** — see [docs/HOSTING.md](docs/HOSTING.md). It covers what the infrastructure team needs,
every environment variable, and plain explanations of `PUBLIC_BASE` and `TRUST_PROXY`, the two that
are easiest to get wrong.

Useful commands, all from `web/backend`:

| | |
|---|---|
| `npm start` | run the console and API |
| `npm run users` | list accounts and their roles |
| `npm run make-admin -- you@company.com` | make somebody an admin (add `super` for the owner tier) |
| `npm run mail:test -- you@company.com` | check that sign-in codes actually send |
| `npm run migrate:dry` | report what a JSON-to-Postgres migration would do, writing nothing |

> Stop the server before running `make-admin`. It holds accounts in memory and would overwrite the
> change on its next save, so the command refuses to run while it can see a live server.

---

## The idea in one line

**Company Profile → dynamic variables → one conversational voice agent + one white-label dashboard.**
Change the profile, change the company. No re-coding, no re-writing prompts.

---

## Use-case playbooks

Each is a self-contained conversation flow, toggleable per profile:

| # | Playbook | What it does |
|---|----------|--------------|
| 1 | **Payment / Due Reminder** | Friendly heads-up before a bill, EMI, premium, invoice, or subscription is due |
| 2 | **Overdue Follow-up / Collections** | Compliance-aware, empathetic follow-up after a missed payment |
| 3 | **Sales / Offers / Win-back** | New products, promotions, cross-sell/upsell, lapsed-customer win-back |
| 4 | **Appointment Reminder & Confirmation** | Confirm/remind about appointments, deliveries, service visits |
| 5 | **Feedback / CSAT Survey** | Post-interaction satisfaction & feedback capture |
| 6 | **Lead Qualification & Appointment-Setting** | Call a new lead, qualify need/fit, book a meeting |
| 7 | **Renewal / Retention** | Proactive renewal of policies, subscriptions, AMCs, memberships |

The agent (name, tone, honorifics), the products, the currency, the compliance framework,
and the contact channels are **all** driven by the active profile.

---

## How "generic" works

```
┌──────────────────────────────┐
│  Company Profile (config)    │  ← industry preset OR filled by hand in the dashboard
│  name · industry · country   │
│  currency · agent persona    │
│  offerings · contact · rules │
└──────────────┬───────────────┘
               │  flattened into dynamic variables
┌──────────────▼───────────────┐        ┌───────────────────────────────┐
│  White-label Dashboard        │───────▶│  Backend proxy (Node/Express) │
│  (single call · smart target  │  HTTP  │  intelligence engine + history│
│   · bulk campaign · history   │        │  + recordings/transcripts     │
│   · recordings · profile)     │        └───────────────┬───────────────┘
└───────────────────────────────┘                        │ HTTPS
                                          ┌───────────────▼───────────────┐
                                          │  Voice platform (Retell)      │
                                          │  ONE conversational-flow agent │
                                          │  global prompt + 7 use-case    │
                                          │  nodes, all variable-driven    │
                                          └───────────────────────────────┘
```

One Retell agent. The `{{use_case}}` variable routes to the right node; the profile
variables make that node speak as the right company.

---

## Repo layout

```
Generic Outbound Voice Agent/
├── README.md                        ← this file
├── config/
│   ├── COMPANY_PROFILE_GUIDE.md      ← every profile field explained
│   ├── company-profile.example.json  ← the profile contract (filled example)
│   ├── agent_tools.json             ← the agent's mid-call action tools (source of truth)
│   ├── catalog/                     ← industries.json + countries.json (power the Agent Builder)
│   └── presets/                      ← 23 ready-to-load industry profiles (banking → pharmacy),
│                                        globally diverse; the dashboard auto-discovers them
├── docs/                             ← SETUP · PLATFORM · TOOLS · DATA_INTEGRATION · SIMULATION_AND_ANALYTICS
├── prompts/                          ← agent prompts (global + 7 use-case nodes + end-call rules)
│   ├── global_prompt.txt             ← agent identity (variable-driven, world-ready)
│   ├── payment_reminder.txt          ← 1  Payment / Due Reminder
│   ├── overdue_followup.txt          ← 2  Overdue Follow-up / Collections
│   ├── sales_offer.txt               ← 3  Sales / Offers / Win-back
│   ├── appointment_reminder.txt      ← 4  Appointment Reminder & Confirmation
│   ├── feedback_survey.txt           ← 5  Feedback / CSAT Survey
│   ├── lead_qualification.txt        ← 6  Lead Qualification & Appointment-Setting
│   ├── renewal_retention.txt         ← 7  Renewal / Retention
│   └── *_transition.txt              ← one end-call condition per node
└── web/                              ← BUILT · Node backend (:3002) + single-file dashboard
```

---

## Build status

- [x] **Framework** — Company Profile schema + guide + example
- [x] **Industry presets** — starter set (India / UAE / USA, 3 verticals, 3 currencies, 3 honorific styles, 3 compliance frameworks)
- [x] **Global agent prompt** — generic, world-ready
- [x] **All 7 use-case playbooks** — Payment Reminder · Overdue/Collections · Sales/Offers · Appointment · Feedback/CSAT · Lead-Qualification · Renewal/Retention (each with its end-call transition)
- [x] **23 industry presets** — Banking, Insurance, Healthcare, Hospitality & Travel, Financial Services, Retail, Manufacturing, Education, Logistics, Telecom, Utilities, Automobile, Aviation, Government, Oil & Gas, Call Centres, Mining, Non-Profit, F&B, Entertainment, Construction, Agriculture, Pharmacy (17 countries · 17 currencies · 3 honorific styles; the dashboard auto-discovers them)
- [x] **Web console** — profile config + one-click preset picker + dashboard (single/bulk/history/recordings) on a neutral OmniReach theme; verified end-to-end (backend on :3002; a preset switch live re-brands the whole UI between companies)
- [x] **ElevenLabs-first, provider-agnostic voice layer** — adapter interface + ElevenLabs adapter (primary) + Retell adapter (fallback); prompt assembled per call; `/api/voices` + recording proxy. Verified boots + endpoints.
- [x] **Composable Agent Builder** — industry × country/region × currency × address × language × accent × voice/gender × LLM × expressiveness × labels × custom placeholders (23 industries × 33 countries, fully independent). Generate composes a bespoke agent and re-brands the console. Verified live (Banking × UAE → "Gulf Meridian Bank / Layla / dirhams"). LLM picker carries the full ElevenLabs model roster; changing industry/region auto-fills the brand labels.
- [x] **Agentic action tools** — 14 webhook tools + 4 ElevenLabs system tools, wired into every use-case prompt at the right branch: promise-to-pay, dispute, callback, survey capture, appointment book/reschedule/cancel, lead capture, renewal decision, transfer-to-human, do-not-call, contact update, follow-up, and a mandatory call-outcome. Confirm-before-side-effect; the backend records structured outcomes; the console shows them (Outcome column + Actions-captured detail). See `docs/TOOLS.md`. Verified end-to-end locally.
- [x] **Data flywheel (bulk + write-back)** — pluggable **sources** (CSV · URL · Google Sheet · REST · CRM/DB adapters), a **smart queue** (routes each customer to the right use case, orders by urgency, skips do-not-call / duplicates / incomplete), and **outcome write-back** (auto or manual → echo / webhook / enriched-CSV / CRM adapters) with a default field mapping. Same plug-and-play adapter pattern as the providers. See `docs/DATA_INTEGRATION.md`. Verified end-to-end locally.
- [x] **Simulation mode + Analytics** — a 🧪 dry-run toggle makes every call a realistic simulated conversation (transcript + outcome, all 7 use cases, fires the same action tools) so the **whole product demos with no credentials or phone numbers**; and an **Analytics** page aggregates outcomes (connect rate, disposition mix, per-use-case volume, sentiment, actions secured, avg CSAT). See `docs/SIMULATION_AND_ANALYTICS.md`. Verified end-to-end (bulk sim → analytics).
- [x] **Platform wiring guide** — `docs/SETUP.md`: end-to-end ElevenLabs setup (create the agent, API key, **enable per-call overrides**, connect a Twilio number, public tunnel, register the 14 action tools) + the Retell fallback. The console adds a **🚀 Go-Live Readiness** check (what's configured / reachable / still manual) and a **tool-registration manifest** that auto-fills every webhook URL from your public base. Verified: preflight reflects real credential + reachability state; manifest emits all 14 tools.

---

## Design principles

- **Extremely conversational & agentic** — the agent listens and responds to what's actually said, never reads a script, adapts tone to the moment.
- **World-ready** — multi-currency, multi-country, language-mirroring; compliance framing swaps per market (RBI / TCPA / GDPR / local rules).
- **Voice-quality by design** — every number, amount, acronym, and date is verbalised in the prompt, which also keeps AI voices (e.g. ElevenLabs) from drifting accent on hard tokens.
- **Plug-and-play** — one config value flips the whole system to a new prospect.

# OmniReach — Web Console

The profile-driven dashboard + backend that drives the generic voice agent. Pick a
**Company Profile** (or load an industry preset) and the same agent + dashboard become that
company's outbound calling operation.

```
web/
├── backend/    ← Node/Express: Retell proxy + Company Profile + intelligence engine + history/recordings
│   ├── server.js
│   ├── package.json
│   ├── .env.example
│   └── sample_crm.csv
└── frontend/   ← single-page dashboard (built in the next increment)
```

## Run the backend

```bash
cd web/backend
npm install
cp .env.example .env      # add ElevenLabs creds (primary) or Retell (fallback); set VOICE_PROVIDER + ACTIVE_PROFILE
                          # ElevenLabs setup steps are in ../../docs/PLATFORM.md
npm start                 # http://localhost:3002
```

The backend reads Company Profiles from `../../config/presets/*.json` and the example from
`../../config/company-profile.example.json`. Switch profiles live from the dashboard (or the API).

## How it's generic

Every outbound call sends Retell a merged set of **dynamic variables**:

```
flatten(active Company Profile)   →  company_name, agent_name, currency_word,
                                     honorific_style, support_number_spoken,
                                     compliance_framework, offerings_summary, …
      +  per-customer row (CRM)   →  customer_name, use_case, amounts, dates, offer, …
```

The prompts (in `../../prompts/`) read only these variables, so **changing the profile changes
the company** — no re-coding.

## The intelligence engine (generic, 7 use cases)

`POST /api/analyse-csv` routes each CRM row to the best **enabled** use case:

```
explicit use_case column                         → use it
days_overdue > 0  OR  due_date in the past        → overdue_followup
due_date within 7 days                            → payment_reminder
appointment_date present                          → appointment_reminder
renewal_date present                              → renewal_retention
interaction_date / interaction_type present       → feedback_survey
lead_source / interest present                    → lead_qualification
otherwise (if sales enabled)                      → sales_offer
```

Only use cases enabled in the active profile are assigned.

## Key API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health + whether configured |
| GET | `/api/profiles` | List available presets |
| GET | `/api/profile` | Active profile + its flattened variables |
| POST | `/api/profile` | Set the active profile (full JSON) |
| POST | `/api/profile/preset/:id` | Load a preset as active |
| GET/POST | `/api/config` | Retell credentials (key masked on GET) |
| GET | `/api/test-connection` | Test the voice-platform key |
| POST | `/api/call/single` | One call (profile vars auto-merged) |
| POST | `/api/analyse-csv` | Route a CRM upload to use cases |
| POST | `/api/campaign/launch` · GET `/status` · POST `/stop` | Bulk campaign |
| GET/DELETE | `/api/history` | Call history (persisted) |
| GET | `/api/call/:callId` | Details + recording + transcript |
| POST | `/api/history/sync` | Pull latest status/recordings |
| GET | `/api/template/crm` | Download a sample CRM CSV (live dates) |

> Ports: the Axis demo uses 3001; this one defaults to **3002** so both can run side by side.

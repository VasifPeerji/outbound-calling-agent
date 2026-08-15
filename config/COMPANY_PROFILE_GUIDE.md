# Company Profile — the configuration contract

The Company Profile is the **single source of truth** that turns the generic agent into a
specific company's outbound operation. Fill it once (or load a preset and tweak it) and
every call + the whole dashboard adapt.

At call time the dashboard **flattens** this profile into Retell **dynamic variables**
(flat `key → string`). The prompts reference those flat `{{keys}}`. This guide lists both
the profile fields and the flat variables they produce.

---

## 1. `platform` — the demo shell (white-label)

| Field | Meaning |
|-------|---------|
| `product_name` | Internal/demo brand shown in the dashboard chrome. Rename freely. |
| `tagline` | Small subtitle under the product name. |

## 2. `company` — who the agent works for

| Field | → variable | Notes |
|-------|-----------|-------|
| `name` | `{{company_name}}` | Full legal/brand name spoken to customers. |
| `short_name` | `{{company_short}}` | Casual short name ("Meridian"). |
| `industry` | `{{industry}}` | Banking, Insurance, Telecom, Healthcare, E-commerce, SaaS, Utilities, Lending, Education… |
| `country` | `{{country}}` | Primary market. Drives examples, tone, compliance. |
| `market` | `{{market}}` | One line on who they serve. |
| `about` | `{{company_about}}` | 1–2 sentences: what they do + why they're trusted. |
| `website` | `{{website}}` | Spoken slowly, in parts. |
| `trust_markers` | `{{trust_markers}}` | Regulator, age, group backing — used to reassure. |

## 3. `locale` — money, language, time

| Field | → variable | Notes |
|-------|-----------|-------|
| `currency_code` | `{{currency_code}}` | ISO code (INR, AED, USD, GBP…). |
| `currency_symbol` | `{{currency_symbol}}` | Display only (dashboard). |
| `currency_spoken` | `{{currency_word}}` | How the agent SAYS it: "rupees", "dirhams", "dollars". |
| `money_scale` | `{{money_scale}}` | `indian` (lakh/crore) or `western` (thousand/million). |
| `primary_language` | `{{primary_language}}` | Default spoken language. |
| `mirror_languages` | `{{mirror_languages}}` | Languages the agent will switch to if the customer does. |
| `timezone` | `{{timezone}}` | For calling-hours awareness. |

## 4. `agent` — the persona

| Field | → variable | Notes |
|-------|-----------|-------|
| `name` | `{{agent_name}}` | The agent's name. |
| `role` | `{{agent_role}}` | e.g. "Relationship Officer", "Care Executive". |
| `tone` | `{{agent_tone}}` | e.g. "warm, professional, and human". |
| `honorific_style` | `{{honorific_style}}` | **How to address the customer after confirming identity** (see below). |
| `persona_notes` | `{{persona_notes}}` | Extra character guidance. |

**`honorific_style` values** — confirm the full name once, then address the customer as:
- `first_name_ji` — "Rajesh ji" (India / warm, respectful)
- `mr_ms_surname` — "Mr. Sharma" / "Ms. Nair" (formal Western / Gulf)
- `first_name` — "Rajesh" (casual, US consumer)
- `sir_maam` — "sir" / "ma'am" (very formal / name uncertain)

## 4b. `voice` — how it sounds (ElevenLabs-first)

The voice layer is provider-agnostic; ElevenLabs is primary, Retell is the fallback. These fields
are set in the **Agent Builder** and become per-call overrides.

| Field | Meaning |
|-------|---------|
| `provider` | `elevenlabs` (primary) or `retell` (fallback) |
| `voice_id` | the chosen voice — this is where **accent + gender** actually live (picked from the ElevenLabs voice library) |
| `voice_label` | human label shown in the UI (e.g. "Aria — American, female") |
| `accent` / `gender` | the picker filters (american, british, indian, arabic…; male/female/neutral) |
| `language` | ISO code the agent speaks (`en`, `hi`, `ar`, `es`…); multilingual is a core strength |
| `model` | real-time TTS model (`eleven_flash_v2_5` for low latency; v3 where supported) |
| `stability` / `similarity_boost` / `speed` | expressiveness knobs (per-call TTS overrides) |
| `audio_tags` | opt-in to embed expressive tags where the model supports them |

`{{agent}}.llm` selects the **brain** (`gemini-2.0-flash`, a Claude/OpenAI model, or a custom
OpenAI-compatible endpoint). See `docs/PLATFORM.md` for the exact ElevenLabs API mapping.

## 5. `contact` — channels the agent quotes

| Field | → variable | Notes |
|-------|-----------|-------|
| `support_number` | `{{support_number}}` | Display form. |
| `support_number_spoken` | `{{support_number_spoken}}` | **Pre-verbalised** grouped digits the agent reads aloud (keeps AI voices stable). |
| `whatsapp_number` | `{{whatsapp_number}}` | Optional. |
| `email` | `{{support_email}}` | Spoken with "dot" / "at". |
| `hours` | `{{hours}}` | Working hours. |
| `portal` | `{{portal}}` | App / website for self-service. |

## 6. `compliance` — the guardrails

| Field | → variable | Notes |
|-------|-----------|-------|
| `framework` | `{{compliance_framework}}` | "RBI Fair Practices Code", "TCPA & FTC rules", "GDPR + local DND"… |
| `calling_hours` | `{{calling_hours}}` | Permitted hours. |
| `recording_disclosure` | `{{recording_disclosure}}` | Whether to disclose the call may be recorded. |
| `dnd_respect` | — | Always honour opt-out; used by Sales/Marketing. |
| `notes` | `{{compliance_notes}}` | Extra do/don'ts. |

## 7. `offerings` — the products/services

A list of `{ name, benefit, category }`. Flattened into `{{offerings_summary}}` — a natural,
spoken-friendly line the agent can pull from (never read as a list).

## 8. `use_cases` — which playbooks are on

Each key toggles a flow and can carry flow-specific settings, e.g.:
- `overdue_followup.consequences` — the real, lawful consequences to mention (late fee, credit-bureau reporting, service suspension, secured-asset recovery…).
- `appointment_reminder.appointment_noun` — "branch appointment", "home delivery", "service visit".
- `feedback_survey.scale` — "1 to 5", "1 to 10".

---

## Per-call (customer) variables — supplied by the CRM/CSV, not the profile

Common across flows: `{{customer_name}}`, `{{use_case}}`, `{{time}}` (morning/afternoon/evening).

Flow-specific (examples):
- Payment reminder: `{{amount_due}}`, `{{due_date}}`, `{{product_name}}`, `{{account_ref}}`
- Overdue: `{{amount_overdue}}`, `{{days_overdue}}`, `{{original_due_date}}`, `{{outstanding_balance}}`
- Sales/Offer: `{{offer_type}}`, `{{offer_detail}}`, `{{pre_approved}}`, `{{expiry_date}}`
- Appointment: `{{appointment_type}}`, `{{appointment_date}}`, `{{appointment_time}}`, `{{location}}`
- Feedback: `{{interaction_type}}`, `{{interaction_date}}`
- Lead-qual: `{{lead_source}}`, `{{interest}}`
- Renewal: `{{renewal_item}}`, `{{renewal_date}}`, `{{renewal_amount}}`

The prompts are written so that any missing variable degrades gracefully (the agent speaks
around it rather than saying a blank).

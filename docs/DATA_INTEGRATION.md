# OmniReach — Data Integration (sources in, write-back out)

Bulk calling is a closed loop:

```
  SOURCE  →  SMART QUEUE  →  CALL  →  OUTCOME (tools)  →  WRITE-BACK
  CSV/URL/    order by        the      promise, callback,   push to CRM/DB/
  Sheet/REST/ urgency, skip    agent    survey, DNC, …       sheet/webhook
  CRM/DB      DNC & dupes               (see docs/TOOLS.md)
```

Same plug-and-play pattern as the voice providers: one interface, many adapters, in
[`web/backend/connectors.js`](../web/backend/connectors.js). Fully-working adapters run locally; the
CRM/DB adapters are interface-ready (drop in credentials).

---

## 1. Sources (pull customers from anywhere)

Pick a source on **Smart Targeting**. Each returns rows that the engine then analyses and queues.

| Source | Live | Config | Notes |
|--------|------|--------|-------|
| `csv` | ✅ | upload / paste | one row per customer |
| `url` | ✅ | `url`, `format` (auto/csv/json), `path` | any CSV or JSON file over HTTP |
| `sheet` | ✅ | `url` | a Google Sheet published as CSV (File → Share → Publish to web → CSV) |
| `rest` | ✅ | `url`, `headers` (JSON), `path` | a JSON API; `path` points at the array (e.g. `data`) |
| `postgres` / `mysql` | interface-ready | `query` | add a driver (`pg` / `mysql2`); alias columns to the row schema |
| `salesforce` | interface-ready | OAuth | SOQL via the REST API |
| `hubspot` | interface-ready | private-app token | `GET /crm/v3/objects/contacts` |
| `zoho` | interface-ready | OAuth | Zoho CRM records API |

**Row schema** (columns the engine understands; all optional except the first two):
`customer_name`, `to_number`, `use_case`, `product_name`, `amount_due`, `due_date`, `days_overdue`,
`amount_overdue`, `outstanding_balance`, `offer_type`, `offer_detail`, `expiry_date`,
`appointment_type`, `appointment_date`, `appointment_time`, `location`, `interaction_type`,
`interaction_date`, `lead_source`, `interest`, `renewal_item`, `renewal_date`, `do_not_call`, `notes`.
Download a filled example from the console (**Download CRM Template**) or `GET /api/template/crm`.

**Add a source adapter:** add an entry to `sources` in `connectors.js` with an async `fetch(config)`
that returns an array of plain row objects. That is the whole contract.

---

## 2. Smart queue (call logically, not blindly)

`POST /api/source/fetch` (and the CSV analyser) run every row through the engine, which:

1. **Routes each customer to the best enabled use case** — an explicit `use_case` wins; otherwise it
   infers from the data (overdue vs due-soon vs appointment vs renewal vs recent-interaction vs
   lead vs sales). Only use cases enabled in the active profile are assigned.
2. **Orders by urgency:** overdue → payment reminder → appointment → renewal → feedback → lead → sales.
3. **Skips rows it should not call**, with the reason shown:
   - `missing data` — no name or number
   - `do-not-call (data)` — a truthy `do_not_call` / `dnc` / `opt_out` column
   - `do-not-call (prior call)` — the number was marked DNC on an earlier call (honours the outcome)
   - `duplicate number` — the same number earlier in the batch

The console shows the ordered queue with an **Order** column and greys out skipped rows. Launching a
campaign calls only the queued rows, in order.

---

## 3. Write-back (push outcomes to your system of record)

After a call, the outcome is known (from the action tools in [docs/TOOLS.md](TOOLS.md)). Write-back
maps that outcome to fields and pushes it to a **sink**. Configure it on the **Write-back** page.

| Sink | Live | Config | Use |
|------|------|--------|-----|
| `echo` | ✅ | — | preview in-app: see exactly what would be sent (great for demos) |
| `webhook` | ✅ | `url`, `headers` | `POST {updates:[…]}` to your integration or an automation (Zapier / Make / n8n) |
| `csv` | ✅ | — | download an enriched CSV to re-import |
| `salesforce` / `hubspot` / `zoho` / `postgres` | interface-ready | creds | PATCH/UPDATE the record by key |

**Auto vs manual:**
- **Auto** (toggle on the page): the moment a call wraps up with `record_call_outcome`, its row is
  pushed to the sink automatically.
- **Manual:** *Run write-back now* pushes every call that has outcomes; *Preview* shows the rows first.

**Default field mapping** (call outcome → written column; edit in `connectors.js`):

| Column | From |
|--------|------|
| `call_status` | disposition |
| `call_summary` | outcome summary |
| `call_sentiment` | sentiment |
| `promise_amount` / `promise_date` | promise-to-pay |
| `callback_time` | scheduled callback |
| `do_not_call` | opt-out |
| `appointment_status` / `appointment_date` | appointment |
| `survey_score` | CSAT/NPS |
| `lead_qualified` | lead fit |
| `renewal_decision` | renewal |
| `last_called_at`, `call_id` | call metadata |

The `to_number` (and `customer_name`) are always included as the key to match the row back in your
source.

**Add a sink adapter:** add an entry to `sinks` in `connectors.js` with an async `push(rows, config)`.
For a CRM, map `row` fields to the CRM's API and PATCH by `to_number` / an external id.

---

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/connectors` | list source + sink types and the default mapping |
| `POST /api/source/fetch` `{type, config}` | fetch + analyse + plan the smart queue |
| `POST /api/campaign/launch` | call the queued rows in order (existing) |
| `GET/POST /api/writeback/config` | get/set sink + auto toggle |
| `GET /api/writeback/preview` | rows that would be written for calls with outcomes |
| `POST /api/writeback/run` `{sink, config, callIds?}` | write now (CSV sink returns the file) |
| `GET /api/writeback/log` | rows captured by the `echo` sink |

---

## Going live

- **Webhook sink / REST source** need real, reachable URLs (same as the tool webhooks — a tunnel or a
  deploy; `localhost` is not reachable from a cloud CRM).
- **CRM/DB adapters** need credentials. Each stub throws a message telling you exactly what to wire.
- The write-back key is the phone number by default; switch it to your CRM's record id in the mapping
  if you have it on the row.

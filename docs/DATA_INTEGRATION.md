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

**Column names are yours, not ours.** Upload the file as it comes out of the source system. The
router matches each header onto its own vocabulary three ways, in order:

1. **By name** — `due_date`, and the several hundred aliases partners actually use (`msisdn`,
   `consignee`, `appt_dt`, `guardian_phone`, `Bill Amount`, `Payment Due On`).
2. **By meaning** — a longer header whose words still say what it is (`bill_due_date`,
   `restoration_eta`, `pending_documents`).
3. **By its values** — a column called `crm_field_7` full of `+9198…` is the phone number, and one
   full of people is the name. Read down the whole column, not one cell.

The mapping it settled on is shown above the results in the console, so it can be checked before
anything is dialled. Two sample files: `GET /api/template/crm` (our own names, useful as a template)
and `GET /api/template/export` (**Download Sample Export** — a partner-shaped file with none of our
names in it, gaps, and several different calls in the one upload).

All the router needs somewhere in the file is a **name** and a **number**. Everything else shapes
which call is placed and what is said on it.

**Suppression is matched generously**, because the cost of missing it is a call to somebody who
asked us not to ring: `do_not_call`, `Opted Out`, `DNC`, `DND`, `Do Not Contact`, `unsubscribed`,
`Consent Revoked`, `Suppressed`, `Blacklisted` and the like all suppress the row.

**Add a source adapter:** add an entry to `sources` in `connectors.js` with an async `fetch(config)`
that returns an array of plain row objects. That is the whole contract.

---

## 2. Smart queue (call logically, not blindly)

`POST /api/source/fetch` (and the CSV analyser) run every row through the engine, which:

1. **Routes each customer to the best enabled use case.** Every use case in the catalogue declares
   the details it needs (`fields`, with `required` flags). The row is scored against those
   declarations plus what the data is evidently asking for — a date already past, an exception
   logged, documents outstanding — and the use case whose needs the row actually meets wins. There is
   no per-industry code: adding an industry stays a catalogue edit. An explicit `use_case` column
   overrides all of it, and only use cases enabled in the active profile are considered.
2. **Fills the variables that use case declares**, formatted for speech: amounts grouped to the
   profile's money scale, dates spoken in full ("Friday, the 11th of September"), slots read as
   ranges.
3. **Handles a gap rather than papering over it**, in this order:
   - **derive it** — days overdue from a due date, the date out of a delivery slot;
   - **name it from the call itself** — only for the category of the thing ("a delivery exception"),
     which is true because the call was chosen, never for a figure or a date;
   - **leave it out** — the prompts already instruct the agent to speak around an empty variable, so
     silence about an unknown is safe and honest;
   - **step down** to a call the row can support — a fee reminder with no amount but documents
     outstanding is a documents call;
   - **hold the row back** and name the missing column, if none of the above applies.

   A figure or a date is never invented. Anything spoken to a real customer has to be theirs.
4. **Orders by urgency:** service notification → overdue → payment reminder → appointment →
   documents → renewal → feedback → lead → sales.
5. **Skips rows it should not call**, with the reason shown:
   - `no phone number` / `no customer name` — says which, rather than "missing data"
   - `missing <field>` — the row wants a call it has not got the details for; the field is named
   - `do-not-call (data)` — a suppression column, however it is spelled (see above)
   - `do-not-call (prior call)` — the number was marked DNC on an earlier call (honours the outcome)
   - `duplicate number` — the same number earlier in the batch

   Where nothing on the row matches any call the agent makes — an amount and a due date handed to a
   clinic that only books appointments — it says so, rather than falling back to a sales pitch.

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

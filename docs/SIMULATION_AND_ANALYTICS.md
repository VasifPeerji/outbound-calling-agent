# OmniReach — Simulation Mode & Analytics

Two features that let you **demo the entire product with zero setup** and **prove its value with numbers**.

---

## Simulation Mode (dry-run calls, no telephony)

Flip the **🧪 Simulation** toggle in the header. Every call then becomes a realistic *dry-run*:

- **Single Call** → `POST /api/call/simulate`
- **Bulk Campaign** → `/api/campaign/launch` with `simulate: true`

Each simulated call produces a believable **transcript** and a plausible **outcome**, using the active
profile's own values (agent name, company, currency, honorific, amounts). It fires the same action
tools a real call would (promise-to-pay, callback, survey, appointment, lead, renewal, dispute,
do-not-call), so **everything downstream just works**: history, transcripts, the Outcome column,
write-back, and analytics — all with **no ElevenLabs credentials and no phone numbers**.

Every simulated call is flagged `simulated: true` and shown with a **🧪 SIM** badge, so it is never
mistaken for a real one.

**Why it matters:** you can walk a prospect through the whole system live — dial a customer, watch the
conversation, see the outcome captured, watch it written back to a CRM, and open the analytics — before
any account, number, or spend exists. It also makes the outcomes / write-back / analytics features
demoable on their own.

The engine lives in [`web/backend/simulator.js`](../web/backend/simulator.js). It covers all 7 use
cases with several weighted branches each (e.g. payment reminder → will-pay / already-paid / busy /
difficulty), plus a realistic share of voicemails and wrong-person pickups.

---

## Analytics

The **Analytics** page aggregates outcomes across every call (real or simulated) via `GET /api/analytics`:

- **Headline tiles:** total calls, connect rate, calls with an outcome, average duration.

**How connect rate is worked out.** Each call is placed in one bucket: `connected`, `noReach`,
`failed`, or `pending`. A real ElevenLabs call often has no `disposition` (that only comes from the
`record_call_outcome` tool or the simulator), so we fall back to provider signals: a call counts as
**connected** when it has a real disposition, or `callSuccessful` is true, or it ended with a real
conversation (duration over ~10s); **failed** when it never placed or the provider errored; **noReach**
for voicemail / no-answer / wrong-person / instant drops; and **pending** when it was placed but its
outcome has not been synced back yet. **Connect rate = connected / (connected + noReach + failed)** —
pending calls are excluded from the denominator so un-synced calls do not drag the rate to zero. The
Analytics page shows a note when calls are pending, with a **↻ Sync now** button. (Simulated calls
always carry a disposition, so a simulated demo shows a full, correct rate immediately.)

**Who sees what (multi-tenant).** Analytics, history, and recordings are scoped to the signed-in user:
a partner sees only **their own** calls; an admin sees **everyone's**, and can narrow to one user with
`GET /api/analytics?userId=<id>` (the **View calls** button on the Admin page sets this). Cross-user
access to a call's detail or recording is refused with `403`.
- **Dispositions:** a ranked bar breakdown (promised payment, appointment set, renewed, callback,
  do-not-call, voicemail, …), colour-coded by kind (green = positive resolution, red = no reach / opt-out).
- **By use case:** the volume mix across the 7 playbooks.
- **Actions secured:** tiles for promises-to-pay, callbacks, appointments, leads, renewals, surveys
  (with average CSAT), disputes, do-not-call, transfers, follow-ups.
- **Sentiment:** positive / neutral / negative split.

No external charting library — the bars are plain CSS, so it stays a single self-contained file and is
CSP-safe.

**Demo flow:** turn on 🧪 Simulation → Smart Targeting (fetch or upload data) → Bulk Campaign → Analytics.
In under a minute you have a populated dashboard telling the ROI story: "of 200 calls, 71% connected,
we secured 34 promises-to-pay and booked 22 appointments, with 43% positive sentiment."

---

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/call/simulate` `{toNumber, variables}` | one simulated call |
| `POST /api/campaign/launch` `{customers, simulate:true}` | a simulated campaign |
| `GET /api/analytics` | aggregated outcome metrics |

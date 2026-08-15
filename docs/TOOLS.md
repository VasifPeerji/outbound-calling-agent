# OmniReach — Agent Tools (mid-call actions)

The voice agent does not just talk. During a call it can **take real actions** by calling tools:
log a promise to pay, book an appointment, schedule a callback, capture a survey score, flag a
dispute, opt a customer out, transfer to a human, and always record a final outcome.

This is how the deterministic branches work in our single-agent design. The **conversation**
branches live in the prompt (the LLM routes in real time); the **action** branches call a tool so
the side effect is guaranteed and captured. See the "TOOLS FOR THIS NODE" block at the bottom of each
use-case prompt for exactly which tool fires at which branch.

Source of truth: [`config/agent_tools.json`](../config/agent_tools.json). Backend receiver:
`POST /api/agent-tool/:tool` in `web/backend/server.js`.

---

## Two kinds of tools

### 1. System tools (ElevenLabs built-ins, just toggle on)

Enable these on the agent (Agent, then Tools):

| Tool | Why |
|------|-----|
| `end_call` | Lets the agent hang up, but only after it has spoken its closing turn (see each node's end-call rule). |
| `transfer_to_number` | Warm/cold transfer to a human team; pair with the `transfer_to_human` webhook so the handoff is also logged. |
| `language_detection` | Detects and switches to a language the customer speaks. Powers `{{mirror_languages}}`. |
| `voicemail_detection` | Detects answering machines so the agent leaves the short voicemail (no amounts) instead of the full flow. |

### 2. Webhook (server) tools, registered once, reused for every company

14 custom tools, all pointing at our backend. Register each on the agent as a **Webhook** tool with:

- **URL:** `{PUBLIC_BASE}/api/agent-tool/{tool_name}`
- **Method:** `POST`
- **Body parameters:** the `parameters` for that tool in `config/agent_tools.json`

`{PUBLIC_BASE}` is wherever the backend is reachable from the public internet (see "Going live" below).

**Universal (every use case)**

| Tool | Fires when | Key parameters |
|------|-----------|----------------|
| `record_call_outcome` | Once, right before the goodbye, on **every** call | `disposition`, `summary`, `sentiment` |
| `schedule_callback` | Customer is busy or wants another time | `callback_time`, `reason` |
| `mark_do_not_call` | Customer asks to opt out | `reason`, `scope` |
| `transfer_to_human` | Needs a colleague, or they insist | `department`, `reason` |
| `update_contact_info` | Gives a corrected phone/email/address/best time | `field`, `value` |
| `send_followup` | Wants a link or details (payment link, appointment details, info) | `channel`, `content_type` |

**Use-case specific**

| Tool | Use cases | Key parameters |
|------|-----------|----------------|
| `log_promise_to_pay` | payment_reminder, overdue_followup | `amount`, `promised_date`, `method` |
| `flag_dispute` | payment, overdue, renewal | `about`, `details` |
| `capture_survey_response` | feedback_survey | `score`, `scale`, `sentiment`, `verbatim`, `would_recommend` |
| `book_appointment` | appointment, lead, sales | `date`, `time`, `type`, `location` |
| `reschedule_appointment` | appointment | `new_date`, `new_time` |
| `cancel_appointment` | appointment | `reason` |
| `capture_lead` | lead_qualification, sales | `qualified`, `interest`, `budget`, `timeline`, `notes` |
| `log_renewal_decision` | renewal_retention | `decision`, `reason`, `offer_accepted` |

---

## The golden rule: confirm before you commit

Every tool that records, books, sends, or changes something is **confirm-first**. The prompt tells the
agent to say the detail back and get a clear "yes" before calling it:

> "So that's eighteen thousand five hundred rupees by Friday, shall I note that down?"

The agent never fires a tool on a guess, never invents inputs, and speaks in plain human terms
afterwards (never "I called a tool" or field names). These rules live in the global prompt under
"TAKING REAL ACTIONS, YOUR TOOLS".

---

## What the backend does with a tool call

1. Validates the tool name against the spec (unknown tool, `404`).
2. Finds the matching call in history by `conversation_id` (ElevenLabs sends this), and attaches a
   structured **outcome** to it: an `outcomes[]` timeline plus convenience fields
   (`disposition`, `promiseToPay`, `callback`, `survey`, `appointment`, `lead`, `renewal`, `dispute`,
   `transferred`, `dnc`, `followups`, `contactUpdates`).
3. Returns a natural line for the agent to speak back (from the tool's `say` template), e.g.
   *"Thank you, I've noted your payment of eighteen thousand five hundred rupees by Friday."*

A missing required parameter does **not** derail the call: the backend still returns `200` and lists
`missing_params` so you can see it, while the agent (per the prompt) simply asks for the missing value.

### Where outcomes show up in the console

- **History table:** a new **Outcome** column with compact chips (disposition, promise, callback,
  survey score, appointment, do-not-call, and so on).
- **Call detail modal:** an **Actions captured** section listing every action with its details.

---

## Correlating a tool call to the right call

Outcomes attach to a call by its ElevenLabs `conversation_id` (our `callId`). Make sure each webhook
tool passes it. The simplest way: add `conversation_id` as a parameter on each tool and map its value
to the system variable `{{system__conversation_id}}` in the ElevenLabs tool config. The backend also
reads it from the `elevenlabs-conversation-id` / `x-conversation-id` header or a `?conversation_id=`
query param, and (for local demos) falls back to the most recent call.

---

## Going live (the webhook must be publicly reachable)

For real calls, ElevenLabs calls the webhook from the cloud, so `localhost:3002` will not work. Expose
the backend with a tunnel or deploy it, then use that base URL when registering the tools:

```bash
# example: a tunnel in front of the local backend
ngrok http 3002
# -> https://abc123.ngrok.app  →  {PUBLIC_BASE} = https://abc123.ngrok.app
# tool URL example: https://abc123.ngrok.app/api/agent-tool/log_promise_to_pay
```

**Secure it:** set `TOOL_WEBHOOK_SECRET` in `web/backend/.env`, then add an `x-tool-secret` header with
the same value to each tool in ElevenLabs. The backend rejects tool calls without it (`401`).

---

## Local test (no ElevenLabs needed)

The receiver is fully testable on its own:

```bash
curl -X POST http://localhost:3002/api/agent-tool/log_promise_to_pay \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"<a callId from history>","amount":"eighteen thousand five hundred rupees","promised_date":"this Friday","method":"upi"}'
# -> { "success": true, "message": "Thank you, I've noted your payment of ... by this Friday.", "recorded": true }
```

Then open the **History** page: the call shows a `promised_payment` chip and, in its detail, the full
Actions-captured breakdown.

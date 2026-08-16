/**
 * OmniReach — outbound email.
 *
 * Same adapter shape as voice-providers.js and connectors.js: one interface, swappable backends,
 * chosen by MAIL_PROVIDER. Nothing above this file knows or cares how a message actually leaves.
 *
 *   graph  Microsoft 365 via the Graph API (production). Sends as a single mailbox that IT has
 *          scoped the app registration to. No SMTP, no password, no DNS work: Exchange Online
 *          authenticates the mail itself, so SPF/DKIM/DMARC on streebo.com are not involved.
 *   smtp   Any SMTP relay via nodemailer. Kept as the fallback if IT ever prefers SMTP AUTH.
 *          nodemailer is required lazily so it stays an optional dependency.
 *   dev    Prints the message to the server log. Lets the whole sign-in flow be built and tested
 *          before any credential exists. NEVER leave this on once real users can reach the console.
 *
 * Why Graph and not SMTP: Microsoft is retiring SMTP client submission, and a per-mailbox SMTP
 * credential is not a thing an M365 admin can issue anyway (which is exactly what ours said).
 */
const fetch = require('node-fetch');

const PROVIDER = (process.env.MAIL_PROVIDER || 'dev').toLowerCase();
const GRAPH = 'https://graph.microsoft.com/v1.0';

// ── Entra token, cached ─────────────────────────────────
// Client-credentials tokens last about an hour. Fetching one per email would triple the latency of
// every sign-in and hammer the token endpoint, so hold it until shortly before it expires.
let cachedToken = null;   // { value, expiresAt }

async function graphToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;

  const tenant = (process.env.GRAPH_TENANT_ID || '').trim();
  const client = (process.env.GRAPH_CLIENT_ID || '').trim();
  const secret = (process.env.GRAPH_CLIENT_SECRET || '').trim();
  if (!tenant || !client || !secret) throw new Error('GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET must all be set.');

  const body = new URLSearchParams({
    client_id: client,
    client_secret: secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeout: 20000
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(explainAuthError(d, r.status));

  cachedToken = { value: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

/**
 * Turn Entra's error codes into the actual thing that is wrong, because the raw messages are long
 * and bury the one useful sentence. Each of these maps to a different person fixing a different
 * thing, so guessing wastes a round-trip with IT.
 */
function explainAuthError(d, status) {
  const raw = String(d.error_description || d.error || `HTTP ${status}`);
  const code = (raw.match(/AADSTS\d+/) || [])[0];
  const hints = {
    AADSTS7000215: 'The client secret is wrong. The most common cause is pasting the secret\'s "Secret ID" instead of its "Value" — the Value is the secret, and Azure shows it only once at creation.',
    AADSTS7000222: 'The client secret has EXPIRED. IT needs to issue a new one; nothing else is broken.',
    AADSTS700016: 'The application was not found in this tenant. Either GRAPH_CLIENT_ID or GRAPH_TENANT_ID belongs to a different directory.',
    AADSTS90002: 'That tenant does not exist. GRAPH_TENANT_ID should be the Directory (tenant) ID from the app registration overview, not the Object ID and not the Application (client) ID.',
    AADSTS900023: 'The tenant id is not valid. GRAPH_TENANT_ID should be the Directory (tenant) ID, not the Object ID.',
    AADSTS7000216: 'The app is registered but client-credentials flow was refused. Ask IT to confirm this is an application (daemon) registration.',
    AADSTS50034: 'The tenant exists but the account does not. Check GRAPH_TENANT_ID.'
  };
  // Microsoft's description repeats the code and then appends Trace/Correlation/Timestamp lines
  // that mean nothing to whoever is fixing this. Keep the first sentence, drop the telemetry.
  const fallback = raw.split('\n')[0].replace(/^AADSTS\d+:\s*/, '').replace(/\s*(Trace ID|Correlation ID|Timestamp):.*$/i, '').trim();
  return `${code || 'Auth failed'}: ${hints[code] || fallback}`;
}

function explainSendError(d, status) {
  const code = ((d.error || {}).code) || '';
  const msg = ((d.error || {}).message) || `HTTP ${status}`;
  if (status === 403 || /AccessDenied|ErrorAccessDenied/i.test(code)) {
    return 'Access denied when sending. Three things to check with IT, in this order: (1) the Mail.Send permission is an APPLICATION permission, not Delegated — delegated needs a signed-in user and can never work for an unattended service; (2) admin consent was actually granted (the portal shows a green tick); (3) if an application access policy was applied, it must INCLUDE this mailbox, since a policy scoped to a different mailbox blocks this one.';
  }
  if (status === 404 || /ErrorInvalidUser|ResourceNotFound|MailboxNotEnabled/i.test(code)) {
    return `The mailbox "${process.env.GRAPH_MAIL_FROM || '(unset)'}" was not found or is not an Exchange Online mailbox. Check GRAPH_MAIL_FROM is the full address and is a real mailbox rather than an alias or a distribution list.`;
  }
  if (status === 429) return 'Throttled by Exchange Online. Retry shortly; this is a rate limit, not a misconfiguration.';
  return `${code || 'Send failed'}: ${msg}`;
}

// ── the adapters ────────────────────────────────────────
/** One address or many, in whatever shape the caller had it. */
function recipientList(to) {
  const arr = Array.isArray(to) ? to : String(to || '').split(/[,;]/);
  return arr.map(x => String(x || '').trim()).filter(Boolean);
}

const adapters = {
  async graph({ to, subject, text, html }) {
    const from = (process.env.GRAPH_MAIL_FROM || '').trim();
    if (!from) throw new Error('GRAPH_MAIL_FROM must be set to the mailbox the app is allowed to send as.');
    const token = await graphToken();
    const people = recipientList(to);

    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Plain text unless the caller supplies HTML. A sign-in code needs no markup, and a message
      // with no links at all is immune to link-rewriting scanners (Defender Safe Links, Proofpoint)
      // and scores far better against phishing filters than a styled mail carrying a button. The
      // daily report is the exception: it is a table, and a table has to be drawn.
      body: JSON.stringify({
        message: {
          subject,
          body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text },
          toRecipients: people.map(address => ({ emailAddress: { address } }))
        },
        // Sign-in codes in Sent Items are just clutter in a shared mailbox, and a small liability.
        // A report is worth keeping, so it is the one thing we file.
        saveToSentItems: !!html
      }),
      timeout: 30000
    });

    if (r.status === 202) return { ok: true, provider: 'graph', detail: `sent as ${from} to ${people.length} recipient${people.length === 1 ? '' : 's'}` };
    const d = await r.json().catch(() => ({}));
    throw new Error(explainSendError(d, r.status));
  },

  async smtp({ to, subject, text, html }) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new Error('MAIL_PROVIDER=smtp needs nodemailer:  npm install nodemailer'); }
    const url = (process.env.SMTP_URL || '').trim();
    if (!url) throw new Error('SMTP_URL must be set, e.g. smtps://user%40streebo.com:pass@smtp.office365.com:587');
    const from = (process.env.GRAPH_MAIL_FROM || process.env.SMTP_FROM || '').trim();
    const info = await nodemailer.createTransport(url).sendMail({ from, to: recipientList(to).join(', '), subject, text, html: html || undefined });
    return { ok: true, provider: 'smtp', detail: info.messageId };
  },

  async dev({ to, subject, text, html }) {
    const people = recipientList(to).join(', ');
    console.log(`\n📧  [dev mailer] would send to ${people}\n    subject: ${subject}\n    ${String(text).replace(/\n/g, '\n    ')}\n${html ? `    (plus an HTML body of ${html.length} characters)\n` : ''}`);
    return { ok: true, provider: 'dev', detail: 'printed to server log (no mail sent)' };
  }
};

/**
 * Send one message. Throws with a human-readable reason; callers decide whether that is fatal.
 * `to` may be one address or a list. Pass `html` for a rendered body; `text` is still required
 * and becomes the fallback for clients that will not render it.
 */
async function send({ to, subject, text, html }) {
  const adapter = adapters[PROVIDER];
  if (!adapter) throw new Error(`Unknown MAIL_PROVIDER "${PROVIDER}". Use graph, smtp or dev.`);
  if (!recipientList(to).length || !subject || !text) throw new Error('send() needs to, subject and text.');
  return adapter({ to, subject, text, html });
}

/** Is this provider actually configured? Used by the readiness check, and by the startup warning. */
function status() {
  if (PROVIDER === 'graph') {
    const missing = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_MAIL_FROM'].filter(k => !(process.env[k] || '').trim());
    return { provider: 'graph', configured: !missing.length, missing, delivers: true };
  }
  if (PROVIDER === 'smtp') {
    const missing = ['SMTP_URL'].filter(k => !(process.env[k] || '').trim());
    return { provider: 'smtp', configured: !missing.length, missing, delivers: true };
  }
  return { provider: 'dev', configured: true, missing: [], delivers: false };
}

module.exports = { send, status, recipientList, _internals: { graphToken, explainAuthError, explainSendError } };

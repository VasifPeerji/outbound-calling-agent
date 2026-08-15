# OmniReach — Going live (HTTPS, database, partner accounts)

Everything below is optional for local use. It matters once the console is on a public URL that
partners log in to.

---

## 1. Move data into a managed Postgres

Without a database, users/calls/profiles live in JSON files under `web/backend/data/`. Most hosts
(Render, Railway, Fly) give containers an **ephemeral filesystem**, so every deploy wipes that folder
and your partner accounts disappear. A managed Postgres fixes it.

**"Managed" means you do not run a database server.** The provider hosts it on their infrastructure,
keeps it up 24/7, and hands you one connection string. Nothing to install, patch, or back up.
Free tiers that comfortably hold ~500 users: **[Neon](https://neon.tech)** (recommended: serverless,
scales to zero), [Supabase](https://supabase.com), [Railway](https://railway.app).

1. Create a database and copy the connection string.
2. Put it in `web/backend/.env`:
   ```
   DATABASE_URL=postgresql://user:pass@your-host.neon.tech/omnireach?sslmode=require
   ```
3. Copy your existing data across (creates the tables, then verifies the row counts):
   ```bash
   npm run migrate
   ```
   Use `npm run migrate:dry` first if you want a preview that writes nothing. The script **refuses to
   overwrite a database that already has data** unless you pass `--force`, because it replaces tables
   wholesale. Your JSON files are never modified, so they remain a backup.
4. Restart. The startup banner shows `Storage: Postgres at <host>`.

**Tables created:** `users`, `calls`, `user_profiles`, `user_writeback`, `settings`. The volatile parts
of each record are stored as `JSONB`, with the fields we filter on (`user_id`, `call_id`, `ts`,
`simulated`, `email`) promoted to real indexed columns.

If the provider uses a private certificate authority, set `DATABASE_SSL_INSECURE=true`. Prefer not to:
it disables certificate verification. Neon, Supabase, and Railway all work without it.

---

## 2. Set the session signing key

`AUTH_SECRET` signs login tokens. Leave it blank and a random key is written to `data/auth-secret`,
which means **every redeploy signs everyone out**, and two instances behind a load balancer reject each
other's logins. Generate one and set it:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 3. The first admin account

On a completely empty database the server creates one admin and prints it **once** in the startup log.

- Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to choose them, or
- leave `ADMIN_PASSWORD` blank and a strong random password is generated and printed. Copy it from the
  log immediately; it is not stored anywhere in plain text.

Either way the account is flagged `mustChangePassword`, so it has to set a new password at first
sign-in before it can do anything. There is no hard-coded default password anywhere in the codebase.

The startup banner also prints a **security checklist** warning about anything still unsafe for a public
URL (no `AUTH_SECRET`, no `DATABASE_URL`, accounts still on their initial password).

---

## 4. Behind a proxy / load balancer

Hosts terminate TLS in front of your app. So that recording URLs come out as `https://` rather than
`http://`, add near the top of `server.js`:

```js
app.set('trust proxy', 1);
```

---

## 5. How partners get accounts

Two routes, both controlled from **Admin → Sign-up & access** (self sign-up is **off** by default):

- **You create them.** Admin → Add a user. They must change the temporary password at first sign-in.
- **They create their own.** Turn on self sign-up. Anyone on a **trusted domain** you list is approved
  instantly; everyone else lands in a pending queue with an **Approve** button.

Because nobody verifies the mailbox, a trusted domain is not proof of identity: someone could type
`jane@partner.com` without owning it. That is why auto-approved accounts start on the **daily call cap**
you set. An impostor gets a demo login, not your telephony budget. Raise the cap per user once you know
who they are. Adding real email verification (Resend, SendGrid, SMTP) would close this properly.

---

## 6. Guardrails before you hand out the link

Admin → **Guardrails**. Everything is off by default; nothing is enforced until you switch it on.

| Setting | What it does |
|---|---|
| Enforce daily limits | Stops a partner's **real** calls once they hit their daily cap. A running campaign stops cleanly. |
| Default daily limit | Applies to users with no explicit limit of their own. |
| Rate limit | Calls per minute, per user. |
| Simulation-only | Forces everyone into dry-run mode. Zero telephony spend — ideal for a wide-open demo link. |

Admins are exempt, and **simulated calls never count** against any limit.

---

## 7. Deploy checklist

- [ ] `DATABASE_URL` set, `npm run migrate` run, banner shows Postgres
- [ ] `AUTH_SECRET` set to a long random string
- [ ] First admin password changed (the forced prompt handles this)
- [ ] `PUBLIC_BASE` set to the HTTPS URL, so ElevenLabs can reach the tool webhooks
- [ ] `app.set('trust proxy', 1)` if behind a load balancer
- [ ] ElevenLabs + Twilio credentials in the host's environment variables, never in code
- [ ] Twilio international permissions enabled for the countries you will demo to
- [ ] Guardrails reviewed, and self sign-up configured the way you want it
- [ ] `data/` and `.env` still gitignored (they are by default)

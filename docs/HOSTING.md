# Hosting OmniReach

Everything the infrastructure team needs, and everything the application owner needs to fill in
afterwards. It is one Node process that serves both the API and the web console, so there is no
separate front end to deploy.

---

## For the infrastructure team

**What it is:** a Node.js application (Node 18 or newer). One process. No build step, no bundler.

**What it needs**

| | |
|---|---|
| Runtime | Node.js 18+ |
| Install | `npm ci --omit=dev` inside `web/backend` (a lockfile is committed, so this is reproducible) |
| Start | `npm start` inside `web/backend` (runs `node server.js`) |
| Listens on | `process.env.PORT`, falling back to 3002. Set `PORT` if the platform expects a specific one. |
| Root directory | `web/backend` |
| Health check | `GET /api/health` |
| Database | External managed Postgres, already provisioned. Nothing to install. |
| Storage | None. The filesystem is not used for anything that must survive a restart. |
| Outbound access | `api.elevenlabs.io`, `login.microsoftonline.com`, `graph.microsoft.com`, and the Postgres host |
| Inbound | HTTPS only |

**Important:** clone the whole repository, then set the root directory to `web/backend`. The
application reads `config/` and `prompts/` from two levels up, so those folders must be present on
disk even though the process starts inside `web/backend`.

### Running under PM2

A process definition is committed at `ecosystem.config.js` in the repository root.

```bash
git clone https://github.com/VasifPeerji/outbound-calling-agent.git
cd outbound-calling-agent/web/backend && npm ci --omit=dev && cd ../..
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup        # bring it back after a server reboot
```

Then, day to day:

```bash
pm2 logs omnireach             # follow the log
pm2 reload omnireach           # restart after a deploy
pm2 status
```

**Keep it at one instance.** The config sets `instances: 1` deliberately, and it should stay that
way. Two parts of the application assume a single writer: the scheduler fires on its own timer, so a
second copy would ring the same customers a second time, and the storage layer rewrites whole tables
on save, so copies would overwrite each other. Scale by giving the machine more resources, not by
adding instances.

**Secrets do not go in `ecosystem.config.js`.** It is committed to the repository. On a server you
manage yourself, put them in `web/backend/.env` (owned by the service account, permissions `600`) or
export them in the shell PM2 starts from. On a managed platform, use that platform's own environment
settings instead — see the next section.

`env_production` already sets `TRUST_PROXY=true`, which is correct for the usual PM2-behind-nginx
arrangement.

**What we need back from you:** the final HTTPS URL. Nothing else, and it does not have to exist
before the code is deployed. See "About PUBLIC_BASE" below for why.

**If the platform sits behind a load balancer or reverse proxy** (Render, Railway, Azure App
Service, nginx, any managed platform): set `TRUST_PROXY=true`. Explained below.

---

## Environment variables

Where they go depends on how you are hosting:

- **A managed platform** (Render, Railway, Azure App Service, Elastic Beanstalk): use the platform's
  own environment settings. Nothing is written to disk.
- **A server you manage, under PM2**: `web/backend/.env`, permissions `600`, owned by the service
  account. The application reads it on start.

Either way the file in this repository is `.env.example` and is a template only. A real `.env` is
gitignored and never leaves the machine it was written on.

### Required

```
DATABASE_URL      postgresql://…?sslmode=require     the managed Postgres connection string
AUTH_SECRET       (48+ random bytes, hex)            signs login sessions
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID
ELEVENLABS_AGENT_PHONE_NUMBER_ID
MAIL_PROVIDER     graph
GRAPH_TENANT_ID
GRAPH_CLIENT_ID
GRAPH_CLIENT_SECRET
GRAPH_MAIL_FROM   notification@streebo.com
```

### Required once hosted

```
PUBLIC_BASE               https://your-hosted-url    no trailing slash
TRUST_PROXY               true                       if there is a proxy in front (there usually is)
PLATFORM_ORG              streebo.com                which organisation owns the platform
TOOL_WEBHOOK_SECRET       (32+ random bytes, hex)    see below — set this before the URL is public
ELEVENLABS_WEBHOOK_SECRET (from the ElevenLabs UI)   see below
```

**The last two are the ones easiest to skip, and the two that matter once the address is public.**

Two routes answer without a login, on purpose: the voice agent calls back into this server during a
call, and ElevenLabs pushes the finished conversation to it afterwards. Neither caller is a person,
so neither can hold a session. Each has a shared secret instead — and **both default to not checking
when the secret is blank**, which is right on a laptop and wrong on the internet.

- `TOOL_WEBHOOK_SECRET` — any long random string; generate it the same way as `AUTH_SECRET`. Set it,
  then open the console's Settings page and press **Create & attach all tools** so ElevenLabs starts
  sending the matching header. Until it is set, anyone who finds the URL can write outcomes into real
  call records or mark a customer do-not-call.
- `ELEVENLABS_WEBHOOK_SECRET` — copy the signing secret ElevenLabs shows when the post-call webhook
  is configured. Until it is set, an unsigned POST could overwrite a real conversation's transcript.

The server checks both at start-up and prints a warning if `PUBLIC_BASE` is set while either is
missing, so this cannot be forgotten quietly.

`AUTH_SECRET` matters more than it looks. If it is blank, a random one is generated on each boot,
which signs everybody out on every redeploy and makes two instances reject each other's logins.
Generate one with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## About PUBLIC_BASE

**What it is:** the address at which this server can be reached from the public internet.

**Why it exists:** during a call the agent takes real actions — recording the outcome, booking a
callback, marking a do-not-call request. Those are performed by ElevenLabs' cloud calling *back
into* this server over the internet. It cannot reach a laptop, and it cannot reach a private
address. `PUBLIC_BASE` is how it is told where to find us.

**Set it before or after hosting?** After. It has to be the real URL, and until the platform has
deployed something there is no real URL to use. Nothing breaks in the meantime:

- Calls work completely without it. Dialling, conversation, voice, language, recordings,
  transcripts and analytics are all unaffected.
- Only the fourteen action tools are inactive, and while they are, the agent is explicitly
  instructed not to claim it has recorded or booked anything.

**What happens when you set it:** on the next restart the server registers all fourteen tools with
ElevenLabs and attaches them, using this URL. No button to press. It is idempotent, so later
restarts are a no-op, and after a redeploy it re-points every tool by itself.

**Order of work:** deploy → get the URL → set `PUBLIC_BASE` → restart. That is the whole sequence.

> If a second instance ever shares the same ElevenLabs workspace (a staging copy, say), set
> `AUTO_SYNC_TOOLS=false` on that one. Otherwise the two keep overwriting each other's tool URLs.

---

## Putting it behind HTTPS

**The application does not need to change, and its port does not need to change.**

It speaks plain HTTP on `PORT` (3002 by default) and is designed to sit behind something that
terminates TLS. That is the normal arrangement and it is the one to use here:

```
browser ──HTTPS:443──▶ nginx / load balancer ──HTTP──▶ 127.0.0.1:3002 (this app)
         certificate lives here                        no certificate, no change
```

**Please do not make the application listen on 443 directly.** Three reasons:

1. Ports below 1024 need root on Linux, and this process should not run as root.
2. The certificate would then live inside the application, so every renewal means an application
   restart. In front of it, renewals never touch the app at all.
3. Redirecting HTTP to HTTPS, security headers and connection limits are all things the proxy
   already does well.

### What the proxy needs to send

Two headers, or things break in ways that are not obvious:

```nginx
server {
    listen 443 ssl;
    server_name omnireach.smartcogs.ai;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # Recordings can be several minutes of audio, and a call detail waits on the provider.
    proxy_read_timeout 300s;
    client_max_body_size 12m;          # CSV uploads

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # REQUIRED, see below
    }
}

server {                                # send plain HTTP to HTTPS
    listen 80;
    server_name omnireach.smartcogs.ai;
    return 301 https://$host$request_uri;
}
```

### The same thing in Apache

Apache is what answers on `smartcogs.ai`, so this is probably the one you want. It needs
`mod_ssl`, `mod_proxy`, `mod_proxy_http` and `mod_headers`
(`a2enmod ssl proxy proxy_http headers && systemctl reload apache2`).

```apache
<VirtualHost *:443>
    ServerName omnireach.smartcogs.ai

    SSLEngine on
    SSLCertificateFile      /path/to/fullchain.pem
    SSLCertificateKeyFile   /path/to/privkey.pem

    ProxyPreserveHost On
    ProxyTimeout 300
    LimitRequestBody 12582912

    # mod_proxy sets X-Forwarded-For by itself; this one has to be set by hand.
    RequestHeader set X-Forwarded-Proto "https"

    ProxyPass        / http://127.0.0.1:3002/
    ProxyPassReverse / http://127.0.0.1:3002/
</VirtualHost>

<VirtualHost *:80>
    ServerName omnireach.smartcogs.ai
    Redirect permanent / https://omnireach.smartcogs.ai/
</VirtualHost>
```

If the machine terminating TLS is **not** the machine running the application, replace
`127.0.0.1:3002` with the application server's address, and make sure that hop is reachable and
firewalled to the proxy alone. The application should never be reachable on 3002 from outside.

`X-Forwarded-Proto` is the one that is easy to leave out. The application builds the URL for a call
recording from the incoming request, so without that header it produces an `http://` link on an
`https://` page and the browser silently blocks it as mixed content: **everything works except
playing a recording.** With the header, and with `TRUST_PROXY=true` set on the application, the link
comes out as `https://` and plays.

`X-Forwarded-For` matters for a different reason: without it every request appears to come from the
proxy, so the per-IP sign-in rate limits would treat the whole internet as one client.

### The same thing on Windows, in IIS

If the server is Windows, IIS is the front end. It needs two free Microsoft add-ons, neither of
which ships by default: **URL Rewrite** and **Application Request Routing (ARR)**.

1. Install both, then in IIS Manager open the **server** node (not the site) → *Application Request
   Routing Cache* → *Server Proxy Settings* → tick **Enable proxy**.
2. Create a site bound to `https` on port 443 for `omnireach.smartcogs.ai`, and select the
   certificate in the binding.
3. Put this `web.config` in that site's folder. The site serves nothing itself; every request is
   handed to the application.

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="OmniReach" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3002/{R:1}" />
          <serverVariables>
            <!-- Without this the app builds recording links as http:// on an https:// page. -->
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- CSV uploads: 12 MB. IIS default is 30 MB but the rewrite module is stricter. -->
        <requestLimits maxAllowedContentLength="12582912" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
```

`HTTP_X_FORWARDED_PROTO` has to be allowed before a rule may set it: IIS Manager → the site → *URL
Rewrite* → *View Server Variables* → **Add** `HTTP_X_FORWARDED_PROTO`. Skipping that step makes the
rule fail with a 500 rather than silently, which is at least honest.

ARR adds `X-Forwarded-For` by itself, so nothing further is needed for the rate limits.

### On the application side

Exactly two environment variables, then one restart:

```
TRUST_PROXY=true
PUBLIC_BASE=https://omnireach.smartcogs.ai
```

`TRUST_PROXY` tells it to believe those two headers. `PUBLIC_BASE` is the address ElevenLabs calls
back on during a call; set it to the final public name, not the IP.

### A note on `https://10.0.103.50`

Reaching the app over HTTPS on the private IP works, but the browser will warn about the
certificate, and that is not a misconfiguration. Public certificate authorities do not issue
certificates for private IP addresses, so that step can only ever use a self-signed or internal-CA
certificate. The warning goes away once the real name, `omnireach.smartcogs.ai`, is in front of it
with its own certificate.

One side effect worth knowing about: the application sends an HSTS header, so a browser that has
once loaded `https://10.0.103.50` will refuse to load `http://10.0.103.50` afterwards. If somebody
needs to go back to plain HTTP on the IP for a test, clear the HSTS entry for that host
(`chrome://net-internals/#hsts`) rather than assuming the server broke.

---

## About TRUST_PROXY

**What it is:** a switch telling the application that something sits in front of it.

**Why it matters:** managed platforms do not hand traffic to your process directly. A load balancer
receives the request and forwards it on, so from the application's point of view **every request in
the world arrives from that one load balancer**. Without correcting for it, two things break:

1. **Rate limits collapse.** The sign-in limits are per IP address. If every request looks like it
   came from the same place, the whole internet is counted as one client and a handful of people
   signing in locks everybody out.
2. **Access requests become useless.** When somebody outside the approved domains tries to sign in,
   the admin dashboard records where they came from. Without this, every single entry shows the data
   centre's location instead of the person's.

The load balancer adds a header saying who the request really came from. `TRUST_PROXY=true` tells
the application to read it.

**Why it is not simply on by default:** with nothing in front, anyone could send that header
themselves and claim any address they liked, sidestepping the rate limits. So it is on only where
there is a real proxy to trust — and it trusts exactly one hop, not the whole chain.

**Rule of thumb:** hosted on a managed platform → `true`. Running on a laptop → leave it `false`.

---

## After the first deploy

1. **Sign in.** Existing accounts work unchanged; the database comes with them.
2. **Check the boot log.** It states which organisation owns the platform, who the super
   administrators are, and where the daily report is addressed. If any of those looks wrong, fix it
   before letting partners in.
3. **Add the approved email domains** under Admin → Sign-up & limits. Until a domain is listed,
   people from it are refused and land in the access-request queue instead.
4. **Turn on the daily allowance** under Admin → Sign-up & limits → Guardrails when you want it enforced.
5. **Confirm mail works** by signing in with a code, or run `npm run mail:test -- you@streebo.com`.
6. **Check the daily report** under Admin → Daily report. Press *Preview* to see exactly what will
   be sent, and *Send a test to me* to prove delivery end to end.

---

## Deploying an update

Every deploy after the first one is this. Nothing here needs the database touched.

```bash
cd outbound-calling-agent
git pull
cd web/backend && npm ci --omit=dev
pm2 reload omnireach
pm2 logs omnireach --lines 40      # confirm it came up clean
```

`npm ci` is worth running even when no dependency changed: it is fast when the lockfile is
unchanged, and it is the only thing that keeps the installed tree honest if one ever does.

**The runtime data is not in the repository.** Accounts, call history, profiles and settings live in
Postgres (`DATABASE_URL`), so a deploy never disturbs them. If `DATABASE_URL` is unset the same data
sits in `web/backend/data/`, which most hosts wipe on deploy — that is why the boot log warns about
it.

### Checking it before you trust it

```bash
cd web/backend && npm test
```

Plain Node, no framework, no network, and it neither reads nor writes the live database: each suite
builds a throwaway copy of the app under the system temp folder with its own port, a blank
`DATABASE_URL` and `MAIL_PROVIDER=dev`. Safe to run on the server. It prints `all N suites passed`.

### Does this release need anything else?

Check these three before assuming not:

| Question | Where to look |
|---|---|
| New dependency? | `git diff <old>..<new> -- web/backend/package.json` |
| New environment variable? | `git diff <old>..<new> -- web/backend/ \| grep 'process.env'` |
| Database change? | `git diff --stat <old>..<new> -- web/backend/store.js web/backend/migrate-to-postgres.js` — empty means nothing to migrate |

### One-off: refreshing the post-call scoring

The criteria the agent scores finished calls against live **on the ElevenLabs agent**, not in this
repository, so a deploy does not update them. They used to be generated from whichever profile the
administrator had open, which meant one partner's industry could end up scoring another partner's
calls. They are now generic — the nine call archetypes, identical for every partner — but the old
ones stay on the agent until someone replaces them:

```bash
curl -X POST https://omnireach.smartcogs.ai/api/elevenlabs/analysis/sync \
  -H "Authorization: Bearer <a platform admin's token>"
```

Run it once after this release. It only changes how calls are SCORED afterwards; it has no effect on
what any customer hears, because everything spoken is sent per call rather than stored on the agent.

---

## The daily activity report

Once a day the server emails Streebo one message covering **every partner**: calls placed, who they
called and in which country, talk time, the industries demonstrated, and any allowance boosts in
force. It exists so nobody has to log in and page through the console to know whether the platform
is being used.

Nothing needs configuring on the host beyond working mail. The defaults are:

| Setting | Default |
| --- | --- |
| Send at | 00:15 |
| Day boundary | `Asia/Kolkata` — midnight to midnight, India time |
| Recipients | vasif.peerji@streebo.com, presales@streebo.com, vibhuti.ramanuj@streebosolutions.com |

All of it is editable in the console under **Admin → Daily report**, by a super administrator only.

Three things worth knowing:

- **The day is a real day in a real place.** The window is midnight to midnight in the report's own
  timezone, never the host's clock, so moving the server to a machine in another region does not
  silently redraw every day boundary. The report always covers the day that has just *finished*,
  whatever hour it is sent at.
- **No recordings are attached.** A day across every partner would be tens of megabytes, and
  Microsoft Graph's simple send would refuse it. The report carries everything needed to decide
  which conversations are worth hearing; the audio stays in the console behind the usual
  permissions. That also stops a message sitting in an inbox from becoming an unguarded copy of real
  customer conversations.
- **It cannot be sent to a partner.** It puts every customer's activity side by side, so an address
  on a partner's own domain is refused outright rather than merely discouraged. Only a super
  administrator can change the recipients at all.

If it fails to send, the server retries on its next check, up to five times for that day, and both
the failure and the reason appear in the log and under Admin → Daily report → Delivery. A restart or
an overnight outage cannot make a day disappear: whenever the process is next alive past the send
time, the day it owes still goes out.

**What happens on the very first boot.** A brand-new instance has no record of ever having sent one.
If it starts up more than two hours after the send time, it does *not* post a report for a day that
closed hours ago; it arms itself for the next one and says so in the log:

```
📊  Daily report armed for 00:15 Asia/Kolkata. 2026-08-15 was NOT sent: this instance was not
    running when that day closed, and it is now 22:44 there.
```

That is deliberate. Without it, deploying at four in the afternoon posts yesterday's report
immediately, which reads as a fault rather than a feature. A genuinely missed run, on an instance
that has sent before, still goes out however late it is. If you do want the skipped day, press
**Send to everyone now**.

## Verifying it is healthy

```
GET /api/health          no authentication, suitable for the platform's health check
GET /api/preflight       signed in as a platform admin: credentials, public URL, tool status
```

## Twilio note

International calling is off by default on a new Twilio account. If calls to a particular country
fail while others succeed, enable geographic permissions for that country in the Twilio console.
This has caught us before, on a Botswana number.

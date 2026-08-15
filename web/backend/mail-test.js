#!/usr/bin/env node
/**
 * OmniReach — prove the mail credential works, before anything is built on top of it.
 *
 *   npm run mail:test                     check config + token + permissions, send nothing
 *   npm run mail:test -- you@company.com  ...then actually send a test message there
 *
 * The useful part is the permissions check. A client-credentials token carries a `roles` claim
 * listing the APPLICATION permissions it was actually granted. If Mail.Send is missing from it,
 * IT granted a Delegated permission instead, which needs a signed-in user and can never work for
 * an unattended service. That is by far the most common way this request comes back broken, and
 * this catches it without sending a single message or waiting to see a confusing 403.
 */
require('dotenv').config();
const mailer = require('./mailer');

const to = process.argv.slice(2).find(a => a.includes('@'));
const ok = s => `  \x1b[32m✓\x1b[0m ${s}`;
const no = s => `  \x1b[31m✗\x1b[0m ${s}`;
const hm = s => `  \x1b[33m•\x1b[0m ${s}`;

// Never print a secret. Enough to prove the right thing was pasted, not enough to leak it.
const fingerprint = v => !v ? '(not set)' : `${v.length} chars, ends "${v.slice(-4)}"`;

(async () => {
  console.log('\n📧  OmniReach — mail credential check\n');

  const st = mailer.status();
  console.log(`  provider: ${st.provider}`);
  if (st.provider === 'dev') {
    console.log(hm('MAIL_PROVIDER is "dev", so nothing is actually delivered.'));
    console.log('    Set MAIL_PROVIDER=graph in web/backend/.env once you have the credential.\n');
    process.exit(0);
  }
  if (!st.configured) {
    console.log(no(`missing: ${st.missing.join(', ')}`));
    console.log('\n    Add them to web/backend/.env and run this again.\n');
    process.exit(1);
  }

  if (st.provider === 'graph') {
    console.log(ok(`GRAPH_TENANT_ID     ${process.env.GRAPH_TENANT_ID.trim()}`));
    console.log(ok(`GRAPH_CLIENT_ID     ${process.env.GRAPH_CLIENT_ID.trim()}`));
    console.log(ok(`GRAPH_CLIENT_SECRET ${fingerprint(process.env.GRAPH_CLIENT_SECRET.trim())}`));
    console.log(ok(`GRAPH_MAIL_FROM     ${process.env.GRAPH_MAIL_FROM.trim()}`));

    // A secret Value and a Secret ID look similar at a glance, but a Secret ID is a GUID and a
    // Value never is. Catching that here saves a confusing AADSTS7000215 round-trip.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.env.GRAPH_CLIENT_SECRET.trim())) {
      console.log(no('GRAPH_CLIENT_SECRET looks like a GUID, which means it is the "Secret ID", not the "Value".'));
      console.log('    Azure shows the Value only once at creation. If it was not saved, IT must issue a new secret.\n');
      process.exit(1);
    }

    console.log('\n  requesting a token from Entra...');
    let token;
    try { token = await mailer._internals.graphToken(); }
    catch (e) { console.log(no(e.message) + '\n'); process.exit(1); }
    console.log(ok('token issued, so tenant id, client id and secret are all correct'));

    // Inspect the token's own claims. Not verifying it, just reading what Entra says it grants.
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      const roles = claims.roles || [];
      if (roles.includes('Mail.Send')) console.log(ok(`application permission granted: ${roles.join(', ')}`));
      else if (!roles.length) {
        console.log(no('the token carries NO application permissions.'));
        console.log('    Mail.Send was most likely added as a Delegated permission, or admin consent was never granted.');
        console.log('    Ask IT for: Microsoft Graph > APPLICATION permissions > Mail.Send, then "Grant admin consent".');
      } else {
        console.log(no(`granted permissions are [${roles.join(', ')}] but Mail.Send is not among them.`));
      }
      if (claims.exp) console.log(hm(`token valid until ${new Date(claims.exp * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z`));
    } catch { console.log(hm('could not decode the token claims (harmless, the send test still applies)')); }
  }

  if (!to) {
    console.log('\n  Config looks right. To send a real test message:');
    console.log('      npm run mail:test -- vasif.peerji@streebo.com\n');
    process.exit(0);
  }

  console.log(`\n  sending a test message to ${to} ...`);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  try {
    const r = await mailer.send({
      to,
      subject: `OmniReach test — code ${code}`,
      text: `This is a test of OmniReach sign-in code delivery.\n\nSample code: ${code}\n\nIf you received this, mail delivery is working and no further IT action is needed.`
    });
    console.log(ok(`accepted by ${r.provider} (${r.detail})`));
    console.log(`\n  Check ${to}. If it is not in the inbox within a minute, look in Junk:`);
    console.log('  landing in Junk is a reputation problem, not a credential problem, and is fixed differently.\n');
  } catch (e) {
    console.log(no(e.message) + '\n');
    process.exit(1);
  }
})();

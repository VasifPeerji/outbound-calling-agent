#!/usr/bin/env node
/**
 * OmniReach — promote (or create) an administrator from the server console.
 *
 *   npm run make-admin -- you@company.com              make this address an admin
 *   npm run make-admin -- you@company.com super        ...as a SUPER admin (the owner tier)
 *   npm run make-admin -- you@company.com demote       drop them back to a normal user
 *   npm run users                                      list accounts and their roles
 *
 * Write the keywords WITHOUT leading dashes. `npm run` treats an unrecognised --flag as its own
 * configuration and never passes it on, so `-- you@company.com --super` arrives here as just the
 * email and quietly creates a plain admin. Both spellings work when calling node directly.
 *
 * WHY THIS EXISTS: sign-in by emailed code always creates a PLAIN USER, and the first-admin seed
 * only fires on a completely empty database. Without this there is a deadlock on a database that
 * already has accounts: you cannot reach the Admin page to whitelist your own company's domain
 * unless you are already an admin, and you cannot become an admin without the Admin page.
 *
 * An account created here has NO PASSWORD. That is deliberate: it exists only so the person can be
 * sent a sign-in code, and an existing active account is allowed to request one even before their
 * domain is whitelisted. So the bootstrap is:
 *
 *   1. npm run make-admin -- you@yourcompany.com
 *   2. sign in on the login screen with that address and the code you receive
 *   3. Admin page → add your domain to the whitelist → everyone else can now self-serve
 *
 * SECURITY: this grants full administrative access with no authentication, so it is restricted to
 * whoever can already run commands on the server. That person can read .env and the database
 * directly, so this hands them nothing they did not already have.
 */
require('dotenv').config();
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();   // Node's own, no dependency
const store = require('./store');
const auth = require('./auth');

const args = process.argv.slice(2).filter(a => a !== '--');
// Accept both "--super" and a bare "super". npm run SWALLOWS unknown --flags as its own config, so
// `npm run make-admin -- x@y.com --super` silently arrives here as just the email, and the account
// is created one tier lower than asked for with no warning. The bare keyword survives npm intact.
const has = (...names) => names.some(n => args.includes(n));
const demote = has('--demote', 'demote');
// The owner tier: full control, decides who else may create admins, and cannot be demoted, disabled
// or signed out by anyone below it. Console-only, so no stolen admin session can mint a peer.
const superAdmin = has('--super', 'super');
const email = (args.find(a => a.includes('@')) || '').trim().toLowerCase();

(async () => {
  console.log('\n👑  OmniReach — administrator\n');
  if (!email) {
    // Distinguish "you typed nothing" from "you typed something that is not an address", otherwise
    // a typo silently reads as a missing argument and sends the reader looking in the wrong place.
    const KEYWORDS = ['super', 'demote', 'force'];
    const junk = args.filter(a => !a.startsWith('--') && !KEYWORDS.includes(a));
    if (junk.length) console.error(`  "${junk.join(' ')}" is not an email address.\n`);
    console.error('  Usage (keywords take NO dashes through npm):');
    console.error('      npm run make-admin -- you@yourcompany.com');
    console.error('      npm run make-admin -- you@yourcompany.com super');
    console.error('      npm run make-admin -- you@yourcompany.com demote\n');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error(`  "${email}" is not a valid email address.\n`); process.exit(1); }

  // REFUSE TO RUN AGAINST A LIVE SERVER. The server keeps every account in memory and rewrites the
  // WHOLE table on its next save, so a change written here is silently erased the moment anyone
  // edits a user, adjusts a guardrail, or the debounced writer flushes. The change appears to
  // succeed and then quietly disappears, which is the worst possible failure for a command whose
  // entire job is to restore access.
  if (!has('--force', 'force')) {
    const running = await new Promise(resolve => {
      const r = require('http').get({ host: '127.0.0.1', port: process.env.PORT || 3002, path: '/api/health', timeout: 1500 },
        res => { res.resume(); resolve(res.statusCode > 0); });
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
    });
    if (running) {
      console.error(`  ⚠️   The server is running on port ${process.env.PORT || 3002}.`);
      console.error('      Stop it first, then run this again. It holds every account in memory and');
      console.error('      would overwrite this change on its next save, without any error.\n');
      console.error('      Stop the server (Ctrl+C in its window, or 3-STOP.bat), then retry.');
      console.error('      If you are certain nothing is running here, add --force.\n');
      process.exit(1);
    }
  }

  let where;
  try { where = await store.init(); }
  catch (e) { console.error(`  Could not open the data store: ${e.message}\n`); process.exit(1); }
  const data = await store.loadAll();
  auth.setUsers(data.users || []);
  console.log(`  Store: ${where.detail}`);

  const existing = auth.findByEmail(email);

  if (demote) {
    if (!existing) { console.error(`\n  No account for ${email}.\n`); await store.close(); process.exit(1); }
    const all = auth.loadUsers().filter(u => u.active !== false);
    // Refuse to remove the last administrator: an installation with none cannot be recovered
    // through the console at all, only by running this script again.
    const admins = all.filter(u => u.role === 'admin');
    if (existing.role === 'admin' && admins.length <= 1) {
      console.error(`\n  ${email} is the only administrator. Promote someone else first, or nobody could reach the Admin page.\n`);
      await store.close(); process.exit(1);
    }
    // Same reasoning one tier up: with no super administrator left, nobody can decide who may
    // create admins, and the tier could only be restored from here.
    const supers = all.filter(u => u.role === 'admin' && u.superAdmin);
    if (existing.superAdmin && supers.length <= 1) {
      console.error(`\n  ${email} is the only SUPER administrator. Run this first, then retry:`);
      console.error(`      npm run make-admin -- someone.else@yourcompany.com --super\n`);
      await store.close(); process.exit(1);
    }
    existing.role = 'user'; delete existing.superAdmin; delete existing.canGrantAdmin;
    auth.upsertUser(existing);
    await store.flush(); await store.close();
    console.log(`\n  ✅  ${email} is now a normal user.\n      Restart the server if it is running.\n`);
    return;
  }

  if (existing) {
    const was = existing.superAdmin ? 'super admin' : (existing.role || 'user');
    existing.role = 'admin';
    existing.active = true; existing.pending = false;   // an admin awaiting approval makes no sense
    if (superAdmin) { existing.superAdmin = true; existing.canGrantAdmin = true; }
    auth.upsertUser(existing);
    await store.flush(); await store.close();
    console.log(`\n  ✅  ${email} is now a${superAdmin ? ' SUPER administrator' : 'n administrator'} (was: ${was}).`);
    if (superAdmin) console.log('      Full control, decides who else may create admins, and cannot be demoted,\n      disabled or signed out by anyone below this tier.');
    console.log(`      They keep their existing sign-in method${existing.passwordHash ? ' (password and code both work)' : ' (sign-in code)'}.`);
  } else {
    const u = {
      id: uuidv4(), email, name: email.split('@')[0], org: '', orgId: email.split('@')[1],
      role: 'admin', passwordHash: '', active: true,
      ...(superAdmin ? { superAdmin: true, canGrantAdmin: true } : {}),
      createdAt: new Date().toISOString(), createdBy: 'make-admin cli', signInMethod: 'code',
      quota: { callsPerDay: null, minutesPerDay: null }, usage: { calls: 0 }
    };
    auth.upsertUser(u);
    await store.flush(); await store.close();
    console.log(`\n  ✅  Created ${email} as a${superAdmin ? ' SUPER administrator' : 'n administrator'}, with no password.`);
    console.log(`      Organisation: ${u.orgId}  (colleagues on this domain will share their calls)`);
    console.log(`\n      Sign in at the console with this address. Because the account already exists,`);
    console.log(`      a code will be sent even though the domain is not whitelisted yet.`);
    console.log(`      Then: Admin → Sign-up & access → add "${u.orgId}" to the trusted domains.`);
  }
  console.log('\n      Restart the server if it is running, so it reloads the accounts.\n');
})().catch(e => { console.error('\n❌  Failed:', e.message, '\n'); process.exit(1); });

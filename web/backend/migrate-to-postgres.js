#!/usr/bin/env node
/**
 * OmniReach — one-shot migration: local JSON files  →  managed Postgres.
 *
 *   1. Create a database (Neon / Supabase / Railway / RDS) and copy its connection string.
 *   2. Put it in web/backend/.env as:   DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
 *   3. Run:                             npm run migrate
 *   4. Restart the server. It now reads and writes Postgres; the JSON files are left untouched
 *      as a backup, and you can delete them once you're happy.
 *
 * Safe to re-run: it refuses to clobber a database that already has data unless you pass --force
 * (the writes are a full replace, so an accidental second run against a live DB would otherwise
 * overwrite newer rows with whatever is in the old files).
 *
 *   node migrate-to-postgres.js            migrate, refusing to overwrite existing data
 *   node migrate-to-postgres.js --force    migrate anyway, replacing what's there
 *   node migrate-to-postgres.js --dry-run  report what would be copied, write nothing
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  users: 'users.json', calls: 'calls.json', userProfiles: 'user-profiles.json',
  userWriteback: 'user-writeback.json', activeProfile: 'active-profile.json',
  guardrails: 'guardrails.json', signup: 'signup.json'
};
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

function read(key, fallback) {
  const p = path.join(DATA_DIR, FILES[key]);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`  ! ${FILES[key]} is not valid JSON (${e.message}) — skipping.`); return fallback; }
}
const count = v => Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : (v ? 1 : 0));

(async () => {
  console.log('\n📦  OmniReach — migrate JSON files → Postgres\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌  DATABASE_URL is not set.\n    Add it to web/backend/.env first, e.g.:\n    DATABASE_URL=postgresql://user:pass@your-host.neon.tech/omnireach?sslmode=require\n');
    process.exit(1);
  }

  // Read everything off disk first, so we fail before touching the database if something is corrupt.
  const data = {
    users: read('users', []) || [],
    calls: read('calls', []) || [],
    userProfiles: read('userProfiles', {}) || {},
    userWriteback: read('userWriteback', {}) || {},
    activeProfile: read('activeProfile', null),
    guardrails: read('guardrails', null),
    signup: read('signup', null)
  };

  console.log('  Found locally:');
  console.log(`    users            ${count(data.users)}`);
  console.log(`    calls            ${count(data.calls)}`);
  console.log(`    user profiles    ${count(data.userProfiles)}`);
  console.log(`    write-back cfgs  ${count(data.userWriteback)}`);
  console.log(`    active profile   ${data.activeProfile ? 'yes' : 'no'}`);
  console.log(`    guardrails       ${data.guardrails ? 'yes' : 'no (defaults)'}`);
  console.log(`    signup config    ${data.signup ? 'yes' : 'no (defaults)'}`);

  if (!count(data.users) && !count(data.calls)) console.log('\n  (Nothing much to copy — that is fine, the schema still gets created.)');

  const store = require('./store');
  if (store.backend !== 'postgres') { console.error('\n❌  store.js did not select the Postgres backend. Is DATABASE_URL well-formed?\n'); process.exit(1); }

  let where;
  try { where = await store.init(); }
  catch (e) {
    console.error(`\n❌  Could not connect: ${e.message}`);
    console.error('    Check the host, password and that your IP is allowed. Most managed providers need ?sslmode=require.');
    console.error('    If the provider uses a private CA, set DATABASE_SSL_INSECURE=true (weaker — prefer a proper chain).\n');
    process.exit(1);
  }
  console.log(`\n  Connected: ${where.detail}`);

  const existing = await store.loadAll();
  const hasData = existing.users.length || existing.calls.length;
  if (hasData) {
    console.log(`  Database already holds ${existing.users.length} user(s) and ${existing.calls.length} call(s).`);

    // Say exactly what --force would destroy. Once the server has been pointed at Postgres it writes
    // there directly, so the database is usually AHEAD of the JSON files rather than behind them,
    // and "re-run with --force" reads like a routine next step instead of a wipe. Name the rows that
    // exist only in the database, so the number lands before the flag gets typed.
    const localCallIds = new Set(data.calls.map(c => c.id));
    const localUserIds = new Set(data.users.map(u => u.id));
    const orphanCalls = existing.calls.filter(c => !localCallIds.has(c.id));
    const orphanUsers = existing.users.filter(u => !localUserIds.has(u.id));
    if (orphanCalls.length || orphanUsers.length) {
      console.log('\n  ⚠️   These exist ONLY in the database. A --force run deletes them permanently:');
      if (orphanUsers.length) console.log(`        ${orphanUsers.length} user account(s): ${orphanUsers.map(u => u.email).join(', ')}`);
      if (orphanCalls.length) console.log(`        ${orphanCalls.length} call(s), including everything placed since the server switched to Postgres`);
    }

    // A dry run writes nothing, so it should always be allowed to finish its report. Refusing it too
    // left no safe way to ask "what would this do?" against a live database, which is exactly the
    // moment the question matters most.
    if (!force && !dryRun) {
      console.error('\n⚠️   Refusing to overwrite. This migration REPLACES the tables wholesale, it does not merge.');
      console.error('    If the server has already been running against this database, the database is the newer');
      console.error('    copy and your JSON files are the old backup, so forcing would move you backwards.');
      console.error('    Only use --force if you are deliberately restoring the JSON files over the database.');
      console.error('    To see what would happen without changing anything:  npm run migrate:dry\n');
      await store.close(); process.exit(1);
    }
    if (force) console.log('\n  --force given: replacing everything above.');
  }

  if (dryRun) { console.log('\n  --dry-run: nothing written.\n'); await store.close(); process.exit(0); }

  store.saveUsers(data.users);
  store.saveCalls(data.calls);
  store.saveUserProfiles(data.userProfiles);
  store.saveUserWriteback(data.userWriteback);
  if (data.activeProfile) store.saveSetting('active_profile', data.activeProfile);
  if (data.guardrails) store.saveSetting('guardrails', data.guardrails);
  if (data.signup) store.saveSetting('signup', data.signup);
  await store.flush();

  // Read it back and compare, so we report what actually landed rather than what we hoped.
  const after = await store.loadAll();
  const rows = [
    ['users', count(data.users), after.users.length],
    ['calls', count(data.calls), after.calls.length],
    ['user profiles', count(data.userProfiles), count(after.userProfiles)],
    ['write-back cfgs', count(data.userWriteback), count(after.userWriteback)]
  ];
  console.log('\n  Verified in Postgres:');
  let mismatch = false;
  rows.forEach(([label, from, to]) => { const good = from === to; if (!good) mismatch = true; console.log(`    ${good ? '✓' : '✗'} ${label.padEnd(16)} ${from} → ${to}`); });

  await store.close();

  if (mismatch) {
    console.error('\n❌  Counts do not match. Your JSON files are untouched — investigate before switching over.');
    console.error('    A common cause is duplicate ids or emails in users.json (those get de-duplicated).\n');
    process.exit(1);
  }
  console.log('\n✅  Migration complete. Restart the server and it will use Postgres.');
  console.log('    Your JSON files are untouched — keep them as a backup until you are confident.\n');
})().catch(e => { console.error('\n❌  Migration failed:', e.message, '\n'); process.exit(1); });

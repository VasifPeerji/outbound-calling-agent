#!/usr/bin/env node
/**
 * OmniReach — set a user's password from the terminal.
 *
 * For the cases the console can't help with: nobody can sign in, an admin forgot their password,
 * or you want to set the admin password before handing the link out.
 *
 *   npm run set-password -- admin@streebo.com 'MyNewPassword123'
 *   npm run set-password -- admin@streebo.com                  (generates a strong one)
 *   npm run set-password -- --list                             (show accounts, no changes)
 *
 * Works against whichever store is configured: Postgres if DATABASE_URL is set, JSON files if not.
 * The new password is stored only as a one-way scrypt hash.
 */
require('dotenv').config();
const crypto = require('crypto');
const store = require('./store');
const auth = require('./auth');

const args = process.argv.slice(2).filter(a => a !== '--');
const wantList = args.includes('--list');
const keepFlag = args.includes('--no-force-change');
const positional = args.filter(a => !a.startsWith('--'));
const [emailArg, passwordArg] = positional;

(async () => {
  let where;
  try { where = await store.init(); }
  catch (e) { console.error(`\n❌  Could not reach the store: ${e.message}\n`); process.exit(1); }

  const data = await store.loadAll();
  auth.setUsers(data.users || []);
  const users = auth.loadUsers();
  console.log(`\n🔑  OmniReach — set password   (${where.detail})\n`);

  if (!users.length) {
    console.log('  There are no accounts yet. Start the server once and it will seed the first admin.\n');
    await store.close(); process.exit(0);
  }

  if (wantList || !emailArg) {
    console.log('  Accounts:');
    users.forEach(u => console.log(`    ${(u.email || '').padEnd(32)} ${String(u.role || 'user').padEnd(6)} ${u.active === false ? (u.pending ? 'pending approval' : 'disabled') : 'active'}${u.mustChangePassword ? '  (must change password)' : ''}`));
    if (!wantList) console.log('\n  Usage:  npm run set-password -- <email> [newPassword]');
    console.log('');
    await store.close(); process.exit(0);
  }

  const user = auth.findByEmail(emailArg);
  if (!user) {
    console.error(`  ❌  No account with the email "${emailArg}".`);
    console.error('      Run with --list to see the accounts that exist.\n');
    await store.close(); process.exit(1);
  }

  const password = passwordArg || crypto.randomBytes(12).toString('base64url');
  if (password.length < 8) {
    console.error('  ❌  The password must be at least 8 characters.\n');
    await store.close(); process.exit(1);
  }

  user.passwordHash = auth.hashPassword(password);
  // Default: make them choose their own at next sign-in. --no-force-change sets it as the real password.
  user.mustChangePassword = !keepFlag;
  user.passwordChangedAt = new Date().toISOString();
  // A password reset also un-disables the account, so this can rescue a locked-out admin.
  user.active = true; user.pending = false;
  auth.upsertUser(user);
  await store.flush();

  console.log(`  ✅  Password updated for ${user.email}  (${user.role})`);
  if (!passwordArg) console.log(`\n      New password:  ${password}\n      ← generated; copy it now, it is not stored in plain text anywhere.`);
  console.log(keepFlag
    ? '\n      This is now their permanent password.'
    : '\n      They will be asked to choose their own password at next sign-in.');
  console.log('      If the server is running, restart it so it picks up the change.\n');

  await store.close();
})().catch(e => { console.error('\n❌  Failed:', e.message, '\n'); process.exit(1); });

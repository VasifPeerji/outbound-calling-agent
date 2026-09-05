#!/usr/bin/env node
/**
 * Run every suite in this folder and fail the process if any assertion did.
 *
 *   npm test              all of them
 *   npm test -- router    only the suites whose name contains "router"
 *
 * Each suite is a plain Node script that prints "N passed, M failed" and exits non-zero on failure,
 * with no framework to install: the point is that anyone who can run the app can run the tests.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const filter = process.argv[2] || '';
const suites = fs.readdirSync(__dirname)
  .filter(f => /^t-.*\.js$/.test(f) && f.includes(filter))
  .sort();

if (!suites.length) { console.error('No suites match "' + filter + '".'); process.exit(1); }

let failed = [];
let total = 0;
for (const s of suites) {
  console.log('\n' + '\u2550'.repeat(70) + '\n  ' + s + '\n' + '\u2550'.repeat(70));
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(s);
  total++;
}
console.log('\n' + '\u2500'.repeat(70));
console.log(failed.length ? `${failed.length} of ${total} suites FAILED: ${failed.join(', ')}` : `all ${total} suites passed`);
process.exit(failed.length ? 1 : 0);

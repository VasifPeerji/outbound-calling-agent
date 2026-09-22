/**
 * WHAT A PARTNER READS ON SCREEN, AND IN WHAT WE HAND THEM.
 *
 * The CRM panel listed four vendors by name, with a sentence about adding credentials in
 * connectors.js for administrators and "ready to connect" for partners. The write-back list showed
 * the same four as "(needs creds)". Both read as "these four and nothing else", when the point is
 * that whichever CRM or database a customer runs can be connected, and the admin version is on
 * screen whenever the platform is being demonstrated. The manual repeated the names.
 *
 * Static checks, no server: cheap enough to run every time and exactly the sort of thing that
 * creeps back in when somebody adds a connector.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../..');
const read = p => fs.readFileSync(path.join(SRC, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  OK   ' : '  FAIL ') + m); };

const console_ = read('web/frontend/index.html');
const admin = read('web/backend/ui/admin.html');
const manual = read('docs/USER-GUIDE.html');
const guide = read('web/frontend/guide/index.html');
const PARTNER_GUIDE = 'D:/Streebo/Pre Sales/Notes/Handover/Patner_Q4_2026/guides/omnireach-guide.html';

// The CRM vendors that were listed. "Salesforce Agentforce" legitimately appears in the Agent
// Builder as a platform the agent can be deployed on, which is a different thing entirely, so it
// is excluded rather than flagged.
const VENDORS = /\b(HubSpot|Zoho|PostgreSQL|MySQL|Salesforce(?! Agentforce))\b/g;
const without = (s, rx) => s.replace(rx, '');

console.log('\nTHE CONSOLE NAMES NO CRM:');
const crmFn = console_.slice(console_.indexOf("if (type === 'crm')"), console_.indexOf("const isRest = type === 'rest'"));
ok(crmFn.length > 0, 'found the CRM data-source panel');
ok(!/v\.label|stubs\.map/.test(crmFn), 'it no longer lists the connector names it is given');
ok(!/iAmPlatformAdmin\(\)/.test(crmFn), 'and shows one message to everyone, administrators included');
ok(/not tied to any particular vendor/i.test(crmFn), 'the message is that any CRM or database can be connected');
ok(!/interface-ready|connectors\.js|DATA_INTEGRATION|add credentials/i.test(without(console_, /\/\/.*$/gm)), 'none of the developer wording that was on the panel: adapters, source files, "add credentials"');
ok(!/needs creds/i.test(console_), 'and nothing is marked as needing credentials');
// HubSpot, Zoho, PostgreSQL and MySQL have no legitimate use anywhere in the console. Salesforce
// does, as the Agentforce deployment platform, so it is only checked where connectors are listed.
const ONLY_CRMS = /\b(HubSpot|Zoho|PostgreSQL|MySQL)\b/g;
const vendorHits = (without(console_, /\/\/.*$/gm).match(ONLY_CRMS) || []);
ok(vendorHits.length === 0, 'no CRM vendor is named anywhere in the console' + (vendorHits.length ? ': ' + [...new Set(vendorHits)].join(', ') : ''));
const connectorCode = console_.slice(console_.indexOf('// ══════ DATA SOURCES ══════'), console_.indexOf('async function saveWritebackConfig'));
ok(connectorCode.length > 0 && !/Salesforce/.test(without(connectorCode, /\/\/.*$/gm)), 'and Salesforce is not listed as a data source or write-back destination');

console.log('\nWRITE-BACK OFFERS "YOURS", NOT A SHORT LIST:');
ok(/Your own CRM or database \(set up on request\)/.test(console_), 'one line stands in for every system that is set up on request');
ok(/filter\(\(\[, v\]\) => v\.live\)/.test(console_), 'and only the destinations that work out of the box are selectable');

console.log('\nTHE MANUAL AND THE GUIDE SAY THE SAME:');
const manualHits = manual.match(VENDORS) || [];
ok(manualHits.length === 0, 'the user manual names no CRM' + (manualHits.length ? ': ' + [...new Set(manualHits)].join(', ') : ''));
ok(/not tied to any particular vendor/i.test(manual), 'and says any CRM or database can be connected');
ok(!(guide.match(VENDORS) || []).length, 'nor does the quick guide');

console.log('\nHOW IT WORKS, AND THE MANUAL:');
ok(/id="help-btn"[^>]*href="guide\/"/.test(console_), 'the header has a How it works button that opens the guide');
ok(/target="_blank"/.test(console_.slice(console_.indexOf('id="help-btn"'), console_.indexOf('id="help-btn"') + 400)), 'in a new tab, so the console is not lost');
ok(/New to OmniReach\? See how it works/.test(console_), 'and the sign-in screen offers it too, where a new person needs it most');
ok(/href="guide\/OmniReach-User-Manual\.pdf" download/.test(console_), 'the profile menu offers the manual as a download');
ok(fs.existsSync(path.join(SRC, 'web/frontend/guide/OmniReach-User-Manual.pdf')), 'which is really there to be downloaded');
ok(/Want the full detail\?/.test(guide) && /download="OmniReach-User-Manual\.pdf"/.test(guide), 'the guide itself offers the manual, rather than a file arriving unasked');
if (fs.existsSync(PARTNER_GUIDE)) {
  const partner = fs.readFileSync(PARTNER_GUIDE, 'utf8');
  ok(!/href="\.\.\/"|href="OmniReach-User-Manual/.test(partner), 'the copy sent to partners uses full addresses, so it works wherever it is opened');
  ok(partner.replace(/https:\/\/omnireach\.smartcogs\.ai\/guide\/OmniReach-User-Manual\.pdf/g, 'OmniReach-User-Manual.pdf').replace(/https:\/\/omnireach\.smartcogs\.ai\//g, '../') === guide,
    'and apart from those addresses it is identical to the one the app serves');
} else console.log('  --   partner copy not on this machine, skipped');

console.log('\nTHE DAILY REPORT CAN BE COPIED AND DOWNLOADED:');
ok(/function copyDailyReport\(/.test(console_) && /function downloadDailyReport\(/.test(console_), 'both actions exist');
ok(/'text\/html':/.test(console_) && /'text\/plain':/.test(console_), 'copy carries the formatted report and a plain-text fallback, so it pastes well anywhere');
ok(/pending\.then\(r => new Blob/.test(console_), 'and starts the clipboard write inside the click, which browsers require');
ok(/onclick="copyDailyReport\(\)"/.test(admin) && /onclick="downloadDailyReport\(\)"/.test(admin), 'offered on the report card');
const modal = console_.slice(console_.indexOf('id="report-preview-modal"'), console_.indexOf('id="report-preview-modal"') + 1400);
ok(/copyDailyReport\(\)/.test(modal) && /downloadDailyReport\(\)/.test(modal), 'and inside the preview, where it acts on whichever day is being viewed');

console.log('\nSAVE UPDATES THE SETUP THAT WAS LOADED:');
ok(/let activeBookmark = null/.test(console_), 'the console remembers which setup is loaded');
ok(/'\/api\/bookmarks\/' \+ a\.id, 'POST'/.test(console_), 'and Save updates that setup by its id');
ok(/const suggested = a \? a\.name/.test(console_), 'proposing its existing name, instead of a fresh one built from the company and country');
ok(/\$\{can \? `<button[^`]*updateBookmark/.test(console_), 'Update and delete are only offered where the server says they will work');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

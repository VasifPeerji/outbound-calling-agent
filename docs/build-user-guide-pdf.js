#!/usr/bin/env node
/**
 * Build the user manual PDF from USER-GUIDE.html.
 *
 *   node docs/build-user-guide-pdf.js
 *
 * Two things a plain "print to PDF" cannot do, both of which this handles:
 *
 *   1. PAGE NUMBERS IN THE FOOTER. The command-line --print-to-pdf flag has no way to set a footer
 *      template, so we drive the browser over the DevTools protocol instead and pass one.
 *
 *   2. REAL PAGE NUMBERS IN THE CONTENTS. There is no way to ask a rendered PDF which page a
 *      heading landed on. So we render the document once per section, with the later sections
 *      hidden, and count the pages each time. Section N therefore begins on the page after the last
 *      page of the render that stopped at section N-1. Every section starts on a fresh page, which
 *      is what makes that arithmetic exact rather than approximate.
 *
 * Needs Edge or Chrome installed. No npm packages: Node 22 has a WebSocket client built in.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const DOCS = __dirname;
const SRC = path.join(DOCS, 'USER-GUIDE.html');
const OUT = path.join(DOCS, 'OmniReach-User-Guide.pdf');
// The copy the console serves: the How it works guide and the profile menu both link to it.
// Written by the same build, so the download people get can never lag the manual in docs/.
const PUBLISHED = path.join(DOCS, '..', 'web', 'frontend', 'guide', 'OmniReach-User-Manual.pdf');
const PORT = 9333;

// Page geometry, kept in step with the @page rule in the stylesheet so the cover still bleeds to
// the paper edge.
const MM = mm => mm / 25.4;
const PAGE = { paperWidth: 8.27, paperHeight: 11.69, marginTop: MM(17), marginBottom: MM(20), marginLeft: MM(15), marginRight: MM(15) };

const FOOTER = `<div style="width:100%;font-size:7.5pt;color:#8890A3;padding:0 15mm;
  font-family:-apple-system,'Segoe UI',sans-serif;display:flex;justify-content:space-between;">
  <span>OmniReach User Manual</span><span class="pageNumber"></span></div>`;

function findBrowser() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  const hit = candidates.find(p => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome or Edge found. Install one, or add its path to findBrowser().');
  return hit;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Minimal DevTools client. One socket, numbered requests, promises keyed by id. */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('DevTools socket failed'));
    ws.onopen = () => resolve({
      send: (method, params) => new Promise((res, rej) => {
        const n = ++id;
        pending.set(n, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      }),
      close: () => ws.close()
    });
  });
}

const pageCount = b64 => {
  const buf = Buffer.from(b64, 'base64');
  return (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
};

(async () => {
  if (!fs.existsSync(SRC)) throw new Error('USER-GUIDE.html not found beside this script.');
  const browser = findBrowser();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnireach-pdf-'));
  const fileUrl = 'file:///' + SRC.replace(/\\/g, '/').replace(/ /g, '%20');

  console.log('browser :', browser);
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, fileUrl
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint, then find the tab showing our file.
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('USER-GUIDE'));
    } catch (e) { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('The browser never exposed the page over DevTools.'); }

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(600);   // let fonts settle, or the first render paginates differently

  const evaluate = async expr => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const render = async () => (await cdp.send('Page.printToPDF', {
    ...PAGE, printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<span></span>', footerTemplate: FOOTER, preferCSSPageSize: false
  })).data;

  const ids = await evaluate(`[...document.querySelectorAll('section[id]')].map(s => s.id)`);
  console.log('sections:', ids.length);

  // ── work out where each section starts ──
  // Hide everything from section k onwards, render, and count. The last page of that render is the
  // page section k-1 finishes on, so section k opens on the page after it.
  console.log('measuring pagination', '.'.repeat(ids.length + 1));
  const startPage = {};

  // The front matter on its own. The container has to go too: hiding only the sections leaves an
  // empty page behind, because the contents block ends with a page break either way, and counting
  // that blank would push every figure in the contents one page late.
  await evaluate(`document.querySelector('section[id]').parentElement.style.display = 'none'`);
  await sleep(120);
  const frontMatter = pageCount(await render());
  await evaluate(`document.querySelector('section[id]').parentElement.style.display = ''`);

  let prevTotal = frontMatter;
  for (let k = 1; k <= ids.length; k++) {
    await evaluate(`
      (() => {
        document.querySelectorAll('section[id]').forEach((s, i) => { s.style.display = (i < ${k}) ? '' : 'none'; });
        return true;
      })()`);
    await sleep(120);
    startPage[ids[k - 1]] = prevTotal + 1;
    prevTotal = pageCount(await render());
  }
  await evaluate(`document.querySelectorAll('section[id]').forEach(s => s.style.display = '')`);
  console.log('front matter:', frontMatter, 'pages');

  // ── write those numbers into the contents ──
  const filled = await evaluate(`
    (() => {
      const pages = ${JSON.stringify(startPage)};
      let n = 0;
      for (const el of document.querySelectorAll('.toc .pg[data-pg]')) {
        const p = pages[el.dataset.pg];
        if (p) { el.textContent = String(p); n++; }
      }
      return n;
    })()`);
  console.log('contents entries numbered:', filled, 'of', ids.length);
  if (filled !== ids.length) throw new Error('Some contents entries have no matching section.');

  await sleep(200);
  const finalB64 = await render();
  const pages = pageCount(finalB64);
  fs.writeFileSync(OUT, Buffer.from(finalB64, 'base64'));
  fs.mkdirSync(path.dirname(PUBLISHED), { recursive: true });
  fs.copyFileSync(OUT, PUBLISHED);

  // The measurement assumed the contents stays one page. If numbering it had pushed the document
  // onto another page, every figure in it would be one short, so check rather than hope.
  const expected = prevTotal;
  if (pages !== expected) throw new Error(`Pagination shifted after numbering (${expected} -> ${pages}). The contents no longer fits on one page.`);

  console.log('\nwrote', path.relative(process.cwd(), OUT));
  console.log('published', path.relative(process.cwd(), PUBLISHED), '(served at /guide/)');
  console.log('pages:', pages, '| size:', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
  console.log('\ncontents:');
  for (const id of ids) console.log('  ' + String(startPage[id]).padStart(3) + '  ' + id);

  cdp.close();
  proc.kill();
  await sleep(400);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });

'use strict';
/**
 * The bits every isolated-instance suite needs, in one place.
 *
 * The suites build a throwaway copy of the app under the OS temp folder and point it at the real
 * node_modules rather than reinstalling. That link was written with `cmd /c mklink`, which is fine
 * on the machine these were written on and fails on the Ubuntu box the platform actually runs on,
 * so `npm test` was Windows-only without saying so.
 */
const fs = require('fs');
const { execSync } = require('child_process');

const win = process.platform === 'win32';
const w = p => String(p).replace(/\//g, '\\');

/** Point `link` at `target` as a directory link, however this platform spells that. */
function linkModules(link, target) {
  unlinkModules(link);
  if (win) execSync('cmd /c mklink /J "' + w(link) + '" "' + w(target) + '"', { stdio: 'ignore' });
  else fs.symlinkSync(target, link, 'dir');
}

/**
 * Release the link WITHOUT following it. Deleting a junction with a recursive remove would walk
 * into the real node_modules and take the project's dependencies with it, so this is deliberately
 * the narrow operation: rmdir on Windows, unlink elsewhere.
 */
function unlinkModules(link) {
  if (win) { try { execSync('cmd /c rmdir "' + w(link) + '"', { stdio: 'ignore' }); } catch (e) {} }
  else { try { fs.unlinkSync(link); } catch (e) {} }
}

module.exports = { linkModules, unlinkModules, isWindows: win };

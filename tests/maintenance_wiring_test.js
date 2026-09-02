#!/usr/bin/env node
/* The shared maintenance gate ("out back" screen) is wired here. It does nothing on a normal day —
 * which is exactly why it needs a test: a silent mis-wire looks identical to a working one until the
 * morning something is actually down, and by then nobody is reading this file.
 *
 * Two of the three things asserted below are NOT in core-admin's install note, because they are
 * this app's wrinkles rather than the shared recipe:
 *
 *   1. The note's snippet passes `gxcore: GXCORE_URL`. That is the shared doc's placeholder name.
 *      This app calls the constant GXCORE, and the snippet verbatim throws a ReferenceError.
 *   2. gx-client.js loads with `defer`, so GXClient does not exist while the inline script that
 *      calls init() is running — and fromCore() skips the GX Core kv lever whenever GXClient is
 *      missing, silently and by design. MEASURED in the browser: without a forced re-check after
 *      DOMContentLoaded the app made ONE fetch of the Pages flag and ZERO calls to GX Core config,
 *      i.e. the cockpit's instant lever was dead and only the Pages flag worked. With it: two and
 *      one. Both levers are supposed to gate independently, so half a gate is a real defect.
 *
 * The third is the note's own question: it asks whether this app has a local rule at z-index >= 10000
 * that would fight the gate. It does not — the ceiling here is the login overlay at 999.
 */
'use strict';
const fs = require('fs'), path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${got}, wanted ${want}`));
}

console.log('\nthe gate is loaded and initialized');
check('gx-maintenance.js is loaded from gx-theme',
      /<script src="https:\/\/greencrosscanna\.github\.io\/greencross-gx-theme\/gx-maintenance\.js"><\/script>/.test(SRC), true);
check('it is NOT deferred — the gate must not wait on the rest of the page',
      /gx-maintenance\.js"\s+defer|defer[^>]*gx-maintenance\.js/.test(SRC), false);
check('init names this app key', /GXMaintenance\.init\(\{[^}]*app:\s*'sales'/.test(SRC), true);
check('and a display label, so it does not title-case the key',
      /GXMaintenance\.init\(\{[^}]*appName:\s*'Sales \/ Cashflow'/.test(SRC), true);

console.log("\nthe GX Core kv lever is wired to THIS app's constant");
check('init passes gxcore, so the cockpit lever is reachable at all',
      /GXMaintenance\.init\(\{[^}]*gxcore:\s*GXCORE\b/.test(SRC), true);
// Scoped to the init CALL, not the whole file: the comment above it quotes the note's snippet
// verbatim to explain why this app cannot use it, and a file-wide regex matches that prose.
const INIT_CALL = (/GXMaintenance\.init\(\{[^}]*\}\)/.exec(SRC) || [''])[0];
check('it does NOT use the note\'s placeholder name, which is undefined here',
      /GXCORE_URL/.test(INIT_CALL), false);
check('GXCORE is declared before init runs',
      SRC.indexOf("const GXCORE =") < SRC.indexOf('GXMaintenance.init('), true);

console.log('\nthe kv lever no longer depends on a deferred client — belt AND braces');
/* This block used to require a local DOMContentLoaded re-check, and it asserted that gx-client.js
   really was deferred, because that defer is what made the lever fragile: fromCore() skips the kv
   lever the moment GXClient is missing, so the cockpit toggle did nothing while the app looked
   correctly wired. Two separate fixes have since removed that hazard from both ends.

   FIRST, in gx-theme (b1b12d0, 2026-08-28): fromCore() polls up to 6s for a deferred client instead
   of giving up. Core-admin chose the shared fix over documenting an extra line per app precisely
   because the failure is invisible per-app. That made the local re-check redundant — deferred
   scripts run before DOMContentLoaded, so the shared wait has always already succeeded by then —
   and it cost a second config fetch every load. It stays asserted ABSENT below so nobody
   reintroduces it from the old note or copies it into another spoke as load-bearing.

   SECOND, here in v2.559: `defer` came OFF the gx-client.js tag. It was not only starving the
   maintenance gate — it was starving this app's own inline boot code, which is the real cost, since
   this is a monolith whose startup js runs during parsing. paintSalesUserTray() called
   GXClient(GXCORE) eagerly, threw ReferenceError, and took loadAllStores() down with it; the
   dashboard hung on "Connecting…" until someone pressed Load live data. Three bug reports.

   So the assertion INVERTS AGAIN, and this time it is pinning the fix rather than the hazard: the
   tag must NOT be deferred. tests/boot_sequence_test.js owns the full story and the boot-order
   guards; this one line is here so a reader of THIS file is not left believing the old premise. */
const clientTag = /<script[^>]*gx-client\.js[^>]*>/.exec(SRC);
check('gx-client.js is NOT deferred — GXClient exists before init() runs (see boot_sequence_test)',
      !!clientTag && /\bdefer\b/.test(clientTag[0]), false);
check('...and the tag really does come before GXMaintenance.init()',
      SRC.indexOf('gx-client.js"></script>') < SRC.indexOf('GXMaintenance.init('), true);
check('no local DOMContentLoaded re-check — gx-theme waits for the deferred client now',
      /DOMContentLoaded[\s\S]{0,80}GXMaintenance\.check\(/.test(SRC), false);
check('and no throttled re-check either, which would have been swallowed by the 60s idle window',
      /GXMaintenance\.check\(false\)/.test(SRC), false);

console.log('\nnothing local outranks the gate');
const zs = (SRC.match(/z-index:\s*(\d+)/g) || [])
  .map(m => Number(m.replace(/\D/g, '')))
  .filter(n => !Number.isNaN(n));
const maxZ = Math.max(...zs);
console.log(`  highest local z-index: ${maxZ} (the gate sits at 10000)`);
check('no local rule reaches the gate\'s layer', maxZ < 10000, true);
check('the login overlay is below it, so nobody signs in to be told the app is down',
      /#gc-login-overlay\.gx-login\{[^}]*z-index:\s*999\b/.test(SRC), true);

console.log('\nthe bug reporter is live, so "Poke the tech team" is not the mailto fallback');
check('GXBugReport.init is called from this file', /GXBugReport\.init\(/.test(SRC), true);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

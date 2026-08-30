#!/usr/bin/env node
/* loadAllStores() is the only path that paints the dashboard, and it had `try { … } finally { … }`
 * with NO catch. That combination turns any throw inside into a silent hang: the exception escapes,
 * the final render() never runs, `finally` tidies the button back up, and the app sits on
 * "Connecting…" with nothing logged and nothing shown. The load is dead but looks merely slow —
 * so there is nothing to read and nothing to retry against.
 *
 * Two specific ways in, both asserted here:
 *
 *   1. The PROGRESSIVE render() inside the per-store map sits OUTSIDE that store's fetch
 *      try/catch. A render fault there rejects the store's promise, which rejects the
 *      Promise.all, which escapes the function. A fault in painting must never be able to kill a
 *      data load — the data arrived; only the drawing failed.
 *   2. The function as a whole must surface a failure rather than swallow it into a spinner.
 *
 * This reads the shipped source rather than a copy, so deleting a guard fails the suite.
 */
'use strict';
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const m = /async function loadAllStores\(\)/.exec(HTML);
ok('loadAllStores is present in the shipped source', !!m);

// Slice out the function body by brace matching.
let i = HTML.indexOf('{', m.index), depth = 0, j = i;
for (; j < HTML.length; j++) {
  if (HTML[j] === '{') depth++;
  else if (HTML[j] === '}') { depth--; if (!depth) break; }
}
const body = HTML.slice(i, j + 1);

console.log('\n1. a render fault must not kill the load');
{
  ok('the progressive render() is wrapped in its own try/catch',
     /try\s*\{\s*render\(\);\s*\}\s*catch/.test(body));
  ok('...and it logs rather than failing silently',
     /catch\s*\(\s*e\s*\)\s*\{[^}]*console\.error\([^)]*render/i.test(body));
  // The bare form is what regressed. It must not come back.
  const bareProgressive = /buildStatusGrid\(stateMap\);\s*\n\s*render\(\);/.test(body);
  ok('the UNGUARDED progressive render() is gone', !bareProgressive);
}

console.log('\n2. the load must never fail silently');
{
  ok('loadAllStores has a catch, not just a finally', /\}\s*catch\s*\(/.test(body));
  ok('...it logs the failure', /console\.error\(\s*'\[loadAllStores\] failed:'/.test(body));
  ok('...it tells the user something went wrong', /showErr\(\s*'setup-err'\s*,\s*'Load failed/.test(body));
  ok('...it still tries to paint what arrived, so a partial load beats a blank screen',
     /catch[\s\S]{0,600}?try\s*\{\s*render\(\)/.test(body));
  ok('...and the in-flight flag is still cleared, so a retry is possible',
     /finally\s*\{[\s\S]*?_loadAllStoresInFlight\s*=\s*false/.test(body));
}

console.log('\n3. the flag is cleared on every exit, or the retry button dies too');
{
  const finallyIdx = body.lastIndexOf('finally');
  const catchIdx   = body.indexOf('} catch (');
  ok('catch comes before finally, so both run on a throw', catchIdx > 0 && finallyIdx > catchIdx);
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

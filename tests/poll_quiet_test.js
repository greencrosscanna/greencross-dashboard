#!/usr/bin/env node
/* The 60-second poll has to update the numbers WITHOUT rebuilding the page.
 *
 * Sky, 2026-09-06: "can we make the 60s refresh feel less jumpy on mobile too?" It was jumpy for a
 * reason with a name. `refreshLiveData` goes to real trouble NOT to blank liveData — that is the
 * v2.560 fix, and its comment is the longest in the file — and then called
 * `_invalidateDerivedCaches()`, which set `_incomeMounted = false`. That forces renderIncome down
 * its full-mount path: #main-content replaced wholesale, both chart canvases destroyed and redrawn,
 * and animateStorePacingBars(true) re-running, which collapses all six bars to 0% and grows them
 * back 120ms apart. Correct numbers, quiet data path, and the reader still watched the page rebuild
 * itself every minute. The v2.560 fix was defeated from the side, exactly as the wipe-at-the-wrong-
 * call-site bug it replaced was.
 *
 * MEASURED in a real browser, identical simulated polls on both builds: v2.572 did 1 full mount per
 * poll and the store-breakdown container, the chart canvas and main-content's first child were all
 * DIFFERENT nodes afterwards. v2.573 does 0, and all three survive.
 *
 * Two smaller things moved with it, same complaint:
 *
 *  - The row order re-sorted mid-poll. "Pending" means no data AT ALL, and a re-poll has none —
 *    liveData is kept — so every row looked landed while only some carried this minute's figure,
 *    and the list re-sorted on each of the six progressive renders against a mix of new and
 *    one-minute-old numbers. `_bdHoldOrder` holds the order for the whole load and releases it
 *    immediately before the final render, so the list settles once, on complete data.
 *
 *  - The end-of-load scrollTo was unconditional. A load takes seconds; scroll down during one and
 *    you were yanked back to where you started. It now fires only if the page moved on its own and
 *    the reader did not move it.
 *
 * Reads and EXECUTES the shipped index.html, not a copy.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function grab(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let d = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') d++;
    else if (HTML[j] === '}' && --d === 0) return HTML.slice(start, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

console.log('\n1. the remount belongs to BLANKING, not to a cache reset');
{
  const inv = grab('_invalidateDerivedCaches');
  ok('_invalidateDerivedCaches no longer forces a remount', !/_incomeMounted/.test(inv));
  // It still has to do its actual job, or a poll renders yesterday's derived numbers.
  ok('...it still clears the per-store date maps', /liveDateMaps/.test(inv));
  ok('...and the day-of-week weights', /_dowWeightsCache\s*=\s*null/.test(inv));

  const clr = grab('clearLiveData');
  ok('clearLiveData is where the remount moved to', /_incomeMounted\s*=\s*false/.test(clr));
  ok('...alongside the blanking it belongs to',
     /liveData = \{\}/.test(clr) && /_liveDataKey = null/.test(clr));
}

console.log('\n2. EXECUTED: a poll leaves the mount standing, a real clear tears it down');
{
  const src = grab('_invalidateDerivedCaches') + '\n' + grab('clearLiveData');
  const ctx = { liveDateMaps: { Bend: {} }, _dowWeightsCache: {}, _dowWeightsCacheKey: 'x',
                _incomeMounted: true, liveData: { Bend: {} }, _liveDataKey: '2026:9' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  ctx._invalidateDerivedCaches();
  ok('after a poll\'s cache reset the view is STILL mounted', ctx._incomeMounted === true);
  ok('...and liveData is untouched, so the numbers stay on screen',
     Object.keys(ctx.liveData).length === 1);
  ok('...while the derived caches really were cleared',
     Object.keys(ctx.liveDateMaps).length === 0 && ctx._dowWeightsCache === null);

  ctx.clearLiveData();
  ok('a real clear DOES force the remount', ctx._incomeMounted === false);
  ok('...and blanks liveData with its period key',
     Object.keys(ctx.liveData).length === 0 && ctx._liveDataKey === null);
}

console.log('\n3. the poll path still refuses to blank, and the clear paths still do');
{
  // Comments stripped first: refreshLiveData's own comment NAMES clearLiveData (to say which paths
  // do blank), so a raw text search finds it and passes for the wrong reason.
  const decomment = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const rl = decomment(grab('refreshLiveData'));
  ok('refreshLiveData does not call clearLiveData', !/clearLiveData\(\)/.test(rl));
  ok('...it still busts the localStorage copy, which is what forces the re-fetch',
     /removeItem\(salesCacheKey/.test(rl));
  ['clearDutchieCache', 'clearAllCache'].forEach(fn =>
    ok(fn + ' still goes through clearLiveData', /clearLiveData\(\)/.test(decomment(grab(fn)))));
}

console.log('\n4. rows hold their order for the whole load, not just while one is missing');
{
  ok('_bdHoldOrder exists', /let _bdHoldOrder = false;/.test(HTML));

  const load = grab('loadAllStores');
  ok('...set at the start of a load that has rows on screen',
     /_bdHoldOrder = Object\.keys\(liveData\)\.length > 0;/.test(load));
  ok('...released immediately before the final render', /_bdHoldOrder = false;[\s\S]{0,120}\n  render\(\);/.test(load));
  ok('...and released in finally too, so a failed load cannot freeze the list',
     /finally \{[\s\S]{0,600}_bdHoldOrder = false;/.test(load));

  // Executed: same six rows, all landed, different values — held vs free.
  const src = grab('_bdApplyOrder');
  const rows = () => [
    { s: 'Bend', snet: 1000, pending: false }, { s: 'Center', snet: 5000, pending: false },
    { s: 'River', snet: 3000, pending: false },
  ];
  const held = { _bdHoldOrder: true, _bdOrder: ['River', 'Bend', 'Center'] };
  vm.createContext(held); vm.runInContext(src, held);
  ok('while held, the remembered order wins over the values',
     held._bdApplyOrder(rows()).map(r => r.s).join(',') === 'River,Bend,Center');

  const free = { _bdHoldOrder: false, _bdOrder: ['River', 'Bend', 'Center'] };
  vm.createContext(free); vm.runInContext(src, free);
  ok('once released, the list settles by value',
     free._bdApplyOrder(rows()).map(r => r.s).join(',') === 'Center,River,Bend');
  ok('...and that becomes the remembered order', free._bdOrder.join(',') === 'Center,River,Bend');

  // A cold start has no order to preserve and must still sort as stores land.
  const cold = { _bdHoldOrder: false, _bdOrder: null };
  vm.createContext(cold); vm.runInContext(src, cold);
  const mixed = [{ s: 'Bend', snet: 1000, pending: false }, { s: 'Center', snet: 0, pending: true },
                 { s: 'River', snet: 3000, pending: false }];
  ok('a cold start puts landed stores first, by value, pending ones last',
     cold._bdApplyOrder(mixed).map(r => r.s).join(',') === 'River,Bend,Center');
}

console.log('\n5. the scroll restore no longer fights the reader');
{
  const load = grab('loadAllStores');
  ok('the restore is conditional now',
     /if \(!_userScrolled && window\.scrollY !== _scrollY\) window\.scrollTo\(0, _scrollY\);/.test(load));
  ok('...and there is no unconditional scrollTo left',
     !/^\s*window\.scrollTo\(0, _scrollY\);/m.test(load));
  // 'scroll' fires for programmatic movement too, so it cannot be the signal.
  ok('...keyed on input events, not on scroll itself',
     /\['touchmove', 'wheel', 'keydown'\]\.forEach\(ev =>\n\s*window\.addEventListener/.test(load) &&
     !/addEventListener\('scroll'/.test(load));
  ok('...and the listeners are removed in finally, so a poll cannot leak them',
     /finally \{[\s\S]{0,600}removeEventListener\(ev, _markScrolled\)/.test(load));
}

console.log('\n6. the full-mount path is still the ONLY thing that re-animates the bars');
{
  const ri = grab('renderIncome');
  const i = ri.indexOf('if (needsFullMount)');
  const j = ri.indexOf('} else {', i);
  const mount = ri.slice(i, j);
  ok('animateStorePacingBars(true) lives in the mount branch', /animateStorePacingBars\(true\)/.test(mount));
  ok('...and not in the patch branch', !/animateStorePacingBars\(true\)/.test(ri.slice(j)));
  // Which is the whole point: no mount on a poll means no re-animation on a poll.
  ok('...so a patched render redraws no chart either', !/drawWeekChart\(/.test(ri.slice(j)));
}

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

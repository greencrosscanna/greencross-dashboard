#!/usr/bin/env node
/* getPacingFracs_ must cost ONE GX Core call, not one per store.
 *
 * This looped over six stores and made a separate /exec round trip for each. GX Core's request
 * telemetry measured the bill on 2026-09-03: expected_frac was 46% of ALL traffic reaching GX Core —
 * the single largest caller of anything — and this loop plus Leaderboard's was most of it.
 *
 * The round trips are what matter, not the work. GX Core's /exec has intermittent bad spells, and
 * every trip is an independent roll against them; six rolls to paint one pacing row is six chances
 * to lose. Leaderboard was the app stuck on a 75-day-old cache that morning for exactly this reason,
 * while spiff — which makes one call — loaded fine.
 *
 * What must stay true:
 *   · ONE round trip prices every store;
 *   · the response is keyed by the SALES label, unchanged, because that is what the app renders;
 *   · a store with no curve is SKIPPED, not zeroed — a zero would tell the dashboard the day expects
 *     no sales, which reads as "you are massively ahead" on a pacing bar;
 *   · GX Core being unreachable degrades to an empty map, exactly as the per-store loop did.
 *
 * Per this repo's pattern the test extracts the SHIPPED function and runs it — it never carries a
 * copy of the logic.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(src, name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = src.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

/* `route` stands in for GX Core. Every call is recorded, so "how many round trips did one pacing row
 * cost" is the thing under test rather than an implementation detail. */
function makeCtx(route) {
  const calls = [];
  const ctx = {
    console,
    _out: null,
    calls,
    jsonOut_: (o) => { ctx._out = o; return o; },
    gxCoreRoute_: (action, params) => { calls.push({ action, params }); return route(action, params); },
  };
  vm.createContext(ctx);
  vm.runInContext(grab(GS, 'getPacingFracs_'), ctx);
  return ctx;
}

// What GX Core v293+ returns: canonical store_id keys, whatever alias was asked for.
const CORE_FRACS = {
  bend: 0.11, center: 0.15, commercial: 0.13,
  hillsboro: 0.14, 'portland-rd': 0.09, 'river-rd': 0.08,
};

console.log('\ngetPacingFracs_ — one call, not six');

/* THE POINT OF THE CHANGE. */
{
  const ctx = makeCtx(() => ({ ok: true, fracs: CORE_FRACS }));
  ctx.getPacingFracs_();
  ok(`six stores cost ONE GX Core call (made ${ctx.calls.length})`, ctx.calls.length === 1);
  ok('and it is the expected_frac route', ctx.calls[0].action === 'expected_frac');
  ok('asking for every store in one parameter', /,/.test(String(ctx.calls[0].params.stores || '')));
  ok('and no single-store `store` parameter is sent any more', !ctx.calls[0].params.store);
}

/* THE RENDERED SHAPE MUST NOT MOVE — the app keys its pacing row off these labels. */
{
  const ctx = makeCtx(() => ({ ok: true, fracs: CORE_FRACS }));
  const out = ctx.getPacingFracs_();
  ok('response is still { ok, fracs, hour, minute }',
     out.ok === true && out.fracs && typeof out.hour === 'number' && typeof out.minute === 'number');
  const labels = Object.keys(out.fracs).sort();
  ok(`keyed by the SALES labels, not store_ids (${labels.join(', ')})`,
     labels.join(',') === ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'].sort().join(','));
  ok('River maps from river-rd, which is the one label that differs from its id',
     out.fracs.River === 0.08);
  ok('Portland Rd maps from portland-rd', out.fracs['Portland Rd'] === 0.09);
  ok('and the other four carry their own values', out.fracs.Bend === 0.11 && out.fracs.Center === 0.15);
}

/* IT ASKS BY store_id. Before GX Core v293 the batch came back keyed by whatever the caller typed,
   so asking with Dutchie names produced "portland rd" and nothing could join it. */
{
  const ctx = makeCtx(() => ({ ok: true, fracs: CORE_FRACS }));
  ctx.getPacingFracs_();
  const asked = String(ctx.calls[0].params.stores || '').split(',');
  ok(`it asks with canonical store_ids (${asked.join(',')})`,
     asked.indexOf('river-rd') >= 0 && asked.indexOf('portland-rd') >= 0);
  ok('and not with Dutchie display names', asked.indexOf('River Rd') < 0);
}

/* A STORE WITH NO CURVE IS SKIPPED, NOT ZEROED. A zero says the day expects no sales, which on a
   pacing bar reads as wildly ahead — the opposite of the truth. */
{
  const partial = Object.assign({}, CORE_FRACS);
  delete partial.commercial;
  const ctx = makeCtx(() => ({ ok: true, fracs: partial }));
  const out = ctx.getPacingFracs_();
  ok('a store missing from the batch is absent, not 0', out.fracs.Commercial === undefined);
  ok('and the other five are unaffected', Object.keys(out.fracs).length === 5);
}
{
  const nulled = Object.assign({}, CORE_FRACS, { commercial: null });
  const ctx = makeCtx(() => ({ ok: true, fracs: nulled }));
  const out = ctx.getPacingFracs_();
  ok('an explicit null (cold store) is skipped too', out.fracs.Commercial === undefined);
}

/* GX CORE DOWN degrades exactly as the per-store loop did: an empty map, not a throw. */
{
  const ctx = makeCtx(() => { throw new Error('GX Core unreachable'); });
  let threw = null, out = null;
  try { out = ctx.getPacingFracs_(); } catch (e) { threw = e; }
  ok('an unreachable GX Core does not throw out of the route', !threw);
  ok('it returns ok with an empty fracs map', out && out.ok === true && Object.keys(out.fracs).length === 0);
  ok('and it only tried once', ctx.calls.length === 1);
}

/* A malformed response must not become NaN on the dashboard. */
{
  const ctx = makeCtx(() => ({ ok: true }));                 // no fracs at all
  const out = ctx.getPacingFracs_();
  ok('a response with no fracs yields an empty map rather than undefined values',
     out.ok === true && Object.keys(out.fracs).length === 0);
}
{
  const ctx = makeCtx(() => ({ ok: true, fracs: { bend: 'not a number', center: 0.15 } }));
  const out = ctx.getPacingFracs_();
  ok('a non-numeric frac is dropped, not rendered', out.fracs.Bend === undefined);
  ok('and a good one beside it still lands', out.fracs.Center === 0.15);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

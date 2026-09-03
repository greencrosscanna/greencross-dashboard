#!/usr/bin/env node
/* Nothing that blocks the render may wait forever — and two call sites could latch the app.
 *
 * WHY THIS FILE EXISTS. loadAllStores awaits auxDataPromise before it does anything else, and
 * four calls sit inside it. All four catch their own errors, so Promise.all can never REJECT —
 * which is what makes a hang dangerous rather than merely slow. A caught error is handled; a
 * request that never settles leaves the promise pending forever and there is no catch for that.
 *
 * Everything downstream of that await then never runs: the "Live · N/6" pill, updateCacheStatus,
 * the final authoritative render, refreshCompare, scroll restore — and scheduleAutoRefresh. That
 * last one is the damage. The 60-second timer is never restarted, so the dashboard stops polling
 * for the rest of the session. It does not degrade, it stops, silently, with six stores sitting
 * correct on screen and the pill reading "Loading…" forever.
 *
 * loadPaceFracs is the same shape one level down and worse, because its guard LOOKS safe:
 *
 *     if (_paceFracsInFlight) return;
 *     _paceFracsInFlight = true;
 *     try { await fetch(...) } catch {...} finally { _paceFracsInFlight = false; }
 *
 * `finally` runs on rejection. It does NOT run on a promise that never settles. One hung pace
 * call latches the flag for the life of the tab and no pace fetch ever runs again — which is how
 * paceFracs goes stale, which is what produced "the daily total says we're behind pace yet each
 * store says we're exceeding pace" on 2026-09-03. That bug's symptom was fixed; this is its cause.
 *
 * A ceiling converts every one of those into a caught error, which these functions already handle.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const src  = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')); }
}
/* Slice from the declaration to the START OF THE NEXT top-level function, rather than a fixed
   character count. A fixed window silently truncates: these call sites carry long "why" comments,
   and adding one pushed the call being asserted past the end — four assertions then failed with
   "could not parse the call", which reads as a missing bound rather than a short window. A test
   whose failure mode is indistinguishable from the bug is worse than no test. */
function fn(name) {
  const i = src.indexOf('async function ' + name);
  if (i < 0) return '';
  const next = src.slice(i + 1).search(/\n(?:async )?function [A-Za-z_$]/);
  return next < 0 ? src.slice(i) : src.slice(i, i + 1 + next);
}

// ── TIER 1: the four calls loadAllStores awaits ──────────────────────────────────────────
for (const [name, action] of [
  ['fetchStoresMeta',      'stores'],
  ['loadGoals',            'goals'],
  ['loadPeriodGoalRange',  'period_goals_range'],
]) {
  const body = fn(name);
  ok(body.length > 0, name + '() found');
  ok(/gasFetchJson\(/.test(body), name + '() is bounded (goes through gasFetchJson)',
     'a bare fetch here can stop the poll for the rest of the session');
  ok(!new RegExp('await fetch\\(`\\$\\{proxyUrl\\}\\?action=' + action).test(body),
     name + '() no longer holds auxDataPromise on a bare fetch');
}

/* The fourth is fetchPublishedGoals, which was already on GXClient — bounded per attempt, but
   with the DEFAULT budget: five attempts at 8s plus a patient 45s final, ~90s worst case. That
   patience is right for GX Core in isolation and wrong here, because this call's budget is not
   private — it is time the whole dashboard spends not rendering and not restarting its poll. */
const pub = fn('fetchPublishedGoals');
ok(/GXClient\(GXCORE,\s*\{/.test(pub),
   'fetchPublishedGoals passes an explicit, shortened GXClient budget');
const opts = (pub.match(/GXClient\(GXCORE,\s*\{([^}]*)\}/) || [, ''])[1];
const retries = Number((opts.match(/retries:\s*(\d+)/) || [, NaN])[1]);
const last    = Number((opts.match(/lastTimeoutMs:\s*(\d+)/) || [, NaN])[1]);
const per     = Number((opts.match(/timeoutMs:\s*(\d+)/)     || [, NaN])[1]);
ok(retries <= 1, 'published_goals takes at most 2 attempts', 'retries: ' + retries);
ok(last <= 25000, 'published_goals does NOT inherit the patient 45s final attempt', 'got ' + last);
/* But it must also sit ABOVE Core's measured ordinary wait of ~12.2s. Too tight is not the safe
   direction here: it makes a real route fail on healthy calls and fall back every time, which
   looks like it works and never runs. */
ok(per >= 12000, 'the per-attempt ceiling is above GX Core\'s measured ordinary wait', 'got ' + per);
ok(per * (retries + 1) + last < 60000,
   'the whole published_goals budget stays inside one 60s poll interval');

// ── TIER 2: the latch ────────────────────────────────────────────────────────────────────
const pace = fn('loadPaceFracs');
ok(/gasFetchJson\(/.test(pace), 'loadPaceFracs is bounded');
ok(!/await fetch\(`\$\{getProxyUrl\(\)\}\?action=pace/.test(pace),
   'loadPaceFracs no longer awaits a bare fetch',
   '_paceFracsInFlight is cleared in finally, which does not run for a promise that never settles');
const paceArgs = /gasFetchJson\(\s*`[^`]*action=pace[^`]*`,\s*(\d+),\s*(\d+)\)/.exec(pace);
ok(paceArgs && Number(paceArgs[1]) * Number(paceArgs[2]) < 60000,
   'the pace budget stays inside one poll interval',
   paceArgs ? paceArgs[1] + ' x ' + paceArgs[2] + 'ms' : 'could not parse the call');

/* AND pace specifically gets NO ladder. Measured at 53.6s / 30.5s / 5.1s / 3.9s / 8.9s in a live
   session; the cause is GX Core's expected_frac, which is ~46% of all traffic reaching Core.
   A second attempt here duplicates a call the 60s poll is already going to make, and retrying an
   endpoint that is slow because it is overloaded makes the shared problem worse for all six apps.
   The fallback is real — getPacingPct drops to a linear clock ramp — so giving up early costs a
   slightly less precise bar for one cycle. If someone "improves" this into a ladder, that is a
   regression with suite-wide blast radius, so it fails here. */
ok(paceArgs && Number(paceArgs[1]) === 1,
   'pace takes exactly ONE attempt — the 60s poll is the retry',
   paceArgs ? 'attempts: ' + paceArgs[1] : 'could not parse the call');
/* BOTH ends of this range are load-bearing, and the lower one was learned by shipping it wrong.
   v2.566 set this to 8s, reasoning from the fast samples (2.2s, 3.9s) that 12-17s was the tail.
   GX Core's own instrumentation says a caller waits an average of 12.2s on a request that does
   NOT bounce — twelve seconds is the ordinary clean case. An 8s ceiling aborts a large share of
   healthy calls, paceFracs never populates, and the day view strands on the clock-ramp fallback.
   A ceiling set from the fast samples of a bimodal distribution is not conservative, it is an
   outage. The upper bound keeps it inside one 60s poll with room to spare. */
ok(paceArgs && Number(paceArgs[2]) >= 15000 && Number(paceArgs[2]) <= 30000,
   'the pace ceiling sits above the measured ordinary case (15s-30s), not below it',
   paceArgs ? 'ceiling: ' + paceArgs[2] + 'ms' : 'could not parse the call');

/* TIER 3 was already done and this asserts it stays done: cogs_dutchie carries its own
   AbortController. It is the most expensive route in the app and the reason Gross Profit and
   Margin sit on "—" while every other KPI has a value. */
const gm = fn('loadInvGmData');
ok(/new AbortController\(\)/.test(gm) && /setTimeout\(\(\) => ac\.abort\(\)/.test(gm),
   'loadInvGmData keeps its own abort ceiling');
ok(/finally\s*\{\s*_invGmLoading = false/.test(gm),
   'loadInvGmData clears its in-flight flag in finally — safe because the abort guarantees it settles');

/* ── TWO THAT MUST STAY BARE ────────────────────────────────────────────────────────────
   Converting these would be a regression that looks like consistency. */
ok(!/gasFetchJson\([^)]*action=libversion/.test(src),
   'the prewarm knock stays an unretried, unawaited fetch',
   'it warms the container while the login form is typed into; retrying a warm-up is pointless '
   + 'load, and anything that can throw or block on that path costs a sign-in');
ok(!/gasFetchJson\([^)]*action=ping/.test(src),
   'the heartbeat stays bare — its own interval is already its retry');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

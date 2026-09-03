#!/usr/bin/env node
/* Two things reported by Sky on 2026-09-03, both about the app throwing away something it already
 * had rather than about the thing it was fetching.
 *
 * 1. "the page should do the initial load, then quietly update in the background. right now it is
 *    taking previously loaded data and changing to the shimmer load state while it updates."
 *    loadAllStores opened with an unconditional `liveData = {}`, so every 60-second poll blanked
 *    six stores that were already on screen and correct. Shimmer means "we have nothing yet"; a
 *    poll always has something. The wipe still has to happen on a PERIOD change — without it the
 *    old month's figure survives under the new month's header, the July-736k trap — so the fix is a
 *    period key, not deleting the wipe.
 *
 * 2. "repeat error, tried to submit this bug but it didn't go thru", and "it takes 5-10s to log in".
 *    Both were bare fetches to this app's Apps Script /exec with no retry. That endpoint 302s to
 *    script.googleusercontent.com and the second hop intermittently bounces, returning an HTML page;
 *    r.json() threw and the user saw a failure for a request the server never refused. Measured on
 *    the live deployment the same day: three routes returned Google "Page Not Found" HTML inside one
 *    minute, while ?action=login and ?action=ping both answered in ~1.8s median when they did not
 *    bounce — so the login is not slow, it is occasionally retried by hand.
 *
 * Runs against the shipped index.html. The retry helper is EXECUTED against a stubbed fetch, because
 * "retries a bounce but never re-sends a refusal" is a behavior, not a shape.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// ── 1. The poll must not blank what is already on screen ─────────────────────
{
  const load = grab('loadAllStores');

  ok(/_liveDataKey\s*!==\s*loadKey/.test(load),
     'loadAllStores wipes liveData only when the period key changed');
  ok(/const loadKey = activeYear \+ ':' \+ activeMonth/.test(load),
     'the period key is year:month — the granularity liveData is actually fetched at');

  // An unconditional wipe anywhere in the function is the regression. The only `liveData = {}` left
  // must be the one inside the guard, on the same line as it.
  const wipes = load.split('\n').filter(l => /(^|[^.\w])liveData\s*=\s*\{\s*\}/.test(l));
  eq(wipes.length, 1, 'exactly one liveData wipe survives in loadAllStores');
  ok(/_liveDataKey/.test(wipes[0] || ''),
     'that wipe is guarded by the period key, not unconditional');

  // The guard is only safe because a period change routes through here. If periodApply ever stops
  // reloading on a year/month change, the stale period would survive on screen.
  const apply = grab('periodApply');
  ok(/o\.year !== activeYear \|\| o\.month !== activeMonth/.test(apply) && /loadAllStores\(\)/.test(apply),
     'a year/month change still reaches loadAllStores, so the key can do its job');

  // The explicit clears are a different intent — "forget what you have" — and must still blank it.
  for (const fn of ['clearAllCache', 'clearDutchieCache', 'hardReset']) {
    ok(/clearLiveData\(\)/.test(grab(fn)), fn + ' still clears liveData outright');
  }
  ok(/liveData = \{\};\s*_liveDataKey = null;/.test(grab('clearLiveData')),
     'clearLiveData resets the key too — a wipe the loader cannot see is worse than no wipe');
}

// ── 2. The retry: bounces are retried, refusals are not ──────────────────────
function runFetchCase(responses) {
  const calls = [];
  const ctx = {
    console, Math, JSON, Error, Promise, setTimeout: (f) => f(),   // no real waiting in a test
    fetch: (url) => {
      calls.push(url);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r.throw) return Promise.reject(new Error(r.throw));
      return Promise.resolve({ ok: r.ok !== false, status: r.status || 200,
                               text: () => Promise.resolve(r.body) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(grab('gasFetchJson'), ctx);
  return { calls, run: ctx.gasFetchJson('https://example.test/exec?action=x', 3) };
}

const HTML_BOUNCE = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body></body></html>';

(async () => {
  // A clean answer is returned on the first call — no retry, no extra request.
  {
    const c = runFetchCase([{ body: '{"ok":true,"token":"t"}' }]);
    const out = await c.run;
    eq(out.ok, true, 'a clean JSON answer comes straight back');
    eq(c.calls.length, 1, 'a clean answer costs exactly one request');
  }

  // A bounce returns HTML. That is the ~6% flake and must be retried, not surfaced.
  {
    const c = runFetchCase([{ body: HTML_BOUNCE }, { body: '{"ok":true,"token":"t"}' }]);
    const out = await c.run;
    eq(out.ok, true, 'an HTML bounce is retried and the retry answer is used');
    eq(c.calls.length, 2, 'the bounce cost one retry, not more');
  }

  // A body truncated mid-string is the same flake wearing a JSON error.
  {
    const c = runFetchCase([{ body: '{"ok":true,"perio' }, { body: '{"ok":true}' }]);
    const out = await c.run;
    eq(out.ok, true, 'a truncated body is retried rather than reported as a server fault');
  }

  // THE ONE THAT MATTERS FOR A WRITE. A parsed {ok:false} is the server's ANSWER. Retrying it would
  // be wrong for a login (it is a wrong password) and dangerous for a bug report (gxIngestBug has no
  // dedupe, so a re-send files the report twice).
  {
    const c = runFetchCase([{ body: '{"ok":false,"error":"Invalid username or password"}' }]);
    const out = await c.run;
    eq(out.ok, false, 'a refusal is returned, not swallowed');
    eq(out.error, 'Invalid username or password', 'the refusal keeps its own message');
    eq(c.calls.length, 1, 'a REFUSAL IS NEVER RETRIED — re-sending a write is how one becomes two');
  }

  // Exhausting the retries still fails, rather than returning something invented.
  {
    const c = runFetchCase([{ body: HTML_BOUNCE }]);
    let threw = null;
    try { await c.run; } catch (e) { threw = e; }
    ok(threw !== null, 'a request that never parses ends up throwing, not resolving');
    eq(c.calls.length, 3, 'it gave up after the requested number of attempts');
  }

  // A network reject and an HTTP error are transport failures too.
  {
    const c = runFetchCase([{ throw: 'network down' }, { body: '{"ok":true}' }]);
    eq((await c.run).ok, true, 'a network reject is retried');
  }
  {
    const c = runFetchCase([{ ok: false, status: 500, body: 'boom' }, { body: '{"ok":true}' }]);
    eq((await c.run).ok, true, 'an HTTP error is retried');
  }

  // ── 3. The two reported paths actually use it ──────────────────────────────
  ok(/gasFetchJson\(url, 3\)/.test(grab('doSalesLogin')),
     'sign-in goes through the retry — a bounced login must not read as a wrong password');
  ok(!/await fetch\(url\)/.test(grab('doSalesLogin')),
     'the bare login fetch is gone, not merely wrapped');

  const bugSubmit = /submit: function \(payload\) \{[\s\S]*?\n    \},/.exec(SRC);
  ok(bugSubmit && /gasFetchJson\(/.test(bugSubmit[0]),
     'the bug reporter submits through the retry — it is the one form you cannot file a bug about');
  ok(bugSubmit && !/fetch\(getProxyUrl\(\) \+ '\?' \+ params\)\.then/.test(bugSubmit[0]),
     'the bare bug-report fetch is gone');

  // ── 4. Prewarm is free or it is not worth having ───────────────────────────
  {
    const pw = grab('prewarmSalesProxy');
    ok(/action=libversion/.test(pw), 'prewarm knocks on a PUBLIC route — the login screen holds no token');
    ok(/\.catch\(/.test(pw) && /try \{/.test(pw),
       'prewarm can neither throw nor reject into the login path');
    ok(!/await/.test(pw), 'nothing waits on the prewarm');
    ok(/prewarmSalesProxy\(\);/.test(grab('showLoginScreen')),
       'the prewarm actually fires when the sign-in form appears');
    // A read the app performs must be declared, or it works live and breaks only on localhost.
    ok(/'libversion'/.test(SRC), 'libversion is declared in GX_DEV_READS');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

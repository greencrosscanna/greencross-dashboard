#!/usr/bin/env node
/* The Reconcile headline: what the company banked for the week currently up for reconciliation.
 *
 * It is one number on top of a screen people act on, and every way it can be wrong renders as a
 * perfectly believable dollar figure. So the rules it has to keep are asserted here against the
 * SHIPPED reconWeekKpi_, not described in a comment and hoped for:
 *
 *   1. A reconciled week still counts. `done` is Sky's progress through the list, not a fact about
 *      the money; summing only open cards makes the headline fall toward $0 over a session in which
 *      nothing happened except him ticking stores off.
 *   2. Deposited, expected and the variance come from ONE row set, so `deposited - expected` equals
 *      the variance printed beside them. Two row sets is a headline that fails the subtraction any
 *      reader would do on it.
 *   3. Incomplete weeks are excluded from all three. A week missing a day of sales has a partial
 *      expected figure, which manufactures a variance out of a gap in the data.
 *   4. Coverage is reported. A company total quietly covering five of six stores is the River
 *      failure shape — a per-store problem degrading into a smaller number instead of an error.
 *   5. No complete week returns NULL, never 0. A confident zero is a measurement of a question
 *      nobody has answered yet.
 *   6. It is the LATEST complete week per store, and stores disagree about which dates that is —
 *      Bend runs Tue->Mon and River Wed->Tue, so "this week" is genuinely two different windows.
 */
'use strict';

if (process.env.TZ !== 'America/Los_Angeles') {
  const r = require('child_process').spawnSync(process.execPath, [__filename],
    { stdio: 'inherit', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not locate ' + name + ' in index.html');
  let i = HTML.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(grab('reconWeekKpi_'), ctx);
const kpiOf = (rows, n) => ctx.reconWeekKpi_(rows, n);

// A row shaped exactly as reconBuildRow returns one, reduced to the fields the KPI reads.
// `deps` defaults to one deposit because a week with none is the "awaiting deposit" case, which is
// tested explicitly below rather than arrived at by accident in every other fixture.
const row = (store, start, end, expected, deposited, opts = {}) => ({
  store, win: { start, end }, expected, deposited,
  deps: opts.deps !== undefined ? opts.deps : [{ id: store + start, amount: deposited }],
  missing: opts.missing || [], done: !!opts.done,
});

// The real calendar: 2026-09-01 is a Tuesday, so Bend's week ends on 08-31 and River's on 09-01.
const BEND_LAST  = ['Bend',  '2026-08-25', '2026-08-31'];
const RIVER_LAST = ['River', '2026-08-26', '2026-09-01'];
const BEND_PRIOR = ['Bend',  '2026-08-18', '2026-08-24'];

console.log('\nthe basics');
let k = kpiOf([row(...BEND_LAST, 7000, 7000), row(...RIVER_LAST, 8400, 8400)], 2);
ok('sums the deposits across stores',      k.deposited === 15400);
ok('sums the expectations alongside them', k.expected === 15400);
ok('ties when they agree',                 k.diff === 0);
ok('reports full coverage',                k.covered === 2 && k.stores === 2);
ok('spans the union of two different store-weeks', k.from === '2026-08-25' && k.to === '2026-09-01');

console.log('\n1. a reconciled week still counts');
k = kpiOf([row(...BEND_LAST, 7000, 7000, { done: true }), row(...RIVER_LAST, 8400, 8400)], 2);
ok('the total does not shrink when a store is ticked off', k.deposited === 15400);
ok('and it says how many are already done',                k.reconciled === 1);
const allDone = kpiOf([row(...BEND_LAST, 7000, 7000, { done: true }),
                       row(...RIVER_LAST, 8400, 8400, { done: true })], 2);
ok('a fully reconciled week still reports its money', allDone.deposited === 15400);
ok('...rather than collapsing to zero',                allDone.deposited !== 0);

console.log('\n2. the three figures survive the subtraction a reader will do');
k = kpiOf([row(...BEND_LAST, 7000, 6980.50), row(...RIVER_LAST, 8400, 8400)], 2);
ok('variance equals deposited minus expected, exactly',
   Math.round((k.deposited - k.expected) * 100) / 100 === k.diff);
ok('a shortfall comes out negative', k.diff === -19.5);
k = kpiOf([row(...BEND_LAST, 7000, 7025), row(...RIVER_LAST, 8400, 8400)], 2);
ok('an overage comes out positive',  k.diff === 25);
ok('...and still ties out to the subtraction',
   Math.round((k.deposited - k.expected) * 100) / 100 === k.diff);

console.log('\n3. an incomplete week is excluded from ALL THREE figures');
k = kpiOf([row(...BEND_LAST, 7000, 7000),
           row(...RIVER_LAST, 8400, 3000, { missing: ['2026-08-30'] })], 2);
ok('its deposits are not in the total',     k.deposited === 7000);
ok('its expectation is not in the total',   k.expected === 7000);
ok('so a gap in the data cannot invent a variance', k.diff === 0);
ok('and the row does not count toward coverage',    k.covered === 1);

console.log('\n4. coverage is reported, never assumed');
ok('a store short of a complete week shows as 1 of 2', k.covered === 1 && k.stores === 2);
k = kpiOf([row(...BEND_LAST, 7000, 7000), row(...RIVER_LAST, 8400, 8400)], 6);
ok('covering two of six stores says so rather than reading as the company',
   k.covered === 2 && k.stores === 6);

console.log('\n5. nothing to total returns NULL, not zero');
ok('no rows at all',        kpiOf([], 6) === null);
ok('only incomplete rows',  kpiOf([row(...BEND_LAST, 7000, 0, { missing: ['2026-08-30'] })], 6) === null);
ok('...which is different from a real zero',
   kpiOf([row(...BEND_LAST, 0, 0)], 6).deposited === 0);

console.log('\n5b. a week that has CLOSED but not been BANKED is not the week');
// Deposits land a day or two after a week closes, so there is always a stretch where the newest
// complete week has been sold and not banked. Summing it renders $0.00 against a full week of
// expectation — a confident zero dressed as a finding, right at the top of the tab.
const SEPT_UNBANKED = ['Bend', '2026-09-01', '2026-09-07'];
k = kpiOf([row(...BEND_LAST, 7000, 7000),
           row(...SEPT_UNBANKED, 7000, 0, { deps: [] })], 1);
ok('the unbanked newer week is skipped for the banked older one', k.deposited === 7000);
ok('...so no phantom shortfall is reported',      k.diff === 0);
ok('...and the span names the week actually summed',
   k.from === '2026-08-25' && k.to === '2026-08-31');
ok('nothing banked anywhere returns NULL, not $0.00 short',
   kpiOf([row(...SEPT_UNBANKED, 7000, 0, { deps: [] })], 1) === null);
// The real shape of the bug this caught: six stores, all closed, none banked.
const sixUnbanked = ['Bend','Hillsboro','Center','Commercial','Portland Rd','River']
  .map(s => row(s, '2026-09-01', '2026-09-07', 8400, 0, { deps: [] }));
ok('six closed-but-unbanked stores do not read as "Short by $50,400"',
   kpiOf(sixUnbanked, 6) === null);

console.log('\n6. the LATEST complete week per store, per that store\'s own calendar');
k = kpiOf([row(...BEND_PRIOR, 6000, 6000), row(...BEND_LAST, 7000, 7000),
           row(...RIVER_LAST, 8400, 8400)], 2);
ok('an older unreconciled week is not added in', k.deposited === 15400);
ok('...and does not widen the reported span',    k.from === '2026-08-25');
ok('each store contributes exactly one week',    k.covered === 2);
// The older week wins nothing even when it is the one carrying more money.
k = kpiOf([row(...BEND_PRIOR, 99999, 99999), row(...BEND_LAST, 7000, 7000)], 1);
ok('latest means latest by DATE, not by size', k.deposited === 7000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

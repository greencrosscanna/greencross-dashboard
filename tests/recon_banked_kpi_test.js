#!/usr/bin/env node
/* The Reconcile headline: what was BANKED IN THE SELECTED PERIOD.
 *
 * It tracks the period picker. Sky, 2026-09-07: "yes track the picker. if i've selected this week
 * (36), i would expect to see —, then if i select the previous week i would expect to see the 191k."
 * So the scope is deposits whose OWN DATE falls in the selected window — a dash on a Monday, and
 * last week's banking when last week is picked.
 *
 * It replaced a version that showed the latest banked week regardless of the picker. That one
 * shipped labeled "Deposited this week" while the period bar above it read WK36 and it was
 * reporting $191,617.26 banked in WK35 — real money, real arithmetic, wrong week.
 *
 * It is one number on top of a screen people act on, and every way it can be wrong renders as a
 * believable dollar figure. So these run against the SHIPPED reconBankedInPeriod_:
 *
 *   1. A deposit belongs to the period ITS OWN DATE falls in — not the period of the week it pays
 *      for. Inverting that is precisely the bug the old label had.
 *   2. The comparison is withheld unless every contributing week is wholly inside the period AND
 *      fully priced. A week can bank in two deposits (Commercial splits 3 days + 4 days), so a
 *      period can catch one and miss the other; comparing part of a week's banking against a whole
 *      week's sales manufactures a shortfall out of a date boundary.
 *   3. Reconciled weeks still count. `done` is progress through the list, not a fact about money.
 *   4. Coverage is reported. A total quietly covering four of six stores is the River failure shape.
 *   5. Nothing banked returns NULL, never 0 — the caller renders a dash.
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
for (const fn of ['reconBankedInPeriod_', 'getISOWeek', 'getUserWeek', 'getDaysOfISOWeek', 'toDateStr']) {
  vm.runInContext(grab(fn), ctx);
}
const kpi = (rows, from, to, n) => ctx.reconBankedInPeriod_(rows, from, to, n);

// A row shaped as reconBuildRow returns one, reduced to the fields the KPI reads. `deps` carries
// DATES, because the date is now what decides the period a deposit belongs to.
const row = (store, start, end, expected, deps, opts = {}) => ({
  store, win: { start, end }, expected,
  deposited: deps.reduce((a, d) => a + d[1], 0),
  deps: deps.map((d, i) => ({ id: store + start + i, date: d[0], amount: d[1] })),
  missing: opts.missing || [], done: !!opts.done,
});

// ── The real calendar and the real money, measured off the live reconprobe on 2026-09-07 ────────
// Every store banked on 08-31 and/or 09-01, for weeks ending 08-31 (Bend/Hillsboro, Tue weeks) and
// 09-01 (the four Salem stores, Wed weeks). Nothing has been banked since.
const REAL = [
  row('Bend',        '2026-08-25', '2026-08-31', 39467.76, [['2026-08-31', 39467.76]]),
  row('Hillsboro',   '2026-08-25', '2026-08-31', 25240.13, [['2026-08-31', 25240.13]]),
  row('Center',      '2026-08-26', '2026-09-01', 13448.01, [['2026-08-31', 6700], ['2026-09-01', 6748.01]]),
  row('Commercial',  '2026-08-26', '2026-09-01', 51515.05, [['2026-08-31', 25757.53], ['2026-09-01', 25757.52]]),
  row('Portland Rd', '2026-08-26', '2026-09-01', 24159.55, [['2026-08-31', 12079.78], ['2026-09-01', 12079.77]]),
  row('River',       '2026-08-26', '2026-09-01', 37786.76, [['2026-08-31', 18893.38], ['2026-09-01', 18893.38]]),
];
const WK35 = ['2026-08-31', '2026-09-06'];   // Mon 08-31 .. Sun 09-06
const WK36 = ['2026-09-07', '2026-09-13'];   // Mon 09-07 .. Sun 09-13 — today is the Monday

console.log('\nthe exact case Sky described');
const wk36 = kpi(REAL, WK36[0], WK36[1], 6);
ok('WK36 on the Monday returns NULL, so the tile shows a dash', wk36 === null);
const wk35 = kpi(REAL, WK35[0], WK35[1], 6);
ok('WK35 returns the 191k',              wk35 && wk35.deposited === 191617.26);
ok('...covering all six stores',         wk35.covered === 6 && wk35.stores === 6);
ok('...deposited 08-31 through 09-01',   wk35.bankedFrom === '2026-08-31' && wk35.bankedTo === '2026-09-01');
ok('...paying for weeks Aug 25 – Sep 1', wk35.paysFrom === '2026-08-25' && wk35.paysTo === '2026-09-01');
ok('...and every week is whole, so the comparison stands', wk35.partial === false);
ok('...expected is the six weeks of sales', wk35.expected === 191617.26);
ok('...which ties exactly',                 wk35.diff === 0);
// The picker really is the only thing that changed between those two answers.
ok('same rows, different week, different answer', wk36 === null && wk35.deposited > 0);

console.log('\n1. a deposit belongs to the period its OWN DATE falls in');
// WK34 is the week the money was EARNED in for the Tue stores, and none of it was banked then.
const wk34 = kpi(REAL, '2026-08-24', '2026-08-30', 6);
ok('WK34 holds none of it, though it is when the selling happened', wk34 === null);
// A month view sums every deposit dated in the month, across weeks.
const sept = kpi(REAL, '2026-09-01', '2026-09-30', 6);
ok('September catches only the 09-01 half', sept.deposited === 63478.68);
const aug = kpi(REAL, '2026-08-01', '2026-08-31', 6);
ok('August catches only the 08-31 half',    aug.deposited === 128138.58);
ok('and the two halves add back to the whole',
   Math.round((sept.deposited + aug.deposited) * 100) / 100 === 191617.26);

console.log('\n2. the comparison is withheld when a week is only PARTLY in the period');
// September holds Center's 09-01 deposit but not its 08-31 one, so its week is split by the boundary.
ok('September reports the money it holds', sept.deposited === 63478.68);
ok('...but refuses to compare it',         sept.partial === true && sept.expected === null);
ok('...and publishes no variance either',  sept.diff === null);
ok('August is split the same way and also refuses', aug.partial === true && aug.diff === null);
ok('while WK35, which holds whole weeks, does compare', wk35.partial === false);
// A gap in the SALES data withholds it too, for the same reason every other figure here does.
const gappy = kpi([row('Bend', '2026-08-25', '2026-08-31', 39467.76,
                       [['2026-08-31', 39467.76]], { missing: ['2026-08-27'] })], WK35[0], WK35[1], 1);
ok('a week missing a day of sales is reported but not compared',
   gappy.deposited === 39467.76 && gappy.partial === true && gappy.expected === null);

console.log('\n3. reconciled weeks still count');
const ticked = REAL.map((r, i) => i < 3 ? Object.assign({}, r, { done: true }) : r);
const k3 = kpi(ticked, WK35[0], WK35[1], 6);
ok('the total does not shrink as stores are ticked off', k3.deposited === 191617.26);
ok('and it says how many are already done',              k3.reconciled === 3);
const allDone = kpi(REAL.map(r => Object.assign({}, r, { done: true })), WK35[0], WK35[1], 6);
ok('a fully reconciled week still reports its money',    allDone.deposited === 191617.26);

console.log('\n4. coverage is reported, never assumed');
const four = kpi(REAL.slice(0, 4), WK35[0], WK35[1], 6);
ok('four stores banking reads as 4 of 6, not as the company', four.covered === 4 && four.stores === 6);
ok('...and the figure is only those four',
   four.deposited === Math.round((39467.76 + 25240.13 + 13448.01 + 51515.05) * 100) / 100);

console.log('\n5. nothing banked returns NULL, not zero');
ok('no rows at all',                kpi([], WK35[0], WK35[1], 6) === null);
ok('rows with no deposits at all',
   kpi([row('Bend', '2026-09-01', '2026-09-07', 8400, [])], WK36[0], WK36[1], 1) === null);
ok('rows whose deposits are all outside the period',
   kpi(REAL, '2026-07-01', '2026-07-31', 6) === null);
// A real zero-dollar deposit is data, not absence — it must not be swallowed.
ok('a genuine $0 deposit still returns a figure',
   kpi([row('Bend', '2026-08-25', '2026-08-31', 0, [['2026-08-31', 0]])],
       WK35[0], WK35[1], 1).deposited === 0);

console.log('\n6. the boundaries themselves');
const oneDay = kpi(REAL, '2026-08-31', '2026-08-31', 6);
ok('the first day of the period is INCLUSIVE', oneDay && oneDay.deposited === 128138.58);
const lastDay = kpi(REAL, '2026-09-01', '2026-09-01', 6);
ok('the last day of the period is INCLUSIVE',  lastDay && lastDay.deposited === 63478.68);
ok('a single deposit date reports the same day both ways',
   lastDay.bankedFrom === lastDay.bankedTo);

console.log('\n7. reconSelectedRange follows the week picker');
// WK35 straddles the month; the range must be the WEEK, not the month it mostly falls in.
vm.runInContext('var activeYear = 2026, activeWeek = 35, activeMonth = 9;', ctx);
// Stubbed, because what it returns is not what is under test here — only that the WEEK wins over it.
vm.runInContext('function reconWantedRange(){ return { start: "2026-09-01", end: "2026-09-30" }; }', ctx);
vm.runInContext(grab('reconSelectedRange'), ctx);
let sel = vm.runInContext('reconSelectedRange()', ctx);
ok('WK35 resolves to 2026-08-31 .. 2026-09-06',
   sel.start === '2026-08-31' && sel.end === '2026-09-06');
vm.runInContext('activeWeek = 36;', ctx);
sel = vm.runInContext('reconSelectedRange()', ctx);
ok('WK36 resolves to 2026-09-07 .. 2026-09-13',
   sel.start === '2026-09-07' && sel.end === '2026-09-13');
vm.runInContext('activeWeek = null;', ctx);
sel = vm.runInContext('reconSelectedRange()', ctx);
ok('no week selected falls back to the period range',
   sel.start === '2026-09-01' && sel.end === '2026-09-30');

console.log('\n8. the shipped markup names the period and never says "this week"');
const CARD_AT = HTML.indexOf('<div class="card recon-summary">');
const CARD = CARD_AT === -1 ? '' : HTML.slice(CARD_AT, HTML.indexOf('recon-summary-row', CARD_AT));
ok('the summary markup was actually found', CARD.length > 200);
ok('the tile is labeled "Banked" plus the SELECTED range',
   /Banked \$\{reconFmtRange\(sel\)\}/.test(CARD));
ok('no relative week-word survives in the tile', !/this week/i.test(CARD));
ok('the empty state says nothing was banked in the period',
   /Nothing banked in this period/.test(CARD));
ok('the comparison is gated on `partial`', /kpi && !kpi\.partial/.test(CARD));
ok('and a withheld comparison explains itself', /Not compared/.test(CARD));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

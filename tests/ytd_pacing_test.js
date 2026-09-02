#!/usr/bin/env node
/* The YTD hero read "+$1,774,488 over pace" directly under "98% of $5,369,852 goal". Both numbers
 * were computed from the same net and the same goal, and they disagreed by $1.8M, because the YTD
 * goal and the YTD pacing percent measure two different periods:
 *
 *   periodGoal  = getGoal(store, MONTH_YTD) → sums Jan..CURRENT MONTH. Already a to-date figure.
 *   pacingPct   = getPacingPct()            → (today − Jan 1) / (Dec 31 − Jan 1). Fraction of the
 *                                             whole CALENDAR YEAR, ~65% in late August.
 *
 * pacedGoal = periodGoal × pacingPct therefore discounts an already-discounted goal, and every
 * store row inherits it. The fix is getGoalPacingPct(): whole elapsed months at 100%, current month
 * pro-rated. This test runs the REAL functions grabbed out of index.html — a modeled copy would go
 * on passing after the shipped code regressed, which is the only way it could lie.
 *
 * The other half is a separation the fix depends on and nothing else enforces: the EXPENSES tab's
 * YTD budget IS all twelve months, so getPacingPct must keep returning the calendar fraction. A
 * later "cleanup" that folds the two functions together fixes income and silently breaks expenses.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + '() in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const MONTHS_SRC     = /const MONTHS = \[[^\]]*\];/.exec(SRC)[0];
const YTD_SRC        = /const MONTH_YTD = 0;/.exec(SRC)[0];
const THRESHOLDS_SRC = /const THRESHOLDS = Object\.freeze\(\{[\s\S]*?\}\);/.exec(SRC)[0];

// Six stores, a flat $100k every month. Flat on purpose: with an even budget the correct YTD pacing
// is arithmetic anyone can check by hand, so a failure names the bug instead of the fixture.
const STORES = ['Commercial', 'Century', 'River', 'Baseline', 'Portland', 'Center'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const goals = Object.fromEntries(STORES.map(s =>
  [s, Object.fromEntries(MONTH_NAMES.map(m => [m, 100000]))]));

const ctx = {
  console, goals,
  activeYear: 2026, activeMonth: 0, activeWeek: null, activeDay: null,
  Date: null,                       // installed per-case
  // null, not 2026: this suite flips activeYear to 2025/2027 to check how much of a CLOSED or
  // future year has elapsed, and a year-gated getGoal would zero the budget out from under those
  // cases and make them assert nothing. The gate itself is covered by past_year_goals_test.js.
  goalsYear: null,
  // Empty, so pgTotal returns null for every window and the accessors fall through to the budget —
  // which is what this suite is about. The frozen-period path has its own suite.
  pgDaily: {}, _pgTotalMemo: new Map(),
  lbGoals: null,                    // no published payload: exercise the budget fallback
  periodGoalsCache: {},
  paceFracs: null, paceFracsAt: 0,
  paceFracsStale: () => true,
  getDaysOfISOWeek: () => [],
  getActiveStores: () => STORES,
  // Flat DOW weights keep the current-month pro-rate equal to day/daysInMonth, so the expected
  // numbers below stay hand-checkable. monthGoalFrac's DOW weighting is exercised separately.
  getDOWWeights: () => Array(7).fill(1 / 7),
  toDateStr: d => d.toLocaleDateString('en-CA'),
};
vm.createContext(ctx);

function atClock(iso) {
  const t = new Date(iso).getTime();
  class FakeDate extends Date {
    constructor(...a) { return a.length ? new Date(...a) : new Date(t); }
    static now() { return t; }
  }
  ctx.Date = FakeDate;
}

vm.runInContext([
  MONTHS_SRC, YTD_SRC, THRESHOLDS_SRC,
  grab('getGoal'), grab('monthBounds'), grab('ytdBounds'), grab('pgTotal'),
  grab('getMonthlyGoal'), grab('getWeeklyGoal'), grab('getDailyGoal'),
  grab('getPacingPct'), grab('monthGoalFrac'), grab('getGoalPacingPct'),
].join('\n'), ctx);

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${got}, wanted ${want}`));
}
const call = (fn) => vm.runInContext(fn + '(' + JSON.stringify(STORES) + ')', ctx);
const goalOf = (m) => vm.runInContext(
  `${JSON.stringify(STORES)}.reduce((a,s)=>a+getMonthlyGoal(s,${m},activeYear),0)`, ctx);

// ── The reported screenshot: 2026-08-24, YTD ─────────────────────────────────
console.log('\nthe screenshot: YTD on 2026-08-24');
atClock('2026-08-24T17:14:00');
ctx.activeMonth = 0; ctx.activeWeek = null; ctx.activeDay = null;

const periodGoal = goalOf(0);
check('YTD goal covers Jan..Aug only, not the full year', periodGoal, 6 * 8 * 100000);

const calendarPct = call('getPacingPct');
const goalPct     = call('getGoalPacingPct');
console.log(`  calendar-year elapsed ${calendarPct}%  ·  goal-window elapsed ${goalPct}%`);
check('the calendar fraction is ~65% (Aug 24 of 365 days)', calendarPct, 65);
// 7 whole months at 100% + August at 24/31 → (7 + 0.774) / 8 = 97%.
check('the goal window is 97% elapsed, not 65%', goalPct, 97);

// The bug, in the units it was reported in. Net is scaled to the fixture: the screenshot sat at 98%
// of its YTD goal, so 98% of $800k here reproduces the same relationship.
const net = Math.round(periodGoal * 0.98);
const brokenPaced = Math.round(periodGoal * calendarPct / 100);
const fixedPaced  = Math.round(periodGoal * goalPct / 100);
const brokenUnder = brokenPaced - net;
const fixedUnder  = fixedPaced - net;
console.log(`  at 98% of goal: old reads +${(-brokenUnder).toLocaleString()} over pace, ` +
            `new reads ${fixedUnder > 0 ? '−' + fixedUnder.toLocaleString() + ' behind' : '+' + (-fixedUnder).toLocaleString() + ' over'}`);
check('the old path claims a third of the goal in phantom surplus', brokenUnder < -periodGoal * 0.3, true);
check('a hero at 98% of goal no longer reads wildly over pace', Math.abs(fixedUnder) < periodGoal * 0.03, true);
check('98% of goal with 97% of the window gone reads slightly OVER, not behind', fixedUnder < 0, true);

// ── The two halves of the rule ───────────────────────────────────────────────
console.log('\nwhole elapsed months count in full; only the current one is pro-rated');
atClock('2026-08-01T09:00:00');
// Aug day 1 of 31 → (7 + 1/31) / 8 = 88.0%.
check('Aug 1 — seven months banked, August barely begun', call('getGoalPacingPct'), 88);
atClock('2026-08-31T21:00:00');
check('Aug 31 — the window is complete', call('getGoalPacingPct'), 100);
atClock('2026-01-15T12:00:00');
// January alone: 15/31 = 48.4%.
check('mid-January paces against January alone, not the year', call('getGoalPacingPct'), 48);

console.log('\nclosed and future years');
ctx.activeYear = 2025;
atClock('2026-08-24T17:14:00');
check('a past year is 100% elapsed', call('getGoalPacingPct'), 100);
ctx.activeYear = 2027;
check('a future year is 0% elapsed, never negative', call('getGoalPacingPct'), 0);
ctx.activeYear = 2026;

// ── The separation the fix rests on ──────────────────────────────────────────
console.log('\nExpenses must keep the calendar fraction — its YTD budget is all twelve months');
atClock('2026-08-24T17:14:00');
check('getPacingPct is untouched for YTD', call('getPacingPct'), 65);
check('the two functions genuinely disagree in YTD', call('getPacingPct') !== call('getGoalPacingPct'), true);
check('getPacingPct() still answers with no store list (how Expenses calls it)',
      vm.runInContext('getPacingPct()', ctx), 65);

console.log('\nevery other grain delegates unchanged');
ctx.activeMonth = 8;
check('a month view matches getPacingPct exactly', call('getGoalPacingPct'), call('getPacingPct'));
ctx.activeMonth = 8; ctx.activeDay = '2026-08-20';
check('a past day matches getPacingPct exactly', call('getGoalPacingPct'), call('getPacingPct'));
ctx.activeDay = null; ctx.activeWeek = 34; ctx.activeMonth = 0;
// activeWeek wins over the YTD sentinel — a week inside a YTD selection is still a week.
check('a week inside YTD delegates rather than pacing the year',
      call('getGoalPacingPct'), call('getPacingPct'));
ctx.activeWeek = null;

// ── monthGoalFrac's DOW weighting ────────────────────────────────────────────
console.log('\nmonthGoalFrac weights by day-of-week, not by flat date');
ctx.getDOWWeights = () => [0.05, 0.05, 0.05, 0.05, 0.05, 0.5, 0.25]; // [Sun..Sat] — Friday carries it
atClock('2026-08-24T17:14:00');
const frac = (d) => vm.runInContext(`monthGoalFrac(${JSON.stringify(STORES)}, 8, 2026, 31, ${d})`, ctx);

// Aug 2026: the 21st is a Friday, the 23rd a Sunday. Banking a Friday has to move the month further
// along than banking a Sunday — that is the whole difference between this and day/daysInMonth, which
// would score the two identically at 1/31 apiece.
const friStep = frac(21) - frac(20);
const sunStep = frac(23) - frac(22);
console.log(`  crossing Fri Aug 21 adds ${(friStep * 100).toFixed(1)}%; crossing Sun Aug 23 adds ${(sunStep * 100).toFixed(1)}%`);
check('a Friday advances the month far more than a Sunday', friStep > sunStep * 5, true);
check('and neither equals the flat 1/31 a date-only count would give',
      Math.abs(friStep - 1 / 31) > 0.005 && Math.abs(sunStep - 1 / 31) > 0.005, true);
check('the fraction never exceeds 1', frac(24) <= 1, true);
check('the whole month is exactly 1', Math.abs(frac(31) - 1) < 1e-9, true);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

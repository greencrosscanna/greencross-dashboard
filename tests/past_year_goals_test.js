#!/usr/bin/env node
/* The budget spreadsheet is ONE year wide — the "2026 GX2 Dashboard" workbook, twelve monthly
 * columns, no year dimension — but the period picker offers curY-2..curY and fetches all twelve
 * months of Dutchie data for a past year. So a 2025 view measured real 2025 sales against the 2026
 * plan, and "Full year" 2025 measured them against the entire 2026 annual budget. Nothing said so:
 * the number rendered in the same place, in the same style, as a correct one.
 *
 * Measured before the fix, over the eighteen 2026 pay periods and the six store rows the goals tab
 * actually returns: getMonthlyGoal('Bend', 3, 2024) === getMonthlyGoal('Bend', 3, 2026). Identical
 * for every store, every month, every year the picker offers.
 *
 * There is no 2025 budget to fall back to (that workbook holds only ATM usage) and GX Core's frozen
 * period goals do not begin until ~Nov 2025, so the fix is to show NO goal rather than a wrong one.
 * This suite runs the real functions out of index.html — a copy would keep passing after the shipped
 * code regressed, which is the only way it could lie.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT  = path.join(__dirname, '..');
const SRC   = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PROXY = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html — renamed?');
  let depth = 0, j = SRC.indexOf('{', m.index + 1);
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const MONTHS_SRC = /const MONTHS = \[[^\]]*\];/.exec(SRC)[0];
const YTD_SRC    = /const MONTH_YTD = 0;/.exec(SRC)[0];

const STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];
// The real 2026 figures the goals tab returns, so a failure prints numbers Sky can recognise.
const BUDGET = {
  'Bend':        [143823, 130172, 144416, 140045, 145011, 140623, 145609, 145909, 141494, 146511, 142077, 147115],
  'Center':      [ 50631,  45826,  50840,  49301,  51050,  49505,  51260,  51366,  49811,  51578,  50017,  51790],
  'Commercial':  [197205, 178487, 198018, 192025, 198834, 192817, 199654, 200066, 194011, 200891, 194811, 201719],
  'Hillsboro':   [ 80279,  72659,  80610,  78170,  80942,  78492,  81276,  81443,  78978,  81779,  79304,  82116],
  'Portland Rd': [ 65100,  58921,  65368,  63390,  65638,  63652,  65909,  66044,  64046,  66317,  64310,  66590],
  'River':       [143045, 129468, 143635, 139287, 144227, 139862, 144822, 145120, 140728, 145718, 141308, 146319],
};
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const goals = Object.fromEntries(Object.entries(BUDGET).map(([s, v]) =>
  [s, Object.fromEntries(MONTH_NAMES.map((m, i) => [m, v[i]]))]));

// Clock is fixed: getGoal's YTD branch asks the host what "this year" and "this month" are, so a
// real Date would quietly change what the YTD cases mean once the calendar moved past 2026.
class FakeDate extends Date {
  constructor(...a) { return a.length ? new Date(...a) : new Date('2026-08-29T12:00:00'); }
  static now() { return new Date('2026-08-29T12:00:00').getTime(); }
}

const ctx = {
  console, goals, goalsYear: 2026,
  activeYear: 2026,
  // No frozen period goals loaded: this suite is about the BUDGET path and its year gate, so every
  // pgTotal window must come back null and fall through. tests/period_goal_rollup_test.js covers
  // the frozen path and the precedence between the two.
  pgDaily: {}, _pgTotalMemo: new Map(),
  lbGoals: null,             // no published payload — exercise the budget path, which is the one gated
  periodGoalsCache: {},
  getDOWWeights: () => Array(7).fill(1 / 7),
  Date: FakeDate,
};
vm.createContext(ctx);
vm.runInContext([
  MONTHS_SRC, YTD_SRC,
  grab('getGoal'), grab('monthBounds'), grab('ytdBounds'), grab('pgTotal'),
  grab('getMonthlyGoal'), grab('getWeeklyGoal'), grab('getDailyGoal'),
].join('\n'), ctx);

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${desc}` + (ok ? '' : `\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

console.log('the budget year still resolves exactly as before');
for (const s of STORES) {
  check(`${s} March 2026 is the sheet's March`, ctx.getMonthlyGoal(s, 3, 2026), BUDGET[s][2]);
}
check('YTD 2026 sums Jan..Aug, not all twelve',
  ctx.getGoal('Bend', 0, 2026), BUDGET['Bend'].slice(0, 8).reduce((a, b) => a + b, 0));

console.log('\nan unbudgeted year gets NO goal, not the wrong one');
for (const yr of [2024, 2025, 2027]) {
  for (const s of STORES) check(`${s} March ${yr}`, ctx.getMonthlyGoal(s, 3, yr), 0);
  check(`YTD/full-year ${yr}`, ctx.getGoal('Bend', 0, yr), 0);
}

console.log('\nevery goal accessor is gated, not just the monthly one');
// getWeeklyGoal and getDailyGoal reach the sheet through getGoal, and a fix that gated only
// getMonthlyGoal would leave the week and day views printing 2026 targets over 2025 sales.
check('getWeeklyGoal 2025',  ctx.getWeeklyGoal('Bend', 3, 2025, 31), 0);
check('getWeeklyGoal 2026',  Math.round(ctx.getWeeklyGoal('Bend', 3, 2026, 31)), Math.round(BUDGET['Bend'][2] * 7 / 31));
check('getDailyGoal 2025',   ctx.getDailyGoal('Bend', 4, 3, 2025, 31), 0);
check('getDailyGoal 2026',   Math.round(ctx.getDailyGoal('Bend', 4, 3, 2026, 31)), Math.round(BUDGET['Bend'][2] * 7 / 31 / 7));

console.log('\nthe gate opens only when the backend actually named a year');
// Pages and clasp deploy separately, and getGoals() caches server-side for an hour. A frontend that
// blanked every goal because the proxy had not caught up would be a worse outage than the bug.
ctx.goalsYear = null;
check('no year reported → 2025 falls through to the old behaviour',
  ctx.getMonthlyGoal('Bend', 3, 2025), BUDGET['Bend'][2]);
check('no year reported → 2026 still correct', ctx.getMonthlyGoal('Bend', 3, 2026), BUDGET['Bend'][2]);
ctx.goalsYear = 2026;

console.log('\nthe backend half is present — the gate is dead without it');
check('dutchie_proxy.gs declares BUDGET_YEAR', /const BUDGET_YEAR\s*=\s*\d{4};/.test(PROXY), true);
// Scoped to getGoals' own body and asserting the INVARIANT — that the response carries
// `year: BUDGET_YEAR` — rather than one exact serialization. The literal form this used to match
// broke when getGoals stopped reading the budget spreadsheet and started serving the frozen
// snapshot (v2.553), even though it still ships the year. A test that fails on a rename of the
// thing it is not about stops being read as a real signal.
const GET_GOALS_BODY = (function () {
  const i = PROXY.indexOf('function getGoals()');
  if (i < 0) return '';
  let j = PROXY.indexOf('{', i), depth = 0, k = j;
  for (; k < PROXY.length; k++) {
    if (PROXY[k] === '{') depth++;
    else if (PROXY[k] === '}') { depth--; if (!depth) break; }
  }
  return PROXY.slice(i, k + 1);
})();
check('getGoals() ships it to the client',
  /JSON\.stringify\(\{[^}]*year:\s*BUDGET_YEAR/.test(GET_GOALS_BODY), true);
check('BUDGET_YEAR matches the sheet this repo points at', /const BUDGET_YEAR\s*=\s*2026;/.test(PROXY), true);

console.log('\nthe client stores and reads the year alongside the numbers');
check('loadGoals caches under a v2 key, retiring year-less v1 entries',
  /readCache\('goals_v2'\)/.test(SRC) && /writeCache\('goals_v2'/.test(SRC), true);
check('loadGoals assigns goalsYear from the response', /goalsYear = Number\(data\.year\) \|\| null/.test(SRC), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

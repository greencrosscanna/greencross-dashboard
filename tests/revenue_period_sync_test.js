#!/usr/bin/env node
/* The +Revenue tab renders ONE cell of a two-dimensional key: (year, month) → ATM txns / sublet $.
 * It used to read those two coordinates from two different places — the month from the shared
 * selection (activeMonth, which the sub-nav period control drives) and the year from a private
 * `activeRevYear` that only its own two year buttons could move. Stepping ‹ from Jan 2026 walked
 * the shared selection to Dec 2025; the private year stayed on 2026; the tab rendered December of
 * the 2026 dataset. That is the reported symptom — "Dec 2025 shows no value".
 *
 * The blank was the harmless half. openRevModal was handed the SAME mismatched pair (month from the
 * selection, year from the loaded payload) and passed it straight to ?action=set_revenue, so a save
 * made while the header read Dec 2025 wrote rev_atm_2026/Dec. A silent write to the wrong year is
 * not visible anywhere until someone reconciles the year, which is why this test asserts the
 * SAVE-TARGET pair, not just what renders.
 *
 * Everything below runs the real functions lifted out of index.html — including the real
 * periodApply and periodStepTarget, so the step that produced the bug is the step under test.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull real bodies out of the monolith. A restated copy would keep passing after the shipped code
// regressed, which is the only way a test like this can lie.
function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate function ' + name + '() in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}
function grabLine(re, what) {
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + what + ' in index.html');
  return m[0];
}

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}

// A private revenue year is the bug itself, not merely one way to write it. Fail loudly if it
// comes back, because every assertion below would still pass while the tab drifted again.
if (/\n\s*(?:let|var|const)\s+activeRevYear\b/.test(SRC)) {
  console.log('  FAIL  index.html declares activeRevYear again — the +Revenue tab has a private year once more');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

// Fixed clock: the reported case sits in 2026, and revMonthNum()/revYearChoices() both read "now".
const NOW = new Date('2026-08-25T12:00:00').getTime();
class FakeDate extends Date {
  constructor(...a) { return a.length ? new Date(...a) : new Date(NOW); }
  static now() { return NOW; }
}

const calls = [];
const ctx = {
  console, Date: FakeDate,
  section: 'revenue',
  activeYear: 2026, activeMonth: 1, activeWeek: null, activeDay: null,
  revenueDetail: null,
  liveData: {},
  // periodApply's fan-out. Recorded, not modelled: what matters is that the revenue tab's own
  // controls reach the shared write-point at all.
  buildTimeNav:    () => calls.push('buildTimeNav'),
  render:          () => calls.push('render'),
  clearAutoRefresh:() => calls.push('clearAutoRefresh'),
  loadAllStores:   () => calls.push('loadAllStores'),
  refreshCompare:  () => calls.push('refreshCompare'),
  loadPeriodGoals: () => calls.push('loadPeriodGoals'),
  // periodApply now loads the frozen-goal range for whatever view it lands on, day or not — the
  // week/month/YTD views read those goals as of v2.541. Recorded like the others so a future change
  // that stops following the period shows up here.
  loadPeriodGoalRange: () => calls.push('loadPeriodGoalRange'),
  activeGoalRange: () => ['2026-01-01', '2026-01-31'],
  loadPaceFracs:   () => calls.push('loadPaceFracs'),
  paceFracsAt: 0,
  getDaysOfISOWeek: () => [],
  getUserWeek: () => 1,
  periodGoDay:  () => {},
  periodGoWeek: () => {},
};
vm.createContext(ctx);

vm.runInContext([
  grabLine(/const MONTHS = \[[^\]]*\];/, 'MONTHS'),
  grabLine(/const MONTH_YTD = \d+;/, 'MONTH_YTD'),
  grab('toDateStr'),
  grab('todayMidnight'),
  grab('periodGrain'),
  grab('periodApply'),
  grab('periodStepTarget'),
  grab('periodStep'),
  grab('revYear'),
  grab('revMonthNum'),
  grab('revDetailStale_'),
  grab('revYearChoices'),
  grab('setRevYear'),
  grab('setRevMonth'),
  grabLine(/let _revDetailLoading = null;/, '_revDetailLoading'),
  grab('loadRevenueDetail'),
].join('\n'), ctx);

const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// The exact pair the tab renders and, identically, the pair openRevModal hands to set_revenue.
function revCell() {
  return vm.runInContext('revYear()', ctx) + '/' + MO[vm.runInContext('revMonthNum()', ctx) - 1];
}
function select(year, month) {
  ctx.activeYear = year; ctx.activeMonth = month; ctx.activeWeek = null; ctx.activeDay = null;
}

console.log('\n1. the reported step: ‹ from January 2026');
select(2026, 1);
check('starts on Jan 2026', revCell(), '2026/Jan');
check('the ‹ neighbor is named Dec', vm.runInContext('periodStepTarget(-1).label', ctx), 'Dec');
check('and it is reachable', vm.runInContext('periodStepTarget(-1).allowed', ctx), true);
vm.runInContext('periodStep(-1)', ctx);
check('the shared selection is Dec 2025', ctx.activeYear + '/' + ctx.activeMonth, '2025/12');
check('and the +Revenue cell follows it across the year boundary', revCell(), '2025/Dec');

console.log('\n2. the silent half — the save target moves with the header');
// openRevModal is handed (month, year) from exactly these two reads; before the fix the year came
// from revenueDetail.year, which the step could not touch.
check('a save from Dec 2025 targets rev_atm_2025/Dec, not 2026', revCell(), '2025/Dec');
vm.runInContext('periodStep(1)', ctx);
check('stepping › back lands on Jan 2026 again', revCell(), '2026/Jan');

console.log('\n3. a payload for another year is refused, not rendered');
select(2026, 12);
ctx.revenueDetail = { year: '2026', cfg: {}, atm: {}, sub: {} };
check('the 2026 payload is fresh while 2026 is selected', vm.runInContext('revDetailStale_()', ctx), false);
select(2025, 12);
check('the same payload is STALE once Dec 2025 is selected', vm.runInContext('revDetailStale_()', ctx), true);
check('numeric and string years still compare equal', (() => {
  ctx.revenueDetail = { year: 2025 };
  return vm.runInContext('revDetailStale_()', ctx);
})(), false);
ctx.revenueDetail = null;
check('holding nothing is stale too — one predicate, both cases', vm.runInContext('revDetailStale_()', ctx), true);

console.log('\n4. the tab\'s own controls write through periodApply');
select(2026, 8);
ctx.liveData = { Commercial: {} };   // periodApply only refetches once something has been loaded
calls.length = 0;
vm.runInContext('setRevMonth(3)', ctx);
check('setRevMonth moves the SHARED month', ctx.activeYear + '/' + ctx.activeMonth, '2026/3');
check('and rebuilds the sub-nav period control', calls.includes('buildTimeNav'), true);
check('and reloads — picking a month here no longer leaves Income on the old one', calls.includes('loadAllStores'), true);

calls.length = 0;
vm.runInContext('setRevYear(2025)', ctx);
check('setRevYear moves the SHARED year', ctx.activeYear, 2025);
check('keeping the month you were looking at', ctx.activeMonth, 3);
check('and the cell agrees', revCell(), '2025/Mar');
check('sub-nav rebuilt', calls.includes('buildTimeNav'), true);

calls.length = 0;
vm.runInContext('setRevYear(2025)', ctx);
check('re-picking the year you are on is a no-op', calls.length, 0);

console.log('\n5. a week or day selection still names the month it sits in');
select(2025, 12); ctx.activeWeek = 51; ctx.activeDay = '2025-12-18';
check('a day inside Dec 2025 renders Dec 2025', revCell(), '2025/Dec');
ctx.activeWeek = null; ctx.activeDay = null;

console.log('\n6. a YTD selection has no month — fall back the way the calendar does');
select(2026, 0);
check('current year, year-wide → this month', revCell(), '2026/Aug');
select(2025, 0);
check('a PAST year, year-wide → December, the last month that can hold data', revCell(), '2025/Dec');
select(2024, 0);
check('and not "August 2024", a month nobody picked', revCell(), '2024/Dec');

console.log('\n7. the year buttons cover every year the period control can reach');
const years = vm.runInContext('revYearChoices()', ctx);
check('three years offered, matching the popover', years.length, 3);
check('current year included', years.includes(2026), true);
check('and the two the popover offers behind it', years.join(','), '2024,2025,2026');
check('no literal year list left in the markup', /setRevYear\(20\d\d\)/.test(SRC), false);

/* renderRevenue asks loadRevenueDetail for help whenever what it holds is the wrong year, and
 * loadRevenueDetail can answer straight out of localStorage. Those two facts make a cache entry
 * that disagrees with its own key a synchronous render → load → render loop that hangs the tab —
 * a far worse failure than the stale number the year check was added to prevent. The key contains
 * the year, so this should be unreachable; "should be unreachable" is exactly the reasoning that
 * makes a hang ship, so the guard is asserted rather than argued. */
console.log('\n8. a cache entry that disagrees with its own key cannot loop');
(async () => {
  let renderCalls = 0, fetched = 0, guardTripped = false;
  ctx.getProxyUrl = () => '';                 // no backend: the ONLY way out is not re-entering
  ctx.getToken    = () => 't';
  ctx.writeCache  = () => {};
  ctx.fetch       = () => { fetched++; return Promise.reject(new Error('no network in test')); };
  // Stands in for the real renderRevenue's one relevant behavior: stale → ask again.
  ctx.renderRevenue = () => {
    if (++renderCalls > 50) { guardTripped = true; throw new Error('render/load loop'); }
    if (vm.runInContext('revDetailStale_()', ctx)) vm.runInContext('loadRevenueDetail()', ctx);
  };

  select(2025, 12);
  ctx.revenueDetail = null;
  ctx.readCache = () => ({ year: '2026', cfg: {}, atm: {}, sub: {} });   // poisoned: wrong year
  try { await vm.runInContext('loadRevenueDetail()', ctx); } catch (e) { guardTripped = true; }
  check('a wrong-year cache entry is not adopted', ctx.revenueDetail, null);
  check('and it does not re-enter render', renderCalls, 0);
  check('no runaway loop', guardTripped, false);

  renderCalls = 0;
  const good = { year: '2025', cfg: {}, atm: {}, sub: {} };
  ctx.readCache = () => good;
  ctx.section = 'revenue';
  try { await vm.runInContext('loadRevenueDetail()', ctx); } catch (e) { guardTripped = true; }
  check('a matching cache entry IS adopted', ctx.revenueDetail, good);
  check('and renders exactly once', renderCalls, 1);
  check('with no fetch — the cache is still the fast path', fetched, 0);

  console.log('\n──────────────────────────────');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

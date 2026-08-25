#!/usr/bin/env node
/* The Reconcile tab makes ONE claim: this store banked what it sold that week. Everything that can
 * go wrong with that claim is arithmetic on dates, and none of it announces itself — a week summed
 * over the wrong seven days still prints a confident figure, and a deposit filed under the wrong
 * week makes two weeks wrong at once while the totals still look plausible.
 *
 * So this file runs the REAL shipped functions (lifted out of index.html, not restated here) over
 * dates chosen to sit on the failure boundaries:
 *
 *   1. Week windows must honour the PER-STORE start day. Some stores run Tue->Mon and some Wed->Tue
 *      because that is when Shawn deposits; a Monday-week assumption silently shifts a day of sales
 *      into the neighbouring week, and both weeks then disagree with the bank by that day's takings.
 *   2. The window maths must not touch the local timezone. `new Date('2026-08-18')` is midnight UTC
 *      and is the 17th anywhere west of Greenwich, so a naive implementation misfiles the boundary
 *      day for every user in Oregon. Asserted by running the boundary cases under TZ=America/
 *      Los_Angeles (see the re-exec at the top).
 *   3. A deposit is made AFTER the week it pays for, so attribution cannot use its own date
 *      directly. The default rule is "the most recent window that had already ENDED"; a deposit
 *      dated ON a window's first day must pay for the week that just closed, not the one opening.
 *   4. Expected = Net Sales + TAX. Tax is the half that was missing from the daily records until
 *      this feature added it, and dropping it understates every week by roughly the tax rate.
 *   5. A window with a missing day must report incomplete, NOT a shortfall. This is the difference
 *      between "we haven't loaded Tuesday" and "Tuesday's money never arrived", and a reconciliation
 *      screen that confuses the two sends someone hunting for a theft that did not happen.
 */
'use strict';

// Timezone is part of what is under test, so pin it rather than inherit the runner's.
if (process.env.TZ !== 'America/Los_Angeles') {
  const r = require('child_process').spawnSync(process.execPath, [__filename],
    { stdio: 'inherit', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Lift a function body out of the shipped page. A copy pasted in here would keep passing after the
// real one regressed, which is the only way a test like this can lie.
function grab(src, name, where) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in ' + where);
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

const ctx = { console };
vm.createContext(ctx);
const FALLBACK_SRC = /const RECON_WEEK_START_FALLBACK = Object\.freeze\(\{[\s\S]*?\}\);/.exec(HTML);
if (!FALLBACK_SRC) { console.log('RECON_WEEK_START_FALLBACK is gone from index.html');
                     console.log('\n0 passed, 1 failed'); process.exit(1); }
vm.runInContext(FALLBACK_SRC[0], ctx);
for (const fn of ['reconAddDays', 'reconDow', 'reconWindowStart', 'reconWindows',
                  'reconWeekStartFor', 'reconWindowForDeposit', 'reconExpectedFor',
                  'reconStateKey', 'reconIsDone', 'reconBuildRow']) {
  vm.runInContext(grab(HTML, fn, 'index.html'), ctx);
}

// State the shipped functions read off the page globals.
let reconData = null, allDailyData = {};
Object.defineProperty(ctx, 'reconData',    { get: () => reconData });
Object.defineProperty(ctx, 'allDailyData', { get: () => allDailyData });

const C = ctx;

// ── 1 & 2. Window boundaries, per store, under a west-of-UTC timezone ─────────────────────────
// 2026-08-18 is a Tuesday. Verified against the calendar, not assumed.
ok('the fixture date is really a Tuesday', C.reconDow('2026-08-18') === 2);

reconData = { config: { Commercial: 2, Bend: 3 } };   // Commercial Tue->Mon, Bend Wed->Tue

ok('Tue-week: Tuesday opens its own window',      C.reconWindowStart('2026-08-18', 2) === '2026-08-18');
ok('Tue-week: the following Monday still in it',  C.reconWindowStart('2026-08-24', 2) === '2026-08-18');
ok('Tue-week: the next Tuesday starts a new one', C.reconWindowStart('2026-08-25', 2) === '2026-08-25');
ok('Wed-week: Tuesday belongs to the week before',C.reconWindowStart('2026-08-18', 3) === '2026-08-12');
ok('Wed-week: Wednesday opens its own window',    C.reconWindowStart('2026-08-19', 3) === '2026-08-19');

// The same calendar day lands in DIFFERENT windows for two stores — the whole reason the start day
// is configured per store rather than assumed.
ok('one date, two stores, two different windows',
   C.reconWindowStart('2026-08-18', C.reconWeekStartFor('Commercial'))
   !== C.reconWindowStart('2026-08-18', C.reconWeekStartFor('Bend')));

// A month boundary and a leap day are where naive date maths breaks.
ok('windows cross a month end intact',  C.reconAddDays('2026-08-30', 3) === '2026-09-02');
ok('windows cross a year end intact',   C.reconAddDays('2026-12-30', 3) === '2027-01-02');
ok('a 7-day window ends 6 days later',  C.reconAddDays('2026-08-18', 6) === '2026-08-24');

// ── The shipped defaults must match Shawn's actual slips ──────────────────────────────────────
// Read off "08.17.26 Deposits.xlsx": one tab per store, each naming its DEPOSIT DATE and the SALES
// DATE range it covers. Bend/Hillsboro bank Tue->Mon on the Tuesday; the four Salem stores bank
// Wed->Tue on the Wednesday. Sky confirmed the pattern repeats every week. Getting one of these
// wrong shifts a whole store's week by a day, silently, against every deposit it ever makes.
reconData = { config: {} };
const SLIP_WEEK_START = { 'Bend': 2, 'Hillsboro': 2, 'Center': 3, 'Commercial': 3, 'Portland Rd': 3, 'River': 3 };
for (const [store, ws] of Object.entries(SLIP_WEEK_START)) {
  ok(`${store} defaults to ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][ws]}, per the slip`,
     C.reconWeekStartFor(store) === ws);
}

// The slips again, as end-to-end cases: the sales range printed on each slip must be exactly the
// window this code derives from that store's deposit date.
const SLIPS = [
  { store: 'Bend',        deposited: '2026-08-18', from: '2026-08-11', to: '2026-08-17' },
  { store: 'Hillsboro',   deposited: '2026-08-18', from: '2026-08-11', to: '2026-08-17' },
  { store: 'Center',      deposited: '2026-08-19', from: '2026-08-12', to: '2026-08-18' },
  { store: 'River',       deposited: '2026-08-19', from: '2026-08-12', to: '2026-08-18' },
  { store: 'Commercial',  deposited: '2026-08-19', from: '2026-08-12', to: '2026-08-18' },
  { store: 'Portland Rd', deposited: '2026-08-19', from: '2026-08-12', to: '2026-08-18' },
];
for (const sl of SLIPS) {
  const win = C.reconWindowForDeposit(sl.store, { id: 'x', date: sl.deposited });
  ok(`${sl.store}: a deposit on ${sl.deposited} pays for ${sl.from}..${sl.to}`,
     win === sl.from && C.reconAddDays(win, 6) === sl.to);
}

// The SAME slips, but dated the way QUICKBOOKS dates them. Measured on the live qb_deposits route
// over 2026-08-01..08-25: QB's TxnDate runs ONE DAY EARLIER than the DEPOSIT DATE printed on
// Shawn's slip — Bend's $40,418.94 is 08-18 on the slip and 2026-08-17 in QB. So a deposit lands on
// the LAST DAY of the window it pays for, not the day after, and the attribution rule has to be
// right at that boundary too. It is, because the rule steps back a day before finding the window —
// but that was true by luck until this asserted it, and a change to the rule could break it silently.
const QB_SLIPS = [
  { store: 'Bend',        txn: '2026-08-17', from: '2026-08-11', to: '2026-08-17' },
  { store: 'Hillsboro',   txn: '2026-08-17', from: '2026-08-11', to: '2026-08-17' },
  { store: 'Center',      txn: '2026-08-18', from: '2026-08-12', to: '2026-08-18' },
  { store: 'River',       txn: '2026-08-18', from: '2026-08-12', to: '2026-08-18' },
  { store: 'Commercial',  txn: '2026-08-18', from: '2026-08-12', to: '2026-08-18' },
  { store: 'Portland Rd', txn: '2026-08-18', from: '2026-08-12', to: '2026-08-18' },
];
reconData = { config: {}, assign: {} };
for (const q of QB_SLIPS) {
  const win = C.reconWindowForDeposit(q.store, { id: 'q', date: q.txn });
  ok(`${q.store}: QB TxnDate ${q.txn} (the window's LAST day) still pays for ${q.from}..${q.to}`,
     win === q.from && C.reconAddDays(win, 6) === q.to);
}
// Commercial's split is two deposits on ONE date, so the default rule must put both in the same
// window with no manual override — the case the first cut assumed would need nudging.
const cA = C.reconWindowForDeposit('Commercial', { id: 'a', date: '2026-08-18' });
const cB = C.reconWindowForDeposit('Commercial', { id: 'b', date: '2026-08-18' });
ok('a same-day split lands both halves in one window, unaided', cA === cB && cA === '2026-08-12');

// A junk or unknown value must fall back, never leak through as a week start.
ok('a junk config value does not leak through', (reconData = { config: { River: 99 } },
   C.reconWeekStartFor('River') === 3));
ok('an unknown store still gets a usable default',
   Number.isInteger(C.reconWeekStartFor('Nowhere')));

// ── Window enumeration over a period ──────────────────────────────────────────────────────────
// A period rarely starts on a store's week-start day. The window straddling the boundary is mostly
// days from the previous period, which were never loaded — so it would read "Incomplete" forever and
// sort to the TOP as the oldest. It belongs to the period it started in and is reconciled there.
reconData = { config: { Commercial: 2 } };   // Tue weeks; Aug 1 2026 is a Saturday
const AUG = C.reconWindows('Commercial', '2026-08-01', '2026-08-31');
ok('no window starts before the period',       AUG.every(w => w.start >= '2026-08-01'));
ok('the straddling week is not shown at all',  !AUG.some(w => w.start === '2026-07-28'));
ok('the first window is the first Tuesday in', AUG[0].start === '2026-08-04');
ok('windows are contiguous, 7 days apart',
   AUG.every((w, i) => i === 0 || w.start === C.reconAddDays(AUG[i - 1].start, 7)));
ok('every window is exactly 7 days',           AUG.every(w => w.end === C.reconAddDays(w.start, 6)));
ok('a full month yields four Tuesday weeks',   AUG.length === 4);

// ── 3. Deposit attribution ────────────────────────────────────────────────────────────────────
reconData = { config: { Commercial: 2 }, assign: {} };

// Window 2026-08-18..08-24. A deposit on the 25th (the next window's first day) pays for the one
// that just closed — the off-by-one that would otherwise credit it to a week not yet sold.
ok('a deposit on the next window\'s first day pays for the closed week',
   C.reconWindowForDeposit('Commercial', { id: 'a', date: '2026-08-25' }) === '2026-08-18');
ok('a deposit mid-week pays for the week before',
   C.reconWindowForDeposit('Commercial', { id: 'b', date: '2026-08-27' }) === '2026-08-25');

// The override is the escape hatch for a late deposit or a month-end split, and it must WIN.
reconData.assign = { a: '2026-08-11' };
ok('a manual assignment overrides the date rule',
   C.reconWindowForDeposit('Commercial', { id: 'a', date: '2026-08-25' }) === '2026-08-11');

// ── 4 & 5. Expected = Net Sales + Tax; a gap is incomplete, not a shortfall ────────────────────
reconData = { config: { Commercial: 2 }, assign: {}, state: {}, deposits: {} };
const week = { start: '2026-08-18', end: '2026-08-24' };
allDailyData = { Commercial: {} };
for (let i = 0; i < 7; i++) {
  allDailyData.Commercial[C.reconAddDays(week.start, i)] = { netSales: 1000, tax: 200 };
}

let exp = C.reconExpectedFor('Commercial', week);
ok('expected sums all seven days',            exp.missing.length === 0);
ok('expected INCLUDES tax, not just net',     exp.total === 8400);   // 7 * (1000 + 200)
ok('expected is not merely net sales',        exp.total !== 7000);

delete allDailyData.Commercial['2026-08-20'];
exp = C.reconExpectedFor('Commercial', week);
ok('a missing day is reported, not silently skipped', exp.missing.length === 1
   && exp.missing[0] === '2026-08-20');

// A gap must block the verdict: with 6 of 7 days loaded and a full week's deposit, a naive
// implementation reports "over by a day's takings" and sends someone hunting.
reconData.deposits = { Commercial: [{ id: 'd1', date: '2026-08-25', amount: 8400 }] };
let row = C.reconBuildRow('Commercial', week);
ok('an incomplete week does not tie',           row.ties === false);
ok('an incomplete week cannot be reconciled',   row.reconcilable === false);
ok('an incomplete week names the missing day',  row.missing.length === 1);

// ── Split deposits: several in one week must SUM, not last-one-wins ────────────────────────────
allDailyData.Commercial['2026-08-20'] = { netSales: 1000, tax: 200 };
reconData.deposits = { Commercial: [
  { id: 'd1', date: '2026-08-25', amount: 3600 },   // the 3-day half
  { id: 'd2', date: '2026-08-26', amount: 4800 },   // the 4-day half
]};
reconData.assign = { d2: '2026-08-18' };            // both halves pay for the same week
row = C.reconBuildRow('Commercial', week);
ok('two deposits in one week are summed',   row.deposited === 8400);
ok('a split week ties when it adds up',     row.ties === true && row.diff === 0);
ok('both deposits are listed on the card',  row.deps.length === 2);

// And when it does NOT tie, the shortfall is reported with its sign intact.
reconData.deposits.Commercial[1].amount = 4700;
row = C.reconBuildRow('Commercial', week);
ok('a short week does not tie',             row.ties === false);
ok('a short week reports a negative diff',  row.diff === -100);

// ── A variance must NOT block reconciling ─────────────────────────────────────────────────────
// The whole point, measured on Shawn's 08.17.26 slips: five of six stores carried a variance in a
// perfectly normal week (1.90, -0.33, -24.77, -0.42, 0.01) and only Bend came out exactly zero. The
// -24.77 is annotated "$25 Gift Cert" — explained, not an error. Gating the Reconcile button on an
// exact tie would have blocked five stores every week and made the tab unusable.
ok('a week with a variance is still reconcilable', row.reconcilable === true);
for (const v of [1.90, -0.33, -24.77, -0.42, 0.01]) {
  reconData.deposits.Commercial = [{ id: 'v1', date: '2026-08-25', amount: 8400 + v }];
  reconData.assign = {};
  const r = C.reconBuildRow('Commercial', week);
  ok(`a real-world variance of ${v} reconciles, and is reported`,
     r.reconcilable === true && r.ties === false && Math.abs(r.diff - v) < 0.005);
}

// Only an exact tie counts as a tie — the cent is not rounded away.
reconData.deposits.Commercial = [{ id: 'v2', date: '2026-08-25', amount: 8400 }];
ok('an exact match ties', C.reconBuildRow('Commercial', week).ties === true);
reconData.deposits.Commercial = [{ id: 'v3', date: '2026-08-25', amount: 8400.01 }];
ok('one cent out does not tie', C.reconBuildRow('Commercial', week).ties === false);

// A week with sales and no deposit at all is "awaiting" — never a tie, and not reconcilable.
reconData.deposits = { Commercial: [] };
row = C.reconBuildRow('Commercial', week);
ok('no deposit is never a tie',             row.ties === false && row.deposited === 0);
ok('no deposit is not reconcilable',        row.reconcilable === false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

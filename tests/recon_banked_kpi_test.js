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
for (const fn of ['reconBankedDate_', 'reconBankedInPeriod_', 'getISOWeek', 'getUserWeek', 'getDaysOfISOWeek', 'toDateStr']) {
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

console.log('\n2b. the money banked OUTSIDE the period is named, which is what explains a lumpy week');
// Sky, 2026-09-07: "wk 30 is abnormally high and wk 31 is low, the two combined look like it could
// be the right amount." Measured on the live reconprobe and he was right, with nothing broken:
// WK30 $283,835.57 / 13 deposits, WK31 $97,959.90 / 6, against a ~$186k / 7-deposit norm — and the
// pair $381,795.47, two ordinary weeks. Every store banked twice in WK30: the usual Mon/Tue deposit
// plus an extra on Friday 07-31, the last day of July, because a deposit spanning month end is split
// so the income lands in the right month.
const SPLIT = [row('River', '2026-07-29', '2026-08-04', 52135.89,
                   [['2026-07-31', 32733.00], ['2026-08-04', 19402.89]])];
const wk30 = kpi(SPLIT, '2026-07-27', '2026-08-02', 6);   // holds the July half
const wk31 = kpi(SPLIT, '2026-08-03', '2026-08-09', 6);   // holds the August half
ok('WK30 reports only the July half',        wk30.deposited === 32733.00);
ok('WK31 reports only the August half',      wk31.deposited === 19402.89);
ok('both refuse to compare',                 wk30.partial === true && wk31.partial === true);
ok('WK30 names the August half as outside',  wk30.outside === 19402.89);
ok('WK31 names the July half as outside',    wk31.outside === 32733.00);
ok('inside plus outside is the whole week, from either side',
   Math.round((wk30.deposited + wk30.outside) * 100) / 100 === 52135.89 &&
   Math.round((wk31.deposited + wk31.outside) * 100) / 100 === 52135.89);
ok('both halves pay for the SAME store-week, so the card reconciles normally',
   wk30.paysFrom === '2026-07-29' && wk31.paysFrom === '2026-07-29');
// A period holding a whole week has nothing outside it, and must not claim otherwise.
ok('a whole week reports zero outside', wk35.outside === 0);

console.log('\n2c. banked_on WINS over TxnDate — the month-end artifact, with the real numbers');
/* Sky, 2026-09-07: "we deposited on 8/4 for the last days of the month (7/28-31) and back dated the
 * deposit to 7/31 so it hits the P&L correctly, but it messes up my 'week' view expectations."
 *
 * Every figure below is MEASURED off the live route (reconprobe, GXCore v305), not invented. Booked
 * dates are QuickBooks TxnDate; banked dates are read from the deposit memos by reconBankedOn_.
 * Note the banked date is NOT uniform — Bend/Hillsboro/River banked 08-04, the other three 08-05 —
 * so any single "month-end deposits land on the 4th" rule would be wrong. */
const dep = (date, banked_on, amount, i) => ({ id: 'd' + date + i, date, banked_on, amount });
const bankRow = (store, ws, we, expected, deps) => ({
  store, win: { start: ws, end: we }, expected,
  deposited: deps.reduce((a, d) => a + d.amount, 0),
  deps, missing: [], done: false,
});
const JULAUG = [
  // the ordinary end-of-July run: booked Mon/Tue, banked the next day
  bankRow('Bend',       '2026-07-21', '2026-07-27', 39740.07, [dep('2026-07-27', '2026-07-28', 39740.07, 1)]),
  bankRow('Hillsboro',  '2026-07-21', '2026-07-27', 24329.52, [dep('2026-07-27', '2026-07-28', 24329.52, 1)]),
  bankRow('Center',     '2026-07-22', '2026-07-28', 11091.85, [dep('2026-07-28', '2026-07-29', 11091.85, 1)]),
  bankRow('Commercial', '2026-07-22', '2026-07-28', 45757.60, [dep('2026-07-28', '2026-07-29', 45757.60, 1)]),
  bankRow('Portland Rd','2026-07-22', '2026-07-28', 26876.04, [dep('2026-07-28', '2026-07-29', 26876.04, 1)]),
  bankRow('River',      '2026-07-22', '2026-07-28', 34510.81, [dep('2026-07-28', '2026-07-29', 34510.81, 1)]),
  // the BACK-DATED month-end run: all booked 07-31, actually banked 08-04 or 08-05
  bankRow('Bend',       '2026-07-28', '2026-08-03', 25277.67, [dep('2026-07-31', '2026-08-04', 25277.67, 2)]),
  bankRow('Hillsboro',  '2026-07-28', '2026-08-03', 14451.61, [dep('2026-07-31', '2026-08-04', 14451.61, 2)]),
  bankRow('River',      '2026-07-29', '2026-08-04', 17625.01, [dep('2026-07-31', '2026-08-04', 17625.01, 2)]),
  bankRow('Center',     '2026-07-29', '2026-08-04',  6334.27, [dep('2026-07-31', '2026-08-05',  6334.27, 2)]),
  bankRow('Commercial', '2026-07-29', '2026-08-04', 25865.23, [dep('2026-07-31', '2026-08-05', 25865.23, 2)]),
  bankRow('Portland Rd','2026-07-29', '2026-08-04', 11975.89, [dep('2026-07-31', '2026-08-05', 11975.89, 2)]),
];
const WK30 = ['2026-07-27', '2026-08-02'], WK31 = ['2026-08-03', '2026-08-09'];
const k30 = kpi(JULAUG, WK30[0], WK30[1], 6);
const k31 = kpi(JULAUG, WK31[0], WK31[1], 6);
ok('WK30 is the ordinary run alone — $182,305.89, not $283,835.57',
   k30.deposited === 182305.89);
ok('...covering all six stores',            k30.covered === 6);
ok('WK31 now carries the back-dated money — $101,529.68 of it',
   k31.deposited === 101529.68);
ok('...banked 08-04 through 08-05, not on the booked 07-31',
   k31.bankedFrom === '2026-08-04' && k31.bankedTo === '2026-08-05');
// The artifact Sky spotted: on TxnDate the pair reads 283,835.57 / 97,959.90 against a ~186k norm.
const byTxn = JULAUG.map(r => ({ ...r, deps: r.deps.map(d => ({ ...d, banked_on: '' })) }));
const t30 = kpi(byTxn, WK30[0], WK30[1], 6), t31 = kpi(byTxn, WK31[0], WK31[1], 6);
ok('on TxnDate alone WK30 swallows the whole month-end run',
   Math.round((t30.deposited - k30.deposited) * 100) / 100 === 101529.68);
// Every one of these deposits is booked 07-27..07-31, so on TxnDate WK31 holds NOTHING — the whole
// $101,529.68 sits in the week before the one it reached the bank in. That is the artifact entire.
ok('...and WK31 is left with nothing at all', t31 === null);
ok('the money is conserved — only the week it lands in moves',
   Math.round((t30.deposited + 0) * 100) / 100 ===
   Math.round((k30.deposited + k31.deposited) * 100) / 100);
// Falling back is what makes an unreadable memo cost nothing.
ok('a deposit with no readable memo keeps its TxnDate',
   ctx.reconBankedDate_({ date: '2026-07-31', banked_on: '' }) === '2026-07-31');
ok('...and one with a memo uses the real date',
   ctx.reconBankedDate_({ date: '2026-07-31', banked_on: '2026-08-04' }) === '2026-08-04');
ok('a missing banked_on field entirely is the same as an empty one',
   ctx.reconBankedDate_({ date: '2026-07-31' }) === '2026-07-31');

console.log('\n2d. money that is not a store\'s sales banking was NEVER in the total');
/* Sky, 2026-09-07: "the KPI card should exclude any deposits that have been ignored, so wk31 should
 * be 199490-12662-27" — and then "or if its easier, only show deposits attributed to store CLASS's,
 * not Corporate".
 *
 * MEASURED on the live route: it already does. WK31 holds 13 deposits totalling $212,152.49, of
 * which 12 are store-classed sales banking summing to exactly $199,489.58 — the figure on screen.
 * The $12,662.91 "South Accident (January) Insurance Reimbursement" is classed CORPORATE, so it has
 * no store and never enters a row; the $26.84 "Q1 Refund" is also CORPORATE and is dated 08-11,
 * which is WK32 and not this week at all. Over 2026-07-01..09-07 those two are the ONLY deposits
 * with no store class, and there are NO store-classed deposits whose memo is not sales.
 *
 * What misled was the note underneath: "Ignoring 2 deposits ... ($12,689.75)" — 12,662.91 + 26.84 —
 * sitting directly below a large total without saying which side of it they were on. The arithmetic
 * never changed; the sentence did.
 *
 * These pin the exclusion so a future change cannot quietly fold that money in. */
const CORP = [
  { id: 'c1', date: '2026-08-04', banked_on: '2026-08-04', amount: 12662.91, class: 'CORPORATE',
    memo: 'South Accident (January)  Insurance Reimbursement' },
  { id: 'c2', date: '2026-08-11', banked_on: '2026-08-11', amount: 26.84, class: 'CORPORATE',
    memo: 'Q1 Refund' },
];
// Unattributed deposits are not in any store row, which is the structural reason they cannot count.
const k31c = kpi(JULAUG, WK31[0], WK31[1], 6);
ok('WK31 is the store banking alone', k31c.deposited === 101529.68);
ok('...and no CORPORATE row can reach it — they belong to no store',
   CORP.every(c => !JULAUG.some(r => r.deps.some(d => d.id === c.id))));
// A deposit that IS store-classed but is not sales banking is set aside as a stray by reconBuildRow
// and lands in `strays`, never `deps`. The KPI reads `deps` only.
const withStray = JULAUG.concat([{
  store: 'Commercial', win: { start: '2026-07-29', end: '2026-08-04' }, expected: 0,
  deposited: 0, deps: [], missing: [],
  strays: [{ id: 's1', date: '2026-08-04', banked_on: '2026-08-05', amount: 12662.91 }],
}]);
ok('a store-classed NON-sales deposit is a stray and is not counted either',
   kpi(withStray, WK31[0], WK31[1], 6).deposited === 101529.68);
ok('...and it does not inflate the store coverage count',
   kpi(withStray, WK31[0], WK31[1], 6).covered === 6);

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
// A withheld comparison must first say the TOTAL is complete. Sky, 2026-09-07: "when i'm in week
// mode, i want to see the sum of what was deposited that week, regardless of the month." The figure
// already was that sum — measured, WK30 $283,835.57 and WK31 $97,959.90, matching QuickBooks to the
// cent — but the note read as though money were missing from it. Only the GOAL comparison is
// withheld, and the note has to lead with that or a correct total looks clipped.
ok('a withheld comparison first says the total is complete',
   /This is everything banked in this period/.test(CARD));
ok('...and it is the GOAL comparison that is withheld, named as such',
   /No goal comparison —/.test(CARD));
// DATED, not banked. Sky, 2026-09-07: "we deposited on 8/4 for the last days of the month
// (7/28-31) and back dated the deposit to 7/31 so it hits the P&L correctly." The money did not move
// in another period — only its QuickBooks date did, and the tile must not assert otherwise. The real
// banking date lives in the deposit memo (`BEND 08.04.26 Dep (7/28/26 - 7/31/26)`), which
// qb_deposits does not yet pass through; requested from core-admin 2026-09-07.
ok('...saying the money is DATED outside the period, not banked there',
   /is\s+DATED outside this period/.test(CARD));
ok('...and naming back-dating as the cause', /back-dated so they land in the right\s+month/.test(CARD));

console.log('\n9. the headline is a swipe surface, sharing the income hero\'s gesture');
// Sky, 2026-09-07: "can we update so i can swipe the top KPI chip to switch the week, same as we do
// on the income tab." Same machinery, not a second copy — a parallel implementation drifts from this
// one within a release. The surface is declared with data-pswipe="<selector>", and the selector has
// to re-find the node AFTER periodStep re-renders, because the element thrown off screen is not the
// one that comes back.
ok('the Reconcile headline declares itself a swipe surface',
   /class="recon-kpi" data-pswipe="\.recon-kpi"/.test(HTML));
ok('...restricted to phones, where a drag is a swipe and not a text selection',
   /data-pswipe="\.recon-kpi" data-pswipe-mobile/.test(HTML));
ok('...and carries its own pair of cues', /recon-kpi[^>]*>\s*<span class="ic-swipe-cue l">/.test(HTML));
ok('the income hero is the same kind of surface, not a special case',
   /id="ic-mob-hero" data-pswipe="#ic-mob-hero"/.test(HTML));
ok('there is exactly ONE commit path, shared', (HTML.match(/function _pCommit\s*\(/g) || []).length === 1);
ok('cues are found inside the surface, not by a global id',
   /el\.querySelector\('\.ic-swipe-cue\.l'\)/.test(HTML) && !/getElementById\('ic-cue-l'\)/.test(HTML));
ok('a drag starting on a control is left to that control',
   /closest\('button,a,input,select,textarea'\)/.test(HTML));
ok('the surface allows vertical scrolling through it',
   /\.recon-kpi\{[^}]*touch-action:pan-y/.test(HTML));
ok('...and is positioned so the cues have something to anchor to',
   /\.recon-kpi\{[^}]*position:relative/.test(HTML));
// periodStep is what actually moves, so the swipe inherits the week/month/day grain for free.
ok('the commit calls periodStep, so it steps whatever grain is selected',
   /_pCommit\(dir, sel\)[\s\S]{0,1200}periodStep\(dir\)/.test(HTML));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

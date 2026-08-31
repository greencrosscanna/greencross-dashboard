#!/usr/bin/env node
/* getDeposits turns GX Core's qb_deposits payload into the per-store rows the Reconcile tab draws.
 * The failure that matters here is not a crash — it is a MISCOUNT that still adds up.
 *
 * A real store deposit arrives as FIVE lines, all carrying the same class, because QuickBooks breaks
 * the revenue out by category: "Sales 3% Tax", "Sales 17% Tax", "Med Sales", "Rec Sales",
 * "Non MJ Sales". Measured on the live route over 2026-08-01..08-25: 22 deposits, 20 of them 5 lines,
 * and not one spanning more than one class. The first cut of this code pushed a record per LINE, so
 * one trip to the bank became five rows under that store — 101 rows where there were 21 deposits.
 * The week TOTAL still reconciled, because amounts sum either way, which is exactly what makes it
 * dangerous: nothing looks wrong until you read the card and it claims Commercial banked ten times.
 *
 * So this asserts the collapse, and the two things the collapse must not break:
 *   - money is conserved (every line's amount still lands somewhere, once)
 *   - a class that maps to no store still surfaces under `unattributed` rather than vanishing
 *
 * The fixture is the SHAPE of a live qb_deposits response, including the two real oddities the live
 * route actually returned: a one-line CORPORATE refund, and a one-line deposit under a STORE class
 * that is an insurance reimbursement, not sales. That second one must be kept and attributed — it is
 * money in the bank under that class — because a reconciliation screen that silently drops a deposit
 * is worse than one that shows a variance.
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

const MAP_SRC = /const RECON_STORE_BY_CLASS_ = \{[\s\S]*?\};/.exec(GS);
if (!MAP_SRC) { console.log('RECON_STORE_BY_CLASS_ is gone from dutchie_proxy.gs');
                console.log('\n0 passed, 1 failed'); process.exit(1); }

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(MAP_SRC[0] + '\n' + grab(GS, 'hasOwn_') + '\n' + grab(GS, 'reconDate_'), ctx);

// The grouping half of the SHIPPED getDeposits, lifted rather than restated — a copy pasted here
// would keep passing after the real one regressed.
const BODY  = grab(GS, 'getDeposits');
const START = BODY.indexOf('const byStore = {};');
const END   = BODY.indexOf('for (const k of Object.keys(byStore))');
if (START === -1 || END === -1) { console.log('getDeposits no longer has the shape this test lifts from');
                                  console.log('\n0 passed, 1 failed'); process.exit(1); }
vm.runInContext('function group(raw){' + BODY.slice(START, END) + 'return { byStore, unattributed };}', ctx);

// ── Fixture: the shape of a live qb_deposits response ─────────────────────────────────────────
const FIVE = ['Sales 3% Tax', 'Sales 17% Tax', 'Med Sales', 'Rec Sales', 'Non MJ Sales'];
const storeDeposit = (id, date, cls, amounts) => ({
  id, date, total: Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100,
  account: 'CHECKING OPERATIONS',
  lines: amounts.map((amount, i) => ({ class: cls, class_id: '25000000000' + cls.length, amount, memo: FIVE[i] })),
});

const RAW = [
  storeDeposit('59109', '2026-08-17', 'CENTURY DR',    [ 368.53, 2090.68,  234.83, 37513.08, 211.82]),
  storeDeposit('59110', '2026-08-17', 'BASELINE ST',   [ 287.25, 1628.99,  234.83, 21734.28, 211.82]),
  // Commercial's 3-day + 4-day split: two separate deposits, same day, same class.
  storeDeposit('59151', '2026-08-18', 'COMMERCIAL ST', [ 300.00, 1700.00,  200.00, 28794.42, 200.00]),
  storeDeposit('59152', '2026-08-18', 'COMMERCIAL ST', [ 200.00, 1100.00,  100.00, 17629.71, 100.00]),
  // A one-line deposit under a STORE class that is NOT sales. Real: the live route returned exactly
  // this. It must be kept and attributed, memo intact, so the variance it causes explains itself.
  { id: '58974', date: '2026-08-04', total: 12662.91, account: 'CHECKING OPERATIONS',
    lines: [{ class: 'COMMERCIAL ST', class_id: '25', amount: 12662.91,
              memo: 'South Accident (January)  Insurance Reimbursement' }] },
  // A one-line CORPORATE refund. CORPORATE is a real class carrying real money but it is not a
  // store, so it must land in `unattributed` — listed, never dropped.
  { id: '59093', date: '2026-08-11', total: 26.84, account: 'CHECKING OPERATIONS',
    lines: [{ class: 'CORPORATE', class_id: '26', amount: 26.84, memo: 'Q1 Refund' }] },
];

const { byStore, unattributed } = ctx.group(RAW);
const all = Object.values(byStore).flat();

// ── The collapse ──────────────────────────────────────────────────────────────────────────────
ok('one 5-line deposit becomes ONE row, not five', all.length + unattributed.length === RAW.length);
ok('every row reports the line count it folded',
   all.filter(r => r.lines === 5).length === 4 && all.filter(r => r.lines === 1).length === 1);

const century = byStore['Bend'] || [];
ok('a 5-line store deposit yields a single row',   century.length === 1);
ok('...carrying the deposit total, not one line',  century[0].amount === 40418.94);
ok('...and keeping every memo',                    FIVE.every(m => century[0].memo.includes(m)));

// ── Money is conserved ────────────────────────────────────────────────────────────────────────
const rawTotal = RAW.reduce((a, d) => a + d.lines.reduce((x, l) => x + l.amount, 0), 0);
const outTotal = [...all, ...unattributed].reduce((a, r) => a + r.amount, 0);
ok('not a cent is lost or double-counted in the collapse', Math.abs(rawTotal - outTotal) < 0.005);

// ── The split survives it ─────────────────────────────────────────────────────────────────────
const comm = byStore['Commercial'] || [];
ok('Commercial keeps its two same-day deposits as TWO rows',
   comm.filter(r => r.date === '2026-08-18').length === 2);
ok('...with their own amounts, not merged',
   comm.some(r => r.amount === 31194.42) && comm.some(r => r.amount === 19129.71));

// ── Nothing vanishes ──────────────────────────────────────────────────────────────────────────
ok('CORPORATE is not a store, so it lands in unattributed',
   unattributed.length === 1 && unattributed[0].class === 'CORPORATE');
ok('...with its amount and memo intact',
   unattributed[0].amount === 26.84 && unattributed[0].memo === 'Q1 Refund');

const ins = comm.find(r => r.id === '58974');
ok('a non-sales deposit under a store class is KEPT, not filtered', !!ins);
ok('...and carries the memo that explains the variance it will cause',
   !!ins && ins.memo.indexOf('Insurance Reimbursement') !== -1);

// ── The class is never folded ─────────────────────────────────────────────────────────────────
// Guarding the same mistake that cost this repo four ATM machines: fold or normalize the class and
// every store bucket empties, silently.
const FOLDED = RAW.map(d => ({ ...d, lines: d.lines.map(l => ({ ...l, class: l.class.replace(/ (ST|DR|RD)$/, '') })) }));
const folded = ctx.group(FOLDED);
ok('folding the class empties every store bucket — so never fold it',
   Object.keys(folded.byStore).length === 0 && folded.unattributed.length === RAW.length);

// ── Prototype keys must not resolve to a store ────────────────────────────────────────────────
const EVIL = [{ id: 'x', date: '2026-08-18', total: 1, account: '',
                lines: [{ class: 'constructor', amount: 1, memo: '' }] }];
const evil = ctx.group(EVIL);
ok('an inherited key like "constructor" is unattributed, not a store',
   Object.keys(evil.byStore).length === 0 && evil.unattributed.length === 1);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* qbBreakdownWalk_ derives what sits BEHIND an Expenses category — the QuickBooks accounts under it
 * and the per-store (QB class) split — from the P&L summarized by Classes. The panel it feeds sits
 * under a total that comes from a DIFFERENT report (the same P&L summarized by Month), so the only
 * property worth asserting is that the two agree. Every way this walk can be wrong produces a
 * believable number on an expanded row, and nobody reconciles an expanded row by hand.
 *
 * The specific bug this was written for, caught by running the walk against the real August report
 * with the HARDCODED map rather than the live one:
 *
 *   a matched section INSIDE a matched section was counted twice.
 *
 * 'COST OF GOODS SOLD' maps to COGS and contains 'PAYROLL EXPENSES' and 'COGS - SUPPLIES &
 * MATERIALS', which map to categories of their own. The walk added the outer summary AND both inner
 * ones: $566,667 of real spend came out as $692,056. walkQBRows_ has always guarded this — it
 * recurses with a null `result` once a summary matches, and its summary branch is wrapped in
 * `if (result)` — and the first version of this walk simply did not copy that guard.
 *
 * It did not fire in production. The live custom mapping happens to contain no nested match, so the
 * live probe tied out perfectly on every window tried. That is exactly why it is worth a test: the
 * mapping UI lets any section be mapped, so this is one custom override away from silently doubling
 * a category, and the screen it feeds would look completely normal.
 *
 * This EXECUTES the shipped qbBreakdownWalk_ out of dutchie_proxy.gs in a vm, together with the real
 * QB_SUMMARY_MAP_ / QB_DETAIL_MAP_, so renaming either map or the function fails the suite rather
 * than quietly falling out of coverage.
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

const SUM_SRC = /const QB_SUMMARY_MAP_ = \{[\s\S]*?\n\};/.exec(GS);
const DET_SRC = /const QB_DETAIL_MAP_ = \{[\s\S]*?\n\};/.exec(GS);
if (!SUM_SRC || !DET_SRC) {
  console.log('QB_SUMMARY_MAP_ / QB_DETAIL_MAP_ are gone from dutchie_proxy.gs');
  console.log('\n0 passed, 1 failed'); process.exit(1);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(SUM_SRC[0] + '\n' + DET_SRC[0] + '\n' + grab(GS, 'qbBreakdownWalk_'), ctx);
ok('qbBreakdownWalk_ and both QB maps load from the shipped source',
   typeof ctx.qbBreakdownWalk_ === 'function');

// ── Fixture helpers — QB's report shape, trimmed to what the walk reads ───────────────────────
const COLS = ['STORE A', 'STORE B', 'TOTAL'];
const cd   = (label, ...nums) => [{ value: label }].concat(nums.map(n => ({ value: String(n) })));
const leaf = (label, a, b) => ({ ColData: cd(label, a, b, a + b) });
const sect = (label, kids, a, b) => ({
  Header:  { ColData: cd(label, '', '', '') },
  Rows:    { Row: kids },
  Summary: { ColData: cd('Total ' + label, a, b, a + b) }
});

const run = (rows) => {
  const out = {};
  ctx.qbBreakdownWalk_(rows, COLS, out, { custom: {}, ignored: new Set() }, 0, null);
  return out;
};
const total = (out, cat) => (out[cat] && out[cat].byClass['TOTAL']) || 0;
const grand = (out) => Object.keys(out).reduce((s, c) => s + total(out, c), 0);

// ── 1. A leaf maps by name, and its class split is kept ──────────────────────────────────────
{
  const out = run([leaf('RENT EXPENSE', 100, 250)]);
  ok('a mapped leaf lands in its category', total(out, 'Rent Expense') === 350);
  ok('the class split survives', out['Rent Expense'].byClass['STORE A'] === 100
                              && out['Rent Expense'].byClass['STORE B'] === 250);
  ok('the account is listed under it', out['Rent Expense'].accounts.length === 1
     && out['Rent Expense'].accounts[0].display === 'RENT EXPENSE');
}

// ── 2. A matched section is the total; its children are LISTED, never re-summed ───────────────
{
  const out = run([sect('INSURANCE EXPENSE', [leaf('GENERAL BUSINESS INSURANCE', 30, 70)], 30, 70)]);
  ok('a matched section carries the category total once', total(out, 'Insurance Expense') === 100);
  ok('its child is listed as an account', out['Insurance Expense'].accounts.length === 1);
  ok('and the child is not counted again', grand(out) === 100);
}

// ── 3. THE REGRESSION — a matched section inside a matched section ────────────────────────────
// This is the live QB tree's actual shape: Cost of Goods Sold wraps COGS - Supplies & Materials
// and Payroll Expenses, and all three are mapped.
{
  const out = run([
    sect('COST OF GOODS SOLD', [
      sect('COGS - SUPPLIES & MATERIALS', [leaf('DISPENSARY SUPPLIES', 10, 15)], 10, 15),
      sect('PAYROLL EXPENSES',            [leaf('WAGES (C)',           60, 90)], 60, 90),
      leaf('5050 PURCHASES - CANNABIS', 100, 200)
    ], 170, 305)
  ]);
  ok('the outer section owns the money exactly once', total(out, 'COGS') === 475);
  ok('the nested matched sections add nothing of their own',
     total(out, 'Payroll Expenses') === 0 && total(out, 'COGS - Supplies & Materials') === 0);
  ok('so the grand total is the section total, not a multiple of it', grand(out) === 475);
  // The pre-fix walk returned 475 + 25 + 150 = 650 here.
  ok('specifically: NOT the 650 the double-counting walk produced', grand(out) !== 650);
  ok('every leaf beneath it is still listed as an account of the outer category',
     out['COGS'].accounts.map(a => a.display).sort().join('|')
       === '5050 PURCHASES - CANNABIS|DISPENSARY SUPPLIES|WAGES (C)');
}

// ── 4. An unmatched section still lets its children map by name ───────────────────────────────
// REPAIRS & MAINTENANCE is deliberately absent from QB_SUMMARY_MAP_ so GENERAL can split off to
// Management while BUILDING stays with Repairs. Guarding the summary must not break that.
{
  const out = run([sect('REPAIRS & MAINTENANCE',
    [leaf('BUILDING', 40, 60), leaf('GENERAL', 5, 15)], 45, 75)]);
  ok('children of an unmapped section map by their own names',
     total(out, 'Repairs & Maintenance') === 100 && total(out, 'Management') === 20);
  ok('and the unmapped section contributes no category of its own', grand(out) === 120);
}

// ── 5. Ignored accounts are excluded, not merely unmapped ─────────────────────────────────────
{
  const out = {};
  ctx.qbBreakdownWalk_([leaf('TRAVEL', 10, 20), leaf('LICENSES', 5, 5)], COLS, out,
                       { custom: {}, ignored: new Set(['TRAVEL']) }, 0, null);
  ok('an ignored leaf is dropped entirely', !out['Travel'] && total(out, 'Licenses') === 10);
}

// ── 6. A custom override beats the hardcoded map, on both leaves and sections ─────────────────
{
  const out = {};
  ctx.qbBreakdownWalk_([leaf('TRAVEL', 10, 20)], COLS, out,
                       { custom: { 'TRAVEL': 'Miscellaneous' }, ignored: new Set() }, 0, null);
  ok('a custom mapping wins over QB_DETAIL_MAP_',
     total(out, 'Miscellaneous') === 30 && !out['Travel']);
}

// ── 7. A repeated display name merges rather than listing twice ───────────────────────────────
{
  const out = run([leaf('SOFTWARE', 10, 10), leaf('SOFTWARE', 5, 5)]);
  ok('a duplicate account name is merged into one row', out['Software'].accounts.length === 1);
  ok('and its amounts are summed, not overwritten', out['Software'].accounts[0].byClass['TOTAL'] === 30);
}

// ── 8. Negative amounts survive — a refund is real money ──────────────────────────────────────
{
  const out = run([leaf('BUILDING', -3000, -3461)]);
  ok('a negative category is kept, not floored at zero', total(out, 'Repairs & Maintenance') === -6461);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

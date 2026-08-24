#!/usr/bin/env node
/* The P&L view renders a FINANCIAL STATEMENT, which is a different promise from the Expenses tab it
 * sits next to. Expenses shows this app's category rollup — QB accounts folded through the mapping
 * sheet, with anything unmapped dropped. That is fine for a budget and fatal for a statement: a P&L
 * that silently omits an account still prints a Net Income, and the number looks right.
 *
 * So the risk here is not "does it throw" — it is "does it quietly disagree with QuickBooks". Two
 * ways that happens, and this file asserts against both:
 *
 *   1. flattenPnlRows_ mis-walks QB's tree. QB nests sections inside sections, carries a section's
 *      own subtotal in a Summary sibling, and emits Gross Profit / Net Income as bare Summary rows
 *      with no header and no children. Confuse the last kind for the first and the statement grows a
 *      phantom section; lose a nesting level and subtotals land under the wrong parent. Neither
 *      shows up as an error — only as arithmetic that no longer ties out.
 *   2. pnlDropEmptyRows (the "hide inactive accounts" toggle, on by default to match QB's PDF)
 *      removes a row that was carrying a number. Hiding must be cosmetic. If a single total moves
 *      between the two toggle states, the toggle is falsifying the statement.
 *
 * Both are checked by running the REAL shipped functions — pulled out of dutchie_proxy.gs and
 * index.html here rather than restated — over a fixture whose shape is copied from a live QuickBooks
 * ProfitAndLoss response (summarize_column_by=Classes). The figures are invented; the STRUCTURE is
 * not, and structure is what these functions are responsible for.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const GS   = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Lift a function body out of the shipped source. A copy pasted in here would keep passing after the
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

const BY_SRC = /const PNL_SUMMARIZE_BY_ = \[[^\]]*\];/.exec(GS);
if (!BY_SRC) { console.log('PNL_SUMMARIZE_BY_ is gone from dutchie_proxy.gs'); console.log('\n0 passed, 1 failed'); process.exit(1); }

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  BY_SRC[0] + '\n' +
  grab(GS,   'flattenPnlRows_',  'dutchie_proxy.gs') + '\n' +
  grab(HTML, 'pnlRowIsEmpty',    'index.html')       + '\n' +
  grab(HTML, 'pnlDropEmptyRows', 'index.html')       + '\n', ctx);
// `const` at the top of a vm script does not become a property of the context object the way a
// function declaration does — read the binding out by evaluating its name.
const SUMMARIZE_BY = vm.runInContext('PNL_SUMMARIZE_BY_', ctx);

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────
// Shape copied from a live ?action=qb_pnl&by=Classes response: two money classes plus TOTAL; an
// Income section with a nested subsection; a COGS section holding one subsection that is entirely
// inactive (the '(deleted)' accounts QB keeps returning and its own PDF omits); an Expenses section
// mixing bare leaves with a nested subsection; and the four computed lines as bare Summaries.
const D = (label, ...v) => ({ ColData: [{ value: label }, ...v.map(x => ({ value: x }))] });
const SEC = (group, header, rows, summary) => {
  const o = { type: 'Section' };
  if (group) o.group = group;
  if (header)  o.Header  = D(...header);
  if (rows)    o.Rows    = { Row: rows };
  if (summary) o.Summary = D(...summary);
  return o;
};

const REPORT = {
  Header: { ReportBasis: 'Cash', Currency: 'USD', SummarizeColumnsBy: 'Classes' },
  Columns: { Column: [{ ColTitle: '' }, { ColTitle: 'RIVER RD' }, { ColTitle: 'CORPORATE' }, { ColTitle: 'TOTAL' }] },
  Rows: { Row: [
    SEC('Income', ['Income', '', '', ''], [
      SEC('', ['PRODUCT SALES', '', '', ''], [
        D('RECREATIONAL', '800.00', '', '800.00'),
        D('MEDICAL',      '200.00', '', '200.00'),
      ], ['Total PRODUCT SALES', '1000.00', '0.00', '1000.00']),
    ], ['Total Income', '1000.00', '0.00', '1000.00']),

    SEC('COGS', ['Cost of Goods Sold', '', '', ''], [
      SEC('', ['COGS - MATERIALS', '', '', ''], [
        D('5000 COGS - CANNABIS', '400.00', '', '400.00'),
      ], ['Total COGS - MATERIALS', '400.00', '0.00', '400.00']),
      // Entirely inactive subsection — QB returns it, QB's PDF does not print it.
      SEC('', ['PURCHASES CLEARING', '', '', ''], [
        D('MARIJUANA FLOWERS (deleted)', '', '', ''),
        D('CBD PRODUCTS (deleted)',      '', '', ''),
      ], ['Total PURCHASES CLEARING', '0.00', '0.00', '0.00']),
    ], ['Total Cost of Goods Sold', '400.00', '0.00', '400.00']),

    SEC('GrossProfit', null, null, ['Gross Profit', '600.00', '0.00', '600.00']),

    SEC('Expenses', ['Expenses', '', '', ''], [
      D('RENT', '100.00', '50.00', '150.00'),
      D('INTEREST EXPENSE', '', '', ''),          // inactive bare leaf
      SEC('', ['TAXES PAID', '', '', ''], [
        D('OR CAT Tax', '25.00', '', '25.00'),
      ], ['Total TAXES PAID', '25.00', '0.00', '25.00']),
    ], ['Total Expenses', '125.00', '50.00', '175.00']),

    SEC('NetOperatingIncome', null, null, ['Net Operating Income', '475.00', '-50.00', '425.00']),

    SEC('OtherExpenses', ['Other Expenses', '', '', ''], [
      D('Ask My Accountant', '5.00', '', '5.00'),
    ], ['Total Other Expenses', '5.00', '0.00', '5.00']),

    SEC('NetOtherIncome', null, null, ['Net Other Income', '-5.00', '0.00', '-5.00']),
    SEC('NetIncome',      null, null, ['Net Income', '470.00', '-50.00', '420.00']),
  ] },
};

const COLS = 3;
const rows = [];
ctx.flattenPnlRows_(REPORT.Rows.Row, COLS, rows, 0);

// ── Assertions ────────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};
const find = (label) => rows.find(r => r.label === label);
const money = (label, col) => { const r = find(label); return r ? r.values[col] : undefined; };

// 1. Every line QB sent survives the walk. A statement may not drop accounts.
ok('all leaf accounts present', rows.filter(r => r.kind === 'detail').length === 9,
   'got ' + rows.filter(r => r.kind === 'detail').length + ' detail rows, want 9');

// 2. The four computed lines are 'grand', not mistaken for sections, and sit at depth 0.
for (const g of ['Gross Profit', 'Net Operating Income', 'Net Other Income', 'Net Income']) {
  const r = find(g);
  ok(g + ' is a grand line', r && r.kind === 'grand' && r.depth === 0,
     r ? ('kind=' + r.kind + ' depth=' + r.depth) : 'missing');
}

// 3. A section's own subtotal is a 'total' at the section header's depth — not the children's.
const tInc = find('Total Income'), hInc = find('Income');
ok('Total Income is a section total at header depth',
   tInc && tInc.kind === 'total' && hInc && tInc.depth === hInc.depth,
   tInc ? ('kind=' + tInc.kind + ' depth=' + tInc.depth) : 'missing');

// 4. Nesting: a subsection's children sit one level deeper than the subsection header.
const hProd = find('PRODUCT SALES'), lRec = find('RECREATIONAL');
ok('nested subsection indents its children',
   hProd && lRec && lRec.depth === hProd.depth + 1,
   hProd && lRec ? (hProd.depth + ' -> ' + lRec.depth) : 'missing');

// 5. Blank ≠ zero. QB prints nothing for an account with no activity in a class; so must we, or a
//    reader cannot tell "no activity" from "netted to zero".
ok('blank cell stays null', money('RECREATIONAL', 1) === null,
   String(money('RECREATIONAL', 1)));
ok('explicit zero stays 0', money('Total PRODUCT SALES', 1) === 0,
   String(money('Total PRODUCT SALES', 1)));

// 6. The statement ties out, per column — the whole reason anyone trusts the page.
for (let c = 0; c < COLS; c++) {
  const v = (l) => money(l, c) || 0;
  ok('col ' + c + ': Income − COGS = Gross Profit',
     Math.abs((v('Total Income') - v('Total Cost of Goods Sold')) - v('Gross Profit')) < 0.005);
  ok('col ' + c + ': Gross Profit − Expenses = Net Operating Income',
     Math.abs((v('Gross Profit') - v('Total Expenses')) - v('Net Operating Income')) < 0.005);
  ok('col ' + c + ': NOI + Net Other Income = Net Income',
     Math.abs((v('Net Operating Income') + v('Net Other Income')) - v('Net Income')) < 0.005);
}

// 7. Hiding inactive accounts is COSMETIC. Every total and grand line must be byte-identical across
//    the toggle, and the wholly-inactive subsection must disappear header-and-total together.
const kept    = ctx.pnlDropEmptyRows(rows);
const keptSet = new Set(kept.map(r => r.kind + '\u0000' + r.label));
const sums    = (list) => list.filter(r => r.kind === 'total' || r.kind === 'grand');

// Every subtotal still on the page carries exactly the figures QB sent...
ok('no surviving total changes value', sums(kept).every(k => {
  const orig = sums(rows).find(r => r.label === k.label);
  return orig && JSON.stringify(orig.values) === JSON.stringify(k.values);
}));
// ...and the only subtotals that left were ones with nothing in them.
ok('every dropped total was empty', sums(rows)
  .filter(r => !keptSet.has(r.kind + '\u0000' + r.label))
  .every(r => ctx.pnlRowIsEmpty(r)));
ok('inactive leaves are hidden', !kept.some(r => /\(deleted\)/.test(r.label)));
ok('inactive bare leaf is hidden', !kept.some(r => r.label === 'INTEREST EXPENSE'));
ok('emptied subsection drops its header', !kept.some(r => r.label === 'PURCHASES CLEARING'));
ok('emptied subsection drops its total',  !kept.some(r => r.label === 'Total PURCHASES CLEARING'));
// ...and a section that still has activity keeps both.
ok('active subsection survives', kept.some(r => r.label === 'TAXES PAID') &&
                                 kept.some(r => r.label === 'Total TAXES PAID'));
ok('grand lines always survive', ['Gross Profit', 'Net Income'].every(l => kept.some(r => r.label === l)));

// 8. `by` is validated against an ARRAY with indexOf, deliberately not an object read by key. This
//    app removed the MAP[value] idiom once already, because it answers for inherited keys too.
for (const bad of ['constructor', '__proto__', 'toString', 'Classes ', 'classes', '', 'Quarter']) {
  ok('rejects by=' + JSON.stringify(bad), SUMMARIZE_BY.indexOf(bad) === -1);
}
for (const good of ['Classes', 'Month', 'Total']) {
  ok('accepts by=' + good, SUMMARIZE_BY.indexOf(good) !== -1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

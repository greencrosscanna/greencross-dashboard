#!/usr/bin/env node
/* Applying a smart budget must never rewrite a month that is already closed.
 *
 * This is the one rule on the budget planner whose violation is completely invisible. Every variance
 * the Expenses tab has shown for January was measured against the budget that stood in January; a
 * quarterly re-cut in September that also rewrites January does not error, does not warn, and does
 * not look different — the tab simply starts drawing a different line, and every earlier reading of
 * it becomes retroactively wrong.
 *
 * Two halves, and both matter:
 *
 *   1. A closed month KEEPS what it already budgeted — the overlay's own figure if the category was
 *      applied before, otherwise the frozen one. Not zero, and not the proposal's number for that
 *      month. The overlay row has to stay a full twelve months because getExpenseBudgets replaces
 *      the whole category row with it, so a partial row would blank every month it left out. That is
 *      the same read-merge-write hazard the GX Core writes have.
 *   2. The window is decided by the SERVER. The client sends figures for the months it believes are
 *      open; a client that is wrong about the date — a stale tab left open overnight into a new
 *      month, a wrong clock — must not be able to reach a closed month by asking nicely.
 *
 * The month IN PROGRESS is closed for this purpose: a partial month cannot be budgeted, which is the
 * same reason sbHistoryWindow_ excludes it from the proposal's history.
 *
 * EXECUTES the shipped applyBudget_ and sbOpenMonths_ out of dutchie_proxy.gs in a vm, against a
 * stubbed PropertiesService, so a rename fails the suite instead of dropping out of coverage.
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

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Harness: the Apps Script globals these two functions touch ────────────────────────────────
function makeCtx(now, stored, frozen) {
  const props = Object.assign({}, stored);
  const ctx = {
    console,
    MONTHS_12_: MONTHS.slice(),
    BUDGET_YEAR: 2026,
    FROZEN_EXPBUD_PROP: 'frozen_expbudgets',
    SMART_BUDGET_PROP: 'smart_budget',
    _out: null,
    jsonOut_: (o) => { ctx._out = o; return o; },
    cacheDelete_: () => {},
    frozenGet_: () => frozen,
    sbGetOverlay_: () => { try { return props.smart_budget ? JSON.parse(props.smart_budget) : null; }
                           catch (e) { return null; } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: (k) => { delete props[k]; }
    }) },
    // Only the two format strings these functions actually use.
    Utilities: { formatDate: (d, tz, f) => {
      const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
      if (f === 'yyyy') return String(y);
      if (f === 'MM')   return m;
      return y + '-' + m + '-' + String(now.getDate()).padStart(2, '0') + 'T00:00:00-07:00';
    } },
    _props: props
  };
  vm.createContext(ctx);
  vm.runInContext(grab(GS, 'sbOpenMonths_') + '\n' + grab(GS, 'applyBudget_'), ctx);
  return ctx;
}
const full = (v) => Object.fromEntries(MONTHS.map(m => [m, v]));

// ── sbOpenMonths_ ─────────────────────────────────────────────────────────────────────────────
{
  const c = makeCtx(new Date(2026, 7, 30), {}, {});   // 30 August 2026
  ok('sbOpenMonths_ loads from the shipped source', typeof c.sbOpenMonths_ === 'function');
  ok('in August only Sep–Dec are open',
     c.sbOpenMonths_(2026).join(',') === 'Sep,Oct,Nov,Dec');
  ok('the month IN PROGRESS is closed — a partial month cannot be budgeted',
     c.sbOpenMonths_(2026).indexOf('Aug') === -1);
  ok('a past year is entirely closed', c.sbOpenMonths_(2025).length === 0);
  ok('a future year is entirely open', c.sbOpenMonths_(2027).length === 12);
  const dec = makeCtx(new Date(2026, 11, 15), {}, {});
  ok('in December nothing is left open this year', dec.sbOpenMonths_(2026).length === 0);
  const jan = makeCtx(new Date(2026, 0, 5), {}, {});
  ok('in January eleven months are open', jan.sbOpenMonths_(2026).join(',') === 'Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec');
}

// ── The closed months keep the FROZEN figure when nothing was applied before ─────────────────
{
  const c = makeCtx(new Date(2026, 7, 30), {}, { Rent: full(1000) });
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Rent: full(9999) }) });
  const row = JSON.parse(c._props.smart_budget).categories.Rent;
  ok('a closed month keeps the budget it already had', row.Jan === 1000 && row.Aug === 1000);
  ok('an open month takes the new figure', row.Sep === 9999 && row.Dec === 9999);
  ok('and the row is still a full twelve months', Object.keys(row).length === 12);
  ok('the response names the window it wrote',
     c._out.open_months.join(',') === 'Sep,Oct,Nov,Dec');
  ok('and names what it preserved rather than staying silent',
     c._out.preserved_months.join(',') === 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug');
}

// ── A previously applied overlay wins over frozen for the closed months ───────────────────────
{
  const prior = JSON.stringify({ year: 2026, categories: { Rent: full(2500) } });
  const c = makeCtx(new Date(2026, 7, 30), { smart_budget: prior }, { Rent: full(1000) });
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Rent: full(7777) }) });
  const row = JSON.parse(c._props.smart_budget).categories.Rent;
  ok('a closed month keeps the OVERLAY figure, not the frozen one', row.Mar === 2500);
  ok('open months still move', row.Oct === 7777);
}

// ── The client cannot reach a closed month by supplying one ──────────────────────────────────
{
  const c = makeCtx(new Date(2026, 7, 30), {}, { Rent: full(1000) });
  // A stale tab that still believes it is January and sends a full-year re-cut.
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Rent: full(5) }) });
  const row = JSON.parse(c._props.smart_budget).categories.Rent;
  ok('a client sending every month still cannot write a closed one', row.Jan === 1000 && row.Jul === 1000);
  ok('only the server-decided window moved', row.Sep === 5);
}

// ── A $0 proposal is a real answer, and must be applyable ────────────────────────────────────
// This is how a stale figure gets retired. The previous behavior skipped an all-zero row, so the
// old number survived by being left alone — which is exactly how an $18,000 Startup Expense stays
// in a budget nobody chose.
{
  const c = makeCtx(new Date(2026, 7, 30), {}, { Startup: full(1500) });
  const zeros = Object.fromEntries(MONTHS.map(m => [m, 0]));
  const r = c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Startup: zeros }) });
  ok('a category zeroed for every open month IS applied', r.ok === true && r.applied.join() === 'Startup');
  const row = JSON.parse(c._props.smart_budget).categories.Startup;
  ok('its open months are genuinely zero', row.Sep === 0 && row.Dec === 0);
  ok('and its closed months are still untouched', row.Jan === 1500);
}

// ── A year with no open month refuses outright ───────────────────────────────────────────────
{
  const c = makeCtx(new Date(2026, 7, 30), {}, {});
  const r = c.applyBudget_({ year: 2025, _user: 'sky', categories: JSON.stringify({ Rent: full(10) }) });
  ok('a closed year refuses rather than writing nothing and reporting success', r.ok === false);
  ok('and says why', /closed/.test(r.error));
  ok('nothing was stored', !c._props.smart_budget);
}

// ── Applying one category never drops another ────────────────────────────────────────────────
{
  const prior = JSON.stringify({ year: 2026, categories: { Rent: full(2500), Travel: full(300) } });
  const c = makeCtx(new Date(2026, 7, 30), { smart_budget: prior }, {});
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Rent: full(9) }) });
  const cats = JSON.parse(c._props.smart_budget).categories;
  ok('a second apply merges rather than replacing', !!cats.Travel && cats.Travel.Jan === 300);
  ok('and the applied category moved', cats.Rent.Sep === 9);
}

// ── A different budget year replaces rather than merging ─────────────────────────────────────
{
  const prior = JSON.stringify({ year: 2025, categories: { Rent: full(2500) } });
  const c = makeCtx(new Date(2026, 7, 30), { smart_budget: prior }, {});
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Travel: full(11) }) });
  const rec = JSON.parse(c._props.smart_budget);
  ok('last year’s overlay is not carried into a new budget year', !rec.categories.Rent);
  ok('and the new year is stamped', rec.year === 2026);
}

// ── Rubbish in a month is refused, not stored ────────────────────────────────────────────────
{
  const c = makeCtx(new Date(2026, 7, 30), {}, {});
  const bad = Object.assign(full(100), { Sep: -5, Oct: 'abc', Nov: null });
  c.applyBudget_({ year: 2026, _user: 'sky', categories: JSON.stringify({ Rent: bad }) });
  const row = JSON.parse(c._props.smart_budget).categories.Rent;
  ok('a negative month becomes 0 rather than a negative budget', row.Sep === 0);
  ok('a non-numeric month becomes 0', row.Oct === 0 && row.Nov === 0);
  ok('a valid open month is kept', row.Dec === 100);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

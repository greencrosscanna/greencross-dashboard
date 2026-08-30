#!/usr/bin/env node
/* The smart budget replaces two things a human was doing badly — "annual ÷ 12" and "$500 sounds
 * right" — with arithmetic. That trade is only worth making if the arithmetic is actually better,
 * and every way it can be worse is SILENT: a proposal is a plausible number no matter how it was
 * reached, so a broken engine ships a budget that looks exactly like a working one.
 *
 * The failures this file is built around, each of which produces a believable wrong answer:
 *
 *   1. A mean instead of a median. One annual insurance premium or one legal bill inside a
 *      twelve-month window moves a mean enough to set the next twelve months wrong, and the result
 *      still looks like a budget. Medians throughout is the design; this asserts the outlier really
 *      is ignored, and that it is REPORTED rather than dropped quietly.
 *   2. The month in progress left in the series. On the 30th, that column holds ~29 days of spend.
 *      Left in, it drags the level and the trend down every time the proposal runs — and the closer
 *      to the 1st you run it, the more wrong it gets. Nothing errors. sbHistoryWindow_ must end on
 *      the last COMPLETE month.
 *   3. A seasonal index that does not average 1. Then applying "seasonality" also changes the annual
 *      total, so the budget quietly inflates or deflates by however far off 1 the average sits.
 *   4. An undamped trend. A 6-vs-6-month growth ratio extrapolated a year forward compounds noise;
 *      a category that happened to double in a good half-year would be budgeted to double again.
 *   5. Guessing for a category with no history — the exact thing Sky asked to stop. A no-data
 *      category must produce NO proposal, not a round number.
 *
 * These run the REAL functions, lifted out of dutchie_proxy.gs rather than restated here, so a
 * rename or a regression fails the suite instead of quietly falling out of coverage.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  PASS ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(GS);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = GS.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < GS.length; j++) {
    if (GS[j] === '{') depth++;
    else if (GS[j] === '}') { depth--; if (!depth) break; }
  }
  return GS.slice(m.index, j + 1);
}

// Constants the engine reads, pulled from source so a retuned value is exercised, not shadowed.
const CONSTS = ['SB_VOLUME_LINKED', 'SB_MIN_SEASONAL', 'SB_MIN_TREND', 'SB_MIN_RATIO', 'SB_MIN_ANY',
                'SB_TREND_DAMP', 'SB_TREND_MIN', 'SB_TREND_MAX', 'SB_LIMIT_FLOOR', 'SB_LOCAL_W', 'SB_SPARSE_ZERO_SHARE', 'SB_SPARSE_EVENT_SHARE']
  .map(n => {
    const m = new RegExp('const ' + n + '\\s*=\\s*([^;]+);').exec(GS);
    if (!m) throw new Error('missing const ' + n);
    // `var`, not `const`: a top-level const in a vm script is lexically scoped and never becomes a
    // property of the context, so ctx.SB_TREND_MAX would read undefined and every comparison
    // against it would silently be NaN — a test that passes by not really asserting.
    return 'var ' + n + ' = ' + m[1] + ';';
  }).join('\n');

const FNS = ['sbMedian_', 'sbMad_', 'sbMean_', 'sbOutlierLimit_', 'sbSplitOutliers_', 'sbCleanSeries_', 'sbParseCol_', 'sbTrendFactor_',
             'sbSeasonalIndex_', 'sbBlankYear_', 'sbProjectSeries_', 'sbSparseProposal_', 'sbBuildProposal_'];

const ctx = {
  console,
  MONTHS_12_: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
};
vm.createContext(ctx);
vm.runInContext(CONSTS + '\n' + FNS.map(grab).join('\n'), ctx);
ok('the engine lifts out of the shipped source and runs', typeof ctx.sbBuildProposal_ === 'function');

const MONTHS = ctx.MONTHS_12_;

// ── 1. Medians, not means — the lumpy-category case ───────────────────────────────────────────
console.log('\n1. one anomalous month must not set the year');
{
  // Eleven months at ~1000, one legal bill of 40000.
  const vals = [1000,1020,980,1010,990,1000,1030,970,1000,1010,990,40000];
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
  const med  = ctx.sbMedian_(vals);
  ok('the median sits with the typical month (~1000), the mean does not', med > 950 && med < 1050);
  ok('...and the mean is more than 3x the median — the trap is real', mean > med * 3);

  const split = ctx.sbSplitOutliers_(vals);
  ok('the 40000 month is set aside as an outlier', split.outliers.length === 1 && split.outliers[0] === 40000);
  ok('...and the other eleven are kept', split.kept.length === 11);
}
{
  // A perfectly flat category (rent). MAD is 0; nothing may be called an outlier, or a steady
  // category loses months to a rule meant for lumpy ones.
  const flat = new Array(12).fill(7500);
  const split = ctx.sbSplitOutliers_(flat);
  ok('a flat series keeps every month (MAD 0 must not exclude everything)', split.outliers.length === 0 && split.kept.length === 12);
}

// ── 2. Seasonal index is normalised ───────────────────────────────────────────────────────────
console.log('\n2. seasonality redistributes the year, it must not resize it');
{
  // A strongly seasonal series: summer triple the winter, two full years.
  const series = [];
  for (let yr = 2024; yr <= 2025; yr++)
    for (let mo = 0; mo < 12; mo++)
      series.push({ mo, yr, v: (mo >= 5 && mo <= 7) ? 3000 : 1000 });

  const idx = ctx.sbSeasonalIndex_(series);
  const avg = idx.reduce((a,b)=>a+b,0) / 12;
  ok('the index averages 1 (so the annual total is preserved)', Math.abs(avg - 1) < 1e-9);
  ok('summer indexes above winter', idx[6] > idx[0]);

  const proj = ctx.sbProjectSeries_(series, 2026);
  ok('June is budgeted well above January', proj.monthly.Jun > proj.monthly.Jan * 2);
  ok('...and January is not budgeted at zero', proj.monthly.Jan > 0);
}
{
  // Fewer than 12 months: the engine must NOT claim a seasonal shape.
  const series = [];
  for (let mo = 0; mo < 8; mo++) series.push({ mo, yr: 2026, v: mo < 4 ? 500 : 1500 });
  const proj = ctx.sbProjectSeries_(series, 2026);
  const uniq = new Set(MONTHS.map(m => proj.monthly[m]));
  ok('under SB_MIN_SEASONAL months of history the months are held FLAT, not shaped', uniq.size === 1);
}

// ── 3. Trend is damped and clamped ────────────────────────────────────────────────────────────
console.log('\n3. a trend must not compound into next year');
{
  // Doubling over the last six months.
  const series = [];
  for (let i = 0; i < 6;  i++) series.push({ mo: i,       yr: 2025, v: 1000 });
  for (let i = 0; i < 6;  i++) series.push({ mo: i + 6,   yr: 2025, v: 2000 });
  const t = ctx.sbTrendFactor_(series);
  ok('a raw 2.0x growth is damped below 2.0', t < 2.0);
  ok('...and clamped at SB_TREND_MAX', t <= ctx.SB_TREND_MAX + 1e-9);
  ok('...but still reads as growth, not held at 1', t > 1);
}
{
  // Collapsing spend — the clamp must hold on the downside too, or a budget goes to near zero.
  const series = [];
  for (let i = 0; i < 6; i++) series.push({ mo: i,     yr: 2025, v: 5000 });
  for (let i = 0; i < 6; i++) series.push({ mo: i + 6, yr: 2025, v: 100 });
  const t = ctx.sbTrendFactor_(series);
  ok('a collapse is clamped at SB_TREND_MIN, not extrapolated to zero', t >= ctx.SB_TREND_MIN - 1e-9);
}
{
  const flat = [];
  for (let i = 0; i < 12; i++) flat.push({ mo: i % 12, yr: 2025, v: 1000 });
  ok('a flat series has trend exactly 1', ctx.sbTrendFactor_(flat) === 1);
  ok('too short a series has trend exactly 1 rather than a guess',
     ctx.sbTrendFactor_([{mo:0,yr:2025,v:1},{mo:1,yr:2025,v:9}]) === 1);
}

// ── 4. Column parsing ─────────────────────────────────────────────────────────────────────────
console.log('\n4. month columns parse, everything else is refused');
{
  ok("'Aug 2026' parses to month 7 of 2026",
     ctx.sbParseCol_('Aug 2026').mo === 7 && ctx.sbParseCol_('Aug 2026').yr === 2026);
  ok("'Total' is refused — it must never enter a series", ctx.sbParseCol_('Total') === null);
  ok('an empty column title is refused', ctx.sbParseCol_('') === null);
  ok('a bogus month name is refused, not folded to 0', ctx.sbParseCol_('Xyz 2026') === null);
}

// ── 5. The whole proposal, over a realistic history ───────────────────────────────────────────
console.log('\n5. end to end — the refusal, the ratio, and the seasonal shape together');
{
  const columns = [];
  for (let yr = 2024; yr <= 2025; yr++) for (let mo = 0; mo < 12; mo++) columns.push(MONTHS[mo] + ' ' + yr);
  columns.push('Total');

  const income = {}, expenses = { 'COGS': {}, 'Rent Expense': {}, 'Advertising & Promotion': {}, 'Startup Expense': {} };
  columns.forEach(c => {
    const p = ctx.sbParseCol_(c);
    if (!p) { income[c] = 0; Object.keys(expenses).forEach(k => expenses[k][c] = 0); return; }
    const summer = p.mo >= 5 && p.mo <= 7;
    income[c] = summer ? 900000 : 600000;
    expenses['COGS'][c] = income[c] * 0.42;                       // a clean 42% of revenue
    expenses['Rent Expense'][c] = 50000;                          // fixed
    expenses['Advertising & Promotion'][c] = summer ? 30000 : 10000;
    expenses['Startup Expense'][c] = 0;                           // never spent → must get NO proposal
  });
  // One anomalous legal-style spike inside Rent, to prove the outlier path runs end to end.
  expenses['Rent Expense']['Mar 2025'] = 400000;

  const built = ctx.sbBuildProposal_(2026, { columns, expenses, income });
  const by = {};
  built.proposals.forEach(p => by[p.category] = p);

  ok('every category comes back', built.proposals.length === 4);

  // 5a. The refusal — the headline requirement.
  const su = by['Startup Expense'];
  ok('a category with NO spend gets no proposal at all', su.monthly === null && su.annual === null);
  ok('...its confidence is "none", not "low"', su.confidence === 'none');
  ok('...and it says why, rather than showing a number', /nothing to derive/i.test(su.note));

  // 5b. COGS as a ratio to revenue.
  const cogs = by['COGS'];
  ok('COGS is modelled as a % of revenue, not from its own level', cogs.method === 'pct_of_revenue');
  ok('...at ~42%', Math.abs(cogs.basis.ratio_pct - 42) < 0.6);
  ok('...and its budget follows revenue: June above January',
     cogs.monthly.Jun > cogs.monthly.Jan);

  // 5c. Rent — fixed, and the spike excluded.
  const rent = by['Rent Expense'];
  ok('Rent excludes the one 400k spike', rent.basis.outliers_excluded >= 1);
  ok('...and lands near the true 50k/mo, not dragged up by it',
     rent.monthly.Jan > 40000 && rent.monthly.Jan < 62000);
  const meanRent = 50000 + (400000 - 50000) / 24;
  ok('...where a mean would have been visibly higher', rent.monthly.Jan < meanRent);

  // 5d. Advertising — genuinely seasonal, and it should say so.
  const adv = by['Advertising & Promotion'];
  ok('Advertising is recognised as seasonal with 24 months behind it',
     adv.method === 'seasonal_trend' && adv.confidence === 'high');
  ok('...and budgets summer above winter', adv.monthly.Jul > adv.monthly.Feb * 1.5);

  // 5e. Sorting and totals.
  const annuals = built.proposals.map(p => p.annual || 0);
  ok('proposals are ordered biggest-first', annuals.every((v, i) => i === 0 || annuals[i-1] >= v));
  ok('every proposed month is a non-negative finite number',
     built.proposals.filter(p => p.monthly).every(p =>
       MONTHS.every(m => Number.isFinite(p.monthly[m]) && p.monthly[m] >= 0)));
}

// ── 5f. A budget has to TOTAL correctly ───────────────────────────────────────────────────────
// This is the property that forced level/index off medians and onto means over the CLEANED series.
// For a category that runs 10k for nine months and 30k for three, the median month is 10k, and
// twelve of those under-budget the year by 20% — a shortfall that shows up as an overspend every
// summer, in a budget nobody can see is wrong by construction.
console.log('\n5f. a steady-state category is budgeted to its own annual run-rate');
{
  const series = [];
  for (let yr = 2024; yr <= 2025; yr++)
    for (let mo = 0; mo < 12; mo++)
      series.push({ mo, yr, v: (mo >= 5 && mo <= 7) ? 30000 : 10000 });

  const actualAnnual = 9 * 10000 + 3 * 30000;             // 180,000
  const proj   = ctx.sbProjectSeries_(series, 2026);
  const annual = MONTHS.reduce((a, m) => a + proj.monthly[m], 0);

  ok('the proposed annual matches the historical annual within 1%',
     Math.abs(annual - actualAnnual) / actualAnnual < 0.01);
  ok('...whereas 12 x the median month would have under-budgeted it by ~20%',
     Math.abs(12 * 10000 - actualAnnual) / actualAnnual > 0.15);
  ok('...and the shape is kept: a summer month is ~3x a winter month',
     Math.abs(proj.monthly.Jul / proj.monthly.Feb - 3) < 0.15);
  ok('...with no month winsorized — a recurring peak is not an anomaly',
     proj.outliers === 0);
}

// ── 5g. A one-off inside a seasonal category hits only itself ─────────────────────────────────
// The two rules have to coexist: the spike is removed, the season survives. Getting one right at
// the cost of the other is how this engine would most plausibly ship broken.
console.log('\n5g. a one-off and a real season in the same series');
{
  const series = [];
  for (let yr = 2024; yr <= 2025; yr++)
    for (let mo = 0; mo < 12; mo++)
      series.push({ mo, yr, v: (mo >= 5 && mo <= 7) ? 30000 : 10000 });
  const spikeAt = series.findIndex(p => p.mo === 10 && p.yr === 2025);   // one odd November
  series[spikeAt].v = 250000;

  const cleaned = ctx.sbCleanSeries_(series);
  ok('the lone November spike is winsorized', cleaned.replaced === 1);
  ok('...and the six recurring summer months are NOT',
     cleaned.series.filter(p => p.mo >= 5 && p.mo <= 7).every(p => p.v === 30000));

  const proj = ctx.sbProjectSeries_(series, 2026);
  ok('November is budgeted like a normal month, not at 250k', proj.monthly.Nov < 20000);
  ok('...and summer still outruns winter', proj.monthly.Jul > proj.monthly.Feb * 2);
}

// ── 5h. A LEVEL SHIFT is not a pile of outliers ───────────────────────────────────────────────
// The real Rent Expense series is what exposed this. It runs ~38-42k through 2024/early 2025 and
// ~44k after, with three true anomalies mixed in: a partial first month, a double payment, and a
// skipped month. The first version of the cleaner called 10 of 23 months outliers — seven of which
// were just the old, lower rent — and only landed on the right annual by luck.
//
// The failure that hides behind that mislabelling is the one that matters: a RECENT step up (a new
// lease, a new store) is exactly what a budget must capture, and winsorizing to the window median
// erases it, quietly budgeting next year at last year's rent.
console.log('\n5h. a level shift is kept; only true anomalies are removed');
{
  const v = [5951, 41996, 37766, 41381, 73762, 38381, 38381, 39200, 0, 44939, 43918, 43918,
             43918, 43918, 43918, 44503, 44503, 43524, 46087, 44126, 44126, 44126, 44126, 44126];
  const series = v.map((val, i) => ({ mo: (7 + i) % 12, yr: 2024 + Math.floor((7 + i) / 12), v: val }));

  const cleaned = ctx.sbCleanSeries_(series);
  ok('exactly the three true anomalies are flagged, not half the series', cleaned.replaced === 3);
  ok('...the partial first month is one of them', cleaned.series[0].v !== 5951);
  ok('...so is the double payment', cleaned.series[4].v !== 73762);
  ok('...and so is the zero month', cleaned.series[8].v !== 0);
  ok('...but the old, lower 2024 rent is KEPT as a real level, not erased',
     cleaned.series[2].v === 37766 && cleaned.series[5].v === 38381);

  // The current run rate is 44,126.84/mo -> ~529,522/yr. The proposal must land there, not on the
  // 24-month average of two different rent regimes (~42k -> ~505k, low by 4.5%).
  const proj   = ctx.sbProjectSeries_(series, 2026);
  const annual = MONTHS.reduce((a, m) => a + proj.monthly[m], 0);
  ok('the annual lands on the CURRENT rent, within 3%', Math.abs(annual - 529522) / 529522 < 0.03);
  ok('...and not on the whole-window average, which is materially lower',
     annual > 12 * 42500);
}

// A step up in the LAST few months must survive rather than be flattened back to the old level.
{
  const v = new Array(21).fill(44000).concat([60000, 60000, 60000]);
  const series = v.map((val, i) => ({ mo: (7 + i) % 12, yr: 2024 + Math.floor((7 + i) / 12), v: val }));
  const cleaned = ctx.sbCleanSeries_(series);
  ok('a recent step UP is not winsorized away',
     cleaned.replaced === 0 && cleaned.series.slice(-3).every(p => p.v === 60000));
  const proj = ctx.sbProjectSeries_(series, 2026);
  ok('...and it lifts the budget above the old level', proj.monthly.Jan > 44000);
}

// ── 5i. Sparse categories get a RATE, never a confident zero ──────────────────────────────────
// Both of these are real 24-month series from the live QuickBooks data, and both came out wrong
// before this path existed. Meals & Entertainment has spend in 12 of 24 months; with the median at
// zero, every month that DID spend read as an outlier, cleaning replaced each with the surrounding
// zeros, and the category was budgeted at $0/yr against $7,014 of actual spend — while reporting
// "11 outliers excluded". A confident zero is the worst answer available here: it reads as a
// decision someone made.
console.log('\n5i. a mostly-empty category is budgeted at its run rate, not at zero');
{
  const meals = [133,0,108,0,1706,13,0,113,949,135,0,0,941,0,0,853,0,1533,0,50,0,0,480,0];
  const series = meals.map((v,i) => ({ mo:(7+i)%12, yr:2024+Math.floor((7+i)/12), v }));
  const p = ctx.sbSparseProposal_('Meals & Entertainment', series, 24);
  const total = meals.reduce((a,b)=>a+b,0);   // 7,014

  ok('it is NOT budgeted at zero', p.annual > 0);
  ok('...it is the run rate: total/24, twelve times', Math.abs(p.annual - total/2) < 12);
  ok('...flat, with no seasonal claim', new Set(MONTHS.map(m=>p.monthly[m])).size === 1);
  ok('...method says run_rate and confidence is low', p.method === 'run_rate' && p.confidence === 'low');
  ok('...and the note says why rather than presenting it as analysis', /no typical month/i.test(p.note));
  ok('...no month is called an outlier — the busy months are real spend',
     p.basis.one_off_excluded === 0);
}
{
  // Miscellaneous: 94% of the window is ONE $26,915 month. That is an event, not a rate, and must
  // not become a recurring budget line.
  const misc = [0,0,31,0,26915,0,0,0,0,-207,17,-20,24,-24,0,0,0,14,960,283,0,175,325,52];
  const series = misc.map((v,i) => ({ mo:(7+i)%12, yr:2024+Math.floor((7+i)/12), v }));
  const p = ctx.sbSparseProposal_('Miscellaneous', series, 24);
  ok('the one-off is set aside', p.basis.one_off_excluded === 1 && p.basis.one_off_amount === 26915);
  ok('...so the budget reflects the ordinary months, not the event', p.annual < 1500);
  ok('...but is still above zero — the ordinary months are real', p.annual > 0);
  ok('...and the note names the amount that was set aside', /26,915/.test(p.note));
}
{
  // A negative-heavy or empty series must not produce a negative budget.
  const series = new Array(24).fill(0).map((_,i)=>({mo:(7+i)%12, yr:2024+Math.floor((7+i)/12), v: i===3?-500:0}));
  const p = ctx.sbSparseProposal_('Refunds', series, 24);
  ok('a net-negative sparse category floors at zero, never negative',
     MONTHS.every(m => p.monthly[m] >= 0));
}
{
  // The routing itself: a sparse category must not reach the seasonal path.
  const columns = [];
  for (let yr = 2024; yr <= 2025; yr++) for (let mo = 0; mo < 12; mo++) columns.push(MONTHS[mo] + ' ' + yr);
  const income = {}, expenses = { 'Meals & Entertainment': {} };
  const meals = [133,0,108,0,1706,13,0,113,949,135,0,0,941,0,0,853,0,1533,0,50,0,0,480,0];
  columns.forEach((c,i) => { income[c] = 600000; expenses['Meals & Entertainment'][c] = meals[i]; });
  const built = ctx.sbBuildProposal_(2026, { columns, expenses, income });
  const row = built.proposals[0];
  ok('sbBuildProposal_ routes a sparse category to the run-rate path', row.method === 'run_rate');
  ok('...and it is not zero', row.annual > 0);
}

// ── 6. The history window ends on the last COMPLETE month ─────────────────────────────────────
console.log('\n6. the month in progress is excluded from history');
{
  // sbHistoryWindow_ uses Utilities.formatDate; stub it the way the runtime behaves so the real
  // date arithmetic is exercised rather than replaced.
  const wctx = {
    console,
    Utilities: { formatDate: (d, tz, fmt) => {
      const p = n => String(n).padStart(2, '0');
      if (fmt === 'yyyy') return String(d.getFullYear());
      if (fmt === 'MM')   return p(d.getMonth() + 1);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    } },
    Date: class extends Date {
      constructor(...a) { if (!a.length) super(2026, 7, 30); else super(...a); }   // "today" = Aug 30 2026
    },
  };
  vm.createContext(wctx);
  vm.runInContext(grab('sbHistoryWindow_'), wctx);
  const w = wctx.sbHistoryWindow_();
  ok('on Aug 30, history ENDS Jul 31 — August is excluded', w.end === '2026-07-31');
  ok('...and starts 24 complete months earlier', w.start === '2024-08-01');
  ok('...giving a whole number of months, not a ragged window', /-01$/.test(w.start));
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

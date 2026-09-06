#!/usr/bin/env node
/* The month goal resolves through THREE sources — frozen period goals, then lbGoals, then the
 * budget spreadsheet — and pgDaily is empty at first paint because loadPeriodGoalRange is still in
 * flight. So the hero painted the BUDGET figure and replaced it with the period goal a moment
 * later. Measured on May 2026 that is $685,702 becoming $742,625, and Portland Rd $65,638 becoming
 * $92,073 (+40%). Reported by Sky as "it shows a number that is more realistic, then the number
 * changes and is much higher".
 *
 * Nothing was recalculating — the second number was always the intended one. But a figure that
 * changes under the reader is worse than one that arrives a beat late, so the goal now shimmers
 * until the authoritative source has ANSWERED.
 *
 * The subtle part, and what this file mostly guards: "asked" and "answered" are different states.
 * pgLoaded is added to BEFORE the await (so render() cannot loop on the fetch), so it only ever
 * means asked. Resolution needs its own set — and every exit path must reach it, including the
 * ones where GX Core legitimately has NO periods for the range. Miss one and that view shimmers
 * forever instead of falling back to the budget line, which is a worse bug than the flicker.
 */
'use strict';
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function grab(name) {
  const re = new RegExp('(?:async )?function ' + name + '\\s*\\(');
  const m = re.exec(HTML);
  if (!m) return null;
  let i = HTML.indexOf('{', m.index), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

console.log('\n1. asked and answered are tracked separately');
{
  ok('pgResolved exists alongside pgLoaded', /let pgResolved = new Set\(\)/.test(HTML));
  const pred = grab('goalPending');
  ok('goalPending() is defined', !!pred);
  ok('...and it asks pgResolved, not pgLoaded — pgLoaded only means "asked"',
     pred && /pgResolved\.has/.test(pred) && !/pgLoaded\.has/.test(pred));
  ok('...keyed on the ACTIVE view range, so switching months re-arms it',
     pred && /activeGoalRange\(\)/.test(pred));
}

console.log('\n2. every exit path resolves, or the view shimmers forever');
{
  const fn = grab('loadPeriodGoalRange');
  ok('loadPeriodGoalRange is present', !!fn);
  const adds = (fn.match(/pgResolved\.add\(key\)/g) || []).length;
  ok('...it resolves on at least three paths (bad shape, success, failure)', adds >= 3);
  ok('...the "no usable periods" early return resolves before returning',
     /!Array\.isArray\(data\.periods\)\s*\)\s*\{[^}]*pgResolved\.add\(key\)/.test(fn));
  ok('...the catch resolves too, so a dead fetch falls back instead of hanging',
     /catch[\s\S]*pgResolved\.add\(key\)/.test(fn));
  // The clear is CONDITIONAL on rows arriving; the render must not be. Assert that ordering
  // directly rather than by exact spacing, so a reformat doesn't fail a correct implementation.
  const clearIdx  = fn.indexOf('if (added) _pgTotalMemo.clear()');
  const renderIdx = fn.indexOf('render();', clearIdx);
  ok('...and render() runs even when NOTHING was added, so the shimmer clears',
     clearIdx > 0 && renderIdx > clearIdx && !/if \(added\)[\s\S]{0,40}render\(\)/.test(fn));
}

console.log('\n3. the goal is what waits — never the sales figure');
{
  const hero = grab('_incomeHeroInnerHtml');
  ok('the hero has a pending branch', /o\.goalWait/.test(hero));
  // The whole point: net sales is already final and must paint immediately.
  const pendingBranch = hero.slice(hero.indexOf('if (o.goalWait)'), hero.indexOf('return `\n    <div class="ic-hero-top">', hero.indexOf('if (o.goalWait)')) + 900);
  ok('...and it still prints the net sales value while waiting', /ic-hero-val">\$\{fmtK\(net\)\}/.test(pendingBranch));
  ok('...with a placeholder where the goal goes', /bd-skel/.test(pendingBranch));

  const proj = grab('_incomeProjCardHtml');
  ok('the projection card takes the flag', /function _incomeProjCardHtml\([^)]*goalWait\)/.test(proj));
  ok('...and shims rather than dividing by a goal it does not have yet',
     /if \(goalWait\)[\s\S]{0,220}val-skel/.test(proj));
}

console.log('\n4. the flag is actually threaded through every call site');
{
  // Exclude the declaration — it takes `opts`, not `goalWait`, and matching it here made this
  // assertion fail against correct code.
  const heroCalls = (HTML.match(/(?<!function )_incomeHeroInnerHtml\(net, periodGoal/g) || []).length;
  const heroWith  = (HTML.match(/(?<!function )_incomeHeroInnerHtml\(net, periodGoal[^)]*goalWait/g) || []).length;
  ok(`all ${heroCalls} hero call sites pass goalWait`, heroCalls > 0 && heroCalls === heroWith);

  const projCalls = (HTML.match(/(?<!function )_incomeProjCardHtml\(net, periodGoal/g) || []).length;
  // Not `goalWait\)` — since v2.571 the projection also shims on dataWait (no store has answered
  // at all yet), so the call sites read `goalWait || dataWait`. What this pins is that goalWait
  // still reaches every one of them, which is the same assertion it always made.
  const projWith  = (HTML.match(/(?<!function )_incomeProjCardHtml\(net, periodGoal[^)]*goalWait/g) || []).length;
  ok(`all ${projCalls} projection call sites pass goalWait`, projCalls > 0 && projCalls === projWith);
  ok('goalWait is computed in renderIncome', /const goalWait\s*=\s*goalPending\(\)/.test(HTML));
}

console.log('\n5. a logout clears the resolution state with the rest of the goals');
{
  ok('pgResolved is cleared alongside lbGoals', /lbGoals\s*=\s*null;[\s\S]{0,200}pgResolved\.clear\(\)/.test(HTML));
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/* A class name in the markup that NO stylesheet defines is invisible to every check this repo has.
 * The page renders, nothing throws, no test fails — the element just quietly falls back to the
 * browser's default look. That is how `.pill-btn` survived: it was never defined anywhere, so the
 * P&L's "Try again" and the Expenses tab's "Save Mappings" primary CTA had been rendering as raw
 * gray browser buttons, in an app whose whole point is looking like the rest of the suite.
 *
 * It is the same shape of bug as a lookup miss: the name resolves to nothing, and nothing is not an
 * error. So this asserts that every class the page puts in a `class="..."` attribute is defined —
 * either here, or in one of the gx-theme stylesheets this app loads by URL.
 *
 * Shared `gx-*` classes are exempted by prefix rather than by list: they live in gx-theme, which is
 * a different repo, and hard-coding its contents here would go stale the day it changes.
 */
'use strict';
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

// Every class this page defines — and it defines them in TWO places, which is the thing that made
// the first version of this test cry wolf about fourteen classes that were perfectly fine.
//
//   1. <style> blocks.
//   2. CSS built as a JS STRING and injected with createElement('style'). The What's New modal does
//      exactly this, concatenating one rule per line. A test that only reads <style> declares every
//      one of those classes an orphan while the page renders them correctly.
//
// So: <style> blocks, plus any string literal that looks like a CSS rule (a .selector followed by a
// brace). A string literal that shape is not something you write by accident.
const styleBlocks = (HTML.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []).join('\n');
const injected = (HTML.match(/'[^'\n]*'|"[^"\n]*"/g) || [])
  .filter(lit => /\.[A-Za-z][\w-]*\s*[,{]/.test(lit) && lit.includes('}'))
  .join('\n');
const css = styleBlocks + '\n' + injected;
const defined = new Set();
for (const m of css.matchAll(/\.([A-Za-z][\w-]*)/g)) defined.add(m[1]);
ok('found the stylesheet and its class definitions', defined.size > 50);
ok('found CSS injected from JS strings too, not just <style>',
   defined.has('wn-modal') && defined.has('wn-rel-ver'));

// Every class actually used in markup. Template-literal class attributes carry ${...} expressions;
// strip those before splitting so an interpolation is never mistaken for a class name.
const used = new Map();   // class -> a sample of the line it appeared on
const lines = HTML.split('\n');
for (let i = 0; i < lines.length; i++) {
  for (const m of lines[i].matchAll(/class="([^"]*)"/g)) {
    // An interpolation can be GLUED to a class name, and the two cases mean opposite things:
    //
    //   `rev-mo-btn${on ? ' on' : ''}`  -> the stem IS a real class; the interpolation adds another
    //   `recon-${state}`                -> the stem is a FRAGMENT; the real name is computed
    //
    // Telling them apart is what makes this test useful rather than merely loud. Mark the
    // interpolation, keep the stem before it, and treat a stem ending in - or _ as a fragment and
    // skip it. Guessing at a computed name is how a test starts lying.
    const cleaned = m[1].replace(/\$\{[^}]*\}/g, '\u0000');
    for (const raw of cleaned.split(/\s+/)) {
      const c = raw.split('\u0000')[0];
      if (!c || /[-_]$/.test(c)) continue;
      if (/^[A-Za-z][\w-]*$/.test(c) && !used.has(c)) used.set(c, i + 1);
    }
  }
}
ok('found the classes the markup uses', used.size > 30);

// Loaded from gx-theme by URL — a different repo, so exempt by prefix, not by an enumerated list
// that would go stale the moment gx-theme changes.
const SHARED = /^(gx-|is-|has-)/;
// Set by script at runtime rather than styled here.
const RUNTIME = new Set(['spinner-inline']);

// The baseline is EMPTY, and that is the point — it exists so a real orphan can be quarantined
// while it is investigated, never so one can be hidden. It was populated with 19 names the day this
// test was written; all 19 are now resolved rather than tolerated:
//
//   14 wn-* were never orphans at all. The What's New modal injects its CSS from a JS string, and
//      the first version of this test only read <style> blocks. The TEST was wrong, not the app.
//    5 were genuinely dead — ic-dsk-bd-wrap, rev-machine-hdr, store-pill-name, tnav-pill, wtab.
//      Each sat beside a class that does the styling (card, rev-machine, store-pill, mtab), none
//      was read by any selector or any querySelector, and ic-dsk-bd is targeted by ID. They were
//      removed from the markup rather than given rules: inventing styling for a name nobody styled
//      would have CHANGED how the page looks, which is not what fixing an orphan means.
//
// Anything added here needs the same treatment — a reason, and a way out.
const KNOWN_ORPHANS = new Set([]);

const orphans = [...used.entries()]
  .filter(([c]) => !defined.has(c) && !SHARED.test(c) && !RUNTIME.has(c) && !KNOWN_ORPHANS.has(c))
  .sort((a, b) => a[0].localeCompare(b[0]));

// A baselined name that has since been defined should come OFF the list, or the baseline rots into
// a place where real orphans hide.
const stale = [...KNOWN_ORPHANS].filter(c => defined.has(c) || !used.has(c)).sort();
ok('the baseline holds no stale entries' + (stale.length ? ' — remove: ' + stale.join(', ') : ''),
   stale.length === 0);

ok('every class used in markup is defined somewhere'
   + (orphans.length ? ' — ORPHANS: ' + orphans.map(([c, l]) => `${c} (line ${l})`).join(', ') : ''),
   orphans.length === 0);

// The specific regression: .pill-btn was used nine times and defined never.
ok('pill-btn is gone — it was never a real class', !used.has('pill-btn'));

// The Reconcile tab's controls use the app's own button idioms rather than inventing new ones:
// .s-btn for actions, .rev-mo-btn/.on for state toggles, .s-btn.primary for a card's main action.
for (const c of ['s-btn', 'rev-mo-btn', 'toggle-btn']) {
  ok(`${c} is defined and in use`, defined.has(c) && used.has(c));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

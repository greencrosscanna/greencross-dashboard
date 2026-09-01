#!/usr/bin/env node
/* THE GATE MUST ACCEPT THE NAMES THE FRONTEND ACTUALLY SENDS.
 *
 * index.html asks the proxy for one store at a time — `?store=River` — using its own internal
 * names. dutchie_proxy.gs decides whether that name is a store at all, in knownStore_, and anything
 * it refuses comes back as "Unknown store: X". A refused store is not an error the reader sees: the
 * status grid marks it red, the pill says 5/6, and every figure on every tab is quietly short one
 * store. The company reads a smaller number and nothing says why.
 *
 * That is exactly what happened on 2026-08-31. The store vocabulary used to be the KEYS of this
 * app's own Dutchie credential map — Sales' internal names, `River` among them. Moving the keys
 * into GX Core replaced the list with the registry's `dutchie_name` values. Five of six stores are
 * spelled identically in both, so five kept working; River Rd is the one store whose two names
 * differ, and it went blank on every load.
 *
 * The lesson is not "remember River". It is that the two lists are maintained in different repos by
 * different people and NOTHING compared them. This test compares them: every name in index.html's
 * STORES array is run through the SHIPPED knownStore_ against a registry that spells things the way
 * GX Core does. It executes the real function rather than restating the rule, so renaming or
 * re-tightening the gate fails here instead of in production.
 *
 * The prototype guard is asserted alongside, because the fix widens the gate and that is precisely
 * when an inherited name ('constructor', 'toString') sneaks back through — the reason the exact
 * array test replaced `if (MAP[store])` in the first place.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const GS   = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

// ── The frontend's side: the names index.html will actually put on the wire ────────────────────
const STORES_SRC = /const STORES = \[[\s\S]*?\];/.exec(HTML);
if (!STORES_SRC) { console.log('STORES is gone from index.html'); console.log('\n0 passed, 1 failed'); process.exit(1); }
const fctx = {}; vm.createContext(fctx);
vm.runInContext(STORES_SRC[0] + '; var NAMES = STORES.map(function(s){return s.name;});', fctx);
const FRONTEND = fctx.NAMES;

ok('index.html still declares six stores', FRONTEND.length === 6);

// ── The registry's side: GX Core's `dutchie_name` spellings, and how it folds a name to a store_id.
// Measured 2026-08-31 from the live app (?action=storekeys) and from GX Core's own dutchie_get,
// which resolved BOTH `River` and `River Rd` to store_id `river-rd`.
const REGISTRY = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River Rd'];
const FOLD = {              // what GXCore.resolveStore answers, for the names this test asks about
  'bend': 'bend', 'center': 'center', 'commercial': 'commercial', 'hillsboro': 'hillsboro',
  'portland rd': 'portland-rd', 'portland': 'portland-rd',
  'river rd': 'river-rd', 'river': 'river-rd',
};

const ctx = {
  console,
  GXCore: {
    resolveStore(name) {
      // Deliberately a null-prototype lookup with an own-property check: the real registry cannot
      // answer for an inherited name either, and a plain object here would hand the gate a function
      // and hide the very regression this test exists to catch.
      const k = String(name).trim().toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(FOLD, k)) return null;
      return { store_id: FOLD[k], dutchie_name: name };
    },
  },
};
vm.createContext(ctx);
vm.runInContext('function gxStoreNames_(){ return ' + JSON.stringify(REGISTRY) + '; }', ctx);
vm.runInContext(grab(GS, 'gxStoreIds_') + '\nlet _gxStoreIds_ = null;', ctx);
// gxStoreIds_ is declared with `let _gxStoreIds_` above its own body in the source; re-run the
// declaration first so the hoisting order inside the vm matches the file's.
vm.runInContext('_gxStoreIds_ = null;', ctx);
vm.runInContext(grab(GS, 'knownStore_'), ctx);

// ── Every store the frontend asks for must pass ────────────────────────────────────────────────
FRONTEND.forEach(name => {
  ok('the gate accepts "' + name + '" — the name index.html sends', ctx.knownStore_(name) === true);
});

// The specific one that broke, called out so a future rename cannot quietly retire the coverage.
ok('"River" passes even though the registry spells it "River Rd"', ctx.knownStore_('River') === true);
ok('"River Rd" — the registry spelling — still passes too', ctx.knownStore_('River Rd') === true);
ok('the two spellings are NOT the same string, which is the whole hazard',
   FRONTEND.indexOf('River') !== -1 && REGISTRY.indexOf('River') === -1);

// ── and nothing else may ───────────────────────────────────────────────────────────────────────
['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'].forEach(n => {
  ok('an inherited name is refused: ' + n, ctx.knownStore_(n) === false);
});
ok('an unknown store is refused', ctx.knownStore_('Springfield') === false);
ok('an empty name is refused', ctx.knownStore_('') === false);

// An alias the registry folds onto one of our six is fine — that is the whole point of asking the
// registry instead of matching strings. What must not pass is a name that folds to a store_id the
// registry does not list, which is the direction a widened gate goes wrong.
ok('a registry ALIAS of a real store is accepted ("Portland" → portland-rd)',
   ctx.knownStore_('Portland') === true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

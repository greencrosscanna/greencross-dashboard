#!/usr/bin/env node
/* ─── a calendar day is never derived from UTC ───────────────────────────────────────────────────
 *   RUN:  node tests/date_convention_test.js   (also run by the pre-push hook via gx-preflight.sh)
 *
 * THE CONVENTION: "A calendar day is Los Angeles; an instant is UTC."
 *
 * `.toISOString()` is UTC regardless of anything — the browser's zone, the Apps Script project's
 * zone, the machine's. Truncated to ten characters it becomes a calendar day, and from 17:00 PT to
 * midnight (seven hours of every day, eight in winter) that day is TOMORROW.
 *
 * WHAT IT COST HERE, found 2026-09-03: three sites derived a day from a CLOCK READING. The 28-day
 * gross-margin window asked the engine for a range ending tomorrow, and the rolling cutoff it is
 * compared against excluded a day of real sales — every evening, with no error and no visible
 * symptom beyond numbers being slightly off. That is the whole hazard: this bug never announces
 * itself, it just quietly reports the wrong figure to someone deciding something.
 *
 * WHAT IS FINE, and deliberately not flagged:
 *   Date.parse(d + 'T12:00:00Z') stepped by 86400000, read back with .toISOString()
 *   new Date(Date.UTC(y, m, d)) with .setUTCDate()
 *       Both are CONSTRUCTED in UTC from calendar components, so reading them back in UTC returns
 *       the day they were built from. Round-trips exactly; the standard idiom for date-only
 *       arithmetic, and this app uses it correctly in three places.
 *   plain .toISOString() with no truncation — an INSTANT, where UTC is the right answer.
 *
 * THE CORRECT HELPERS in index.html, and which question each answers:
 *   laDay() / laDaysAgo(n) — "what day is it where the stores are", via Intl in America/Los_Angeles
 *   ymdLocal(d)            — "what day does this Date represent", read from the components it was
 *                            built from, with no UTC round trip
 *
 * ymdLocal replaced eight sites that were CORRECT BY ACCIDENT OF GEOGRAPHY. A Date built as
 * new Date(y, m, d) is local midnight, which in LA is 07:00 or 08:00Z — still the same UTC calendar
 * day, so the old code happened to be right, and only because the offset is negative. The same code
 * in a browser set to UTC+1 reads the previous day for every date on a chart. Being right for a
 * reason nobody wrote down is not the same as being right.
 *
 * ESCAPE HATCH:  @utc-ok <reason>  on the line. The reason is required — a bare marker is refused
 * below, because an exemption nobody had to justify is how a rule erodes.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const TRUNCATED = /\.toISOString\(\)\s*\.\s*(?:slice|substring)\s*\(\s*0\s*,\s*10\s*\)|\.toISOString\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/;
const ROUNDTRIP = /Date\.UTC\s*\(|\.setUTC[A-Za-z]+\s*\(|['"]T\d{2}:\d{2}:\d{2}Z['"]/;
const LOOKBACK  = 4;

/* Blank out comments before matching, keeping line numbers intact. Not optional: this file's own
   header quotes the bad pattern in order to explain it, and index.html now carries a long comment
   doing the same. A gate that reports its own documentation as a defect teaches people to skim it. */
function decomment(src) {
  let inBlock = false;
  return src.split('\n').map(line => {
    let out = '', i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        inBlock = false; i = end + 2; continue;
      }
      if (line[i] === '/' && line[i + 1] === '*') { inBlock = true; i += 2; continue; }
      if (line[i] === '/' && line[i + 1] === '/') break;
      out += line[i]; i++;
    }
    return out;
  });
}

function offenders(file) {
  const out = [];
  const src = fs.readFileSync(file, 'utf8');
  const raw = src.split('\n');
  const code = decomment(src);
  code.forEach((c, i) => {
    if (!TRUNCATED.test(c)) return;
    if (ROUNDTRIP.test(c)) return;                       // built and read on the same line
    /* The construction may sit a few lines above the read. Look back — but ONLY for the identifier
       actually being read. A blanket window scan is worse than no lookback: it would swallow a real
       offender sitting under an unrelated Date.UTC, a false negative in the one gate meant to catch
       this class. (Borrowed wholesale from the hub's version, which learned it the hard way.) */
    const recv = /([A-Za-z_$][\w$]*)\s*\.\s*toISOString\s*\(\)/.exec(c);
    if (recv) {
      /* \b matters, and its absence is a live false NEGATIVE in the hub's copy. Without it the
         name `d` matches inside `const end = …`, because "end" ends in a d — so a read of `d` was
         excused by an unrelated line that merely happened to contain 'T12:00:00Z'. Found here
         2026-09-03: index.html:1886 passed for that reason rather than on its merits. A gate that
         clears code by coincidence is worse than one that flags it, because nobody looks again. */
      const name  = recv[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const built = new RegExp('\\b' + name + '\\s*(?:=[^=]|\\.setUTC)');
      if (code.slice(Math.max(0, i - LOOKBACK), i).some(l => built.test(l) && ROUNDTRIP.test(l))) return;
    }
    if (/@utc-ok\s+\S/.test(raw[i])) return;             // exempted WITH a reason
    if (/@utc-ok\s*$/.test(raw[i])) { out.push({ line: i + 1, text: raw[i].trim(), bare: true }); return; }
    out.push({ line: i + 1, text: raw[i].trim() });
  });
  return out;
}

console.log('1. the detector catches the real shapes and spares the correct ones');
{
  const tmp = path.join(os.tmpdir(), 'gx-sales-datecheck-' + process.pid + '.js');
  fs.writeFileSync(tmp, [
    "const a = new Date().toISOString().slice(0, 10);",                          // 1 wrong
    "const b = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);",// 2 wrong
    "const c = cell.toISOString().split('T')[0];",                               // 3 wrong
    "const d = new Date(Date.UTC(y, m, dd)).toISOString().slice(0, 10);",        // fine, same line
    "const e = new Date(Date.parse(s + 'T12:00:00Z'));",
    "const f = e.toISOString().slice(0, 10);",                                   // fine, lookback
    "const g = new Date();",
    "const h = g.toISOString().slice(0, 10);",                                   // 4 wrong — lookback must NOT save it
    "const i2 = new Date().toISOString();",                                      // fine, an instant
    "const j = new Date().toISOString().slice(0, 10);   // @utc-ok compared only to other UTC days",
    "const k = new Date().toISOString().slice(0, 10);   // @utc-ok",             // 5 wrong — bare marker
    "// const l = new Date().toISOString().slice(0, 10);",                       // fine, a comment
    "const end = Date.parse(s + 'T12:00:00Z');",
    "const d = new Date(now);",
    "const m = d.toISOString().slice(0, 10);",                                   // 6 wrong — see \\b below
  ].join('\n'));
  const found = offenders(tmp);
  fs.unlinkSync(tmp);
  const lines = found.map(f => f.line);
  ok(lines.includes(1) && lines.includes(2) && lines.includes(3), 'flags the three clock-derived shapes');
  ok(lines.includes(8), 'lookback does not excuse a plain new Date() built above the read');
  ok(!lines.includes(4) && !lines.includes(6), 'spares a UTC round trip, same line and via lookback');
  ok(!lines.includes(9), 'spares an untruncated instant');
  ok(!lines.includes(10), 'honors @utc-ok WITH a reason');
  ok(found.some(f => f.line === 11 && f.bare), 'refuses a bare @utc-ok carrying no reason');
  ok(!lines.includes(12), 'ignores the pattern inside a comment');
  /* The \b regression guard: `d` must not be excused by `const end = …` on a nearby line just
     because "end" ends in a d and that line carries a UTC literal. */
  ok(lines.includes(15), 'an identifier is matched whole — "end" does not stand in for "d"');
  ok(found.length === 6, 'exactly six offenders in the fixture, no more');
}

console.log('\n2. the shipped source is clean');
{
  const files = ['index.html', 'dutchie_proxy.gs']
    .map(f => path.join(ROOT, f)).filter(fs.existsSync);
  ok(files.length >= 1, 'found the source files to check');
  for (const f of files) {
    const bad = offenders(f);
    if (bad.length) {
      console.log('       ' + path.basename(f) + ':');
      bad.forEach(b => console.log('         :' + b.line + '  ' + b.text.slice(0, 100)
                                  + (b.bare ? '     <- @utc-ok needs a reason' : '')));
    }
    ok(bad.length === 0, path.basename(f) + ' derives no calendar day from UTC');
  }
}

console.log('\n3. the helpers exist and answer the two different questions');
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/function laDay\s*\(/.test(src) && /America\/Los_Angeles/.test(src),
     'laDay() derives today in America/Los_Angeles, not the browser zone');
  ok(/en-CA/.test(src), 'it uses the en-CA locale, which formats as YYYY-MM-DD');
  ok(/function laDaysAgo\s*\(/.test(src), 'laDaysAgo(n) exists for window edges');
  ok(/function ymdLocal\s*\(/.test(src), 'ymdLocal(d) exists for reading a Date built locally');
  ok(!/ymdLocal[\s\S]{0,200}toISOString/.test(src.slice(src.indexOf('function ymdLocal'))),
     'ymdLocal does NOT round trip through UTC — it reads the components directly');

  /* The three sites the audit found genuinely wrong. Named, so a revert is loud rather than a
     silent return to "correct except in the evening". */
  ok(/const to   = laDay\(\);/.test(src),        'the gross-margin window ends on an LA day');
  ok(/const from = laDaysAgo\(28\);/.test(src),  'the gross-margin window starts on an LA day');
  ok(/const cutoff28  = laDaysAgo\(28\);/.test(src), 'the rolling 28-day cutoff is an LA day');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

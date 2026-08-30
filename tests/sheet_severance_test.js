#!/usr/bin/env node
/* This app is DISCONNECTED from the legacy "2026 GX2 Dashboard" workbook (Sky's call, 2026-08-30).
 * Everything it used to read now lives in this script's own properties: frozen_goals,
 * frozen_expbudgets, frozen_qbmapping, otherrev_data and rev_atm_*, with expense budgets
 * superseded by the smart budget.
 *
 * A severance is not a one-time edit, it is an invariant — and this one is unusually easy to undo
 * by accident, because reaching for a spreadsheet is a one-liner and the workbook still exists. So
 * this asserts the ABSENCE: no SpreadsheetApp call, no workbook id, no sheet gids. If a future
 * session needs data from that file, it has to notice this test and make the case for it, rather
 * than adding "just one quick read" that quietly grows the dependency back.
 *
 * The scopes are deliberately NOT asserted. The manifest still requests `spreadsheets`, and it must:
 * an Apps Script library runs under the CALLING project's authorization, and GXCore reads the GX
 * Core spreadsheet for period goals and roleForApp. Dropping that scope would sever GX Core along
 * with the budget sheet — including the fail-closed write guard, which would then refuse every
 * write. Severing the workbook and keeping the scope is the correct end state, not an oversight.
 */
'use strict';
const fs = require('fs'), path = require('path');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

// Strip comments so the prose above (and in the source) can name the thing without tripping the test.
const code = GS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n1. the workbook is unreachable from this script');
{
  ok('no SpreadsheetApp call anywhere in the proxy', !/SpreadsheetApp\s*\./.test(code));
  ok('the workbook id is gone from executable code', !/1OBNzkBrJtLIlf8xknVlGd6Jb8nlkg4_KG-Gq6BD7HHY/.test(code));
  ok('BUDGET_SHEET_ID is no longer a constant', !/const\s+BUDGET_SHEET_ID/.test(code));
  ok('the sheet gids are gone too', !/const\s+(BUDGET_SHEET_GID|ATM_SHEET_GID|SUBLET_SHEET_GID)/.test(code));
  ok('ATM_SHEET_CONFIG_ is gone', !/ATM_SHEET_CONFIG_/.test(code));
}

console.log('\n2. the readers that used the sheet now read properties');
{
  ok('frozenGet_ exists', /function frozenGet_/.test(code));
  for (const p of ['FROZEN_GOALS_PROP', 'FROZEN_EXPBUD_PROP', 'FROZEN_QBMAP_PROP']) {
    ok(`${p} is defined`, new RegExp('const\\s+' + p).test(code));
  }
  ok('getGoals reads the frozen snapshot', /function getGoals\(\)[\s\S]{0,700}frozenGet_\(FROZEN_GOALS_PROP\)/.test(code));
  ok('getExpenseBudgets reads the frozen snapshot', /function getExpenseBudgets\(\)[\s\S]{0,900}frozenGet_\(FROZEN_EXPBUD_PROP\)/.test(code));
  ok('...and still overlays the applied smart budget on top',
     /function getExpenseBudgets\(\)[\s\S]{0,1400}sbGetOverlay_\(\)/.test(code));
  ok('getQBMappingSheet reads the frozen snapshot', /function getQBMappingSheet\(\)[\s\S]{0,400}frozenGet_\(FROZEN_QBMAP_PROP\)/.test(code));
}

console.log('\n3. the sheet-reading helpers are gone, not merely unused');
{
  for (const fn of ['getSheetPreview', 'bootstrapAtmFromSheet_', 'freezeReadGoals_',
                    'freezeReadExpBudgets_', 'freezeReadQbMap_', 'freezeSheet_']) {
    ok(`${fn} is removed`, !new RegExp('function\\s+' + fn + '\\s*\\(').test(code));
  }
  ok('the sheetpreview route is gone with its handler', !/action === 'sheetpreview'/.test(code));
  ok('the freeze_sheet route is gone with its handler', !/action === 'freeze_sheet'/.test(code));
}

console.log('\n4. what remains is read-only status, which touches no sheet');
{
  ok('freezestatus survives', /action === 'freezestatus'/.test(code));
  ok('...and it is secret-gated', /action === 'freezestatus'[\s\S]{0,300}GX_DEPLOY_SECRET/.test(code));
  ok('freezeStatus_ reads only properties', /function freezeStatus_[\s\S]{0,900}getProperty/.test(code)
     && !/function freezeStatus_[\s\S]{0,900}SpreadsheetApp/.test(code));
}

console.log('\n5. nothing silently falls back to a spreadsheet');
{
  ok('getOtherRevData_ no longer bootstraps from a sheet',
     /function getOtherRevData_[\s\S]{0,900}/.test(code) && !/function getOtherRevData_[\s\S]{0,900}SpreadsheetApp/.test(code));
  ok('BUDGET_YEAR survives — the frozen goals are still tagged with their year',
     /const\s+BUDGET_YEAR/.test(code));
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

# Sales / Cashflow (app key `sales`) — GX app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app is being integrated with it. Owner: **Sky** — Shawn is a USER of this app, not its
owner (corrected by Sky 2026-08-20; the shared brain's app-owner list still says otherwise). Backend:
`dutchie_proxy.gs` (Dutchie + QuickBooks proxy). Frontend: `index.html`, deployed via **GitHub Pages**. Its
app key in GX Core is **`sales`**.

## Stack & local loop

**No build step — the file on disk IS the app.**

| | |
|---|---|
| frontend | `index.html` — a **monolith with inline JS**, on GitHub Pages |
| backend | `dutchie_proxy.gs` — the Dutchie **and QuickBooks** proxy, deployed with clasp |
| version | the **`APP_VERSION` constant** in `index.html` (no `?v=` cache-buster — there's no external `.js`) |
| run | `python3 serve.py` → <http://localhost:3000> |
| ship | commit → push (Pages) → `./deploy.sh` records the release to `version_history` |
| tests | `tests/*_test.js` — 10 suites, run by the **pre-push hook** via `gx-preflight.sh`; a failure blocks the push. Also verify live with the `gxpin` / `authprobe` routes below |

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed — which matters more
here than elsewhere, since this app's writes now run through a fail-closed auth guard. `gx-preflight.sh`
runs as a **pre-push hook** and refuses dev leftovers — and it also runs every `tests/*_test.js`, so a
failing test blocks the push exactly like a dev leftover does.

**Run them yourself with `ls tests/*_test.js | xargs -n1 node`.** Seven of the nine read this repo's real
`index.html` / `dutchie_proxy.gs` — none of them tests a copy, which is what stops coverage rotting
silently. Five EXECUTE the shipped source: `pnl_statement`, `deposit_reconciliation`, `pacing_staleness`
and `qb_deposits_shape` `grab()` named functions out of the file and run them in a `vm` context, and
`write_guard` rebuilds them with `new Function` — so a renamed function fails the suite instead of quietly
falling out of coverage. The other two, `orphan_css_classes` and `dev_guard_actions`, analyse the source
text rather than running it. `.claude/gx-posttool-tests.sh` reruns all of them after every edit to those
two files, which is why a broken edit surfaces mid-session instead of at push time.

What they cover, before you assume a change is untested: `orphan_css_classes` (every class used in the
markup is defined, and every class defined is used), `pnl_statement` (the P&L build **and** the store-pill
state machine), `deposit_reconciliation`, `write_guard` (the auth guard's log / enforce / off modes),
`dev_guard_actions` (every `action=` the app fetches is declared in `GX_DEV_READS`, so a new read cannot
break localhost only), `pacing_staleness` (the two-clock bug — `paceFracs` going stale against a live
poll), `qb_deposits_shape`.

**Two of the nine are wrappers, and they SKIP — not fail — when `greencross-command-center` is not a
sibling checkout.** `cross_app_contract` (the Leaderboard → Sales goal payload) and `store_palette_drift`
(this app's hardcoded store palette against the hub's) both live canonically in the hub, because they span
repos and neither side owns them. On a lone clone you get 8 suites, not 10, and the output says `SKIP` —
read it, don't assume green means covered.

*Corrected 2026-08-25: this row previously read "no automated suite — verify with the `gxpin` /
`authprobe` routes". There were 9 suites behind two hooks at the time it said that. A doc that tells a
session there is nothing to run invites skipping a gate that works: on the period-selector change,
`orphan_css_classes` caught dead `.dsk-pfield`/`.dsk-chip` rules left mid-refactor and `pnl_statement`
caught `refreshCompare` being undefined in the pill handlers. Both would have shipped.*

**Shared files** (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from
**gx-theme** via `./gx-sync.sh`, filled from `.gx_app`. Edit them **there**, then re-sync. This CLAUDE.md is
intentionally **not** synced.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=sales`, resolves done ones (`resolve_note`), and writes
note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

Integration status: app key **`sales`**; deploys clasp (backend) + GitHub Pages (frontend). ✅ shared login
(Phase-2), ✅ auto-record (`deploy_version`), ✅ changelog from `version_history`, ✅ gx-theme, ✅ bug
forwarding (`gxIngestBug` in `reportBug_`) — verified 2026-08-20: real 🐞 reports from this app are on Core's
board with reporter/tab/app_version filled in. Fully integrated; no seam left open.

**Verify the `GXCore` pin by asking the live app, never by reading the repo.** A `GXCore.x()` call runs the
snapshot of the version this app PINS, and a deployment snapshots the manifest — so `appsscript.json` at HEAD
and `gx_core.gs` as it reads today both tell you nothing about what the running app has. Re-pinning is two
steps and the second is the one people skip: set the version, then **deploy**. Then measure:

```
curl -sL -G "<sales /exec>" --data-urlencode action=gxpin --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

`gxpin` returns `GXCore.libVersion()` from the live deployment plus `qb.last_source`, which names the
connector that served the last uncached Expenses load. A `Forbidden` here is a finding, not a route bug:
it means `GX_DEPLOY_SECRET` is unset or stale on this script, and that same property gates
`qbReportViaGXCore_`.

**The legacy local QuickBooks path was REMOVED 2026-08-24** (`qbReportLocal_`, `getQBAccessToken_`,
`exchangeQBCode`, the `qbaccounts` route and the two editor debug fns — ~180 lines). Sales no longer reads
`QB_REFRESH_TOKEN`/`QB_CLIENT_*`/`QB_REALM_ID` at all; the only `QB_` property left is the `QB_LAST_SOURCE`
diagnostic. **GX Core is now the sole QuickBooks token owner by construction, not by convention** — the
invalid_grant desync is no longer a thing that can happen here, so don't re-add a "temporary" local
fallback. `qbProfitAndLoss_` now THROWS when Core is unreachable instead of quietly serving numbers from
somewhere else; a broken Expenses tab is the intended failure, and it is strictly better than the silent
one that hid the misnamed-secret regression for an unknown stretch. `last_source` can now only read
`gxcore@…`; the field stays because it is what made that regression visible, and `null` (nothing has
missed cache yet) is still meaningfully different from a stale timestamp.

**Reconcile counts the Dutchie sales banking and nothing else — by MEMO, not by arithmetic.**
`reconIsSalesDeposit` reads the QuickBooks memo, because the tab answers one question: did this
store bank what it SOLD that week. A `Printer Ink (refund)` line classed to Portland Rd is real
money and not that. Everything it rejects goes to the **not included in a store's week** list with
its amount and memo showing — never dropped, and it survives reconciling the week.

The vocabulary is **measured, not guessed** — `?action=reconprobe&start=…&end=…` reports it. Over
2026-05-25..08-31 the live route gave **103** store-classed deposits: 102 carrying all five of
`Sales 3% Tax` · `Sales 17% Tax` · `Med Sales` · `Rec Sales` · `Non MJ Sales`, one
`Printer Ink (refund)`, one `Report does not match`.

Two things about that rule are load-bearing and easy to "simplify" into a bug:

- **ANY sales line qualifies, not ALL of them.** `Report does not match` is not a deposit — it is a
  SIXTH line on a real Commercial banking, someone's annotation, and it is what Commercial's
  `max_lines_folded: 6` is. An all-lines rule throws a genuine week's banking onto the not-included
  list.
- **A memo naming `sales` or `tax` also counts**, beyond the exact five. Exact-match-only is a bad
  single point of failure: rename a QuickBooks category and EVERY deposit becomes non-sales at once,
  so every week silently reads nothing banked. Both known outliers name neither word. A deposit with
  **no** memo is not counted — no memo is not positive evidence of sales — but it lands on the
  not-included list with its amount visible rather than silently joining a week.

*This replaced an earlier rule that inferred strays by finding a subset of a week's deposits that
tied to the expected figure exactly. Don't go back to it: it only works on a week that TIES, and
most weeks do not — measured on Shawn's 08.17.26 slips, five of six stores carried a variance. It
also had to refuse whenever two subsets both hit the number, and be switched off entirely on an
incomplete week. Classifying a deposit by what it IS needs none of that.*

**`reconData` carries the range it was fetched for.** It used to be a bare global that only reloaded
when null, so changing the period drew the OLD range's deposits against the NEW period's week
windows until someone hit Refresh — a wrong answer, not just friction. `reconDataStale_` compares
the two and the render reloads on a mismatch; visited ranges come back from a 30-minute client cache.
Failures are deliberately never cached, but ARE tagged with their range so an error renders once
instead of re-fetching forever.

**The pacing section renders ALL six stores from the first frame — don't filter it back down.**
`_storeBreakdownRows` deliberately does *not* filter to `liveData[s]`. A store with no data yet is a
row carrying its name, its bar track and shimmer placeholders, so the card is **245px at every
stage** — nothing loaded, half loaded, fully loaded. Filtering meant six height changes per load,
and `loadAllStores` clears `liveData` before refetching, so a re-poll tore the list down and rebuilt
it under the reader. It also made a straggler *invisible*: a store that never answered had no row,
which reads as "no such store" rather than "still waiting".

Sorting is the other half and breaks the same way if touched. **Sort only when every store has
landed**, remember that order in `_bdOrder`, and reuse it while anything is pending — that is what
makes a re-poll refresh numbers in place instead of reshuffling. Sorting by value while values are
still arriving is precisely what makes rows jump.

**`getCogsDutchie` is cached at the proxy — leave it that way.** It was the only route the Income tab
touches with no server-side cache, and the most expensive: six `getSalesDaily` reads plus **six live
`dutchieClosingReport` calls, one per store, in sequence**. The Gross Profit card waits on it, which
is why that card was always the last to fill in. Cached by range: 10 min while today is in the
window, 6 hours once the range is settled. The client key `inv_gm2_<today-28>` rotates daily by
design; its TTL used to resolve through `CACHE_TTL['inv']`, *a key that did not exist*, to the 1-hour
default — so a phone re-triggered twelve backend calls hourly.

**A stale tab now says so.** `gcCheckVersion` compares `APP_VERSION` against the newest row in GX
Core `version_history` and offers a cache-busting reload. It never reloads on its own, is suppressed
while signed out and for a version already dismissed or already attempted (Pages can serve a stale
copy for a minute after `deploy.sh` records the release — without that guard the reload loops).
There is no `?v=` cache-buster to check instead: this is a monolith with inline JS, so the HTML *is*
the bundle.

*When GX Core's two-hop flakes it can return a TRUNCATED body, which fails JSON parsing as an
"invalid control character" mid-string. That is the documented ~6% flake, not malformed output —
**retry until it parses**, and don't reach for a lenient parser, which turns a cut-off payload into
one you'll treat as complete.*

**The write guard is LIVE BUT DARK — don't mistake it for enforcing.** All four writes
(`save_expense_mapping` GET+POST, `set_otherrev`, `set_revenue`, `clear_atm_cache`) call `writeGuard_`,
which asks `GXCore.roleForApp(user, 'sales')` and **records what it would have decided without acting on
it**. Mode is the `GX_WRITE_GUARD` script property: `log` (default) · `enforce` · `off`.

Read the decisions, never infer them:

```
curl -sL -G "<sales /exec>" --data-urlencode action=authprobe --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

`write_guard_log` is a capped ring of the last 25 decisions, recording **admits as well as refusals** —
deliberately, because "refuses the bad" and "admits the good" are two different assertions and only the
second one licenses flipping to `enforce`.

**Do not flip to `enforce` until the log shows a real NON-SUPERADMIN user ADMITTED.** Probed on live v170,
`roleForApp` returned a role for exactly one account — `sky`, who is also the account that deploys.
Everyone else came back null, **including Shawn — because he has not been granted access in GX Core yet**
(confirmed by Sky 2026-08-20). That is the true answer, not a lookup miss and not the local-fallback theory
that was current when the guard was built. Shawn is a user of this app, not its owner; Sky owns it.

**ENFORCING since 2026-08-20.** `GX_WRITE_GUARD` = `enforce`, flipped by Sky's explicit instruction after
the admit test below passed. Reads unaffected; unauthenticated and forged-token writes are still refused at
the session gate ABOVE the guard, so a signature failure never reaches the grant lookup. **Roll back in one
command:** the same `guardmode` call with `mode=log`.

**Now pinned to GXCore v223** (2026-08-25, from v220; deployment `AKfycbzju5He…@176`). Two re-pins the
same day, and the second one is the one that finished the job — see the store-key entry below. Verified
live after the redeploy: `?action=libversion` → `{"ok":true,"gxcore":223}` six consecutive reads (no
warm-instance lag this time), `gxpin` → `gxcore_version 223` with `qb.last_source` still `gxcore@…`,
`authprobe&user=shawn` → `role editor` / `write_guard_mode enforce`, `pnlprobe` → `qb_source gxcore` with
all three P&L identities balancing, and `goalprobe&date=2026-03-05` → **all six stores** on
`2026-03-02..2026-03-15`: River 70711 · Bend 63205 · Hillsboro 36663 · Portland Rd 41500 · Center 23223 ·
Commercial 89177.

**Superseded — kept for the reasoning.** Pinned to GXCore v220 (2026-08-25, from v213; deployment
`AKfycbzju5He…@175`). The reason was
`getPeriodGoals`: through v218 it returned `match[0]` — the first matching row in SHEET ORDER — and GX
Core held both the stale and the corrected DST pay-period rows, with the stale ones earlier in the sheet.
Every date from 2026-01-05 to 2026-03-15 resolved here to a period that never existed; March carried a
14-day goal total over a 15-day window. Verified live after the redeploy: `?action=libversion` →
`{"ok":true,"gxcore":220}` five consecutive reads, `gxpin` → `gxcore_version 220`,
`authprobe&user=shawn` → `role editor` / `has_roleForApp true` / `write_guard_mode enforce`, and
`goalprobe&date=2026-03-05` → `2026-03-02..2026-03-15`. A `pnlprobe` in the same window returned
`qb_source: gxcore` with all three P&L identities balancing, so the QuickBooks-through-Core path is
healthy on this pin too.

**`action=goalprobe` — secret-gated, added 2026-08-25.** `getPeriodGoalsForDate_` sits behind the login
gate, so proving a re-pin resolves dates to the right pay period used to mean opening a browser and
logging in. Same trick and same reasoning as `pnlprobe`/`reconprobe`: read-only, runs the real path in
the live runtime, returns exactly what the app would render.
`?action=goalprobe&date=YYYY-MM-DD&secret=…`.

**FIXED in GXCore v223 — the story is worth keeping, because the bug was invisible by construction.**
Through v220, `GXCore.getPeriodGoals` matched the store with exact `gxSlug_` equality, but the
`period_goals` tab is keyed by **alias**: the rows are `baseline`, `center`, `century`, `commercial`,
`portland`, `river`. `getPeriodGoalsForDate_` asks with Dutchie names, so only `Center` and `Commercial`
hit — and **only because for those two the canonical id and the alias happen to be the same word.**
`Bend`→`bend` vs row `century`, `Hillsboro`→`hillsboro` vs `baseline`, `Portland Rd`→`portland-rd` vs
`portland`, `River Rd`→`river-rd` vs `river` all returned null, and the `catch(e2)` in that loop makes a
lookup miss indistinguishable from a store with no goals. Four of six stores silently had no period goals
for as long as the tab had been keyed that way. Found here 2026-08-25 while verifying the v220 re-pin,
raised as `note_mt99ji06_9as`, fixed in **v223** — `getPeriodGoals` now resolves BOTH sides through
`gxResolveStore_`, additively (`store` stays as the sheet holds it, canonical `store_id` alongside), and
an unknown store still returns null rather than guessing at a neighbour.

**The lesson, not the incident:** the fix belonged in Core and the workaround belonged nowhere. A
store-alias table in this repo would have made Sales look correct while four stores kept paying for a
Core bug that Leaderboard cannot see either — it reads `getPeriodGoals` with an EMPTY store and never
reaches that comparison. `never hardcode stores` is not only about Command Center edits flowing through.

*One claim in that note was wrong and core-admin corrected it: **`expectedSalesFrac` does NOT share the
assumption.** It delegates to `getHourlyShape` (`gx_dutchie.gs`), which already calls `gxResolveStore_`
and carries a comment naming this exact scenario. `getPacingFracs_` is fine as written, and
`getPeriodGoals` was the lone holdout rather than one instance of a pattern.*

**`goalprobe` is what made this findable, and it is now a discriminating test.** Before the fix it
returned two stores; after, six. Re-run it after any GXCore re-pin — a pin that reports the right version
and still returns two stores is a different failure from one that never took.

**Superseded — kept for the history.** Pinned to GXCore v213 (2026-08-23, from v204; deployment
`AKfycbzju5He…@160`). The reason was the
shared bug reporter: on v204 `gxIngestBug` does **not** self-install the `bug_reports.context` header, so
every 🐞 filed from Sales silently lost its state snapshot while still returning `ok`. Sales was filing
half-reports until this landed. Verified live on the deployed `/exec`: `?action=libversion` →
`{"ok":true,"gxcore":213}`, eight consecutive reads.

**Two cautions were attached to that re-pin. Both are now DISCHARGED — 2026-08-24:**

- **~~The admit check was NOT re-run~~ — RUN 2026-08-24, and it PASSES on the hand-typed path.**
  `authprobe&user=shawn` under v213 returns `role_for_user {"user":"shawn","role":"editor"}`, with
  `has_roleForApp true`, `gxcore_version 213` and `write_guard_mode enforce`. So the nine-version crossing
  did not break `roleForApp`, which was the fear — `writeGuard_` fails CLOSED, so a Core-side break would
  have looked exactly like an outage.
  **CLOSED 2026-08-24 on Sky's word: Shawn has saved under v213 several times, so the token-derived
  path is exercised and this caution is spent.** Rollback is unchanged and one command:
  `guardmode&mode=log`.

  One footnote, deliberately not an open item: `write_guard_log` was showing only three admits, all
  v194-era, with nothing after the v213 re-pin — so it is probably not capturing every write. **Sky's
  call (2026-08-24): don't track this.** The guard enforces and admits correctly in practice, which is
  what matters. Don't cite the log as proof of an admit, don't read its silence as a problem, and don't
  re-open this on your own — if it ever bites, Sky will raise it.
- **~~`gxpin` itself was not read~~ — READ AND CLEAN 2026-08-24.** It returns
  `{"gxcore_version":213,"qb":{"secret_configured":true,"last_source":"gxcore@2026-08-24T23:32:08Z"}}`.
  So `GX_DEPLOY_SECRET` is set on this script and the connector that actually served the last uncached
  Expenses load was **GX Core, not the legacy local QuickBooks token** — the silent-fallback hazard this
  bullet was raised about is not present. That reading, holding across four days and the v153 → v213
  re-pin, is what licensed **deleting** the local path outright on 2026-08-24 (see above). Re-check after
  any deploy that touches script properties; a `Forbidden` here is the finding.

**`gxengine.sh` — FIXED 2026-08-24, safe to use again.** It used to pick the highest `@version` among
non-HEAD deployments, and this script has a stray `AKfycbxDmCB_…@159` that outranked the one every caller
actually uses (`AKfycbzju5He…`, hardcoded as `DEFAULT_PROXY` in `index.html`) — so `--deploy` would push
to HEAD, redeploy the stray, and report success while the live `/exec` kept serving the old snapshot.
core-admin fixed it in gx-theme; `./gx-sync.sh` pulled it here. It now matches deployment ids against the
ones this repo's own source references, and **stops** rather than guessing when it cannot tell
(`GX_DEPLOY_ID=` overrides). Verified by running it: it resolves `AKfycbzju5He…@161`, *"referenced by this
repo's source"*. The by-hand path still works if you want it: `clasp push --force` then
`clasp update-deployment AKfycbzju5He…`.

**`deploy.sh` reads `git show HEAD:index.html`**, not the working tree — same 2026-08-24 sync. It used to
grep the version off disk while pairing it with a sha from `git rev-parse HEAD`, so a mid-edit tree could
record a version and a sha that never coexisted. `GX_VERSION=vX.YYY` records an exact version;
`GX_ALLOW_DIRTY=1` proceeds when HEAD and your tree disagree, which otherwise stops with both printed.

> Both scripts are synced from gx-theme. After **every** `./gx-sync.sh`, `chmod 755` them before
> committing — Dropbox strips the exec bit back to 0600 on its next sweep.

**`ATM_MACHINE_MAP` (`dutchie_proxy.gs`) must NOT be switched to `GXCore.resolveStore()`.** core-admin's
re-pin notes carry a blanket line saying to use `resolveStore()` if you fold store names yourself; it does
not apply here. That map keys **ATM machine labels**, not stores, and `resolveStore` has no machine concept.
**Measured by EXECUTION** (2026-08-22) — the real `gxResolveStore_` run against the live `stores` rows,
not modelled from `?action=stores`. Of the map's **22** labels the swap drops **13 to null**, leaving 9.
**All 9 ATM 2 labels are among the drops; every survivor is ATM 1**, so Bend, Commercial, Hillsboro and
River each lose their second machine entirely. ATM revenue would quietly shrink with no error anywhere —
in a lookup map `null` does not mean "wrong bucket", it means the row **vanishes**.

**There is no merge risk**, contrary to an earlier claim here. The map has 8 collision groups and every
one collapses to an identical `{store, machine}` — `Commercial`/ATM 2 alone has four labels. Collapsing
any group loses nothing; all the damage is in the drops.

*Provenance, since this paragraph previously said otherwise: the earlier "19 labels / 11 to null / merges
`center st`+`center`" figures were **core-admin's**, not Sky's, produced by reading the map through
`grep -A 20` — which truncated it — and retracted the same day. This app caught the error twice: first by
parsing the literal, then by refusing to let core-admin's replacement number harden while it was still
modelled. Modelling undercounts survivors, because `resolveStore` token-folds before matching and strips a
trailing ` rd`/` st` — so `center st` resolves to `center` even though that store publishes only
`["Center"]`.*

**Re-confirmed on 2026-08-22 under GXCore v194.** The app was re-pinned v188 → v194 and redeployed;
Shawn then saved an expense mapping successfully. That matters because `writeGuard_` fails CLOSED — a
Core-side change that broke `roleForApp` would look exactly like an outage, and the six versions crossed
included v191, which changed `gxRead_` to return null-prototype rows that cross the library boundary into
this app. A real non-superadmin admit is the only evidence that actually settles it; the deployer's own
account cannot, because `sky` is superadmin and resolves by a different path.

**The admit test PASSED on 2026-08-20 and is what licensed enforcing.** Shawn was granted, signed in and
saved an expense mapping, and the guard recorded `user shawn / role editor / err null`, with
`tally.first_admit` stamped and zero refusals. That closes the last gap: my earlier probe passed a
hand-typed `"shawn"`, whereas this exercised the REAL path — session token → `auth.user` → `roleForApp` —
proving the token-derived id matches what the grant lookup expects. A mismatch there would have refused him
while the probe kept saying `editor`.

Flip it with `action=guardmode` (secret-gated, below). Enforce mode changes nothing for an admitted user:
the same call already ran in production and returned `editor`; enforce only acts on a null.

**Know the tradeoff before flipping:** enforce fails CLOSED on a Core error as well as on a missing grant,
per core-admin's rule for auth checks. That means a GX Core outage blocks Sales writes — deliberate, since
failing open on an auth check is no check at all, but it is a real availability cost that the read paths
do not pay.

**SUPERSEDED — kept for the reasoning, not the conclusion.** The two paragraphs below argue for staying in
`log`; that was the correct call *until* the admit test passed on 2026-08-20. The guard is **`enforce`**
now. Read them as the rationale for why the admit test was required first, not as current state.

**Why it stays in `log` even though Sales is effectively single-user today.** Sky is currently the only
account that resolves, and he is superadmin, so enforcing right now would be harmless — and would also buy
almost nothing, since the whole point of the check is closing a revocation window and there is presently no
non-superadmin grant to revoke. The risk is all on the other side: flip it now and the FIRST person ever
granted meets a live fail-closed gate on day one, with no evidence it admits anyone but the deployer. Log
mode costs nothing and collects exactly the evidence that removes that risk.

Still true and worth keeping separately: this app has a **local-login fallback** (`gc_sales_users`, which
holds only `sky`), so "signed in" and "holds a grant" are two different statements here where for Inventory
they are one. That is a real hazard for any grant check, just not the reason Shawn returned null.

**Flip or roll back the guard by curl — `action=guardmode`, no editor needed.** This exists for ROLLBACK,
not convenience: the guard arms a fail-closed auth gate, so a revert must be seconds away and must not
depend on anyone being at a browser.

```
curl -sL -G "<sales /exec>" --data-urlencode action=guardmode --data-urlencode "secret=$(cat .gx_deploy_secret)" --data-urlencode mode=enforce
```

`mode` is one of `log` · `enforce` · `off`, validated against an array with `indexOf` — deliberately not an
object checked with `MAP[value]`, since this app spent a session removing exactly that idiom. Verified to
refuse `constructor`, `__proto__`, `toString`, an unknown string and an empty one, and to refuse a bad
secret, all without perturbing the current mode.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.

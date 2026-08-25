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
| tests | no automated suite — verify with the `gxpin` / `authprobe` routes below |

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed — which matters more
here than elsewhere, since this app's writes now run through a fail-closed auth guard. `gx-preflight.sh`
runs as a **pre-push hook** and refuses dev leftovers.

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

**Now pinned to GXCore v213** (2026-08-23, from v204; deployment `AKfycbzju5He…@160`). The reason was the
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
  **This is the weaker of the two evidences, and the stronger one is still missing.** The guard log's three
  admits (`shawn` / `editor` / `err null`) are stamped `2026-08-20T21:08` and `2026-08-22T14:07`–`14:08` —
  all under v194/v204, none since the v213 re-pin on 2026-08-23. A hand-typed `"shawn"` exercises the grant
  lookup but NOT the session-token → `auth.user` → `roleForApp` chain; a mismatch there would refuse him
  while the probe kept saying `editor`. **A real non-superadmin save under v213 is what actually settles
  it**. Rollback is unchanged and one command: `guardmode&mode=log`.

  **CLOSED 2026-08-24 on Sky's word: Shawn has saved under v213 several times, so the token-derived
  path is exercised and this caution is spent.** Recorded with its provenance because the two sources
  disagree: `write_guard_log` at 2026-08-24 ~18:00 held three admits, all stamped v194-era
  (`2026-08-20T21:08`, `2026-08-22T14:07`–`14:08`), with nothing after the v213 re-pin on 08-23. The
  ring keeps 25 and records refusals too, so real saves should have appeared in it. Sky owns the app
  and knows what Shawn has been doing; the likeliest reading is that the log is not capturing what it
  is assumed to capture. **Do not treat the log's silence as evidence of a problem — but do not cite
  the log as proof of the admit either.** If it ever matters, one real save followed by `authprobe`
  settles which of the two is wrong.
  *Re-run independently later the same evening, against deployment `@162`, by a second session that had
  not seen this note: same answer — `role editor`, `has_roleForApp true`, `gxcore_version 213`, and the
  same three v194-era admits in the log with nothing newer. Two runs agreeing does not upgrade the
  hand-typed path into the token-derived one; it only rules out a flaky read.*
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

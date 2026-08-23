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
connector that actually served the last uncached Expenses load (`gxcore@<iso>` vs `local@<iso>`). A
`Forbidden` here is a finding, not a route bug: it means `GX_DEPLOY_SECRET` is unset or stale on this
script, and that same property gates `qbReportViaGXCore_` — which fails *silently* to the legacy local
QuickBooks token, the path that must not run while Core also refreshes.

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

**Now pinned to GXCore v204** (2026-08-22, from v194; commit `a13a5a2`, deployment `AKfycbzju5He…@158`).
v203 added `publishGoals`/`publishedGoals`; v204 normalised `getStores()` aliases to an array. Neither
changes behaviour here — this app consumes goals through the **`?action=published_goals` web route**
(`index.html`), not a library call, and `getStoresMeta_` picks four named fields and never reads `aliases`.
Verified live: `gxpin` → `gxcore_version 204`, and `authprobe&user=shawn` → `role editor` under v204, so the
fail-closed guard still admits. That probe is the hand-typed path, not the token-derived one — the standard
below still applies, and a real Shawn write under v204 is what finally settles it.

**`ATM_MACHINE_MAP` (`dutchie_proxy.gs`) must NOT be switched to `GXCore.resolveStore()`.** core-admin's
re-pin notes carry a blanket line saying to use `resolveStore()` if you fold store names yourself; it does
not apply here. That map keys **ATM machine labels**, not stores, and `resolveStore` has no machine concept.
Sky modelled all 19 labels against the live registry (2026-08-22): the swap would resolve **11 to null** —
every ATM 2, including `bend 2`, `hillsboro 2`, `commercial lg`, `river lg`, `river sm` — and would merge
`center st`/`center` and `portland`/`portland rd`. ATM revenue would quietly shrink with no error anywhere.

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

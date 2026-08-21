# Sales / Cashflow (app key `sales`) — GX app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app is being integrated with it. Owner: **Sky** — Shawn is a USER of this app, not its
owner (corrected by Sky 2026-08-21; the shared brain's app-owner list still says otherwise). Backend:
`dutchie_proxy.gs` (Dutchie + QuickBooks proxy). Frontend: `index.html`, deployed via **GitHub Pages**. Its
app key in GX Core is **`sales`**.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (not this repo's `BRAIN_NOTES.md`, which is
retired): `/gxbrain` reads notes addressed to `to_app=sales`, resolves done ones (`resolve_note`), and writes
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
(confirmed by Sky 2026-08-21). That is the true answer, not a lookup miss and not the local-fallback theory
that was current when the guard was built. Shawn is a user of this app, not its owner; Sky owns it.

So the path to enforcing is: **grant a real non-superadmin → have them sign in and save something → confirm
they appear in `write_guard_tally.first_admit` as ADMITTED → flip `GX_WRITE_GUARD` to `enforce`.**

**Why it stays in `log` even though Sales is effectively single-user today.** Sky is currently the only
account that resolves, and he is superadmin, so enforcing right now would be harmless — and would also buy
almost nothing, since the whole point of the check is closing a revocation window and there is presently no
non-superadmin grant to revoke. The risk is all on the other side: flip it now and the FIRST person ever
granted meets a live fail-closed gate on day one, with no evidence it admits anyone but the deployer. Log
mode costs nothing and collects exactly the evidence that removes that risk.

Still true and worth keeping separately: this app has a **local-login fallback** (`gc_sales_users`, which
holds only `sky`), so "signed in" and "holds a grant" are two different statements here where for Inventory
they are one. That is a real hazard for any grant check, just not the reason Shawn returned null.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.

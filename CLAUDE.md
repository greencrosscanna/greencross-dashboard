# Sales / Cashflow (app key `sales`) — GX app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app is being integrated with it. Owner: **Shawn** (code access: Sky). Backend:
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
(Phase-2), ✅ auto-record (`deploy_version`), ✅ changelog from `version_history`, ✅ gx-theme. ⬜ bug
forwarding (`gxIngestBug`) — the last seam, now a note in the central inbox.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) if you need its id.

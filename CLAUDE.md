# Sales / Cashflow (app key `sales`) — GX app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app is being integrated with it. Owner: **Shawn** (code access: Sky). Backend:
`dutchie_proxy.gs` (Dutchie + QuickBooks proxy). Frontend: `index.html`, deployed via **GitHub Pages**. Its
app key in GX Core is **`sales`**.

## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and then reconciles this repo's
`BRAIN_NOTES.md` (does **## Pending**, reports sync status) — the sync protocol lives in that one command,
not copied here. **"brain sync" / "sync brain"** = the reconcile-and-report step alone (skips orientation).

Integration status (2026-08-09): **channel established; seams being wired.** App key **`sales`**. Deploys
via clasp (backend) + GitHub Pages (frontend). Shared login live as of Phase-2 (2026-08-09).
Current app version **v38**; changelog live from GX Core `version_history`.

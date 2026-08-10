# BRAIN_NOTES — Sales / Cashflow — RETIRED (2026-08-09) → central GX Core inbox

> ⚠️ **This per-repo file is retired.** Cross-app coordination moved to GX Core's central **brain_notes**
> inbox. `/gxbrain` and the hook now read notes addressed to `to_app=sales`, resolve via `resolve_note`, and
> write note-backs via `add_note`. The remaining local items were **migrated to the central inbox**: the
> bug-reports task (→ `sales`) and the `lbGoals` note-back (→ `core-admin`). Kept only as a local archive.

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-09)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | ✅ **Live** | bound (lib v19, userSymbol GXCore) as part of task #1 |
| Shared login / roles      | ✅ **Live** | auth gate on all proxy actions; login screen in frontend; verified 2026-08-09 |
| `gxIngestBug` forwarding  | 🔜 **task #1** | add 🐞 button+modal → forward (Leaderboard pattern) |
| Changelog from GX Core `version_history` | ✅ **Live** | JSONP fetch replaces hardcoded rows; verified 2026-08-09 |
| `deploy_version` auto-record | ✅ **Live** | `deploy.sh` wired; v39 verified in GX Core 2026-08-09 |
| gx-theme adoption         | ✅ **Live** | `gx-theme.css` linked; `:root` aliases wired; logo → shared URL; verified 2026-08-09 |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

_(retired — migrated to the central GX Core inbox as a note to `to_app=sales`; read it via `/gxbrain`)_

## Notes back to the brain

<!-- Things only the brain can act on (cross-app contracts, GX Core schema changes, etc.) -->

- This app reads leaderboard goals from a separate GAS endpoint (`lbGoals`). That endpoint's URL is currently hardcoded in the proxy config. If the Leaderboard app moves its GAS, the proxy URL will need updating. Consider formalizing this as a GX Core config entry.

> **Brain (2026-08-09):** `lbGoals` hardcoded URL → tracked in the GX roadmap as a candidate **GX Core
> config entry** so a Leaderboard GAS move can't silently break Sales. *(The earlier "no auth layer" note is
> **RESOLVED** — shared login shipped 2026-08-09; brain verified the proxy now rejects un-tokened calls.)*

## Archive

<!-- Completed pending items land here: - [x] Task — done YYYY-MM-DD commit XXXXXXX -->

- [x] #1 Auto-record deploys — `APP_VERSION = 'v39'` in `index.html`; `deploy.sh` wired; v39 verified in GX Core (`deployed_by:"app"`) — done 2026-08-09 commits 849920c / 1a78cdc
- [x] #2 Changelog → GX Core — JSONP fetch replaces 39 hardcoded rows; lazy-loads on first open; graceful fallback; verified in browser — done 2026-08-09 commit 5219271
- [x] #1 Shared login (Phase-2 auth) — GXCore lib bound (v19); `requireAuth_` gates all proxy actions; login screen matches Leaderboard design; session heartbeat + logout wired; Sky verified login works; deployed @82 — done 2026-08-09
- [x] #2 gx-theme adoption — `gx-theme.css` linked; `:root` aliases wired to `--gx-*` tokens with fallbacks; all hardcoded hex in CSS replaced; logo → shared URL; base64 removed (~20KB savings); verified in browser — done 2026-08-09

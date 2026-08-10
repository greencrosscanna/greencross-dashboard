# BRAIN_NOTES — Sales / Cashflow

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-09)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | ✅ **Live** | bound (lib v19, userSymbol GXCore) as part of task #1 |
| Shared login / roles      | ✅ **Live** | auth gate on all proxy actions; login screen in frontend; verified 2026-08-09 |
| `gxIngestBug` forwarding  | ❌ Not started | No bug surface in app yet → build-then-wire |
| Changelog from GX Core `version_history` | ✅ **Live** | JSONP fetch replaces hardcoded rows; verified 2026-08-09 |
| `deploy_version` auto-record | ✅ **Live** | `deploy.sh` wired; v39 verified in GX Core 2026-08-09 |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

### 2. Bug reports → GX Core (build-then-wire — after login)
No bug surface today, so: add a minimal "report a problem" control, then forward via
`gxIngestBug('sales', reporter, payload)` (you'll have GXCore bound after #1) or the public `report_bug`
route. Payload keys map like the other apps (`priority/desc/appVer/appStore/appTab`). Lowest priority.

## Notes back to the brain

<!-- Things only the brain can act on (cross-app contracts, GX Core schema changes, etc.) -->

- Sales app has **no auth layer** — anyone with the GitHub Pages URL can view all store data. When Command Center Phase 2 brings Sales onto GX Core shared login, this will need a login gate + role check. Flag for Phase 2 planning.
- This app reads leaderboard goals from a separate GAS endpoint (`lbGoals`). That endpoint's URL is currently hardcoded in the proxy config. If the Leaderboard app moves its GAS, the proxy URL will need updating. Consider formalizing this as a GX Core config entry.

> **Brain (2026-08-09):** both logged in the GX roadmap and kept open until acted on. Auth exposure →
> tracked as the **Phase-2 shared-login + role-gate** item (real exposure now; deliberate decision, not an
> accident). `lbGoals` hardcoded URL → tracked as a candidate **GX Core config entry** so a Leaderboard GAS
> move can't silently break Sales. Neither blocks the seam work above.

## Archive

<!-- Completed pending items land here: - [x] Task — done YYYY-MM-DD commit XXXXXXX -->

- [x] #1 Auto-record deploys — `APP_VERSION = 'v39'` in `index.html`; `deploy.sh` wired; v39 verified in GX Core (`deployed_by:"app"`) — done 2026-08-09 commits 849920c / 1a78cdc
- [x] #2 Changelog → GX Core — JSONP fetch replaces 39 hardcoded rows; lazy-loads on first open; graceful fallback; verified in browser — done 2026-08-09 commit 5219271
- [x] #1 Shared login (Phase-2 auth) — GXCore lib bound (v19); `requireAuth_` gates all proxy actions; login screen matches Leaderboard design; session heartbeat + logout wired; Sky verified login works; deployed @82 — done 2026-08-09

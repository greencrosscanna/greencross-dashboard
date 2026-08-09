# BRAIN_NOTES — Sales / Cashflow

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-08)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | ❌ Not started | No shared library referenced |
| Shared login / roles      | ❌ Not started | No auth layer — open URL = access |
| `gxIngestBug` forwarding  | ❌ Not started | |
| Changelog from GX Core `version_history` | ❌ Not started | No changelog UI in app |
| `deploy_version` auto-record | ❌ Not started | |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

<!-- Brain drops tasks here. Each item: what to do + any context needed. -->
<!-- Format: - [ ] Task description -->

_Nothing pending._

## Notes back to the brain

<!-- Things only the brain can act on (cross-app contracts, GX Core schema changes, etc.) -->

- Sales app has **no auth layer** — anyone with the GitHub Pages URL can view all store data. When Command Center Phase 2 brings Sales onto GX Core shared login, this will need a login gate + role check. Flag for Phase 2 planning.
- This app reads leaderboard goals from a separate GAS endpoint (`lbGoals`). That endpoint's URL is currently hardcoded in the proxy config. If the Leaderboard app moves its GAS, the proxy URL will need updating. Consider formalizing this as a GX Core config entry.

## Archive

<!-- Completed pending items land here: - [x] Task — done YYYY-MM-DD commit XXXXXXX -->

_Nothing archived yet._

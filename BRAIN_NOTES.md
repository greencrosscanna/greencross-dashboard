# BRAIN_NOTES — Sales / Cashflow

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-08)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | ❌ Not started | No shared library referenced |
| Shared login / roles      | ❌ Not started | No auth layer — open URL = access |
| `gxIngestBug` forwarding  | ❌ Not started | No bug surface in app yet → build-then-wire |
| Changelog from GX Core `version_history` | ❌ Not started | UI **exists** but is hardcoded `vhist-row`s in `index.html` — repoint at GX Core (already holds v1–v39) |
| `deploy_version` auto-record | ❌ Not started | No deploy pipeline yet (`clasp.sh` is a bare node wrapper); current version **v38** |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

### Next up (after #1 verifies — don't start these yet)
- **Changelog → read from GX Core.** Replace the hardcoded `vhist-row` list in `index.html` with a JSONP
  fetch of `…?action=version_history&app=sales&callback=…` (GX Core already serves Sales' v1–v39). Same
  pattern Inventory + Leaderboard used. Do it AFTER auto-record so new versions keep flowing (otherwise the
  list freezes at the last recorded version). Graceful fallback if the fetch fails.
- **Bug reports → GX Core.** No bug surface today, so build-then-wire: add a minimal "report a problem"
  control, then forward via `gxIngestBug('sales', reporter, payload)` (bound library) or the public
  `report_bug` route. Payload keys map like the other apps (`priority/desc/appVer/appStore/appTab`).
  Lowest priority of the three.

## Notes back to the brain

- **`.gx_deploy_secret` needed:** `deploy.sh` is ready but can't run end-to-end until Sky drops the shared suite secret into `.gx_deploy_secret` (same value other apps use). Once it's there, run `GX_NOTES="..." ./deploy.sh` once and confirm v39 appears via `?action=version_history&app=sales` with `deployed_by:"app"`. After that, move item #1 to Archive.

<!-- Things only the brain can act on (cross-app contracts, GX Core schema changes, etc.) -->

- Sales app has **no auth layer** — anyone with the GitHub Pages URL can view all store data. When Command Center Phase 2 brings Sales onto GX Core shared login, this will need a login gate + role check. Flag for Phase 2 planning.
- This app reads leaderboard goals from a separate GAS endpoint (`lbGoals`). That endpoint's URL is currently hardcoded in the proxy config. If the Leaderboard app moves its GAS, the proxy URL will need updating. Consider formalizing this as a GX Core config entry.

> **Brain (2026-08-09):** both logged in the GX roadmap and kept open until acted on. Auth exposure →
> tracked as the **Phase-2 shared-login + role-gate** item (real exposure now; deliberate decision, not an
> accident). `lbGoals` hardcoded URL → tracked as a candidate **GX Core config entry** so a Leaderboard GAS
> move can't silently break Sales. Neither blocks the seam work above.

## Archive

<!-- Completed pending items land here: - [x] Task — done YYYY-MM-DD commit XXXXXXX -->

- [~] #1 Auto-record deploys — `APP_VERSION = '39'` added to `index.html` (single source of truth); `deploy.sh` created (pushes clasp + git, curls GX Core endpoint) — 2026-08-09 commit 849920c. **Blocked: needs `.gx_deploy_secret` from Sky to verify end-to-end.**

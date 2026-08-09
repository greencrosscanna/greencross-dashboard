# BRAIN_NOTES — Sales / Cashflow

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-09)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | ❌ Not started | No shared library referenced |
| Shared login / roles      | ❌ Not started | No auth layer — open URL = access |
| `gxIngestBug` forwarding  | ❌ Not started | No bug surface in app yet → build-then-wire |
| Changelog from GX Core `version_history` | ❌ Not started | UI **exists** but is hardcoded `vhist-row`s in `index.html` — repoint at GX Core (already holds v1–v39) |
| `deploy_version` auto-record | ✅ **Live** | `deploy.sh` wired; v39 verified in GX Core 2026-08-09 |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

### 1. Changelog → read from GX Core (repoint the hardcoded Version History)
Single-source Sales' Version History from GX Core's release log — same pattern Inventory + Leaderboard used.
GX Core already serves Sales' history (`v1`–`v39`).

**Version-format fix FIRST (else the list shows a duplicate).** Auto-record wrote a bare **`39`**, but every
historical entry is **`vNN`** (`v39`, `v38`, …) — so GX Core currently holds *both* `39` and `v39`.
- Standardize on the **`vNN`** format: make `APP_VERSION` the single source (e.g. `APP_VERSION = 'v39'`) and
  have the `<title>` read from it (today the title still says "v38" while `APP_VERSION` was `'39'` —
  reconcile to ONE value that reflects what actually shipped).
- `deploy.sh` then records that `vNN` string, which upserts onto the matching historical entry (no dup).
- The stray bare **`39`** row is being removed from GX Core brain-side (Sky / `delete_version`) — just don't
  record bare numbers again.

**The repoint:**
1. Remove the static `vhist-row` block from `index.html`.
2. On load, JSONP-fetch `…/exec?action=version_history&app=sales&callback=cb` (public, read-only).
3. Render each entry into a row: `version → .vhist-tag`, `deployed_at → .vhist-date` (format "Mon YYYY" in
   **America/Los_Angeles** — suite convention), `notes → .vhist-desc`. The route returns newest-first already.
4. Empty-`notes` entries still render (tag + date, no desc); keep it tidy.
5. Graceful fallback: fetch fails/empty → one "version history momentarily unavailable" row, never break the
   page. `APP_VERSION` stays the on-screen version badge.
6. Verify the rendered list matches the cockpit, then move this to **## Archive** (date + commit) and give a
   sync report.

### 2. Bug reports → GX Core (build-then-wire — last)
No bug surface today, so: add a minimal "report a problem" control, then forward via
`gxIngestBug('sales', reporter, payload)` (bound library) or the public `report_bug` route. Payload keys map
like the other apps (`priority/desc/appVer/appStore/appTab`). Lowest priority of the three.

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

- [x] #1 Auto-record deploys — `APP_VERSION = '39'` in `index.html`; `deploy.sh` wired; v39 verified in GX Core (`deployed_by:"app"`) — done 2026-08-09 commits 849920c / 1a78cdc

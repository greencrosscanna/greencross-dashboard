# BRAIN_NOTES — Sales / Cashflow

Owner: Shawn (code access: Sky)
Repo: `greencross-sales` → GitHub Pages at https://skygreencross.github.io/greencross-dashboard/
Backend GAS: `dutchie_proxy.gs` (Dutchie + QuickBooks proxy; no dedicated GAS web app for this repo — proxy is deployed separately)

## Integration status (as of 2026-08-09)

| Integration point         | Status        | Notes |
|---------------------------|---------------|-------|
| GXCore library pin        | 🔜 task #1 | bound as part of shared-login |
| Shared login / roles      | 🔴 **task #1 (SECURITY)** | proxy has NO auth on ~15 financial actions — gating now |
| `gxIngestBug` forwarding  | ❌ Not started | No bug surface in app yet → build-then-wire |
| Changelog from GX Core `version_history` | ✅ **Live** | JSONP fetch replaces hardcoded rows; verified 2026-08-09 |
| `deploy_version` auto-record | ✅ **Live** | `deploy.sh` wired; v39 verified in GX Core 2026-08-09 |
| GX2 reads                 | ✅ None        | App reads only Dutchie + QuickBooks via proxy; never touches GX2 |

## Pending

### 1. 🔴 Shared login on Sales — gate the proxy + add a login screen (Phase-2 auth; closes the open-proxy exposure)
**Why this is now top priority (security):** the proxy (`dutchie_proxy.gs`, `doGet` ~line 60) serves ~15
Dutchie + QuickBooks financial actions (`expenses`, `costs`, `qbaccounts`, `qbmapping`, `otherrev`,
`txdetail`, …) with **zero auth** — anyone with the `/exec` URL can pull store sales + QuickBooks data
directly. A frontend-only gate does NOT fix this; the gate must be **server-side, on the proxy**.

**Replicate Leaderboard's proven pattern — don't invent.** Reference `greencross-leaderboard`:
- `appsscript.json` → GXCore library binding (`userSymbol: "GXCore"`, latest version — currently 19).
- `dutchie_proxy.gs` → `loginUser` (login handler), `requireAuth_(params)` (the gate, ~line 225),
  `requireRole_(auth, […])`, and the session-token issue/heartbeat (`issueSessionToken_`).
- `index.html` → its login screen + token storage + `&token=` on every call + heartbeat/logout.

**Steps:**
1. **Bind GXCore** in `appsscript.json` (`userSymbol: "GXCore"`, latest lib version). Add only scopes login needs.
2. **Login action:** `if (params.action === 'login') return jsonOut(loginUser(params), params.callback)`.
   `loginUser` validates via **`GXCore.login(user, pass, 'sales')`**; on success issue a session token
   (mirror Leaderboard's `issueSessionToken_` + expiry + silent heartbeat re-issue).
3. **Gate every data action:** add `const auth = requireAuth_(params); if (!auth.ok) return …Unauthorized`
   in `doGet` **above** the ~15 data actions. Each now requires `&token=`. If any action must stay public,
   keep it explicitly above the gate (Sales likely has none — its reads are all sensitive).
4. **Frontend login** (`index.html`): login screen → `?action=login` → store token in **namespaced**
   sessionStorage (e.g. `gc_sales_token`; same-origin collision rule), pass `&token=` on every proxy call,
   heartbeat + logout. Block the dashboard UI until authed.
5. **Secrets (do alongside):** confirm `QB_CLIENT_SECRET` (~line 23) + the Dutchie keys live only in
   ScriptProperties, never in source/git; rotate anything ever committed. (Roadmap flagged hardcoded Dutchie keys.)
6. **Verify:** (a) `curl` a data action with NO token → `Unauthorized`; (b) valid token → works; (c) Shawn
   logs in and his daily flow works end-to-end; (d) token expiry/heartbeat OK; (e) a direct proxy-URL hit
   without login is dead. Then archive + sync report. **Verify carefully — Shawn uses this daily; don't break him.**

**Dependency (brain handles):** GX Core must **grant `sales` access** to the right users or login returns no
access. That's a GX Core admin action — the brain is setting it up once Sky confirms the user list (Shawn +
Sky at minimum). Login won't succeed until those grants exist.

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

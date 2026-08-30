// Green Cross — Dutchie API Proxy
// Deploy as Web App: Execute as "Me", Who has access "Anyone"
// Paste your API keys below — these never leave your Google account

// ── DUTCHIE CREDENTIALS — NEVER IN SOURCE ────────────────────────────────────────
// The six POS keys used to live here as literals. They were committed to a PUBLIC repo and sat at
// HEAD from the first commit of this file until 2026-08-29. They now live in Script Properties
// under DUTCHIE_STORE_KEYS_JSON, the same place leaderboard and inventory keep theirs.
// To set or rotate them, run setDutchieStoreKeys() from the script editor and paste the JSON —
// the value never enters the repo. Do NOT reintroduce a literal here, even "temporarily".
const DUTCHIE_STORE_KEYS_PROP_ = 'DUTCHIE_STORE_KEYS_JSON';
let _storeKeysCache_ = null;   // request-scoped; a GAS execution is short-lived

function getStoreKeys_() {
  if (_storeKeysCache_) return _storeKeysCache_;
  const raw = PropertiesService.getScriptProperties().getProperty(DUTCHIE_STORE_KEYS_PROP_);
  if (!raw) {
    // Fail CLOSED and say so. Returning {} makes every storeKey_ lookup null, which surfaces as
    // "Unknown store" at the gate rather than an outbound call with an undefined credential.
    Logger.log('DUTCHIE_STORE_KEYS_JSON is not set — every store will read as unknown.');
    return (_storeKeysCache_ = {});
  }
  try {
    const parsed = JSON.parse(raw);
    _storeKeysCache_ = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    Logger.log('DUTCHIE_STORE_KEYS_JSON is not valid JSON — every store will read as unknown.');
    _storeKeysCache_ = {};
  }
  return _storeKeysCache_;
}

/**
 * One-time / rotation setter. Run from the script editor:
 *   setDutchieStoreKeys('{"Bend":"...","Center":"..."}')
 *
 * Labels are this app's store names, which are identical to GX Core's `dutchie_name` column and to
 * Inventory's — verified 2026-08-29 by comparing key material across all three repos. Leaderboard
 * uses a different (transposed) label set and has since moved to store_id keying; Sales has NOT,
 * so do not paste a store_id-keyed JSON in here. Returns the labels written, never the values.
 */
function setDutchieStoreKeys(json) {
  if (!json) throw new Error('Pass the store-keys JSON as the argument.');
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Store keys must be a JSON object of { storeKey: apiKey }.');
  }
  PropertiesService.getScriptProperties().setProperty(DUTCHIE_STORE_KEYS_PROP_, JSON.stringify(parsed));
  _storeKeysCache_ = null;
  return { ok: true, stores: Object.keys(parsed) };
}

// ── A LOOKUP TABLE IS NOT A WHITELIST ────────────────────────────────────────────
// Every plain object inherits constructor, __proto__, toString, valueOf, hasOwnProperty and
// isPrototypeOf, so MAP[userInput] returns a truthy FUNCTION for those names and any `if (MAP[x])`
// gate waves them straight through. Reported as a suite-wide idiom by pricecards (whose router
// returned a whole pricing sheet to ?action=toString) and fixed in GX Core v170.
// Measured here before fixing: all SIX inherited names passed `if (!STORE_KEYS[store])`. Core got
// away with toString and valueOf only because it lowercases keys first; we do not slug, so nothing
// was covering us. The gate is post-auth, so this was never the Price Cards hole — an
// unauthenticated request reaches no read or write here — but a caller could still turn a clean
// "Unknown store" into an outbound Dutchie call carrying a stringified function as its credential.
// Every read of STORE_KEYS now goes through storeKey_, so an inherited name resolves to null and
// fails the gate like any other unknown store.
function hasOwn_(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, String(key));
}

function storeKey_(store) {
  const keys = getStoreKeys_();
  return hasOwn_(keys, store) ? keys[store] : null;
}

const BASE = 'https://api.pos.dutchie.com';

const BUDGET_SHEET_ID  = '1OBNzkBrJtLIlf8xknVlGd6Jb8nlkg4_KG-Gq6BD7HHY';
const BUDGET_SHEET_GID = 1092240858;
// The calendar year the sheet above holds goals for — it is the "2026 GX2 Dashboard" workbook and
// carries ONE set of 12 monthly columns, with no year dimension. getGoals() ships this alongside the
// numbers so the frontend can refuse to show them for a year they do not describe: the period picker
// offers curY-2..curY, and without this every 2024/2025 view measured real sales against the 2026
// plan. Swap the sheet, swap this. There is no 2025 budget anywhere to fall back to.
const BUDGET_YEAR      = 2026;

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE = CacheService.getScriptCache();

function cacheGet_(key) {
  try {
    // Support chunked storage for large payloads
    const meta = CACHE.get(key + '__meta');
    if (meta) {
      const { chunks } = JSON.parse(meta);
      let out = '';
      for (let i = 0; i < chunks; i++) out += (CACHE.get(key + '__' + i) || '');
      return out || null;
    }
    return CACHE.get(key);
  } catch(e) { return null; }
}

function cacheSet_(key, value, ttl) {
  try {
    const CHUNK = 95000; // GAS cache limit is ~100KB per entry
    if (value.length > CHUNK) {
      const chunks = Math.ceil(value.length / CHUNK);
      const entries = { [key + '__meta']: JSON.stringify({ chunks }) };
      for (let i = 0; i < chunks; i++) {
        entries[key + '__' + i] = value.slice(i * CHUNK, (i + 1) * CHUNK);
      }
      CACHE.putAll(entries, ttl);
    } else {
      CACHE.put(key, value, ttl);
    }
  } catch(e) { /* cache write failure is non-fatal */ }
}

function cacheDelete_(key) {
  try {
    const meta = CACHE.get(key + '__meta');
    if (meta) {
      const { chunks } = JSON.parse(meta);
      const keys = [key + '__meta'];
      for (let i = 0; i < chunks; i++) keys.push(key + '__' + i);
      CACHE.removeAll(keys);
    } else {
      CACHE.remove(key);
    }
  } catch(e) { /* non-fatal */ }
}

// ── JSON response helper ──────────────────────────────────────────────────────
function jsonOut_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Session auth (mirrors Inventory Phase-1 pattern) ─────────────────────────
// Tokens are signed with GC_SESSION_SECRET (shared across the suite) so a token
// issued by GXCore.login() validates identically in requireAuth_() here.
const GC_SESSION_SECRET_KEY = 'GC_SESSION_SECRET'; // MUST match GXCore + Inventory
const GC_SESSION_TTL_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days
const GC_USERS_KEY          = 'gc_sales_users';    // local fallback user store

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GC_SESSION_SECRET_KEY);
  if (!secret) {
    // Bootstrap: generate once. For shared-secret operation, Sky must copy the
    // same value from GXCore / Inventory ScriptProperties here after first deploy.
    secret = Utilities.getUuid() + ':' + Utilities.getUuid();
    props.setProperty(GC_SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function hashPass_(pass) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass));
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function signSession_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, sessionSecret_());
  return Utilities.base64EncodeWebSafe(sig);
}

function issueSessionToken_(user) {
  const exp = Date.now() + GC_SESSION_TTL_MS;
  const payload = [String(user).toLowerCase().trim(), exp].join(':');
  return payload + ':' + signSession_(payload);
}

function validateSessionToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const [user, expStr, sig] = parts;
  const exp = Number(expStr || 0);
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  const payload = user + ':' + exp;
  if (sig !== signSession_(payload)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user };
}

// ── Write-auth grant re-check — SHIPPED DARK ON PURPOSE ──────────────────────────
// THE GAP: validateSessionToken_ checks a signature and an expiry, never a GRANT. A token proves who
// you are, not that you still have access, so revoking someone in the shared user list leaves them
// able to write here for the remainder of a SEVEN DAY TTL. Core's roleForApp (public in v170) closes
// that — it is superadmin-aware, filters on status, and invalidates on revoke, so a revocation bites
// in a minute instead of waiting out the token.
//
// WHY IT DOES NOT ENFORCE YET, WHICH IS THE WHOLE POINT OF THIS SHAPE. Probing roleForApp against
// real accounts on live v170 returned a role for exactly ONE of them — the superadmin, who is also
// the person deploying. Every other name came back null, including the owner of this app. Turning
// that into a refusal would have write-locked the owner while working perfectly for whoever shipped
// it, which is precisely the configuration in which nobody notices. Inventory has since made the
// rule explicit and it is adopted here: BEFORE wiring an auth check fail-closed, probe a real
// NON-SUPERADMIN account through it and require ADMITTED. The deployer is the worst test subject
// because they are usually the one account that resolves.
//
// SO THE CHECK RUNS AND RECORDS INSTEAD OF REFUSING. Mode lives in the GX_WRITE_GUARD property:
//   'log'     (default) — decide, record, ALLOW regardless. Cannot cause an outage.
//   'enforce'           — actually refuse. Flip only once the log shows real users being ADMITTED.
//   'off'               — skip entirely.
//
// IT RECORDS ADMITS AS WELL AS REFUSALS, DELIBERATELY. The lesson both this app and inventory landed
// on this week is that "refuses the bad" and "admits the good" are two different assertions, and a
// probe that only ever asserts the first reads green while locking everyone out. A log that captured
// only refusals would repeat that exact error one level down: it could never show the positive path
// working, which is the only evidence that justifies flipping to enforce.
const GX_WRITE_GUARD_KEY = 'GX_WRITE_GUARD';      // 'log' (default) | 'enforce' | 'off'
const GX_WRITE_GUARD_LOG = 'GX_WRITE_GUARD_LOG';  // capped ring — history tables never grow unbounded
const GX_WRITE_GUARD_CAP = 25;
const GX_WRITE_GUARD_TALLY = 'GX_WRITE_GUARD_TALLY';  // monotonic counters — survive the ring rolling

function writeGuard_(user, action) {
  const props = PropertiesService.getScriptProperties();
  const mode  = props.getProperty(GX_WRITE_GUARD_KEY) || 'log';
  if (mode === 'off') return { ok: true, mode: mode };

  let role = null, err = null;
  try {
    role = (typeof GXCore !== 'undefined' && GXCore && typeof GXCore.roleForApp === 'function')
      ? GXCore.roleForApp(String(user || '').toLowerCase().trim(), 'sales')
      : null;
    if (!role && typeof GXCore.roleForApp !== 'function') err = 'roleForApp unavailable at this pin';
  } catch (e) {
    err = e.message;
  }

  recordGuard_(props, { user: user, action: action, role: role || null, err: err || null });

  // Fail CLOSED when enforcing, including on a Core error. We fail open everywhere else so a Core
  // hiccup never blanks a board, but failing open on an AUTH check means no check at all.
  if (mode === 'enforce' && !role) {
    return { ok: false, mode: mode, error: err ? 'Access check unavailable' : 'No access to Sales', code: 'no_access' };
  }
  return { ok: true, mode: mode, role: role || null, would_refuse: !role };
}

function recordGuard_(props, entry) {
  try {
    const ring = JSON.parse(props.getProperty(GX_WRITE_GUARD_LOG) || '[]');
    // Dates in this suite are TEXT, never Date objects.
    entry.ts = Utilities.formatDate(new Date(), 'America/Los_Angeles', "yyyy-MM-dd'T'HH:mm:ss");
    ring.push(entry);
    while (ring.length > GX_WRITE_GUARD_CAP) ring.shift();
    props.setProperty(GX_WRITE_GUARD_LOG, JSON.stringify(ring));

    // COUNTERS ALONGSIDE THE RING, because they answer a question the ring cannot. The ring holds
    // detail for the last 25 decisions and then rolls — and the single most valuable record here is
    // the FIRST admit by a real non-superadmin, since that is the event that licenses flipping to
    // enforce. A batch of saves right after a grant lands would push it off the end. Counters are
    // monotonic, so "has a real user ever been admitted" and "did the gate start refusing everyone"
    // stay answerable as numbers long after the detail has rolled away.
    // Shape borrowed from pricecards via inventory so the suite reads the same way.
    const kind = entry.err ? 'error' : (entry.role ? 'admitted' : 'refused_no_grant');
    const tally = JSON.parse(props.getProperty(GX_WRITE_GUARD_TALLY) || '{}');
    tally[kind] = (tally[kind] || 0) + 1;
    // First admit is stamped once and never overwritten — it is the evidence, not a running value.
    if (kind === 'admitted' && !tally.first_admit) {
      tally.first_admit = { user: entry.user, role: entry.role, ts: entry.ts };
    }
    props.setProperty(GX_WRITE_GUARD_TALLY, JSON.stringify(tally));
  } catch (e) {
    // A diagnostic must never be the reason a write fails.
  }
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

// Phase-2 shared sign-on: validate through GXCore (which checks app access grant),
// with a local fallback so a GXCore hiccup never locks anyone out.
function loginUser(params) {
  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.login) {
      const r = GXCore.login(params.user, params.pass, 'sales');
      if (r && r.ok) return r;
      const local = _loginUserLocal_(params);
      if (local && local.ok) return local;
      return r;
    }
  } catch(e) {
    Logger.log('[Sales login/GXCore] ' + e.message);
  }
  return _loginUserLocal_(params);
}

function _loginUserLocal_(params) {
  if (!params.user || !params.pass) return { ok: false, error: 'Missing credentials' };
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key   = String(params.user).toLowerCase().trim();
  const hash  = hashPass_(String(params.pass));
  if (hasOwn_(users, key) && users[key] === hash) {
    return { ok: true, user: key, token: issueSessionToken_(key), expiresAt: new Date(Date.now() + GC_SESSION_TTL_MS).toISOString() };
  }
  return { ok: false, error: 'Invalid username or password' };
}

function doGet(e) {
  const params = e.parameter;

  // Serve the dashboard HTML when accessed with no parameters
  if (!params.action && !params.store) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Green Cross Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // ── Public actions (no token required) ──────────────────
  if (params.action === 'login') return jsonOut_(loginUser(params));

  // Temporary debug — protected by deploy secret
  if (params.action === 'debuglogin') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const r = GXCore.login(params.user || '__probe__', params.pass || '__probe__', 'sales');
      return jsonOut_({ gxcore: { ok: r.ok, user: r.user, role: r.role, error: r.error, hasToken: !!r.token } });
    } catch(e) {
      return jsonOut_({ gxcore: null, error: e.message });
    }
  }

  // Which GXCore snapshot is this deployment ACTUALLY running? A GXCore.x() call executes the version this
  // app PINS, and a deployment snapshots the manifest — so the pin in appsscript.json at HEAD tells you
  // nothing about the live app, and reading gx_core.gs tells you less. The only honest answer comes from
  // the live deployment asking the library itself. Ask this URL, not the repo, after every re-pin.
  // Guarded by the deploy secret like debuglogin: a Forbidden here means GX_DEPLOY_SECRET is unset or
  // stale on THIS script, which is its own finding — that same property gates qbReportViaGXCore_.
  /* Are the Dutchie credentials actually configured? Reports LABELS and a COUNT, never a value.
     Exists because the keys moved out of source into Script Properties on 2026-08-29: the property
     is invisible from outside the script, so "did the seed work?" had no answer short of pushing
     the new code and finding out in production. Deploy-secret gated, same as gxpin above. */
  if (params.action === 'storekeys') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const labels = Object.keys(getStoreKeys_()).sort();
    return jsonOut_({ ok: true, configured: labels.length > 0, count: labels.length, labels: labels });
  }

  if (params.action === 'gxpin') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      if (typeof GXCore === 'undefined' || !GXCore) return jsonOut_({ ok: false, error: 'GXCore binding missing' });
      // libVersion() landed in Core v153. Its absence is not an error — it dates the pin as older than that.
      const props = PropertiesService.getScriptProperties();
      // Which connector actually served the last uncached Expenses load, and whether the precondition
      // for using Core at all is even in place. qb_last_source is stamped by getExpenses on a cache miss.
      const qb = {
        secret_configured: !!secret,
        last_source: props.getProperty('QB_LAST_SOURCE') || null   // 'gxcore@<iso>' | 'local@<iso>' | null
      };
      if (typeof GXCore.libVersion !== 'function') {
        return jsonOut_({ ok: true, app: 'sales', gxcore_version: null, qb: qb, note: 'pinned Core predates libVersion() (added v153)' });
      }
      return jsonOut_({ ok: true, app: 'sales', gxcore_version: GXCore.libVersion(), qb: qb });
    } catch (e) {
      return jsonOut_({ ok: false, error: e.message });
    }
  }

  // Inventory's snippet, adopted as offered. gxpin answers the same question but is secret-gated;
  // this one is public and needs no session, which is the point — "what version am I running" should
  // cost nothing to ask right after a deploy, or nobody runs it. An old pin IDENTIFIES ITSELF here
  // rather than throwing, so the diagnostic still answers when it is most needed. Leaks one integer,
  // and Core's own action=health already publishes the matching side.
  if (params.action === 'libversion') {
    try {
      if (typeof GXCore === 'undefined' || !GXCore) return jsonOut_({ ok: false, error: 'GXCore not bound' });
      if (typeof GXCore.libVersion !== 'function') return jsonOut_({ ok: false, error: 'pinned GXCore has no libVersion() - pre-v153' });
      return jsonOut_({ ok: true, gxcore: GXCore.libVersion() });
    } catch (e) {
      return jsonOut_({ ok: false, error: e.message });
    }
  }

  // Two facts this app cannot settle by inspection, both secret-gated like gxpin.
  //
  // 1. THE SESSION SECRET FINGERPRINT. Core and every spoke read the SAME property name,
  //    GC_SESSION_SECRET, and each project AUTO-GENERATES a random value when it finds none set — so
  //    matching NAMES prove nothing about matching VALUES. Two projects can hold different secrets
  //    under one name and their tokens will never interoperate. A truncated SHA-256 compares the two
  //    without either side handing over a value. Core publishes 625516f184e4f203.
  //    Read the property DIRECTLY, never through sessionSecret_() — that helper MINTS a secret when
  //    it finds none, so a diagnostic built on it would create the very thing it claims to measure
  //    and then report a confident fingerprint for a brand-new value nobody shares.
  //
  // 2. WHETHER THE GRANT RE-CHECK IS AVAILABLE AND WHAT IT SAYS. roleForApp went public in Core
  //    v170. Pass &user= to see how Core answers for a REAL account before anything fails closed on
  //    it. A fail-closed auth check wired against a wrong assumption is an outage for every user of
  //    the app, not a quiet degradation, so the refusal path gets measured before it is trusted.
  if (params.action === 'authprobe') {
    const props0 = PropertiesService.getScriptProperties();
    const secret = props0.getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const out = { ok: true, app: 'sales' };
    try {
      const raw = PropertiesService.getScriptProperties().getProperty(GC_SESSION_SECRET_KEY) || '';
      out.session_secret_set = !!raw;
      out.session_fingerprint = raw
        ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)
            .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16)
        : null;
    } catch (e) {
      out.session_fingerprint_error = e.message;
    }
    // WHO WOULD A FAIL-CLOSED GRANT CHECK ACTUALLY LOCK OUT? Names only, never hashes. roleForApp
    // answered null for every account name I could guess, which has two very different causes —
    // nobody holds a sales grant in Core, or I was simply guessing the wrong ids — and they call for
    // opposite responses. Listing the ids this app really authenticates tells the two apart instead
    // of leaving a guess in a report.
    try {
      const uraw = PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}';
      out.local_users = Object.keys(JSON.parse(uraw));
    } catch (e) {
      out.local_users_error = e.message;
    }
    // WHAT CAN THIS PIN ACTUALLY CALL? Asked because the grant question above is unanswerable from
    // outside Core — no HTTP route enumerates who holds a grant — but we are a BOUND spoke, so
    // anything public on the library is callable from in here. Listing the surface says whether a
    // user/grant listing function exists at our pin instead of guessing route names over HTTP.
    if (params.surface) {
      try {
        out.gxcore_surface = Object.keys(GXCore).sort();
      } catch (e) {
        out.gxcore_surface_error = e.message;
      }
    }
    try {
      out.write_guard_mode = props0.getProperty(GX_WRITE_GUARD_KEY) || 'log';
      out.write_guard_log  = JSON.parse(props0.getProperty(GX_WRITE_GUARD_LOG) || '[]');
      out.write_guard_tally = JSON.parse(props0.getProperty(GX_WRITE_GUARD_TALLY) || '{}');
    } catch (e) {
      out.write_guard_error = e.message;
    }
    try {
      out.gxcore_version  = (typeof GXCore !== 'undefined' && GXCore && typeof GXCore.libVersion === 'function') ? GXCore.libVersion() : null;
      out.has_roleForApp  = !!(typeof GXCore !== 'undefined' && GXCore && typeof GXCore.roleForApp === 'function');
      if (out.has_roleForApp && params.user) {
        const u = String(params.user).toLowerCase().trim();
        out.role_for_user = { user: u, role: GXCore.roleForApp(u, 'sales') };
      }
    } catch (e) {
      out.gxcore_error = e.message;
    }
    return jsonOut_(out);
  }

  // Flip the write guard between log / enforce / off WITHOUT opening the editor. Secret-gated.
  // THE REASON THIS EXISTS IS ROLLBACK, NOT CONVENIENCE. GX_WRITE_GUARD arms a FAIL-CLOSED auth gate;
  // if it ever misbehaves, the fix must be seconds away and must not depend on anyone being at a
  // browser. A revert that requires opening the Apps Script editor is a revert that happens late.
  //
  // The accepted values are an ARRAY checked with indexOf, deliberately not an object checked with
  // MAP[value]. This app spent a session removing exactly that idiom after measuring six inherited
  // names passing a lookup gate; reintroducing it on the route that arms the auth gate would be a
  // poor joke. 'constructor' is not a mode.
  if (params.action === 'guardmode') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const MODES = ['log', 'enforce', 'off'];
    const want  = String(params.mode || '');
    if (MODES.indexOf(want) === -1) {
      return jsonOut_({ ok: false, error: 'mode must be one of ' + MODES.join(', '), got: want });
    }
    const props = PropertiesService.getScriptProperties();
    const was   = props.getProperty(GX_WRITE_GUARD_KEY) || 'log';
    props.setProperty(GX_WRITE_GUARD_KEY, want);
    return jsonOut_({ ok: true, app: 'sales', was: was, now: want });
  }

  // Heartbeat: renew a still-valid token to extend the session
  // ── pnlprobe — exercise the P&L path in the LIVE Apps Script runtime, without a session ──────
  // The `pnl` action sits behind the session gate, so the only way to run it is to be signed in with
  // a browser — which means the server-side half (qbProfitAndLoss_ by class, flattenPnlRows_, the
  // cache) can sit unexercised while everything around it looks verified. That is exactly the gap
  // this repo already fills with gxpin / authprobe / guardmode: secret-gated, read-only, and asked
  // OF the running deployment rather than inferred from the source.
  //
  // It does not re-implement anything. It calls getPnl and then checks the one property that says
  // the walk was correct: a P&L ties out. Income - COGS = Gross Profit, - Expenses = Net Operating
  // Income, + Net Other Income = Net Income, in EVERY class column. A structural bug in the tree
  // walk cannot leave those identities standing.
  if (params.action === 'pnlprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const out  = getPnl({ by: params.by || 'Classes', start: params.start, end: params.end, nocache: '1' });
      const data = JSON.parse(out.getContent());
      if (data.error) return jsonOut_({ ok: false, stage: 'getPnl', error: data.error });

      const at = (label) => (data.rows || []).find(r => r.label === label);
      const val = (label, i) => { const r = at(label); return r ? (r.values[i] || 0) : 0; };
      const checks = [];
      (data.columns || []).forEach((col, i) => {
        const gp  = val('Total Income', i) - val('Total Cost of Goods Sold', i);
        const noi = gp - val('Total Expenses', i);
        const ni  = noi + val('Net Other Income', i);
        checks.push({
          column: col,
          gross_profit:         Math.abs(gp  - val('Gross Profit', i))         < 0.005,
          net_operating_income: Math.abs(noi - val('Net Operating Income', i)) < 0.005,
          net_income:           Math.abs(ni  - val('Net Income', i))           < 0.005,
          reported_net_income:  val('Net Income', i)
        });
      });
      const failed = checks.filter(c => !c.gross_profit || !c.net_operating_income || !c.net_income);
      return jsonOut_({
        ok: failed.length === 0,
        ran_in: 'apps script runtime',
        by: data.by, start: data.start, end: data.end,
        qb_source: data.qb_source, qb_fallback_reason: data.qb_fallback_reason,
        columns: data.columns, rows: (data.rows || []).length,
        kinds: (data.rows || []).reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {}),
        ties_out: failed.length === 0, failed_columns: failed
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }

  // Runs the REAL deposits path in the live Apps Script runtime with no session, the same trick and
  // the same reason as pnlprobe: getDeposits sits behind the login gate, so without this the only
  // way to know whether it works in production is to open a browser and log in — and a check that
  // inconvenient is a check nobody runs after a deploy. Secret-gated, read-only, returns a SHAPE
  // summary rather than the money.
  if (params.action === 'reconprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const out  = getDeposits({ start: params.start, end: params.end, nocache: '1' });
      const data = JSON.parse(out.getContent());
      if (data.ok === false) return jsonOut_({ ok: false, stage: 'getDeposits', error: data.error });
      const byStore = data.deposits || {};
      const rows = Object.keys(byStore).map(function (k) {
        const list = byStore[k];
        return {
          store: k, deposits: list.length,
          // The count that was 5x wrong before the lines were collapsed. If a deposit ever comes
          // back as one row per QB line again, this is where it shows.
          max_lines_folded: list.reduce(function (m, r) { return Math.max(m, r.lines || 0); }, 0),
          total: Math.round(list.reduce(function (a, r) { return a + r.amount; }, 0) * 100) / 100,
          first: list.length ? list[0].date : null,
          last:  list.length ? list[list.length - 1].date : null
        };
      }).sort(function (a, b) { return a.store < b.store ? -1 : 1; });
      // The MEMO VOCABULARY, counted over the window. Reconcile only wants the Dutchie sales
      // banking; a "Printer Ink (refund)" line carrying the store's class is not that. Deciding
      // which memos mean sales has to be READ OFF THE REAL DATA rather than guessed, because
      // guessing wrong in the generous direction quietly folds non-sales money into a store's week,
      // and guessing wrong the other way strands real banking on the not-included list. Reports
      // memo strings and how often each occurs — no amounts.
      const memoTally = {};
      Object.keys(byStore).forEach(function (k) {
        byStore[k].forEach(function (r) {
          String(r.memo || '(none)').split(' · ').forEach(function (m) {
            const key = m.trim() || '(none)';
            memoTally[key] = (memoTally[key] || 0) + 1;
          });
        });
      });
      const memos = Object.keys(memoTally)
        .map(function (m) { return { memo: m, seen: memoTally[m] }; })
        .sort(function (a, b) { return b.seen - a.seen; });
      // The SALES half, sampled in the same breath. The expected figure on every card is
      // Net Sales + TAX, and per-day tax was only added to the daily records for this feature — it
      // used to be summed into the store-month total and dropped from the rows. That change touches
      // the SHARED aggregation path every tab reads, so it is worth proving in production rather
      // than inferring from a green test. Reports the shape, not the money.
      let sales = null;
      if (params.store && storeKey_(params.store)) {
        const sr = JSON.parse(getStoreSales_(params.store, data.start, data.end).getContent());
        const daily = sr.daily || [];
        const withTax = daily.filter(function (d) { return typeof d.tax === 'number'; });
        sales = {
          store: params.store, days: daily.length,
          days_carrying_tax: withTax.length,
          // If this is false the Reconcile tab silently understates every week by the tax.
          every_day_carries_tax: daily.length > 0 && withTax.length === daily.length,
          // The per-day tax must add up to the store-month total the response already reported.
          daily_tax_sum: Math.round(daily.reduce(function (a, d) { return a + (d.tax || 0); }, 0) * 100) / 100,
          reported_tax: sr.tax,
          daily_net_sum: Math.round(daily.reduce(function (a, d) { return a + (d.netSales || 0); }, 0) * 100) / 100,
          // What a Reconcile card would show as Expected for this window: Net Sales + Tax.
          expected: Math.round(daily.reduce(function (a, d) { return a + (d.netSales || 0) + (d.tax || 0); }, 0) * 100) / 100,
          sample: daily.length ? daily[0] : null
        };
        sales.tax_ties_out = Math.abs(sales.daily_tax_sum - (sr.tax || 0)) < 0.02;
      }

      return jsonOut_({
        ok: true, ran_in: 'apps script runtime', start: data.start, end: data.end,
        stores: rows, sales: sales,
        store_deposits: rows.reduce(function (a, r) { return a + r.deposits; }, 0),
        unattributed: (data.unattributed || []).map(function (u) {
          return { date: u.date, class: u.class, amount: u.amount, memo: u.memo };
        }),
        memos: memos,
        week_starts: data.config
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }

  // Runs the REAL period-goal path in the live runtime with no session, the same trick and the same
  // reason as pnlprobe/reconprobe: getPeriodGoalsForDate_ sits behind the login gate, so after a
  // GXCore re-pin the only way to prove the PINNED library resolves a date to the right pay period
  // is to open a browser and log in — and a check that inconvenient is a check nobody runs after a
  // deploy. Secret-gated, read-only, returns exactly what the app would render.
  if (params.action === 'goalprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return getPeriodGoalsForDate_(params.date);
  }

  // Same trick and same reason as goalprobe, one range wide: the range route sits behind the login
  // gate, so proving a re-pin still rolls periods up correctly would otherwise mean opening a
  // browser. It is also the only way to see uncovered_days/truncated without a session.
  if (params.action === 'goalrangeprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return getPeriodGoalsRange_(params.start, params.end);
  }

  if (params.action === 'ping') {
    const pAuth = requireAuth_(params);
    if (!pAuth.ok) return jsonOut_({ ok: false, error: pAuth.error });
    const newExp = Date.now() + GC_SESSION_TTL_MS;
    const payload = pAuth.user + ':' + newExp;
    return jsonOut_({ ok: true, token: payload + ':' + signSession_(payload), expiresAt: new Date(newExp).toISOString() });
  }

  // ── Auth gate — all data actions require a valid session ─
  const auth = requireAuth_(params);
  if (!auth.ok) return jsonOut_({ ok: false, error: auth.error, code: 401 });

  if (params.action === 'stores')      return getStoresMeta_();
  if (params.action === 'goals')       return getGoals();
  if (params.action === 'period_goals') return getPeriodGoalsForDate_(params.date);
  if (params.action === 'period_goals_range') return getPeriodGoalsRange_(params.start, params.end);
  if (params.action === 'pace')        return getPacingFracs_();
  if (params.action === 'save_expense_mapping') { const g = writeGuard_(auth.user, 'save_expense_mapping'); if (!g.ok) return jsonOut_(g); return saveExpenseMapping_(params); }
  if (params.action === 'expenses')    return getExpenses(params);
  if (params.action === 'pnl')         return getPnl(params);
  if (params.action === 'qbmapping')   return getQBMappingSheet();
  if (params.action === 'txfields')    return getTxFields(params);
  if (params.action === 'eodtest')     return getEodTest(params);
  if (params.action === 'sheetpreview')  return getSheetPreview(params);
  if (params.action === 'cogs_dutchie')  return jsonOut_(getCogsDutchie(params));
  if (params.action === 'expbudgets')    return getExpenseBudgets();
  if (params.action === 'otherrev')       return getOtherRevenue();
  if (params.action === 'set_otherrev')   { const g = writeGuard_(auth.user, 'set_otherrev'); if (!g.ok) return jsonOut_(g); return setOtherRevenue(params); }
  if (params.action === 'revenue_detail') return getRevenueDetail(params);
  if (params.action === 'set_revenue')    { const g = writeGuard_(auth.user, 'set_revenue'); if (!g.ok) return jsonOut_(g); return setRevenueLine(params); }
  if (params.action === 'clear_atm_cache') { const g = writeGuard_(auth.user, 'clear_atm_cache'); if (!g.ok) return jsonOut_(g); return clearAtmCache_(params, auth.user); }
  if (params.action === 'inventory')     return getInventory(params);
  if (params.action === 'invprobe')      return probeInventoryEndpoints(params);
  if (params.action === 'invfields')     return getInvFields(params);
  if (params.action === 'itemstest')     return getItemsTest(params);
  if (params.action === 'txdetail')      return getTxDetail(params);
  if (params.action === 'reportbug')     return reportBug_(params, auth.user);
  if (params.action === 'deposits')      return getDeposits(params);
  if (params.action === 'recon_config')  return getReconConfig(params);
  if (params.action === 'set_recon_config') { const g = writeGuard_(auth.user, 'set_recon_config'); if (!g.ok) return jsonOut_(g); return setReconConfig_(params); }
  if (params.action === 'set_recon')        { const g = writeGuard_(auth.user, 'set_recon');        if (!g.ok) return jsonOut_(g); return setRecon_(params, auth.user); }
  if (params.action === 'set_recon_assign') { const g = writeGuard_(auth.user, 'set_recon_assign'); if (!g.ok) return jsonOut_(g); return setReconAssign_(params); }

  const store = params.store;
  const from  = params.from;
  const to    = params.to;

  if (!store || !storeKey_(store)) return jsonOut_({ error: 'Unknown store: ' + store });

  return getStoreSales_(store, from, to);
}

function doPost(e) {
  const params = e.parameter || {};
  const auth = requireAuth_(params);
  if (!auth.ok) return jsonOut_({ ok: false, error: auth.error, code: 401 });

  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch(err) {}

  if (params.action === 'save_expense_mapping') { const g = writeGuard_(auth.user, 'save_expense_mapping:POST'); if (!g.ok) return jsonOut_(g); return saveExpenseMapping_(body); }
  return jsonOut_({ ok: false, error: 'Unknown POST action: ' + params.action });
}

// ── GX Core sales cache + live Dutchie split ──────────────────────────────────
// Settled days (yesterday and earlier) come from GXCore.getSalesDaily — fast,
// no Dutchie quota.  Today (intraday) still uses a live Dutchie transaction pull.

function getStoreSales_(store, from, to) {
  try {
    const todayPT  = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
    const fromDate = from.slice(0, 10);
    const toDate   = to.slice(0, 10);

    // Settled: [fromDate .. min(toDate, yesterday)]
    const settledTo = toDate < todayPT ? toDate : dayBefore_(todayPT);
    let cacheRows = [];
    if (fromDate <= settledTo) {
      // Version prefix (v3): bumped 2026-08-15 to bust stale entries after GXCore backfill (8/13–8/14 rows
      // were missing; proxy had cached the incomplete result for up to 1h). CacheService has no clear-all.
      const gasCacheKey = 'sdaily_v4_' + store + '_' + fromDate + '_' + settledTo;
      const hit = cacheGet_(gasCacheKey);
      if (hit) {
        cacheRows = JSON.parse(hit);
      } else {
        try {
          cacheRows = GXCore.getSalesDaily(store, fromDate, settledTo) || [];
          // 1-hour TTL (was 4h): getSalesDaily is authoritative + cheap, so retroactive returns / re-pull
          // corrections to settled days surface within the hour instead of lingering.
          cacheSet_(gasCacheKey, JSON.stringify(cacheRows), 3600);
        } catch(gxErr) {
          // GXCore hiccup — degrade to live-only (today's data still loads below)
          Logger.log('GXCore.getSalesDaily failed for ' + store + ': ' + gxErr.message);
        }
      }
    }

    // Live: today only (if the requested range includes today)
    const liveResult = toDate >= todayPT ? dutchieTodayFetch_(store, todayPT, to) : null;

    let net = 0, gros = 0, disc = 0, cogs = 0, tx = 0, ord = 0;
    const dailyMap = {}, weeklyMap = {};

    for (const r of cacheRows) {
      const rNet  = Number(r.net      || 0);
      const rGros = Number(r.gross    || 0);
      const rDisc = Number(r.discount || 0);
      const rTax  = Number(r.tax      || 0);
      const rCogs = Number(r.cogs     || 0);
      const rOrd  = Number(r.orders   || 0);
      net  += rNet; gros += rGros; disc += rDisc;
      cogs += rCogs; tx   += rTax;  ord  += rOrd;
      if (r.date) {
        dailyMap[r.date] = {
          netSales:   Math.round(rNet  * 100) / 100,
          grossSales: Math.round(rGros * 100) / 100,
          orders:     rOrd,
          discounts:  Math.round(rDisc * 100) / 100,
          cogs:       Math.round(rCogs * 100) / 100,
          // Per-day tax exists only because the Reconcile tab needs it: a bank deposit is
          // Net Sales + Tax for the days it covers, so a day-level total without tax cannot be
          // compared to one. It was summed into the store-month total already and dropped here.
          tax:        Math.round(rTax  * 100) / 100,
        };
        const wk = getISOWeek(new Date(r.date + 'T12:00:00')) - 1;
        weeklyMap['WK' + wk] = (weeklyMap['WK' + wk] || 0) + rNet;
      }
    }

    if (liveResult) {
      net  += liveResult.netSales;  gros += liveResult.grossSales;
      disc += liveResult.discounts; cogs += liveResult.cost;
      tx   += liveResult.tax;       ord  += liveResult.orders;
      for (const d of (liveResult.daily || [])) {
        dailyMap[d.date] = { netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts, cogs: d.cogs || 0, tax: d.tax || 0 };
        const wk = getISOWeek(new Date(d.date + 'T12:00:00')) - 1;
        weeklyMap['WK' + wk] = (weeklyMap['WK' + wk] || 0) + d.netSales;
      }
    }

    const weekly = Object.entries(weeklyMap)
      .sort((a, b) => Number(a[0].slice(2)) - Number(b[0].slice(2)))
      .map(([label, amount]) => ({ label, amount }));

    return jsonOut_({
      store, orders: ord,
      netSales:   Math.round(net  * 100) / 100,
      grossSales: Math.round(gros * 100) / 100,
      discounts:  Math.round(disc * 100) / 100,
      cost:       Math.round(cogs * 100) / 100,
      tax:        Math.round(tx   * 100) / 100,
      profit:     Math.round((net - cogs) * 100) / 100,
      aov:        ord > 0 ? Math.round(net / ord * 100) / 100 : 0,
      margin:     net > 0 ? Math.round((net - cogs) / net * 10000) / 100 : 0,
      weekly,
      topProducts: liveResult ? (liveResult.topProducts || []) : [],
      daily: Object.entries(dailyMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, d]) => ({ date, netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts, cogs: d.cogs || 0, tax: d.tax || 0 })),
      cacheRows:  cacheRows.length,
      liveOrders: liveResult ? liveResult.orders : 0,
    });
  } catch (err) {
    return jsonOut_({ error: err.message });
  }
}

// Live intraday Dutchie fetch — today only, same logic as the old full handler.
function dutchieTodayFetch_(store, todayPT, toISO) {
  const apiKey = storeKey_(store);
  const auth   = Utilities.base64Encode(apiKey + ':');
  // Wide lastModified window (approx Pacific midnight); filter by transaction date below.
  const fromUTC = todayPT + 'T07:00:00Z';
  const url = BASE + '/reporting/transactions'
    + '?fromLastModifiedDateUTC=' + encodeURIComponent(fromUTC)
    + '&toLastModifiedDateUTC='   + encodeURIComponent(toISO)
    + '&includeItems=true';

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
    muteHttpExceptions: true,
  });

  const raw  = JSON.parse(resp.getContentText());
  const rows = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

  const sales = rows.filter(r => {
    if (r.isVoid) return false;
    if ((r.transactionType || '').toLowerCase() !== 'retail') return false;
    const txDate = (r.transactionDateLocalTime || r.transactionDate || '').slice(0, 10);
    return txDate === todayPT;
  });

  let netSales = 0, grossSales = 0, discounts = 0, cost = 0, tax = 0;
  const dailyMap   = {};
  const productMap = {};

  for (const tx of sales) {
    // LOCKED canonical definitions — mirror GXCore.txNet / txDiscount / txCogs (nullish `??`, NOT truthy `||`,
    // and net now includes the `total` fallback that was missing here). See the Command Center's
    // GX_CONSOLIDATION_MAP.md 🔒 section. Kept inline for the intraday hot loop; settled days already read
    // GXCore.getSalesDaily. Intraday only. Keep in sync with GXCore.
    const net  = Number(tx.totalBeforeTax != null ? tx.totalBeforeTax : (tx.subtotal != null ? tx.subtotal : tx.total)) || 0;
    const disc = Number(tx.totalDiscount != null ? tx.totalDiscount : tx.discountTotal) || 0;
    const txTax= Number(tx.tax            || tx.taxAmount || 0);
    netSales   += net;
    grossSales += net + disc;
    discounts  += disc;
    tax        += txTax;

    const items = tx.items || tx.lineItems || tx.orderItems || [];
    for (const item of items) {
      const qty = Number(item.quantity != null ? item.quantity : (item.qty != null ? item.qty : 1)) || 1;
      if (!(item && item.isReturned)) {   // canonical txCogs excludes returned line items
        const itemCost = Number(item.costOfGoods != null ? item.costOfGoods : (item.cost != null ? item.cost : item.unitCost)) || 0;
        cost += itemCost * qty;
      }
      const name = item.productName || item.name || 'Unknown';
      const rev  = Number(item.totalPrice || item.price || item.lineTotal || 0);
      if (!productMap[name]) productMap[name] = { revenue: 0, units: 0 };
      productMap[name].revenue += rev;
      productMap[name].units   += qty;
    }

    const dateStr = (tx.transactionDateLocalTime || tx.transactionDate || '').slice(0, 10);
    if (dateStr) {
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { netSales: 0, grossSales: 0, orders: 0, discounts: 0, cogs: 0, tax: 0 };
      dailyMap[dateStr].netSales   += net;
      dailyMap[dateStr].grossSales += net + disc;
      dailyMap[dateStr].orders     += 1;
      dailyMap[dateStr].discounts  += disc;
      dailyMap[dateStr].tax        += txTax;   // Reconcile compares deposits to Net Sales + Tax
      // accumulate per-tx cost into the date bucket
      const txItems = tx.items || tx.lineItems || tx.orderItems || [];
      for (const item of txItems) {
        if (item && !item.isReturned) {
          const qty = Number(item.quantity != null ? item.quantity : (item.qty != null ? item.qty : 1)) || 1;
          const itemCost = Number(item.costOfGoods != null ? item.costOfGoods : (item.cost != null ? item.cost : item.unitCost)) || 0;
          dailyMap[dateStr].cogs += itemCost * qty;
        }
      }
    }
  }

  const topProducts = Object.entries(productMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([name, d]) => ({ name, revenue: d.revenue, units: d.units }));

  return {
    netSales:   Math.round(netSales   * 100) / 100,
    grossSales: Math.round(grossSales * 100) / 100,
    discounts:  Math.round(discounts  * 100) / 100,
    cost:       Math.round(cost       * 100) / 100,
    tax:        Math.round(tax        * 100) / 100,
    orders:     sales.length,
    topProducts,
    daily: Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({
        date,
        netSales:   Math.round(d.netSales   * 100) / 100,
        grossSales: Math.round(d.grossSales * 100) / 100,
        orders:     d.orders,
        discounts:  Math.round(d.discounts  * 100) / 100,
        cogs:       Math.round((d.cogs || 0) * 100) / 100,
        tax:        Math.round((d.tax  || 0) * 100) / 100,
      })),
  };
}

function dayBefore_(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
}

function getISOWeek(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getStoresMeta_() {
  const HIT = cacheGet_('stores_meta');
  if (HIT) return ContentService.createTextOutput(HIT).setMimeType(ContentService.MimeType.JSON);
  try {
    const rows = GXCore.getStores().map(function(s) {
      return {
        dutchie_name: s.dutchie_name,
        display_name: s.display_name,
        color:        s.color || '',
        sort_order:   Number(s.sort_order) || 0,
      };
    });
    const body = JSON.stringify({ stores: rows });
    cacheSet_('stores_meta', body, 3600); // 1-hour TTL — store list rarely changes
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    // GXCore hiccup — return empty list so frontend keeps its hardcoded fallback colors
    Logger.log('getStoresMeta_ GXCore.getStores failed: ' + e.message);
    return jsonOut_({ stores: [] });
  }
}

function getGoals() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('goals');
  if (cached) { output.setContent(cached); return output; }
  try {
    const ss    = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const sheet = ss.getSheets().find(s => s.getSheetId() === BUDGET_SHEET_GID);
    if (!sheet) throw new Error('Budget sheet not found (gid ' + BUDGET_SHEET_GID + ')');

    const STORE_NAMES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];
    const MONTHS_12   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const data  = sheet.getDataRange().getValues();
    const goals = {};

    for (const row of data) {
      const name = String(row[3] || '').trim();
      if (!STORE_NAMES.includes(name)) continue;
      goals[name] = {};
      MONTHS_12.forEach((m, i) => {
        goals[name][m] = Number(String(row[4 + i]).replace(/[$,]/g, '')) || 0;
      });
    }

    const content = JSON.stringify({ goals, year: BUDGET_YEAR });
    cacheSet_('goals', content, 3600); // 1 hour
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// Returns period goals (per-DOW targets) for all stores for a given date.
// Uses GXCore.getPeriodGoals which resolves any date to its pay period and
// returns the frozen goal. Keyed by Sales canonical store name.
function getPeriodGoalsForDate_(date) {
  if (!date) return jsonOut_({ ok: false, error: 'date required' });
  const STORE_MAP = [
    { dutchie: 'Bend',        sales: 'Bend'        },
    { dutchie: 'Center',      sales: 'Center'      },
    { dutchie: 'Commercial',  sales: 'Commercial'  },
    { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
    { dutchie: 'Portland Rd', sales: 'Portland Rd' },
    { dutchie: 'River Rd',    sales: 'River'       },
  ];
  try {
    const goals = {};
    for (const s of STORE_MAP) {
      try {
        const pg = GXCore.getPeriodGoals(s.dutchie, date);
        if (pg && pg.dow_targets) {
          goals[s.sales] = {
            period_start: pg.period_start,
            period_end:   pg.period_end,
            period_total: pg.period_total,
            dow_targets:  pg.dow_targets,
          };
        }
      } catch(e2) { /* store not in ledger yet — skip */ }
    }
    return jsonOut_({ ok: true, date, goals });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Dutchie name → Sales canonical key. Shared by getPeriodGoalsForDate_ and the range route below so
// the two cannot drift into disagreeing about what a store is called.
const PG_STORE_MAP_ = [
  { dutchie: 'Bend',        sales: 'Bend'        },
  { dutchie: 'Center',      sales: 'Center'      },
  { dutchie: 'Commercial',  sales: 'Commercial'  },
  { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
  { dutchie: 'Portland Rd', sales: 'Portland Rd' },
  { dutchie: 'River Rd',    sales: 'River'       },
];

const PG_RANGE_MAX_DAYS_ = 400; // a full year plus slack — bounds the walk below

/**
 * Sales store name keyed by GX Core canonical store_id, resolved through the registry.
 *
 * Needed because the store-less getPeriodGoals below returns rows keyed by the period_goals tab's
 * ALIASES — `century`, `baseline`, `portland` — not by anything Sales calls a store. `store_id` is
 * the canonical form Core resolves both sides to, so it is the only safe join key. Resolved live
 * rather than hardcoded as a third store table in this file: a spelling added in Command Center
 * flows through, and an unknown name drops out instead of guessing.
 */
function pgStoreIdMap_() {
  const cached = cacheGet_('pg_storeids');
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  const map = {};
  for (const s of PG_STORE_MAP_) {
    try {
      const row = GXCore.resolveStore(s.dutchie);
      if (row && row.store_id) map[String(row.store_id).toLowerCase()] = s.sales;
    } catch (e) { /* unknown to the registry — it simply will not match, which is the safe direction */ }
  }
  if (Object.keys(map).length) cacheSet_('pg_storeids', JSON.stringify(map), 21600);
  return map;
}

/**
 * The first and last date the period_goals ledger covers, as { min, max }, or null if unknowable.
 *
 * One call with BOTH arguments empty returns every row in the tab, and the min/max of period_start
 * and period_end is all this needs. That makes an out-of-range walk free instead of spending its
 * whole MISS_LIMIT budget discovering, one probe at a time, that the ledger does not go there —
 * measured 22.5s for a 2027 range, which is 14 probes at ~1.6s each because every getPeriodGoals
 * call re-reads the whole tab.
 *
 * Only period_start/period_end are read here, never a goal value and never a tie-break. That matters:
 * `rows` is the RAW audit view, orphans included, and picking a goal out of it by hand is precisely
 * the `match[0]`-in-sheet-order bug that forced the v220 re-pin. An orphan row can only WIDEN these
 * bounds, which costs a wasted probe and never a missed period — the safe direction.
 */
function pgCoverageBounds_() {
  const cached = cacheGet_('pg_bounds');
  if (cached) { try { const b = JSON.parse(cached); return b.min ? b : null; } catch (e) {} }
  try {
    const all  = GXCore.getPeriodGoals('', '');
    const rows = (all && all.rows) || [];
    let min = '', max = '';
    for (const r of rows) {
      const ps = String(r.period_start || ''), pe = String(r.period_end || ps);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ps)) continue;
      if (!min || ps < min) min = ps;
      if (!max || pe > max) max = pe;
    }
    if (min && max) {
      const b = { min: min, max: max };
      cacheSet_('pg_bounds', JSON.stringify(b), 1800); // 30 min: the ledger GROWS, so do not pin it long
      return b;
    }
  } catch (e) { /* unknown bounds — fall back to probing, which is correct if slow */ }
  cacheSet_('pg_bounds', JSON.stringify({ min: '' }), 300);
  return null;
}

/**
 * One pay period's goals for every store, as { window, goals }.
 *
 * ONE store-less call, not six per-store ones. getPeriodGoals re-reads the whole period_goals tab on
 * every call, so asking per store meant six full tab reads per period — measured on the deployed
 * route, a cold YTD (18 periods) took 42 seconds. The store-less form returns `picked`: the best row
 * PER STORE for the period, by the same tie-break the single-store branch uses, which is exactly
 * this shape with none of the repetition.
 *
 * The per-store loop is kept as a fallback, not as dead code: it is the path this route shipped on,
 * and if `picked` ever changes shape the range views should get slower rather than silently empty.
 */
function pgLoadPeriod_(date, byStoreId) {
  const out = { window: null, goals: {} };
  try {
    const all    = GXCore.getPeriodGoals('', date);
    const picked = all && all.picked;
    // An ANSWER of "no rows" is not a shape failure. `{ok:true, picked:[]}` is Core stating there is
    // no pay period covering this date, which is the normal reply for anything outside the ledger —
    // and outside it is where the walk spends every one of its MISS_LIMIT probes. Falling through to
    // the per-store loop on an empty array made a miss cost SEVEN calls instead of one, measured at
    // 39s for the 123 uncovered days after 2026-08-30. Only an exception or an unrecognisable shape
    // earns the fallback.
    if (Array.isArray(picked) && !picked.length) return out;
    if (picked && picked.length) {
      for (const r of picked) {
        const sales = byStoreId[String(r.store_id || '').toLowerCase()];
        if (!sales || !r.dow_targets || r.dow_targets.length !== 7) continue;
        // Pin to the FIRST period seen and skip any row describing a different window. Stores should
        // share a pay period, but "should" is not a guarantee, and caching one store's targets under
        // another store's date range is the kind of off-by-a-period nobody would spot in a total.
        if (!out.window) out.window = { start: r.period_start, end: r.period_end };
        if (r.period_start !== out.window.start || r.period_end !== out.window.end) continue;
        out.goals[sales] = { period_total: r.period_total, dow_targets: r.dow_targets };
      }
      if (out.window && Object.keys(out.goals).length) return out;
    }
  } catch (e) { /* fall through to the per-store path */ }

  out.window = null; out.goals = {};
  for (const s of PG_STORE_MAP_) {
    try {
      const pg = GXCore.getPeriodGoals(s.dutchie, date);
      if (pg && pg.dow_targets) {
        out.goals[s.sales] = { period_total: pg.period_total, dow_targets: pg.dow_targets };
        if (!out.window) out.window = { start: pg.period_start, end: pg.period_end };
      }
    } catch (e2) { /* store not in the ledger for this period — skip, same as the day route */ }
  }
  return out;
}

/**
 * Every pay period overlapping [start, end], each with its frozen per-DOW targets.
 *
 * The client needs this because only the DAY view reads frozen period goals; week, month and YTD
 * read the budget spreadsheet, and the two disagree — measured over Jan–Jul 2026, by +7.2%
 * ($337k), and for Portland Rd by ~40% every month. Asking per date would be 365 × 6 GXCore calls
 * for a YTD view, so this returns PERIODS and lets the client expand them to dates itself, exactly
 * as getDailyGoal already does with dow_targets.
 *
 * Walk, don't guess: period boundaries come from GXCore, never from arithmetic on a 14-day cadence.
 * They have moved before — the DST rows that made March 2026 a 15-day window are what forced the
 * v220 re-pin — so a client-side stride would silently mis-bucket exactly the dates that matter.
 *
 * A frozen period never changes, so each one is cached on its own key rather than the range being
 * cached as a whole: overlapping ranges (Aug, then YTD) then share every period they have in common
 * instead of re-fetching from scratch.
 */
function getPeriodGoalsRange_(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return jsonOut_({ ok: false, error: 'start and end required as YYYY-MM-DD' });
  }
  if (end < start) return jsonOut_({ ok: false, error: 'end is before start' });

  const dayMs = 86400000;
  // Noon UTC, not midnight: these are date-only strings and the script timezone is Pacific, so a
  // midnight anchor lands on the previous day and every window shifts by one. Same reason the suite
  // stores dates as TEXT.
  const at    = s => new Date(s + 'T12:00:00Z').getTime();
  const iso   = t => new Date(t).toISOString().slice(0, 10);

  if ((at(end) - at(start)) / dayMs + 1 > PG_RANGE_MAX_DAYS_) {
    return jsonOut_({ ok: false, error: 'range exceeds ' + PG_RANGE_MAX_DAYS_ + ' days' });
  }

  const bounds    = pgCoverageBounds_();
  const byStoreId = pgStoreIdMap_();
  const periods = [];
  let cursor    = at(start);
  const last    = at(end);
  let uncovered = 0;

  // An uncovered date costs six live GXCore calls to establish, and coverage is a contiguous run
  // that begins ~Nov 2025 and extends forward — so a long miss streak means the range starts before
  // the ledger does, not that it is pocked with holes. Without this, asking for 2025 YTD walks 365
  // days at six calls each and times the request out. After a month of nothing, stop probing and
  // report the remainder uncovered; the client shows no goal either way.
  // One pay period. A gap longer than that is not a hole in the ledger, it is the edge of it —
  // measured 2026-08-29, coverage runs contiguously from ~Nov 2025 forward with no interior gaps.
  // 14 rather than 31 halves the worst-case probe cost, which is the whole point of the guard: a
  // fully uncovered year still costs 14 x 6 live calls before it gives up.
  const MISS_LIMIT = 14;
  let misses = 0, everTruncated = false;

  while (cursor <= last) {
    const date = iso(cursor);

    // Outside the ledger's known span, BEFORE touching the cache. Nothing can be found there and
    // nothing can be cached there, so both the probe and the lookup are pure cost. cacheGet_ is two
    // CacheService round-trips per date, which is what actually made an out-of-range walk slow: with
    // the probe already skipped, a 182-day 2028 range still took 12-22s in 364 cache reads. It is
    // also not `truncated` — that word means the walk gave up guessing, and this is the opposite:
    // Core told us where the ledger ends, so these misses are certain and cost no probe budget.
    if (bounds && (date < bounds.min || date > bounds.max)) {
      uncovered++;
      cursor += dayMs;
      continue;
    }

    const cached = cacheGet_('pgp_' + date);
    let period   = cached ? JSON.parse(cached) : null;
    if (period && period.none) period = null;

    if (!period && !cached && misses < MISS_LIMIT) {
      const loaded = pgLoadPeriod_(date, byStoreId);
      const goals  = loaded.goals;
      const window = loaded.window;
      if (window) {
        period = { period_start: window.start, period_end: window.end, goals: goals };
        // Cache under EVERY date the period covers, not just the one asked for: the next range that
        // starts mid-period must hit the same entry, or the walk pays for it again.
        const pEnd = at(period.period_end);
        for (let t = at(period.period_start); t <= pEnd; t += dayMs) {
          cacheSet_('pgp_' + iso(t), JSON.stringify(period), 21600); // 6h — the period itself is frozen
        }
      } else {
        // Cache the miss too, on a shorter TTL than a hit: a date before the ledger starts will
        // still be before it in an hour, but a date the producer has yet to publish should not stay
        // negative for six hours after it lands.
        cacheSet_('pgp_' + date, JSON.stringify({ none: true }), 1800);
      }
    }

    if (!period) {
      // No pay period covers this date. GX Core's period_goals do not begin until ~Nov 2025, so this
      // is the normal answer for older dates — report it rather than letting the client mistake a
      // partial sum for a whole one.
      uncovered++;
      if (++misses >= MISS_LIMIT) everTruncated = true;
      cursor += dayMs;
      continue;
    }

    misses = 0;
    periods.push(period);
    cursor = at(period.period_end) + dayMs;
  }

  return jsonOut_({
    ok: true, start: start, end: end, periods: periods,
    uncovered_days: uncovered,
    // The ledger span this walk trusted, echoed so a slow range can be diagnosed from outside. null
    // means the bounds lookup failed and every date was probed; a max far in the future means an
    // orphan row widened it, which costs probes without ever costing correctness.
    bounds: bounds,
    // STICKY: true if the walk ever stopped probing on the miss streak, not merely if it was still
    // in one when the range ended. Read live 2026-08-29 for all of 2025, the non-sticky version
    // reported false after a cached December period reset the counter — so it said "fully probed"
    // about a walk that had skipped ten months. `uncovered_days` is a floor whenever this is true.
    truncated: everTruncated,
  });
}

function getPacingFracs_() {
  const now    = new Date();
  const hour   = now.getHours();
  const minute = now.getMinutes();
  const STORE_MAP = [
    { dutchie: 'Bend',        sales: 'Bend'        },
    { dutchie: 'Center',      sales: 'Center'      },
    { dutchie: 'Commercial',  sales: 'Commercial'  },
    { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
    { dutchie: 'Portland Rd', sales: 'Portland Rd' },
    { dutchie: 'River Rd',    sales: 'River'       },
  ];
  const fracs = {};
  for (const s of STORE_MAP) {
    try {
      const frac = GXCore.expectedSalesFrac(s.dutchie, hour, minute);
      if (typeof frac === 'number' && frac >= 0) fracs[s.sales] = frac;
    } catch(e) { /* store not in shape table yet — skip */ }
  }
  return jsonOut_({ ok: true, fracs, hour, minute });
}



// ── QuickBooks Expenses ───────────────────────────────────────────────────────

// Section summaries: when matched, add the total and DON'T recurse into children
// Keys are the section name after stripping "Total " or "Total for "
const QB_SUMMARY_MAP_ = {
  'COST OF GOODS SOLD':             'COGS',
  'COGS - SUPPLIES & MATERIALS':    'COGS - Supplies & Materials',
  'PAYROLL EXPENSES':               'Payroll Expenses',
  'PURCHASED MATERIALS FOR RESALE': 'COGS',
  'INSURANCE EXPENSE':              'Insurance Expense',
  'PROFESSIONAL FEES':              'Professional Fees',
  'TAXES PAID':                     'Taxes',
  'SOFTWARE':                       'Software',
};

// Individual leaf rows: always captured directly by account name
// REPAIRS & MAINTENANCE is intentionally NOT in QB_SUMMARY_MAP_ so we recurse
// into its sub-items and split GENERAL (Management) from the rest
const QB_DETAIL_MAP_ = {
  'ADVERTISING & PROMOTION':   'Advertising & Promotion',
  'BANK SERVICE CHARGE':       'Bank Service Charge',
  'BUILDING':                  'Repairs & Maintenance',
  'EQUIPMENT':                 'Repairs & Maintenance',
  'GARBAGE':                   'Utilities / Garbage',
  'GENERAL':                   'Management',
  'INTEREST EXPENSE':          'Interest Expense',
  'INTERNET & PHONE':          'Internet & Phone',
  'LICENSES':                  'Licenses',
  'MEALS & ENTERTAINMENT':     'Meals & Entertainment',
  'MISCELLANEOUS EXPENSE':     'Miscellaneous',
  'OFFICE SUPPLIES':           'Office Supplies',
  'PEST CONTROL':              'Repairs & Maintenance',
  'POSTAGE':                   'Office Supplies',
  'RENT EXPENSE':              'Rent Expense',
  'SCALES':                    'Repairs & Maintenance',
  'SECURITY SYSTEMS':          'Security Monitoring',
  'SOFTWARE':                  'Software',
  'START UP EXPENSES':         'Startup Expense',
  'TELEPHONE EXPENSE':         'Internet & Phone',
  'TRAVEL':                    'Travel',
  'UNCATEGORIZED EXPENSE':     'Miscellaneous',
  'UTILITIES':                 'Utilities / Garbage',
};

// Loads custom QB→dashboard mappings and ignored accounts from ScriptProperties.
function getExpenseMapConfig_() {
  const props = PropertiesService.getScriptProperties();
  let custom = {}, ignored = [];
  try { custom  = JSON.parse(props.getProperty('expense_map')     || '{}'); } catch(e) {}
  try { ignored = JSON.parse(props.getProperty('expense_ignored') || '[]'); } catch(e) {}
  return { custom, ignored: new Set(ignored) };
}

// Saves QB→dashboard mappings submitted from the in-app mapping tool.
// mappings JSON: { QB_RAW_UPPER: dashCat | '__ignore__' | '' }
// '' = revert to hardcoded (remove custom), '__ignore__' = suppress from expenses + unmapped
function saveExpenseMapping_(params) {
  let mappings;
  const raw = params.mappings;
  try {
    mappings = (raw && typeof raw === 'object') ? raw : JSON.parse(raw || '{}');
  } catch(e) {
    return jsonOut_({ ok: false, error: 'Invalid mappings JSON' });
  }
  const props = PropertiesService.getScriptProperties();
  let custom = {}, ignored = [];
  try { custom  = JSON.parse(props.getProperty('expense_map')     || '{}'); } catch(e) {}
  try { ignored = JSON.parse(props.getProperty('expense_ignored') || '[]'); } catch(e) {}
  const ignoredSet = new Set(ignored);
  for (const [qb, cat] of Object.entries(mappings)) {
    if (cat === '__ignore__') { ignoredSet.add(qb); delete custom[qb]; }
    else if (!cat)            { delete custom[qb];  ignoredSet.delete(qb); }
    else                      { custom[qb] = cat;   ignoredSet.delete(qb); }
  }
  props.setProperty('expense_map',     JSON.stringify(custom));
  props.setProperty('expense_ignored', JSON.stringify([...ignoredSet]));
  cacheDelete_('expenses_' + new Date().getFullYear() + '_v5');
  return jsonOut_({ ok: true });
}

// accounts is an ordered array; seenRaws is a Set for dedup across the tree.
// depth drives indentation in the mapping UI and increments on each recursive level.
// Pushing the parent entry BEFORE recursing ensures it appears above its children.
function walkQBRows_(rows, cols, result, accounts, seenRaws, mapConfig, depth) {
  depth = depth || 0;
  const custom  = mapConfig?.custom  || {};
  const ignored = mapConfig?.ignored || new Set();
  for (const row of (rows || [])) {
    let summaryMatched = false;

    // Section row — push parent first, then recurse into children
    if (row.Summary) {
      const summaryLabel = (row.Summary.ColData?.[0]?.value || '').replace(/^Total\s+(for\s+)?/i, '').trim();
      const raw  = summaryLabel.toUpperCase();
      const disp = (row.Header?.ColData?.[0]?.value || summaryLabel);
      const cat  = custom[raw] || QB_SUMMARY_MAP_[raw];
      if (cat && !ignored.has(raw)) {
        summaryMatched = true;
        if (result) {
          if (!result[cat]) result[cat] = {};
          cols.forEach((col, i) => {
            const v = parseFloat((row.Summary.ColData?.[i + 1]?.value || '').replace(/,/g, '')) || 0;
            if (col) result[cat][col] = (result[cat][col] || 0) + v;
          });
        }
      }
      // Always record section in accounts so the full QB tree appears in the mapping UI
      if (accounts && raw && !seenRaws.has(raw)) {
        seenRaws.add(raw);
        accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: cat || null, ignored: ignored.has(raw), hardcoded: !!QB_SUMMARY_MAP_[raw] && !custom[raw], isSection: true });
      }
    }

    // Recurse into children — depth+1, null result when parent summary already aggregated
    if (row.Rows?.Row) {
      walkQBRows_(row.Rows.Row, cols, summaryMatched ? null : result, accounts, seenRaws, mapConfig, depth + 1);
    }

    // Leaf data row (no Summary)
    if (row.ColData && !row.Summary) {
      const raw  = (row.ColData[0]?.value || '').trim().toUpperCase();
      const disp = (row.ColData[0]?.value || '').trim();
      if (!raw) continue;
      const cat       = custom[raw] || QB_DETAIL_MAP_[raw];
      const isIgnored = ignored.has(raw);
      if (cat && !isIgnored) {
        if (result) {
          if (!result[cat]) result[cat] = {};
          cols.forEach((col, i) => {
            const v = parseFloat((row.ColData[i + 1]?.value || '').replace(/,/g, '')) || 0;
            if (col) result[cat][col] = (result[cat][col] || 0) + v;
          });
        }
        if (accounts && !seenRaws.has(raw)) {
          seenRaws.add(raw);
          accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: cat, ignored: false, hardcoded: !!QB_DETAIL_MAP_[raw] && !custom[raw], isSection: false });
        }
      } else if (accounts) {
        const hasVal = cols.some((_, i) => Math.abs(parseFloat((row.ColData[i + 1]?.value || '').replace(/,/g, '')) || 0) > 0.01);
        if (hasVal && !seenRaws.has(raw)) {
          seenRaws.add(raw);
          accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: null, ignored: isIgnored, hardcoded: false, isSection: false });
        }
      }
    }
  }
}

// QB Profit & Loss raw report. GX Core's connector is now the ONLY path — Core is the sole owner of the
// QuickBooks token. The local-token fallback was retired 2026-08-24 after gxpin showed last_source
// gxcore@ across four days and a v153 -> v213 re-pin, i.e. the fallback had gone unused.
//
// It fails LOUD on purpose. The fallback existed to keep Expenses alive through the cutover, and the cost
// was that it could not report the cutover had not happened: a misnamed GX_DEPLOY_SECRET kept the tab
// rendering off the legacy token for an unknown stretch while this file read as if it were centralized.
// An error here is a worse afternoon than a silently wrong number is; a silently wrong number is a worse
// quarter. Keep the throw.
//
// Returns { report, source, fallback_reason } — the shape getExpenses and qb_source depend on. `source` is
// constant today and stays anyway: it is what made the regression visible, and a second connector would
// need it back.
function qbProfitAndLoss_(start, end, by) {
  by = by || 'Month';
  const r = qbReportViaGXCore_(start, end, by);
  // qbReportViaGXCore_ returns null for exactly one reason: no secret configured on this script.
  if (!r) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach the GX Core QuickBooks connector.');
  return { report: r, source: 'gxcore', fallback_reason: '' };
}

// Fetch the P&L through GX Core's centralized, health-instrumented QB connector (secret-gated qb_pnl route).
// Retries the intermittent Drive-HTML two-hop 404. Returns the raw QB report, or throws.
function qbReportViaGXCore_(start, end, by) {
  const GXCORE_EXEC = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) return null;   // no secret configured → caller throws; there is no local path any more
  const url = GXCORE_EXEC + '?action=qb_pnl&secret=' + encodeURIComponent(secret)
    + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end)
    + '&by=' + encodeURIComponent(by || 'Month');
  for (let i = 0; i < 5; i++) {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null; try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true && data.report) return data.report;
    if (data && data.ok === false) throw new Error(data.error || 'qb_pnl error');   // connected but errored → surface it; nothing to fall back TO
    Utilities.sleep(500);   // transient Drive-HTML miss → retry
  }
  throw new Error('qb_pnl unreachable after retries');
}


// ── Weekly deposit reconciliation ─────────────────────────────────────────────────────────────
//
// Shawn banks each store's week as one or more deposits; Sky checks that the deposit equals that
// store's Net Sales + Tax for the days it covers. Three things make this NOT a calendar-week sum:
//
//   1. The week does not start on Monday, and it differs BY STORE — some run Tue→Mon, some Wed→Tue,
//      because that is when the deposits happen. The boundary is CONFIGURED (see RECON_CFG_PROP),
//      not hardcoded, so a store whose deposit day moves is a settings change, not a deploy.
//   2. One week can have SEVERAL deposits — Commercial is routinely split 3 days + 4 days.
//   3. A deposit that spans month end gets split in two so the income lands in the right month.
//
// So the unit is a WEEK WINDOW per store, holding N deposits, and it balances when the deposits sum
// to the sales sum. Never assume one deposit per week.

const GXCORE_EXEC_ = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

// Reads real bank deposits out of QuickBooks THROUGH GX Core. Sales holds no QB token — the local
// path was deleted 2026-08-24 and must not come back — so this fails CLOSED exactly like
// qbReportViaGXCore_ does: a broken Reconcile tab is the intended failure, and it is strictly better
// than a tab that quietly shows sales with no deposits and reads as "nothing has been banked".
function qbDepositsViaGXCore_(start, end) {
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) throw new Error('GX_DEPLOY_SECRET not set on this script — cannot reach GX Core');
  const url = GXCORE_EXEC_ + '?action=qb_deposits&secret=' + encodeURIComponent(secret)
    + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
  for (let i = 0; i < 5; i++) {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null; try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true && Array.isArray(data.deposits)) return data.deposits;
    if (data && data.ok === false) throw new Error(data.error || 'qb_deposits error');
    Utilities.sleep(500);   // transient Drive-HTML miss → retry, same as the P&L bridge
  }
  throw new Error('qb_deposits unreachable after retries');
}

// Dates are TEXT end to end. Accepts only YYYY-MM-DD, else ''. Same rule and same reason as
// pnlDate_: parsing to a Date and reformatting is where a timezone mismatch shifts a day.
function reconDate_(v) {
  const t = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

// Adds n days to a YYYY-MM-DD string WITHOUT going through the script timezone. Date.UTC keeps the
// arithmetic in UTC and the result is sliced straight back to text, so no local offset can touch it.
function reconAddDays_(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Day of week for a YYYY-MM-DD, 0=Sun..6=Sat, in UTC for the same reason as above.
function reconDow_(dateStr) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

const RECON_CFG_PROP_   = 'RECON_CONFIG_V1';
const RECON_STATE_PROP_ = 'RECON_STATE_V1';

// Week-start weekday per store, 0=Sun..6=Sat. MEASURED, not assumed: read off Shawn's own deposit
// slips ("08.17.26 Deposits.xlsx", one tab per store, each stating its DEPOSIT DATE and the SALES
// DATE range that deposit covers). Bend and Hillsboro bank Tue→Mon on the Tuesday; the four Salem
// stores bank Wed→Tue on the Wednesday. Sky confirmed the pattern is the same every week.
//
// Still overridable per store from the tab — a deposit day that moves should be a dropdown, not a
// deploy — but the shipped defaults are now the real ones rather than a placeholder.
const RECON_WEEK_START_BY_STORE_ = {
  'Bend':        2,   // CENTURY   — Tue→Mon, deposited Tue
  'Hillsboro':   2,   // HILLSBORO — Tue→Mon, deposited Tue
  'Center':      3,   // CENTER    — Wed→Tue, deposited Wed
  'Commercial':  3,   // COMMERCIAL, the "South" tab — Wed→Tue, routinely split Wed-Sat + Sun-Tue
  'Portland Rd': 3,   // PORTLAND  — Wed→Tue, deposited Wed
  'River':       3,   // RIVER     — Wed→Tue, deposited Wed
};
const RECON_DEFAULT_WEEK_START_ = 3;   // a store not named above; Salem's pattern is the majority

function getReconConfig_() {
  let cfg = {};
  try { cfg = JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_CFG_PROP_) || '{}'); }
  catch (e) { cfg = {}; }
  const out = {};
  for (const name of Object.keys(getStoreKeys_())) {
    const v = Number(cfg[name]);
    if (Number.isInteger(v) && v >= 0 && v <= 6) { out[name] = v; continue; }
    out[name] = hasOwn_(RECON_WEEK_START_BY_STORE_, name)
      ? RECON_WEEK_START_BY_STORE_[name] : RECON_DEFAULT_WEEK_START_;
  }
  return out;
}

function getReconState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_STATE_PROP_) || '{}'); }
  catch (e) { return {}; }
}

// GET action=recon_config — the per-store week-start map, always complete for all six stores.
function getReconConfig(params) {
  return jsonOut_({ ok: true, config: getReconConfig_(), default_week_start: RECON_DEFAULT_WEEK_START_ });
}

// Write one store's week-start weekday. Validated against the canonical store list and an integer
// 0..6 — never used as an object key lookup on unvalidated input.
function setReconConfig_(params) {
  const store = String(params.store || '');
  const dow   = Number(params.week_start);
  // storeKey_ is the repo's own guard: an INHERITED name ('constructor', 'toString') resolves to
  // null instead of sailing through a bare truthiness check on STORE_KEYS[store].
  if (!storeKey_(store)) return jsonOut_({ ok: false, error: 'unknown store' });
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return jsonOut_({ ok: false, error: 'week_start must be an integer 0..6' });
  try {
    const cfg = getReconConfig_();
    cfg[store] = dow;
    PropertiesService.getScriptProperties().setProperty(RECON_CFG_PROP_, JSON.stringify(cfg));
    return jsonOut_({ ok: true, config: cfg });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Mark one store-week reconciled, or un-mark it. The key is store + window-start, which is stable
// even when the store's week-start setting changes later — a week already reconciled keeps the
// window it was reconciled under, recorded ON the record rather than re-derived from current config.
function setRecon_(params, user) {
  const store = String(params.store || '');
  const start = reconDate_(params.start);
  const end   = reconDate_(params.end);
  const on    = String(params.reconciled) !== 'false';
  if (!storeKey_(store)) return jsonOut_({ ok: false, error: 'unknown store' });
  if (!start || !end) return jsonOut_({ ok: false, error: 'start and end must be YYYY-MM-DD' });
  if (end < start)    return jsonOut_({ ok: false, error: 'end is before start' });
  try {
    const state = getReconState_();
    const key   = store + '|' + start;
    if (on) {
      state[key] = {
        store: store, start: start, end: end,
        expected: Math.round(Number(params.expected || 0) * 100) / 100,
        deposited: Math.round(Number(params.deposited || 0) * 100) / 100,
        by: String(user || ''), at: new Date().toISOString(),
      };
    } else {
      delete state[key];
    }
    PropertiesService.getScriptProperties().setProperty(RECON_STATE_PROP_, JSON.stringify(state));
    return jsonOut_({ ok: true, state: state });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

const RECON_ASSIGN_PROP_ = 'RECON_ASSIGN_V1';

function getReconAssign_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_ASSIGN_PROP_) || '{}'); }
  catch (e) { return {}; }
}

// Pin one deposit to a specific week window, overriding the default date rule.
//
// The default rule (see reconWindowForDeposit in index.html) says a deposit belongs to the most
// recent week that had already ENDED when it was made. That is right for an ordinary week and wrong
// for the two cases Sky called out: a deposit split across month end has its second half dated in
// the next month, and a week banked late drifts into the following window. Rather than guess harder,
// the guess is overridable and the override is what gets stored.
//
// An empty window clears the override and returns the deposit to the default rule.
function setReconAssign_(params) {
  const id     = String(params.deposit_id || '');
  const window = params.window ? reconDate_(params.window) : '';
  if (!id) return jsonOut_({ ok: false, error: 'deposit_id is required' });
  if (params.window && !window) return jsonOut_({ ok: false, error: 'window must be YYYY-MM-DD' });
  try {
    const a = getReconAssign_();
    if (window) a[id] = window; else delete a[id];
    PropertiesService.getScriptProperties().setProperty(RECON_ASSIGN_PROP_, JSON.stringify(a));
    return jsonOut_({ ok: true, assign: a });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// GET action=deposits — real QB deposits for a range, plus the reconciled-week history and the
// week-start config, so the tab can paint in one round trip.
//
// Deposits are attributed to a store by QB CLASS, using the SAME explicit map the P&L already uses.
// The class string is compared verbatim: no folding, no trailing-token stripping. A deposit whose
// class matches no store is NOT silently dropped — it comes back under `unattributed`, because in a
// lookup a miss is not a wrong bucket, it is a row that vanishes, and money that vanishes from a
// reconciliation screen is the exact failure this tab exists to prevent.
const RECON_STORE_BY_CLASS_ = {
  'CENTURY DR':    'Bend',
  'CENTER ST':     'Center',
  'COMMERCIAL ST': 'Commercial',
  'BASELINE ST':   'Hillsboro',
  'PORTLAND RD':   'Portland Rd',
  'RIVER RD':      'River',
};

function getDeposits(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const start = reconDate_(params && params.start);
    const end   = reconDate_(params && params.end);
    if (!start || !end) throw new Error('start and end are required, as YYYY-MM-DD');
    if (end < start)    throw new Error('end is before start');

    const cacheKey = 'deposits_' + start + '_' + end + '_v1';
    if (!params?.nocache) {
      const cached = cacheGet_(cacheKey);
      if (cached) { output.setContent(cached); return output; }
    }

    const raw   = qbDepositsViaGXCore_(start, end);
    const byStore = {};
    const unattributed = [];
    for (const dep of raw) {
      const date = reconDate_(dep && dep.date);
      if (!date) continue;
      const lines = Array.isArray(dep.lines) && dep.lines.length
        ? dep.lines
        : [{ class: '', amount: Number(dep.total || 0), memo: '' }];
      // COLLAPSE THE LINES BY CLASS FIRST. A real store deposit arrives as FIVE lines all carrying
      // the same class — "Sales 3% Tax", "Sales 17% Tax", "Med Sales", "Rec Sales", "Non MJ Sales" —
      // because that is how the revenue is broken out in QuickBooks. Measured on the live route over
      // 2026-08-01..08-25: 20 of 22 deposits are 5 lines, and NOT ONE spans more than one class.
      //
      // Pushing a record per LINE turned one trip to the bank into five rows under that store. The
      // week TOTAL still reconciled, because amounts sum either way — but the card listed five
      // deposits and any count was 5x out, and "Commercial banked ten times this week" reads as
      // broken faster than a wrong total would.
      //
      // Grouped by class rather than assumed one-per-deposit: a deposit CAN carry several stores.
      // That did not occur in the sample, so it is handled but not treated as the common case.
      const byClass = {};
      const order   = [];
      for (const ln of lines) {
        const cls = String(ln.class || '');
        if (!hasOwn_(byClass, cls)) { byClass[cls] = { amount: 0, memos: [] }; order.push(cls); }
        byClass[cls].amount += Number(ln.amount || 0);
        const memo = String(ln.memo || '').trim();
        if (memo) byClass[cls].memos.push(memo);
      }
      for (const cls of order) {
        const g = byClass[cls];
        // Own property only — an inherited key like 'constructor' must not resolve to a store.
        const store  = hasOwn_(RECON_STORE_BY_CLASS_, cls) ? RECON_STORE_BY_CLASS_[cls] : null;
        const rec = {
          id: String(dep.id || ''), date: date,
          amount: Math.round(g.amount * 100) / 100,
          class: cls, account: String(dep.account || ''),
          // The per-line memos are the tax/med/rec breakdown. Kept, not folded away — GX Core
          // deliberately did not collapse them upstream, and they are the obvious next thing to
          // want on this tab.
          memo: g.memos.join(' · '), lines: g.memos.length,
        };
        if (store) { (byStore[store] = byStore[store] || []).push(rec); }
        else       { unattributed.push(rec); }
      }
    }
    for (const k of Object.keys(byStore)) byStore[k].sort((a, b) => a.date.localeCompare(b.date));

    const content = JSON.stringify({
      ok: true, start: start, end: end,
      deposits: byStore, unattributed: unattributed,
      config: getReconConfig_(), state: getReconState_(), assign: getReconAssign_(),
    });
    cacheSet_(cacheKey, content, 900);   // 15 min — deposits land during the day
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.message }));
  }
  return output;
}


function getExpenses(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cacheKey = 'expenses_' + new Date().getFullYear() + '_v6';   // v6: response now carries qb_source
  if (!params?.debug && !params?.nocache) {
    const cached = cacheGet_(cacheKey);
    if (cached) { output.setContent(cached); return output; }
  }
  try {
    const today   = new Date();
    const yr      = today.getFullYear();
    const start   = yr + '-01-01';
    const end     = yr + '-' + String(today.getMonth() + 1).padStart(2, '0')
                        + '-' + String(today.getDate()).padStart(2, '0');

    // GX Core's connector is the single token owner and the only path; a failure here throws rather than
    // quietly serving numbers from somewhere else.
    const qb     = qbProfitAndLoss_(start, end);
    const report = qb.report;
    const raw    = JSON.stringify(report);
    // Park the answer where an unauthenticated caller can read it. Every QB path here is behind the
    // login gate, so without this the only way to learn which connector served the tab is to open
    // devtools while logged in — and a fact that inconvenient to check is a fact nobody checks.
    // Cache-miss only, so this writes at most twice an hour.
    try {
      PropertiesService.getScriptProperties()
        .setProperty('QB_LAST_SOURCE', qb.source + '@' + new Date().toISOString());
    } catch (e) { /* diagnostics must never break the tab */ }
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column titles e.g. ["Jan 2026", "Feb 2026", ...]
    const cols = (report.Columns?.Column || []).map(c => c.ColTitle || '').filter(Boolean);

    const mapConfig   = getExpenseMapConfig_();
    const allAccounts = []; // ordered, tree-structured
    const seenRaws    = new Set();
    const expenses    = {};
    walkQBRows_(report.Rows?.Row || [], cols, expenses, allAccounts, seenRaws, mapConfig, 0);

    // debug=true returns raw report for mapping verification
    if (params && params.debug === 'true') {
      output.setContent(raw);
      return output;
    }

    const unmappedCount = allAccounts.filter(a => !a.mapped_to && !a.ignored).length;

    const content = JSON.stringify({ expenses, columns: cols, allAccounts, unmappedCount,
                                     qb_source: qb.source, qb_fallback_reason: qb.fallback_reason });
    cacheSet_(cacheKey, content, 1800); // 30 min
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// ── Profit & Loss — the QB report rendered as QB renders it ────────────────────────────────────
// Deliberately NOT built on getExpenses. That path exists to force QB's chart of accounts through
// this app's OWN category map (QB_SUMMARY_MAP_ / QB_DETAIL_MAP_ + the user's custom overrides) and
// to DROP whatever it cannot map — which is the right behavior for a budget tab and the wrong
// behavior for a financial statement. A P&L that silently omits an unmapped account is not a P&L.
// So this walks the QB tree structurally instead: every row survives, in QB's own order, with QB's
// own subtotals, which is also what makes the output line up with the PDF Sky reads in QuickBooks.
//
// `by` is validated against an ARRAY with indexOf, not an object looked up by key — this app spent a
// session removing that idiom, because `MAP[value]` answers for 'constructor' and '__proto__' too.
const PNL_SUMMARIZE_BY_ = ['Classes', 'Month', 'Total'];

function getPnl(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const by = String((params && params.by) || 'Classes');
    if (PNL_SUMMARIZE_BY_.indexOf(by) === -1) {
      output.setContent(JSON.stringify({ error: 'bad by (want one of: ' + PNL_SUMMARIZE_BY_.join(', ') + ')' }));
      return output;
    }

    const today = new Date();
    const yr    = today.getFullYear();
    const start = pnlDate_(params && params.start) || (yr + '-01-01');
    const end   = pnlDate_(params && params.end)   || (yr + '-' + String(today.getMonth() + 1).padStart(2, '0')
                                                          + '-' + String(today.getDate()).padStart(2, '0'));

    const cacheKey = 'pnl_' + by + '_' + start + '_' + end + '_v1';
    if (!params?.nocache) {
      const cached = cacheGet_(cacheKey);
      if (cached) { output.setContent(cached); return output; }
    }

    const qb     = qbProfitAndLoss_(start, end, by);
    const report = qb.report;
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column 0 is the account-name column and carries no title; the rest are the money columns.
    const allCols = (report.Columns?.Column || []).map(c => c.ColTitle || '');
    const columns = allCols.slice(1);

    const rows = [];
    flattenPnlRows_(report.Rows?.Row || [], columns.length, rows, 0);

    const content = JSON.stringify({
      columns, rows,
      start, end,
      basis:    report.Header?.ReportBasis || '',
      currency: report.Header?.Currency || 'USD',
      by,
      qb_source: qb.source, qb_fallback_reason: qb.fallback_reason
    });
    cacheSet_(cacheKey, content, 1800); // 30 min, same as Expenses
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// Accepts only YYYY-MM-DD and returns it unchanged, else ''. Dates go into a URL that reaches QB, and
// this app's convention is that dates are TEXT end to end — never parsed into a Date and re-formatted,
// which is where a sheet/script timezone mismatch shifts them a day.
function pnlDate_(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Walk QB's nested report into a FLAT, ordered list — the render order is decided here, once, on the
// server, so the client never has to re-derive the shape of a financial statement.
//
// Each row is { label, depth, kind, group, values[] }:
//   kind 'header'  — a section's opening line ("Income", "TAXES PAID"); no numbers of its own
//   kind 'detail'  — an account line
//   kind 'total'   — a section's own subtotal ("Total Income")
//   kind 'grand'   — QB's computed lines (Gross Profit, Net Operating Income, Net Income)
// `group` carries QB's semantic tag (Income / COGS / GrossProfit / Expenses / NetIncome / …) so the
// client can rule off the statement lines without string-matching English labels.
function flattenPnlRows_(rows, colCount, out, depth) {
  const vals = (colData) => {
    const v = [];
    for (let i = 0; i < colCount; i++) {
      const raw = (colData?.[i + 1]?.value || '').replace(/,/g, '');
      const n   = parseFloat(raw);
      v.push(isNaN(n) ? null : n);   // null ≠ 0: QB prints blank for "no activity", and the PDF does too
    }
    return v;
  };

  for (const row of (rows || [])) {
    const group = row.group || '';

    // A section: optional header line, its children, then its own total line.
    if (row.Rows?.Row || row.Header || row.Summary) {
      const headLabel = (row.Header?.ColData?.[0]?.value || '').trim();
      if (headLabel) {
        out.push({ label: headLabel, depth, kind: 'header', group, values: vals(row.Header.ColData) });
      }

      if (row.Rows?.Row) {
        flattenPnlRows_(row.Rows.Row, colCount, out, headLabel ? depth + 1 : depth);
      }

      const sumLabel = (row.Summary?.ColData?.[0]?.value || '').trim();
      if (sumLabel) {
        // QB's standalone computed lines (Gross Profit, Net Income) arrive as a Summary with no
        // header and no children — they are the statement's rules, not a section's subtotal.
        const isGrand = !headLabel && !row.Rows?.Row;
        out.push({
          label: sumLabel,
          depth: isGrand ? 0 : depth,
          kind:  isGrand ? 'grand' : 'total',
          group, values: vals(row.Summary.ColData)
        });
      }
      continue;
    }

    // A leaf account line.
    if (row.ColData) {
      const label = (row.ColData[0]?.value || '').trim();
      if (!label) continue;
      out.push({ label, depth, kind: 'detail', group, values: vals(row.ColData) });
    }
  }
}

// Probes common Dutchie EOD/daily-summary endpoint patterns to find inventory cost
function getEodTest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const store  = params.store || 'River';
    const apiKey = storeKey_(store);
    const auth   = Utilities.base64Encode(apiKey + ':');
    const date   = params.date || '2026-04-20'; // use yesterday by default
    const today2 = new Date();
    const from   = new Date(today2.getFullYear(), today2.getMonth(), 1).toISOString().replace('.000','');
    const to     = today2.toISOString().replace('.000','');

    // Probe endpoints that might expose product-level sold qty or cost
    const paths = [
      // Dedicated sales / product-performance endpoints
      ['/reporting/sales', '?fromDate=' + date + '&toDate=' + date],
      ['/reporting/sales', '?startDate=' + date + '&endDate=' + date],
      ['/reporting/product-performance', '?fromDate=' + date + '&toDate=' + date],
      ['/reporting/product-performance', ''],
      ['/reporting/daily-summary', '?date=' + date],
      ['/reporting/daily-summary', ''],
      ['/reporting/sales-summary', '?date=' + date],
      // Inventory adjustments — could show outbound movements
      ['/reporting/inventory-adjustments', '?fromLastModifiedDateUTC=' + encodeURIComponent(from)],
      ['/reporting/adjustments', '?fromDate=' + date],
    ];
    const results = {};
    for (const [path, qs] of paths) {
      const resp = UrlFetchApp.fetch(BASE + path + qs, {
        method: 'get',
        headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
        muteHttpExceptions: true,
      });
      const code = resp.getResponseCode();
      // For 200s grab more content to see fields; for others just status
      const body = code === 200 ? resp.getContentText().slice(0, 800) : '';
      results[path + (qs ? ' ' + qs.slice(0,30) : '')] = { status: code, preview: body };
    }
    output.setContent(JSON.stringify(results));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Returns top-level fields + first item fields from one transaction — for debugging cost field names
function getTxFields(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const store  = params.store || 'River';
    const apiKey = storeKey_(store);
    const auth   = Utilities.base64Encode(apiKey + ':');
    const today  = new Date();
    const from   = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().replace('.000','');
    const to     = today.toISOString().replace('.000','');
    const url    = BASE + '/reporting/transactions'
      + '?fromLastModifiedDateUTC=' + encodeURIComponent(from)
      + '&toLastModifiedDateUTC='   + encodeURIComponent(to)
      + '&includeItems=true&includeItemDetails=true';
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    const raw  = JSON.parse(resp.getContentText());
    const rows = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
    const tx   = rows.find(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail') || rows[0];
    if (!tx) { output.setContent(JSON.stringify({ error: 'no transactions found' })); return output; }
    const items = tx.items || tx.lineItems || tx.orderItems || [];
    output.setContent(JSON.stringify({
      txKeys:   Object.keys(tx),
      txSample: Object.fromEntries(Object.entries(tx).filter(([k,v]) => typeof v !== 'object')),
      itemKeys: items[0] ? Object.keys(items[0]) : [],
      itemSample: items[0] ? Object.fromEntries(Object.entries(items[0]).filter(([k,v]) => typeof v !== 'object')) : {},
    }));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Returns Col A → Col B from the P&L mapping sheet so we can verify/build the map
function getQBMappingSheet() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const MAPPING_GID = 996732254;
    const ss    = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const sheet = ss.getSheets().find(s => s.getSheetId() === MAPPING_GID);
    if (!sheet) throw new Error('Mapping sheet not found (gid ' + MAPPING_GID + ')');
    const rows = sheet.getDataRange().getValues();
    const pairs = rows
      .filter(r => r[0] && r[1])
      .map(r => ({ qb: String(r[0]).trim(), dash: String(r[1]).trim() }));
    output.setContent(JSON.stringify({ pairs }));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}




function testProxy() {
  const e = { parameter: {
    store: 'River',
    from:  '2026-04-01T07:00:00Z',
    to:    '2026-04-21T07:00:00Z',
  }};
  const result = doGet(e);
  Logger.log(result.getContent());
}

// Returns first 10 rows of a sheet by GID to inspect structure
function getSheetPreview(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const gid = params.gid;
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const sheets = ss.getSheets();
    const sheet = sheets.find(s => String(s.getSheetId()) === String(gid));
    if (!sheet) {
      output.setContent(JSON.stringify({ error: 'Sheet not found', available: sheets.map(s => ({ name: s.getName(), gid: s.getSheetId() })) }));
      return output;
    }
    const maxRows = parseInt(params.rows || '10') || 10;
    const rows = sheet.getRange(1, 1, Math.min(maxRows, sheet.getLastRow()), sheet.getLastColumn()).getValues();
    output.setContent(JSON.stringify({ name: sheet.getName(), rows }));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Returns daily COGS from GXCore (Dutchie-sourced, settled days only).
// Response: { data: [{ date, store, cogs }] }
function getCogsDutchie(params) {
  // dutchie_name → Sales internal store name (only River differs)
  const STORES = [
    { dutchie: 'Bend',        sales: 'Bend'        },
    { dutchie: 'Center',      sales: 'Center'      },
    { dutchie: 'Commercial',  sales: 'Commercial'  },
    { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
    { dutchie: 'Portland Rd', sales: 'Portland Rd' },
    { dutchie: 'River Rd',    sales: 'River'       },
  ];
  const todayPT      = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const from         = (params.from || '').slice(0, 10);
  const rawTo        = (params.to   || '').slice(0, 10);
  const includesToday = !rawTo || rawTo >= todayPT;
  const settledTo    = includesToday ? dayBefore_(todayPT) : rawTo;

  // This route was the only uncached one on the Income tab, and it is the most expensive: six
  // getSalesDaily reads PLUS six live dutchieClosingReport calls, one per store, in sequence. The
  // Gross Profit card is what waits on it, which is why that card is the last thing to fill in on a
  // phone. Everything about the settled half is immutable — yesterday's COGS does not change — and
  // even today's only moves as sales happen.
  const cacheKey = 'cogsd_' + from + '_' + (rawTo || 'now') + '_v1';
  if (!params.nocache) {
    const hit = cacheGet_(cacheKey);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }

  const results      = [];
  for (const { dutchie, sales } of STORES) {
    try {
      // Settled days via sales_daily cache (sourced from Dutchie Closing Report, nightly)
      const rows = GXCore.getSalesDaily(dutchie, from, settledTo) || [];
      for (const r of rows) {
        if (!r.date) continue;
        results.push({ date: String(r.date).slice(0, 10), store: sales, cogs: Number(r.cogs || 0) });
      }
      // Today: call Closing Report directly — returns live intra-day COGS (a valid partial, not an error)
      if (includesToday) {
        try {
          const cr = GXCore.dutchieClosingReport(dutchie, todayPT);
          results.push({ date: todayPT, store: sales, cogs: Math.round(Number(cr && cr.cost || 0) * 100) / 100 });
        } catch(e) {
          Logger.log('getCogsDutchie: today CR failed for ' + dutchie + ': ' + e.message);
        }
      }
    } catch(e) {
      Logger.log('getCogsDutchie: getSalesDaily failed for ' + dutchie + ': ' + e.message);
    }
  }
  const out = { data: results };
  // 10 minutes while today is in range, 6 hours once the whole window is settled. A range that ends
  // in the past cannot change at all, so the only reason not to cache it forever is the sheet being
  // corrected behind us.
  try { cacheSet_(cacheKey, JSON.stringify(out), includesToday ? 600 : 21600); } catch (e) {}
  return out;
}

// Returns monthly expense budgets from the Annual Budget sheet
// Response: { budgets: { "COGS": { Jan: 311749, Feb: 282160, ... }, ... } }
function getExpenseBudgets() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('expbudgets');
  if (cached) { output.setContent(cached); return output; }
  try {
    const ss    = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const sheet = ss.getSheets().find(s => s.getSheetId() === BUDGET_SHEET_GID);
    if (!sheet) throw new Error('Budget sheet not found');

    const data = sheet.getDataRange().getValues();
    const MONTHS_12 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Find the "EXPENSES BUDGET" section header
    let expStart = -1;
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][1]).trim() === 'EXPENSES BUDGET') { expStart = i; break; }
    }
    if (expStart < 0) throw new Error('EXPENSES BUDGET section not found');

    const budgets = {};
    for (let i = expStart + 1; i < data.length; i++) {
      const cat = String(data[i][3]).trim();
      if (!cat || cat === 'Total') continue;
      // Stop if we hit another section header
      if (data[i][1]) break;
      budgets[cat] = {};
      MONTHS_12.forEach((m, j) => {
        budgets[cat][m] = Number(data[i][4 + j]) || 0;
      });
    }

    const content = JSON.stringify({ budgets });
    cacheSet_('expbudgets', content, 3600); // 1 hour
    output.setContent(content);
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Test transactions with fromDate/toDate params instead of lastModifiedDate
function getTxDetail(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const apiKey = storeKey_(store);
  const auth   = Utilities.base64Encode(apiKey + ':');
  const hdrs   = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const today  = new Date();
  const yd     = new Date(today - 86400000).toISOString().slice(0, 10);
  // Try fromDate/toDate instead of lastModified
  const resp = UrlFetchApp.fetch(
    BASE + '/reporting/transactions?fromDate=' + yd + '&toDate=' + yd + '&includeItems=true',
    { method: 'get', headers: hdrs, muteHttpExceptions: true }
  );
  const code  = resp.getResponseCode();
  const raw   = JSON.parse(resp.getContentText());
  const rows  = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  const retail = rows.filter(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail');
  const first  = retail.find(r => (r.items||r.lineItems||r.orderItems||[]).length > 0) || retail[0];
  const fi     = first ? (first.items || first.lineItems || first.orderItems || []) : [];
  output.setContent(JSON.stringify({
    status: code,
    total: rows.length,
    withItems: retail.filter(r => (r.items||r.lineItems||r.orderItems||[]).length > 0).length,
    firstItemLen: fi.length,
    firstItem: fi[0] || null,
  }));
  return output;
}

// Probes candidate inventory endpoints to find which one the Dutchie API supports.
function probeInventoryEndpoints(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const apiKey = storeKey_(store);
  const auth   = Utilities.base64Encode(apiKey + ':');
  const hdrs   = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const paths  = [
    '/inventory/product',
    '/inventory',
    '/product',
    '/products',
    '/inventory/active',
    '/api/inventory/product',
    '/v1/inventory/product',
    '/reporting/product-performance',
    '/reporting/inventory',
    '/inventory/transfer',
  ];
  const results = {};
  for (const path of paths) {
    try {
      const resp = UrlFetchApp.fetch(BASE + path, { method: 'get', headers: hdrs, muteHttpExceptions: true });
      const code = resp.getResponseCode();
      const body = resp.getContentText();
      results[path] = { status: code, preview: body.slice(0, 300) };
    } catch(e) {
      results[path] = { status: 'error', preview: e.message };
    }
  }
  output.setContent(JSON.stringify(results, null, 2));
  return output;
}

// Tests item-level access — fetches one transaction and tries its detail endpoint
function getItemsTest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const apiKey = storeKey_(store);
  const auth   = Utilities.base64Encode(apiKey + ':');
  const hdrs   = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const today  = new Date();
  const from   = new Date(today - 2 * 86400000).toISOString().replace('.000', '');
  const to     = today.toISOString().replace('.000', '');

  // Fetch with includeLineItems param variant
  const resp1 = UrlFetchApp.fetch(
    BASE + '/reporting/transactions?fromLastModifiedDateUTC=' + encodeURIComponent(from)
      + '&toLastModifiedDateUTC=' + encodeURIComponent(to) + '&includeLineItems=true',
    { method: 'get', headers: hdrs, muteHttpExceptions: true }
  );
  const raw1  = JSON.parse(resp1.getContentText());
  const rows1 = Array.isArray(raw1) ? raw1 : (raw1.data || raw1.items || []);
  const retail1 = rows1.filter(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail');
  const withItems1 = retail1.filter(r => (r.items||r.lineItems||r.orderItems||[]).length > 0);

  output.setContent(JSON.stringify({
    includeLineItems_variant: { retail: retail1.length, withItems: withItems1.length },
    firstTxId: retail1[0]?.transactionId || null,
  }));
  return output;
}

// Returns keys + first 3 items from /reporting/inventory for field discovery
function getInvFields(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const apiKey = storeKey_(store);
  const auth   = Utilities.base64Encode(apiKey + ':');
  const resp   = UrlFetchApp.fetch(BASE + '/reporting/inventory', {
    method: 'get',
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  const raw   = JSON.parse(resp.getContentText());
  const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  const sample = items.slice(0, 3);
  output.setContent(JSON.stringify({
    totalItems: items.length,
    keys: sample[0] ? Object.keys(sample[0]) : [],
    samples: sample,
  }));
  return output;
}

// Returns current inventory with stock levels and value per store.
// Response: { store, products: [{ name, category, vendor, qty, value, sku }] }
// qty=0 means OOS (recently active package with no remaining stock)
function getInventory(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  const store = params.store;
  if (!store || !storeKey_(store)) {
    output.setContent(JSON.stringify({ error: 'Unknown store: ' + store }));
    return output;
  }

  const cacheKey = 'inv_' + store;
  const cached = cacheGet_(cacheKey);
  if (cached) { output.setContent(cached); return output; }

  try {
    const apiKey = storeKey_(store);
    const auth   = Utilities.base64Encode(apiKey + ':');
    const hdrs   = { Authorization: 'Basic ' + auth, Accept: 'application/json' };

    const invResp = UrlFetchApp.fetch(BASE + '/reporting/inventory', {
      method: 'get', headers: hdrs, muteHttpExceptions: true,
    });
    const invCode = invResp.getResponseCode();
    if (invCode !== 200) {
      output.setContent(JSON.stringify({
        error: 'Inventory endpoint returned HTTP ' + invCode
          + '. Body: ' + invResp.getContentText().slice(0, 300),
        store,
      }));
      return output;
    }
    const invRaw   = JSON.parse(invResp.getContentText());
    const invItems = Array.isArray(invRaw) ? invRaw : (invRaw.data || invRaw.items || []);

    // Aggregate all packages by productName (including qty=0 for OOS detection).
    // Keep OOS entries modified within 1 year so recently-sold-out products count.
    // Only drop truly ancient zero-qty entries (ghost products never re-ordered).
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
    const productMap = {};
    for (const item of invItems) {
      const lastMod = item.lastModifiedDateUtc || '';
      const qty     = Number(item.quantityAvailable || 0);
      if (qty <= 0 && lastMod < cutoff) continue;
      const name = item.productName || 'Unknown';
      if (!productMap[name]) {
        productMap[name] = {
          name,
          category: item.masterCategory || item.category || 'Other',
          vendor:   item.brandName || item.vendor || '',
          qty:      0,
          value:    0,
          sku:      item.sku || '',
          lastMod:  lastMod,
        };
      }
      productMap[name].qty   += qty;
      productMap[name].value += qty * Number(item.unitCost || 0);
      if (lastMod > productMap[name].lastMod) productMap[name].lastMod = lastMod;
    }

    const result = Object.values(productMap).map(p => ({
      name:     p.name,
      category: p.category,
      vendor:   p.vendor,
      qty:      Math.round(p.qty   * 10)  / 10,
      value:    Math.round(p.value * 100) / 100,
      sku:      p.sku,
    }));

    const content = JSON.stringify({ store, products: result });
    cacheSet_(cacheKey, content, 300); // 5 min
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message, store }));
  }
  return output;
}

const ATM_SHEET_GID    = 1349619595;
const SUBLET_SHEET_GID = 1274502465;
const OTHERREV_PROP    = 'otherrev_data';
const MONTHS_12_       = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Per-year ATM sheet config. sid = spreadsheet ID; gid = sheet GID (0 = first sheet).
const ATM_SHEET_CONFIG_ = {
  '2025': { sid: '10xW3f4nhGAFGPfpjQod0VOdfKalW4hWtLnBlrGttTmU', gid: 0 },
  '2026': { sid: BUDGET_SHEET_ID, gid: ATM_SHEET_GID },
};

// Header cell text → MONTHS_12_ 3-letter abbreviation (handles full and abbreviated names)
const MONTH_ABBR_ = {
  jan:'Jan', january:'Jan', feb:'Feb', february:'Feb', mar:'Mar', march:'Mar',
  apr:'Apr', april:'Apr', may:'May', jun:'Jun', june:'Jun', jul:'Jul', july:'Jul',
  aug:'Aug', august:'Aug', sep:'Sep', sept:'Sep', september:'Sep',
  oct:'Oct', october:'Oct', nov:'Nov', november:'Nov', dec:'Dec', december:'Dec',
};

function getOtherRevData_() {
  const props = PropertiesService.getScriptProperties();
  const raw   = props.getProperty(OTHERREV_PROP);
  if (raw) return JSON.parse(raw);

  // One-time bootstrap from GX2 sheet
  const blank = () => Object.fromEntries(MONTHS_12_.map(m => [m, 0]));
  let atm = blank(), sublet = blank();
  try {
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);

    const atmSheet = ss.getSheets().find(s => s.getSheetId() === ATM_SHEET_GID);
    if (atmSheet) {
      const atmData = atmSheet.getDataRange().getValues();
      let atmRevRow = null;
      for (let i = 0; i < atmData.length; i++) {
        const v = atmData[i][0];
        if (typeof v === 'number' && v > 1 && v < 3) { atmRevRow = atmData[i]; break; }
      }
      if (atmRevRow) MONTHS_12_.forEach((m, j) => { atm[m] = Number(atmRevRow[j + 1]) || 0; });
    }

    const subSheet = ss.getSheets().find(s => s.getSheetId() === SUBLET_SHEET_GID);
    if (subSheet) {
      const subData = subSheet.getDataRange().getValues();
      let subTotalRow = null;
      for (let i = 0; i < subData.length; i++) {
        if (String(subData[i][0]).trim().toUpperCase() === 'TOTAL') { subTotalRow = subData[i]; break; }
      }
      if (subTotalRow) MONTHS_12_.forEach((m, j) => { sublet[m] = Number(subTotalRow[j + 1]) || 0; });
    }
  } catch(e) {
    Logger.log('OtherRev GX2 bootstrap failed: ' + e.message);
  }

  const data = { atm, sublet };
  props.setProperty(OTHERREV_PROP, JSON.stringify(data));
  return data;
}

function getOtherRevenue() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('otherrev');
  if (cached) { output.setContent(cached); return output; }
  try {
    const data    = getOtherRevData_();
    const content = JSON.stringify(data);
    cacheSet_('otherrev', content, 3600);
    output.setContent(content);
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

function setOtherRevenue(params) {
  const type  = params.type;
  const month = params.month;
  const value = Number(params.value);
  if (!['atm','sublet'].includes(type))       return jsonOut_({ ok: false, error: 'invalid type' });
  if (!MONTHS_12_.includes(month))            return jsonOut_({ ok: false, error: 'invalid month' });
  if (isNaN(value) || value < 0)             return jsonOut_({ ok: false, error: 'invalid value' });
  try {
    const data     = getOtherRevData_();
    data[type][month] = Math.round(value * 100) / 100;
    PropertiesService.getScriptProperties().setProperty(OTHERREV_PROP, JSON.stringify(data));
    cacheDelete_('otherrev');
    return jsonOut_({ ok: true, data });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// ── Revenue detail: ATM + Sublet per machine/category, per store ──────────────

// Canonical store names (must match STORE_KEYS and the frontend STORES array)
const DEFAULT_ATM_MACHINES = {
  'Bend':        ['ATM 1', 'ATM 2'],
  'Center':      ['ATM 1'],
  'Commercial':  ['ATM 1', 'ATM 2'],
  'Hillsboro':   ['ATM 1', 'ATM 2'],
  'Portland Rd': ['ATM 1'],
  'River':       ['ATM 1', 'ATM 2']
};

// Maps GX2 ATM sheet row labels → {store, machine} using canonical store names
const ATM_MACHINE_MAP = {
  'bend':                  { store: 'Bend',        machine: 'ATM 1' },
  'bend 2':                { store: 'Bend',        machine: 'ATM 2' },
  'bend atm':              { store: 'Bend',        machine: 'ATM 1' },
  'bend atm 2':            { store: 'Bend',        machine: 'ATM 2' },
  'center st':             { store: 'Center',      machine: 'ATM 1' },
  'center':                { store: 'Center',      machine: 'ATM 1' },
  'commercial':            { store: 'Commercial',  machine: 'ATM 1' },
  'commercial large-2':    { store: 'Commercial',  machine: 'ATM 2' },
  'commercial large 2':    { store: 'Commercial',  machine: 'ATM 2' },
  'commercial 2':          { store: 'Commercial',  machine: 'ATM 2' },
  'hillsboro':             { store: 'Hillsboro',   machine: 'ATM 1' },
  'hillsboro 2':           { store: 'Hillsboro',   machine: 'ATM 2' },
  'baseline':              { store: 'Hillsboro',   machine: 'ATM 1' },
  'commercial lg':         { store: 'Commercial',  machine: 'ATM 2' },
  'hilsborro':             { store: 'Hillsboro',   machine: 'ATM 1' },
  'portland lg':           { store: 'Portland Rd', machine: 'ATM 1' },
  'portland':              { store: 'Portland Rd', machine: 'ATM 1' },
  'portland rd':           { store: 'Portland Rd', machine: 'ATM 1' },
  'river lg':              { store: 'River',       machine: 'ATM 1' },
  'river sm':              { store: 'River',       machine: 'ATM 2' },
  'river rd sm':           { store: 'River',       machine: 'ATM 2' },
  'river':                 { store: 'River',       machine: 'ATM 1' },
};

function getRevConfig_() {
  const props = PropertiesService.getScriptProperties();
  const raw   = props.getProperty('rev_config');
  const cfg   = raw ? JSON.parse(raw) : {};
  let dirty = false;
  if (!cfg.machines)    { cfg.machines    = DEFAULT_ATM_MACHINES; dirty = true; }
  if (!cfg.sublet_cats) { cfg.sublet_cats = {}; dirty = true; }
  if (!cfg.atm_rate)    { cfg.atm_rate    = 1.75; dirty = true; }
  // Migrate legacy 'Portland' key → 'Portland Rd' (canonical store name)
  if (cfg.machines['Portland'] && !cfg.machines['Portland Rd']) {
    cfg.machines['Portland Rd'] = cfg.machines['Portland'];
    delete cfg.machines['Portland'];
    dirty = true;
  }
  if (dirty) props.setProperty('rev_config', JSON.stringify(cfg));
  return cfg;
}

function getRevYearData_(type, year) {
  const raw = PropertiesService.getScriptProperties().getProperty('rev_' + type + '_' + year);
  return raw ? JSON.parse(raw) : {};
}

// One-time bootstrap: reads per-machine rows from the ATM sheet and stores txn counts.
// Revenue = txns × rate is computed at display time (rate lives in rev_config.atm_rate).
// Sum-row detection uses INDENTATION: sheet machine rows have leading whitespace;
// store total rows (uppercase, no indent) are skipped when a store has any indented siblings.
function bootstrapAtmFromSheet_(year) {
  const sheetCfg = ATM_SHEET_CONFIG_[String(year)];
  if (!sheetCfg) { Logger.log('ATM bootstrap: no sheet configured for year ' + year); return; }
  try {
    const ss    = SpreadsheetApp.openById(sheetCfg.sid);
    const sheet = ss.getSheets().find(s => s.getSheetId() === sheetCfg.gid);
    if (!sheet) { Logger.log('ATM bootstrap: sheet GID ' + sheetCfg.gid + ' not found'); return; }
    const rows  = sheet.getDataRange().getValues();

    // Scan for header row (col A = "location") and rate row (col A is a number 0.5–5)
    let sheetRate = 0;
    let monthColMap = null; // { 'Jan': colIdx, 'May': colIdx, ... }
    for (const row of rows) {
      const a = row[0];
      if (typeof a === 'number' && a > 0.5 && a < 5) {
        sheetRate = a;
      } else if (typeof a === 'string' && a.trim().toLowerCase() === 'location') {
        monthColMap = {};
        for (let c = 1; c < row.length; c++) {
          const abbr = MONTH_ABBR_[String(row[c]).trim().toLowerCase()];
          if (abbr) monthColMap[abbr] = c;
        }
      }
    }
    // Fallback: no header found → assume Jan=col1…Dec=col12
    if (!monthColMap || !Object.keys(monthColMap).length) {
      monthColMap = {};
      MONTHS_12_.forEach((m, i) => { monthColMap[m] = i + 1; });
    }
    const activeCols = Object.values(monthColMap);

    // Collect all matched label rows; track indentation
    const allMatched = [];
    for (const row of rows) {
      const colA = row[0];
      if (typeof colA === 'string' && colA.trim() !== '') {
        const key = colA.trim().toLowerCase();
        if (hasOwn_(ATM_MACHINE_MAP, key)) {
          allMatched.push({ map: ATM_MACHINE_MAP[key], row, indented: /^\s/.test(colA) });
        }
      }
    }
    if (!allMatched.length) return;

    // Group by store
    const storeGroups = {};
    for (const r of allMatched) {
      const s = r.map.store;
      if (!storeGroups[s]) storeGroups[s] = [];
      storeGroups[s].push(r);
    }

    // Sum-row detection per group
    const rowsToUse = [];
    for (const group of Object.values(storeGroups)) {
      const indented = group.filter(r => r.indented);
      if (indented.length > 0) {
        // Indent-based (2026): keep only rows with leading whitespace
        rowsToUse.push(...indented);
      } else if (group.length <= 1) {
        rowsToUse.push(...group);
      } else {
        // Value-based (2025): find the row whose column values = sum of all others
        const sumIdx = group.findIndex((cand, ci) => {
          const others = group.filter((_, j) => j !== ci);
          let checks = 0, matches = 0;
          for (const colIdx of activeCols) {
            const cv = Number(cand.row[colIdx]) || 0;
            const ov = others.reduce((acc, g) => acc + (Number(g.row[colIdx]) || 0), 0);
            if (cv === 0 && ov === 0) continue;
            checks++;
            if (Math.abs(cv - ov) < 0.5) matches++;
          }
          return checks > 0 && matches === checks;
        });
        rowsToUse.push(...group.filter((_, i) => i !== sumIdx));
      }
    }

    // Store txn counts indexed by month using actual column positions
    const data = {};
    MONTHS_12_.forEach(month => { data[month] = {}; });
    for (const { map, row } of rowsToUse) {
      const { store, machine } = map;
      MONTHS_12_.forEach(month => {
        const colIdx = monthColMap[month];
        if (colIdx === undefined) return;
        const txns = Number(row[colIdx]) || 0;
        if (txns <= 0) return;
        if (!data[month][store]) data[month][store] = {};
        data[month][store][machine] = (data[month][store][machine] || 0) + txns;
      });
    }

    PropertiesService.getScriptProperties().setProperty('rev_atm_' + year, JSON.stringify(data));

    if (sheetRate > 0) {
      const revCfg = getRevConfig_();
      if (!revCfg.atm_rate || revCfg.atm_rate === 1.75) {
        revCfg.atm_rate = sheetRate;
        PropertiesService.getScriptProperties().setProperty('rev_config', JSON.stringify(revCfg));
      }
    }

    cacheDelete_('otherrev');
    Logger.log('ATM bootstrap ' + year + ': ' + rowsToUse.length + ' rows kept, ' +
      (allMatched.length - rowsToUse.length) + ' sum rows skipped, months: ' + Object.keys(monthColMap).join(','));
  } catch(e) {
    Logger.log('ATM bootstrap error for ' + year + ': ' + e.message);
  }
}

function getRevenueDetail(params) {
  const year = params.year || String(new Date().getFullYear());
  try {
    const cfg    = getRevConfig_();
    let   atm    = getRevYearData_('atm', year);
    const sub    = getRevYearData_('sub', year);

    // Bootstrap from sheet on first access (only for years with a configured sheet)
    const hasAtm = Object.values(atm).some(mo => Object.keys(mo).length > 0);
    if (!hasAtm && ATM_SHEET_CONFIG_[String(year)]) {
      bootstrapAtmFromSheet_(year);
      atm = getRevYearData_('atm', year);
    }

    return jsonOut_({ ok: true, year, cfg, atm, sub });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Sky-only: delete stored ATM bootstrap so next revenue_detail re-reads from sheet.
function clearAtmCache_(params, user) {
  const u = (user || '').toLowerCase();
  const isSky = u === 'sky@greencrosscanna.com' || u === 'sky' || u.startsWith('sky@');
  if (!isSky) return jsonOut_({ ok: false, error: 'Forbidden' });
  const year = params.year || String(new Date().getFullYear());
  PropertiesService.getScriptProperties().deleteProperty('rev_atm_' + year);
  cacheDelete_('otherrev');
  return jsonOut_({ ok: true, cleared: 'rev_atm_' + year });
}

function setRevenueLine(params) {
  const { year, month, type, store, item } = params;
  const value = Math.round(Number(params.value) * 100) / 100;
  if (!['atm','sub'].includes(type)) return jsonOut_({ ok: false, error: 'invalid type' });
  if (!MONTHS_12_.includes(month))   return jsonOut_({ ok: false, error: 'invalid month' });
  if (isNaN(value) || value < 0)    return jsonOut_({ ok: false, error: 'invalid value' });
  if (!year || !store || !item)      return jsonOut_({ ok: false, error: 'missing params' });
  try {
    const data = getRevYearData_(type, year);
    if (!data[month])        data[month]       = {};
    if (!data[month][store]) data[month][store] = {};
    data[month][store][item] = value;
    PropertiesService.getScriptProperties().setProperty('rev_' + type + '_' + year, JSON.stringify(data));
    cacheDelete_('otherrev');
    return jsonOut_({ ok: true });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

function reportBug_(params, reporter) {
  try {
    const priority = params.priority || 'medium';
    const desc     = params.desc     || '';
    if (!desc) return jsonOut_({ ok: false, error: 'desc required' });
    // GX Core requires a title; the Sales form collects only a description, so derive one from its first
    // line. Without this, the pinned GXCore library rejected the report ("title required") and the old code
    // ignored that result — returning ok:true, so the report was silently lost while the user saw success.
    const title = (params.title && String(params.title).trim()) || desc.split('\n')[0].slice(0, 80).trim();
    const r = GXCore.gxIngestBug('sales', reporter, {
      title, priority, desc,
      appVer:   params.appVer   || '',
      appStore: params.appStore || '',
      appTab:   params.appTab   || ''
    });
    if (!r || !r.ok) return jsonOut_({ ok: false, error: (r && r.error) || 'bug report was not saved' });
    return jsonOut_({ ok: true });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

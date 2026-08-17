// Green Cross — Dutchie API Proxy
// Deploy as Web App: Execute as "Me", Who has access "Anyone"
// Paste your API keys below — these never leave your Google account

const STORE_KEYS = {
  'Bend':        '77e157f3fcdf43d9864daf0420df8c97',
  'Center':      '6a7e9c3187a6471d8a0a2d05cfa92023',
  'Commercial':  'd97da3cef3f74dd087cee7d4239a851d',
  'Hillsboro':   'a2de33457b8f4d35972d3c47832207eb',
  'Portland Rd': '5671f32c2c2a4756811e9513945815f4',
  'River':       '5212417431014845a6db39bcb4ccef6b',
};

const BASE = 'https://api.pos.dutchie.com';

const BUDGET_SHEET_ID  = '1OBNzkBrJtLIlf8xknVlGd6Jb8nlkg4_KG-Gq6BD7HHY';
const BUDGET_SHEET_GID = 1092240858;

// ── QuickBooks credentials ────────────────────────────────────────────────────
// Paste values here ONLY to run exchangeQBCode() — after that they are stored
// in Script Properties and these constants are no longer used.
const QB_CLIENT_ID     = 'XXXXXXX';
const QB_CLIENT_SECRET = 'XXXXXXX';
const QB_REALM_ID      = 'XXXXXXX';
const QB_AUTH_CODE     = 'XXXXXXX';

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
  if (users[key] && users[key] === hash) {
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

  // Heartbeat: renew a still-valid token to extend the session
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
  if (params.action === 'expenses')    return getExpenses(params);
  if (params.action === 'qbaccounts')  return getQBAccountNames();
  if (params.action === 'qbmapping')   return getQBMappingSheet();
  if (params.action === 'txfields')    return getTxFields(params);
  if (params.action === 'eodtest')     return getEodTest(params);
  if (params.action === 'sheetpreview')  return getSheetPreview(params);
  if (params.action === 'costs')         return getCosts(params);
  if (params.action === 'cogs_dutchie')  return jsonOut_(getCogsDutchie(params));
  if (params.action === 'expbudgets')    return getExpenseBudgets();
  if (params.action === 'otherrev')      return getOtherRevenue();
  if (params.action === 'inventory')     return getInventory(params);
  if (params.action === 'invprobe')      return probeInventoryEndpoints(params);
  if (params.action === 'invfields')     return getInvFields(params);
  if (params.action === 'itemstest')     return getItemsTest(params);
  if (params.action === 'txdetail')      return getTxDetail(params);
  if (params.action === 'reportbug')     return reportBug_(params, auth.user);

  const store = params.store;
  const from  = params.from;
  const to    = params.to;

  if (!store || !STORE_KEYS[store]) return jsonOut_({ error: 'Unknown store: ' + store });

  return getStoreSales_(store, from, to);
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
      const gasCacheKey = 'sdaily_v3_' + store + '_' + fromDate + '_' + settledTo;
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
        dailyMap[d.date] = { netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts };
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
        .map(([date, d]) => ({ date, netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts })),
      cacheRows:  cacheRows.length,
      liveOrders: liveResult ? liveResult.orders : 0,
    });
  } catch (err) {
    return jsonOut_({ error: err.message });
  }
}

// Live intraday Dutchie fetch — today only, same logic as the old full handler.
function dutchieTodayFetch_(store, todayPT, toISO) {
  const apiKey = STORE_KEYS[store];
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
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { netSales: 0, grossSales: 0, orders: 0, discounts: 0 };
      dailyMap[dateStr].netSales   += net;
      dailyMap[dateStr].grossSales += net + disc;
      dailyMap[dateStr].orders     += 1;
      dailyMap[dateStr].discounts  += disc;
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

    const content = JSON.stringify({ goals });
    cacheSet_('goals', content, 3600); // 1 hour
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// ── QuickBooks OAuth ──────────────────────────────────────────────────────────

// Run this ONCE after pasting QB_AUTH_CODE above. Saves refresh token to
// Script Properties so the live proxy can auto-refresh without touching the code.
function exchangeQBCode() {
  const resp = UrlFetchApp.fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'post',
    headers: {
      Authorization:  'Basic ' + Utilities.base64Encode(QB_CLIENT_ID + ':' + QB_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
    payload: 'grant_type=authorization_code'
           + '&code='         + encodeURIComponent(QB_AUTH_CODE)
           + '&redirect_uri=' + encodeURIComponent('https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl'),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  if (data.refresh_token) {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('QB_CLIENT_ID',     QB_CLIENT_ID);
    props.setProperty('QB_CLIENT_SECRET', QB_CLIENT_SECRET);
    props.setProperty('QB_REALM_ID',      QB_REALM_ID);
    props.setProperty('QB_REFRESH_TOKEN', data.refresh_token);
    Logger.log('Success! All QB credentials saved to Script Properties.');
  } else {
    Logger.log('Failed: ' + resp.getContentText());
  }
}

function getQBAccessToken_() {
  const props     = PropertiesService.getScriptProperties();
  const clientId  = props.getProperty('QB_CLIENT_ID');
  const secret    = props.getProperty('QB_CLIENT_SECRET');
  const refresh   = props.getProperty('QB_REFRESH_TOKEN');
  if (!refresh)  throw new Error('No QB_REFRESH_TOKEN — run exchangeQBCode() first.');
  if (!clientId) throw new Error('No QB_CLIENT_ID in Script Properties — run exchangeQBCode() first.');

  const resp = UrlFetchApp.fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'post',
    headers: {
      Authorization:  'Basic ' + Utilities.base64Encode(clientId + ':' + secret),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept:         'application/json',
    },
    payload: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  if (!data.access_token) throw new Error('QB token refresh failed: ' + resp.getContentText());
  props.setProperty('QB_REFRESH_TOKEN', data.refresh_token);
  return data.access_token;
}

// ── QuickBooks Expenses ───────────────────────────────────────────────────────

// Section summaries: when matched, add the total and DON'T recurse into children
// Keys are the section name after stripping "Total " or "Total for "
const QB_SUMMARY_MAP_ = {
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

function walkQBRows_(rows, cols, result) {
  for (const row of (rows || [])) {
    let summaryMatched = false;

    // Section summary row — strip "Total for " or "Total " prefix to get the section name
    if (row.Summary) {
      const raw = (row.Summary.ColData?.[0]?.value || '')
        .replace(/^Total\s+(for\s+)?/i, '').trim().toUpperCase();
      const cat = QB_SUMMARY_MAP_[raw];
      if (cat) {
        summaryMatched = true; // skip recursion to avoid double-counting sub-items
        if (!result[cat]) result[cat] = {};
        cols.forEach((col, i) => {
          const v = parseFloat((row.Summary.ColData?.[i + 1]?.value || '').replace(/,/g, '')) || 0;
          if (col) result[cat][col] = (result[cat][col] || 0) + v;
        });
      }
    }

    // Individual data row (leaf node — no Summary sibling)
    if (row.ColData && !row.Summary) {
      const raw = (row.ColData[0]?.value || '').trim().toUpperCase();
      const cat = QB_DETAIL_MAP_[raw];
      if (cat) {
        if (!result[cat]) result[cat] = {};
        cols.forEach((col, i) => {
          const v = parseFloat((row.ColData[i + 1]?.value || '').replace(/,/g, '')) || 0;
          if (col) result[cat][col] = (result[cat][col] || 0) + v;
        });
      }
    }

    // Recurse only if this section's summary wasn't matched (prevents double-counting)
    if (!summaryMatched && row.Rows?.Row) {
      walkQBRows_(row.Rows.Row, cols, result);
    }
  }
}

// QB Profit & Loss raw report. Prefer the centralized GX Core connector (the single token owner); fall back
// to the local Sales token only if GX Core is unreachable or not yet connected — so the Expenses tab keeps
// working right through the cutover and auto-switches to GX Core the moment it's connected.
function qbProfitAndLoss_(start, end) {
  try {
    const r = qbReportViaGXCore_(start, end);
    if (r) return r;
  } catch (e) {
    Logger.log('QB via GX Core unavailable, falling back to local token: ' + e.message);
  }
  return qbReportLocal_(start, end);
}

// Fetch the P&L through GX Core's centralized, health-instrumented QB connector (secret-gated qb_pnl route).
// Retries the intermittent Drive-HTML two-hop 404. Returns the raw QB report, or throws.
function qbReportViaGXCore_(start, end) {
  const GXCORE_EXEC = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) return null;   // no secret configured → skip straight to local
  const url = GXCORE_EXEC + '?action=qb_pnl&secret=' + encodeURIComponent(secret)
    + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end) + '&by=Month';
  for (let i = 0; i < 5; i++) {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null; try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true && data.report) return data.report;
    if (data && data.ok === false) throw new Error(data.error || 'qb_pnl error');   // connected but errored → let caller fall back
    Utilities.sleep(500);   // transient Drive-HTML miss → retry
  }
  throw new Error('qb_pnl unreachable after retries');
}

// Legacy local path — Sales refreshes its own QB token. Retained as the cutover fallback; remove once GX Core
// is the proven sole owner (it and Sales must NOT both actively refresh — that's the invalid_grant desync).
function qbReportLocal_(start, end) {
  const props   = PropertiesService.getScriptProperties();
  const token   = getQBAccessToken_();
  const realmId = props.getProperty('QB_REALM_ID');
  const qbBase  = (props.getProperty('QB_SANDBOX') === 'true')
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const url = qbBase + '/v3/company/' + realmId + '/reports/ProfitAndLoss'
    + '?start_date=' + start + '&end_date=' + end + '&summarize_column_by=Month';
  const resp   = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, muteHttpExceptions: true });
  const report = JSON.parse(resp.getContentText());
  if (report.Fault) throw new Error(JSON.stringify(report.Fault));
  return report;
}

function getExpenses(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cacheKey = 'expenses_' + new Date().getFullYear();
  if (!params?.debug) {
    const cached = cacheGet_(cacheKey);
    if (cached) { output.setContent(cached); return output; }
  }
  try {
    const today   = new Date();
    const yr      = today.getFullYear();
    const start   = yr + '-01-01';
    const end     = yr + '-' + String(today.getMonth() + 1).padStart(2, '0')
                        + '-' + String(today.getDate()).padStart(2, '0');

    // Prefer the centralized GX Core QB connector (single token owner — no two-refresher desync); fall back
    // to the local Sales token only if GX Core is unreachable/unconnected, so Expenses never gaps during the
    // cutover. Once GX Core is the proven owner, the local fallback (qbReportLocal_) can be removed.
    const report = qbProfitAndLoss_(start, end);
    const raw    = JSON.stringify(report);
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column titles e.g. ["Jan 2026", "Feb 2026", ...]
    const cols = (report.Columns?.Column || []).map(c => c.ColTitle || '').filter(Boolean);

    const expenses = {};
    walkQBRows_(report.Rows?.Row || [], cols, expenses);

    // debug=true returns raw report for mapping verification
    if (params && params.debug === 'true') {
      output.setContent(raw);
      return output;
    }

    const content = JSON.stringify({ expenses, columns: cols });
    cacheSet_(cacheKey, content, 1800); // 30 min
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// Probes common Dutchie EOD/daily-summary endpoint patterns to find inventory cost
function getEodTest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const store  = params.store || 'River';
    const apiKey = STORE_KEYS[store];
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
    const apiKey = STORE_KEYS[store];
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

// Web-accessible version — hit ?action=qbaccounts to get all raw row names as JSON
function getQBAccountNames() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const token   = getQBAccessToken_();
    const realmId = PropertiesService.getScriptProperties().getProperty('QB_REALM_ID');
    const yr      = new Date().getFullYear();
    const url     = 'https://quickbooks.api.intuit.com/v3/company/' + realmId
      + '/reports/ProfitAndLoss?start_date=' + yr + '-01-01&end_date=' + yr + '-04-21&summarize_column_by=Month';
    const resp   = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    const report = JSON.parse(resp.getContentText());
    const names  = [];
    function walk(rows, depth) {
      for (const r of rows || []) {
        if (r.Summary?.ColData?.[0]?.value) names.push({ type:'S', depth, name: r.Summary.ColData[0].value });
        else if (r.ColData?.[0]?.value)     names.push({ type:'D', depth, name: r.ColData[0].value });
        if (r.Rows?.Row) walk(r.Rows.Row, depth + 1);
      }
    }
    walk(report.Rows?.Row || [], 0);
    output.setContent(JSON.stringify({ names }));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Run in editor to see raw QB account/section names for mapping verification
function debugQBAccountNames() {
  const token   = getQBAccessToken_();
  const realmId = PropertiesService.getScriptProperties().getProperty('QB_REALM_ID');
  const yr      = new Date().getFullYear();
  const url     = 'https://quickbooks.api.intuit.com/v3/company/' + realmId
    + '/reports/ProfitAndLoss?start_date=' + yr + '-01-01&end_date=' + yr + '-04-20&summarize_column_by=Month';
  const resp  = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  const report = JSON.parse(resp.getContentText());
  function names(rows, d) {
    let out = [];
    for (const r of rows || []) {
      if (r.Summary?.ColData?.[0]?.value) out.push('  '.repeat(d) + '[S] ' + r.Summary.ColData[0].value);
      else if (r.ColData?.[0]?.value)     out.push('  '.repeat(d) + '[D] ' + r.ColData[0].value);
      if (r.Rows?.Row) out = out.concat(names(r.Rows.Row, d + 1));
    }
    return out;
  }
  Logger.log(names(report.Rows?.Row || [], 0).join('\n'));
}

function debugQBAuth() {
  const props   = PropertiesService.getScriptProperties();
  const realmId = props.getProperty('QB_REALM_ID') || '(not set)';
  const hasRefresh = !!props.getProperty('QB_REFRESH_TOKEN');
  const hasClient  = !!props.getProperty('QB_CLIENT_ID');
  Logger.log('Realm ID: ' + realmId);
  Logger.log('Has refresh token: ' + hasRefresh);
  Logger.log('Has client ID: ' + hasClient);
  // Try a simple company info call to verify auth
  try {
    const token     = getQBAccessToken_();
    const sandbox   = (props.getProperty('QB_SANDBOX') === 'true');
    const base      = sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
    const url       = base + '/v3/company/' + realmId + '/companyinfo/' + realmId;
    const resp  = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      muteHttpExceptions: true,
    });
    Logger.log('Company info status: ' + resp.getResponseCode());
    Logger.log('Company info response: ' + resp.getContentText().slice(0, 500));
  } catch(e) {
    Logger.log('Error: ' + e.message);
  }
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
    const gid = params.gid || '1548231883';
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
  const STORE_NAMES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];
  const todayPT  = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const from     = (params.from || '').slice(0, 10);
  const rawTo    = (params.to   || '').slice(0, 10);
  const to       = (!rawTo || rawTo >= todayPT) ? dayBefore_(todayPT) : rawTo;
  const results  = [];
  for (const store of STORE_NAMES) {
    try {
      const rows = GXCore.getSalesDaily(store, from, to) || [];
      for (const r of rows) {
        if (!r.date) continue;
        results.push({ date: String(r.date).slice(0, 10), store: store, cogs: Number(r.cogs || 0) });
      }
    } catch(e) {
      Logger.log('getCogsDutchie: getSalesDaily failed for ' + store + ': ' + e.message);
    }
  }
  return { data: results };
}

// Returns daily inventory cost data from the EOD sheet
// Columns expected: Date, Month, Store, [Revenue], [Cost], ...
// Returns daily inventory cost by date and store from the Income Data Dump sheet.
// Response: { daily: { "2026-01-01": { "Bend": 2100.50, "Center": 742.57, ... }, ... } }
function getCosts(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('costs');
  if (cached) { output.setContent(cached); return output; }
  try {
    const COST_SHEET_GID = 1548231883;
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const sheet = ss.getSheets().find(s => s.getSheetId() === COST_SHEET_GID);
    if (!sheet) {
      output.setContent(JSON.stringify({ error: 'Income Data Dump sheet not found' }));
      return output;
    }

    // Location name → dashboard store key
    const LOC_MAP = {
      'bend':         'Bend',
      'center':       'Center',
      'commercial':   'Commercial',
      'hillsboro':    'Hillsboro',
      'portland road':'Portland Rd',
      'portland rd':  'Portland Rd',
      'river':        'River',
    };

    function locToStore(loc) {
      const lower = (loc || '').toLowerCase();
      for (const [key, store] of Object.entries(LOC_MAP)) {
        if (lower.includes(key)) return store;
      }
      return null;
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const dateCol = headers.indexOf('Order Date');
    const locCol  = headers.indexOf('Location Name');
    const costCol = headers.indexOf('Inventory Cost');

    if (dateCol < 0 || locCol < 0 || costCol < 0) {
      output.setContent(JSON.stringify({ error: 'Expected columns not found', headers }));
      return output;
    }

    const daily = {};
    for (let i = 1; i < data.length; i++) {
      const row  = data[i];
      const raw  = row[dateCol];
      if (!raw) continue;
      // Dates stored as midnight Pacific (7 or 8 AM UTC depending on DST).
      // UTC date portion always equals the local Pacific date since Pacific is UTC-7/-8.
      const d = raw instanceof Date ? raw : new Date(raw);
      if (isNaN(d)) continue;
      const dateStr = d.toISOString().slice(0, 10);

      const store = locToStore(String(row[locCol]));
      if (!store) continue;
      const cost = Number(row[costCol]) || 0;

      if (!daily[dateStr]) daily[dateStr] = {};
      daily[dateStr][store] = (daily[dateStr][store] || 0) + cost;
    }

    const content = JSON.stringify({ daily });
    cacheSet_('costs', content, 1800); // 30 min
    output.setContent(content);
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
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
  const apiKey = STORE_KEYS[store];
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
  const apiKey = STORE_KEYS[store];
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
  const apiKey = STORE_KEYS[store];
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
  const apiKey = STORE_KEYS[store];
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
  if (!store || !STORE_KEYS[store]) {
    output.setContent(JSON.stringify({ error: 'Unknown store: ' + store }));
    return output;
  }

  const cacheKey = 'inv_' + store;
  const cached = cacheGet_(cacheKey);
  if (cached) { output.setContent(cached); return output; }

  try {
    const apiKey = STORE_KEYS[store];
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

function getOtherRevenue() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('otherrev');
  if (cached) { output.setContent(cached); return output; }
  try {
    const ss = SpreadsheetApp.openById(BUDGET_SHEET_ID);
    const MONTHS_12 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // ── ATM ──────────────────────────────────────────────────────────────────
    const atmSheet = ss.getSheets().find(s => s.getSheetId() === ATM_SHEET_GID);
    if (!atmSheet) throw new Error('ATM sheet not found');
    const atmData = atmSheet.getDataRange().getValues();

    // The multiplier row has a decimal (1.75) in col A; its cols B-M are the revenue
    let atmRevRow = null;
    for (let i = 0; i < atmData.length; i++) {
      const v = atmData[i][0];
      if (typeof v === 'number' && v > 1 && v < 3) { atmRevRow = atmData[i]; break; }
    }
    const atm = {};
    MONTHS_12.forEach((m, j) => {
      atm[m] = atmRevRow ? (Number(atmRevRow[j + 1]) || 0) : 0;
    });

    // ── Sublet ────────────────────────────────────────────────────────────────
    const subSheet = ss.getSheets().find(s => s.getSheetId() === SUBLET_SHEET_GID);
    if (!subSheet) throw new Error('Sublet sheet not found');
    const subData = subSheet.getDataRange().getValues();

    let subTotalRow = null;
    for (let i = 0; i < subData.length; i++) {
      if (String(subData[i][0]).trim().toUpperCase() === 'TOTAL') { subTotalRow = subData[i]; break; }
    }
    const sublet = {};
    MONTHS_12.forEach((m, j) => {
      sublet[m] = subTotalRow ? (Number(subTotalRow[j + 1]) || 0) : 0;
    });

    const content = JSON.stringify({ atm, sublet });
    cacheSet_('otherrev', content, 3600); // 1 hour
    output.setContent(content);
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
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

# Handoff: Income dashboard layout (mobile 1c + desktop 2a)

## Overview
Two redesigned layouts for the Income section of the Green Cross sales dashboard
(`index.html`, the single-file Apps Script web app):

- **Mobile (option 1c)** — the phone screen restructured so net sales is the first thing on
  screen and all controls (period, store filter, sections) live in a pinned bottom tray.
- **Desktop (option 2a)** — the >=768px layout rebuilt in the same language: net sales hero
  plus projection card, six KPI cards, store breakdown as a real table, full-width Fridays
  chart, and a trimmed sidebar whose period fields are interactive.

Both are the Income tab only. Expenses and Inventory are unchanged.

## About the Design Files
The two files in this bundle (`Mobile Income.dc.html`, `Desktop Income.dc.html`) are
**design references written in HTML** — prototypes showing intended look and behavior, not
production code to copy. Data in them is fabricated sample data.

The target codebase is the existing `index.html`: vanilla JS, CSS classes on
`:root` custom properties (aliased to the `gx-theme.css` `--gx-*` tokens), section
renderers that build HTML strings (`renderIncome()`, `_incomeKpiHtml()`,
`_incomeStoreBreakdownHtml()`, `_incomeTopProductsHtml()`, `_incomeChartLabel()`),
and a single desktop media query:
`@media(min-width:768px) and (hover:hover) and (pointer:fine)`.

Implement these designs **in that file, with its existing class + renderer patterns and
`var(--*)` tokens**. Do not port the inline styles from the prototypes verbatim, and do not
introduce a framework or build step — the app is served by Apps Script as one HTML file.

## Fidelity
**High-fidelity.** Colors, type sizes, spacing, radii and copy in the prototypes are the
intended final values. Match them, expressed through the existing tokens (e.g. `#121715` is
`var(--card)`, `#4ade80` is `var(--green)`, `#232a27` is `var(--border)`,
`#8a958f` is `var(--dim)`, `#5e6864` is `var(--muted)`, `#e6ece9` is `var(--text)`).
Store swatch colors are already in the codebase; keep them.

---

## Screen 1 — Mobile Income (option 1c)

**Purpose:** answer "are we on pace this month" in one glance, with no scroll before the number.

**Layout** — 390pt wide, single column, `padding:0 16px`, sections stacked with 16px gaps.
Nothing above net sales except the device status bar: the logo row, store status grid, section
tabs, time-nav scroller and store pill scroller are all removed from the top of the document.

### Hero card (net sales)
- `background:var(--card)`, `border-radius:12px`, `padding:16px`, `margin-bottom:10px`
- Row: label `Net sales · August` — 11px, `var(--dim)`, uppercase, `letter-spacing:.06em`;
  right side stacks the live-refresh indicator (6px pulsing `var(--green)` dot + time, 11px,
  `gxpulse` 2s ease-in-out infinite, opacity 1 -> .4) over `day 14 of 31` (11px, `var(--muted)`).
  This is the only place the live dot appears — it moves out of the old header pill.
- Value: 38px, weight 500, `var(--text)`, `line-height:1.05`, `letter-spacing:-.01em`
- Pace bar: 6px tall, `margin:14px 0 9px`, track `var(--border)` radius 3px, fill
  `linear-gradient(to right,rgba(74,222,128,.18) 0%,#4ade80 100%)` at % of goal, plus a 2px
  elapsed-time marker at % of period elapsed (`var(--green)`, opacity .75,
  `box-shadow:0 0 5px #86efac`). Same construction as the existing `.sbar-*` classes.
- Footer row: `+$26,860` 14px weight 600 `var(--green)` (red/amber when behind) then
  `over pace · 46% of $2.48M goal` 12px `var(--dim)`.

### Store breakdown card
`background:var(--card)`, `border-radius:10px`, `padding:6px 12px`, rows separated by
`.5px solid var(--border)` (last row none). Each row, 11px vertical padding, 10px gap:
9px round store swatch / name 13px `var(--text)` above a 5px pace bar (same fill + marker
rules, amber `#eab308` when behind, red `#ef4444` when far behind) / net 14px weight 500
right-aligned `min-width:62px` / stacked `% of goal` 11px `var(--muted)` over the pace
delta 14px weight 600 in green/amber/red, `min-width:58px`.
Row order is by pace delta, best first.

### Secondary KPIs
2-col grid, 9px gap. Card: `var(--card)`, radius 8px, padding 11px; label 10px
`var(--muted)` uppercase; value 21px weight 500; sub 11px. Content: Gross profit /
Transactions / Discounts / Gross sales.

### Fridays chart
Label row above the card: `All Fridays · 2026` 10px uppercase `var(--muted)`, right side
`stacked by store` 10px. Card `var(--card)` radius 10px padding `12px 12px 8px`;
stacked bar chart (one bar per Friday, segments per store, dashed
`rgba(255,255,255,.45)` target line, current-week bar outlined and at 95% opacity);
legend below a `.5px` divider — six store swatches 7px + `Friday target` dashed key.

### Pinned bottom tray (fixed to the bottom of the viewport)
1. Filter row — `background:rgba(10,14,13,.97)`, `border-top:.5px solid var(--border)`,
   `padding:8px 12px`, 7px gap, two equal 44px-tall buttons (radius 10px, `.5px solid
   var(--border-strong)`, `background:var(--card-2)`): calendar icon + `August 2026`
   (14px weight 600 `var(--text)`) and list icon + store filter label (14px weight 500
   `var(--dim)`), each with a caret. They open the sheets they sit next to.
2. Section nav — 74px tall, same background and top border, 4-col grid:
   Income / Expenses / Inventory / Settings. 22px stroked icons, 10px labels;
   active is `var(--green)` weight 600, inactive `var(--muted)`.
   Settings moves here — the sidebar gear is gone on mobile.

### Sheets (bottom sheets, over a `rgba(0,0,0,.55)` scrim)
`background:var(--card)`, `border-top:.5px solid var(--border-strong)`,
`border-radius:16px 16px 0 0`, `padding:14px 16px 22px`, 36x4 grab handle centered.
- **Period sheet** — title `Period` 15px weight 600; four granularity fields, then the
  values for the active one; future values dimmed to .38 and non-interactive (existing
  `.mtab.future` rule).
- **Store sheet** — checkbox rows, 18px radius-5 boxes, store dot, name 14px, net 13px
  `var(--dim)`, % 12px colored by pace. Any combination allowed; header pill reads
  `Century +1` for two, snaps back to `All stores` when all six are on.

**What is removed on mobile:** the six-card store status grid and the store pill scroller
(the breakdown card carries that information), the horizontal time-nav scroller (replaced by
the period sheet), and the header logo row (the tray owns navigation).

---

## Screen 2 — Desktop Income (option 2a)

**Purpose:** same question at desk scale, using the width instead of stacking phone cards.

**Layout** — `.w` stays `max-width:1400px`, `padding:24px`,
`grid-template-columns:264px 1fr`, `gap:0 32px` (sidebar narrows from 360px). Main column
is a flex column, 14px gaps. Everything through the KPI row sits above a 900px fold.

### Sidebar (sticky, `top:24px`)
1. Header — gx logo image at 140px wide
   (`https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png`) with the live pill
   right-aligned: 6px pulsing green dot + time, 11px `var(--green)`,
   `background:rgba(74,222,128,.1)`, radius 20px, `padding:3px 8px`.
2. Section nav — vertical, 3px gaps, rows `padding:9px 12px` radius 8px with a 16px stroked
   icon + 13px label. Active row `background:var(--green)`, ink `#07100c` weight 600;
   inactive `var(--dim)` on transparent, hover `var(--card-2)`.
3. Period — section label 10px uppercase `var(--muted)`, then a 2x2 grid (6px gap) of
   Year / Month / Week / Day fields: `min-height:44px`, radius 8px, `.5px` border,
   `background:var(--bg)`, 9px uppercase label over the value (13px) and an 11px caret.
   Border is `var(--border)` when unset, `var(--border-strong)` when set,
   `var(--green)` + `rgba(74,222,128,.06)` when open.
   **Clicking a field opens its value list directly below** — one panel,
   `.5px solid var(--border-strong)`, radius 8px, `background:#0f1413`, padding 8px:
   header `Select month` + a `Close` text button, then wrapped chips (11px, radius 6px,
   `padding:5px 9px`, `max-height:168px` scroll). Selected chip is `var(--green)` with
   `#07100c` ink; future values `color:#2e3733`, `border-color:#1c2320`, not clickable.
   Picking a value closes the panel. There is no standing pill row — the old
   `.time-nav` scroller is gone on desktop too.
4. Stores — label row with `All 6` count in `var(--green)`; six rows
   (`padding:7px 8px`, radius 7px, `background:var(--card)`, 2px gaps) of
   16px green checkbox / 8px store dot / name 13px / % of goal 12px colored by pace.
   This single list replaces both the `.store-status-grid` and the `.store-scroll` pills.
5. Gear — right-aligned above a `.5px` top border, `padding-top:12px`.

### Hero row — `grid-template-columns:1fr 300px`, 14px gap
- **Net sales card** `var(--card)`, radius 12px, `padding:22px 24px`:
  label `Net sales · <period>` 11px uppercase `var(--dim)` (bound to the sidebar
  selection); value 64px weight 500 `letter-spacing:-.02em` on the same baseline as
  `+$26,860` 19px weight 600 `var(--green)` + `over pace` 13px `var(--dim)`;
  8px pace bar (`margin:20px 0 10px`, radius 4px, 5px-tall marker,
  `box-shadow:0 0 6px #86efac`); footer row 13px `var(--dim)` —
  `46% of $2.48M goal` left, `day 14 of 31 · 45% elapsed` right.
- **Projection card** same shell, space-between: `Projected month` label, `$2.53M`
  32px, `+$52,400 above goal` 13px `var(--green)`; below a `.5px` divider two
  label/value rows at 13px — `Daily run rate $81,633`, `Needed to goal $78,650`.

### KPI row — 6 columns, 12px gap
`var(--card)`, radius 10px, `padding:15px 16px`; label 10px uppercase `var(--muted)`,
value 25px weight 500, sub 12px:
Gross profit `$541,860` / 47% of net · Margin `47.4%` / +0.6 pts vs July ·
Transactions `24,118` / 1,723 per day · AOV `$46.99` / +$1.12 vs July ·
Discounts `$138,420` / 12% of sales · Gross sales `$1,281,280` / before discounts.
Margin and AOV are peer KPIs here, not sublines of profit and transactions
(`.kpi-grid` becomes `repeat(6,minmax(0,1fr))` at >=768px).

### Lower row — two equal columns, 14px gap, `align-items:start`
- **Store breakdown table** `var(--card)`, radius 10px, `padding:6px 18px 10px`.
  Header row (10px uppercase `var(--muted)`, `.5px solid var(--border)` under it):
  Store / Net / Goal / vs pace. Body rows `padding:14px 0`, divider
  `.5px solid #1c2320`, 12px gap: 9px dot / name 14px above a 5px full-width pace bar with
  the elapsed marker at 45% / net 16px weight 500 `min-width:82px` / % 13px `var(--dim)`
  `min-width:44px` / delta 14px weight 600 colored `min-width:74px`.
  Final unbordered row totals `All stores`.
- **Fridays chart** `var(--card)`, radius 10px, `padding:16px 18px 12px`; header
  `All Fridays · 2026` + `stacked by store · dashed line is target` 11px
  `var(--muted)`; chart viewBox 600x250, `padL:44 padB:40 padT:8`, gridlines every
  $5k to $35k with 10px `var(--muted)` labels, x labels every third Friday rotated -45deg
  at 9px, dashed target line at $26k, current Friday outlined; legend under a `.5px`
  divider, six 8px swatches at 11px.
- **Top products** below the chart, same shell, `padding:6px 18px 12px`; label
  `Top products · <period>`; rows `padding:9px 0`: rank 16px `var(--muted)` /
  name 13px / revenue 14px weight 500 `min-width:70px` / units 12px `var(--muted)`
  `min-width:58px`.

Footer: `Updated 9:41:07 AM` 11px `var(--muted)`, centered (existing `.last-sync`).

---

## Interactions & Behavior
- **Desktop period fields** — click toggles the value panel for that granularity (clicking the
  open field closes it); only one panel open at a time; picking a value sets it and closes;
  `Close` dismisses. Selection drives the hero label and the top-products label
  (`Net sales · June 2026`, `Top products · June`). Future months/weeks/days are dimmed
  and inert. In the real app the selection also drives the data fetch, exactly as the current
  `.mtab` / `.wtab` / `.dtab` handlers do.
- **Mobile tray buttons** — each opens its own bottom sheet (period, stores); sheets slide up
  over a scrim and close on scrim tap or selection. Reuse the existing settings-drawer timing:
  `0.22s cubic-bezier(.4,0,.2,1)`.
- **Store filter** — multi-select checkboxes; label collapses to `All stores` when every
  store is on, `Century +1` style otherwise.
- **Pace bars** — keep the current `width` transition (`1s ease-out`) and the
  `sbarGlowPulse` animation on bars that are over pace.
- **Live dot** — 2s ease-in-out opacity pulse; tapping it still refreshes
  (`refreshLiveData()`).
- Hover states are desktop-only (the media query already gates on `hover:hover`): sidebar
  nav rows and period fields lighten their background/border; table rows need no hover.

## State Management
Existing globals cover most of this — `section`, the selected year/month/week/day, the
store filter set, `costData`, `_incomeMounted` / `_incomeViewType`. New state:
- `openPeriodField`: `'year' | 'month' | 'week' | 'day' | null` (desktop sidebar panel)
- `openSheet`: `'period' | 'stores' | null` (mobile tray sheets)
Both are pure UI state; neither should trigger a fetch. Keep the targeted-update path in
`renderIncome()` — only the period/store selection change should re-render KPI, breakdown,
chart and top-product blocks.

## Design Tokens
Colors (prototype hex -> existing token):
`#07100c` page backdrop of the mock frames · `#0a0e0d` `--bg` ·
`#121715` `--card` · `#161c1a` `--card-2` · `#0f1413` period panel (new, one use) ·
`#232a27` `--border` · `#1c2320` inner divider · `#2e3733` `--border-strong` ·
`#e6ece9` `--text` · `#8a958f` `--dim` · `#5e6864` `--muted` ·
`#4ade80` `--green` · `#07100c`/`#06210f` green ink · `#86efac` glow ·
`#eab308` `--amber` · `#ef4444` `--red` · `#60a5fa` `--blue`.
Store swatches: Century `#1D9E75`, Center `#378ADD`, Commercial `#D85A30`,
Baseline `#7F77DD`, Portland `#BA7517`, River `#D4537E`.

Spacing: 2 / 5 / 6 / 7 / 9 / 12 / 14 / 16 / 20 / 24 / 32.
Radii: 4 (bar) / 6 (chip) / 7 / 8 (`--radius`) / 10 / 12 / 14 (frame) / 20 (pill).
Type: system stack via `var(--gx-font)`. Mobile 9 / 10 / 11 / 12 / 13 / 14 / 21 / 38.
Desktop 9 / 10 / 11 / 12 / 13 / 14 / 16 / 19 / 25 / 32 / 64. Weights 400 / 500 / 600.
Uppercase labels carry `letter-spacing:.05em`–`.07em`.
Borders are `0.5px` throughout, matching the existing CSS.

## Assets
- gx logo: `https://greencrosscanna.github.io/greencross-gx-theme/gx-logo.png`
  (already referenced by `index.html`); `GreenCross_Logo_Secondary_Simple_Green.png`
  ships in the repo as the alternate mark.
- Theme: `https://greencrosscanna.github.io/greencross-gx-theme/gx-theme.css`.
- Icons are inline stroked SVGs (24x24 viewBox, `stroke-width:2`, round caps), in the
  same family as the existing gear icon. No icon library.
- No raster imagery in either design.

## Screenshots
- `screenshots/desktop-income-2a.png` — desktop option 2a as rendered.
- `screenshots/mobile-income-1c.png` — mobile option 1c, with the period and store sheets.
The screenshots are flat renders; the HTML files are the source of truth for values.

## Files
- `Mobile Income.dc.html` — mobile option 1c, at 390pt with the iPhone-14 fold marked,
  plus the period and store sheets drawn beside the screen.
- `Desktop Income.dc.html` — desktop option 2a, at 1440x900 with the fold marked;
  the sidebar period fields are live, so the panel behavior can be clicked through.
Both open directly in a browser. Ignore the annotation text and badges around the frames —
they are commentary for this handoff, not part of the design.

Target file to change: `index.html` (Income section: `renderIncome()` and the
`_income*Html()` builders, the `.kpi-grid` / `.srow` / `.sbar-*` / `.period-*` /
`.section-tabs` / `.store-*` CSS, and the
`@media(min-width:768px) and (hover:hover) and (pointer:fine)` block).

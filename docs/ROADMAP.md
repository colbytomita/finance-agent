# Improvement Roadmap — v3 (2026-07-09)

Roadmaps v1 (#1–#14) and v2 (#15–#28) are **complete** — see the archives at
the bottom. This v3 list came from a fresh pass over the codebase on
2026-07-09; every "Why" cites the actual code it's grounded in. Items are
numbered #29+ so git-history references to "roadmap #N" stay unambiguous.

Work top-to-bottom within a tier. Recommended sequencing: **29 → 30** first
(both are fully implemented, fully tested safety features that are wired to
nothing), then Tier 2 surfaces data the DB already holds, then Tier 3 QoL.

## Working agreement (read before starting any item)

- Read `README.md`, `AGENTS.md`, and `docs/agent-memory.md` first.
- Real data only — never run `db:seed`, never fabricate rows.
- Keep the "decision support, not advice" framing: model output is labeled as
  interpretation; Catalyst Edge stats are historical correlation, not
  prediction.
- Schema changes: edit `src/db/schema.ts`, run
  `npm run db:generate -- --name <slug>`, commit the `drizzle/` output. Never
  edit applied migrations or `src/db/legacyBaseline.ts`.
- `npm run jobs` does not hot-reload — restart it after code changes.
- Before calling an item done: `npm run typecheck`, `npm test`, and verify the
  behavior live (`npm run dev`, exercise the real page/API). Small fixes go
  straight to `main`; features get a branch and a `Merge: <title> (roadmap
  #N)` merge commit (see git history for the style).
- New code uses the shared modules — `src/services/llm.ts`,
  `src/components/useApiAction.ts`, `src/lib/util.ts` (`nowIso`, `clamp`,
  `errorMessage`, `mapPool`), `src/services/watchlist.ts` — don't re-roll
  them. Since #26, quote refresh lives in `src/services/quotes.ts`, the bar
  store in `src/services/bars.ts`, and `getTrackedTickers` in
  `@/lib/queries`; `marketData.ts` is analysis orchestration only.

## Tier 1 — Wire up the dead safety features

- [x] **29. Pre-trade risk gate: wire `validateProposedTrade` into trade
  entry** *(medium — done)*
  **Why:** `validateProposedTrade` (`src/services/riskManagement.ts:134`)
  checks exactly what a swing trader should see before entry — no stop
  defined, no target, R/R below `minRiskReward`, inside the
  `avoidEarningsWithinDays` window — and it has unit tests
  (`riskManagement.test.ts:87`). **Nothing calls it.** The order dialog
  (`TradeOrder.tsx`) and both write paths (`POST /api/trades/place`,
  `POST /api/trades`) submit with zero risk-rule feedback; the only
  server-side check is bracket-leg sidedness.
  **What:** In both API routes, run `validateProposedTrade` (entry = limit
  price / reference price / entryPrice; `daysToEarnings` from
  `daysToNextEarnings(ticker)`; thresholds from config). When problems exist
  and the request doesn't set `confirmRisks: true`, return 400 with
  `{ error, riskProblems }` — mirroring the existing `confirmLive` pattern,
  so it's a speed bump, never a hard block (decision support, not an
  autopilot). In `TradeOrder.tsx`, surface returned `riskProblems` with a
  "place anyway" confirm path; optionally pre-compute the R/R warning
  client-side as the user types.
  **Accept:** Unit/route tests: no-stop and thin-R/R trades → 400 with
  problems listed; same request + `confirmRisks` → succeeds; clean trade →
  no friction. Live: the dialog shows the problems and the confirm path
  works.

- [x] **30. Account-level concentration alerts: wire `concentrationWarnings`
  into `generateAlerts`** *(small — done)*
  **Why:** `concentrationWarnings` (`riskManagement.ts:104`) computes
  per-position and per-sector weight breaches against
  `maxPortfolioConcentrationPercent` / `maxSectorConcentrationPercent` — both
  configurable in Settings — and is tested. **No caller.** `generateAlerts`
  (`alerts.ts:65`) covers stops/targets/scores/catalysts/staleness but never
  concentration; per-position weight only feeds the trade *score*
  (`tradeScoring`), which a holdings-only user never sees.
  **What:** In `generateAlerts`, build positions from `portfolio_holdings`
  (`marketValue`) plus open trades (`shares × currentPrice`), account value
  via `currentAccountValue()`, and emit one `warning` alert per breach
  through the existing `emit` dedupe. Note: holdings carry no sector data
  today, so pass `sector: null` and let only the position-weight half fire —
  don't invent sectors.
  **Accept:** Persistence test: an oversized holding → exactly one alert,
  rerun → no duplicate; under-cap → none. Live: visible in the alerts feed
  with real holdings.

## Tier 2 — Surface data the DB already holds

- [x] **31. Portfolio equity curve (daily account-value snapshots)**
  *(medium — done)*
  **Why:** `portfolio_holdings` is current-state only and
  `market_price_snapshots` is per-ticker — the app cannot answer "how has my
  account done over time?" even though it recomputes
  `currentAccountValue()` constantly. Realized-trade stats exist, but no
  equity curve.
  **What:** New `portfolio_snapshots` table (normal migration flow): one row
  per calendar day — total holdings value, open-trade value, holding count —
  upserted (not stacked) by daily maintenance and by `fullRefresh`. On
  `/portfolio`, render a dependency-free SVG equity curve (reuse the
  `PriceChart` idiom) once ≥2 days exist, with SPY normalized to the same
  start for comparison; before that, show "collecting — N day(s) so far".
  Real data only: the curve starts today, no backfill fabrication.
  **Accept:** Persistence test: two upserts same day → one row, next day →
  two. Live: after a refresh the row exists and the page states its day
  count honestly.

- [x] **32. Upcoming-earnings calendar view** *(small — done; card lives on
  the Summary page)*
  **Why:** #16 auto-fetches upcoming-earnings dates into `catalysts`
  (type=earnings, status=upcoming, `EARNINGS_CALENDAR_SOURCE`), but they
  surface only as per-row badges. There's no single "what reports in the
  next two weeks across everything I track" view — the exact question the
  earnings guard is about.
  **What:** A card on the Catalysts page (or Summary if it fits better):
  tracked tickers' upcoming-earnings catalysts within N days (default 14),
  sorted by date, with the existing days-to badge styling and links to the
  stock pages. Pure read of existing rows — a `lib/queries` helper + UI.
  **Accept:** With real fetched dates, the card lists them soonest-first and
  shows nothing (with a quiet empty state) when no reports are near.

- [x] **33. Score-history sparkline on the stock page** *(small–medium —
  done)*
  **Why:** `stock_scores` keeps an append-only per-ticker time series
  (retention thins to one row/ticker/day precisely so history survives), and
  Signal Performance proves the data is usable — but `/stock/[ticker]` shows
  only the latest score. "Is this name improving or decaying?" requires the
  performance page detour.
  **What:** Small SVG sparkline of `overallScore` over the stored history
  (reuse the Sector Scout sparkline idiom from #25) next to the score block,
  with min/max labels and a "N points since <date>" caption so short
  histories aren't over-read.
  **Accept:** Renders real history for a long-tracked ticker; a
  single-point history states "no trend yet"; no new deps.

## Tier 3 — Operational QoL

- [x] **34. Test-notification button in Settings** *(small — done)*
  **Why:** Notification wiring (desktop toast + ntfy, #15/#9) can only be
  verified by lowering `notifyMinSeverity` and waiting for a real alert —
  so a broken ntfy topic or PowerShell toast path stays silent until it
  matters.
  **What:** "Send test notification" button in the Settings notifications
  block → `POST /api/settings/test-notification` → calls the existing
  channel senders directly (bypassing severity gating, labeled as a test),
  returns per-channel ok/error for display.
  **Accept:** Clicking it with ntfy configured delivers to the phone and
  reports per-channel results in the UI; with nothing configured it says so
  instead of pretending success.

- [x] **35. Acknowledge-all on `/alerts`** *(small — done)*
  **Why:** The alerts page (#27) acknowledges one row at a time; after a
  noisy day (stale-data warnings across 45 tickers) that's dozens of
  clicks.
  **What:** An "Acknowledge all shown" button that acks the current
  *filtered* set via one API call (`POST /api/alerts/ack-all` with the same
  filter params), with row count in the label.
  **Accept:** Filter to a subset → button acks exactly that subset; route
  test covers filter scoping.

## Tier 4 — Follow-ups spotted while shipping v3 (2026-07-09)

- [x] **36. Alert-table retention** *(small — done)*
  **Why:** `runRetention` pruned snapshots/drawdowns/score history but never
  `alerts` — 278 unacked rows and growing, dominated by repeated stale-data
  warnings the 20h dedupe happily re-emits every day.
  **What:** In `runRetention`: auto-acknowledge non-critical alerts left
  unacked for 14+ days (no longer actionable; the row survives as audit
  trail; **critical is never auto-acked** — it waits for the user), and
  delete acknowledged alerts older than 90 days. Reported in the maintenance
  log line.
  **Accept:** Persistence test covers auto-ack severity gating, recent rows
  untouched, and the delete window. Live run auto-acked 29 stale alerts on
  the real database.

- [x] **37. Sector data for holdings** *(medium — done)*
  **Why:** Nothing stores a sector, so the sector half of
  `concentrationWarnings` (#30) can never fire, and the portfolio has no
  sector breakdown. Yahoo `quoteSummary` `assetProfile` carries
  sector/industry, and `fundamentals.ts` already requests that module for
  discovery — the plumbing exists.
  **What:** Add `sector` to `portfolio_holdings` (migration). Backfill in
  daily maintenance (and on portfolio sync) via a small
  `getYahooSector(ticker)` (or reuse the fundamentals fetch), only for rows
  missing it. Pass real sectors into the #30 concentration scan (drop the
  `sector: null` placeholder), and show a small sector-weights strip on
  `/portfolio`.
  **Accept:** After one maintenance run, real holdings carry sectors, the
  strip renders true weights, and an over-cap sector emits the warning
  alert (persistence-tested with seeded sectors).

- [x] **38. `trade_setups` retention that preserves the backtest's episodes**
  *(small — done)*
  **Why:** `scanForSetups` re-inserts every live setup on each refresh
  (~854 rows in the first 12 days) and nothing pruned the table. The catch:
  the setup backtest's `dedupeSetups` chains rows into episodes by ≤10-day
  gaps and resolves outcomes from each episode's **earliest** row, so naive
  deletion could split episodes or change their entry/stop levels.
  **What:** In `runRetention`: for non-active rows older than 30 days, keep
  the first row (`MIN(id)`) per (ticker, setupType, day) — episode-start
  rows survive exactly and gap chaining is unchanged at day resolution.
  **Accept:** Persistence test proves `dedupeSetups` returns identical
  episodes before and after thinning, and active rows are never touched.

## Archive — v2 (2026-07-06 review), all done 2026-07-09

`#15` Windows desktop notifications · `#16` auto-fetch upcoming earnings
dates (earnings guard live) · `#17` setup outcome backtest (Signal
Performance §4) · `#18` jobs runner as a Windows Scheduled Task · `#19`
`db:restore` backup restore path · `#20` SQLite housekeeping in maintenance ·
`#21` market-regime context for entries · `#22` trade & journal CSV export ·
`#23` price-chart volume + event markers · `#24` entity watch + new-mention
alerts · `#25` Sector Scout industry trend sparkline · `#26` split
`marketData.ts` into quotes/bars/orchestration · `#27` alerts history page ·
`#28` esbuild override for drizzle-kit's dev-only advisory.

## Archive — v1 (2026-07-01 review), all done 2026-07-05

Kept for git-history reference ("roadmap #N" in commit messages):
`#1` Alpaca order-fill sync · `#2` data retention · `#3` scheduled Signal
Performance backtest · `#4` job-health heartbeat + badge · `#5` drizzle-kit
migrations (schema written once) · `#6` in-memory SQLite test harness ·
`#7` parallelized Sector Scout · `#8` Yahoo over plain HTTP (browser demoted
to fallback) · `#9` alert notifications (desktop/ntfy) · `#10` bracket-leg
auto-close · `#11` watchlist bulk import · `#12` → carried to #26 ·
`#13` /status page · `#14` daily VACUUM INTO backups.

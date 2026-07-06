# Improvement Roadmap

Prioritized task list from the 2026-07-01 full-codebase review (post PR #27
consolidation refactor). Work top-to-bottom within a tier; tiers are ordered by
value-to-effort. Check items off as they land.

Recommended sequencing: **1 → 3 → 2 → 4** as one "operational trust" arc (they
make the numbers you act on trustworthy), then **5 + 6** before the next feature
work, then Tier 3 by taste.

## Tier 1 — Correctness & reliability

- [x] **1. Sync Alpaca order fills back into trades** *(medium — done, PR #28)*
  `brokerOrderId` is written at placement (`trades/place`) but never read again.
  A limit order that never fills, gets canceled, or partially fills leaves a
  phantom "open" trade with wrong entry data — which feeds trade scores and
  realized-performance stats. Add a scheduler job: poll open trades' order
  status via Alpaca, update `entryPrice`/`shares` to actual fill, and
  flag/cancel trades whose orders were canceled or expired.

- [x] **2. Data retention for append-only tables** *(small — done)*
  `market_price_snapshots`, `stock_scores`, `drawdown_metrics`, `score_history`
  are never pruned. At the market-open cadence (120s × N tickers) snapshots grow
  by thousands of rows/day. Add a retention pass to daily maintenance (e.g. keep
  last N days of snapshots/drawdowns; **thin, don't truncate** `stock_scores` —
  Signal Performance uses the score history as its event source).

- [x] **3. Schedule the Signal Performance backtest** *(small — done)*
  It's manual-only ("Run backtest") with a cached report — the
  industry-performance strip in Sector Scout silently shows stale data. Run it
  in daily maintenance after the refresh.

- [x] **4. Job health visibility** *(small–medium — done)*
  The scheduler only logs to console; if `npm run jobs` dies, nothing in the UI
  says so. Generalize the `ingestion_runs` idea: a small `job_runs` heartbeat
  table written by the scheduler + a "jobs last ran X min ago" indicator in the
  dashboard header (red when stale).

## Tier 2 — Code health

- [ ] **5. drizzle-kit migrations** *(medium)*
  Schema is written twice (`schema.ts` + DDL string in `db/index.ts`) with
  try/catch `ALTER`s for migrations. Migrate to generated migrations; write the
  schema once. Do this *before* the next feature that adds tables.

- [x] **6. Integration-test harness with in-memory SQLite** *(medium — done)*
  All tests are pure functions — zero coverage on the persistence layer
  (upserts, status preservation on re-scan, ingestion logging, accept/dismiss
  flows). `better-sqlite3` supports `:memory:`; make `getDb()` injectable and
  add a suite for the write paths.

- [x] **7. Parallelize Sector Scout scans** *(small — done)*
  `runSectorScan` analyzes tickers sequentially — 24 candidates × network
  fetches makes scans slow. `mapPool` already exists in `marketData.ts`; move it
  to `lib/util.ts` and use it (respect the thesis budget).

## Tier 3 — Features

- [x] **8. Reduce Yahoo/Playwright dependence** *(medium–large — done)*
  The most fragile subsystem. Evaluate replacing headless-browser scraping with
  Yahoo's plain `quoteSummary`/`chart` HTTP endpoints (fetch + crumb/cookie
  handling), keeping the browser as fallback. *(Quotes, earnings, and daily
  bars now go over plain HTTP; the browser remains only as fallback and for
  the news-page scan.)*

- [x] **9. Alert notifications** *(small–medium — done)*
  The alerts feed only shows when you look at it. Stop-loss proximity warnings
  should reach you — Windows toast from the scheduler, or push via
  ntfy/Telegram for high-severity alerts.

- [x] **10. Trade lifecycle polish** *(medium — done)*
  With #1 in place, bracket-order legs (stop/target fills) can auto-close
  trades and pre-fill the journal entry with the actual exit price — making
  realized-performance stats trustworthy without bookkeeping discipline.

- [x] **11. Watchlist bulk import** *(small — done)*
  Paste a comma/newline ticker list → validate against real data (reuse the
  Sector Scout validation path) → add.

## Tier 4 — When bored

- [ ] **12. Split `marketData.ts`** (only if it keeps growing)
- [x] **13. `/status` page** — integrations health, last job runs, DB size, bar coverage per ticker *(done)*
- [x] **14. Backup story** — daily `VACUUM INTO` copy of the SQLite file in maintenance *(done)*

# Agent Memory

Last updated: 2026-07-05.

## Current State

`finance-agent` is a market-research and swing-trading decision-support
dashboard. It tracks portfolio/watchlist/trades, pulls market data, scores
stocks and trades, detects swing setups, monitors catalysts, proposes Agent
Picks and Sector Scout picks, tracks earnings surprises, runs Catalyst Edge
event studies, and backtests its own signals (Signal Performance).

On 2026-07-05 the entire `docs/ROADMAP.md` was completed (except the
conditional #12), including:

- **Data path:** Yahoo quotes/earnings/daily bars now go over plain HTTP
  (`src/services/yahooHttp.ts`, cookie+crumb session); the headless browser is
  only a fallback and the news-page scanner. Discovery works without Alpaca
  keys (Yahoo chart bars).
- **Trade lifecycle:** broker order sync reconciles fills, cancels phantoms,
  and auto-closes trades when a bracket stop/target leg fills (shared
  `closeTrade` in `src/services/trades.ts` pre-fills the journal).
- **Ops:** `job_runs` heartbeat + header badge, `/status` page, retention
  pruning for append-only tables, daily `VACUUM INTO` backups (`data/backups/`,
  keeps 7), scheduled Signal Performance backtest, desktop/ntfy alert
  notifications (off by default; Settings).
- **Schema:** written once in `src/db/schema.ts`; drizzle-kit migrations in
  `drizzle/` are applied by `getDb()`; pre-migration DBs are baselined via the
  frozen `src/db/legacyBaseline.ts`. Migration 0001 added
  `ingestion_runs.skipped_json`.
- **Tests:** 307 across 29 files — pure logic plus an in-memory-SQLite harness
  (`src/services/__tests__/dbHarness.ts`) covering persistence write paths and
  direct route-handler smoke tests (`src/app/api/__tests__/routes.test.ts`).

The 2026-06-26 "Likely Next Work" items are all done (2026-07-05): per-item
skipped reasons in ingestion results (returned, stored, and shown on `/events`),
a same-day duplicate guard for manually added mentions (`findSameDayMention` +
`duplicate: true` from `POST /api/events`), stale-catalyst labeling on the
stock-detail timeline, and the route smoke tests.

## Important Constraints

- This is real-data-first. Do not seed demo data or fabricate rows.
- Existing SQLite data may be the user's working data.
- Scoring and UI must keep the "decision support only" framing.
- Catalyst Edge statistics must always be labeled as historical correlation, not
  advice or prediction.
- Social platforms are not scraped directly; ingest news coverage or official
  sources instead.
- Alpaca bars are expected to be ascending, oldest to newest (the Yahoo chart
  helper returns the same shape/order).
- `getDb()` caches the connection and runs migrations once per process; schema
  changes require a dev-server restart. Tests get a fresh in-memory DB via
  `useTestDb()` from `src/services/__tests__/dbHarness.ts`.
- Schema changes: edit `src/db/schema.ts`, then
  `npm run db:generate -- --name <slug>`, commit the `drizzle/` output. Never
  edit applied migrations or `src/db/legacyBaseline.ts`.

## Likely Next Work

- Roadmap #12 (split `marketData.ts`) only if it starts growing again.
- The Yahoo news scanner (`scanYahooNews`) still drives the headless browser
  and is layout-fragile — consider an HTTP/RSS replacement like the quote path.
- Notifications currently fire on every new alert insert from any process;
  consider batching or digesting if they get noisy at market open.
- `refreshPrices` stores bars only via Alpaca (`fullRefresh`); tracked tickers
  without Alpaca get quotes but no stored bars — could reuse
  `getYahooDailyBars` in the bar-refresh path for keyless setups.
- Bulk import caps at 50 tickers per request and runs serially per batch of 5;
  fine for pastes, revisit if used for large lists.

## Standard Commands

```bash
npm run typecheck
npm test
npm run dev
npm run jobs
npm run db:generate -- --name <slug>
```

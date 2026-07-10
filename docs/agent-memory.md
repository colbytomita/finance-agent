# Agent Memory

Last updated: 2026-07-09.

## 2026-07-09 session — roadmap v2 finished, v3 written and finished

- **v2 closed out:** #26 split `marketData.ts` — quote refresh now lives in
  `src/services/quotes.ts`, the bar store in `src/services/bars.ts`,
  `getTrackedTickers` in `@/lib/queries` (marketData re-exports it and
  `getLatestSnapshot`); `marketData.ts` is analysis orchestration only.
  #28 resolved via a scoped npm override (`@esbuild-kit/core-utils` →
  `esbuild ^0.25.0`) — `npm audit` clean without downgrading drizzle-kit.
- **Roadmap v3 (#29–#35) written from a fresh pass and fully shipped the
  same day:** pre-trade risk gate on both trade routes (`confirmRisks`
  bypass mirrors `confirmLive`; shared `pretradeRiskProblems` in
  `services/trades.ts`; `useApiAction` gained `onErrorData`); account
  concentration alerts in `generateAlerts` (holdings + non-held open
  trades, no sector data so only position-weight fires);
  `portfolio_snapshots` (migration 0005) + equity curve on /portfolio
  (SPY rebased overlay, honest "collecting" state); upcoming-earnings
  calendar card on Summary (`upcomingEarningsCalendar` in lib/queries);
  score-history sparkline on the stock page (`scoreSeries` collapses
  stock_scores to last-per-day); test-notification button in Settings
  (`sendTestNotification` + POST /api/settings/test-notification);
  acknowledge-all on /alerts (`ackAlerts` + POST /api/alerts/ack-all).
- Suite grew 357 → 373 tests across 32 files; typecheck clean; every item
  verified live against real data before its merge commit.

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

All of the 2026-07-05 follow-ups landed the same day: Yahoo news now comes
from the public per-ticker RSS feed (browser scrape is the fallback; top-5
entries only, so repeated scans don't crawl the feed), `refreshBars` and
`ensureBarsCover` fall back to Yahoo chart bars (source "yahoo") so keyless
setups get indicators/setups/event studies, and alert notifications queue
into a 3s burst digest (`queueAlertNotification`/`buildDigest`;
`flushQueuedNotifications` for tests/shutdown).

On 2026-07-06 the dependabot minor-and-patch group was merged (PR #30) and the
`yahooBrowserEnabled` setting was renamed to `yahooEnabled` ("Yahoo Finance
connector") — it gates all Yahoo usage (quotes, news, earnings, keyless bars);
env `YAHOO_BROWSER_ENABLED` gates only the headless-browser fallback layer.
`loadConfig()` still honors the legacy key from an existing database and drops
it on the next save.

**Roadmaps v1–v3 are all complete (see `docs/ROADMAP.md`).** Candidate seeds
for a v4, spotted 2026-07-09 but not yet written up:

- **Alert retention:** `runRetention` never prunes the `alerts` table — 278
  unacked rows and counting (mostly repeated daily stale-data warnings).
  Consider pruning acked rows after N days and auto-acking superseded
  stale-data warnings.
- **Sector data for holdings:** nothing stores a sector, so the sector half
  of `concentrationWarnings` can never fire and the portfolio has no sector
  breakdown. Yahoo `quoteSummary` `assetProfile` has it; `yahooHttp.ts` has
  the crumb/session plumbing to add a fetcher + a `sector` column.
- The equity curve (#31) needs a few days of runtime before it shows a
  trend — nothing to build, just let it accumulate.

Still-parked notes:

- Bulk import caps at 50 tickers per request and runs 5 in flight; fine for
  pastes, revisit if used for large lists.

## Standard Commands

```bash
npm run typecheck
npm test
npm run dev
npm run jobs
npm run db:generate -- --name <slug>
```

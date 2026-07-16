# Agent Memory

Last updated: 2026-07-16.

## 2026-07-16 session — roadmap v6 (#51–#55): runner resilience

Executed the committed v6 plan (written from the 2026-07-13 forensics:
task killed at logon with 0xC000013A, catalyst_scan dark since Friday, the
>20h maintenance anchor drifting past bedtime, browser-fallback parser rot,
gdelt silently dark for six runs). All five items shipped and live-verified;
tests 420 → 443. What shipped, plus the live discoveries:

- **#51b lock:** `data/jobs.lock` pidfile guard in `schedulerLock.ts`;
  second `npm run jobs` exits 1 naming the holder pid. Verified against the
  real task.
- **#51a hidden task:** `run-hidden.vbs` + re-registered FinanceAgentJobs
  action (needed an **elevated** re-register — the old task's ACL blocked a
  limited-token overwrite; fresh task names register fine unelevated).
  **Live discovery: `Stop-ScheduledTask` orphans the cmd/npm/node tree**
  (kills only its direct child; observed with BOTH the old cmd.exe action
  and the new wscript one — jobs.log refreshes continued right through a
  "stop"). New `scripts/stop-jobs-task.ps1` stops the task and kills the
  lockfile pid (node.exe-verified against pid reuse); the npm/cmd ancestry
  unwinds. Uninstall now routes through it. **Windows PS gotcha:** .ps1
  files must carry a UTF-8 BOM — PowerShell 5.1 reads BOM-less files as
  ANSI and an em dash inside a double-quoted string parses as a smart-quote
  terminator (0x94). All repo .ps1 files now have BOMs.
- **#52 no more cron:** node-cron removed; `isMaintenanceDue` (calendar-day
  anchor, 08:00 local) + `isCatalystScanDue` (4h interval, weekdays) run
  from the minute loop. Verified live: neither re-fired after today's
  completed runs; scan skipped on maintenance ticks. Also fixed the latent
  unhandled-rejection crash in the old `void catalystScan()` cron callback.
- **#53 Yahoo browser fallback — FIXED (probe-driven):** the quote page
  loads headless with no consent wall, but the main quote no longer renders
  any `data-symbol="<ticker>"` fin-streamer; price lives in
  `data-testid="qsp-price"` spans and the 52-week range in a
  `fiftyTwoWeekRange` streamer's `data-value`. Parser falls back to those
  (fixture test from the live page). Post-fix probe: AAPL 331.92, zero
  extraction errors. Earnings in-page API path verified (4 rows), kept.
- **#54 /status Data sources card:** per-source ingestion pulse from
  `ingestion_runs.by_source` (amber ≥3 empty runs) + quote-transport
  last-produced stamps. First live render showed **gdelt at 8 runs dark**.
- **#55 watchdog:** `src/jobs/watchdog.ts` (src/jobs, not scripts/, for
  `@/` imports) + `decideWatchdogAction` pure core. Live-verified against
  a real outage window mid-session: toast at 14-min staleness, throttle
  held on the re-run, state self-cleared once the runner returned.
  FinanceAgentWatchdog registered unelevated, 30-min repetition. Gotcha:
  `-RepetitionDuration [TimeSpan]::MaxValue` is rejected as out-of-range
  XML on current Windows builds — omit the parameter for indefinite.

End state: FinanceAgentJobs Running (hidden, new code, lock held),
FinanceAgentWatchdog Ready, today's maintenance + catalyst_scan stamped ok,
/status card live, jobs.log clean of cron banners and parser noise.

## 2026-07-11 session — audit of the modules the quality pass skipped

The 2026-07-10 repo quality pass left sectorScout, companyThesisScout, and
eventIngestion/extraction (incl. `sources/*`) line-audited only structurally;
this session audited them line-by-line. companyThesisScout, eventExtraction,
gdelt, secEdgar, tickerMap, and parse reviewed clean. Three logic fixes +
one gap (tests 396 → 405):

- **Ingestion cap starved GDELT/IR (real bug):** `ingestCore` concatenated
  SEC+GDELT+IR then `slice(0, maxItems)`; SEC's recent-filings feed always
  fills its fetch size (= the cap, default 25), so GDELT/IR items **never
  reached extraction** while SEC was enabled. Now `capAcrossSources`
  round-robins one item per source per round (per-source order preserved).
- **Curated theme matching used substrings:** "ai" seeded retail (ret-**ai**-l),
  "tech" seeded fintech+biotech. `curatedTickersFor`/`curatedMatch` now match
  whole words with a light plural fold (`themeWords`/`themeKeyMatches`);
  "banking" added as an explicit key (the only real stem match lost).
- **`listSectorPicks` comparator was non-transitive:** industries were ordered
  by per-row `scannedAt`, but an "added" pick that stops re-surfacing keeps its
  old timestamp — could interleave industries and split the page's groups. Now
  sorts by per-industry latest scannedAt, then name, then adjusted score.
- **IR feed fetch had no timeout** (EDGAR 15s, GDELT 10s, IR none) — a hung
  feed would stall ingestion; now `AbortSignal.timeout(10s)`.

Live-verified against the running dev server: two real SEC+GDELT ingestion
runs end-to-end (LLM extraction, mentions persisted), /sector-scout page and
API render real picks grouped correctly. Note: GDELT 429-throttles for
minutes at a time — a `bySource` gdelt=0 with no error usually means it was
rate-limited and the run correctly stopped early, not that the connector broke.

**Same session, roadmap v5 (#48–#50) written from runtime signals and shipped
(tests 420/35):**

- **#48 sleep-proof maintenance:** node-cron's 08:00 tick doesn't fire while
  the machine sleeps, and the #43 catch-up only ran at boot — observed a full
  missed day (2026-07-11) with a live heartbeat. Now the minute loop calls
  `isMaintenanceCatchupDue` (past 08:00 local + `isDailyJobDue`) and a
  `maintaining` guard serializes the three trigger paths (cron / startup /
  loop). Live: the loop's catch-up fired at boot, ran the full chain, and
  wrote the day's missed backup; the 30s startup timer was absorbed by the
  guard.
- **#49 condition alerts auto-ack when cleared:** `generateAlerts` marks
  condition-true (type,ticker) pairs and post-scan acks unacked rows no
  longer true. Fluid types clear on any scan; sticky criticals
  (`stop_loss_hit`, `thesis_invalidated`) only clear when the ticker has no
  open trade; `closeTrade` acks its ticker's trade-condition alerts
  immediately; event alerts never touched. Live: first scan drained the
  backlog 64→14 criticals / 118→13 warnings (the survivors are legit: open
  TSLA/UPS trades).
- **#50 theme-membership flag:** `checkThemeMembership` (one batched LLM
  call, curated members exempt, returns **null when it couldn't run** so
  flags are never cleared blind) covers surfaced AND kept "added" picks;
  `theme_fit_flag` column (migration 0007); amber "theme fit questioned"
  chip on the pick card — flag, never drop. Live: re-scanning "space"
  flagged the legacy ALKS row ("Biopharmaceutical company…") and a
  borderline new pick (COMM), left RTX/TRMB clean.

Session gotcha: the machine's internet dropped mid-scan once
(`ERR_INTERNET_DISCONNECTED` on every Yahoo call) — scans fail soft
(validation drops, errors array) and the membership check's null path left
flags untouched, as designed. Retried after connectivity returned.

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
- Suite grew 357 → 385 tests across 35 files (incl. follow-ups #36–#40:
  alert retention, holding sectors, trade_setups thinning, opt-in morning
  brief, scheduler .env fix); typecheck clean; every item verified live
  against real data before its merge commit.
- **2026-07-10, #39:** opt-in daily morning brief
  (`src/services/morningBrief.ts`, `morningBriefEnabled` config, sent at
  the end of daily maintenance; pushes via `sendDirectNotification` only
  when the severity gate would suppress info — no double-send).
- **2026-07-10, #40 (operational bug):** `npm run jobs` had NEVER loaded
  `.env` — the scheduler ran keyless since day one (Yahoo-only quotes, no
  broker order sync, rule-based LLM paths). Fixed with
  `src/lib/loadEnv.ts` (`loadDotEnv()` at the top of the tsx entrypoints;
  real env vars always win). If a new tsx entrypoint is added, call
  `loadDotEnv()` there too.
- **Considered and rejected (2026-07-10): broker-equity equity curve.**
  The Alpaca *paper* account reports ~$100k equity of which ~$88k is
  untouched default paper cash; plotting equity would flatten the real
  ~$13k positions curve into noise. `portfolio_snapshots.totalValue`
  stays positions-based on purpose. Revisit only for a real-money account.
- **2026-07-10, roadmap v4 (#44–#47) written and shipped same day (tests
  391/35):** #44 `classifyCatalyst` tone now nudges toward zero, never
  flips a strong rule match; #45 `emitAlert` gained `onceWhileUnacked`
  (condition-state alerts — stop/score/rec/buy-zone/stale/concentration —
  emit once per (type,ticker) until acked; #36's auto-ack re-arms every
  14d); #46 the three maintenance Yahoo loops (news/earnings/upcoming)
  use `mapPool` at concurrency 4 (47 tickers ≈7s vs ~14s); #47 the trade
  dialog shows live direction-aware R/R + suggested size via a new
  optional `risk` prop (display-only; server gate authoritative). Also
  fixed `install-jobs-task.ps1` reporting success after a denied
  registration (needs `-ErrorAction Stop` on the CIM cmdlet + existence
  check) — registration on this machine requires an elevated PowerShell.
- **2026-07-10, repo quality pass (tests 396/35):** scripted dead-code
  audit found the repo clean (zero orphan files/deps; the one orphaned
  function, `flushQueuedNotifications`, is now the scheduler's
  SIGINT/SIGTERM flush). Logic fixes: **tradeScoring was long-biased for
  shorts** — `tradeMomentumScore(ind, direction)` now mirrors
  EMA/RSI/MACD polarity, and `addBlockers`/`trimRules` are
  direction-aware (long behavior regression-asserted unchanged);
  setupDetection's `sma200 ?? 0` quality inflation fixed; sentimentScore
  filters expired; combine*Score guard against zero weight sums.
  Reviewed clean: indicators, buyZone, eventStudy, orderSync,
  riskManagement. NOT line-audited yet: sectorScout, companyThesisScout,
  eventIngestion/extraction internals (structural scan only). Test
  fixture note: linear trendCloses converge the MACD histogram to ~0 —
  use accelerating two-phase trends when a test needs histogram sign.
- **2026-07-10, #41–#43 (ops-truth chain; tests 388/35, prod build clean):**
  #41 the minute heartbeat self-reports the runner's integrations
  (`alpaca=paper llm=on`) — `/status` shows it and warns on the
  web-has-Alpaca/runner-doesn't mismatch; #42 header `AlertsBadge` (unacked
  count via `GET /api/alerts/unacked-count`, red when criticals wait); #43
  startup catch-up — `daily_maintenance` had **never completed** and no
  backup existed, because the 08:00 cron needs the runner alive at 08:00;
  the scheduler now runs maintenance 30s after boot when the last run is
  missing or >20h old (`isDailyJobDue`). First backup written 2026-07-10.
  **Still open:** the user should run `scripts/install-jobs-task.ps1`
  (opt-in by design) so the runner survives terminal closes and reboots.

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

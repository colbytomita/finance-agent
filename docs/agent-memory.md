# Agent Memory

Last updated: 2026-07-20.

## 2026-07-20 session — roadmap v8 (#57–#59): GDELT budget + alert hygiene

Post-v7 forensics pass over the running system (DB + jobs.log + live GDELT
probes) → wrote roadmap **v8** in `docs/ROADMAP.md`. Tests 470/40 (was 458),
typecheck clean, nothing committed (finance-agent rule). Also live-restarted
the runner (stop-jobs-task.ps1 → Start-ScheduledTask; Running, lock held).

- **#57 GDELT — CODE SHIPPED + TESTED, live fetch UNCONFIRMED (honest
  blocker).** The v7 "multi-day IP penalty, needs days to decay" theory was
  **WRONG**: a cold single query returned 200 within hours. Real problem is
  query **cost + spacing**, proven by probes — a 3-phrase OR at maxrecords=15
  got 429 on the FIRST request after 10 min idle (idle time didn't reset it →
  not purely time-based; GDELT's 429 body offers "contact us for larger
  queries"). Only shape served cold: a single phrase at low maxrecords. Fix
  in `fetchGdeltNews`/`buildGdeltQueriesFor`: **batchSize 6→1** (one company
  per query — the extractor attributes by article title, so batching only
  bought coverage speed, which #56 rotation restores), **maxPerQuery 25→10**,
  **spacingMs 5500→20000**, **timeout 20s→30s** (a 429 took 19.1s — nearly
  mis-timed-out), **maxQueries 8→4**, and a **doubled pause after any
  non-429 failure** (failed requests still count against the budget). New
  `sleepFn` injection makes the spacing schedule unit-testable. Thesis-scout's
  single query → 30s timeout too. **The catch:** I ran ~8 probes today and
  put my OWN IP into a persistent penalty — the only 200 was the session's
  first request; everything after (incl. single-phrase maxrecords=10 after
  8 min idle) 429'd. So I could NOT prove a clean fetch tonight and stopped
  (probing a free API more = rude + self-defeating). Loud-failure path IS
  proven (07-19 scheduled run recorded `gdelt: 0 items — 1 throttled (429),
  1 http error`). **NEXT SESSION: (1) the RUNNER is on the 06:13
  interim build (batchSize=3) — it has final #58 but NOT the final
  batchSize=1 GDELT code; restart it (`scripts/stop-jobs-task.ps1` then
  `Start-ScheduledTask -TaskName FinanceAgentJobs`) ONLY after the penalty
  clears, since a restart immediately fires the overdue catalyst_scan → a
  GDELT hit. (2) Then check /status Data sources card; if gdelt still 0
  after a clean window, it's too rate-limited for per-company polling —
  pivot to their ngrams dataset or drop GDELT.** Item left `[~]` in the
  roadmap, not `[x]`. Nothing committed — `git status` shows 8 modified
  files (gdelt.ts, alerts.ts, companyThesisScout.ts, 3 test files, ROADMAP,
  agent-memory); ready to commit when Colby asks.

- **#58 `new_setup` alert lifecycle — DONE + live-verified.** `new_setup`
  was an "event" alert (never auto-acked), deduped only by exact message,
  so quality drift 7.5→7.0 minted duplicates and 113 unacked rows piled up.
  Reclassified it as a **fluid condition**: added to `FLUID_CONDITION_TYPES`,
  emitted from `activeSetups()` (so it also honors the swing archive) with
  `onceWhileUnacked`, marked per ticker with a q≥7 active setup, drained by
  `ackClearedConditionAlerts` when the episode ends. Trade-off: a 2nd setup
  type on an already-alerted ticker adds no 2nd row while unacked (/swing
  shows all). Live: the runner's first new-code scan added **0 new rows**;
  backlog 113→65 (the 65 are legacy pre-fix duplicates for the 13 tickers
  whose episodes are STILL active — can't consolidate retroactively, but
  stop growing and drain as episodes end / #36's 14-day sweep).

- **#59 stale-wave aggregate — DONE (persistence-tested; not live-
  triggerable without a real outage).** On a machine wake-into-dead-network
  the per-ticker loop emitted **52 data_stale warnings for one WiFi blip**
  (observed 07-17T04:37Z). Now `generateAlerts` gathers stale tickers first
  and, when `≥ STALE_WAVE_MIN` (10) AND ≥50% of the board is stale, emits
  ONE aggregate `data_stale` warning (ticker null, `onceWhileUnacked`);
  below threshold stays per-ticker. Marked so #49 auto-ack supersedes older
  per-ticker rows on the transition and clears the aggregate when freshness
  returns.

- **#60 wake task — BUILT (Colby chose `-WakeToRun`).** The laptop slept
  Thu 22:27 → Sun 15:43 HST and missed Friday's whole session (the runner is
  only SUSPENDED while asleep, so it does nothing; watchdog shares the
  machine). New opt-in `FinanceAgentWake` task: weekday `-WakeToRun` trigger
  (default 03:10 local, `-WakeAt` param) wakes the machine pre-open, then
  `scripts/keep-awake.ps1` holds it awake via `SetThreadExecutionState`
  (ES_SYSTEM_REQUIRED) until 16:05 ET — window computed in US Eastern → local
  so it's DST-correct for HST; weekends self-skip; released in a `finally`, no
  permanent power-plan edits. Launched hidden by NEW `scripts/run-hidden-ps.vbs`
  (mirrors `run-hidden.vbs` for a .ps1 — **needs `cmd /c` or `>>` isn't
  interpreted**, caught in test). Install/uninstall mirror the watchdog
  scripts; README section added. **Gotcha caught live: under PS 5.1
  `[uint32]0x80000000` THROWS** (hex parses as signed int32) — use decimal
  `[uint32]2147483648`. **Two OS deps `-WakeToRun` can't override (documented):
  "Allow wake timers" must be ON; a lid-close still forces sleep.** Verified:
  DST math, PS-5.1 P/Invoke, hidden launcher chain, BOM/CRLF. NOT verified:
  the multi-hour hold (first proof = next weekday wake). **Colby still needs to
  run `scripts/install-wake-task.ps1` from an elevated PS** (opt-in, needs
  elevation like the other task installers).

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

**Same session: roadmap v7 (#56) — GDELT throttle-blindness (tests 450 →
458).** Post-v6 forensics: gdelt fetched 0 items in EVERY recorded run since
≥07-10 with zero errors. Root cause chain, proven by live probes: 1.5s
request spacing violates GDELT's 1-per-5s floor → multi-minute penalty
windows → **the throttled 429 response itself takes >10s to arrive, past the
old 10s timeout, so the abort fired first and the empty catch swallowed it**
— the connector never saw the 429, never warned, never backed off. Fix:
`fetchGdeltNews` returns `{items, failures}` (throttled/timedOut/badPayload/
httpError + sample), spacing 5500ms, timeout 20s, one polite Retry-After
retry, `rotateQueries` day-rotation so early-death runs still cycle
coverage; ingestCore records `gdelt: 0 items — <reasons>` into
ingestion_runs.errors_json when zero-with-failures. First live run: exactly
that error recorded (still throttled — penalty needs days of politeness to
decay; the /status card + /events now show it loudly). Also: the old runner
double-ran maintenance this morning (startup catch-up + 08:00 cron, 17:48 +
18:02 runs) — the exact duplication #52 eliminated; it was the old code's
last day.

**Same session: swing recommendation archive (user feature request; tests
443 → 450).** Spec + plan in docs/superpowers/{specs,plans}/2026-07-16-*.
Archive = snapshot + episode-scoped suppression: `archived_setups` table
(migration 0008) copies the trade_setups row (immune to retention) with a
`suppressing` flag; `activeSetups()` filters suppressed (ticker,setupType)
pairs — which also removes them from Summary's setup strip, watchlist rows,
and the morning brief; `scanForSetups` clears the flag when a scan stops
detecting the pair, so a future NEW episode lists normally while the
snapshot stays as history. Detection rows keep inserting while suppressed —
the setup-outcome backtest loses nothing. Three POST routes
(/api/setups/archive|unarchive|note); /swing has an Archive button per
recommendation and a collapsed native-`<details>` "Archived recommendations
(N)" section (snapshot numbers, live price, editable note, Unarchive, Trade
with stale-snapshot caveat). Live-verified end-to-end: archived AAPL
momentum_continuation → left the table, survived a real /api/refresh scan
(suppressing stayed 1 while the detection row re-inserted), note updated,
unarchived → row returned, archive (0).

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

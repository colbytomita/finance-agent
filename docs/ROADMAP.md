# Improvement Roadmap — v2 (2026-07-06)

Roadmap v1 (items #1–#14, from the 2026-07-01 review) is **complete** — see the
archive at the bottom. This v2 list was drawn up from a fresh pass over the
codebase; every "Why" below cites the actual code it's grounded in. Items are
numbered #15+ so git-history references to "roadmap #N" stay unambiguous.

Work top-to-bottom within a tier. Recommended sequencing: **15 → 16 → 17**
first (they make existing safety/measurement features real), then Tier 2 for
operational resilience, then Tier 3 features by taste.

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
  straight to `main`; features get a branch and a `Merge PR #N: <title>` merge
  commit (see git history for the style).
- New code uses the shared modules from PR #27 — `src/services/llm.ts`,
  `src/components/useApiAction.ts`, `src/lib/util.ts` (`nowIso`, `clamp`,
  `errorMessage`, `mapPool`), `src/services/watchlist.ts` — don't re-roll them.

## Tier 1 — Make existing features real

- [x] **15. Windows desktop notifications** *(small — done)*
  **Why:** `sendDesktop` in `src/services/notifications.ts` bails unless
  `process.platform === "darwin"` — but this app runs on Windows 11, so the
  "desktop" half of alert notifications (roadmap #9) silently does nothing on
  the machine it's actually used on. Only the ntfy channel works today.
  **What:** Add a Windows branch that shows a toast, best-effort and
  never-throwing like the macOS path. Simplest reliable approach: `execFile`
  PowerShell with a script using
  `[Windows.UI.Notifications.ToastNotificationManager]` (no new npm deps;
  quote/escape the message carefully — build the XML with a here-string and
  pass the text via `-EncodedCommand` or argument array, never string
  interpolation of user-ish content). Keep the macOS branch; return `false` on
  unsupported platforms as now.
  **Accept:** With `notifyEnabled` on and a `critical` alert emitted (easy to
  trigger from a test script or by temporarily lowering `notifyMinSeverity`),
  a toast appears on Windows. Unit test covers the platform dispatch with a
  mocked `execFile` (see `src/services/__tests__/notifications.test.ts` for
  the existing mocking pattern). Nothing throws when PowerShell is missing.

- [x] **16. Auto-fetch upcoming earnings dates (make the earnings guard live)** *(medium — done)*
  **Why:** The earnings-proximity guard (`avoidEarningsWithinDays`, wired into
  `riskManagement.ts` and `tradeScoring.ts`) gets its dates from
  `daysToNextEarnings` (`src/services/marketData.ts:318`), which reads
  catalysts with `catalystType="earnings"`, `status="upcoming"`, and a future
  `eventDate`. **Nothing creates those automatically** — the earnings fetch
  pulls only past quarters, and the news scan stores occurred events. So the
  guard is effectively dead unless the user hand-enters an upcoming-earnings
  catalyst.
  **What:** Add `getYahooNextEarningsDate(ticker)` to
  `src/services/yahooHttp.ts` using the `quoteSummary` `calendarEvents`
  module (the crumb/cookie plumbing and a mapper-test pattern already exist
  there — see `getYahooEarnings`). In daily maintenance (`scheduler.ts`),
  behind `cfg.yahooEnabled`, upsert one upcoming-earnings catalyst per tracked
  ticker: dedupe on (ticker, type=earnings, status=upcoming) — update the
  `eventDate` if Yahoo moved it, don't stack duplicates.
  `rollCatalystStatuses` already promotes them to `occurred` when the date
  passes. Surface it: an "Earnings in Nd" badge on the watchlist rows,
  stock-detail header, and Swing Trading page (a `daysToNextEarnings` value
  already flows into trade rows — check `marketData.ts:522`).
  **Accept:** Mapper is a tested pure function (fixture JSON → date). A
  persistence test proves upsert-not-duplicate across two runs and date
  updates. Live: after one maintenance run, a tracked ticker with a scheduled
  report shows the badge, and `riskManagement` warnings fire inside the
  window.

- [x] **17. Setup outcome backtest — Signal Performance section 4** *(medium — done)*
  **Why:** `trade_setups` (schema.ts, `detectedAt`, entry range, `stopLoss`,
  `targetPrice1/2`, `status`) accumulates every detected swing setup, but no
  code ever measures whether they worked. Signal Performance covers scores,
  picks, and realized trades — the setup detector, arguably the app's most
  actionable output, is the one signal with zero feedback.
  **What:** Pure function in a new `src/services/setupPerformance.ts`:
  `resolveSetupOutcome(setup, bars, horizonDays)` — walk daily bars after
  `detectedAt`; if the low touches the stop before the high touches target 1,
  it's a loss (−1R), target first is a win (compute R from entry-mid → stop
  vs entry-mid → target); **same-bar stop+target counts as a stop** (be
  conservative); neither within the horizon = "expired" with mark-to-market R
  at horizon. Aggregate per `setupType`: count, win rate, average R,
  expectancy. Reuse `ensureBarsCover` (exported from `entityMentions`) to
  backfill bars, and follow the maturity-gating style of the other sections
  (an unmatured setup is excluded, and the UI says how many are pending, not
  "no data"). Wire into the combined report in `signalPerformance.ts` and a
  fourth section on `/performance` (`SignalPerformance.tsx`).
  **Accept:** Resolver unit tests: target-first, stop-first, same-bar
  ambiguity → stop, gap through stop (open below stop → R computed from the
  open, not the stop), expiry mark-to-market, missing bars → null. Live: the
  section renders with real detected setups and states its horizon and sample
  sizes. The daily-maintenance backtest run picks it up automatically.

## Tier 2 — Operational resilience

- [ ] **18. Keep the jobs runner alive across reboots** *(small–medium)*
  **Why:** `npm run jobs` lives and dies with a terminal window. The health
  badge (roadmap #4) tells you it's dead, but nothing brings it back; every
  reboot silently stops refreshes/maintenance until noticed.
  **What:** A `scripts/install-jobs-task.ps1` that registers a Windows
  Scheduled Task (`Register-ScheduledTask` or `schtasks`) running
  `npm run jobs` at logon with restart-on-failure, plus an
  `uninstall-jobs-task.ps1`. Log stdout to a file under `data/logs/`
  (gitignore it). Document in README. Keep it strictly opt-in — a user-run
  script, never auto-installed.
  **Accept:** After running the install script and rebooting (or ending the
  task and letting it restart), the header badge goes green without opening a
  terminal. Uninstall removes the task cleanly.

- [ ] **19. Backup restore path** *(small)*
  **Why:** Daily `VACUUM INTO` backups exist (`src/services/backup.ts`, keeps
  7) but there is no documented or scripted way back — a restore under stress
  is when mistakes happen.
  **What:** `npm run db:restore -- <backup-file>` (a small `tsx` script):
  refuses to run if the DB is in use (try an exclusive open), backs up the
  *current* DB to `data/backups/pre-restore-<ts>.db` first, then copies the
  chosen backup into place. Document the procedure (stop dev+jobs first) in
  README next to the backup description.
  **Accept:** Round-trip verified live: restore a day-old backup, app opens
  it and runs migrations cleanly (restoring an older backup must replay any
  newer migrations — verify that path), original DB preserved as
  pre-restore copy.

- [ ] **20. SQLite housekeeping in maintenance** *(small)*
  **Why:** WAL mode plus append-heavy tables: nothing ever runs
  `PRAGMA optimize` or `wal_checkpoint(TRUNCATE)`, so the `-wal` file can grow
  unbounded between backups and query plans go unrefreshed.
  **What:** At the end of daily maintenance (after retention, before backup),
  run `PRAGMA optimize;` and `PRAGMA wal_checkpoint(TRUNCATE);` with the same
  log-and-continue error handling as retention. Report WAL size on `/status`
  (next to DB size in `status.ts`).
  **Accept:** Maintenance log line shows the checkpoint ran; `/status` shows
  main + WAL sizes; a persistence test asserts the pragmas execute without
  error on the in-memory harness (or are skipped harmlessly there).

## Tier 3 — Features

- [ ] **21. Market-regime context for new entries** *(medium)*
  **Why:** Open trades already get a market-condition component
  (`marketConditionScore` in `tradeScoring.ts:210` — SPY vs 50-SMA + RSI),
  but the entry-side surfaces (Agent Picks, Sector Scout, setup detection,
  Swing page) ignore regime entirely: the app will happily propose breakout
  longs in a downtrend.
  **What:** Reuse `marketConditionScore` (don't re-derive): compute it once
  from SPY indicators and (a) show a small regime banner on the Summary and
  Swing pages ("Market regime: SPY above 50-SMA — favorable", neutral styling,
  labeled as heuristic), and (b) attach the regime note to Agent Picks /
  Sector Scout rationales at proposal time. Optionally a config toggle
  (`regimeFilterEnabled`, default off) that raises the effective
  `agentMinScore` by 1 when the regime score is < 4.5 — a nudge, never a hard
  block, and the rationale must say it happened.
  **Accept:** Banner renders from real SPY bars (`ensureBarsCover("SPY")`),
  pure scoring reuse is tested, and with the toggle on a sub-threshold pick
  shows the raised bar in its rationale. Decision-support framing throughout.

- [ ] **22. Trade & journal CSV export** *(small)*
  **Why:** Realized trades and journal entries (entry/exit reasons, R
  multiples) are the user's tax/record data, and the only way out today is
  the SQLite file itself.
  **What:** `GET /api/trades/export` streaming CSV of closed trades joined
  with their journal entries (one row per trade: ticker, entry/exit dates and
  prices, shares, P&L, R-multiple, thesis-played-out, reasons), plus an
  "Export CSV" button on the Swing Trading page. No new deps — hand-roll the
  CSV with proper quoting (a pure `toCsvRow` helper in `lib/util.ts`, tested
  with commas/quotes/newlines in fields).
  **Accept:** Downloaded file opens in a spreadsheet with correct columns and
  escaping; route smoke test asserts header row + one seeded-via-API trade.

- [ ] **23. Price-chart upgrades: volume + event markers** *(small–medium)*
  **Why:** `PriceChart.tsx` is a clean dependency-free SVG line chart with
  level lines, but it shows no volume (relative volume is already an input to
  setups) and no event context, while the data for both is at hand
  (`price_bars.volume`, catalysts/mentions/earnings per ticker).
  **What:** Extend `PriceChart` with an optional volume subpanel (thin bars
  under the price pane, same x-scale) and optional event markers (small
  glyphs on the date axis: earnings = ▲, catalysts = ●, entity mentions = ◆)
  with the existing hover-tooltip pattern showing the event title. Keep it
  dependency-free and prop-driven; wire up on the stock-detail page where
  bars, catalysts, and earnings are already loaded.
  **Accept:** Stock page renders volume + markers for a real ticker; chart
  stays readable with zero events; hover shows event titles; no new deps.

- [ ] **24. Entity watch + new-mention alerts** *(medium)*
  **Why:** Catalyst Edge computes per-entity edge, but discovering that "an
  entity you care about said something new" still requires opening `/events`.
  The alerts + notifications rails (roadmap #9) are already there.
  **What:** A `watched` flag on entities (config-list or a small table —
  prefer a `watched_entities` table via the normal migration flow, storing
  the entity name as normalized in `entityMentions`). Star/unstar from the
  entity list on `/events`. In `runEventIngestion`, after persisting, emit
  one `info`-severity alert per watched entity with new mentions ("Elon Musk:
  2 new mentions — TSLA, DJT"), deduped by the existing `emitAlert` rules so
  reruns don't spam. Notifications then flow by severity config as usual.
  **Accept:** Persistence test: watched entity + ingested mention → exactly
  one alert; unwatched → none; second identical run → no duplicate. Live:
  star an entity, run ingestion, see the alert in the feed.

- [ ] **25. Sector Scout industry trend history** *(medium)*
  **Why:** `sector_scans` logs every run (industry, timestamp, counts) and
  picks carry scores, but nothing shows how an industry's scan results move
  across time — "is this theme heating up?" is exactly what a re-scanned
  favorite industry should answer.
  **What:** At scan time, store an aggregate per run (mean/max pick score,
  candidates validated vs dropped) — extend `sector_scans` via migration if a
  column is missing. In `IndustryExplorer`, render a small SVG sparkline of
  mean pick score across that industry's historical scans (reuse the
  dependency-free chart idiom), with the run count labeled so two points
  aren't over-read as a trend.
  **Accept:** After ≥2 scans of one industry, the sparkline renders real
  values; one scan shows "1 run — no trend yet"; aggregates covered by a
  persistence test.

## Tier 4 — When bored

- [ ] **26. Split `marketData.ts`** *(carried from v1 #12; 630 lines and the
  largest non-scout module)* — natural seams: quote refresh (`refreshPrices`
  and helpers), bar store/backfill (`refreshBars`, `ensureBarsCover` wiring),
  and analysis orchestration (`recomputeStockAnalysis`, tracked-ticker
  plumbing). Pure moves, no behavior change, tests stay green.
- [ ] **27. Alerts history page** *(small)* — the dashboard shows recent
  alerts; a `/alerts` page with filters (severity, ticker, acknowledged)
  over the existing table would make audits of "what did it warn me about"
  possible.
- [ ] **28. Dependency watch** — the moderate `npm audit` finding is esbuild
  via drizzle-kit's dev-only chain; no runtime exposure. Revisit when
  drizzle-kit ships a fix; don't downgrade.

## Archive — v1 (2026-07-01 review), all done 2026-07-05

Kept for git-history reference ("roadmap #N" in commit messages):
`#1` Alpaca order-fill sync · `#2` data retention · `#3` scheduled Signal
Performance backtest · `#4` job-health heartbeat + badge · `#5` drizzle-kit
migrations (schema written once) · `#6` in-memory SQLite test harness ·
`#7` parallelized Sector Scout · `#8` Yahoo over plain HTTP (browser demoted
to fallback) · `#9` alert notifications (desktop/ntfy) · `#10` bracket-leg
auto-close · `#11` watchlist bulk import · `#12` → carried to #26 ·
`#13` /status page · `#14` daily VACUUM INTO backups.

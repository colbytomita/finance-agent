# Improvement Roadmap — v8 (2026-07-19)

v8 came from the post-v7 forensics pass (2026-07-19 evening), three days
after #56 shipped. The loud-failure plumbing works — the 07-19 scheduled
ingestion recorded `gdelt: 0 items — 1 throttled (429), 1 http error` — but
GDELT is still dark, and live probes **overturned v7's penalty-decay
theory**: a cold simple query returned 200 just 4 hours after the runner's
own 429 (no multi-day IP penalty exists), while a connector-shaped batched
query got 429 even after 30 seconds of politeness, and every request made
during a penalty re-armed it (4 consecutive 429s at 10–30s spacing).
Responses are also slow — 13.2s for a successful trivial query, 429s
arriving at 11–19s — so the current 20s timeout has almost no headroom and
the 5.5s completion-to-start spacing trips the limiter on the second
request of nearly every run. Separately, the alert scan showed two hygiene
problems: a machine-wake network blip on 07-17 emitted **52 `data_stale`
warnings in one minute**, and back-to-back refresh+maintenance ticks on
07-19 emitted **duplicate `new_setup` alerts one minute apart** (quality
drifted 7.5→7.0, defeating the exact-message dedupe) on top of a
113-row unacked `new_setup` backlog that nothing ever drains.

## v8 — Tier 1: data-source truth (continued)

- [~] **57. GDELT: run within the limiter's real budget** *(small–medium —
  CODE SHIPPED + TESTED 2026-07-20; loud-failure path verified live;
  fetch-success UNCONFIRMED and must be watched on /status over the coming
  days. Honest blocker: I ran ~8 diagnostic requests at GDELT today and put
  my own IP into a persistent penalty — the only 200 all session was the
  very first request, hours ago, before any others; every request since
  (including a single-phrase maxrecords=10 query after 8 min idle) 429'd.
  So I could not prove a clean fetch tonight without abusing a free API,
  and stopped. The design (one company/query, maxrecords 10, 20s spacing,
  30s timeout) is evidence-consistent but the shape-vs-penalty variables
  stayed confounded. NEXT: once the penalty decays (hours, not days),
  watch the /status Data sources card / /events. If scheduled runs still
  show gdelt=0 after a clean window, GDELT is simply too rate-limited for
  per-company polling — pivot to their suggested ngrams dataset or drop it.)*
  **Why:** post-#56 runs fail honestly but still fetch zero. Probes
  (2026-07-19): no long-lived IP penalty — cold start returns articles —
  but a ~6s completion-to-start gap trips the 429 despite the stated
  1-per-5s floor, requests during a penalty re-arm it indefinitely, and
  responses take 13–20s (a 429 took 19.1s — a whisker under the 20s
  timeout, one jitter away from being miscounted as a timeout). With 5.5s
  spacing the second request of a run nearly always trips, the run dies,
  and the source looks permanently dark.
  **What:** in `fetchGdeltNews`: `spacingMs` 5500 → 20000, per-request
  timeout 20s → 30s, `maxQueries` 8 → 4 (day-rotation #56 already cycles
  the tail across runs), and after any non-429 failure double the pause
  before the next request (failed requests still count against the
  budget — tonight's run: query 1 http error, query 2 429). Batch cost
  down: `buildGdeltQueriesFor` batchSize 6 → **1** and `maxPerQuery` 25 →
  **10**. (Started at batch 3 / maxrecords 15, but a second clean probe
  settled it: a 3-phrase OR at maxrecords=15 got 429 on the FIRST request
  after 10 minutes idle — since idle time didn't reset it, the limiter is
  rejecting on query COST, not spacing. The one shape that returned 200
  cold was a single phrase at low maxrecords. So one company per query is
  the only shape reliably served; the extractor attributes by article
  title, so batching only ever bought coverage speed, which rotation
  restores.) Thesis-scout's single query gets the same 30s timeout.
  Worst-case run: 4 × (30s + 20s) ≈ 3.3 min — inside `maxDuration = 300`.
  **Accept:** unit tests with scripted fetchFn + injected sleep assert the
  spacing schedule (normal, doubled-after-failure, stop-on-429), one
  company per query, and maxrecords=10. Live: a cold scheduled run's
  leading single-phrase query fetches >0 items, or /events records an
  honest per-class reason (the loud-failure path is already proven — the
  07-19 run recorded `gdelt: 0 items — 1 throttled (429), 1 http error`).

## v8 — Tier 2: alert hygiene

- [x] **58. `new_setup` alert lifecycle: once-while-unacked + auto-ack when
  the episode ends** *(small–medium — done 2026-07-20; `new_setup` is now a
  FLUID_CONDITION_TYPE emitted with `onceWhileUnacked` and marked from
  `activeSetups()` so it also honors the archive. Live: the runner's first
  new-code scan added 0 new rows (`0 new alert(s)` in jobs.log) — the
  onceWhileUnacked guard held against the existing backlog — and the
  113-row backlog had already dropped to 65 as ended-episode tickers
  auto-acked. The 65 survivors are legacy duplicates for the 13 tickers
  whose episodes are STILL active (each was a separate pre-fix daily
  re-emit >20h apart); they can't consolidate retroactively but stop
  growing now and drain as each episode ends / #36's 14-day auto-ack
  sweeps them.)*
  **Why:** `new_setup` re-emits on every scan for every active q≥7 setup,
  deduped only by exact message — quality drifting 7.5→7.0 between the
  01:43 refresh and 01:44 maintenance tick minted duplicate rows for the
  same setups one minute apart, and 113 unacked rows have accumulated
  because event alerts are never auto-acked. But a setup is not an event —
  it is a condition with a natural end (`scanForSetups` already computes
  episode-end for archive suppression, #swing-archive).
  **What:** reclassify `new_setup` as a fluid condition at (type, ticker)
  granularity: emit with `onceWhileUnacked`, `mark("new_setup", ticker)`
  while any q≥7 active setup exists for the ticker, and let
  `ackClearedConditionAlerts` drain rows when no such setup remains.
  Trade-off (documented): a second setup type on an already-alerted ticker
  won't add a row while the first is unacked — /swing shows every setup
  regardless.
  **Accept:** persistence tests — same setup two scans running → one row;
  quality drift → still one row; episode ends → row auto-acked; ack + new
  episode → fresh row. Live: the 113-row backlog drains to just tickers
  with currently-active quality setups on the first scan.

- [x] **59. Collapse total-refresh-failure stale waves into one alert**
  *(small — done 2026-07-20; `generateAlerts` gathers stale tickers first,
  then emits ONE aggregate `data_stale` warning (ticker null,
  `onceWhileUnacked`) when ≥`STALE_WAVE_MIN` (10) AND ≥50% of the board is
  stale; below that it stays per-ticker. The aggregate is marked so #49
  auto-ack supersedes older per-ticker rows on the transition and clears
  the aggregate once freshness returns. Persistence-tested (12/12 → one
  aggregate; 3/12 → per-ticker; 12/30 minority → per-ticker; supersede +
  freshen round-trip). Not live-triggerable without a real network
  outage — the tests stand in for it.)*
  **Why:** when the machine wakes into a dead network, every tracked
  ticker is stale at once and the per-ticker loop emits a wave — observed
  2026-07-17T04:37Z: **52 `data_stale` warnings + one digest push for a
  WiFi blip**. A wave of identical warnings is one fact wearing 52 rows.
  **What:** in `generateAlerts`, count stale tickers first; when ≥10 AND
  ≥50% of tracked, emit ONE aggregate warning (`data_stale`, ticker null:
  "N of M tracked tickers have stale data — refresh has been failing;
  check network / runner") instead of per-ticker rows, marked so #49
  auto-ack clears it when freshness returns. Below threshold, per-ticker
  behavior unchanged (a single dead symbol stays individually visible).
  **Accept:** persistence tests — 52/52 stale → exactly one row; 3/52
  stale → per-ticker rows; aggregate auto-acks when data freshens. Live:
  present on the next wake-into-blip instead of a wave.

## v8 — Discussion (needs Colby's call, not code yet)

- **Machine-sleep market blindness:** the laptop slept Thu 22:27 →
  Sun 15:43 HST — Friday's entire market session had no refreshes, no
  catalyst scan, and no watchdog (it lives on the same machine; #55 noted
  this). Options when wanted: `-WakeToRun` on a pre-market scheduled
  task (changes power behavior — ask first), leaving the machine on
  during market hours, or accepting the gap (equity curve keeps honest
  holes for 07-17/07-18 — real-data-only means no backfill).

---

# Improvement Roadmap — v7 (2026-07-16) — complete

v7 came from the post-v6 forensics pass (2026-07-16 evening): the new /status
Data sources card and the run log agree that **GDELT has fetched zero items in
every recorded run since at least 2026-07-10** — spanning the 07-11 audit, so
not a regression — while `ingestion_runs.errors` stayed empty every time.
Live probes: a single simple query returns articles (the API works, the IP is
not permanently blocked), but the connector's 1.5s spacing violates GDELT's
stated 1-request-per-5-seconds limit and trips multi-minute penalty windows.
The smoking gun: a throttled 429 response took **11.7 seconds to arrive —
past the connector's 10s request timeout** — so in production the abort
fires first, the empty catch swallows it, and the connector never sees the
429 at all: no warn, no backoff, and the next query 1.5s later re-triggers
the penalty. That is why a week of dead runs shows zero errors and only one
429 warning (the one day GDELT answered fast).

## v7 — Tier 1: data-source truth (continued)

- [x] **56. GDELT: obey the rate limit and make silent failures loud**
  *(small–medium — done 2026-07-16; first live run after the fix recorded
  `gdelt: 0 items — 1 throttled (429)` in the run's errors — the 20s timeout
  let the connector finally SEE the slow 429 and stop after one request
  instead of hammering eight blind. The penalty window needs days of polite
  behavior to decay; watch the /status card — the failure is loud now either
  way.)*
  **Why:** the source has been dark ≥6 days with zero errors recorded.
  `fetchGdeltNews` never throws: 429 stops the run with only a console.warn,
  a 200 whose body isn't JSON parses to `{}` → zero articles, and a
  timeout/network error is swallowed by an empty catch. `ingestCore` records
  `bySource.gdelt = 0`, `errors: []` — indistinguishable from "no news
  today". Meanwhile the request spacing (1.5s) is below GDELT's documented
  1-per-5s minimum, so a run of 8 batched queries self-inflicts throttling,
  and observed penalty windows extend minutes beyond the nominal 5s.
  **What:** (a) `fetchGdeltNews` gains a diagnostics channel: return
  `{ items, failures }` (or accept an errors sink) counting per-run
  `throttled` / `timedOut` / `badPayload` / `httpError` outcomes, with the
  first offending body head captured for badPayload; `ingestCore` pushes a
  one-line summary into `result.errors` whenever gdelt produced 0 items AND
  failures > 0 — it then flows to `ingestion_runs.errors_json`, the /events
  run list, and the /status card's context for free. (b) Respect the limit:
  default `spacingMs` 5500 (>5s), honor a `Retry-After` header when present
  on 429 before giving up, and raise the per-request timeout to 20s (GDELT
  is slow; a 10s cap plus silent catch is how whole runs vanished). (c)
  Rotate batch order across runs (persist a cursor or derive from run count)
  so companies beyond the first batches still get coverage when a run dies
  early.
  **Accept:** unit tests with a scripted fetchFn (429 with/without
  Retry-After, non-JSON 200, timeout, mixed success) assert both the items
  and the failure counts, plus the ingestCore error-line wiring. Live: the
  next scheduled ingestion either produces gdelt items or records a
  human-readable reason in the run's errors — never again a bare silent 0.

---

# Improvement Roadmap — v6 (2026-07-13) — complete

Roadmaps v1–v6 (#1–#55) are **complete** — see below and the archives. v6
came from runtime forensics on 2026-07-13: the newly installed scheduled
task's logon run died after 13 seconds with 0xC000013A (console Ctrl+C /
window close) and nothing restarted it — the whole Monday market session ran
with no scheduler and no notice anywhere; `catalyst_scan` hadn't fired since
Friday (its cron has no catch-up); the 07-12 daily maintenance was missed
because the >20h due-anchor had drifted 43 minutes past the machine's
bedtime; every Yahoo browser-fallback invocation fails to parse; and GDELT
has produced 0 items across six straight ingestion runs with zero errors
shown. Items are #51+. Implemented 2026-07-16.

## v6 — Tier 1: runner resilience

- [x] **51. Runner survivability: hidden task window + single-instance
  lock** *(small–medium — done 2026-07-16; task re-registered on the
  hidden VBS action and Running with a fresh heartbeat; a second
  `npm run jobs` exits 1 with the "another scheduler (pid N)" message.
  Live surprise: `Stop-ScheduledTask` kills only the wscript launcher and
  orphans the cmd/npm/node tree — even the old cmd.exe action behaved
  this way — so `scripts/stop-jobs-task.ps1` now stops the task AND kills
  the pid in `data/jobs.lock`, and README says to use it. Also: .ps1
  files need a UTF-8 BOM or PS 5.1 parses an em dash inside a string as a
  smart-quote terminator.)*
  **Why:** the scheduled task runs `cmd.exe` interactively at logon, so a
  console window pops up on every logon — closing it (or a stray Ctrl+C)
  kills the runner, and the task doesn't restart it. Observed 2026-07-13:
  LastTaskResult 0xC000013A 13s after logon, runner dead all day. Ad-hoc
  `npm run jobs` terminals also compete with the task — the double-scheduler
  footgun the README warns about (the 07-12 evening runner was a manual one;
  its output isn't even in jobs.log).
  **What:** (a) `scripts/run-jobs-hidden.vbs`: `WScript.Shell.Run` of
  `cmd /c npm run jobs >> data\logs\jobs.log 2>&1` with window style 0 and
  bWaitOnReturn=True, so no window ever appears, the task shows *Running*,
  and `Stop-ScheduledTask` kills the whole tree. `install-jobs-task.ps1`
  points the action at `wscript.exe` + the vbs and gains `-StartNow`;
  the uninstall script stops the task before unregistering (stopping is now
  Stop-ScheduledTask, not Ctrl+C — losing the best-effort SIGINT
  notification flush on a hard stop is acceptable). (b) single-instance
  lock: at startup the scheduler exclusively creates `data/jobs.lock`
  containing its PID; if the file exists and that PID is alive, log
  "another scheduler (pid N) is running — exiting" and exit(1); a dead PID's
  lock is stolen; the lock is removed on SIGINT/SIGTERM. Lock *errors*
  (fs failures) never stop the runner — only a held lock does.
  **Accept:** lock helper unit-tested with injectable PID-liveness (fresh
  start, held-by-live-pid, stale-pid steal, unreadable lockfile). Live:
  re-register + start → no window, heartbeat ticks; a second
  `npm run jobs` exits immediately with the clear message;
  `Stop-ScheduledTask` actually stops node (heartbeat stops).

- [x] **52. One scheduling mechanism: fold the cron jobs into the minute
  loop** *(medium — done 2026-07-16; node-cron removed, both jobs on
  minute-loop due-checks. Live: after restart, catalyst_scan (2h old)
  correctly stayed quiet inside its 4h window and maintenance did not
  re-run after today's completed 08:02 run — calendar anchor holding; no
  cron banners in jobs.log. The rewire also fixed a latent crash: a throw
  inside `void catalystScan()` was an unhandled rejection under cron.)*
  **Why:** two of the three jobs still depend on being awake at exact
  minutes. `catalyst_scan` (`0 */4 * * 1-5`) has **no catch-up** — last ran
  Friday 07-10 20:00 local, then nothing (weekend gate aside, Monday was
  simply missed). And maintenance's ">20h since last run" anchor drifts
  later every time a catch-up runs late: the 07-11 catch-up ran 17:18 local,
  so 07-12's maintenance wasn't due until 13:18 — 43 minutes after the
  machine went to sleep — and the day was silently skipped. node-cron also
  spams missed-execution warnings after every sleep.
  **What:** drop node-cron entirely; the existing self-scheduling minute
  loop becomes the only trigger. Two pure due-checks in `jobHealth.ts`:
  `isMaintenanceDue(lastRunAt, now)` — past 08:00 local AND the last
  completed run's **local calendar date** is before today (calendar
  anchoring can't drift; a mid-run kill self-heals because the completion
  date stays yesterday); `isCatalystScanDue(lastRunAt, now)` — local
  Mon–Fri AND (never ran OR >4h old). Tick order: heartbeat → refresh →
  maintenance if due → catalyst scan if due *and* maintenance didn't just
  run this tick (maintenance already includes the news scan). The
  `maintaining` guard stays; the #43 startup timer and
  `isMaintenanceCatchupDue` are deleted (the loop's first tick at boot
  covers startup catch-up). `recordJobRun("daily_maintenance","error")`
  still bumps last_run_at, so a failing maintenance retries next day —
  unchanged from #48.
  **Accept:** due-checks unit-tested with fake clocks (pre/post 08:00,
  ran-today, ran-yesterday-late, never-ran, unparseable, weekend vs weekday,
  4h boundary). node-cron gone from package.json. Live: with stale last
  runs, both jobs fire within a minute of runner start, and sleep/wake no
  longer logs cron warnings.

## v6 — Tier 2: data-source truth

- [x] **53. Yahoo browser fallback: verify live, then fix or retire**
  *(small–medium — done 2026-07-16; **fixed**, not retired: the live probe
  (AAPL + MSFT) showed the page loads clean with no consent wall, but the
  main quote's price moved off fin-streamer — zero `data-symbol="<ticker>"`
  elements on the whole page — into `data-testid="qsp-price"` spans, with
  the 52-week range on a `fiftyTwoWeekRange` streamer's data-value. Parser
  now falls back to those; pinned by a fixture test from the live page.
  Post-fix probe parsed AAPL at 331.92 with zero extraction errors. The
  earnings in-page API path was verified working (4 rows) and untouched;
  the news-scan fallback stays behind the stable RSS primary.)*
  **Why:** every browser-quote invocation in the recent log fails with
  "regularMarketPrice not found — page layout may have changed", and
  chromium-1228 *is* installed — this is parser rot, not environment. The
  last-resort quote net demonstrably catches nothing, keeps Playwright load
  in the hot path, and fills the log with noise during outages.
  **What:** drive `yahooFinanceBrowser` live (quote path and the news-scan
  fallback separately) against real tickers. If the page still carries the
  data (fin-streamer data-field attributes or the embedded JSON state
  blob), fix the extraction and pin it with a saved-fixture unit test. If
  Yahoo's page is no longer reliably scrapable headless (consent walls,
  anti-bot), remove the browser **quote** fallback — `yahooHttp` stays
  primary, `quoteFromSummaryFields` untouched — and update the README and
  provenance notes; judge the news fallback by the same rule. Bias: don't
  keep a safety net that demonstrably doesn't catch.
  **Accept:** either a live browser quote returns real fields plus a green
  fixture test, or the dead path is removed with tests/typecheck/README
  updated. Log noise gone either way.

- [x] **54. /status "Data sources" health card** *(small — done
  2026-07-16; live /status immediately showed the real problem: gdelt
  amber at "8 runs dark", sec-edgar and ir-rss producing, and the three
  quote transports with honest last-produced stamps — alpaca fresh,
  yahoo/yahoo-browser last used 07-10/07-11.)*
  **Why:** GDELT returned 0 items in six straight ingestion runs with zero
  errors — silent 429 throttling looks identical, on /events, to "nothing
  happened". The browser rot (#53) was likewise invisible until log
  forensics. Nothing answers "which sources actually produced data lately?"
  **What:** pure helpers in `status.ts`, derived from existing tables — no
  new writes. Per ingestion source (sec-edgar / gdelt / ir-rss) from
  `ingestion_runs.by_source`: last producing run + consecutive zero-item
  streak, amber at ≥3. Per quote transport (alpaca / yahoo / yahoo-browser)
  from `market_price_snapshots.source`: last "produced data" timestamp,
  phrased so a legitimately-never-invoked fallback isn't an alarm. New card
  on /status.
  **Accept:** helpers unit-tested (streak counting, sources missing from
  some runs, empty/absent by_source JSON). Live: /status shows a gdelt
  streak matching ingestion_runs and renders with real data.

## v6 — Tier 3: last-resort alerting

- [x] **55. Dead-runner watchdog task** *(small–medium — done 2026-07-16;
  entrypoint landed in `src/jobs/watchdog.ts` (not scripts/) to keep `@/`
  imports. Live-verified against a REAL outage: with the runner down
  mid-migration, `npm run watchdog` raised the desktop toast ("heartbeat
  is 14 minutes old"), the immediate re-run stayed silent (6h throttle),
  and after the runner came back the state file self-cleared.
  FinanceAgentWatchdog registered without elevation, Ready, 30-min
  repetition — note `[TimeSpan]::MaxValue` as RepetitionDuration is
  rejected by current builds; omit the parameter for "indefinite".)*
  **Why:** every liveness surface — header badge, /status, alerts, ntfy —
  is served by processes that are dead exactly when the answer matters.
  Observed 2026-07-13: runner dead since 22:35 the prior night, the whole
  market session missed, zero notification anywhere.
  **What:** `scripts/watchdog.ts` (tsx entrypoint — `loadDotEnv()` first,
  per the #40 rule): opens the DB read-only (missing DB → silent exit 0),
  reads the heartbeat age; if >10 min stale, pushes a critical notification
  through the existing ntfy/desktop plumbing (severity-gate bypass, like
  the morning brief's direct send), throttled to one alert per outage with
  a 6h re-alert via `data/watchdog-state.json`; a fresh heartbeat clears
  the state silently. If no notification channel is configured it logs and
  exits — the install script warns about that. `install-watchdog-task.ps1`
  registers `FinanceAgentWatchdog` on a 30-minute repetition using the #51
  hidden-vbs pattern (short-lived run each time), with an uninstall mirror;
  opt-in like #18. A sleeping machine pauses the watchdog too — correct,
  since there's nobody there to alert.
  **Accept:** staleness/throttle helpers unit-tested (fresh, stale,
  missing DB, inside/outside the re-alert window, state round-trip). Live:
  with the runner stopped, one manual watchdog run raises the toast/ntfy
  push; with it running, a run stays silent and clears the state.

---

# Roadmap v5 (2026-07-11) — complete

Roadmaps v1–v4 (#1–#47) are **complete** — see below and the archives. v5
came from runtime signals observed on 2026-07-11 against the live system
(alert-table composition, job heartbeats vs. the maintenance log, and a
mis-themed pick found while verifying the audit fixes). Items are #48+.

## v5 — Tier 1: ops correctness & alert hygiene

- [x] **48. Sleep-proof the daily maintenance schedule** *(small — done
  2026-07-11)*
  **Why:** node-cron's `0 8 * * *` tick doesn't fire when the machine is
  asleep at 08:00, and the #43 catch-up only runs at process startup.
  Observed 2026-07-11: the runner's heartbeat was alive 08:36–08:42 local
  (machine woke after the tick) but no maintenance ran all day — no
  retention, no backup, no discovery — with nothing on /status to say why.
  The refresh loop is already a sleep-tolerant self-scheduling timer; only
  maintenance depends on being awake at one exact minute.
  **What:** pure `isMaintenanceCatchupDue(lastRunAt, now, dueHour=8,
  maxAgeHours=20)` in `jobHealth.ts` — due only when past `dueHour` local
  AND `isDailyJobDue` — called from the minute refresh loop; a `maintaining`
  guard prevents overlap with the 08:00 cron and the startup catch-up (both
  stay). Note `recordJobRun("daily_maintenance","error")` bumps
  `last_run_at`, so a failing maintenance retries next day, not every
  minute — unchanged from today.
  **Accept:** helper unit-tested (pre-hour stale, post-hour stale, post-hour
  fresh, never-ran, unparseable). Live: with a >20h-old last run, the
  running scheduler kicks maintenance within a minute — no restart needed.

- [x] **49. Auto-acknowledge condition alerts whose condition has cleared**
  *(medium — done 2026-07-11; the first live scan drained the backlog
  64→14 criticals, 118→13 warnings, event alerts untouched)*
  **Why:** #45 stopped daily re-emits, but rows for dead states linger
  forever: observed 48 unacked `stop_loss_hit` **criticals all referencing
  closed trades** (RTX ×28), `exit_recommended` for long-closed F/ORCL
  trades, and 93 `data_stale` warnings whose tickers have long since
  refreshed. The header badge stays red on states nobody can act on. #36's
  age-based auto-ack deliberately never touches criticals — age is not
  evidence a critical is moot — but the condition objectively ending is.
  **What:** two layers. (a) `generateAlerts` tracks which condition alerts
  are currently true per (type, ticker) and, after the scan, auto-acks
  unacked rows no longer true. *Fluid* conditions (`near_stop_loss`,
  `target_hit`, `trade_score_low/critical`, `exit/trim/add`,
  `entry_range_reached`, `concentration`, `data_stale`) clear as soon as a
  scan stops finding them; *sticky* criticals (`stop_loss_hit`,
  `thesis_invalidated`) clear only when the ticker has no open trade left —
  an intraday stop breach stays visible even if price recovers. Event
  alerts (order fills/cancels, auto-closes, new_setup, major_catalyst,
  mentions, morning brief) are never touched. (b) `closeTrade` acks the
  trade-scoped types for its ticker immediately; on multi-trade tickers the
  next scan re-emits if another open trade still has the condition (#45's
  ack re-arm makes this self-healing).
  **Accept:** persistence tests — zombie stop alert on a closed trade acked
  by one scan; an open-trade breach survives; stale→fresh `data_stale`
  acked; event alerts untouched; `closeTrade` acks immediately. Live: the
  48-critical backlog drains on the first scan and the badge drops.

## v5 — Tier 2: pick quality

- [x] **50. Sector Scout: theme-membership check on surfaced picks**
  *(small–medium — done 2026-07-11; also covers kept "added" picks, which is
  how the live ALKS row got its flag)*
  **Why:** validation proves a ticker has real price data, not that it
  belongs to the theme — the live "space" scan holds **ALKS (Alkermes, a
  biotech)** as an added pick, an LLM-expansion slip from 2026-06-29 that
  rode a decent market score into the industry list. Thesis validation
  would catch this via `themeFitScore`, but it's budget-capped and opt-in.
  **What:** after the score/thesis gates select the surfaced set, one
  batched LLM call re-checks membership ("which of these are NOT primarily
  <industry> businesses?") and stores a flag; the pick card shows a visible
  "theme fit questioned" chip — flag, never silently drop (decision
  support). Rule-based fallback: curated-theme members pass, everything
  else is left unflagged (no false accusations without evidence). Nullable
  `theme_fit_flag` column on `sector_scout_picks` (normal migration flow).
  **Accept:** parser + fallback unit-tested; persistence test that a
  flagged pick keeps its flag through a re-scan upsert. Live: a re-scan of
  "space" flags a biotech interloper while leaving RKLB-class names clean.

---

# Roadmap v4 (2026-07-10) — complete

Roadmaps v1 (#1–#14), v2 (#15–#28), and v3 (#29–#43, including follow-ups)
are **complete** — see below and the archives. v4 came from a fresh pass on
2026-07-10 over the modules v2/v3 hadn't touched (orderSync, catalysts,
discovery, earnings fetch) plus runtime signals from the first-ever real
maintenance run. Items are numbered #44+.

## v4 — Tier 1: correctness

- [x] **44. `classifyCatalyst` tone adjustment forces the sign** *(small — done)*
  **Why:** `catalysts.ts` tone rules say "adjustment for otherwise-neutral
  matches" but apply to every match with sign-forcing math:
  `Math.min(impact - 1, -1)` turns a +4 guidance-raise headline containing
  one word like "warns" into **-1**, and the positive mirror turns a -3
  estimates-miss with "soars" into **+1**. The existing test only covers the
  neutral case, so the flip is unexercised.
  **What:** Tone only *nudges*: when no rule matched (impact 0) it sets ±1
  as today; when a rule matched, add/subtract 1 with the -5..5 clamp but
  never force the result across zero. Tests for the two flip cases plus the
  existing neutral behavior.
  **Accept:** "Raises guidance but warns on supply" scores strongly positive
  (+3), "misses estimates as shares soar" stays negative; old tests green.

- [x] **45. Suppress re-emits of condition alerts while one is already
  unacked** *(medium — done)*
  **Why:** `emitAlert`'s 20h dedupe keys on the exact message, and condition
  messages embed the live price/score — so a stop that stays breached or a
  ticker that stays stale re-alerts **every day with a new row**: observed
  91 `data_stale`, 48 `stop_loss_hit` rows. The feed and badge fill with
  repeats of states the user already hasn't acted on.
  **What:** An `onceWhileUnacked` option on `emitAlert`: skip when an
  **unacknowledged** alert of the same (type, ticker) already exists,
  regardless of message/age. Apply to the condition-state alerts in
  `generateAlerts` (stop/near-stop, score low/critical, exit/trim/add,
  buy-zone, data_stale, concentration) — not to event alerts (order fills,
  auto-closes, mentions, brief). Acknowledging re-arms the alert.
  **Accept:** Persistence test: same condition two days running → one row
  while unacked; ack + re-emit → second row. Live feed stops accumulating
  daily repeats.

## v4 — Tier 2: efficiency & UX

- [x] **46. Parallelize the maintenance Yahoo loops** *(small — done)*
  **Why:** `scanYahooNews`, `fetchEarningsForTickers`, and
  `fetchUpcomingEarningsForTickers` each `await` per ticker in a `for` loop
  — 3 × 45 serialized Yahoo calls per maintenance (~20s observed for the
  earnings pair alone). `mapPool` is the established idiom everywhere else.
  **What:** `mapPool(tickers, 4, …)` in all three, keeping per-ticker
  error isolation exactly as now (SQLite writes are synchronous on the main
  thread, so parallel fetch + serial write is safe).
  **Accept:** Tests stay green; a live maintenance run logs the same counts
  in visibly less wall time.

- [x] **47. Live R/R + size feedback in the trade dialog** *(small–medium — done)*
  **Why:** The pre-trade gate (#29) answers only on submit; the dialog shows
  est. notional but not the risk/reward being keyed in or a suggested size,
  though `riskRewardRatio` and `suggestPositionSize` are pure and
  client-importable.
  **What:** In `TradeOrder`, compute R/R from limit/stop/target as the user
  types (with the configured minimum passed as a prop from the server page),
  show it inline colored by threshold, plus "suggested size: N shares
  (risking $X)" from `suggestPositionSize` when a stop is set. Display-only
  — the server gate stays authoritative.
  **Accept:** Typing a thin target shows the sub-minimum R/R immediately;
  the placed order still round-trips the server gate unchanged.

---

# Roadmap v3 (2026-07-09) — complete

This v3 list came from a fresh pass over the codebase on 2026-07-09; every
"Why" cites the actual code it's grounded in. Items are numbered #29+ so
git-history references to "roadmap #N" stay unambiguous.

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

- [x] **39. Opt-in daily morning brief** *(small–medium — done 2026-07-10)*
  **Why:** Everything a trader should glance at each morning (market regime,
  earnings inside the avoid window, trades flagged Exit/Trim, buy-zone hits,
  fresh quality setups) is computed but spread across four pages; the
  notification rails (#9/#15/#34) were only used for reactive alerts.
  **What:** `src/services/morningBrief.ts` — `buildMorningBrief()` composes
  the sections (empty ones omitted) and `sendMorningBrief()` emits it once
  per day as an info alert (date in the message keys the dedupe) at the end
  of daily maintenance, pushing through the channels directly when the
  severity gate would suppress info (the `morningBriefEnabled` toggle is the
  opt-in; master `notifyEnabled` still applies; no double-send when the gate
  passes info). New config key + settings validation + Settings row, per the
  new-setting checklist.
  **Accept:** Tests cover section composition, quiet-day omission, the
  disabled/sent/already-sent-today paths, and exactly one alert row. Live
  compose against real data produced a correct brief (regime favorable, LLY
  Trim, six buy-zone names, five q≥7 setups, earnings section rightly
  absent).

- [x] **40. The jobs runner never loaded `.env`** *(small, operational bug —
  done 2026-07-10)*
  **Why:** Next.js loads `.env` for the app, but `npm run jobs` runs under
  plain tsx, which doesn't — so the background scheduler has been running
  **keyless** the whole time: quotes fell back to Yahoo, broker order sync
  and portfolio sync silently skipped, Alpaca clock phase detection
  approximated, and LLM-gated features ran rule-based even with a key
  configured. Found by comparing snapshot sources: dev-server refreshes
  wrote `alpaca`, scheduler refreshes wrote `yahoo`. The README's
  Scheduled-Task section even claimed `.env` was read.
  **What:** `src/lib/loadEnv.ts` — dependency-free `applyDotEnv` parser
  (comments, `export` prefixes, quotes, trailing comments; **never
  overwrites real env vars**) + `loadDotEnv()` called at the top of the
  three tsx entrypoints (`scheduler.ts`, `db/restore.ts`, `db/seed.ts`).
  Safe because every env read in the codebase happens at call time.
  **Accept:** Parser unit-tested (quoting, precedence, CRLF). Live: after
  restart, the scheduler's refresh wrote 45/45 snapshots with source
  `alpaca` (was `yahoo`), in 3s instead of a Yahoo-paced crawl.

- [x] **41. Surface the runner's env on `/status`** *(small — done
  2026-07-10)*
  **Why:** #40 stayed invisible for weeks because `/status` reports the
  *web process's* integrations while the scheduler is a separate process —
  "Alpaca: connected" on the page said nothing about the runner being
  keyless.
  **What:** The minute heartbeat now records the scheduler's own
  integration flags in its `job_runs` message (`alpaca=paper llm=on`);
  `schedulerEnvFromHeartbeat` (pure, in `status.ts`) surfaces it on
  `/status` and raises an amber warning when the web app has Alpaca but
  the runner reports `alpaca=off` — exactly #40's failure mode.
  **Accept:** Helper unit-tested (match, mismatch, both-keyless,
  legacy null message). Live: restarted runner heartbeat shows
  `alpaca=paper llm=on` on the page.

- [x] **42. Unacked-alerts badge in the header** *(small — done 2026-07-10)*
  **Why:** The alerts feed only warns if you visit it — 319 unacked rows
  (64 critical) had accumulated with zero ambient visibility; the header
  had a jobs-health badge but nothing for alerts.
  **What:** `AlertsBadge` (client, 60s poll of the new
  `GET /api/alerts/unacked-count`) next to `JobHealthBadge`: hidden at
  zero, muted amber-dot count normally, red when anything critical waits;
  links to `/alerts?ack=unacked`.
  **Accept:** Route test (acked rows excluded, criticals counted); live
  endpoint returns the real backlog and the chip renders in the header.

- [x] **43. Startup catch-up for missed daily maintenance** *(small,
  operational bug — done 2026-07-10)*
  **Why:** The 08:00 maintenance cron only fires while the runner is alive
  at 08:00. With the runner living in ad-hoc terminals, `job_runs` showed
  **zero `daily_maintenance` completions ever** and `data/backups/` didn't
  exist — no retention, no backups, no scheduled backtests had actually
  been happening. (The #18 Scheduled Task installer would prevent this but
  is opt-in and was never installed.)
  **What:** Pure `isDailyJobDue(lastRunAt, now, maxAgeHours=20)` in
  `jobHealth.ts`; on scheduler startup, when the last completed maintenance
  is missing or >20h old, run it 30s after boot (logged as a catch-up).
  **Accept:** Due-check unit-tested (never/stale/unparseable/recent). Live:
  restarted runner logged the catch-up, ran full maintenance (discovery,
  159 earnings quarters, retention), and wrote the **first backup ever**
  (`finance-agent-2026-07-10.db`, 12.9 MB).

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

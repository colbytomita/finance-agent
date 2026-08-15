# Agent Memory

Last updated: 2026-08-14.

## 2026-08-14 session — v10 executed (#66, #67, #68, #72–#76) + a broker-state investigation

Colby asked "how is this project doing performance wise", then "start fixing
those issues", then requested the stock-page trade panel and exit buttons, then
asked why his limit orders had been cancelled. Nine roadmap items shipped.
**Committed on branch `roadmap-v10-execution`, PR #39** (he merges PRs himself).
**Tests 501 → 564 across 45 files; `npx tsc --noEmit` clean; migrations 0009 + 0010.**
Full per-item detail with tables lives in `docs/ROADMAP.md` — this is the map.

### The through-line worth reading first

**Four separate times this session, a plausible fix was wrong and only
measurement caught it.** That is the transferable lesson, not any single fix:

1. "Breakout fails → require volume confirmation." The volume-confirmed subset
   went **0-for-4**. Dropped before any code was written.
2. "ma_reclaim catches bull traps → filter reclaims of a falling 50-SMA." Built,
   then measured: **halved the sample (1,922 → 1,067 matured) for an unchanged
   35.5% win rate.** Reverted; the null result is recorded in a comment in
   `detectMaReclaim` so it is not re-derived.
3. "Make riskScore two-sided by re-basing to a neutral 5.5." Measured: it pushed
   the **median stock down** (Buy 17 → 7, Watch/Hold 29 → 40) because real
   holdings cluster at 2.5–4% ATR. Kept the base at 7 and added only upside.
4. "7 of 8 open trades have live bracket legs" — asserted from the app's
   `stop_loss` column **without asking the broker**. Wrong: 5 of 11 positions had
   no live stop at all.

**Method that works, use it:** run OLD and NEW logic over the **same recomputed
inputs** in one process, keeping the old implementation inline as a control.
Comparing new output against **stored** rows is confounded (stored scores were
built from live quotes + earnings nudges) and produced a false negative that cost
a full cycle. And: if a change is monotone by construction but the measurement
shows non-monotone results, **trust the construction and debug the measurement.**

### What shipped

- **#68 breakout detector — it could never fire on a breakout.**
  `supportResistance` defines `resistance` as the nearest swing high *strictly
  above* price, so `price >= resistance*0.99` only ever meant "climbed to within
  1% below a ceiling"; `price <= resistance*1.03` was dead code. Proven against
  data: across all 616 stored breakout rows `entry_range_low > entry_range_high`
  never occurs. Fixed with a new `clearedHigh` indicator + fresh-crossing test +
  5% extension cap + volume as a hard gate; targets now measured from the entry
  **mid** (the resolver fills at mid, so measuring from `entryHigh` advertised an
  R/R the trade never got). **Replay over 288 tickers with the old logic as a
  control on identical data: 23.2% → 38.3% win rate, +0.04R → +0.10R.**
  `setupDetection.ts` had **no unit tests at all** — that is how it survived.
- **#66 the top band was arithmetically impossible.** `riskScore` capped at 7.5
  (base 7, subtract-only), `valuationScore` at 7.0 (flat {4.5,6,7} lookup) → max
  blend **7.46**. Both are two-sided now. A/B: 36 of 54 raised, 0 lowered.
- **#67 catalyst compression is an INPUT problem, not a range problem.** 74% of
  stored catalysts have `impact_score = 0` (mostly `yahoo-news`), and mega-caps
  hold 300+ rows, so the *mean* buried real signal (NVDA 0.31 over everything vs
  1.09 over directional only). New `directionalCatalysts()` feeds scoring only;
  the display timeline is unchanged. Sentiment weight → 0, folded into catalyst
  (0.25 → 0.35). Rejected on evidence: net-pressure tanh (saturates, median
  9.97) and strongest-signal (one −3 headline pinned four mega-caps at 3.61).
- **#72 `thesisPlayedOut` was uncollectable AND would have been inverted.** The
  close form never collected it, and the route used `z.coerce.boolean()` =
  `Boolean(v)`, so the string `"no"` → **true**. **Grep for `z.coerce.boolean()`
  anywhere else before trusting it.**
- **#73 a third of the realized sample was dev cleanup.** 5 of 16 closed trades
  batch-closed within ~2 minutes on 2026-06-25. New `excluded_from_stats` /
  `excluded_reason` columns (**migration 0009**); **rows kept, flagged not
  deleted**. Realized avg R −0.22 → **+0.00**, avg return −1.86% → **+0.71%**.
  **ORCL (−2.67R) is now excluded, so #69/#71 rest on a trade that has left the
  live sample — re-check them before acting.**
- **#74 / #76 exits.** `tradeExit.ts` sequences cancel legs → market close →
  poll for a real fill → close at the **actual** fill; refuses when the market is
  closed; re-places the stop and raises a critical alert if the sell fails after
  cancelling. `exitAll.ts` adds a bulk exit behind a typed `EXIT ALL` phrase —
  sequential, never aborts the batch on one failure, records exit reason +
  thesis on every journal entry, re-runs the performance backtest afterwards.
- **#75 stop-coverage reconciliation.** Compares each open trade's *recorded*
  stop against orders actually working at the broker; `stop_missing` alerts;
  user-initiated `restore-stop` places a standalone **GTC** stop.

- **#71 stop-distance-vs-ATR advisory.** Premise re-verified on the post-#73
  sample: 14 of 15 closed trades with a stop sat at **1.49–2.12× ATR(14)**; the
  sole outlier is **V at 0.61×**, and V is *not* excluded, so the finding stands
  (n=1 still does not establish "tight stops lose"). The order dialog now shows
  `stop N.NN× ATR(14)` beside the live R/R, amber under 1×. `pretradeRiskProblems`
  deliberately unchanged — advisory, never a block.

- **#68c setup expiry — the premise was backwards.** 44 of 111 triggered setups
  expire, which reads as a defect. Replaying 11,266 episodes and re-resolving the
  same setups at different targets shows **expectancy rises monotonically with
  target distance** (avg R 0.014 @1R → 0.059 @2R → 0.108 @3R, n=9,968 triggered).
  Pulling targets in would raise the win rate and **lower** the return; every type
  was worse at 1.5R, and `pullback_to_support` went negative. **The horizon is the
  binding constraint** — the same setups at 40 days expire 11.8% instead of 28.2%
  and return 0.076R instead of 0.059R. `SETUP_HORIZON_DAYS` left at 20 on purpose
  (changing it reshapes every historical comparison; 20d matches the ~15-day
  observed hold). A `/performance` note now states this so it is not re-"fixed".
  **General lesson: when a metric looks bad, check whether it is the cost of
  something good before optimising it away.**


### App review + performance pass (#77-#79)

**`next build` had been broken for three weeks, so the dev server was the only
way to run the app.** TypeScript 7 is the native rewrite: its package `exports`
map points `"."` at `lib/version.cjs` (a version string, not the classic compiler
API), while Next 16.2.10's build still expects `typescript.sys`,
`readConfigFile` and `formatDiagnostic`. It resolved the package, got an object
with no `.sys`, and failed with `The "id" argument must be of type string`.
Fixed with `typescript: { ignoreBuildErrors: true }`; **`npx tsc --noEmit`
remains the real type gate**, now with `noUnusedLocals`/`noUnusedParameters`.
Measured dev vs production, warm: `/` 196->33ms, `/swing` 422->77ms,
`/watchlist` 933->125ms, `/status` 205->31ms, `/stock/AVGO` 123->16ms -- **5-8x
on every page**. Use `npm run dev` while developing, `npm start` to use the app.

**Indexing:** `catalysts(ticker, status)` added (migration 0010) -- scoring
full-scanned 9k rows once per ticker per 2-minute refresh (27.2ms -> 11.0ms per
54-ticker pass), and that table only grows. `price_bars` (120k rows) *looked*
unindexed but is covered by its `UNIQUE(ticker, timeframe, bar_date)`
auto-index -- worth checking rather than assuming.

**Dead code:** a scan of every exported function found **exactly one** genuinely
unreachable export in 25k lines, and it was mine from earlier the same day
(`defaultExitOne`, never wired up). The no-dead-code discipline is holding.

**Verdict: structurally healthy, no refactor warranted.** 25k source / 7.4k test
lines, largest file 860, DB layer ~60ms of a page's work. The problems were
configuration and indexing, not structure.

### The broker-state findings (these will bite again)

- **`?status=open` does NOT return orders in `held`**, which is where a bracket's
  protective stop waits. And `nested=true` hides bracket children inside their
  parent (**31 orders returned nested vs 77 flat**). The first cut of
  `openOrdersFor` used both and therefore missed **5 live stop legs** — an exit
  would have sold the position and left an orphaned stop that can later execute
  and **flip the account short**, the exact failure the design exists to prevent.
  Now `status=all&nested=false` filtered by an explicit `LIVE_ORDER_STATUSES` set.
  **A broker's "open" is not your definition of open — enumerate statuses.**
- **Why orders get cancelled, confirmed pair-by-pair:** a bracket is **OCO**, so
  a filled stop cancels its target and vice versa (MSFT, AMGN, EIX, EXC, V, RTX,
  BABA, MA, AMZN, TSLA — all normal). Separately, the 2026-06-25 orders used
  `time_in_force=day`, so their protective legs expired at that day's close and
  were never replaced; orders from 2026-07-06 onward use `gtc`.
- **QBTS is unexplained**: both legs cancelled 2026-07-27 at 07:03/08:00 UTC,
  **neither filled**, position still held, no corporate action in activities.
- **Never infer broker state from the app DB. Query the broker.**

### State at session end

- **Uncommitted**, tests 560/45, typecheck clean, migration 0009 pending commit.
- Account: equity $101,269.64 on a $100k paper account (**+1.27% all-time**);
  open book cost $17,292 → value $18,362 = **+$1,069.52 (+6.2%)**, but **$82,908
  (82%) is idle cash**, so the 6.2% is on ~18% deployed. **QBTS alone is $424.71
  = 40% of the entire gain.**
- **Colby plans to exit everything at Monday 2026-08-17's open (09:30 ET) and
  redeploy.** `/swing` → "Exit all 8 positions…". **That bulk exit has never run
  against the broker** (market closed all session) — #74b covers the first real
  round-trip, and Monday IS it.
- 18 pending Agent Picks (XOM 8.1, COP 8.1, MS 7.9, SMCI 7.9, ASML 7.8, PLTR
  7.8 …) already exist for redeployment — **no need to spend LLM credits** on a
  fresh scan. They were scored *before* #66/#67 and will re-score on refresh.
- **Open and important: #67b** — #66 and #67 both widened the score and both were
  validated on *distribution shape only*. Neither has been shown to predict
  anything, and the Buy band now holds 43% of the watchlist (was 15%).
  Recalibrate the bands on **forward returns** once 20 trading days have matured.

## 2026-08-06 session (later still) — the first real performance evaluation → roadmap v10

Colby asked "how has this finance agent been performing?" This is the first time
the question was answered with numbers rather than vibes. Sources: the
`/performance` backtest re-run at 21:00Z (1,545 score events, 55 tickers,
2026-06-13 → 2026-08-06), 16 closed trades, 83 matured setups. **Nothing was
built for this** — v10 is written, no v10 item is implemented except the #70
measurement. Roadmap v10 in `docs/ROADMAP.md` carries the full tables.

**Headline: risk control works; selection has not demonstrated forward edge; the
score is mostly a restatement of trailing momentum.**

- **Score calibration.** Read t-stats, not percentages. Backward the score is
  overwhelming (Buy band pre5 **+3.00%, t=8.68**; Avoid band **−5.16%,
  t=−11.81**). Forward at 5 days **nothing is significant and the ordering
  inverts** — Buy −0.58% is *worse* than Hold −0.37%. At post20 the ordering is
  monotonic but only the downside is solid (Avoid −9.49%, **t=−6.16**, n=102;
  Buy +2.48% at t=1.49 on n=25 is noise). **So: a reliable "what to avoid"
  detector, an unproven "what to buy" detector.**
- **The score's ceiling is structural (#66).** In 26,667 rows the score has
  **never reached 8** — min 2.8, max **7.7**, mean 6.10. "Strong Buy" (9–10)
  has zero events ever; "Strong Avoid" has 44. Cause: the heavily-weighted
  components are compressed — catalyst (w=0.25) spans 3.79–6.66 = 0.72 pts of
  swing, sentiment (w=0.10) spans 4.36–6.22 = **0.19 pts** and literally cannot
  move a band. Only **momentum has real range (1.5–9.5)**, which is *why* the
  score mirrors momentum. Max achievable ≈ 7.46, matching the observed 7.7.
- **Setups (#68).** 83 matured, 27.8% win, avg R **+0.07** ≈ breakeven — and
  breakeven only because **`breakout` (27 matured, 1 win in 13 triggered,
  avg R −0.24)** cancels out pullback_to_support (55.6%, +0.26) and
  momentum_continuation (37.5%, +0.24).
- **Realized trades.** 16 closed, 25% win, avg −1.86%, avg R **−0.22**, net
  **+$95 on $17,749 deployed (+0.54%) vs SPY +1.84%** — underperformed the
  benchmark. Profit factor 1.17 is dollar-weighted and flattering.
- **#70 MEASURED — exits are *not* the problem.** Actual exits −0.379R vs
  holding to +20d −0.212R: holding better by 0.168R/trade, but that is a small
  net of huge opposing effects on n=12 (exiting saved 1.5–2.4R on TSLA×3/ORCL,
  cost 2.9R and 4.8R on RTX/V). **No exit-logic change is justified.** Item
  closed, not deferred.
- **The one actionable find (#71).** Stops are mostly sane at 1.6–2.5× ATR(14).
  **V's was 1.43% against a 2.36% ATR = 0.61×** — inside a single day's range;
  stopped instantly, then ran to +3.82R, forgoing **4.83R**, the biggest swing
  in the book. Only 2 trades sit under 1.5× ATR so "tight stops lose" is NOT
  established — but flagging a sub-1× ATR stop in the trade dialog is cheap and
  clearly right.

**Caveat stapled to all of it:** eight weeks, one mild-uptrend regime (SPY
+1.84%), post20 only matures for events before ~07-09, 16 trades. The *negative*
findings rest on the big samples and are the trustworthy half; the positive ones
do not clear the bar. Re-run before treating any of it as settled.

**#66/#67 need Colby's decision before any code moves** — rescaling the bands or
widening components changes every score on every page.

## 2026-08-06 session (later) — #63: GDELT was never rate-limited to death; our connector threw the data away

**Read this before acting on anything that calls GDELT "dead".** The entry below
concluded GDELT was unusable from twelve consecutive zero-item runs and filed #63
as a retire-vs-pivot decision. That inference was wrong, and the trap is easy to
repeat: *a source returning nothing is not evidence the source is at fault until
the client has been tested independently.* A connector-identical request from
this machine returned 200 OK with 10 articles.

**Two defects in `src/services/sources/gdelt.ts`:**

1. **A single 429 ended the whole run.** `fetchGdeltNews` did a hard `break` on
   the first 429, and its only escape was a `Retry-After` retry. GDELT **never
   sends `Retry-After`** (`null` on every observed 429), so that branch was
   unreachable and every run died on its first throttle. Replaying the exact
   production shape live gave `429, 429, 429, 200 with 10 articles` — the budget
   recovers *within* a run, so abandoning it guarantees zero.
2. **Connect timeouts were misfiled as `http error`.** Node/undici's connect
   timeout is **10s**, is **not** governed by `AbortSignal.timeout(30000)`, and
   throws a bare `TypeError`. The catch matched only `TimeoutError`/`AbortError`,
   so those landed in `httpError` — the "opaque class" the entry below noticed
   but attributed to missing instrumentation rather than misclassification.

**Fixed:** a 429 now backs off and continues, bounded by
`maxConsecutiveThrottled` (default 3, reset by any non-429 outcome) so a genuine
wall of throttling still stops politely and the day-rotation resumes the tail;
`UND_ERR_*_TIMEOUT` counts as a timeout; `httpErrorSample` records "HTTP 503" or
`name: UND_ERR_CODE`, surfaced by `describeGdeltFailures` into
`ingestion_runs.errors_json`.

**Verified:** 5 new tests (**500/41**, typecheck clean) plus a live
production-shape run — **10 real articles where the old code returned 0**.
Nothing committed (finance-agent rule).

**Gotcha worth keeping:** `AbortSignal.timeout(n)` does **not** cover connection
establishment in Node `fetch`. Any connector relying on it for "my timeout is n"
is wrong about connect-phase failures and will see them as a generic
`TypeError: fetch failed`. Check `err.cause.code` for the real reason.

## 2026-08-06 session — roadmap v9 (#61, #62): the database was doubling every 12 days

Post-v8 forensics pass → wrote roadmap **v9** in `docs/ROADMAP.md` and shipped
#61 + #62 the same session. Tests **496/41** (was 487), typecheck clean,
nothing committed (finance-agent rule). Runner restarted twice onto the new
builds; `FinanceAgentJobs` Running, lock held.

**The finding.** v8 shipped 07-20; since then the machine stayed awake through
several *full* market days for the first time, which exposed a cost nobody had
measured. The DB went **41 MB (07-25 backup) → 88 MB**, +13 MB per awake market
day. `dbstat` located **50.4 MB of the 88 MB (57%) in `stock_scores`**.
Retention was *not* broken — it was doing exactly what it says (0 drawdown rows
past 30d, 0 snapshots past 7d, only 282 score rows past the thin window). The
**write path** was the problem: `recomputeStockAnalysis` appended a full score
row (~640 bytes of `reasoning_json`) **and** a full drawdown row per ticker on
every ~2-minute refresh — ~12,400 rows/day each — while `score_history`
recorded only **9–34 real score moves/day** and *every* consumer reads at most
one row per ticker per day (`latestScore`/`latestDrawdown` = newest row;
`scoreSeries` and `buildScoreEvents` = last-per-day). The comment above the
insert already said "Persist stock score + history when it changed" — only the
*history* row was ever conditional.

- **#61 DONE + live-verified.** New pure `canUpdateLiveScoreRow` in
  `scoring.ts`; `recomputeStockAnalysis` UPDATEs the ticker's existing row in
  place when it is the **same UTC day** and the score moved **less than
  `MATERIAL_SCORE_DELTA`**, else INSERTs. So: ≥1 row per ticker per day for the
  daily readers, plus a real row for every material intraday move — nothing a
  consumer reads is lost. The hardcoded `0.5` that gated `score_history` is now
  that same shared constant, so the two "did it move?" tests can't drift.
  **Checked before building:** `data_stale` reads
  `market_price_snapshots.captured_at`, *not* `stock_scores`, so freshness
  alerting is untouched. Retention's `MAX(id) GROUP BY ticker, day` thin still
  works because in-place updates only ever touch the newest row, so MAX(id)
  stays the latest `calculated_at`.
- **#62 DONE + live-verified.** Same treatment for `drawdown_metrics`, minus
  the threshold (no history feed to preserve; every reader takes the newest
  row). The UTC-day test both need is now shared `isSameUtcDay` in
  `lib/util.ts` — **UTC deliberately**: every daily reader buckets on
  `substr(ts,1,10)`, and local time would disagree by a day for a UTC-10 user.

**The live check worth copying.** Restarting the runner between the two items
gave a natural control: the 20:35Z 53-ticker refresh (with #61 only) left
`stock_scores` at **12,402 → 12,402** while `drawdown_metrics` went
**12,402 → 12,455 (+53)**. Same tickers, same cycle — proof the flat count was
the fix and not an idle loop. After #62 the 20:38Z refresh appended **0** to
both. UI re-verified: /stock/NVDA header and its sparkline's 08-06 point both
read 6.7, matching the in-place-updated row.

**#65 DONE (Colby approved "shorten the window to ~2 days").**
`SCORE_THIN_AFTER_DAYS` 30 → **2**, new `DRAWDOWN_THIN_AFTER_DAYS` = 2, and a
shared `thinToLastPerDay()` helper — `drawdown_metrics` previously had *no*
thin at all (only an outright delete at 30 days), so its intraday backlog would
have sat for a month. Live: thinned **38,106 score + 38,106 drawdown rows**,
deleted 2,915 snapshots; a one-off `VACUUM` (runner stopped for the exclusive
lock — `PRAGMA optimize` + `wal_checkpoint` do **not** shrink the file, only
VACUUM does) took it **88.5 MB → 45.2 MB**. Still falling: 25,069 of the 26,667
remaining score rows are inside the 2-day window and thin to ~106 as they age.
**Integrity proof:** a full `POST /api/performance` re-run against the thinned
data returned **sampledEvents 1545 / analyzed 1543 / tickers 55 / calibration
"mixed" — identical to pre-purge**; only `totalScoreRows` moved (61,805 →
26,667), which is the raw-row stat by definition.

**~~OPEN — needs Colby (#63): GDELT is now conclusively dead.~~ WRONG —
superseded by the later 2026-08-06 entry at the top of this file. Do not act on
this paragraph.** It read: 12 consecutive scheduled runs (07-21 → 08-06) fetched
0 items, plus a manual probe that 429'd, therefore GDELT is too rate-limited to
use. **The inference was unsound**: those zeros are fully explained by *our*
connector breaking the run on its first 429 (its only escape was a `Retry-After`
header GDELT never sends — my own probe that session recorded
`retry-after: null` and I failed to connect the two). A source returning nothing
is not evidence about the source until the client has been tested independently.
GDELT works; the client was throwing the data away. Kept here rather than
deleted because the reasoning error is the useful part.

**Still not installed:** `FinanceAgentWake` (#60). `Get-ScheduledTask` shows
only `FinanceAgentJobs` (Running) and `FinanceAgentWatchdog` (Ready). Needs
Colby to run `scripts/install-wake-task.ps1` from an elevated PowerShell.

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

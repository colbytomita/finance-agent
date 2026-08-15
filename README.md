# Finance Agent

A market-research and swing-trading **decision-support** dashboard. It tracks your portfolio, watchlist, and active trades; pulls live prices and daily bars; scores stocks and trades on a 1–10 scale with plain-language explanations; detects swing setups; watches drawdowns, buy zones, and catalysts; discovers new candidates; and measures the historical price relationship between real-world events and the stocks they reference.

It is **decision support, not an autopilot** — it never trades on its own and never guarantees returns, labels every model-generated interpretation as such, and timestamps all data with a staleness warning. It can place an order through your Alpaca account, but only when you open the trade dialog, set the size, and confirm — paper by default, with an explicit extra confirmation required for a live (real-money) account. Built with Next.js 16 (App Router) · TypeScript (strict) · React 19 · Tailwind v4 · `better-sqlite3` + `drizzle-orm` · `zod` · `node-cron` · Playwright.

## What's in it

**Market data & scoring.** Live quotes come from Alpaca (regular session) and Yahoo Finance for pre/after-hours — via Yahoo's JSON endpoints over plain HTTP (cookie+crumb session), with the headless-Chromium scraper kept only as a fallback. Daily bars come from Alpaca, or from Yahoo's chart endpoint when Alpaca isn't configured — so discovery and Sector Scout work with real data even without broker keys. Daily OHLCV bars feed an indicator engine (SMA/EMA/RSI/MACD/ATR/VWAP, support/resistance, relative volume). Each stock gets a blended 1–10 score from valuation, momentum, catalyst and risk (sentiment is computed and shown but carries no weight — it reads the same catalyst inputs as the catalyst score, so it was nearly collinear with it and could not move a recommendation; its weight was folded into catalyst) — and a recommendation (**Strong Buy Candidate → Strong Avoid**); open trades get their own 1–10 score and an **Enter / Wait / Hold / Add / Trim / Exit / Avoid** action. Every score ships with the reasons behind it, so you can answer "why did this change?". The `risk` and `valuation` components are **two-sided** — they reward genuinely low volatility, an intact structure near the highs, and a discount that is already recovering, rather than only ever deducting for problems. That matters because until 2026-08-14 they were capped at 7.5 and 7.0, which put a hard arithmetic ceiling of ~7.5 on the blend and made the top band (**Strong Buy Candidate**, 9–10) impossible to reach — it had never once fired. It is reachable now; it is still empty whenever nothing genuinely merits it, which is the point. **Only directional catalysts feed the score.** 74% of stored catalysts are neutral (impact 0) news items, and mega-caps accumulate 300+ of them — averaged in, they crushed the catalyst component to a near-constant ~5.7 (NVDA's mean impact is 0.31 over everything but 1.09 over directional items alone). The scoring feed therefore uses only catalysts with a non-zero impact, most recent 30; the stock-page timeline still shows everything. When a ticker has **no directional catalysts**, the catalyst and sentiment components are excluded from the blend (their weight is redistributed) so missing data doesn't drag the score toward neutral — the `confidence` field still reflects the data gap. Catalysts also age out after a freshness window (`catalystFreshnessDays`, default 90) so stale events stop counting as current drivers.

**Buy zones & setups.** Tracks drawdown from 52-week and 30-day highs, evaluates configurable buy zones (target range, reinvest-above, max-risk), and detects swing setups (pullback-to-support, breakout, oversold bounce, etc.) with entry/stop/target levels and risk-reward. A **breakout** means a level that has actually been *broken*: price must have closed above a swing high it previously could not clear, within the last few bars, on ≥1.3× average volume, and without having already run more than 5% past it. (Until 2026-08-14 this detector keyed off `resistance` — which is by definition the nearest swing high *above* price — so it fired on stocks merely *approaching* a ceiling and backtested at 23.2%; the current definition backtests at 38.3% over the same 288-ticker history. Setups detected before that date pool both definitions, and `/performance` says so.)

**Risk management.** Position sizing from account value and risk-per-trade, concentration caps (with account-level position-weight **and sector-weight** alerts — sectors are auto-backfilled from Yahoo and shown as a weights strip on the Portfolio page), stop-loss/drawdown warnings, an earnings-proximity guard, and an alerts feed. A **pre-trade risk gate** runs on both order placement and manual trade logging: a missing stop, a risk/reward below your configured minimum, or an entry inside your earnings-avoidance window returns the specific problems, and the trade only proceeds after you explicitly acknowledge them — a speed bump, never a hard block. The order dialog also shows **stop distance as a multiple of ATR(14)** and warns in amber below 1× — a stop tighter than one average day's range is likely to be hit by ordinary volatility rather than by the thesis breaking. Advisory only: sizing stays your call and the server gate is unchanged. A configurable risk profile (conservative/balanced/aggressive) tunes the thresholds. Alerts can also **reach you outside the app**: enable notifications in Settings for native desktop notifications (macOS/Windows) and/or push to your phone via an [ntfy](https://ntfy.sh) topic, gated by a minimum severity (default: critical only) — with a "send test notification" button to verify the wiring. An opt-in **daily morning brief** condenses the day's state (market regime, earnings inside your avoid window, trades flagged Exit/Trim, buy-zone hits, fresh quality setups) into one message after the 08:00 maintenance refresh.

**Portfolio history.** Every refresh upserts one `portfolio_snapshots` row per calendar day (holdings value plus any open-trade exposure the holdings table doesn't already carry), and the Portfolio page draws the resulting **account-value equity curve** with SPY rebased to the same start for comparison. Real data only: the curve starts accumulating the day the feature ships and is labelled with its day count so a short history is never over-read.

**Discovery agent ("Agent Picks").** Scans a universe of liquid stocks, scores each with the same engine, and proposes any that clear a configurable score test. You **Accept** (promoted to your watchlist with a suggested buy zone) or **Decline** — it never edits your watchlist on its own.

**Sector Scout — industry-targeted discovery (at `/sector-scout`).** Type a free-form industry or theme ("space", "energy", "nuclear fusion", "cybersecurity") and the scout does the legwork: it **expands** the theme into real, US-listed tickers (LLM-assisted when an Anthropic key is configured, a curated theme map otherwise), **validates** each against live price/bar data (anything without real data is dropped, never guessed), **scores** the survivors with the same five-component engine, and writes a full **bull/bear/risk research brief** (LLM or rule-based) for every name that clears your minimum score. Results are grouped by the industry you ran, each with a score, suggested buy zone, and brief; you **Add to watchlist** or **Dismiss** per pick — like Agent Picks, it never edits your watchlist on its own. The expansion prompt biases toward pure-plays (companies whose core business *is* the theme) over incidental mega-cap exposure; the LLM list is still a starting point and may include tangential or even invalid names, so every symbol is validated against real price data and every pick is clearly labelled and meant to be reviewed. You can also save **favorite industries** and turn on **scheduled auto-scan** (Settings) so the daily job re-scans them and keeps their picks fresh.

**Signal Performance — "does any of this actually work?" (at `/performance`).** A backtest of the app's *own* output, in four parts. **(1) Score calibration:** the app keeps a daily time-series of every score it has produced — one `stock_scores` row per ticker per day, plus an extra row whenever a score moves materially intraday; this turns each into an event and **reuses the Catalyst Edge event-study engine** to measure that ticker's forward return vs SPY over the next 1 / 5 / 20 trading days, pooled **by recommendation band** — if the score is calibrated, higher bands show higher forward abnormal returns (a one-line verdict reads *improves / mixed / inverts*). **(2) Pick performance:** the same event study applied to Agent Picks and Sector Scout picks, pooled by source, so you can see how the names each one surfaces actually moved after being proposed. **(3) Realized trades:** settled stats over your closed trades — win rate, avg return, **avg R-multiple** (vs the initial entry→stop risk), profit factor, avg hold, and thesis-played-out rate — which need no window maturity and are useful immediately. Thesis-played-out is recorded on the close-trade form (yes / no / not recorded). A trade can be flagged **excluded from stats** (`excluded_from_stats`) when it was not a genuine exit decision — five trades batch-closed during development on 2026-06-25 are flagged this way; the rows are kept in full, they are simply left out of the realized figures so those describe the strategy rather than the cleanup. **(4) Setup outcomes:** whether detected swing setups reached their target before their stop, walked forward bar by bar into win / loss / expired / no-fill with an average R per setup type. A **date-range slider** at the top filters all four sections at once (drag either handle, or use the 7d / 30d / 90d / All presets) — scores, picks and setups by the day the call was made, trades by the day they closed. The backtest stores its per-event rows alongside the pooled figures, so the slider re-pools them instantly in the browser through the same aggregators rather than re-running the backtest; at the full range it shows the stored figures untouched. It de-duplicates score/pick events to one per ticker per day, benchmarks against a forward-refreshed SPY, and explains when there isn't yet enough matured data. Historical correlation across past calls — not a prediction, not advice.

**Catalyst Edge — real-world events as an event study.** The newest pillar (at `/events`). It records who (an *entity* — a public figure or executive, or a company for its own filing) said something about which ticker, and when, then quantifies the historical price relationship. See the dedicated section below.

**Catalyst Research Universe.** A curated reference catalog (at `/universe`) of *who/what/where* to watch for market-moving catalysts: 55 ranked influential people & organizations, 35 recurring/notable market-moving events, and 60 high-signal news/filing/data sources — each with category, affected tickers, a real impact example, monitoring channels, search queries, and bias/limitations. It also bundles ~30 recommended monitoring queries (grouped by theme) and a usage playbook. The data is searchable and section-filterable in the dashboard, and its monitoring queries can be applied to GDELT event ingestion with one click so the universe actually drives Catalyst Edge. This is static reference data (parsed from a source report), not seeded trading data — it never touches your database.

**Earnings surprise (beat / meet / miss).** Records quarterly results (analyst estimate vs. actual EPS) per ticker and weighs the surprise into the stock score as a **bounded, monotonic nudge** — a beat only helps, a miss only hurts, in-line/none does nothing; magnitude scales with the surprise size and decays with recency (ignored past the freshness window). Data comes in via a "Fetch from Yahoo" button (and a daily scheduler job) that pulls the last ~4 quarters from Yahoo's `quoteSummary` API through the browser connector, or via a manual "Log earnings result" form. Shown on the per-stock page with a beat/meet/miss table.

**Research briefs.** Per-stock bull/bear/risk briefs, LLM-generated when an Anthropic key is configured and rule-based otherwise — same shape either way.

**Operational trust.** A header badge shows whether the background job runner is alive ("Jobs 2m ago", red when the heartbeat stops), and `/status` shows integrations health, per-job last runs, database size and row counts, per-ticker price-bar coverage, and backups. Scores and drawdown metrics are written as **one live row per ticker per UTC day, updated in place** rather than appended on every ~2-minute refresh (a score that moves materially still gets its own row, so intraday moves are never lost) — before this the database grew ~13 MB per market day to record a few dozen real changes. Daily maintenance prunes the remaining append-only tables (snapshots, drawdowns, score history; stock scores and drawdowns older than two days are thinned to one per ticker/day, never truncated — Signal Performance replays them), re-runs the Signal Performance backtest so its cached report never goes stale, and writes a daily `VACUUM INTO` backup to `data/backups/` (keeps 7). The watchlist supports **bulk import**: paste a comma/newline ticker list and each symbol is validated against real market data before it's added with a suggested buy zone.

## Catalyst Edge (event study + ingestion + scoring loop)

The motivating question: *"When a given person talks about a stock, how does that stock tend to move — measured across every other stock that person has talked about?"* Catalyst Edge answers it in three connected stages.

**1. Event study (the math).** For a chosen entity, each of its mentions is turned into before/after returns over trading-day windows (`[-5,0]`, `[0,+1]`, `[0,+5]`, `[0,+20]`). For each window the stock's return is compared against SPY over the *same* calendar window to get the **abnormal return** (stock − market). Results are pooled across all of that entity's prior mentions into a mean abnormal return, hit rate, standard deviation, and a t-stat significance proxy. Historical bars are backfilled on demand so old event dates work. The pure math is fully unit-tested and never throws — missing data yields nulls, not crashes.

**2. Ingestion (getting events in).** Mentions can be entered by hand or ingested automatically from configurable sources: **SEC EDGAR** 8-K filings (free/official, on by default), **GDELT** news coverage of public-figure statements, and **company IR RSS** feeds. A cheap, batched LLM call (Haiku) extracts structured `{ entity, ticker, claim, direction }` events, with a deterministic rule-based fallback when no LLM key is set. Company names resolve to tickers against a known universe **augmented with the companies you track** (so news about smaller names you follow isn't dropped), and SEC filers additionally resolve **by CIK** against SEC's official `company_tickers.json` map — so 8-K filings from companies outside the curated name set still map to a real symbol (unresolved items are still skipped, never guessed); results are de-duplicated before storage. To make GDELT useful out of the box, its search queries are **auto-derived from the companies you track** (no hand-written queries needed), and missing company names are **backfilled from SEC's ticker→name map** (also shown in the UI). Every run — manual or scheduled — is logged and shown as a *Recent ingestion runs* summary on the Events page. Social platforms (X / Truth Social) are **not** scraped directly — news coverage of those statements is ingested instead.

**3. Scoring loop (closing the loop).** "Apply edge to scoring" turns each entity's measured edge into catalysts on the tickers it has mentioned: impact is scaled by the historical 5-day effect size and confidence by the sample size, with the magnitude halved when a mention's stated direction contradicts the measured tendency (an interpretable contrarian signal). Those catalysts flow through the normal `getCatalystInputs → scoreStock` path, so the edge shows up in the blended stock score, the catalysts view, and the Agent Picks rationale — always displayed with the sample size and a "historical correlation, not advice or a prediction" caveat.

## Quick start

```bash
npm install
npx playwright install chromium   # optional: browser fallback + Yahoo news scan
cp .env.example .env              # add Alpaca + (optional) Anthropic keys
npm run dev                       # dashboard at http://localhost:3000
npm run jobs                      # (separate terminal) background scheduler
```

Without any API keys the app still runs: manual entry works everywhere, scores degrade to neutral/low-confidence, and the UI flags missing data. Alpaca enables price history, indicators, setups, and portfolio sync; an Anthropic key upgrades research briefs and event extraction from rule-based to LLM-generated. The app uses only real data you bring in — there is no need to seed it.

### Getting real data in

Data is pulled on demand and on a schedule — nothing is fabricated:

1. Add tickers to your **Watchlist** (or sync your Alpaca portfolio). Only tracked tickers are refreshed.
2. Click **Refresh data** to pull live quotes, daily bars, and recompute scores/setups. Requires `npm run dev`.
3. Run `npm run jobs` in a second terminal for continuous, market-aware updates (refresh cadence, catalyst scan, daily maintenance including discovery, event ingestion, and the edge loop when enabled).
4. On **Agent Picks**, click **Run agent scan**; on **Catalyst Edge**, add mentions or click **Run ingestion**, then **Apply edge to scoring**.

## Configuration

**Secrets (`.env`, never sent to the frontend):** `ALPACA_API_KEY` / `ALPACA_API_SECRET`, `ALPACA_MODE` (`paper`|`live`), `YAHOO_BROWSER_ENABLED`, `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `LLM_MODEL`, `DATABASE_PATH`. Optional: `SEC_USER_AGENT` (identify your client to SEC EDGAR) and `LLM_MODEL_EXTRACTION` (override the Haiku model used for event extraction).

**Editable settings (stored in the DB, on the Settings page):** risk profile, risk-per-trade, R/R minimum, concentration caps, warning thresholds, earnings-avoidance window, refresh cadences, the Yahoo connector toggle, the Agent Picks minimum score, the event-ingestion controls (master switch, per-source toggles, item cap, minimum extraction confidence), the Sector Scout auto-scan toggle + favorite-industries list, and alert notifications (master switch, minimum severity, ntfy topic — `NTFY_SERVER` env overrides the server for self-hosting).

## Security & data

This is a **single-user, localhost tool** — it has no authentication or CSRF protection, by design. Run it only on your own machine and do not expose the dev/prod server to a network you don't trust: anyone who can reach the port can read your data and (if Alpaca is configured) **place orders**.

- **Secrets** live only in `.env` (server-side). They are never bundled into client code or returned by the API — the frontend only ever learns *whether* an integration is configured, never the key. `.env` and the SQLite database (`data/*.db*`) are git-ignored.
- **Order placement** is always user-initiated (you open the trade dialog and submit) and defaults to Alpaca **paper** mode. A **live** account requires an explicit per-order confirmation, enforced both in the UI and server-side in `POST /api/trades/place`.
- **Stop-coverage reconciliation.** The app records the stop it *intended* for each trade, but only the broker knows what protection actually exists — and those drift apart (bracket legs are cancelled by design when their sibling fills, `day` orders expire at the close, and brokers occasionally cancel resting orders outright). Every refresh compares each open trade's recorded stop against the orders actually working at the broker and raises a **critical** alert for any position with no live stop (a warning when the trade never had a stop recorded). Orders resting in `held` count as protection; if the broker can't be read, nothing is reported as unprotected, so a network blip never triggers a false "your position is naked" alarm. Gaps show as a ⚠ on the stock page with a **Restore stop** button that re-places the recorded stop as a GTC order — user-initiated, like every other order the app sends.
- **Exiting a position.** Each stock page shows **your open trades in that name** (entry, current price, shares, stop, target, unrealized P&L, trade score and action) with an **Exit** button per trade, and `/portfolio` has one per holding. Exit is a real broker action, so it is two-step: the first click arms a confirmation naming exactly what will be sold. Because trades placed with a stop and/or target are **bracket** orders whose legs rest at the broker against the same shares, an exit *cancels those legs first*, then sells at market, waits for a genuine fill, and records the close at the **actual fill price** — it will not close a trade on an unfilled order. Exits are refused while the market is closed (a market order would queue unfilled and leave the position unprotected overnight with its legs already cancelled). If the legs are cancelled and the sell then fails, the protective stop is **re-placed** and a critical alert is raised. A live account still requires the same explicit confirmation that order placement enforces. Note that holdings and tracked trades are different sets — exiting a holding with no trade record simply sells it and lets the next portfolio sync reconcile.
- **Order-fill sync.** A placed order logs the trade immediately with the *intended* entry; the scheduler (and every manual refresh) then polls the Alpaca order until it reaches a terminal state — correcting the trade's entry price/size to the **actual fill** (partial fills included), marking trades whose orders were canceled/expired/rejected unfilled as `canceled` (so phantom trades never pollute open positions or realized stats), and flagging orders replaced outside the app. Filled bracket parents keep being watched: when a **stop-loss or take-profit leg fills, the trade is auto-closed at the leg's actual fill price** and its journal entry is pre-filled with the exit. Each correction/close raises an alert, and unfilled orders are labelled on the Swing Trading page.
- **All API inputs are validated** with `zod`, and all database access goes through Drizzle (parameterized — no string-built SQL). External content (SEC/GDELT/IR feeds, Yahoo pages) is treated as untrusted: it's parsed defensively, network calls are time-boxed, and LLM-extracted tickers are resolved against a known universe (unresolved items are skipped, never guessed).
- The app uses only **real data you bring in**; it never fabricates rows. See the no-seed note below.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run jobs` | background scheduler (market-aware refresh + due-check-driven catalyst scan and daily maintenance incl. retention, backtest, backup) |
| `npm run watchdog` | one heartbeat check; notifies if the job runner is down — normally run by the watchdog task |
| `npm test` | vitest suite (pure logic + in-memory-SQLite persistence tests — 564 tests) |
| `npm run typecheck` | strict TypeScript check (`noUnusedLocals` + `noUnusedParameters`) — **the real type gate**, since `next build` skips type-checking (see `next.config.ts`) |
| `npm start` | production server — **5–8× faster per page than `npm run dev`**; use it when using the app rather than developing it |
| `npm run db:generate` | generate a SQL migration in `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:restore -- <file>` | restore the database from a `data/backups/` file (see below); snapshots the current DB first |
| `npm run db:seed` | optional demo data — not required; the app is designed to run on your real data |
| `scripts/install-jobs-task.ps1` | (Windows, opt-in) register a Scheduled Task so `npm run jobs` starts at logon and restarts on failure; `uninstall-jobs-task.ps1` removes it |
| `scripts/install-watchdog-task.ps1` | (Windows, opt-in) register a task that runs the watchdog every 30 min; `uninstall-watchdog-task.ps1` removes it |
| `scripts/install-wake-task.ps1` | (Windows, opt-in) wake the machine before the US market open and hold it awake through the session; `uninstall-wake-task.ps1` removes it |

### Keeping the scheduler running (Windows)

`npm run jobs` normally lives and dies with its terminal, so a reboot silently
stops the background refreshes and daily maintenance until you notice the header
badge go red. To keep it running unattended, register it as a Scheduled Task
(opt-in — nothing installs it for you):

```powershell
# from the project root, in PowerShell
scripts\install-jobs-task.ps1 -StartNow   # register + start: runs `npm run jobs` at logon, hidden, restarts on failure
scripts\stop-jobs-task.ps1                # stop it (it starts again at next logon)
scripts\uninstall-jobs-task.ps1           # remove it
```

Output is appended to `data/logs/jobs.log` (git-ignored). The task runs
hidden — there is no console window to close by accident. Stop it with
`scripts\stop-jobs-task.ps1`, not bare `Stop-ScheduledTask`: stopping the
task only kills the hidden launcher, and the npm/node tree underneath
keeps running as an orphan (observed live); the stop script also
terminates the scheduler process recorded in `data/jobs.lock`. That lock
is the single-instance guard — an ad-hoc `npm run jobs` terminal and the
task can never run two schedulers against the same database; whichever
starts second exits immediately with a message.

### Knowing when the scheduler dies

The header badge and /status only help while you're looking at the app. The
opt-in **watchdog task** watches from outside it: every 30 minutes it checks
the scheduler heartbeat in the database and, if it's more than 10 minutes
old, sends a desktop toast (plus ntfy push, if you configured a topic in
Settings) — one alert per outage, repeated every 6 hours while it stays down.

    scripts\install-watchdog-task.ps1      # register (runs `npm run watchdog` every 30 min)
    scripts\uninstall-watchdog-task.ps1    # remove it

### Not sleeping through market hours (Windows, opt-in)

The runner is only *suspended* while the laptop sleeps, so a machine asleep
during market hours does nothing — no refreshes, no catalyst scan, no watchdog
(that shares the machine). If you don't leave the machine on, register the
**wake task**: it fires on weekdays with `-WakeToRun` to wake the machine
before the open, then holds it awake until just after the close (16:00 ET,
computed DST-correctly for your local clock) and releases. The hold is a
transient `SetThreadExecutionState` assertion — it makes no permanent power-plan
changes, and the runner resumes on its own once the system is awake.

    scripts\install-wake-task.ps1          # register (default wake 03:10 local; pass -WakeAt "HH:mm" to change)
    scripts\uninstall-wake-task.ps1        # remove it

Two OS-level dependencies `-WakeToRun` can't override, so check them or the
wake won't fire: **"Allow wake timers"** must be on in the active power plan,
and **closing the lid** can still force sleep — leave it open (or set "do
nothing" on lid close) during market hours. Logs to `data/logs/wake.log`.

### Restoring a backup

Daily maintenance writes a `VACUUM INTO` snapshot to `data/backups/` (keeps 7).
To roll back to one:

```bash
# 1. Stop the app first — restore refuses while the database is open.
#    (Ctrl+C the `npm run dev` and `npm run jobs` terminals.)
# 2. List backups and restore one (a bare filename resolves in data/backups/):
npm run db:restore                                  # prints available backups
npm run db:restore -- finance-agent-2026-07-05.db   # restore that day's copy
# 3. Start the app again — it applies any newer migrations to the restored file on open.
npm run dev
```

Before swapping the file in, the restore saves your *current* database to
`data/backups/pre-restore-<timestamp>.db`, so a restore is always reversible.
Restoring a backup taken before a schema change is safe: the app replays any
newer migrations automatically the next time it opens the database.

## Architecture

- **`src/services/*`** — the engine. Market data & orchestration (`marketData`, `alpaca`, `yahooHttp` — Yahoo JSON endpoints over plain HTTP, `yahooFinanceBrowser` — the headless fallback + news scan, `orderSync` — broker fill reconciliation & bracket-leg auto-close, `trades` — the shared close-trade write), analytics (`indicators`, `buyZone`, `scoring`, `tradeScoring`, `setupDetection`, `riskManagement`), catalysts & research (`catalysts`, `researchAgent`, `alerts`, `llm` — the shared LLM-provider plumbing every LLM-optional feature goes through), discovery (`discoveryAgent`, `sectorScout` — industry-targeted scan: LLM/curated theme→ticker expansion, validation, scoring, and per-pick briefs; `companyThesisScout` — evidence-backed company-claim validation behind Sector Scout's thesis scores; `portfolioRecommendations` — holdings → watchlist suggestions; `companyNames` — SEC ticker→name backfill; `watchlist` — the shared promote-to-watchlist write), signal-performance backtest (`signalPerformance` — reuses the event-study engine to calibrate the app's own scores by band and picks by source; `tradePerformance` — realized stats over closed trades), earnings surprise (`earnings` — model, calibrated surprise→impact mapping, Yahoo fetch), the Catalyst Edge stack: `eventStudy` (pure math), `entityMentions` (CRUD + per-entity analysis with bar backfill), `eventExtraction` (Haiku + rule-based fallback), `eventIngestion` (sources → extract → dedupe → persist), `catalystEdge` (edge → catalysts → scoring), and `sources/*` (SEC EDGAR, GDELT, IR RSS connectors, feed parsers, company→ticker map, and SEC CIK→ticker map), and the ops layer (`jobHealth` — scheduler heartbeats, `notifications` — desktop/ntfy push, `retention` — append-only table pruning, `backup` — daily VACUUM INTO, `status` — the /status report, `watchlistImport` — validated bulk import).
- **`src/db/*`** — Drizzle schema (the single source of truth; `npm run db:generate` emits SQL migrations into `drizzle/`, applied on open; pre-migration databases are baselined automatically via the frozen `legacyBaseline.ts`). Tables include portfolio holdings, watchlist, price bars, snapshots, drawdowns, catalysts, stock/trade scores, setups, journal, alerts, app settings, agent candidates, `entity_mentions`, the event-ingestion run log (`ingestion_runs`), the Sector Scout run log + picks (`sector_scans`, `sector_scout_picks`), and the scheduler heartbeat (`job_runs`).
- **`src/app/*`** — App-Router pages (Summary, Portfolio, Watchlist, Agent Picks, Sector Scout, Signal Performance, Swing Trading, Catalysts, Catalyst Edge, Research Universe, Status, Settings, per-stock detail) and the JSON API routes behind them.
- **`src/data/*`** + **`src/lib/catalystUniverse.ts`** — the Catalyst Research Universe dataset (`catalystUniverse.json`) and its typed loader/helpers. The JSON is produced from the source HTML report by `scripts/parseUniverse.ts` (re-run if the report changes).
- **`src/lib/*`** — config, shared types, read-side query helpers, and formatting utilities.
- **`src/jobs/scheduler.ts`** — the standalone background runner.
- **`src/services/__tests__/*`** — vitest suite: pure logic plus write-path persistence tests against in-memory SQLite (`dbHarness.ts`).

## Testing

`npm run typecheck` (strict) and `npm test` (the vitest suite — count in the Commands table) both run clean. Most of the suite is pure logic — scoring, buy zones, risk math, exits, indicator/feed parsers, the event-study windows and aggregation, ticker resolution, LLM-response parsing with fallbacks, the edge-impact mapping, order-sync planning (including bracket-leg auto-close), Yahoo JSON-endpoint mappers, notification gating, `mapPool` — using synthetic fixtures with no network. The persistence layer is covered by an in-memory-SQLite harness (`DATABASE_PATH=":memory:"` + a per-test reset) exercising the real write paths: watchlist upserts, alert dedupe, trade close + journal pre-fill, job heartbeats, retention pruning, the live-row score/drawdown writes (in-place refresh vs. a new row on a day rollover or a material move), and config round-trips.

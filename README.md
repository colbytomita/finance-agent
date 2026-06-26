# Finance Agent

A market-research and swing-trading **decision-support** dashboard. It tracks your portfolio, watchlist, and active trades; pulls live prices and daily bars; scores stocks and trades on a 1–10 scale with plain-language explanations; detects swing setups; watches drawdowns, buy zones, and catalysts; discovers new candidates; and measures the historical price relationship between real-world events and the stocks they reference.

It is **decision support, not an autopilot** — it never trades on its own and never guarantees returns, labels every model-generated interpretation as such, and timestamps all data with a staleness warning. It can place an order through your Alpaca account, but only when you open the trade dialog, set the size, and confirm — paper by default, with an explicit extra confirmation required for a live (real-money) account. Built with Next.js 16 (App Router) · TypeScript (strict) · React 19 · Tailwind v4 · `better-sqlite3` + `drizzle-orm` · `zod` · `node-cron` · Playwright.

## What's in it

**Market data & scoring.** Live quotes come from Alpaca (regular session) and a headless-Chromium Yahoo Finance connector (pre/after-hours). Daily OHLCV bars feed an indicator engine (SMA/EMA/RSI/MACD/ATR/VWAP, support/resistance, relative volume). Each stock gets a blended 1–10 score from five components — valuation, momentum, catalyst, risk, sentiment — and a recommendation (**Strong Buy Candidate → Strong Avoid**); open trades get their own 1–10 score and an **Enter / Wait / Hold / Add / Trim / Exit / Avoid** action. Every score ships with the reasons behind it, so you can answer "why did this change?". When a ticker has **no current catalysts**, the catalyst and sentiment components are excluded from the blend (their weight is redistributed) so missing data doesn't drag the score toward neutral — the `confidence` field still reflects the data gap. Catalysts also age out after a freshness window (`catalystFreshnessDays`, default 90) so stale events stop counting as current drivers.

**Buy zones & setups.** Tracks drawdown from 52-week and 30-day highs, evaluates configurable buy zones (target range, reinvest-above, max-risk), and detects swing setups (pullback-to-support, breakout, oversold bounce, etc.) with entry/stop/target levels and risk-reward.

**Risk management.** Position sizing from account value and risk-per-trade, concentration caps, stop-loss/drawdown warnings, an earnings-proximity guard, and an alerts feed. A configurable risk profile (conservative/balanced/aggressive) tunes the thresholds.

**Discovery agent ("Agent Picks").** Scans a universe of liquid stocks, scores each with the same engine, and proposes any that clear a configurable score test. You **Accept** (promoted to your watchlist with a suggested buy zone) or **Decline** — it never edits your watchlist on its own.

**Catalyst Edge — real-world events as an event study.** The newest pillar (at `/events`). It records who (an *entity* — a public figure or executive, or a company for its own filing) said something about which ticker, and when, then quantifies the historical price relationship. See the dedicated section below.

**Catalyst Research Universe.** A curated reference catalog (at `/universe`) of *who/what/where* to watch for market-moving catalysts: 55 ranked influential people & organizations, 35 recurring/notable market-moving events, and 60 high-signal news/filing/data sources — each with category, affected tickers, a real impact example, monitoring channels, search queries, and bias/limitations. It also bundles ~30 recommended monitoring queries (grouped by theme) and a usage playbook. The data is searchable and section-filterable in the dashboard, and its monitoring queries can be applied to GDELT event ingestion with one click so the universe actually drives Catalyst Edge. This is static reference data (parsed from a source report), not seeded trading data — it never touches your database.

**Earnings surprise (beat / meet / miss).** Records quarterly results (analyst estimate vs. actual EPS) per ticker and weighs the surprise into the stock score as a **bounded, monotonic nudge** — a beat only helps, a miss only hurts, in-line/none does nothing; magnitude scales with the surprise size and decays with recency (ignored past the freshness window). Data comes in via a "Fetch from Yahoo" button (and a daily scheduler job) that pulls the last ~4 quarters from Yahoo's `quoteSummary` API through the browser connector, or via a manual "Log earnings result" form. Shown on the per-stock page with a beat/meet/miss table.

**Research briefs.** Per-stock bull/bear/risk briefs, LLM-generated when an Anthropic key is configured and rule-based otherwise — same shape either way.

## Catalyst Edge (event study + ingestion + scoring loop)

The motivating question: *"When a given person talks about a stock, how does that stock tend to move — measured across every other stock that person has talked about?"* Catalyst Edge answers it in three connected stages.

**1. Event study (the math).** For a chosen entity, each of its mentions is turned into before/after returns over trading-day windows (`[-5,0]`, `[0,+1]`, `[0,+5]`, `[0,+20]`). For each window the stock's return is compared against SPY over the *same* calendar window to get the **abnormal return** (stock − market). Results are pooled across all of that entity's prior mentions into a mean abnormal return, hit rate, standard deviation, and a t-stat significance proxy. Historical bars are backfilled on demand so old event dates work. The pure math is fully unit-tested and never throws — missing data yields nulls, not crashes.

**2. Ingestion (getting events in).** Mentions can be entered by hand or ingested automatically from configurable sources: **SEC EDGAR** 8-K filings (free/official, on by default), **GDELT** news coverage of public-figure statements, and **company IR RSS** feeds. A cheap, batched LLM call (Haiku) extracts structured `{ entity, ticker, claim, direction }` events, with a deterministic rule-based fallback when no LLM key is set. Company names resolve to tickers against a known universe, and SEC filers additionally resolve **by CIK** against SEC's official `company_tickers.json` map — so 8-K filings from companies outside the curated name set still map to a real symbol (unresolved items are still skipped, never guessed); results are de-duplicated before storage. Social platforms (X / Truth Social) are **not** scraped directly — news coverage of those statements is ingested instead.

**3. Scoring loop (closing the loop).** "Apply edge to scoring" turns each entity's measured edge into catalysts on the tickers it has mentioned: impact is scaled by the historical 5-day effect size and confidence by the sample size, with the magnitude halved when a mention's stated direction contradicts the measured tendency (an interpretable contrarian signal). Those catalysts flow through the normal `getCatalystInputs → scoreStock` path, so the edge shows up in the blended stock score, the catalysts view, and the Agent Picks rationale — always displayed with the sample size and a "historical correlation, not advice or a prediction" caveat.

## Quick start

```bash
npm install
npx playwright install chromium   # for the Yahoo Finance pre/after-hours connector
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

**Editable settings (stored in the DB, on the Settings page):** risk profile, risk-per-trade, R/R minimum, concentration caps, warning thresholds, earnings-avoidance window, refresh cadences, the Yahoo connector toggle, the Agent Picks minimum score, and the event-ingestion controls (master switch, per-source toggles, item cap, minimum extraction confidence).

## Security & data

This is a **single-user, localhost tool** — it has no authentication or CSRF protection, by design. Run it only on your own machine and do not expose the dev/prod server to a network you don't trust: anyone who can reach the port can read your data and (if Alpaca is configured) **place orders**.

- **Secrets** live only in `.env` (server-side). They are never bundled into client code or returned by the API — the frontend only ever learns *whether* an integration is configured, never the key. `.env` and the SQLite database (`data/*.db*`) are git-ignored.
- **Order placement** is always user-initiated (you open the trade dialog and submit) and defaults to Alpaca **paper** mode. A **live** account requires an explicit per-order confirmation, enforced both in the UI and server-side in `POST /api/trades/place`.
- **All API inputs are validated** with `zod`, and all database access goes through Drizzle (parameterized — no string-built SQL). External content (SEC/GDELT/IR feeds, Yahoo pages) is treated as untrusted: it's parsed defensively, network calls are time-boxed, and LLM-extracted tickers are resolved against a known universe (unresolved items are skipped, never guessed).
- The app uses only **real data you bring in**; it never fabricates rows. See the no-seed note below.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run jobs` | cron scheduler (market-aware refresh, catalyst scan, daily maintenance) |
| `npm test` | vitest suite (scoring, buy zones, risk, exits, parsers, event study, ingestion, edge, research universe, earnings, CIK resolution — 210 tests) |
| `npm run typecheck` | strict TypeScript check |
| `npm run db:seed` | optional demo data — not required; the app is designed to run on your real data |

## Architecture

- **`src/services/*`** — the engine. Market data & orchestration (`marketData`, `alpaca`, `yahooFinanceBrowser`), analytics (`indicators`, `buyZone`, `scoring`, `tradeScoring`, `setupDetection`, `riskManagement`), catalysts & research (`catalysts`, `researchAgent`, `alerts`), discovery (`discoveryAgent`), earnings surprise (`earnings` — model, calibrated surprise→impact mapping, Yahoo fetch), and the Catalyst Edge stack: `eventStudy` (pure math), `entityMentions` (CRUD + per-entity analysis with bar backfill), `eventExtraction` (Haiku + rule-based fallback), `eventIngestion` (sources → extract → dedupe → persist), `catalystEdge` (edge → catalysts → scoring), and `sources/*` (SEC EDGAR, GDELT, IR RSS connectors, feed parsers, company→ticker map, and SEC CIK→ticker map).
- **`src/db/*`** — Drizzle schema + SQLite DDL (Postgres-ready). Tables include portfolio holdings, watchlist, price bars, snapshots, drawdowns, catalysts, stock/trade scores, setups, journal, alerts, app settings, agent candidates, and `entity_mentions`.
- **`src/app/*`** — App-Router pages (Summary, Portfolio, Watchlist, Agent Picks, Swing Trading, Catalysts, Catalyst Edge, Research Universe, Settings, per-stock detail) and the JSON API routes behind them.
- **`src/data/*`** + **`src/lib/catalystUniverse.ts`** — the Catalyst Research Universe dataset (`catalystUniverse.json`) and its typed loader/helpers. The JSON is produced from the source HTML report by `scripts/parseUniverse.ts` (re-run if the report changes).
- **`src/lib/*`** — config, shared types, read-side query helpers, and formatting utilities.
- **`src/jobs/scheduler.ts`** — the standalone background runner.
- **`src/services/__tests__/*`** — pure-function vitest suite.

## Testing

`npm run typecheck` (strict) and `npm test` (210 vitest tests) both run clean. The test suite focuses on pure logic — scoring, buy zones, risk math, exits, indicator/feed parsers, the event-study windows and aggregation, ticker resolution, LLM-response parsing with fallbacks, the edge-impact mapping, and the research-universe dataset shape — using synthetic fixtures so no network or database is required.

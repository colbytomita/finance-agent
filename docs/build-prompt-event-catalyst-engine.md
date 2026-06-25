# BUILD PROMPT — Real-world event ingestion + event-study (“catalyst edge”) engine

> **How to use this file.** Open a fresh Claude Code session in this repo
> (`C:\Projects\finance-agent`) — ideally with **Claude Fable 5** — and either paste
> the entire contents of this file as your message, or say:
> *“Read `docs/build-prompt-event-catalyst-engine.md` in full and build it, starting with Phase 1.”*
> The agent should **read the referenced source files before writing any code** — the code is
> the source of truth; the signatures quoted here may have drifted.

You are extending an existing app. Do not start from scratch. Follow the existing patterns exactly.

---

## 0. One-paragraph goal

The user wants the app to ingest and analyze **real-world events and releases** as potential trading
catalysts — for example, a CEO commenting on another industry, or a public figure (e.g. a politician)
mentioning a specific stock — and, crucially, to **quantify the historical price relationship**: when a
given person/entity mentions a given ticker, measure how that ticker moved *before* and *after* the
statement, pooled across **all of that entity’s prior mentions**, and benchmarked against the market
(SPY). The motivating example: “When Trump talks about a stock, look back at every other stock he has
talked about, and measure the price before vs. after he talked about it, to see if there’s a repeatable
relationship.” These event-driven catalysts must live **alongside** the existing market-research catalysts
and stock-data signals, and feed the app’s scoring and the “Agent Picks” discovery feature.

This is legitimate market-research / decision-support on **public information** (an “event study”). It is
**not** investment advice, insider trading, or manipulation. Preserve the app’s existing safety framing
everywhere (see §3).

---

## 1. Project context (what this app is)

- **finance-agent** — a market-research and swing-trading **decision-support** dashboard.
- **Stack:** Next.js 16 (App Router, Turbopack) · TypeScript (strict) · React 19 · Tailwind CSS v4 ·
  `better-sqlite3` + `drizzle-orm` · `zod` · `node-cron` · `playwright` (headless Chromium for Yahoo).
- **Database:** local SQLite at `./data/finance-agent.db` (path from `DATABASE_PATH`). It currently holds
  **no demo data** by design — the user wiped it and does **not** want demo/seed data (do **not** run
  `npm run db:seed`, do not insert placeholder rows).
- **Environment:** Windows 11. Shells available: PowerShell (primary) and Git Bash. Dev server is
  `npm run dev` on **http://localhost:3000**. Background jobs: `npm run jobs`. Tests: `npm test`
  (vitest). Typecheck: `npm run typecheck`.
- **.env keys already configured:** `ALPACA_API_KEY` / `ALPACA_API_SECRET` (paper mode), `ALPACA_MODE`,
  `YAHOO_BROWSER_ENABLED`, `LLM_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `LLM_MODEL`
  (currently `claude-sonnet-4-6` — **prefer `claude-haiku-4-5` for cheap extraction tasks**),
  `DATABASE_PATH`. The Yahoo connector needs `npx playwright install chromium` if not already installed.
- **Recent history (already on `main`):** a prior session added an “Agent Picks” discovery feature
  (`src/services/discoveryAgent.ts`, `/agent-watchlist`) and fixed an Alpaca bug where
  `getHistoricalBars` returned only one bar (it now sends a `start` date). Commit `df47c17`.

---

## 2. Read these files first (source of truth — read before coding)

| File | Why it matters |
|---|---|
| `src/db/schema.ts` | Drizzle table definitions. Note the `catalysts` table (and that it has **no speaker/entity field**), and the `agentCandidates` table added recently as a pattern to copy. |
| `src/db/index.ts` | `getDb()` singleton + the `DDL` string of `CREATE TABLE IF NOT EXISTS …`. **New tables must be added here AND in `schema.ts`.** |
| `src/lib/config.ts` | `AppConfig`, `DEFAULT_CONFIG`, `loadConfig()`, `saveConfig()`, `effectiveConfig()`. Config is stored in the DB (`app_settings`), not env. |
| `src/app/api/settings/route.ts` | Zod `settingsSchema` for editable config (must be updated for any new config key). |
| `src/app/settings/page.tsx` | `FIELDS` array that renders the settings form (must be updated for any new config key). |
| `src/services/catalysts.ts` | `classifyCatalyst()` (regex keyword classifier), `addCatalyst()` (auto-classify + persist), `scanYahooNews()` (current shallow news scrape), `rollCatalystStatuses()`. |
| `src/services/marketData.ts` | `getBars()`, `refreshBars()`, `getCatalystInputs()`, `recomputeTradeScores()` (note it already loads **SPY bars** as a market benchmark), `fullRefresh()`, `getTrackedTickers()`. |
| `src/services/alpaca.ts` | `AlpacaService.fromEnv()`, `getHistoricalBars(ticker, timeframe, limit)` (now sends `start`; returns bars **ascending** oldest→newest), `getSnapshot()`. |
| `src/services/indicators.ts` | `computeIndicators(bars)` and `IndicatorSnapshot`. Bars must be ascending. |
| `src/services/buyZone.ts` | `computeDrawdown(bars, price, avgCost?)` and `DrawdownReport`. |
| `src/services/scoring.ts` | `scoreStock()`, `catalystScore()`, `sentimentScore()`, `CatalystInput`, `DEFAULT_STOCK_WEIGHTS`, `combineStockScore()` (divides by weight sum — zeroing a weight excludes that component). |
| `src/services/researchAgent.ts` | `getProvider()` → `AnthropicProvider \| null`; `AnthropicProvider.complete(prompt, {maxTokens})`; `generateBrief()` shows the rule-based-fallback pattern. **Reuse `getProvider()`; always provide a rule-based fallback.** |
| `src/services/discoveryAgent.ts` | The most recent feature — copy its structure: pure testable core (`buildCandidate`), a scan orchestrator, DB persistence with `onConflictDoUpdate`, list/accept/decline, scheduler wiring. |
| `src/jobs/scheduler.ts` | `node-cron` schedules: per-minute refresh, 4-hourly catalyst scan, daily maintenance. Wire new scheduled work here. |
| `src/lib/queries.ts` | Read-side helpers for server components (`allCatalysts()`, `tickerBars()`, etc.). |
| `src/lib/format.ts` | `fmtMoney`, `fmtPct`, `fmtDateTime`, `fmtNum`, `freshness`. |
| `src/lib/types.ts` | `CatalystType`, `Confidence`, `ImpactDirection`, `MarketState`, `Bar`, etc. |
| `src/components/forms.tsx` | `useSubmit()` hook + `Collapsible` + the `Add*Form` / `DeleteButton` patterns (client components that POST then `router.refresh()`). |
| `src/components/badges.tsx` | `ScoreBadge`, `RecBadge`, `Pct`, `Freshness`. |
| `src/components/AgentPicks.tsx` | Client-component pattern for action buttons + a “run now” button. |
| `src/app/layout.tsx` | The `NAV` array — add new nav links here. The header brand is the user’s name (“Colby Tomita”); leave it. |
| `src/app/agent-watchlist/page.tsx` | Server-component page pattern (`export const dynamic = "force-dynamic"`). |
| `src/services/__tests__/helpers.ts` | `barsFromCloses()`, `trendCloses()`, `uptrendWithPullback()` for synthetic bars in tests. |
| `README.md` | High-level feature + commands overview. Update it when you add the feature. |

---

## 3. Conventions and gotchas you MUST follow

1. **Dual schema definition.** A new table must be added in **two** places: the Drizzle definition in
   `src/db/schema.ts` *and* the matching `CREATE TABLE IF NOT EXISTS` in the `DDL` string in
   `src/db/index.ts`. They must agree (snake_case columns in DDL, camelCase in Drizzle).
2. **Table creation requires a dev-server restart.** `getDb()` caches the connection and runs the DDL
   once per process. After adding a table, **restart `npm run dev`** (kill the process on port 3000 and
   relaunch) so the new table is created, then hit an endpoint to trigger `getDb()`.
3. **New config key = three edits.** Add it to `AppConfig` + `DEFAULT_CONFIG` (`src/lib/config.ts`), to the
   zod `settingsSchema` (`src/app/api/settings/route.ts`), and to the `FIELDS` array
   (`src/app/settings/page.tsx`).
4. **Alpaca bars.** `getHistoricalBars` sends a `start` date (do not remove it) and returns bars
   **ascending** (oldest first). `computeIndicators` / `computeDrawdown` expect ascending order. The free
   IEX feed (`feed=iex`) is used. `limit=400` ≈ ~1.5 years of trading days; for **older event dates** you
   will need a larger lookback — pass a bigger `limit` (and accordingly older `start`) so bars cover the
   event date minus your pre-window.
5. **Market benchmark.** SPY bars are the market control. `recomputeTradeScores()` already fetches
   `getBars("SPY")`; reuse the same approach for abnormal-return math.
6. **LLM usage.** Get the provider via `getProvider()` (returns `null` when no key) and **always provide a
   deterministic rule-based fallback** — every LLM touchpoint in this app degrades gracefully. Use the
   **`claude-haiku-4-5`** model for cheap extraction (construct `new AnthropicProvider(key, "claude-haiku-4-5")`
   or read from `LLM_MODEL`), and **batch** multiple items into one call (e.g. classify N headlines per
   request) to control cost. Prompt for **strict JSON** and parse defensively (match the `{…}` substring,
   `try/catch`, fall back on failure) exactly like `generateBrief()` does.
7. **API routes.** Use `NextResponse`, validate input with `zod`, return `{ error }` + status on failure.
   Long-running routes set `export const maxDuration = 300`. Pages that read the DB are server components
   with `export const dynamic = "force-dynamic"`. Client forms use the `useSubmit` pattern from
   `src/components/forms.tsx`.
8. **Reuse the catalyst pipeline.** `addCatalyst()` already auto-classifies and persists; prefer extending
   it over duplicating. The `catalysts` table fields: `ticker, industry, title, summary, sourceUrl,
   sourceName, catalystType, eventDate, discoveredAt, impactDirection, impactScore (-5..+5),
   confidence (low|medium|high), status (upcoming|occurred|expired), tags, affectsActiveTrade`.
9. **Tests.** The suite is pure-function vitest. Add tests for any new **pure** logic (especially the
   event-study math) using the synthetic-bar helpers. Run `npm run typecheck` and `npm test` — both must
   pass before you call the work done.
10. **Safety framing (non-negotiable).** This app is decision-support only. Label all model-generated and
    statistical output as **interpretation / historical correlation, not advice or prediction**. On any UI
    that shows the event-study “edge”, display the **sample size** and a caveat that past correlation does
    not guarantee a forward edge (small samples, selection bias, correlation ≠ causation). Keep the
    existing “Decision support only · Not financial advice · No auto-trading” framing.
11. **Git workflow.** The repo is on `main`. **Create a feature branch before committing.** Only commit or
    push **when the user explicitly asks**. End commit messages with:
    `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
12. **No demo data.** Do not run `npm run db:seed` or hardcode example rows into `src/db/seed.ts`. Any data
    used to *validate* the build should be added through the normal UI/API (see Phase 1 verification) and is
    the user’s real data, not committed seed data.

---

## 4. What the app ingests today (the gap you are closing)

- **Stock/market data:** Alpaca + Yahoo quotes, daily OHLCV bars, and everything derived (indicators,
  drawdowns, setups, scores).
- **News:** only `scanYahooNews()` — it scrapes the **Yahoo quote page** of each *tracked* ticker for up to
  five `<h3>` headlines and runs them through the **regex** `classifyCatalyst()`. Headline-only, regex-only,
  tracked-tickers-only.
- **It does NOT:** read article bodies; watch arbitrary sources (filings, press releases, transcripts,
  social/news coverage of public figures); understand *who* said something (no speaker/entity concept); or
  perform any historical/causal before-after analysis. **All of that is what you are building.**

---

## 5. The build — three phases

Build **Phase 1 first, fully, and verify it** before starting Phase 2. Pause and report after Phase 1.

### Phase 1 — Event-study engine (self-contained; no new external data feeds)

This is the highest-value, most tractable piece and needs only data the app already fetches.

**5.1 Data model.** Add an `entity_mentions` table (Drizzle in `schema.ts` + DDL in `index.ts`):
- `id` (pk autoincrement)
- `entity` (text, not null) — the speaker/source, e.g. `"Donald Trump"`, `"Jensen Huang"`
- `ticker` (text, not null) — the stock referenced
- `claim` (text) — short description of what was said
- `direction` (text) — `bullish | bearish | neutral | unknown`
- `eventDate` (text, ISO-8601, not null) — when the statement happened
- `sourceName` (text) · `sourceUrl` (text, nullable)
- `createdAt` (text, not null)
- Add a non-unique index on `(entity)` and `(ticker, eventDate)`.

**5.2 Pure event-study module** `src/services/eventStudy.ts` (no IO — unit-testable):
- `eventStudy(bars: Bar[], spyBars: Bar[], eventDate: string): EventStudyResult | null`
  - Find the trading-day index at/after `eventDate` in `bars` (and the matching SPY index by date).
  - Compute **simple returns** over windows in **trading days**: pre `[-5, 0]`, and post `[0, +1]`,
    `[0, +5]`, `[0, +20]`. For each window compute the stock return and the SPY return over the **same
    calendar window**, and the **abnormal return = stock return − SPY return**.
  - Return a structured object: per-window `{ stockReturnPct, marketReturnPct, abnormalReturnPct }`, plus
    the resolved event index/date and whether enough bars existed on each side.
  - Return `null` (or per-window nulls) when bars don’t cover the window — never throw.
- `aggregateEventStudies(results): EntityEdgeSummary` — pool a set of per-event results into, per window:
  `n`, `meanAbnormalReturnPct`, `hitRate` (% of events with positive abnormal return), `stdDev`, and a
  simple significance proxy (e.g. `tStat = mean / (std / sqrt(n))`; guard `n < 2`).

**5.3 Orchestration + persistence** (in `eventStudy.ts` or a sibling, may do IO):
- `analyzeEntity(entity: string): { summary, perEvent }` — load all `entity_mentions` for `entity`; for each,
  get bars for its ticker (use `getBars(ticker)`; if local bars don’t cover the event window, fetch via
  `AlpacaService.getHistoricalBars` with a `limit` large enough to reach the event date minus the
  pre-window, and persist them through the existing bar-insert path so future runs are fast); fetch SPY bars
  the same way; run `eventStudy` per mention; aggregate. Handle entities/tickers with insufficient data
  gracefully (report `n` and skip rather than error).
- `listMentions(filter?)`, `addMention(input)` helpers.

**5.4 API + UI**
- `src/app/api/events/route.ts` — `GET` lists mentions (optionally `?entity=`), `POST` adds a mention
  (zod-validated, uppercase ticker, ISO date).
- `src/app/api/events/[id]/route.ts` — `DELETE` a mention.
- `src/app/api/events/analyze/route.ts` (or a query param on the above) — `GET ?entity=` returns
  `analyzeEntity(entity)`.
- `src/app/events/page.tsx` — server component (`force-dynamic`). Shows: an **Add mention** form
  (Collapsible, like the watchlist form); a table of mentions; and a per-entity **edge summary** (windows ×
  mean abnormal return, hit rate, n). Use `ScoreBadge`/`Pct`/`fmt*` helpers. Include the sample-size +
  caveat labeling from §3.10.
- Add an `{ href: "/events", label: "Events" }` (or “Catalyst Edge”) entry to `NAV` in `src/app/layout.tsx`.

**5.5 Tests** `src/services/__tests__/eventStudy.test.ts`:
- Stock that jumps after the event date vs flat SPY → **positive** abnormal post-return.
- Stock flat vs SPY up → **negative** abnormal return (proves market subtraction works).
- Insufficient bars → null, no throw.
- `aggregateEventStudies` math: hit rate and mean over a few synthetic results.

**5.6 Verify Phase 1**
- Restart dev server so the table is created; confirm `GET /api/events` → 200.
- Add a **few real, known public mentions** through the API/UI (the user can supply dates; do not invent
  data into seed files), e.g. a politician’s past comments on specific tickers with their dates.
- Call `GET /api/events/analyze?entity=…` and confirm it returns before/after abnormal returns, hit rate,
  and `n`. Spot-check one event by hand against the bars.
- `npm run typecheck` clean, `npm test` green, page renders at `/events`.
- **Pause and report to the user before Phase 2.**

### Phase 2 — Real-world ingestion + LLM extraction

Turn raw real-world text into structured `entity_mentions` / catalysts.

- **Source connectors** (start with legitimate, reliable, low-friction sources; make each a small module):
  - **SEC EDGAR** 8-K / filing feeds (free, official JSON/Atom) — corporate events/releases.
  - **Company IR RSS** feeds where available.
  - **General news** via a news API or **GDELT** for coverage of public-figure statements
    (“person says X about company Y”).
  - **Do NOT scrape Truth Social / X directly** — no clean official API, fragile, ToS issues. Ingest
    **news coverage of** such statements instead. Document this choice in code comments.
- **LLM extraction** `src/services/eventExtraction.ts`:
  - `extractEvents(items: {text, url, source}[]): ExtractedEvent[]` — batch items into one Haiku call;
    strict-JSON prompt extracting `{ entity, ticker (or companyName), claim, direction, confidence }`;
    parse defensively; **rule-based fallback** (reuse/extend `classifyCatalyst` + a company→ticker map)
    when `getProvider()` is null or the call fails.
  - Company-name → ticker resolution: build a small lookup (Alpaca assets list, or a curated static map for
    the universe in `discoveryAgent.ts`’s `DEFAULT_UNIVERSE`). Skip items that don’t resolve to a tracked or
    known ticker (or store with `ticker = null` and a `companyName` note — your call, but be consistent).
  - Persist as `entity_mentions`, and optionally as catalysts via `addCatalyst()` (so they show in the
    existing catalyst views). Dedupe by `(entity, ticker, eventDate, title/url)`.
- **Scheduling + config:** add a scheduled run in `src/jobs/scheduler.ts` (extend `dailyMaintenance` or add a
  cron). Add config flags via the §3.3 three-edit pattern: enable/disable ingestion, which sources, a
  per-run item cap, and a minimum extraction confidence. Cost control: Haiku + batching + the item cap.

### Phase 3 — Close the loop (feed the edge back into scoring)

- Use `analyzeEntity()` to assign **impact** to fresh events: e.g. if entity E historically shows a positive
  mean abnormal 5-day return with a high hit rate over `n ≥ threshold`, a new “E mentioned T bullishly”
  event becomes a positive catalyst with `impactScore` scaled by the effect size and `confidence` scaled by
  `n`. Keep it interpretable.
- Feed those catalysts into `catalystScore` / `sentimentScore` (they already flow through
  `getCatalystInputs` → `scoreStock`) and surface them in the Agent Picks rationale and on stock pages.
- Show the edge on the relevant stock page and in the catalysts view, always with sample size + caveat.

---

## 6. Definition of done

- `npm run typecheck` is clean and `npm test` passes (including the new event-study tests).
- `npm run dev` runs; the new `/events` page renders; `GET /api/events` and the analyze endpoint return 200.
- Event study verified against at least a few real mentions (added via API/UI, not seed files), spot-checked
  by hand against bars.
- No demo/seed data introduced; the DB still contains only the user’s real data.
- Safety labels (sample size, “historical correlation, not advice”) present on every edge/statistic surface.
- A feature branch is created. **Do not commit or push unless the user asks.** Provide a concise summary of
  what changed and how it was verified.

---

## 7. Suggested build order

1. Phase 1 data model (table in both schema files) → restart → confirm table exists.
2. Pure `eventStudy.ts` + tests (get the math right in isolation first).
3. `analyzeEntity` orchestration + bar backfill for old dates.
4. API routes + `/events` page + nav link.
5. Verify Phase 1 end-to-end; **report and pause.**
6. Phase 2 (sources → Haiku extraction → persistence → schedule), then Phase 3 (feed scoring), each
   verified and reported in turn.

Build incrementally, run `npm run typecheck` frequently, and prefer extending existing modules over
creating parallel ones.

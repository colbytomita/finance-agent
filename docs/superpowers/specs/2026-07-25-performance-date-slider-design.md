# Signal Performance date-range slider — Design

**Date:** 2026-07-25
**Requested:** a "slicer" on the Signal Performance page that filters the date range with a slider.

## Problem

`/performance` renders a cached report (`app_settings.performance_report_v2`) that
stores **only pooled aggregates** — `bucketAndAggregate` / `poolBySource` /
`aggregateSetups` collapse every event into per-band / per-source / per-type rows and
the per-event dates are discarded. Nothing on the page can be filtered by date
without retaining per-event rows somewhere.

Re-running the backtest per range is not an option: it backfills bars over the
network and takes minutes (`maxDuration = 300`).

## Decisions (from brainstorming)

- **Scope: all four sections.** One slider at the top drives Score calibration,
  Pick performance, Realized trades and Setup outcomes.
- **Control: dual-thumb range**, 1-day steps over the full history, with a live
  label (`Jun 13 – Jul 24 · 41 days · 1,016 events`) and 7d / 30d / 90d / All
  presets. Chosen over a single "last N days" lookback so an *older* slice can be
  isolated, and over two stacked sliders so it reads as one range control.
- **Recomputation: client-side, from per-event rows stored in the report**
  (approach A below).
- **Filter state lives in component state**, not the URL — not linkable, resets on
  refresh. Deliberate YAGNI.

## Why client-side re-aggregation (approach chosen over alternatives)

Data volumes measured 2026-07-25: 1,016 score events (~52/day), 31 pick events,
≤129 deduped setup episodes, 12 closed trades. A compact per-event payload is
~60 KB today and ~1 MB after a year — irrelevant for a single-user local app.

The decisive point is **correctness, not size**: storing raw per-event rows lets the
filter call the *existing, unit-tested* aggregators (`aggregateEventStudies`,
`bucketAndAggregate`, `poolBySource`, `poolByIndustry`, `aggregateSetups`,
`summarizeClosedTrades`). No new statistics code means the filtered numbers cannot
silently disagree with the unfiltered ones.

Rejected:

- **Server-side re-aggregation** (`/api/performance?from=&to=`): small payloads
  forever, but every drag becomes a debounced round-trip with a loading state and
  the page stops being server-rendered. Latency for no benefit at this scale.
- **Daily sufficient statistics** (per-day `{n, Σx, Σx², hits}`, summed across the
  range): payload stays a few KB forever and is mathematically exact, but requires
  a second aggregation path parallel to the tested one — two code paths that can
  drift. Slots in behind the identical UI later if the payload ever matters.

## Data

`PerformanceReport` gains an **optional** `events` block, written by
`runPerformanceBacktest`:

```ts
interface PerformanceAbn { post1: number | null; post5: number | null; post20: number | null }

interface PerformanceEvents {
  scores: { ticker: string; day: string; band: StockRecommendationLabel; abn: PerformanceAbn }[];
  picks: { ticker: string; day: string; source: string; industries?: string[]; abn: PerformanceAbn }[];
  setups: { setupType: string; day: string; result: SetupResult | "pending"; rMultiple?: number }[];
  scoreRowsByDay: Record<string, number>; // raw stock_scores counts per day
  scoreSampledByDay?: Record<string, number>; // deduped events SUBMITTED per day
}
```

`scoreSampledByDay` exists because only events that resolved to a forward window
survive into `scores` (1014 of 1121 at the time of writing). Without it a filtered
view would report `sampledEvents === analyzed` and silently hide the ~10% that never
resolved. It is optional so a report cached before the field existed falls back to the
analyzed count instead of crashing. Picks carry no equivalent map: nothing on the page
renders their `sampledEvents` separately, and unread stored data is a liability.

Optional (like `setups?`) so an existing cached report still parses and renders —
the slider simply hides until the next backtest run. **No cache-key bump.**

Only the three displayed windows are stored (`pre5` is not rendered anywhere).
`scoreRowsByDay` keeps the header's "raw rows" figure honest under filtering.

Closed trades are **not** in the report — they are read live by
`getTradePerformance()`. The page passes the raw `closedTrades()` +
`journalEntries()` rows to the client, which filters by `closedAt` and calls
`summarizeClosedTrades`.

## Filter semantics

| Section | Filtered on |
|---|---|
| Score calibration | day the score was computed |
| Pick performance | day the pick was proposed / scanned |
| Setup outcomes | detection day of the episode |
| Realized trades | `closedAt` — when the result landed |

Range bounds are **inclusive** on both ends.

Setups are deduped into episodes (earliest detection anchors each episode) *before*
storage, so narrowing the range simply drops episodes whose anchor falls outside it.

Recomputed under a filter: `analyzed`, `sampledEvents`, `tickers`, `totalScoreRows`,
all bucket/source/industry/type rows, `totalSetups` / `matured` / `pending`, and the
small-sample note. Not recomputed (run-level facts): `spyAvailable`,
`primaryWindow`, `horizonDays`, `generatedAt`, and the stored run notes.

**Full-range guarantee:** when both handles sit at the extremes the view renders the
*stored* aggregates verbatim, so the unfiltered page is byte-identical to today's.
Recomputation only engages when the range is narrowed.

## Pure/IO split (forced by the client bundle)

Discovered during implementation: a **client** component importing `performanceFilter.ts`
pulled `signalPerformance.ts` → `bars.ts` → `yahooHttp.ts` → **Playwright** into the
browser bundle, and the page 500'd on `Can't resolve 'async_hooks'`. Filtering in the
browser therefore requires every transitive import to be IO-free, so the pure halves
were separated from the IO halves:

| Module | After |
|---|---|
| `signalPerformanceCore.ts` (new) | report/event types + `bucketAndAggregate`, `poolBySource`, `poolByIndustry`, `calibrationVerdict` |
| `signalPerformance.ts` | IO only — the `run*` backtests (now including `runSetupPerformance`) and the report cache |
| `setupPerformance.ts` | now **pure** (`resolveSetupOutcome`, `dedupeSetups`, `aggregateSetups`) |
| `tradePerformance.ts` | now **pure**; `getTradePerformance()` moved to `lib/queries.ts` |

This mirrors the existing `eventStudy.ts` (pure) / `entityMentions.ts` (IO) split. Each
symbol keeps exactly one home — no re-export shims — so importers can't accidentally
reach the IO module for a pure function.

**Standing rule: anything the browser imports must stay off the DB/Alpaca/Playwright chain.**

## Components

- `src/services/performanceFilter.ts` — pure, no IO. `filterPerformance(events, range)`
  rebuilds minimal `EventStudyResult`-shaped objects (`aggregateEventStudies` only
  reads `abnormalReturnPct`) and delegates to the existing aggregators.
  `filterClosedTrades(trades, journal, range)` delegates to `summarizeClosedTrades`.
- `src/components/performance/DateRangeSlider.tsx` — dual-thumb control built from two
  overlaid native `<input type="range">` elements (keyboard-accessible, no new
  dependency). Handles cannot cross; minimum span 1 day.
- `src/components/performance/PerformanceView.tsx` — client component owning the
  `{from, to}` state and rendering all four sections (table JSX moved out of the page).
- `src/app/performance/page.tsx` — thin server component: read report + trades, render
  `<PerformanceView>`. `RunBacktestButton` stays in `SignalPerformance.tsx`.

## Edge cases

- Cached report without `events` (pre-upgrade) → slider hidden, page behaves as today.
- No cached report at all → existing empty states, unchanged.
- Range containing no events → tables render `n = 0` / `—` plus a "no events in this
  range" note, never a crash or a fabricated figure.
- Single-day history → slider renders disabled at a 1-day span.

## Testing

Unit tests for `performanceFilter.ts`:

- inclusive range boundaries (events exactly on `from` and `to` are kept)
- empty range → zeroed rows, all five bands still present
- per-industry fan-out survives filtering
- setup `pending` / `no_fill` counts filter correctly
- trades filtered by close date, not entry date
- UTC day arithmetic (`dayOffset` / `addDays`) across month, year and leap-day
  boundaries, and under `TZ=Pacific/Honolulu` — local-time parsing would render every
  label a day early in HST
- sampled-vs-analyzed: `sampledEvents` comes from the per-day map, and falls back to
  the analyzed count when the map is absent
- **consistency:** re-aggregating the *full* range from `events` reproduces what the
  backtest's own aggregators produce from the same events — the guard against the
  stored path and the filtered path drifting apart

Then `npx tsc --noEmit`, the full `vitest run` suite, and a live check against
`npm run dev`: load `/performance`, drag both handles, confirm figures change and
that the full-range view matches the pre-change page.

**Note on `npm run build`:** it fails on `main` independently of this work — Next 16.2.10
cannot detect TypeScript 7.0.2 in its type-check step ("The `id` argument must be of type
string"). Bundling itself reports "Compiled successfully", which is the part that matters
for the client-bundle check above. Verified pre-existing by stashing all changes and
building clean `main`. Use `npx tsc --noEmit` for type verification.

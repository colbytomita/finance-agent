import {
  EVENT_WINDOWS,
  type EventStudyResult,
  type EventWindowKey,
  type WindowReturn,
} from "./eventStudy";
import {
  bucketAndAggregate,
  calibrationVerdict,
  PICK_SOURCES,
  poolByIndustry,
  poolBySource,
  type PerformanceAbn,
  type PerformanceEvents,
  type PerformanceReport,
  type PickPerformance,
  type ScoreCalibration,
} from "./signalPerformanceCore";
import { aggregateSetups, type SetupOutcome, type SetupPerformance } from "./setupPerformance";
import {
  summarizeClosedTrades,
  type ClosedTradeInput,
  type JournalInput,
  type TradeStats,
} from "./tradePerformance";

// Date-range filtering for the Signal Performance page. NO IO — pure functions over
// the per-event rows the backtest stored in the report, so dragging the slider
// re-pools instantly instead of re-running a backtest (which refetches bars over the
// network and takes minutes).
//
// This module runs in the BROWSER, so every import must stay free of the DB /
// Alpaca / Playwright chain — hence signalPerformanceCore rather than
// signalPerformance, and the pure halves of setupPerformance / tradePerformance.
//
// The whole point of keeping raw per-event rows is that filtering reuses the SAME
// aggregators the backtest used (bucketAndAggregate / poolBySource / poolByIndustry /
// aggregateSetups / summarizeClosedTrades) rather than a parallel implementation
// that could silently disagree with them. Only the run-level facts a range can't
// change (SPY availability, primary window, setup horizon) are carried over.

/** Inclusive YYYY-MM-DD day range. */
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86400000;

// Day arithmetic is deliberately UTC-only: parsing "2026-06-13" as local time
// renders it as Jun 12 in Hawaii (UTC-10), which would slip every slider label
// and every boundary comparison back a day.
const parseDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** Whole days from `from` to `day`; negative when `day` precedes `from`. */
export function dayOffset(from: string, day: string): number {
  return Math.round((parseDay(day) - parseDay(from)) / DAY_MS);
}

/** The YYYY-MM-DD `offset` days after `from`. */
export function addDays(from: string, offset: number): string {
  return new Date(parseDay(from) + offset * DAY_MS).toISOString().slice(0, 10);
}

export interface FilteredPerformance {
  score: ScoreCalibration;
  picks: PickPerformance;
  setups?: SetupPerformance;
}

const inRange = (day: string, r: DateRange): boolean => day >= r.from && day <= r.to;

/**
 * Rebuild the minimal EventStudyResult the aggregators need. They only ever read
 * `windows[key].abnormalReturnPct`, so the positional fields are placeholders —
 * this is an adapter, not a reconstruction of the original study.
 */
export function studyFromAbn(abn: PerformanceAbn): EventStudyResult {
  const windows = {} as Record<EventWindowKey, WindowReturn>;
  for (const w of EVENT_WINDOWS) {
    const v = (abn as Partial<Record<EventWindowKey, number | null>>)[w.key] ?? null;
    windows[w.key] = {
      stockReturnPct: null,
      marketReturnPct: null,
      abnormalReturnPct: v,
      available: v != null,
    };
  }
  return { eventDate: "", resolvedEventDate: "", eventIndex: 0, windows };
}

/** Total samples in the primary window across pooled rows — drives the small-sample note. */
function primarySamples(
  rows: { windows: { key: EventWindowKey; n: number }[] }[],
  window: EventWindowKey,
): number {
  return rows.reduce((n, r) => n + (r.windows.find((w) => w.key === window)?.n ?? 0), 0);
}

function rangeNotes(analyzed: number, primaryN: number, spyAvailable: boolean, label: string, r: DateRange): string[] {
  const notes: string[] = [];
  if (analyzed === 0) {
    notes.push(`No ${label} events between ${r.from} and ${r.to}.`);
  } else if (primaryN < 20) {
    notes.push("Small sample — treat these figures as indicative only.");
  }
  if (!spyAvailable) notes.push("SPY benchmark unavailable — abnormal returns can't be computed.");
  return notes;
}

function filterScore(events: PerformanceEvents, base: ScoreCalibration, r: DateRange): ScoreCalibration {
  const rows = events.scores.filter((s) => inRange(s.day, r));
  const buckets = bucketAndAggregate(rows.map((s) => ({ bucket: s.band, study: studyFromAbn(s.abn) })));
  const primaryN = primarySamples(buckets, base.primaryWindow);
  const sumInRange = (byDay: Record<string, number>): number =>
    Object.entries(byDay)
      .filter(([day]) => inRange(day, r))
      .reduce((n, [, count]) => n + count, 0);

  return {
    totalScoreRows: sumInRange(events.scoreRowsByDay),
    // Sampled ≥ analyzed: events that never resolved to a forward window aren't
    // stored individually, so this count comes from the per-day totals. A report
    // cached before that map existed can only report what it analyzed.
    sampledEvents: events.scoreSampledByDay ? sumInRange(events.scoreSampledByDay) : rows.length,
    analyzed: rows.length,
    tickers: new Set(rows.map((s) => s.ticker)).size,
    spyAvailable: base.spyAvailable,
    primaryWindow: base.primaryWindow,
    calibration: calibrationVerdict(buckets, base.primaryWindow),
    buckets,
    notes: rangeNotes(rows.length, primaryN, base.spyAvailable, "score", r),
  };
}

/**
 * Picks: unlike scores, nothing on the page renders `sampledEvents` separately from
 * `analyzed`, so both report the studied picks in range rather than carrying a
 * second per-day map that no view would read.
 */
function filterPicks(events: PerformanceEvents, base: PickPerformance, r: DateRange): PickPerformance {
  const rows = events.picks.filter((p) => inRange(p.day, r));
  const studies = rows.map((p) => ({ source: p.source, groups: p.industries, study: studyFromAbn(p.abn) }));
  const sources = poolBySource(studies, PICK_SOURCES);
  const primaryN = primarySamples(sources, "post5");

  return {
    sampledEvents: rows.length,
    analyzed: rows.length,
    spyAvailable: base.spyAvailable,
    sources,
    byIndustry: poolByIndustry(studies),
    notes: rangeNotes(rows.length, primaryN, base.spyAvailable, "pick", r),
  };
}

function filterSetups(events: PerformanceEvents, base: SetupPerformance, r: DateRange): SetupPerformance {
  const rows = events.setups.filter((s) => inRange(s.day, r));
  const pending = rows.filter((s) => s.result === "pending").length;
  const resolved = rows
    .filter((s) => s.result !== "pending")
    .map((s) => ({
      setupType: s.setupType,
      // Only `result` and `rMultiple` are read by aggregateSetups; the rest of the
      // outcome (prices, dates) isn't retained because nothing renders it.
      outcome: {
        result: s.result,
        rMultiple: s.rMultiple ?? 0,
        exitPrice: 0,
        exitDate: s.day,
        barsHeld: 0,
      } as SetupOutcome,
    }));
  const { byType, overall } = aggregateSetups(resolved);

  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push(`No setups detected between ${r.from} and ${r.to}.`);
  } else {
    if (overall.noFill > 0)
      notes.push(
        `${overall.noFill} matured setup(s) never reached their entry zone (no fill) — price ran away before the trade would have triggered; these are excluded from win rate and average R.`,
      );
    if (pending > 0)
      notes.push(
        `${pending} setup(s) not yet matured — a setup needs ${base.horizonDays} trading days of forward data (or an earlier fill + target/stop touch) before it counts.`,
      );
  }

  return {
    horizonDays: base.horizonDays,
    totalSetups: rows.length,
    matured: resolved.length,
    pending,
    byType,
    overall,
    notes,
  };
}

/**
 * Re-pool a stored report over `range`. Returns null-safe sections built from the
 * report's per-event rows; `setups` is omitted when the stored report predates
 * setup tracking.
 */
export function filterPerformance(report: PerformanceReport, range: DateRange): FilteredPerformance {
  const events: PerformanceEvents = report.events ?? {
    scores: [],
    picks: [],
    setups: [],
    scoreRowsByDay: {},
    scoreSampledByDay: {},
  };
  return {
    score: filterScore(events, report.score, range),
    picks: filterPicks(events, report.picks, range),
    setups: report.setups ? filterSetups(events, report.setups, range) : undefined,
  };
}

/** Realized stats over the closed trades that CLOSED inside `range`. */
export function filterClosedTrades(
  trades: ClosedTradeInput[],
  journal: JournalInput[],
  range: DateRange,
): TradeStats {
  const kept = trades.filter((t) => t.closedAt != null && inRange(t.closedAt.slice(0, 10), range));
  const keptIds = new Set(kept.map((t) => t.id));
  return summarizeClosedTrades(
    kept,
    journal.filter((j) => j.tradeId != null && keptIds.has(j.tradeId)),
  );
}

/**
 * Earliest → latest day across every dataset the slider drives, i.e. the range the
 * control spans. Null when there is nothing to filter (no events, no closed trades).
 */
export function performanceDateDomain(
  events: PerformanceEvents | undefined,
  tradeDays: string[],
): DateRange | null {
  const days = [
    ...(events?.scores ?? []).map((s) => s.day),
    ...(events?.picks ?? []).map((p) => p.day),
    ...(events?.setups ?? []).map((s) => s.day),
    ...tradeDays,
  ].filter((d) => d.length >= 10);
  if (days.length === 0) return null;
  return {
    from: days.reduce((min, d) => (d < min ? d : min), days[0]),
    to: days.reduce((max, d) => (d > max ? d : max), days[0]),
  };
}

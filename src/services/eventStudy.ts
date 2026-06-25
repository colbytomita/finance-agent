import type { Bar } from "@/lib/types";

// Pure event-study ("catalyst edge") math. NO IO here so it stays unit-testable.
// Given a stock's bars, the market benchmark's bars (SPY), and an event date,
// measure how the stock moved before/after the event in trading-day windows,
// subtracting the market move over the same calendar window to get the
// "abnormal return". `analyzeEntity` (in entityMentions.ts) wraps this with the
// DB/network IO and pools results across all of an entity's mentions.
//
// Everything degrades gracefully: missing bars yield null windows, never throws.

/** Trading-day windows, measured as offsets from the event index (day 0). */
export const EVENT_WINDOWS = [
  { key: "pre5", label: "Pre [-5,0]", from: -5, to: 0 },
  { key: "post1", label: "Post [0,+1]", from: 0, to: 1 },
  { key: "post5", label: "Post [0,+5]", from: 0, to: 5 },
  { key: "post20", label: "Post [0,+20]", from: 0, to: 20 },
] as const;

export type EventWindowKey = (typeof EVENT_WINDOWS)[number]["key"];

// If the nearest trading day on/after the event is more than this many calendar
// days later, the event predates (or sits in a large gap of) our price history.
// Snapping to that distant bar would misattribute returns to the wrong date, so
// we treat such an event as uncovered (return null) rather than fabricate a result.
const MAX_RESOLUTION_GAP_DAYS = 10;

export interface WindowReturn {
  /** Simple stock return over the window, in percent. Null if bars don't cover it. */
  stockReturnPct: number | null;
  /** SPY return over the same calendar window, in percent. Null if unavailable. */
  marketReturnPct: number | null;
  /** stockReturnPct − marketReturnPct, in percent. Null if either side missing. */
  abnormalReturnPct: number | null;
  /** Whether the stock had enough bars on both ends of this window. */
  available: boolean;
}

export interface EventStudyResult {
  /** The event date as requested. */
  eventDate: string;
  /** The first trading day at/after eventDate, as found in the stock bars. */
  resolvedEventDate: string;
  /** Index of the resolved event day within the (ascending) stock bars. */
  eventIndex: number;
  /** Per-window returns, keyed by EVENT_WINDOWS[].key. */
  windows: Record<EventWindowKey, WindowReturn>;
}

/** First index whose bar date is >= `date` (bars assumed ascending). -1 if none. */
function indexAtOrAfter(bars: Bar[], date: string): number {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date.slice(0, 10) >= date.slice(0, 10)) return i;
  }
  return -1;
}

function simpleReturnPct(from: number, to: number): number | null {
  if (!isFinite(from) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Run a single-event study. Returns null only when the event date can't be
 * resolved to a trading day in the stock bars; otherwise returns a result whose
 * per-window fields are null where bars don't cover that window.
 */
export function eventStudy(
  bars: Bar[],
  spyBars: Bar[],
  eventDate: string,
): EventStudyResult | null {
  if (bars.length === 0) return null;
  const si = indexAtOrAfter(bars, eventDate);
  if (si === -1) return null; // event is after the last bar we have

  // Reject events that resolve to a bar far from the actual event date (i.e. the
  // event is before our price history starts) so we never misattribute returns.
  const evMs = Date.parse(eventDate.slice(0, 10));
  const barMs = Date.parse(bars[si].date.slice(0, 10));
  if (
    Number.isFinite(evMs) &&
    Number.isFinite(barMs) &&
    barMs - evMs > MAX_RESOLUTION_GAP_DAYS * 86400000
  ) {
    return null;
  }

  const windows = {} as Record<EventWindowKey, WindowReturn>;

  for (const w of EVENT_WINDOWS) {
    const startIdx = si + w.from;
    const endIdx = si + w.to;
    const inRange = startIdx >= 0 && endIdx < bars.length && startIdx !== endIdx;

    if (!inRange) {
      windows[w.key] = {
        stockReturnPct: null,
        marketReturnPct: null,
        abnormalReturnPct: null,
        available: false,
      };
      continue;
    }

    const startBar = bars[startIdx];
    const endBar = bars[endIdx];
    const stockReturnPct = simpleReturnPct(startBar.close, endBar.close);

    // Align the market benchmark to the same calendar window by date.
    const spyStartIdx = indexAtOrAfter(spyBars, startBar.date);
    const spyEndIdx = indexAtOrAfter(spyBars, endBar.date);
    let marketReturnPct: number | null = null;
    if (spyStartIdx !== -1 && spyEndIdx !== -1 && spyStartIdx !== spyEndIdx) {
      marketReturnPct = simpleReturnPct(
        spyBars[spyStartIdx].close,
        spyBars[spyEndIdx].close,
      );
    }

    const abnormalReturnPct =
      stockReturnPct != null && marketReturnPct != null
        ? stockReturnPct - marketReturnPct
        : null;

    windows[w.key] = {
      stockReturnPct,
      marketReturnPct,
      abnormalReturnPct,
      available: stockReturnPct != null,
    };
  }

  return {
    eventDate,
    resolvedEventDate: bars[si].date.slice(0, 10),
    eventIndex: si,
    windows,
  };
}

export interface WindowEdge {
  key: EventWindowKey;
  label: string;
  /** Number of events that had a usable abnormal return for this window. */
  n: number;
  /** Mean abnormal return across those events, in percent. Null if n === 0. */
  meanAbnormalReturnPct: number | null;
  /** Share of events with a positive abnormal return, 0..100. Null if n === 0. */
  hitRate: number | null;
  /** Sample standard deviation of abnormal returns. Null if n < 2. */
  stdDev: number | null;
  /** Significance proxy: mean / (std / sqrt(n)). Null if n < 2 or std === 0. */
  tStat: number | null;
}

export interface EntityEdgeSummary {
  /** Number of events that resolved to a trading day (denominator context). */
  totalEvents: number;
  windows: WindowEdge[];
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStdDev(xs: number[], mu: number): number | null {
  if (xs.length < 2) return null;
  const variance =
    xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Pool a set of per-event studies into a per-window edge summary. */
export function aggregateEventStudies(
  results: EventStudyResult[],
): EntityEdgeSummary {
  const windows: WindowEdge[] = EVENT_WINDOWS.map((w) => {
    const values = results
      .map((r) => r.windows[w.key]?.abnormalReturnPct)
      .filter((v): v is number => v != null && isFinite(v));
    const n = values.length;
    if (n === 0) {
      return {
        key: w.key,
        label: w.label,
        n: 0,
        meanAbnormalReturnPct: null,
        hitRate: null,
        stdDev: null,
        tStat: null,
      };
    }
    const mu = mean(values);
    const hits = values.filter((v) => v > 0).length;
    const std = sampleStdDev(values, mu);
    const tStat =
      std != null && std > 0 ? mu / (std / Math.sqrt(n)) : null;
    return {
      key: w.key,
      label: w.label,
      n,
      meanAbnormalReturnPct: mu,
      hitRate: (hits / n) * 100,
      stdDev: std,
      tStat,
    };
  });

  return { totalEvents: results.length, windows };
}

import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { nowIso } from "@/lib/util";
import { AlpacaService } from "./alpaca";
import { ensureBarsCover } from "./entityMentions";
import { getBars, saveBars } from "./bars";
import { eventStudy, type EventStudyResult, type EventWindowKey } from "./eventStudy";
import { stockRecommendationLabel } from "./scoring";
import {
  aggregateSetups,
  dedupeSetups,
  resolveSetupOutcome,
  SETUP_HORIZON_DAYS,
  type PerformanceSetupEvent,
  type SetupOutcome,
  type SetupPerformance,
} from "./setupPerformance";
import {
  bucketAndAggregate,
  calibrationVerdict,
  PICK_SOURCES,
  poolByIndustry,
  poolBySource,
  type PerformanceAbn,
  type PerformancePickEvent,
  type PerformanceReport,
  type PerformanceScoreEvent,
  type PickPerformance,
  type ScoreCalibration,
} from "./signalPerformanceCore";
import type { StockRecommendationLabel } from "@/lib/types";

// Signal-performance ("does any of this actually work?") backtest — the DB/network
// half. The pure types and pooling math live in signalPerformanceCore.ts so the
// browser can import them for the page's date filter; everything here touches the
// DB, Alpaca or Playwright and must stay server-side.
//
// The app appends a stock_scores row on every recompute and records every
// discovery/sector pick, so we already have a time-series of its own calls. We
// treat each as an "event" and reuse the Catalyst-Edge event-study engine
// (forward abnormal return vs SPY over [0,+1]/[0,+5]/[0,+20]) to measure what
// those tickers actually did next — pooled by recommendation band (score
// calibration) and by source (pick performance). Closed-trade realized stats
// live in tradePerformance.ts.
//
// Historical correlation across the app's own past calls — not a prediction and
// not advice.

const CACHE_KEY = "performance_report_v2";

/**
 * The day `detectBreakout` was redefined. Setups detected before this came from
 * a detector that could never fire on an actual breakout (it keyed off
 * `resistance`, which is by definition still above price), so breakout stats
 * pool two different definitions until the older detections age out.
 */
export const BREAKOUT_DETECTOR_CHANGED_ON = "2026-08-14";

export function readCachedReport(): PerformanceReport | null {
  const row = getDb()
    .select()
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, CACHE_KEY))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PerformanceReport;
  } catch {
    return null;
  }
}

function writeCachedReport(report: PerformanceReport): void {
  const db = getDb();
  const value = JSON.stringify(report);
  db.insert(schema.appSettings)
    .values({ key: CACHE_KEY, value, updatedAt: report.generatedAt })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: report.generatedAt } })
    .run();
}

const PRIMARY_WINDOW: EventWindowKey = "post5";

/**
 * Load SPY bars that reach back to `earliest` AND forward to ~today. The benchmark
 * isn't a tracked ticker, so its bars otherwise lag — and `ensureBarsCover` only
 * backfills *older* history, never the recent bars the forward windows need.
 * getHistoricalBars returns the most-recent `limit` daily bars (ending ~today),
 * so a large-enough limit covers both ends.
 */
async function ensureFreshSpy(earliest: string, alpaca: AlpacaService | null): Promise<Bar[]> {
  let bars = getBars("SPY");
  const last = bars.length > 0 ? bars[bars.length - 1].date.slice(0, 10) : null;
  const reachesBack = bars.length > 0 && bars[0].date.slice(0, 10) <= earliest;
  // Forward-stale if the newest bar is >4 days old (covers a long weekend).
  const forwardStale = last == null || Date.now() - Date.parse(last) > 4 * 86400000;
  if (alpaca && (bars.length === 0 || forwardStale || !reachesBack)) {
    const daysBack = Math.max(0, (Date.now() - Date.parse(earliest)) / 86400000) + 45;
    const limit = Math.min(10000, Math.max(400, Math.ceil(daysBack / 1.5) + 30));
    const fetched = await alpaca.getHistoricalBars("SPY", "1Day", limit).catch(() => [] as Bar[]);
    if (fetched.length > 0) {
      saveBars("SPY", fetched);
      bars = getBars("SPY");
    }
  }
  return bars;
}

interface SignalEvent {
  ticker: string;
  day: string; // YYYY-MM-DD
  key: string; // band label or pick source — the primary pooling key
  groups?: string[]; // optional secondary pooling keys (e.g. a pick's industries)
}

interface StudiedEvents {
  studies: { key: string; ticker: string; day: string; groups?: string[]; study: EventStudyResult }[];
  sampledEvents: number;
  analyzed: number;
  tickers: number;
  spyAvailable: boolean;
  earliest: string | null;
  latest: string | null;
  lastBarDay: string | null;
}

/**
 * Shared event-study core: run each (ticker, day) event through the forward
 * abnormal-return engine vs a freshly-benchmarked SPY, loading/backfilling each
 * ticker's bars only once. Returns the resolved studies tagged with their
 * pooling key plus coverage metadata for diagnostics.
 */
async function studyEvents(
  events: SignalEvent[],
  alpaca: AlpacaService | null,
): Promise<StudiedEvents> {
  if (events.length === 0) {
    return {
      studies: [],
      sampledEvents: 0,
      analyzed: 0,
      tickers: 0,
      spyAvailable: false,
      earliest: null,
      latest: null,
      lastBarDay: null,
    };
  }

  const earliest = events.reduce((min, e) => (e.day < min ? e.day : min), events[0].day);
  const latest = events.reduce((max, e) => (e.day > max ? e.day : max), events[0].day);
  const spyBars = await ensureFreshSpy(earliest, alpaca);
  const lastBarDay = spyBars.length > 0 ? spyBars[spyBars.length - 1].date.slice(0, 10) : null;

  const byTicker = new Map<string, SignalEvent[]>();
  for (const e of events) {
    const list = byTicker.get(e.ticker) ?? [];
    list.push(e);
    byTicker.set(e.ticker, list);
  }

  const studies: StudiedEvents["studies"] = [];
  for (const [ticker, list] of byTicker) {
    const earliestForTicker = list.reduce((min, e) => (e.day < min ? e.day : min), list[0].day);
    const bars = await ensureBarsCover(ticker, earliestForTicker, alpaca).catch(() => []);
    if (bars.length === 0) continue;
    for (const e of list) {
      const study = eventStudy(bars, spyBars, e.day);
      if (study) studies.push({ key: e.key, ticker, day: e.day, groups: e.groups, study });
    }
  }

  return {
    studies,
    sampledEvents: events.length,
    analyzed: studies.length,
    tickers: byTicker.size,
    spyAvailable: spyBars.length > 0,
    earliest,
    latest,
    lastBarDay,
  };
}

/**
 * Pull the three rendered windows' abnormal returns off a study for storage.
 * Rounded to 4dp — the page shows one decimal, so this is lossless on screen and
 * roughly halves the stored payload.
 */
function abnOf(study: EventStudyResult): PerformanceAbn {
  const at = (k: EventWindowKey): number | null => {
    const v = study.windows[k]?.abnormalReturnPct;
    return v != null && isFinite(v) ? Math.round(v * 10000) / 10000 : null;
  };
  return { post1: at("post1"), post5: at("post5"), post20: at("post20") };
}

/** Maturity/coverage note shared by the score and pick backtests. */
function coverageNote(s: StudiedEvents, primaryN: number, label: string): string | null {
  if (s.analyzed === 0) {
    return s.lastBarDay != null && s.earliest != null && s.lastBarDay < s.earliest
      ? `No daily bars on/after the earliest ${label} (${s.earliest}); latest bar is ${s.lastBarDay}. Refresh daily bars, then re-run.`
      : `No ${label}s resolved to a forward window yet.`;
  }
  if (primaryN === 0) {
    return s.lastBarDay != null && s.latest != null && s.lastBarDay < s.latest
      ? `Latest daily bar (${s.lastBarDay}) predates the newest ${label} (${s.latest}) — +5d/+20d windows can't be measured until daily bars advance (run the daily price refresh / npm run jobs).`
      : `${label}s are too recent for a matured +5d window — figures populate as history ages.`;
  }
  if (primaryN < 20) return "Small sample — treat these figures as indicative only.";
  return null;
}

/** Build deduped score events (one per ticker per day, latest score that day). */
function buildScoreEvents(): {
  events: SignalEvent[];
  totalRows: number;
  rowsByDay: Record<string, number>;
  sampledByDay: Record<string, number>;
} {
  const rows = getDb()
    .select({
      ticker: schema.stockScores.ticker,
      overallScore: schema.stockScores.overallScore,
      calculatedAt: schema.stockScores.calculatedAt,
    })
    .from(schema.stockScores)
    .all();
  const byKey = new Map<string, { e: SignalEvent; at: string }>();
  const rowsByDay: Record<string, number> = {};
  for (const r of rows) {
    if (!r.calculatedAt) continue;
    const day = r.calculatedAt.slice(0, 10);
    rowsByDay[day] = (rowsByDay[day] ?? 0) + 1;
    const k = `${r.ticker}|${day}`;
    const prev = byKey.get(k);
    if (!prev || r.calculatedAt > prev.at) {
      byKey.set(k, { e: { ticker: r.ticker, day, key: stockRecommendationLabel(r.overallScore) }, at: r.calculatedAt });
    }
  }
  const events = [...byKey.values()].map((v) => v.e);
  const sampledByDay: Record<string, number> = {};
  for (const e of events) sampledByDay[e.day] = (sampledByDay[e.day] ?? 0) + 1;
  return { events, totalRows: rows.length, rowsByDay, sampledByDay };
}

async function runScoreCalibration(
  alpaca: AlpacaService | null,
): Promise<{
  calibration: ScoreCalibration;
  events: PerformanceScoreEvent[];
  rowsByDay: Record<string, number>;
  sampledByDay: Record<string, number>;
}> {
  const { events, totalRows, rowsByDay, sampledByDay } = buildScoreEvents();
  const studied = await studyEvents(events, alpaca);
  const buckets = bucketAndAggregate(
    studied.studies.map((s) => ({ bucket: s.key as StockRecommendationLabel, study: s.study })),
  );
  const calibration = calibrationVerdict(buckets, PRIMARY_WINDOW);
  const primaryN = buckets.reduce(
    (n, b) => n + (b.windows.find((w) => w.key === PRIMARY_WINDOW)?.n ?? 0),
    0,
  );
  const notes: string[] = [];
  if (events.length === 0) notes.push("No stored stock scores yet — refresh some tracked tickers, then re-run.");
  if (studied.earliest && studied.latest) notes.push(`Score history spans ${studied.earliest} → ${studied.latest}.`);
  if (events.length > 0 && !studied.spyAvailable) notes.push("SPY benchmark unavailable — abnormal returns can't be computed.");
  const cn = events.length > 0 ? coverageNote(studied, primaryN, "score") : null;
  if (cn) notes.push(cn);

  return {
    calibration: {
      totalScoreRows: totalRows,
      sampledEvents: studied.sampledEvents,
      analyzed: studied.analyzed,
      tickers: studied.tickers,
      spyAvailable: studied.spyAvailable,
      primaryWindow: PRIMARY_WINDOW,
      calibration,
      buckets,
      notes,
    },
    events: studied.studies.map((s) => ({
      ticker: s.ticker,
      day: s.day,
      band: s.key as StockRecommendationLabel,
      abn: abnOf(s.study),
    })),
    rowsByDay,
    sampledByDay,
  };
}

/** Build deduped pick events from Agent Picks + Sector Scout (one per source/ticker/day). */
function buildPickEvents(): SignalEvent[] {
  const db = getDb();
  const out: SignalEvent[] = [];
  const seen = new Set<string>();
  const add = (ticker: string | null, at: string | null, source: string, groups?: string[]) => {
    if (!ticker || !at) return;
    const day = at.slice(0, 10);
    const k = `${source}|${ticker}|${day}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ticker, day, key: source, groups });
  };
  for (const r of db
    .select({ ticker: schema.agentCandidates.ticker, at: schema.agentCandidates.proposedAt })
    .from(schema.agentCandidates)
    .all())
    add(r.ticker, r.at, "Agent Picks");
  // Sector Scout: one event per ticker/day for the source pool, tagged with every
  // industry that surfaced it that day so the per-industry breakdown can fan out
  // (the same ticker can be a pick under more than one industry).
  const sectorByKey = new Map<string, { ticker: string; at: string; industries: Set<string> }>();
  for (const r of db
    .select({
      ticker: schema.sectorScoutPicks.ticker,
      at: schema.sectorScoutPicks.scannedAt,
      industry: schema.sectorScoutPicks.industry,
    })
    .from(schema.sectorScoutPicks)
    .all()) {
    if (!r.ticker || !r.at) continue;
    const day = r.at.slice(0, 10);
    const k = `${r.ticker}|${day}`;
    let entry = sectorByKey.get(k);
    if (!entry) {
      entry = { ticker: r.ticker, at: r.at, industries: new Set() };
      sectorByKey.set(k, entry);
    }
    if (r.industry) entry.industries.add(r.industry);
  }
  for (const entry of sectorByKey.values())
    add(entry.ticker, entry.at, "Sector Scout", [...entry.industries]);
  return out;
}

async function runPickPerformance(
  alpaca: AlpacaService | null,
): Promise<{ performance: PickPerformance; events: PerformancePickEvent[] }> {
  const events = buildPickEvents();
  const studied = await studyEvents(events, alpaca);
  const sources = poolBySource(
    studied.studies.map((s) => ({ source: s.key, study: s.study })),
    PICK_SOURCES,
  );
  const byIndustry = poolByIndustry(studied.studies);
  const primaryN = sources.reduce(
    (n, s) => n + (s.windows.find((w) => w.key === PRIMARY_WINDOW)?.n ?? 0),
    0,
  );
  const notes: string[] = [];
  if (events.length === 0) notes.push("No Agent Picks or Sector Scout picks recorded yet.");
  const cn = events.length > 0 ? coverageNote(studied, primaryN, "pick") : null;
  if (cn) notes.push(cn);

  return {
    performance: {
      sampledEvents: studied.sampledEvents,
      analyzed: studied.analyzed,
      spyAvailable: studied.spyAvailable,
      sources,
      byIndustry,
      notes,
    },
    events: studied.studies.map((s) => ({
      ticker: s.ticker,
      day: s.day,
      source: s.key,
      industries: s.groups,
      abn: abnOf(s.study),
    })),
  };
}

/**
 * Backtest every detected setup: backfill each ticker's bars once, resolve each
 * setup, and aggregate. Setups without enough forward data are counted as pending
 * (not failures). The per-setup rows are returned alongside the pooled stats so
 * the page can re-pool them by date.
 */
async function runSetupPerformance(
  alpaca: AlpacaService | null,
): Promise<{ performance: SetupPerformance; events: PerformanceSetupEvent[] }> {
  // scanForSetups re-inserts a persistent setup every refresh, so collapse those
  // repeats into one signal (earliest detection) before measuring anything.
  const setups = dedupeSetups(getDb().select().from(schema.tradeSetups).all());
  const notes: string[] = [];
  if (setups.length === 0) {
    return {
      performance: {
        horizonDays: SETUP_HORIZON_DAYS,
        totalSetups: 0,
        matured: 0,
        pending: 0,
        byType: [],
        overall: aggregateSetups([]).overall,
        notes: ["No setups detected yet — they appear on the Swing Trading page as the detector finds them."],
      },
      events: [],
    };
  }

  // Group by ticker so bars are backfilled once per name (reaching back to its
  // earliest detection; the forward window is covered by the normal refresh).
  const byTicker = new Map<string, typeof setups>();
  for (const s of setups) {
    const arr = byTicker.get(s.ticker) ?? [];
    arr.push(s);
    byTicker.set(s.ticker, arr);
  }

  const resolved: { setupType: string; outcome: SetupOutcome }[] = [];
  const events: PerformanceSetupEvent[] = [];
  let pending = 0;
  for (const [ticker, list] of byTicker) {
    const earliest = list.reduce((min, s) => (s.detectedAt < min ? s.detectedAt : min), list[0].detectedAt);
    const bars = await ensureBarsCover(ticker, earliest, alpaca).catch(() => [] as Bar[]);
    for (const s of list) {
      const outcome = resolveSetupOutcome(s, bars);
      const day = s.detectedAt.slice(0, 10);
      if (outcome) {
        resolved.push({ setupType: s.setupType, outcome });
        events.push({ setupType: s.setupType, day, result: outcome.result, rMultiple: outcome.rMultiple });
      } else {
        pending++;
        events.push({ setupType: s.setupType, day, result: "pending" });
      }
    }
  }

  const { byType, overall } = aggregateSetups(resolved);
  if (overall.noFill > 0)
    notes.push(
      `${overall.noFill} matured setup(s) never reached their entry zone (no fill) — price ran away before the trade would have triggered; these are excluded from win rate and average R.`,
    );
  if (pending > 0)
    notes.push(
      `${pending} setup(s) not yet matured — a setup needs ${SETUP_HORIZON_DAYS} trading days of forward data (or an earlier fill + target/stop touch) before it counts.`,
    );
  if (overall.triggered === 0 && pending > 0)
    notes.push("No matured setups have triggered yet — check back once the earliest detections have run their course.");
  if (setups.some((s) => s.setupType === "breakout" && s.detectedAt < BREAKOUT_DETECTOR_CHANGED_ON))
    notes.push(
      `Breakout setups detected before ${BREAKOUT_DETECTOR_CHANGED_ON} came from an earlier detector that fired when price ` +
        `APPROACHED resistance rather than when it broke through, and backtested at a 23.2% win rate. The current detector ` +
        `requires a fresh, volume-confirmed break of a cleared level (38.3% over the same history). Breakout figures mix ` +
        `both definitions until the older detections age out.`,
    );

  return {
    performance: {
      horizonDays: SETUP_HORIZON_DAYS,
      totalSetups: setups.length,
      matured: resolved.length,
      pending,
      byType,
      overall,
      notes,
    },
    events,
  };
}

/** Run all backtests (score calibration + pick + setup performance) and cache the report. */
export async function runPerformanceBacktest(): Promise<PerformanceReport> {
  const alpaca = AlpacaService.fromEnv();
  const score = await runScoreCalibration(alpaca);
  const picks = await runPickPerformance(alpaca);
  const setups = await runSetupPerformance(alpaca);
  const report: PerformanceReport = {
    generatedAt: nowIso(),
    score: score.calibration,
    picks: picks.performance,
    setups: setups.performance,
    // Per-event rows powering the page's date-range filter (performanceFilter.ts).
    events: {
      scores: score.events,
      picks: picks.events,
      setups: setups.events,
      scoreRowsByDay: score.rowsByDay,
      scoreSampledByDay: score.sampledByDay,
    },
  };
  writeCachedReport(report);
  return report;
}

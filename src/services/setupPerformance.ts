import type { Bar } from "@/lib/types";

// Setup outcome backtest (roadmap #17). trade_setups accumulates every detected
// swing setup (entry range, stop, target) but nothing ever measured whether they
// worked. This resolves each detection against the daily bars that follow it —
// win / loss / expired with an R-multiple — then aggregates per setup type into
// win rate, average R and expectancy. Historical outcomes of past detections, not
// a prediction or advice.
//
// NO IO here: the bar loading and DB reads live in runSetupPerformance
// (signalPerformance.ts). Keeping this module pure is what lets the Signal
// Performance page re-aggregate setups in the browser as the date filter moves.

/** Forward window (trading days) a setup gets to reach its target or stop. */
export const SETUP_HORIZON_DAYS = 20;

export interface SetupInput {
  setupType: string;
  detectedAt: string;
  entryRangeLow: number;
  entryRangeHigh: number;
  stopLoss: number;
  targetPrice1: number;
}

// "no_fill" = the entry zone was never reached in the window, so the setup would
// never have triggered a trade (e.g. price gapped away). Excluded from win/loss.
export type SetupResult = "win" | "loss" | "expired" | "no_fill";

export interface SetupOutcome {
  result: SetupResult;
  rMultiple: number; // realized reward in units of initial risk (entry-mid → stop); 0 for no_fill
  exitPrice: number;
  exitDate: string;
  barsHeld: number; // bars from the fill to the exit (0 for no_fill)
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Resolve one setup against the daily bars that follow its detection. Long-only
 * (all detector setups are long: stop below entry, target above). Crucially it
 * models the *entry* first: a setup only becomes a trade if price actually trades
 * into its entry zone — otherwise it's "no_fill" (price ran away, the trade never
 * triggered), which prevents counting never-entered setups as wins. Once filled
 * (at the entry-mid), each following bar within `horizonDays` is walked:
 *   - stop touched first  → loss (a gap-down open below the stop fills at the
 *     open, so R can be worse than −1); same-bar stop+target counts as a stop.
 *   - target touched first → win (fills at the target).
 *   - neither by the horizon → "expired", marked to market at the horizon close.
 * Returns null when the R is undefined (bad geometry) or the setup isn't matured
 * yet (fewer than `horizonDays` bars of forward data and no resolution), so
 * callers can report it as pending rather than "no data".
 */
export function resolveSetupOutcome(
  setup: SetupInput,
  bars: Bar[],
  horizonDays: number = SETUP_HORIZON_DAYS,
): SetupOutcome | null {
  const entryMid = (setup.entryRangeLow + setup.entryRangeHigh) / 2;
  const entryLow = Math.min(setup.entryRangeLow, setup.entryRangeHigh);
  const entryHigh = Math.max(setup.entryRangeLow, setup.entryRangeHigh);
  const risk = entryMid - setup.stopLoss;
  // Need a valid long geometry: stop below entry, target above entry.
  if (!(risk > 0) || !(setup.targetPrice1 > entryMid)) return null;
  const detected = Date.parse(setup.detectedAt);
  if (!Number.isFinite(detected)) return null;

  const forward = bars
    .filter((b) => Date.parse(b.date) > detected)
    .sort((a, b) => a.date.localeCompare(b.date));
  // Unbiased maturity: only judge a setup once the FULL horizon has elapsed, so
  // the sample isn't skewed toward fast losers (which stop out in days) over
  // slow winners (which take longer to reach target). Fewer bars → still pending.
  if (forward.length < horizonDays) return null;
  const window = forward.slice(0, horizonDays);

  // Phase 1 — entry: first bar whose range overlaps the entry zone (price traded
  // into it). Fill at the entry-mid, clamped into that bar's range so a gap-in
  // fills realistically.
  let fillIdx = -1;
  let fillPrice = entryMid;
  for (let i = 0; i < window.length; i++) {
    const b = window[i];
    if (b.low <= entryHigh && b.high >= entryLow) {
      fillIdx = i;
      fillPrice = clamp(entryMid, b.low, b.high);
      break;
    }
  }
  if (fillIdx === -1) {
    // Price never traded into the entry zone across the full horizon → no fill.
    const last = window[window.length - 1];
    return { result: "no_fill", rMultiple: 0, exitPrice: fillPrice, exitDate: last.date, barsHeld: 0 };
  }
  const denom = fillPrice - setup.stopLoss; // realized risk from the actual fill
  const rOf = (exit: number): number => (denom > 0 ? round2((exit - fillPrice) / denom) : 0);

  // Phase 2 — exit: from the fill bar onward, stop or target within the horizon.
  for (let i = fillIdx; i < window.length; i++) {
    const bar = window[i];
    // Conservative on ambiguity: a bar touching both stop and target is a stop.
    if (bar.low <= setup.stopLoss) {
      const exit = bar.open < setup.stopLoss ? bar.open : setup.stopLoss; // gap through the stop
      return { result: "loss", rMultiple: rOf(exit), exitPrice: exit, exitDate: bar.date, barsHeld: i - fillIdx + 1 };
    }
    if (bar.high >= setup.targetPrice1) {
      return { result: "win", rMultiple: rOf(setup.targetPrice1), exitPrice: setup.targetPrice1, exitDate: bar.date, barsHeld: i - fillIdx + 1 };
    }
  }

  // Filled but neither stop nor target touched within the full horizon → expired,
  // marked to market at the horizon close.
  const last = window[window.length - 1];
  return { result: "expired", rMultiple: rOf(last.close), exitPrice: last.close, exitDate: last.date, barsHeld: window.length - fillIdx };
}

/**
 * Collapse repeated detections of the same setup into one signal. scanForSetups
 * re-inserts a still-valid setup on every refresh (a fresh row + detectedAt each
 * day), so a setup that persists for two weeks would otherwise be counted a dozen
 * times over overlapping windows. We group by (ticker, setupType) and keep the
 * EARLIEST detection of each "episode" — a run of detections not separated by a
 * gap longer than `gapDays`. Re-appearance after a real gap starts a new episode.
 * Pure.
 */
export function dedupeSetups<T extends { ticker: string; setupType: string; detectedAt: string }>(
  setups: T[],
  gapDays = 10,
): T[] {
  const byKey = new Map<string, T[]>();
  for (const s of setups) {
    const k = `${s.ticker.toUpperCase()}|${s.setupType}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }
  const gapMs = gapDays * 86400000;
  const kept: T[] = [];
  for (const group of byKey.values()) {
    const sorted = [...group].sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
    let episodeStart: T | null = null;
    let prevTime = -Infinity;
    for (const s of sorted) {
      const t = Date.parse(s.detectedAt);
      if (episodeStart === null || t - prevTime > gapMs) {
        episodeStart = s;
        kept.push(s); // earliest of a new episode
      }
      prevTime = t;
    }
  }
  return kept;
}

export interface SetupTypeStats {
  setupType: string;
  matured: number; // all resolved-enough outcomes (triggered + no_fill)
  triggered: number; // setups that actually reached their entry zone (wins + losses + expired)
  wins: number;
  losses: number;
  expired: number;
  noFill: number; // entry never reached — would not have been a trade
  winRate: number | null; // wins / (wins + losses), percent; null when none resolved
  avgR: number | null; // mean R over triggered outcomes (expectancy in R per trade taken)
}

function statsFor(setupType: string, outcomes: SetupOutcome[]): SetupTypeStats {
  const wins = outcomes.filter((o) => o.result === "win").length;
  const losses = outcomes.filter((o) => o.result === "loss").length;
  const expired = outcomes.filter((o) => o.result === "expired").length;
  const noFill = outcomes.filter((o) => o.result === "no_fill").length;
  const triggered = wins + losses + expired;
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Math.round((wins / resolved) * 1000) / 10 : null;
  const avgR =
    triggered > 0
      ? round2(outcomes.filter((o) => o.result !== "no_fill").reduce((s, o) => s + o.rMultiple, 0) / triggered)
      : null;
  return { setupType, matured: outcomes.length, triggered, wins, losses, expired, noFill, winRate, avgR };
}

/** Pool resolved outcomes into per-type rows plus an overall row. Pure. */
export function aggregateSetups(
  items: { setupType: string; outcome: SetupOutcome }[],
): { byType: SetupTypeStats[]; overall: SetupTypeStats } {
  const byTypeMap = new Map<string, SetupOutcome[]>();
  for (const it of items) {
    const arr = byTypeMap.get(it.setupType) ?? [];
    arr.push(it.outcome);
    byTypeMap.set(it.setupType, arr);
  }
  const byType = [...byTypeMap.entries()]
    .map(([type, outcomes]) => statsFor(type, outcomes))
    .sort((a, b) => b.matured - a.matured || a.setupType.localeCompare(b.setupType));
  const overall = statsFor("All setups", items.map((i) => i.outcome));
  return { byType, overall };
}

export interface SetupPerformance {
  horizonDays: number;
  totalSetups: number;
  matured: number;
  pending: number;
  byType: SetupTypeStats[];
  overall: SetupTypeStats;
  notes: string[];
}

/**
 * One deduped setup episode with its resolved outcome, kept alongside the pooled
 * stats so the Signal Performance page can re-pool any date range (see
 * performanceFilter.ts). `day` is the episode's detection day — the anchor the
 * date filter matches on.
 */
export interface PerformanceSetupEvent {
  setupType: string;
  day: string;
  result: SetupResult | "pending";
  rMultiple?: number; // absent while pending
}


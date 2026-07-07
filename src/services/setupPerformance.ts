import { getDb, schema } from "@/db";
import type { Bar } from "@/lib/types";
import { AlpacaService } from "./alpaca";
import { ensureBarsCover } from "./entityMentions";

// Setup outcome backtest (roadmap #17). trade_setups accumulates every detected
// swing setup (entry range, stop, target) but nothing ever measured whether they
// worked. This walks the daily bars after each detection and resolves it to a
// win / loss / expired outcome with an R-multiple, then aggregates per setup type
// — win rate, average R, expectancy. Historical outcomes of past detections, not
// a prediction or advice. The resolver is pure (no IO) and unit-tested.

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
 * Backtest every detected setup: backfill each ticker's bars once, resolve each
 * setup, and aggregate. Setups without enough forward data are counted as
 * pending (not failures). Runs inside runPerformanceBacktest so the cached
 * report — and daily maintenance — pick it up automatically.
 */
export async function runSetupPerformance(alpaca: AlpacaService | null): Promise<SetupPerformance> {
  // scanForSetups re-inserts a persistent setup every refresh, so collapse those
  // repeats into one signal (earliest detection) before measuring anything.
  const setups = dedupeSetups(getDb().select().from(schema.tradeSetups).all());
  const notes: string[] = [];
  if (setups.length === 0) {
    return {
      horizonDays: SETUP_HORIZON_DAYS,
      totalSetups: 0,
      matured: 0,
      pending: 0,
      byType: [],
      overall: statsFor("All setups", []),
      notes: ["No setups detected yet — they appear on the Swing Trading page as the detector finds them."],
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
  let pending = 0;
  for (const [ticker, list] of byTicker) {
    const earliest = list.reduce((min, s) => (s.detectedAt < min ? s.detectedAt : min), list[0].detectedAt);
    const bars = await ensureBarsCover(ticker, earliest, alpaca).catch(() => [] as Bar[]);
    for (const s of list) {
      const outcome = resolveSetupOutcome(s, bars);
      if (outcome) resolved.push({ setupType: s.setupType, outcome });
      else pending++;
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

  return {
    horizonDays: SETUP_HORIZON_DAYS,
    totalSetups: setups.length,
    matured: resolved.length,
    pending,
    byType,
    overall,
    notes,
  };
}

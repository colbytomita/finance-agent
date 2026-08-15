import type { Bar, SetupType } from "@/lib/types";
import { computeIndicators, sma, type IndicatorSnapshot } from "./indicators";
import { riskRewardRatio } from "./riskManagement";

// Swing-trade setup detection from daily bars. Heuristic pattern checks —
// each detected setup includes entry/stop/targets and an invalidation
// condition so the user can judge it.

export interface DetectedSetup {
  setupType: SetupType;
  setupQualityScore: number; // 1-10
  entryRangeLow: number;
  entryRangeHigh: number;
  stopLoss: number;
  targetPrice1: number;
  targetPrice2: number | null;
  riskRewardRatio: number;
  invalidationCondition: string;
  explanation: string;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function buildSetup(
  type: SetupType,
  quality: number,
  entryLow: number,
  entryHigh: number,
  stop: number,
  target1: number,
  target2: number | null,
  invalidation: string,
  explanation: string,
): DetectedSetup | null {
  const mid = (entryLow + entryHigh) / 2;
  const rr = riskRewardRatio(mid, stop, target1);
  if (rr == null || rr <= 0) return null;
  return {
    setupType: type,
    setupQualityScore: Math.min(10, Math.max(1, Math.round(quality * 10) / 10)),
    entryRangeLow: round2(entryLow),
    entryRangeHigh: round2(entryHigh),
    stopLoss: round2(stop),
    targetPrice1: round2(target1),
    targetPrice2: target2 != null ? round2(target2) : null,
    riskRewardRatio: Math.round(rr * 10) / 10,
    invalidationCondition: invalidation,
    explanation,
  };
}

function detectPullbackToSupport(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, ema21, sma50, rsi14, atr14 } = ind;
  if (ema21 == null || sma50 == null || atr14 == null) return null;
  // Uptrend + price pulled back near 21-EMA without breaking 50-SMA.
  const uptrend = price > sma50 && ema21 > sma50;
  const nearEma = Math.abs(price - ema21) / price < 0.02;
  const pulledBack = rsi14 != null && rsi14 < 55 && rsi14 > 35;
  if (!(uptrend && nearEma && pulledBack)) return null;
  const stop = Math.min(ema21 - atr14, sma50);
  const t1 = price + 2 * (price - stop);
  const t2 = price + 3 * (price - stop);
  let quality = 6.5;
  if (ind.relativeVolume != null && ind.relativeVolume < 0.9) quality += 0.5; // quiet pullback
  // Long-term uptrend bonus only when a 200-SMA actually exists — with fewer
  // than 200 bars `?? 0` made this unconditionally true and inflated quality.
  if (ind.sma200 != null && price > ind.sma200) quality += 0.5;
  return buildSetup(
    "pullback_to_support",
    quality,
    price * 0.995,
    price * 1.01,
    stop,
    t1,
    t2,
    "Daily close below the 50-day average.",
    "Uptrend pullback to the 21-EMA with cooled momentum.",
  );
}

/**
 * A breakout is a level that has been BROKEN, not one being approached. The
 * previous version keyed off `ind.resistance`, which `supportResistance` defines
 * as the nearest swing high strictly ABOVE price — so it could only ever fire
 * while price was still capped, and fired on every approach to a ceiling. Most
 * approaches get rejected (that is what makes a level resistance), which is why
 * it backtested at a 9.5% win rate over 40 matured setups. It now keys off
 * `clearedHigh` (the highest swing high price has cleared) and requires a fresh,
 * volume-confirmed crossing that has not yet run away from the level.
 */
function detectBreakout(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, clearedHigh, atr14, relativeVolume } = ind;
  if (clearedHigh == null || atr14 == null) return null;
  if (price <= clearedHigh) return null; // not broken yet
  // Extended moves are chasing: the retest entry is already gone.
  if (price > clearedHigh * 1.05) return null;
  // A crossing, not a stock that has simply been above the level for weeks.
  const priorCloses = bars.slice(-6, -1).map((b) => b.close);
  if (!priorCloses.some((c) => c <= clearedHigh)) return null;
  // Volume is what separates a real break from a drift through the level.
  if (!(relativeVolume != null && relativeVolume >= 1.3)) return null;

  const stop = clearedHigh - 1.5 * atr14;
  // The broken level becomes support on a retest, so it anchors the entry zone.
  const entryLow = clearedHigh;
  const entryHigh = Math.max(price, clearedHigh * 1.01);
  // Targets are measured from the entry MID because that is where the outcome
  // resolver fills; measuring from entryHigh advertised an R/R the trade never got.
  const mid = (entryLow + entryHigh) / 2;
  const risk = mid - stop;
  let quality = 6.5;
  if (relativeVolume >= 2) quality += 1;
  if (ind.sma50 != null && price > ind.sma50) quality += 0.5;
  if (ind.sma200 != null && price > ind.sma200) quality += 0.5;
  return buildSetup(
    "breakout",
    quality,
    entryLow,
    entryHigh,
    stop,
    mid + 2 * risk,
    mid + 3 * risk,
    "Close back below the broken level (failed breakout).",
    `Broke above ${round2(clearedHigh)} on ${relativeVolume.toFixed(1)}x average volume.`,
  );
}

function detectOversoldBounce(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, rsi14, atr14, sma200, swingLow10 } = ind;
  if (rsi14 == null || atr14 == null || swingLow10 == null) return null;
  if (rsi14 >= 32) return null;
  // Last bar should close green (reversal sign).
  const last = bars[bars.length - 1];
  if (!last || last.close <= last.open) return null;
  const stop = swingLow10 - 0.5 * atr14;
  const t1 = price + 2 * (price - stop);
  let quality = 5.5;
  if (sma200 != null && price > sma200) quality += 1; // bounce within long uptrend
  return buildSetup(
    "oversold_bounce",
    quality,
    price * 0.99,
    price * 1.01,
    stop,
    t1,
    null,
    "New low below the recent swing low.",
    `Oversold (RSI ${rsi14.toFixed(0)}) with a green reversal bar.`,
  );
}

function detectMaReclaim(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, sma50, atr14 } = ind;
  if (sma50 == null || atr14 == null || bars.length < 6) return null;
  const closes = bars.map((b) => b.close);
  const idx = bars.length - 1;
  // Price closed back above the 50-SMA within the last 2 bars after being below.
  // Each prior close is compared against the average AS OF THAT BAR: comparing
  // old closes to *today's* average misjudges whether price was ever really below
  // it, and a falling average made the check trivially true.
  let wasBelow = false;
  for (let i = Math.max(0, idx - 5); i <= idx - 2; i++) {
    const smaThen = sma(closes.slice(0, i + 1), 50);
    if (smaThen != null && closes[i] < smaThen) {
      wasBelow = true;
      break;
    }
  }
  const nowAbove = price > sma50;
  if (!(wasBelow && nowAbove && price < sma50 * 1.04)) return null;
  // NOTE: filtering out reclaims of a *falling* 50-SMA (the "bull trap" theory)
  // was tried and measured over 288 tickers of history — it halved the signal
  // count (1,922 -> 1,067 matured) while the win rate stayed at 35.5%. No edge,
  // so it is deliberately not filtered. Don't re-add it without new evidence.
  const stop = sma50 - 1.5 * atr14;
  const t1 = price + 2 * (price - stop);
  const t2 = price + 3 * (price - stop);
  return buildSetup(
    "ma_reclaim",
    6,
    price * 0.99,
    price * 1.015,
    stop,
    t1,
    t2,
    "Close back below the 50-day average.",
    "Price reclaimed the 50-day average after trading below it.",
  );
}

function detectMomentumContinuation(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, ema8, ema21, rsi14, atr14, relativeVolume } = ind;
  if (ema8 == null || ema21 == null || rsi14 == null || atr14 == null) return null;
  const strong = ema8 > ema21 && rsi14 >= 55 && rsi14 <= 72;
  if (!strong) return null;
  const stop = ema21 - atr14;
  const t1 = price + 2 * (price - stop);
  let quality = 6;
  if (relativeVolume != null && relativeVolume > 1.2) quality += 1;
  if (ind.macd && ind.macd.histogram > 0) quality += 0.5;
  return buildSetup(
    "momentum_continuation",
    quality,
    price * 0.995,
    price * 1.01,
    stop,
    t1,
    null,
    "Close below the 21-EMA.",
    "Established momentum trend with healthy (not overbought) RSI.",
  );
}

function detectHighVolumeReversal(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  if (bars.length < 3 || ind.atr14 == null) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const { relativeVolume, swingLow10 } = ind;
  if (relativeVolume == null || relativeVolume < 2 || swingLow10 == null) return null;
  // Down move followed by a high-volume green bar closing above prior close.
  const reversal = prev.close < prev.open && last.close > last.open && last.close > prev.close;
  if (!reversal) return null;
  const stop = Math.min(last.low, swingLow10) - 0.25 * ind.atr14;
  const t1 = last.close + 2 * (last.close - stop);
  return buildSetup(
    "high_volume_reversal",
    6.5,
    last.close * 0.99,
    last.close * 1.01,
    stop,
    t1,
    null,
    "Close below the reversal bar's low.",
    `High-volume reversal bar (${relativeVolume.toFixed(1)}x avg volume).`,
  );
}

const DETECTORS = [
  detectPullbackToSupport,
  detectBreakout,
  detectMomentumContinuation,
  detectMaReclaim,
  detectOversoldBounce,
  detectHighVolumeReversal,
];

export function detectSetups(bars: Bar[]): DetectedSetup[] {
  if (bars.length < 30) return []; // not enough history to judge anything
  const ind = computeIndicators(bars);
  if (!ind) return [];
  const found: DetectedSetup[] = [];
  for (const detect of DETECTORS) {
    try {
      const setup = detect(ind, bars);
      if (setup) found.push(setup);
    } catch {
      // A single detector failure must not break the scan.
    }
  }
  // Highest quality first; drop setups with sub-1.5 R/R.
  return found
    .filter((s) => s.riskRewardRatio >= 1.5)
    .sort((a, b) => b.setupQualityScore - a.setupQualityScore);
}

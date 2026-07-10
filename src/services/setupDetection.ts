import type { Bar, SetupType } from "@/lib/types";
import { computeIndicators, type IndicatorSnapshot } from "./indicators";
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

function detectBreakout(ind: IndicatorSnapshot, bars: Bar[]): DetectedSetup | null {
  const { price, resistance, atr14, relativeVolume } = ind;
  if (resistance == null || atr14 == null) return null;
  // Price within striking distance (1%) or just above prior resistance with volume.
  const nearBreakout = price >= resistance * 0.99 && price <= resistance * 1.03;
  if (!nearBreakout) return null;
  const volumeConfirms = relativeVolume != null && relativeVolume >= 1.3;
  const stop = resistance - 1.5 * atr14;
  const entryLow = Math.max(price, resistance);
  const entryHigh = resistance * 1.02;
  const t1 = entryHigh + 2 * (entryHigh - stop);
  const t2 = entryHigh + 3 * (entryHigh - stop);
  let quality = volumeConfirms ? 7.5 : 5.5;
  if (ind.sma50 != null && price > ind.sma50) quality += 0.5;
  return buildSetup(
    "breakout",
    quality,
    entryLow,
    entryHigh,
    stop,
    t1,
    t2,
    "Close back below the breakout level (failed breakout).",
    volumeConfirms
      ? "Breaking resistance on above-average volume."
      : "At resistance — needs volume confirmation before entry.",
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
  // Price closed back above 50-SMA within the last 2 bars after being below.
  const prevCloses = bars.slice(-6, -2).map((b) => b.close);
  const wasBelow = prevCloses.some((c) => c < sma50);
  const nowAbove = price > sma50;
  if (!(wasBelow && nowAbove && price < sma50 * 1.04)) return null;
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

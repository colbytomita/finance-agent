import type { Bar } from "@/lib/types";

// Pure technical-indicator math. All functions tolerate short series by
// returning null instead of throwing — callers must handle missing data.

export function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const macdSeries: number[] = [];
  for (let i = slow; i <= closes.length; i++) {
    const window = closes.slice(0, i);
    const f = ema(window, fast);
    const s = ema(window, slow);
    if (f == null || s == null) return null;
    macdSeries.push(f - s);
  }
  const signal = ema(macdSeries, signalPeriod);
  if (signal == null) return null;
  const m = macdSeries[macdSeries.length - 1];
  return { macd: m, signal, histogram: m - signal };
}

export function vwap(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}

export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

/** Today's volume relative to N-day average volume. 1.0 = average. */
export function relativeVolume(bars: Bar[], lookback = 20): number | null {
  if (bars.length < lookback + 1) return null;
  const prior = bars.slice(-lookback - 1, -1);
  const avg = prior.reduce((a, b) => a + b.volume, 0) / prior.length;
  if (avg <= 0) return null;
  return bars[bars.length - 1].volume / avg;
}

export function fiftyTwoWeekRange(bars: Bar[]): { high: number; low: number } | null {
  if (bars.length === 0) return null;
  const window = bars.slice(-252);
  return {
    high: Math.max(...window.map((b) => b.high)),
    low: Math.min(...window.map((b) => b.low)),
  };
}

export function recentHigh(bars: Bar[], days: number): number | null {
  if (bars.length === 0) return null;
  return Math.max(...bars.slice(-days).map((b) => b.high));
}

export function recentLow(bars: Bar[], days: number): number | null {
  if (bars.length === 0) return null;
  return Math.min(...bars.slice(-days).map((b) => b.low));
}

/**
 * Simple swing-point based support/resistance: local minima/maxima over a
 * rolling window, clustered to the most recent levels.
 */
export function supportResistance(
  bars: Bar[],
  window = 5,
): { support: number | null; resistance: number | null } {
  if (bars.length < window * 2 + 1) return { support: null, resistance: null };
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const isLow = bars
      .slice(i - window, i + window + 1)
      .every((b) => b.low >= bars[i].low);
    const isHigh = bars
      .slice(i - window, i + window + 1)
      .every((b) => b.high <= bars[i].high);
    if (isLow) lows.push(bars[i].low);
    if (isHigh) highs.push(bars[i].high);
  }
  const price = bars[bars.length - 1].close;
  const support = lows.filter((l) => l < price).sort((a, b) => b - a)[0] ?? null;
  const resistance = highs.filter((h) => h > price).sort((a, b) => a - b)[0] ?? null;
  return { support, resistance };
}

export interface IndicatorSnapshot {
  price: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema8: number | null;
  ema21: number | null;
  rsi14: number | null;
  macd: MacdResult | null;
  vwap: number | null;
  atr14: number | null;
  relativeVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  thirtyDayHigh: number | null;
  thirtyDayLow: number | null;
  swingHigh10: number | null;
  swingLow10: number | null;
  support: number | null;
  resistance: number | null;
}

export function computeIndicators(bars: Bar[]): IndicatorSnapshot | null {
  if (bars.length === 0) return null;
  const closes = bars.map((b) => b.close);
  const range = fiftyTwoWeekRange(bars);
  const sr = supportResistance(bars);
  return {
    price: closes[closes.length - 1],
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    ema8: ema(closes, 8),
    ema21: ema(closes, 21),
    rsi14: rsi(closes, 14),
    macd: macd(closes),
    vwap: vwap(bars.slice(-20)),
    atr14: atr(bars, 14),
    relativeVolume: relativeVolume(bars),
    fiftyTwoWeekHigh: range?.high ?? null,
    fiftyTwoWeekLow: range?.low ?? null,
    thirtyDayHigh: recentHigh(bars, 30),
    thirtyDayLow: recentLow(bars, 30),
    swingHigh10: recentHigh(bars, 10),
    swingLow10: recentLow(bars, 10),
    support: sr.support,
    resistance: sr.resistance,
  };
}

import type { Bar } from "@/lib/types";

/** Generate synthetic daily bars from a list of closes. */
export function barsFromCloses(closes: number[], volume = 1_000_000): Bar[] {
  return closes.map((c, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10),
    open: c * 0.995,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume,
  }));
}

/** Linear trend closes: start -> end over n days. */
export function trendCloses(start: number, end: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1));
}

/** Uptrend with a recent pullback toward the end. */
export function uptrendWithPullback(): number[] {
  const up = trendCloses(100, 150, 60);
  const pullback = trendCloses(150, 142, 8);
  return [...up, ...pullback];
}

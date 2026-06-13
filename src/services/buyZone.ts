import type { Bar, BuyZoneConfig, BuyZoneStatus } from "@/lib/types";

// Buy zone + drawdown logic per spec. Pure functions, fully tested.

export interface BuyZoneEvaluation {
  status: BuyZoneStatus;
  /** % distance from current price to nearest buy-zone edge (negative = below zone). */
  distanceFromBuyZonePercent: number | null;
  explanation: string;
}

/** How far above buy-zone-high counts as "Extended / Risk Elevated". */
const EXTENDED_THRESHOLD = 0.25; // 25% above targetBuyHigh

export function evaluateBuyZone(
  currentPrice: number | null,
  cfg: BuyZoneConfig,
  opts: { catalystsFavorable?: boolean } = {},
): BuyZoneEvaluation {
  if (
    currentPrice == null ||
    !isFinite(currentPrice) ||
    cfg.targetBuyLow == null ||
    cfg.targetBuyHigh == null
  ) {
    return {
      status: "No Buy Zone Set",
      distanceFromBuyZonePercent: null,
      explanation: "Set a target buy range to enable buy-zone tracking.",
    };
  }
  const { targetBuyLow, targetBuyHigh, reinvestAbovePrice } = cfg;

  if (currentPrice >= targetBuyLow && currentPrice <= targetBuyHigh) {
    return {
      status: "In Buy Zone",
      distanceFromBuyZonePercent: 0,
      explanation: `Price ${currentPrice.toFixed(2)} is inside the ${targetBuyLow}–${targetBuyHigh} buy range.`,
    };
  }

  if (currentPrice < targetBuyLow) {
    const dist = ((currentPrice - targetBuyLow) / targetBuyLow) * 100;
    return {
      status: "Below Buy Zone / Falling Knife Risk",
      distanceFromBuyZonePercent: dist,
      explanation: `Price is ${Math.abs(dist).toFixed(1)}% below the buy zone. Falling below your zone can mean the thesis changed — re-check before buying.`,
    };
  }

  // Above buy zone from here on.
  const distAbove = ((currentPrice - targetBuyHigh) / targetBuyHigh) * 100;

  if (reinvestAbovePrice != null && currentPrice > reinvestAbovePrice) {
    if (opts.catalystsFavorable) {
      return {
        status: "Reinvestment Candidate",
        distanceFromBuyZonePercent: distAbove,
        explanation: `Price cleared the reinvest level (${reinvestAbovePrice}) with favorable catalysts/risk.`,
      };
    }
    return {
      status: "Extended / Risk Elevated",
      distanceFromBuyZonePercent: distAbove,
      explanation: `Price is above the reinvest level but catalysts/risk are not favorable — chasing here is risky.`,
    };
  }

  if (distAbove > EXTENDED_THRESHOLD * 100) {
    return {
      status: "Extended / Risk Elevated",
      distanceFromBuyZonePercent: distAbove,
      explanation: `Price is ${distAbove.toFixed(1)}% above the buy zone — overextended.`,
    };
  }

  return {
    status: "Above Buy Zone / Wait",
    distanceFromBuyZonePercent: distAbove,
    explanation: `Price is ${distAbove.toFixed(1)}% above the buy zone. Wait for a pullback.`,
  };
}

export interface DrawdownReport {
  currentPrice: number;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  drawdownFrom52wHighPercent: number | null;
  thirtyDayHigh: number | null;
  drawdownFrom30dHighPercent: number | null;
  drawdownFromAvgCostPercent: number | null; // negative = below cost
  recentLow: number | null;
  recoveryFromRecentLowPercent: number | null;
  trend: "improving" | "worsening" | "flat" | "unknown";
}

export function computeDrawdown(
  bars: Bar[],
  currentPrice: number,
  averageCost?: number | null,
): DrawdownReport {
  const empty: DrawdownReport = {
    currentPrice,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    drawdownFrom52wHighPercent: null,
    thirtyDayHigh: null,
    drawdownFrom30dHighPercent: null,
    drawdownFromAvgCostPercent:
      averageCost && averageCost > 0
        ? ((currentPrice - averageCost) / averageCost) * 100
        : null,
    recentLow: null,
    recoveryFromRecentLowPercent: null,
    trend: "unknown",
  };
  if (bars.length === 0 || !isFinite(currentPrice)) return empty;

  const window52 = bars.slice(-252);
  const high52 = Math.max(...window52.map((b) => b.high));
  const low52 = Math.min(...window52.map((b) => b.low));
  const window30 = bars.slice(-30);
  const high30 = Math.max(...window30.map((b) => b.high));
  const low30 = Math.min(...window30.map((b) => b.low));

  const dd52 = high52 > 0 ? ((currentPrice - high52) / high52) * 100 : null;
  const dd30 = high30 > 0 ? ((currentPrice - high30) / high30) * 100 : null;
  const recovery = low30 > 0 ? ((currentPrice - low30) / low30) * 100 : null;

  // Trend: compare drawdown now vs ~5 bars ago.
  let trend: DrawdownReport["trend"] = "unknown";
  if (bars.length >= 6 && high30 > 0) {
    const prevPrice = bars[bars.length - 6].close;
    const prevDd = ((prevPrice - high30) / high30) * 100;
    const nowDd = dd30 ?? 0;
    if (nowDd > prevDd + 0.5) trend = "improving";
    else if (nowDd < prevDd - 0.5) trend = "worsening";
    else trend = "flat";
  }

  return {
    ...empty,
    fiftyTwoWeekHigh: high52,
    fiftyTwoWeekLow: low52,
    drawdownFrom52wHighPercent: dd52,
    thirtyDayHigh: high30,
    drawdownFrom30dHighPercent: dd30,
    recentLow: low30,
    recoveryFromRecentLowPercent: recovery,
    trend,
  };
}

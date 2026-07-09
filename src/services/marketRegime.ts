import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import { marketConditionScore } from "./tradeScoring";
import { getBars } from "./bars";

// Broad-market regime (roadmap #21). Open trades already weigh a market-condition
// component (SPY vs its 50-day average + RSI); this reuses that exact scoring so
// the *entry* surfaces — the regime banner, Agent Picks, Sector Scout — share one
// read of "is the tape a tailwind or a headwind right now?". Heuristic context,
// not a market call or advice; it never blocks anything on its own.

export type RegimeLabel = "favorable" | "neutral" | "cautious" | "unknown";

export interface MarketRegime {
  score: number; // 1–10 (marketConditionScore of SPY; 10 = strong tape)
  label: RegimeLabel;
  headline: string;
  reasons: string[];
  spyPrice: number | null;
  spySma50: number | null;
}

/** Pure: turn SPY indicators into a labelled regime. Reuses marketConditionScore. */
export function describeRegime(spyInd: IndicatorSnapshot | null): MarketRegime {
  const { score, reasons } = marketConditionScore(spyInd);
  if (!spyInd) {
    return {
      score,
      label: "unknown",
      headline: "Market regime unknown — no SPY data yet",
      reasons,
      spyPrice: null,
      spySma50: null,
    };
  }
  const label: RegimeLabel = score >= 6.5 ? "favorable" : score <= 4.5 ? "cautious" : "neutral";
  const headline =
    spyInd.sma50 == null
      ? `Market regime ${label} (SPY 50-day average unavailable)`
      : `SPY ${spyInd.price > spyInd.sma50 ? "above" : "below"} its 50-day average — ${label}`;
  return { score, label, headline, reasons, spyPrice: spyInd.price, spySma50: spyInd.sma50 };
}

/**
 * Current SPY-based regime from stored bars. SPY is refreshed alongside the
 * watchlist, so bars are normally present; if not, the regime reads "unknown"
 * rather than fetching on a page render.
 */
export function getMarketRegime(): MarketRegime {
  const bars = getBars("SPY");
  return describeRegime(bars.length > 0 ? computeIndicators(bars) : null);
}

/** A "cautious" tape is a headwind for new long entries (regime score ≤ 4.5). */
export function isRegimeCautious(r: MarketRegime): boolean {
  return r.label === "cautious";
}

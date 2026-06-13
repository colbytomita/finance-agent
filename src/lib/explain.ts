import type { BuyZoneStatus } from "./types";

// Pure, testable explanation helpers for the insight popups. No IO.
// These turn stored model output (scores, statuses, reasoning JSON) into the
// short "why" text shown when a user hovers a value.

/** Human explanation of a buy-zone status, derived from the stored status + distance. */
export function buyZoneExplanation(
  status: string | null | undefined,
  distancePct: number | null | undefined,
): string {
  const dist =
    distancePct != null && isFinite(distancePct) ? Math.abs(distancePct).toFixed(1) : null;
  switch (status as BuyZoneStatus) {
    case "In Buy Zone":
      return "Current price is inside your target buy range.";
    case "Below Buy Zone / Falling Knife Risk":
      return dist
        ? `Price is ${dist}% below your buy zone. Falling below the zone can mean the thesis changed — re-check before buying.`
        : "Price is below your buy zone — re-check the thesis before buying.";
    case "Above Buy Zone / Wait":
      return dist
        ? `Price is ${dist}% above your buy zone. Wait for a pullback into the range.`
        : "Price is above your buy zone — wait for a pullback.";
    case "Reinvestment Candidate":
      return "Price cleared your reinvest level with favorable catalysts/risk.";
    case "Extended / Risk Elevated":
      return dist
        ? `Price is ${dist}% above the zone — overextended; chasing here is risky.`
        : "Price is well above the zone — overextended.";
    case "No Buy Zone Set":
    default:
      return "No target buy range set — add one to enable buy-zone tracking.";
  }
}

/** Explains how a stock recommendation follows from the overall score bands. */
export function explainStockRecommendation(score: number | null | undefined): string {
  const s = score != null && isFinite(score) ? score.toFixed(1) : "—";
  return `Derived from the overall stock score (${s}/10). Bands: ≥9 Strong Buy Candidate · ≥7 Buy Candidate · ≥5 Watch/Hold · ≥3 Avoid/Risk Elevated · <3 Strong Avoid.`;
}

/** Explains how a trade recommendation follows from the trade-score bands + hard rules. */
export function explainTradeRecommendation(score: number | null | undefined): string {
  const s = score != null && isFinite(score) ? score.toFixed(1) : "—";
  return `Based on the trade score (${s}/10) plus hard exit/trim rules. Bands: ≥9 Strong Hold/Add · ≥7 Hold · ≥5 Monitor · ≥3 Trim/Prepare Exit · <3 Exit. Hard rules (stop hit, thesis invalidated, etc.) can override the band.`;
}

/** Parsed stock-score reasoning: component name → list of reason strings. */
export function parseReasoning(json: string | null | undefined): Record<string, string[]> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    return obj && typeof obj === "object" ? (obj as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export interface TradeReasoning {
  components?: Record<string, number>;
  reasons?: string[];
  exit?: string[];
  trim?: string[];
}

/** Parsed trade-score reasoning persisted by recomputeTradeScores. */
export function parseTradeReasoning(json: string | null | undefined): TradeReasoning {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    return obj && typeof obj === "object" ? (obj as TradeReasoning) : {};
  } catch {
    return {};
  }
}

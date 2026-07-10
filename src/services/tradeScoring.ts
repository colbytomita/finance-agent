import type {
  Confidence,
  Recommendation,
  TradeRecommendationLabel,
  TradeScoreComponents,
} from "@/lib/types";
import type { IndicatorSnapshot } from "./indicators";
import { clampScore, type CatalystInput, catalystScore } from "./scoring";

// Active swing-trade score (1–10).
// tradeScore = technical*0.30 + momentum*0.20 + catalyst*0.20 +
//              riskReward*0.15 + marketCondition*0.10 + thesisValidity*0.05

export interface TradeScoreWeights {
  technical: number;
  momentum: number;
  catalyst: number;
  riskReward: number;
  marketCondition: number;
  thesisValidity: number;
}

export const DEFAULT_TRADE_WEIGHTS: TradeScoreWeights = {
  technical: 0.3,
  momentum: 0.2,
  catalyst: 0.2,
  riskReward: 0.15,
  marketCondition: 0.1,
  thesisValidity: 0.05,
};

export function combineTradeScore(
  c: TradeScoreComponents,
  w: TradeScoreWeights = DEFAULT_TRADE_WEIGHTS,
): number {
  const total =
    c.technicalScore * w.technical +
    c.momentumScore * w.momentum +
    c.catalystScore * w.catalyst +
    c.riskRewardScore * w.riskReward +
    c.marketConditionScore * w.marketCondition +
    c.thesisValidityScore * w.thesisValidity;
  const weightSum =
    w.technical + w.momentum + w.catalyst + w.riskReward + w.marketCondition + w.thesisValidity;
  if (weightSum <= 0) return 5; // defensive: all-zero weights → neutral, never NaN
  return clampScore(Math.round((total / weightSum) * 10) / 10);
}

export function tradeRecommendationLabel(score: number): TradeRecommendationLabel {
  if (score >= 9) return "Strong Hold / Consider Add";
  if (score >= 7) return "Hold";
  if (score >= 5) return "Monitor Closely";
  if (score >= 3) return "Trim / Prepare Exit";
  return "Exit";
}

export interface TradeContext {
  direction: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  targetPrice1: number | null;
  targetPrice2: number | null;
  thesis?: string | null;
  thesisInvalidated?: boolean;
  daysHeld?: number;
  daysToEarnings?: number | null;
  positionWeightPercent?: number | null; // % of account in this position
}

export interface TradeEvaluation {
  tradeScore: number;
  components: TradeScoreComponents;
  /** Effective weights used (catalyst is 0 when there are no current catalysts). */
  weightsUsed: TradeScoreWeights;
  label: TradeRecommendationLabel;
  action: Recommendation;
  hardRulesTriggered: string[];
  trimReasons: string[];
  addBlockers: string[];
  reasons: string[];
  confidence: Confidence;
}

// --- Component scores -------------------------------------------------------

export function technicalScore(
  ind: IndicatorSnapshot | null,
  trade: TradeContext,
): { score: number; reasons: string[] } {
  if (!ind) return { score: 5, reasons: ["No price history — neutral technicals."] };
  let score = 5.5;
  const reasons: string[] = [];
  const { price, ema21, sma50, support, resistance, swingLow10 } = ind;
  const long = trade.direction === "long";

  if (ema21 != null) {
    const above = price > ema21;
    if (above === long) {
      score += 1;
      reasons.push(long ? "Holding above 21-EMA trend support." : "Below 21-EMA (good for short).");
    } else {
      score -= 1;
      reasons.push(long ? "Lost the 21-EMA — trend weakening." : "Reclaimed 21-EMA against short.");
    }
  }
  if (sma50 != null) {
    const above = price > sma50;
    if (above === long) score += 0.5;
    else score -= 0.5;
  }
  if (long && support != null) {
    if (price < support) {
      score -= 2;
      reasons.push("Price broke below the nearest support level.");
    } else {
      const cushion = ((price - support) / price) * 100;
      if (cushion < 2) reasons.push("Sitting right on support — watch closely.");
      else score += 0.5;
    }
  }
  if (long && swingLow10 != null && price < swingLow10) {
    score -= 1;
    reasons.push("Price undercut the 10-day swing low.");
  }
  if (long && resistance != null && resistance > price) {
    const room = ((resistance - price) / price) * 100;
    if (room < 1.5) {
      score -= 0.5;
      reasons.push("Right under resistance — limited immediate upside.");
    }
  }
  return { score: clampScore(score), reasons };
}

export function tradeMomentumScore(
  ind: IndicatorSnapshot | null,
  direction: "long" | "short" = "long",
): {
  score: number;
  reasons: string[];
} {
  if (!ind) return { score: 5, reasons: ["No momentum data."] };
  // For a short, favorable momentum is the mirror image: falling EMAs, weak
  // RSI, negative MACD histogram. Long behavior is unchanged.
  const long = direction === "long";
  let score = 5.5;
  const reasons: string[] = [];
  if (ind.ema8 != null && ind.ema21 != null) {
    const rising = ind.ema8 > ind.ema21;
    if (rising === long) score += 1;
    else {
      score -= 1;
      reasons.push(
        long
          ? "Short-term momentum rolled over (EMA8 < EMA21)."
          : "Short-term momentum turned up against the short (EMA8 > EMA21).",
      );
    }
  }
  if (ind.rsi14 != null) {
    // Mirror RSI for shorts so "strong" means "moving the trade's way".
    const r = long ? ind.rsi14 : 100 - ind.rsi14;
    if (r >= 55 && r <= 70) score += 1;
    else if (r > 70) {
      score += 0.25;
      reasons.push(
        long
          ? "RSI overbought — momentum strong but stretched."
          : "RSI deeply oversold — short working but stretched.",
      );
    } else if (r < 45) {
      score -= 1;
      reasons.push(long ? "RSI weak (<45)." : "RSI strengthening against the short.");
    }
  }
  if (ind.macd) {
    const favorable = long ? ind.macd.histogram > 0 : ind.macd.histogram < 0;
    if (favorable) score += 0.75;
    else {
      score -= 0.75;
      reasons.push(long ? "MACD histogram negative." : "MACD histogram positive — against the short.");
    }
  }
  if (ind.relativeVolume != null && ind.relativeVolume > 1.5) {
    reasons.push(`Volume ${ind.relativeVolume.toFixed(1)}x average.`);
  }
  return { score: clampScore(score), reasons };
}

/** Risk/reward of REMAINING move: (target − price) / (price − stop). */
export function riskRewardScore(trade: TradeContext): {
  score: number;
  ratio: number | null;
  reasons: string[];
} {
  const { currentPrice, stopLoss, targetPrice1, direction } = trade;
  if (stopLoss == null || targetPrice1 == null) {
    return { score: 4, ratio: null, reasons: ["No stop or target set — risk/reward unclear."] };
  }
  const long = direction === "long";
  const risk = long ? currentPrice - stopLoss : stopLoss - currentPrice;
  const reward = long ? targetPrice1 - currentPrice : currentPrice - targetPrice1;
  if (risk <= 0) {
    // Stop already breached — hard exit rule will catch this.
    return { score: 1, ratio: null, reasons: ["Price is at/through the stop-loss."] };
  }
  if (reward <= 0) {
    return {
      score: 5,
      ratio: 0,
      reasons: ["Target 1 reached — remaining reward on this leg is exhausted."],
    };
  }
  const ratio = reward / risk;
  let score: number;
  if (ratio >= 3) score = 9;
  else if (ratio >= 2) score = 7.5;
  else if (ratio >= 1.5) score = 6;
  else if (ratio >= 1) score = 4.5;
  else score = 3;
  return {
    score,
    ratio,
    reasons: [`Remaining risk/reward ≈ ${ratio.toFixed(1)}:1.`],
  };
}

export function marketConditionScore(spyInd: IndicatorSnapshot | null): {
  score: number;
  reasons: string[];
} {
  if (!spyInd) return { score: 5.5, reasons: ["Market condition unknown — neutral."] };
  let score = 5.5;
  const reasons: string[] = [];
  if (spyInd.sma50 != null) {
    if (spyInd.price > spyInd.sma50) {
      score += 1.5;
      reasons.push("Broad market above its 50-day average.");
    } else {
      score -= 1.5;
      reasons.push("Broad market below its 50-day average — headwind.");
    }
  }
  if (spyInd.rsi14 != null && spyInd.rsi14 < 35) {
    score -= 1;
    reasons.push("Broad market oversold/volatile.");
  }
  return { score: clampScore(score), reasons };
}

export function thesisValidityScore(trade: TradeContext): {
  score: number;
  reasons: string[];
} {
  if (trade.thesisInvalidated) {
    return { score: 1, reasons: ["Original thesis marked invalidated."] };
  }
  if (!trade.thesis) {
    return { score: 5, reasons: ["No thesis recorded — cannot verify validity."] };
  }
  return { score: 8, reasons: ["Thesis on record and not invalidated."] };
}

// --- Hard rules --------------------------------------------------------------

export interface HardRuleInput {
  trade: TradeContext;
  indicators: IndicatorSnapshot | null;
  catalysts: CatalystInput[];
  tradeScore: number;
  avoidEarningsWithinDays: number;
}

/** Hard exit rules override the score. Returns reasons; empty = no override. */
export function hardExitRules(input: HardRuleInput): string[] {
  const { trade, indicators, catalysts, tradeScore, avoidEarningsWithinDays } = input;
  const reasons: string[] = [];
  const long = trade.direction === "long";

  if (trade.stopLoss != null) {
    const hit = long
      ? trade.currentPrice <= trade.stopLoss
      : trade.currentPrice >= trade.stopLoss;
    if (hit) reasons.push("Stop-loss hit.");
  }
  if (trade.thesisInvalidated) reasons.push("Original thesis invalidated.");
  const majorNegative = catalysts.some(
    (c) => c.status !== "expired" && c.impactScore <= -4,
  );
  if (majorNegative) reasons.push("Major negative catalyst detected.");
  if (long && indicators?.support != null && trade.currentPrice < indicators.support) {
    reasons.push("Price broke critical support.");
  }
  const rr = riskRewardScore(trade);
  if (rr.ratio != null && rr.ratio > 0 && rr.ratio < 0.5) {
    reasons.push("Risk/reward deteriorated below 0.5:1.");
  }
  if (tradeScore < 3) reasons.push("Trade score fell below 3.");
  if (
    avoidEarningsWithinDays > 0 &&
    trade.daysToEarnings != null &&
    trade.daysToEarnings >= 0 &&
    trade.daysToEarnings <= avoidEarningsWithinDays
  ) {
    reasons.push(
      `Earnings in ${trade.daysToEarnings} day(s) — event risk exceeds your settings.`,
    );
  }
  return reasons;
}

export function trimRules(input: {
  trade: TradeContext;
  indicators: IndicatorSnapshot | null;
  catalysts: CatalystInput[];
  tradeScore: number;
  previousScore?: number | null;
  maxPositionWeightPercent: number;
}): string[] {
  const { trade, indicators, catalysts, tradeScore, previousScore, maxPositionWeightPercent } =
    input;
  const reasons: string[] = [];
  const long = trade.direction === "long";

  if (trade.targetPrice1 != null) {
    const hit = long
      ? trade.currentPrice >= trade.targetPrice1
      : trade.currentPrice <= trade.targetPrice1;
    if (hit) reasons.push("Target 1 reached — consider taking partial profits.");
  }
  if (previousScore != null && previousScore >= 8 && tradeScore < 6.5) {
    reasons.push("Trade score fell from strong to neutral.");
  }
  // Overextension in the trade's direction: RSI > 78 for longs, < 22 for shorts.
  if (indicators?.rsi14 != null && (long ? indicators.rsi14 > 78 : indicators.rsi14 < 22)) {
    reasons.push(long ? "Stock is overextended (RSI > 78)." : "Move is overextended (RSI < 22).");
  }
  const rr = riskRewardScore(trade);
  if (rr.ratio != null && rr.ratio > 0 && rr.ratio < 1) {
    reasons.push("Remaining risk/reward below 1:1.");
  }
  if (
    trade.daysToEarnings != null &&
    trade.daysToEarnings >= 0 &&
    trade.daysToEarnings <= 7
  ) {
    reasons.push(`Major event risk approaching (earnings in ${trade.daysToEarnings}d).`);
  }
  if (
    trade.positionWeightPercent != null &&
    trade.positionWeightPercent > maxPositionWeightPercent
  ) {
    reasons.push(
      `Position is ${trade.positionWeightPercent.toFixed(0)}% of the account — above your ${maxPositionWeightPercent}% cap.`,
    );
  }
  const gainPct = long
    ? ((trade.currentPrice - trade.entryPrice) / trade.entryPrice) * 100
    : ((trade.entryPrice - trade.currentPrice) / trade.entryPrice) * 100;
  const catalystsWeakening =
    catalysts.length > 0 &&
    catalysts.filter((c) => c.status !== "expired" && c.impactScore < 0).length >
      catalysts.filter((c) => c.status !== "expired" && c.impactScore > 0).length;
  if (gainPct > 15 && catalystsWeakening) {
    reasons.push("Strong profit but catalysts are weakening.");
  }
  return reasons;
}

export function addBlockers(input: {
  trade: TradeContext;
  indicators: IndicatorSnapshot | null;
  catalysts: CatalystInput[];
  tradeScore: number;
  riskScoreValue: number; // 1-10, 10 = low risk
  maxPositionWeightPercent: number;
  inBuyZone?: boolean;
  belowBuyZone?: boolean;
}): string[] {
  const {
    trade,
    indicators,
    catalysts,
    tradeScore,
    riskScoreValue,
    maxPositionWeightPercent,
    belowBuyZone,
  } = input;
  const blockers: string[] = [];

  const long = trade.direction === "long";
  if (tradeScore < 8) blockers.push("Trade score below 8.");
  if (belowBuyZone) blockers.push("Price is below the buy zone.");
  if (indicators) {
    // Trend-side check in the trade's direction: a long shouldn't add below
    // the 21-EMA; a short shouldn't add above it.
    if (indicators.ema21 != null && (long ? indicators.price < indicators.ema21 : indicators.price > indicators.ema21)) {
      blockers.push(long ? "Price below key trend support (21-EMA)." : "Price above the 21-EMA — against the short.");
    }
    if (
      indicators.ema8 != null &&
      indicators.ema21 != null &&
      (long ? indicators.ema8 < indicators.ema21 : indicators.ema8 > indicators.ema21)
    ) {
      blockers.push(long ? "Momentum is negative." : "Momentum has turned up against the short.");
    }
    if (indicators.relativeVolume != null && indicators.relativeVolume < 0.8) {
      blockers.push("Volume does not confirm momentum.");
    }
    // Too extended in the trade's direction to add safely.
    if (
      indicators.ema21 != null &&
      (long ? indicators.price > indicators.ema21 * 1.1 : indicators.price < indicators.ema21 * 0.9)
    ) {
      blockers.push(long ? "Too extended above the 21-EMA." : "Too extended below the 21-EMA.");
    }
  } else {
    blockers.push("No technical data to confirm an add.");
  }
  const cat = catalystScore(catalysts);
  if (cat.score < 5.5) blockers.push("Catalyst score is not positive.");
  if (riskScoreValue < 5) blockers.push("Risk score unacceptable.");
  if (
    trade.daysToEarnings != null &&
    trade.daysToEarnings >= 0 &&
    trade.daysToEarnings <= 7
  ) {
    blockers.push("Earnings risk is high.");
  }
  if (trade.thesisInvalidated) blockers.push("Original thesis is weakening/invalidated.");
  if (
    trade.positionWeightPercent != null &&
    trade.positionWeightPercent >= maxPositionWeightPercent
  ) {
    blockers.push("Position concentration too high already.");
  }
  return blockers;
}

// --- Full evaluation ---------------------------------------------------------

export function evaluateTrade(input: {
  trade: TradeContext;
  indicators: IndicatorSnapshot | null;
  marketIndicators?: IndicatorSnapshot | null;
  catalysts: CatalystInput[];
  weights?: TradeScoreWeights;
  previousScore?: number | null;
  riskScoreValue?: number;
  avoidEarningsWithinDays?: number;
  maxPositionWeightPercent?: number;
}): TradeEvaluation {
  const {
    trade,
    indicators,
    marketIndicators = null,
    catalysts,
    weights,
    previousScore = null,
    riskScoreValue = 6,
    avoidEarningsWithinDays = 3,
    maxPositionWeightPercent = 20,
  } = input;

  const tech = technicalScore(indicators, trade);
  const mom = tradeMomentumScore(indicators, trade.direction);
  const cat = catalystScore(catalysts);
  const rr = riskRewardScore(trade);
  const mkt = marketConditionScore(marketIndicators);
  const thesis = thesisValidityScore(trade);

  const components: TradeScoreComponents = {
    technicalScore: tech.score,
    momentumScore: mom.score,
    catalystScore: cat.score,
    riskRewardScore: rr.score,
    marketConditionScore: mkt.score,
    thesisValidityScore: thesis.score,
  };
  // With no current catalysts, the catalyst component is a neutral no-data value;
  // drop it from the blend (weight 0) so it doesn't drag the trade score. The
  // weight-sum normalization in combineTradeScore redistributes automatically.
  const baseTradeWeights = weights ?? DEFAULT_TRADE_WEIGHTS;
  const weightsUsed: TradeScoreWeights =
    catalysts.length > 0 ? baseTradeWeights : { ...baseTradeWeights, catalyst: 0 };
  const score = combineTradeScore(components, weightsUsed);
  const label = tradeRecommendationLabel(score);

  const exitReasons = hardExitRules({
    trade,
    indicators,
    catalysts,
    tradeScore: score,
    avoidEarningsWithinDays,
  });
  const trimReasons = trimRules({
    trade,
    indicators,
    catalysts,
    tradeScore: score,
    previousScore,
    maxPositionWeightPercent,
  });
  const blockers = addBlockers({
    trade,
    indicators,
    catalysts,
    tradeScore: score,
    riskScoreValue,
    maxPositionWeightPercent,
  });

  // Action resolution: hard exits first, then trim, then add, then score label.
  let action: Recommendation;
  if (exitReasons.length > 0) action = "Exit";
  else if (trimReasons.length > 0 && score < 8.5) action = "Trim";
  else if (score >= 8 && blockers.length === 0) action = "Add";
  else if (score >= 5) action = "Hold";
  else action = "Trim";

  const dataPoints = [indicators != null, catalysts.length > 0, trade.stopLoss != null].filter(
    Boolean,
  ).length;
  const confidence: Confidence =
    dataPoints >= 3 ? "high" : dataPoints === 2 ? "medium" : "low";

  return {
    tradeScore: score,
    components,
    weightsUsed,
    label,
    action,
    hardRulesTriggered: exitReasons,
    trimReasons,
    addBlockers: blockers,
    reasons: [
      ...tech.reasons,
      ...mom.reasons,
      ...cat.reasons,
      ...rr.reasons,
      ...mkt.reasons,
      ...thesis.reasons,
    ],
    confidence,
  };
}

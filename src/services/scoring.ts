import type {
  Confidence,
  ScoreComponents,
  StockRecommendationLabel,
} from "@/lib/types";
import type { IndicatorSnapshot } from "./indicators";
import type { DrawdownReport } from "./buyZone";

// Stock attractiveness score (1–10).
// stockScore = valuation*0.20 + momentum*0.20 + catalyst*0.25 + risk*0.25 + sentiment*0.10
// All component scores are 1–10 where 10 is most attractive
// (i.e. riskScore 10 = LOW risk).

export interface StockScoreWeights {
  valuation: number;
  momentum: number;
  catalyst: number;
  risk: number;
  sentiment: number;
}

export const DEFAULT_STOCK_WEIGHTS: StockScoreWeights = {
  valuation: 0.2,
  momentum: 0.2,
  catalyst: 0.25,
  risk: 0.25,
  sentiment: 0.1,
};

export const clampScore = (v: number): number => Math.min(10, Math.max(1, v));

export function combineStockScore(
  c: ScoreComponents,
  w: StockScoreWeights = DEFAULT_STOCK_WEIGHTS,
): number {
  const total =
    c.valuationScore * w.valuation +
    c.momentumScore * w.momentum +
    c.catalystScore * w.catalyst +
    c.riskScore * w.risk +
    c.sentimentScore * w.sentiment;
  const weightSum = w.valuation + w.momentum + w.catalyst + w.risk + w.sentiment;
  return clampScore(Math.round((total / weightSum) * 10) / 10);
}

export function stockRecommendationLabel(score: number): StockRecommendationLabel {
  if (score >= 9) return "Strong Buy Candidate";
  if (score >= 7) return "Buy Candidate";
  if (score >= 5) return "Watch / Hold";
  if (score >= 3) return "Avoid / Risk Elevated";
  return "Strong Avoid";
}

// ---------------------------------------------------------------------------
// Component score derivation from available data. Each returns 1–10 plus the
// reasons used, so the UI can answer "why did this score change?".

export interface ComponentResult {
  score: number;
  reasons: string[];
}

/**
 * Momentum from price vs moving averages, RSI regime, and MACD.
 * Neutral 5.5 when data is missing.
 */
export function momentumScore(ind: IndicatorSnapshot | null): ComponentResult {
  if (!ind) return { score: 5.5, reasons: ["No price history — neutral momentum."] };
  let score = 5.5;
  const reasons: string[] = [];
  const { price, sma20, sma50, sma200, ema8, ema21, rsi14 } = ind;

  if (sma50 != null) {
    if (price > sma50) {
      score += 1;
      reasons.push("Price above 50-day average (uptrend).");
    } else {
      score -= 1;
      reasons.push("Price below 50-day average (downtrend).");
    }
  }
  if (sma200 != null) {
    if (price > sma200) {
      score += 1;
      reasons.push("Price above 200-day average (long-term uptrend).");
    } else {
      score -= 1;
      reasons.push("Price below 200-day average (long-term weakness).");
    }
  }
  if (sma20 != null && sma50 != null) {
    if (sma20 > sma50) score += 0.5;
    else score -= 0.5;
  }
  if (ema8 != null && ema21 != null) {
    if (ema8 > ema21) {
      score += 0.5;
      reasons.push("Short-term trend is up (EMA8 > EMA21).");
    } else {
      score -= 0.5;
      reasons.push("Short-term trend is down (EMA8 < EMA21).");
    }
  }
  if (rsi14 != null) {
    if (rsi14 > 70) {
      score -= 0.5;
      reasons.push(`RSI ${rsi14.toFixed(0)} — overbought.`);
    } else if (rsi14 < 30) {
      score -= 0.5;
      reasons.push(`RSI ${rsi14.toFixed(0)} — oversold/weak.`);
    } else if (rsi14 >= 50) {
      score += 0.5;
      reasons.push(`RSI ${rsi14.toFixed(0)} — healthy momentum.`);
    }
  }
  if (ind.macd) {
    if (ind.macd.histogram > 0) score += 0.5;
    else score -= 0.5;
  }
  return { score: clampScore(score), reasons };
}

/**
 * Valuation proxy from drawdown position. Without fundamental data feeds the
 * MVP treats "discount vs its own range" as the valuation signal. Clearly a
 * heuristic — labelled as such in reasons.
 */
export function valuationScore(dd: DrawdownReport | null): ComponentResult {
  if (!dd || dd.drawdownFrom52wHighPercent == null) {
    return { score: 5.5, reasons: ["No range data — neutral valuation (heuristic)."] };
  }
  const ddPct = dd.drawdownFrom52wHighPercent; // negative number
  let score: number;
  if (ddPct >= -5) score = 4.5; // near highs = paying up
  else if (ddPct >= -15) score = 6;
  else if (ddPct >= -30) score = 7;
  else if (ddPct >= -50) score = 6; // deep discount but riskier
  else score = 4.5; // possible broken story
  return {
    score: clampScore(score),
    reasons: [
      `Trading ${Math.abs(ddPct).toFixed(1)}% below 52-week high (range-based heuristic, not fundamental valuation).`,
    ],
  };
}

/**
 * Catalyst score from upcoming/recent catalysts.
 * Inputs: impactScore -5..+5 each, weighted by confidence.
 */
export interface CatalystInput {
  impactScore: number; // -5..+5
  confidence: Confidence;
  status: string; // upcoming | occurred | expired
  title?: string;
}

const CONF_WEIGHT: Record<Confidence, number> = { low: 0.4, medium: 0.7, high: 1 };

export function catalystScore(catalystsIn: CatalystInput[]): ComponentResult {
  const active = catalystsIn.filter((c) => c.status !== "expired");
  if (active.length === 0) {
    return { score: 5, reasons: ["No tracked catalysts — neutral."] };
  }
  let weighted = 0;
  let weightSum = 0;
  for (const c of active) {
    const w = CONF_WEIGHT[c.confidence] ?? 0.4;
    weighted += c.impactScore * w;
    weightSum += w;
  }
  const avg = weightSum > 0 ? weighted / weightSum : 0; // -5..+5
  const score = clampScore(5.5 + avg * 0.9);
  const pos = active.filter((c) => c.impactScore > 0).length;
  const neg = active.filter((c) => c.impactScore < 0).length;
  return {
    score,
    reasons: [
      `${active.length} tracked catalyst(s): ${pos} positive, ${neg} negative (confidence-weighted).`,
    ],
  };
}

/**
 * Risk score (10 = low risk). Penalizes high volatility (ATR%), deep
 * worsening drawdowns, and negative catalysts.
 */
export function riskScore(
  ind: IndicatorSnapshot | null,
  dd: DrawdownReport | null,
  catalystsIn: CatalystInput[] = [],
): ComponentResult {
  let score = 7;
  const reasons: string[] = [];
  if (ind?.atr14 != null && ind.price > 0) {
    const atrPct = (ind.atr14 / ind.price) * 100;
    if (atrPct > 6) {
      score -= 2.5;
      reasons.push(`Very high volatility (ATR ${atrPct.toFixed(1)}% of price).`);
    } else if (atrPct > 4) {
      score -= 1.5;
      reasons.push(`High volatility (ATR ${atrPct.toFixed(1)}%).`);
    } else if (atrPct > 2.5) {
      score -= 0.5;
      reasons.push(`Moderate volatility (ATR ${atrPct.toFixed(1)}%).`);
    } else {
      reasons.push(`Low volatility (ATR ${atrPct.toFixed(1)}%).`);
    }
  } else {
    score -= 1;
    reasons.push("Volatility unknown — risk uncertain.");
  }
  if (dd?.drawdownFrom52wHighPercent != null) {
    if (dd.drawdownFrom52wHighPercent < -40) {
      score -= 1.5;
      reasons.push("Deep drawdown from 52-week high.");
    }
    if (dd.trend === "worsening") {
      score -= 1;
      reasons.push("Drawdown is worsening.");
    } else if (dd.trend === "improving") {
      score += 0.5;
      reasons.push("Drawdown is improving.");
    }
  }
  const strongNegative = catalystsIn.filter(
    (c) => c.status !== "expired" && c.impactScore <= -3,
  );
  if (strongNegative.length > 0) {
    score -= 1.5;
    reasons.push(`${strongNegative.length} strong negative catalyst(s) pending.`);
  }
  return { score: clampScore(score), reasons };
}

/** Sentiment from analyst-action + news catalysts; neutral without data. */
export function sentimentScore(catalystsIn: CatalystInput[]): ComponentResult {
  if (catalystsIn.length === 0) {
    return { score: 5.5, reasons: ["No sentiment signals — neutral."] };
  }
  const avg =
    catalystsIn.reduce((a, c) => a + c.impactScore, 0) / catalystsIn.length;
  return {
    score: clampScore(5.5 + avg * 0.6),
    reasons: [`Average catalyst tone ${avg >= 0 ? "positive" : "negative"} (${avg.toFixed(1)}).`],
  };
}

export interface StockScoreResult {
  overallScore: number;
  components: ScoreComponents;
  recommendation: StockRecommendationLabel;
  confidence: Confidence;
  reasoning: Record<string, string[]>;
}

export function scoreStock(input: {
  indicators: IndicatorSnapshot | null;
  drawdown: DrawdownReport | null;
  catalysts: CatalystInput[];
  weights?: StockScoreWeights;
}): StockScoreResult {
  const m = momentumScore(input.indicators);
  const v = valuationScore(input.drawdown);
  const c = catalystScore(input.catalysts);
  const r = riskScore(input.indicators, input.drawdown, input.catalysts);
  const s = sentimentScore(input.catalysts);

  const components: ScoreComponents = {
    valuationScore: v.score,
    momentumScore: m.score,
    catalystScore: c.score,
    riskScore: r.score,
    sentimentScore: s.score,
  };
  const overall = combineStockScore(components, input.weights);

  // Confidence reflects data completeness, never certainty about outcomes.
  const dataPoints = [
    input.indicators != null,
    input.drawdown != null,
    input.catalysts.length > 0,
  ].filter(Boolean).length;
  const confidence: Confidence =
    dataPoints >= 3 ? "high" : dataPoints === 2 ? "medium" : "low";

  return {
    overallScore: overall,
    components,
    recommendation: stockRecommendationLabel(overall),
    confidence,
    reasoning: {
      momentum: m.reasons,
      valuation: v.reasons,
      catalyst: c.reasons,
      risk: r.reasons,
      sentiment: s.reasons,
    },
  };
}

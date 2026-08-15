import type {
  Confidence,
  ScoreComponents,
  StockRecommendationLabel,
} from "@/lib/types";
import { isSameUtcDay } from "@/lib/util";
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

/**
 * Blend weights. `sentiment` carries **0** since roadmap #67: it is derived from
 * the same catalyst inputs as `catalystScore`, so it was ~collinear with it while
 * contributing 0.19 points of possible movement at weight 0.10 — it could not
 * change a recommendation under any circumstance. Its weight was folded into
 * catalyst. The component is still computed and displayed, just not blended.
 */
export const DEFAULT_STOCK_WEIGHTS: StockScoreWeights = {
  valuation: 0.2,
  momentum: 0.2,
  catalyst: 0.35,
  risk: 0.25,
  sentiment: 0,
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
  if (weightSum <= 0) return 5; // defensive: all-zero weights → neutral, never NaN
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
  const reasons = [
    `Trading ${Math.abs(ddPct).toFixed(1)}% below 52-week high (range-based heuristic, not fundamental valuation).`,
  ];
  // A discount that has already started recovering is the value sweet spot. The
  // flat lookup above topped out at 7.0, which helped make the 9-10 band
  // unreachable; the recovery bonus lets a genuinely well-priced name reach 8.5.
  if (dd.trend === "improving" && ddPct < -15 && ddPct >= -50) {
    score += 1.5;
    reasons.push("Discount is already recovering.");
  }
  return { score: clampScore(score), reasons };
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

/** How many recent directional catalysts the score considers (roadmap #67). */
export const CATALYST_SCORING_WINDOW = 30;

/**
 * The catalysts that should actually drive a SCORE, as opposed to the full set
 * shown on the stock page timeline.
 *
 * Two filters, both measured against the real database:
 *  - **Impact 0 is dropped.** 6,616 of 8,991 stored catalysts (74%) are neutral
 *    `yahoo-news` items. They carry no direction, but because the score is a
 *    *mean*, hundreds of them averaged real signals into nothing: NVDA's mean
 *    impact over everything was 0.31 versus 1.09 over directional items alone.
 *  - **Only the most recent N.** Mega-caps accumulate 300+ rows; without a
 *    window a stale backlog outvotes what just happened.
 *
 * Consequence worth knowing: a ticker whose catalysts are ALL neutral returns []
 * here, so `scoreStock` treats it as having no catalysts and redistributes the
 * catalyst weight — which is right. Neutral news is an absence of signal, not a
 * neutral signal, and it should not drag a score toward the middle.
 */
export function directionalCatalysts<T extends { impactScore: number }>(
  catalysts: T[],
  limit = CATALYST_SCORING_WINDOW,
): T[] {
  return catalysts.filter((c) => c.impactScore !== 0).slice(-limit);
}

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
  // Gain raised 0.9 -> 1.6 with #67: now that neutral news no longer dilutes the
  // mean, the surviving average is both smaller in count and larger in size, and
  // the component needs the range to actually express it (measured span 1.09 ->
  // 3.58 across the tracked universe).
  const score = clampScore(5.5 + avg * 1.6);
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
  // Two-sided, but anchored so the TYPICAL stock is unaffected. This used to
  // start at 7 and only subtract, capping it at 7.5 and (with valuationScore's
  // 7.0 cap) making the 9-10 band arithmetically unreachable. The penalties are
  // unchanged; genuinely calm names now earn a bonus instead of merely avoiding
  // one. NOTE: re-basing to 5.5 was tried and measured — it pushed the median
  // stock DOWN (Buy 17 -> 7, Watch/Hold 29 -> 38 across the live watchlist) and
  // compressed the spread further. Keep the base at 7.
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
    } else if (atrPct > 1.5) {
      score += 0.5;
      reasons.push(`Low volatility (ATR ${atrPct.toFixed(1)}%).`);
    } else {
      score += 1.5;
      reasons.push(`Very low volatility (ATR ${atrPct.toFixed(1)}% of price).`);
    }
  } else {
    score -= 1;
    reasons.push("Volatility unknown — risk uncertain.");
  }
  if (dd?.drawdownFrom52wHighPercent != null) {
    if (dd.drawdownFrom52wHighPercent < -40) {
      score -= 1.5;
      reasons.push("Deep drawdown from 52-week high.");
    } else if (dd.drawdownFrom52wHighPercent > -10) {
      score += 0.5;
      reasons.push("Holding near its 52-week high — structurally intact.");
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
  // Match catalystScore: expired events don't shape current sentiment.
  // (getCatalystInputs pre-filters these; this keeps direct callers safe too.)
  const active = catalystsIn.filter((c) => c.status !== "expired");
  if (active.length === 0) {
    return { score: 5.5, reasons: ["No sentiment signals — neutral."] };
  }
  const avg = active.reduce((a, c) => a + c.impactScore, 0) / active.length;
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
  /** Effective weights actually used in the blend (catalyst/sentiment are 0 when
   *  there are no current catalysts so missing data doesn't drag the score). */
  weightsUsed: StockScoreWeights;
}

// Earnings surprise is applied as a bounded nudge on top of the blended score
// (rather than a catalyst input) so it's monotonic — a beat only ever helps, a
// miss only ever hurts — and a weak/old surprise can't dilute strong technicals.
const EARNINGS_SCALE = 0.25; // score points per impact point
const MAX_EARNINGS_ADJ = 1.2; // cap the nudge either way

// When a fundamentals read is supplied (discovery / Sector Scout), the overall
// score is fundamentals-LED: company quality/value dominates and the technical
// blend becomes a supporting/timing signal. So a strong chart on a weak or
// declining business won't surface as a buy. Tunable.
const FUNDAMENTALS_WEIGHT = 0.6;

export function scoreStock(input: {
  indicators: IndicatorSnapshot | null;
  drawdown: DrawdownReport | null;
  catalysts: CatalystInput[];
  weights?: StockScoreWeights;
  /** Latest earnings surprise as a -5..+5 impact plus a human reason. */
  earnings?: { impact: number; reason: string } | null;
  /** Fundamentals read (1–10 quality/value) — when present, it leads the score. */
  fundamentals?: { score: number; reasons: string[] } | null;
}): StockScoreResult {
  // The SCORING feed, distinct from the display timeline: neutral news is
  // excluded and only the recent window counts (roadmap #67). Every
  // catalyst-derived component reads the same feed so they cannot disagree about
  // what "has catalysts" means.
  const scoringCatalysts = directionalCatalysts(input.catalysts);

  const m = momentumScore(input.indicators);
  const v = valuationScore(input.drawdown);
  const c = catalystScore(scoringCatalysts);
  const r = riskScore(input.indicators, input.drawdown, scoringCatalysts);
  const s = sentimentScore(scoringCatalysts);

  const components: ScoreComponents = {
    valuationScore: v.score,
    momentumScore: m.score,
    catalystScore: c.score,
    riskScore: r.score,
    sentimentScore: s.score,
  };

  // Catalyst and sentiment are derived only from catalysts. With none, they're
  // pure no-data neutrals — and at 35% of the default weight they'd drag a strong
  // stock toward the middle. Drop them from the blend (weight 0) so the score
  // reflects the signals we actually have; `confidence` already flags the gap.
  const baseWeights = input.weights ?? DEFAULT_STOCK_WEIGHTS;
  // "Has catalysts" means has DIRECTIONAL ones. A ticker with 300 neutral
  // headlines has no catalyst signal, and letting those hold 35% of the weight
  // at a flat 5.5 would drag a genuinely strong stock to the middle.
  const hasCatalysts = scoringCatalysts.length > 0;
  const weightsUsed: StockScoreWeights = hasCatalysts
    ? baseWeights
    : { ...baseWeights, catalyst: 0, sentiment: 0 };
  const technicalBlend = combineStockScore(components, weightsUsed);

  // Fundamentals lead the blend when supplied; otherwise the score is the
  // technical blend alone (unchanged behavior for tracked-stock refresh).
  const hasFundamentals = input.fundamentals != null;
  const blended = hasFundamentals
    ? clampScore(
        Math.round(
          (FUNDAMENTALS_WEIGHT * input.fundamentals!.score +
            (1 - FUNDAMENTALS_WEIGHT) * technicalBlend) *
            10,
        ) / 10,
      )
    : technicalBlend;

  // Apply the earnings-surprise nudge on top of the blend (bounded, monotonic).
  const earnAdj =
    input.earnings && input.earnings.impact !== 0
      ? Math.max(-MAX_EARNINGS_ADJ, Math.min(MAX_EARNINGS_ADJ, Math.round(input.earnings.impact * EARNINGS_SCALE * 10) / 10))
      : 0;
  const overall = clampScore(Math.round((blended + earnAdj) * 10) / 10);
  const earningsReasons =
    input.earnings && earnAdj !== 0
      ? [`${input.earnings.reason} → ${earnAdj > 0 ? "+" : ""}${earnAdj} to the score.`]
      : input.earnings
        ? [`${input.earnings.reason} (negligible effect on the score).`]
        : [];

  // Confidence reflects data completeness, never certainty about outcomes.
  const dataPoints = [
    input.indicators != null,
    input.drawdown != null,
    input.catalysts.length > 0,
    hasFundamentals,
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
      catalyst: hasCatalysts
        ? c.reasons
        : ["No current catalysts — excluded from the blend (score uses valuation, momentum, risk)."],
      risk: r.reasons,
      sentiment: hasCatalysts
        ? s.reasons
        : ["No current catalysts — sentiment excluded from the blend."],
      ...(hasFundamentals
        ? {
            fundamentals: [
              `Fundamentals ${input.fundamentals!.score.toFixed(1)}/10 (leads the score at ${Math.round(
                FUNDAMENTALS_WEIGHT * 100,
              )}%).`,
              ...input.fundamentals!.reasons,
            ],
          }
        : {}),
      ...(earningsReasons.length > 0 ? { earnings: earningsReasons } : {}),
    },
    weightsUsed,
  };
}

/**
 * A score's components + labels as flat DB column values — the shape shared by
 * every table that persists a stock score (stock_scores, agent_candidates,
 * sector_scout_picks). Pure; callers spread in their table-specific extras.
 */
export function scoreRowValues(score: StockScoreResult) {
  return {
    overallScore: score.overallScore,
    valuationScore: score.components.valuationScore,
    momentumScore: score.components.momentumScore,
    catalystScore: score.components.catalystScore,
    riskScore: score.components.riskScore,
    sentimentScore: score.components.sentimentScore,
    recommendation: score.recommendation,
    confidence: score.confidence,
  };
}

/**
 * How far an overall score must move to count as a real change. Shared by the
 * `score_history` feed and by `canUpdateLiveScoreRow` below — both answer the
 * same question ("did this score actually move?"), so they must not drift.
 */
export const MATERIAL_SCORE_DELTA = 0.5;

/**
 * Whether a recompute can refresh the ticker's existing `stock_scores` row in
 * place instead of appending a new one (roadmap #61).
 *
 * The refresh loop recomputes every tracked ticker roughly every 2 minutes
 * while the market is open, but nothing reads intraday score resolution:
 * `latestScore()` takes the newest row per ticker, and `scoreSeries()` and
 * `buildScoreEvents()` both collapse to the last row per ticker per day.
 * Appending regardless cost ~12,400 rows/day (~50 MB, 57% of the database) to
 * record the 9–34 moves a day that were real. So a row is reused only while it
 * is still the same UTC day — guaranteeing at least one row per ticker per day
 * for the daily readers — and the score has not moved materially; a material
 * move gets its own row, so intraday movement is never lost. Pure.
 */
export function canUpdateLiveScoreRow(
  prev: { overallScore: number; calculatedAt: string },
  nextOverallScore: number,
  nowTs: string,
): boolean {
  return (
    isSameUtcDay(prev.calculatedAt, nowTs) &&
    Math.abs(prev.overallScore - nextOverallScore) < MATERIAL_SCORE_DELTA
  );
}

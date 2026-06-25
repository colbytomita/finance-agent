import type { ReactNode } from "react";
import { Insight } from "./Insight";
import { ScoreBadge, RecBadge } from "./badges";
import { fmtDate, fmtMoney } from "@/lib/format";
import {
  buyZoneExplanation,
  explainStockRecommendation,
  explainTradeRecommendation,
  parseReasoning,
  parseTradeReasoning,
} from "@/lib/explain";

// Server-composed insight wrappers: each swaps a bare badge/value for a hoverable
// one whose popover explains how the app derived it. All data is already loaded by
// the calling pages; these only format it. When data is missing they fall back to
// the plain badge (no popover).

interface StockScoreRow {
  overallScore: number;
  valuationScore: number;
  momentumScore: number;
  catalystScore: number;
  riskScore: number;
  sentimentScore: number;
  recommendation: string;
  confidence: string;
  reasoningJson: string | null;
  calculatedAt: string;
}

interface SetupRow {
  setupType: string;
  setupQualityScore: number;
  entryRangeLow: number;
  entryRangeHigh: number;
  stopLoss: number;
  targetPrice1: number;
  targetPrice2: number | null;
  riskRewardRatio: number;
  invalidationCondition: string | null;
}

interface TradeRow {
  tradeScore: number | null;
  recommendation: string | null;
  reasoningJson?: string | null;
}

interface StockWeights {
  valuation: number;
  momentum: number;
  catalyst: number;
  risk: number;
  sentiment: number;
}

function PanelTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1 font-semibold text-zinc-100">{children}</div>;
}

function ReasonList({ items, empty }: { items: string[]; empty?: string }) {
  if (!items || items.length === 0) {
    return <p className="text-zinc-500">{empty ?? "Neutral default — no specific drivers."}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((r, i) => (
        <li key={i} className="flex gap-1.5">
          <span className="text-zinc-600">•</span>
          <span>{r}</span>
        </li>
      ))}
    </ul>
  );
}

// --- Stock score (overall) --------------------------------------------------

export function StockScoreInsight({
  score,
  weights,
}: {
  score: StockScoreRow | null | undefined;
  weights: StockWeights;
}) {
  if (!score) return <ScoreBadge score={null} />;
  const reasoning = parseReasoning(score.reasoningJson);
  // Prefer the effective weights actually used for this score (catalyst/sentiment
  // are 0 when there were no current catalysts) so the breakdown matches the blend.
  const w =
    ((reasoning as Record<string, unknown>).weightsUsed as StockWeights | undefined) ?? weights;
  const rows = [
    { label: "Valuation", value: score.valuationScore, weight: w.valuation, key: "valuation" },
    { label: "Momentum", value: score.momentumScore, weight: w.momentum, key: "momentum" },
    { label: "Catalysts", value: score.catalystScore, weight: w.catalyst, key: "catalyst" },
    { label: "Risk", value: score.riskScore, weight: w.risk, key: "risk" },
    { label: "Sentiment", value: score.sentimentScore, weight: w.sentiment, key: "sentiment" },
  ];
  const weightSum = rows.reduce((a, r) => a + r.weight, 0) || 1;
  const panel = (
    <div>
      <PanelTitle>
        Stock score {score.overallScore.toFixed(1)}/10 · {score.recommendation}
      </PanelTitle>
      <p className="mb-1.5 text-zinc-500">
        Weighted blend of five components (confidence: {score.confidence}).
      </p>
      <table className="w-full">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-0.5 pr-2 text-zinc-400">{r.label}</td>
              <td className="py-0.5 pr-2">
                <ScoreBadge score={r.value} />
              </td>
              <td className="py-0.5 text-right tabular-nums text-zinc-600">
                {Math.round((r.weight / weightSum) * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5 space-y-1">
        {rows.map((r) =>
          (reasoning[r.key]?.length ?? 0) > 0 ? (
            <div key={r.label}>
              <span className="font-semibold text-zinc-300">{r.label}: </span>
              <span className="text-zinc-400">{reasoning[r.key].join(" ")}</span>
            </div>
          ) : null,
        )}
      </div>
      <p className="mt-1.5 text-[10px] text-zinc-600">
        Scored {fmtDate(score.calculatedAt)} · heuristic model output.
      </p>
    </div>
  );
  return (
    <Insight panel={panel}>
      <ScoreBadge score={score.overallScore} />
    </Insight>
  );
}

// --- Single stock-score component (catalyst, risk, momentum, …) -------------

const COMPONENT_META: Record<
  "valuation" | "momentum" | "catalyst" | "risk" | "sentiment",
  { label: string; field: keyof StockScoreRow; note?: string }
> = {
  valuation: {
    label: "Valuation",
    field: "valuationScore",
    note: "Range-based heuristic (discount vs 52-week high), not fundamentals.",
  },
  momentum: { label: "Momentum", field: "momentumScore" },
  catalyst: { label: "Catalysts", field: "catalystScore" },
  risk: { label: "Risk", field: "riskScore", note: "10 = low risk." },
  sentiment: { label: "Sentiment", field: "sentimentScore" },
};

export function StockComponentInsight({
  score,
  component,
}: {
  score: StockScoreRow | null | undefined;
  component: keyof typeof COMPONENT_META;
}) {
  if (!score) return <ScoreBadge score={null} />;
  const meta = COMPONENT_META[component];
  const value = score[meta.field] as number;
  const reasons = parseReasoning(score.reasoningJson)[component] ?? [];
  const panel = (
    <div>
      <PanelTitle>
        {meta.label} {value.toFixed(1)}/10
      </PanelTitle>
      {meta.note && <p className="mb-1 text-zinc-500">{meta.note}</p>}
      <ReasonList items={reasons} />
    </div>
  );
  return (
    <Insight panel={panel}>
      <ScoreBadge score={value} />
    </Insight>
  );
}

// --- Stock recommendation ---------------------------------------------------

export function RecommendationInsight({ score }: { score: StockScoreRow | null | undefined }) {
  if (!score) return <RecBadge rec={null} />;
  const panel = (
    <div>
      <PanelTitle>Recommendation: {score.recommendation}</PanelTitle>
      <p className="text-zinc-400">{explainStockRecommendation(score.overallScore)}</p>
      <p className="mt-1 text-[10px] text-zinc-600">Confidence: {score.confidence}.</p>
    </div>
  );
  return (
    <Insight panel={panel}>
      <RecBadge rec={score.recommendation} />
    </Insight>
  );
}

// --- Detected setup ---------------------------------------------------------

export function SetupInsight({
  setup,
  children,
}: {
  setup: SetupRow | null | undefined;
  children?: ReactNode;
}) {
  if (!setup) return <>{children ?? <ScoreBadge score={null} />}</>;
  const panel = (
    <div>
      <PanelTitle>
        {setup.setupType.replace(/_/g, " ")} · quality {setup.setupQualityScore.toFixed(1)}/10
      </PanelTitle>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-zinc-500">Entry</span>
        <span className="tabular-nums">
          {fmtMoney(setup.entryRangeLow)}–{fmtMoney(setup.entryRangeHigh)}
        </span>
        <span className="text-zinc-500">Stop</span>
        <span className="tabular-nums text-red-300">{fmtMoney(setup.stopLoss)}</span>
        <span className="text-zinc-500">Targets</span>
        <span className="tabular-nums text-emerald-300">
          {fmtMoney(setup.targetPrice1)}
          {setup.targetPrice2 != null ? ` / ${fmtMoney(setup.targetPrice2)}` : ""}
        </span>
        <span className="text-zinc-500">Risk/Reward</span>
        <span className="tabular-nums">{setup.riskRewardRatio.toFixed(1)}:1</span>
      </div>
      {setup.invalidationCondition && (
        <p className="mt-1.5 text-zinc-400">{setup.invalidationCondition}</p>
      )}
    </div>
  );
  return (
    <Insight panel={panel}>{children ?? <ScoreBadge score={setup.setupQualityScore} />}</Insight>
  );
}

// --- Buy-zone status --------------------------------------------------------

export function BuyZoneInsight({
  status,
  distancePct,
  children,
}: {
  status: string | null | undefined;
  distancePct: number | null | undefined;
  children?: ReactNode;
}) {
  const label = children ?? <span className="text-xs">{status ?? "—"}</span>;
  if (!status) return <>{label}</>;
  const panel = (
    <div>
      <PanelTitle>Buy zone: {status}</PanelTitle>
      <p className="text-zinc-400">{buyZoneExplanation(status, distancePct)}</p>
    </div>
  );
  return <Insight panel={panel}>{label}</Insight>;
}

// --- Drawdown (factual) -----------------------------------------------------

export function DrawdownInsight({
  pct,
  currentPrice,
  high52,
  children,
}: {
  pct: number | null | undefined;
  currentPrice: number | null | undefined;
  high52: number | null | undefined;
  children: ReactNode;
}) {
  if (pct == null) return <>{children}</>;
  const panel = (
    <div>
      <PanelTitle>Drawdown from 52-week high</PanelTitle>
      <p className="text-zinc-400">
        {currentPrice != null && high52 != null
          ? `Current price ${fmtMoney(currentPrice)} is ${Math.abs(pct).toFixed(1)}% below the 52-week high of ${fmtMoney(high52)}.`
          : `${Math.abs(pct).toFixed(1)}% below the 52-week high.`}
      </p>
    </div>
  );
  return <Insight panel={panel}>{children}</Insight>;
}

// --- Trade score / recommendation -------------------------------------------

export function TradeScoreInsight({ trade, kind }: { trade: TradeRow; kind: "score" | "rec" }) {
  const badge =
    kind === "rec" ? <RecBadge rec={trade.recommendation} /> : <ScoreBadge score={trade.tradeScore} />;
  if (trade.tradeScore == null) return badge;
  const tr = parseTradeReasoning(trade.reasoningJson);
  const hasReasons =
    (tr.reasons?.length ?? 0) > 0 || (tr.exit?.length ?? 0) > 0 || (tr.trim?.length ?? 0) > 0;
  const panel = (
    <div>
      <PanelTitle>
        Trade score {trade.tradeScore.toFixed(1)}/10
        {trade.recommendation ? ` · ${trade.recommendation}` : ""}
      </PanelTitle>
      <p className="mb-1 text-zinc-400">{explainTradeRecommendation(trade.tradeScore)}</p>
      {tr.exit && tr.exit.length > 0 && (
        <div className="mb-1">
          <span className="font-semibold text-red-300">Exit flags: </span>
          <span className="text-zinc-400">{tr.exit.join(" ")}</span>
        </div>
      )}
      {tr.trim && tr.trim.length > 0 && (
        <div className="mb-1">
          <span className="font-semibold text-amber-300">Trim flags: </span>
          <span className="text-zinc-400">{tr.trim.join(" ")}</span>
        </div>
      )}
      {tr.reasons && tr.reasons.length > 0 ? (
        <ReasonList items={tr.reasons} />
      ) : !hasReasons ? (
        <p className="text-zinc-500">Refresh data to compute the breakdown.</p>
      ) : null}
    </div>
  );
  return <Insight panel={panel}>{badge}</Insight>;
}

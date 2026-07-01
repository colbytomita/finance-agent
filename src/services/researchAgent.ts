import { getDb, schema } from "@/db";
import { latestDrawdown, latestScore, tickerCatalysts } from "@/lib/queries";
import { desc, eq } from "drizzle-orm";
import { completeJson, getProvider } from "./llm";

// Research briefs: LLM-generated when a provider is configured, rule-based
// otherwise — same output shape either way, so the app degrades gracefully.
// All output is labelled model-generated interpretation — never presented as
// fact. (LLM provider plumbing lives in ./llm.)

export interface ResearchBrief {
  ticker: string;
  summary: string;
  bullCase: string;
  bearCase: string;
  keyCatalysts: string[];
  keyRisks: string[];
  scoreExplanation: string;
  recommendedAction: string;
  confidence: string;
  generatedBy: "llm" | "rules";
}

function gatherContext(ticker: string) {
  const score = latestScore(ticker);
  const catalysts = tickerCatalysts(ticker, 10);
  const trade = getDb()
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.ticker, ticker))
    .orderBy(desc(schema.activeTrades.updatedAt))
    .limit(1)
    .get();
  const drawdown = latestDrawdown(ticker);
  return { score, catalysts, trade: trade?.status === "open" ? trade : null, drawdown };
}

function ruleBasedBrief(ticker: string): ResearchBrief {
  const { score, catalysts, trade, drawdown } = gatherContext(ticker);
  const reasoning: Record<string, string[]> = score?.reasoningJson
    ? JSON.parse(score.reasoningJson)
    : {};
  const positives = catalysts.filter((c) => c.impactScore > 0);
  const negatives = catalysts.filter((c) => c.impactScore < 0);

  const bullParts = [
    ...(reasoning.momentum ?? []).filter((r) => /above|uptrend|healthy|improving/i.test(r)),
    ...positives.slice(0, 2).map((c) => c.title),
  ];
  const bearParts = [
    ...(reasoning.momentum ?? []).filter((r) => /below|downtrend|weak|overbought/i.test(r)),
    ...(reasoning.risk ?? []).filter((r) => /high|deep|worsening|negative/i.test(r)),
    ...negatives.slice(0, 2).map((c) => c.title),
  ];

  const scoreTxt = score ? `${score.overallScore.toFixed(1)}/10 (${score.recommendation})` : "not yet scored";
  const ddTxt =
    drawdown?.drawdownPercent != null
      ? `${Math.abs(drawdown.drawdownPercent).toFixed(1)}% below its 52-week high`
      : "drawdown unknown";

  return {
    ticker,
    summary: `${ticker} scores ${scoreTxt}, trading ${ddTxt}. ${
      trade ? `Open trade: ${trade.recommendation ?? "no recommendation yet"}.` : "No open trade."
    }`,
    bullCase: bullParts.length > 0 ? bullParts.join(" ") : "No bullish signals tracked yet.",
    bearCase: bearParts.length > 0 ? bearParts.join(" ") : "No bearish signals tracked yet.",
    keyCatalysts: positives.slice(0, 3).map((c) => c.title),
    keyRisks: negatives.slice(0, 3).map((c) => c.title),
    scoreExplanation: Object.entries(reasoning)
      // reasoningJson also carries a non-array `weightsUsed` object — only the
      // per-component reason arrays belong in the explanation.
      .filter((e): e is [string, string[]] => Array.isArray(e[1]))
      .map(([k, v]) => `${k}: ${v.join(" ")}`)
      .join(" | "),
    recommendedAction: trade?.recommendation ?? score?.recommendation ?? "Insufficient data",
    confidence: score?.confidence ?? "low",
    generatedBy: "rules",
  };
}

export async function generateBrief(ticker: string): Promise<ResearchBrief> {
  const provider = getProvider();
  const fallback = ruleBasedBrief(ticker);
  if (!provider) return fallback;

  const { score, catalysts, trade, drawdown } = gatherContext(ticker);
  const prompt = `You are a cautious market research assistant. Using ONLY the data below, write a concise research brief for ${ticker}. Never claim certainty, never guarantee returns, clearly hedge. If data is missing, say so.

DATA (raw, machine-collected):
Stock score: ${JSON.stringify(score ?? "none")}
Drawdown: ${JSON.stringify(drawdown ?? "none")}
Open trade: ${JSON.stringify(trade ?? "none")}
Recent catalysts: ${JSON.stringify(catalysts.slice(0, 8))}

Respond in strict JSON with keys: summary (1 sentence), bullCase (1-2 sentences), bearCase (1-2 sentences), keyCatalysts (array of strings), keyRisks (array of strings), scoreExplanation (1-2 sentences), recommendedAction (one of Enter/Wait/Hold/Add/Trim/Exit/Avoid), confidence (low/medium/high).`;

  const parsed = await completeJson<Partial<ResearchBrief>>(provider, prompt);
  if (!parsed) return fallback;
  const brief: ResearchBrief = {
    ticker,
    summary: parsed.summary ?? fallback.summary,
    bullCase: parsed.bullCase ?? fallback.bullCase,
    bearCase: parsed.bearCase ?? fallback.bearCase,
    keyCatalysts: parsed.keyCatalysts ?? fallback.keyCatalysts,
    keyRisks: parsed.keyRisks ?? fallback.keyRisks,
    scoreExplanation: parsed.scoreExplanation ?? fallback.scoreExplanation,
    recommendedAction: parsed.recommendedAction ?? fallback.recommendedAction,
    confidence: parsed.confidence ?? fallback.confidence,
    generatedBy: "llm",
  };
  persistBrief(brief);
  return brief;
}

function persistBrief(brief: ResearchBrief): void {
  const db = getDb();
  db.insert(schema.researchNotes)
    .values({
      ticker: brief.ticker,
      title: `Research brief ${new Date().toISOString().slice(0, 10)}`,
      summary: brief.summary,
      bullCase: brief.bullCase,
      bearCase: brief.bearCase,
      risks: brief.keyRisks.join("; "),
      sourcesJson: JSON.stringify({ generatedBy: brief.generatedBy }),
      generatedBy: brief.generatedBy,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function getLatestNote(ticker: string) {
  const db = getDb();
  return (
    db
      .select()
      .from(schema.researchNotes)
      .where(eq(schema.researchNotes.ticker, ticker))
      .orderBy(desc(schema.researchNotes.createdAt))
      .limit(1)
      .get() ?? null
  );
}

import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

// Provider-agnostic LLM research module. When no LLM is configured the
// rule-based composer produces the same shape of output from score
// reasoning, so the app degrades gracefully. All output is labelled
// model-generated interpretation — never presented as fact.

export interface LLMProvider {
  name: string;
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  constructor(
    private apiKey: string,
    private model = process.env.LLM_MODEL || "claude-sonnet-4-6",
  ) {}

  async complete(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
}

export function getProvider(): LLMProvider | null {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider(process.env.ANTHROPIC_API_KEY);
  }
  return null; // rule-based fallback
}

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
  const db = getDb();
  const score = db
    .select()
    .from(schema.stockScores)
    .where(eq(schema.stockScores.ticker, ticker))
    .orderBy(desc(schema.stockScores.calculatedAt))
    .limit(1)
    .get();
  const catalysts = db
    .select()
    .from(schema.catalysts)
    .where(eq(schema.catalysts.ticker, ticker))
    .orderBy(desc(schema.catalysts.discoveredAt))
    .limit(10)
    .all();
  const trade = db
    .select()
    .from(schema.activeTrades)
    .where(eq(schema.activeTrades.ticker, ticker))
    .orderBy(desc(schema.activeTrades.updatedAt))
    .limit(1)
    .get();
  const drawdown = db
    .select()
    .from(schema.drawdownMetrics)
    .where(eq(schema.drawdownMetrics.ticker, ticker))
    .orderBy(desc(schema.drawdownMetrics.calculatedAt))
    .limit(1)
    .get();
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

  try {
    const raw = await provider.complete(prompt);
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return fallback;
    const parsed = JSON.parse(jsonText) as Partial<ResearchBrief>;
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
  } catch (e) {
    console.error(`[research] LLM brief failed for ${ticker}, using rules:`, e instanceof Error ? e.message : e);
    return fallback;
  }
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

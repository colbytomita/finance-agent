import type { Confidence, ImpactDirection } from "@/lib/types";
import type { MentionDirection } from "./entityMentions";
import type { RawEventItem } from "./sources/types";
import { AnthropicProvider, type LLMProvider } from "./researchAgent";
import { classifyCatalyst } from "./catalysts";
import { resolveTicker, findKnownTicker, companyDisplayName } from "./sources/tickerMap";

// Turn raw real-world text (filings, press releases, news coverage) into
// structured entity→ticker mentions. The LLM (Haiku — cheap, batched into one
// call) does the heavy lifting; a deterministic rule-based path takes over when
// no key is configured or the call fails, so ingestion always degrades
// gracefully. Everything is labelled model-generated interpretation, never fact.

export interface ExtractedEvent {
  entity: string | null;
  ticker: string | null;
  companyName: string | null;
  claim: string | null;
  direction: MentionDirection;
  confidence: Confidence;
  eventDate: string; // ISO date
  title: string;
  url: string;
  source: string;
  generatedBy: "llm" | "rules";
}

const today = () => new Date().toISOString().slice(0, 10);

export function normalizeDirection(s: string | null | undefined): MentionDirection {
  const v = (s ?? "").toLowerCase();
  if (v.includes("bull") || v.includes("positive")) return "bullish";
  if (v.includes("bear") || v.includes("negative")) return "bearish";
  if (v.includes("neutral") || v.includes("mixed")) return "neutral";
  return "unknown";
}

export function normalizeConfidence(s: string | null | undefined): Confidence {
  const v = (s ?? "").toLowerCase();
  if (v.startsWith("high")) return "high";
  if (v.startsWith("med")) return "medium";
  return "low";
}

function impactToMention(d: ImpactDirection): MentionDirection {
  return d === "positive" ? "bullish" : d === "negative" ? "bearish" : d === "mixed" ? "neutral" : "unknown";
}

function isFiling(source: string): boolean {
  return source.startsWith("sec") || source.startsWith("ir");
}

/** Provider for extraction — Haiku by default (cheap), overridable via env. */
export function getExtractionProvider(): LLMProvider | null {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const key = process.env.ANTHROPIC_API_KEY;
  if (provider === "anthropic" && key) {
    return new AnthropicProvider(key, process.env.LLM_MODEL_EXTRACTION || "claude-haiku-4-5");
  }
  return null;
}

export function buildExtractionPrompt(items: RawEventItem[]): string {
  const lines = items
    .map((it, i) => `[${i}] (source: ${it.source}) ${it.text}`.replace(/\s+/g, " ").slice(0, 400))
    .join("\n");
  return `You extract structured stock "catalyst events" from short real-world texts (SEC filing titles, press releases, and news headlines). For EACH numbered item, decide whether it describes a specific ENTITY making/announcing something about a specific publicly-traded COMPANY.

- "entity" = who is the source of the statement: a person (e.g. a public figure or executive) for news coverage, OR the company itself for its own filing/press release.
- Only include items that clearly reference a specific company. Set "relevant": false (or omit the item) otherwise.
- Keep "claim" under 140 characters. Never invent facts beyond the text.

ITEMS:
${lines}

Respond with STRICT JSON only — an array, one object per RELEVANT item:
[{"index": <number>, "entity": "...", "company": "...", "ticker": "<symbol or empty>", "claim": "...", "direction": "bullish|bearish|neutral|unknown", "confidence": "low|medium|high", "relevant": true}]
No prose, no markdown — just the JSON array.`;
}

interface RawExtraction {
  index?: number;
  entity?: string | null;
  company?: string | null;
  ticker?: string | null;
  claim?: string | null;
  direction?: string | null;
  confidence?: string | null;
  relevant?: boolean;
}

/**
 * Map an LLM JSON response back onto the source items. Returns null when the
 * response can't be parsed at all (so the caller can fall back), or an array
 * (possibly empty) of extracted events when it parses.
 */
export function parseExtractionResponse(
  raw: string,
  items: RawEventItem[],
): ExtractedEvent[] | null {
  const jsonText = raw.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonText) return null;
  let arr: RawExtraction[];
  try {
    arr = JSON.parse(jsonText) as RawExtraction[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;

  const out: ExtractedEvent[] = [];
  for (const el of arr) {
    if (el.relevant === false) continue;
    const idx = typeof el.index === "number" ? el.index : NaN;
    const item = items[idx];
    if (!item) continue;

    // An item's tickerHint is authoritative (IR feed ticker, or a filer resolved
    // via SEC's CIK map) — trust it directly. Otherwise fall back to resolving the
    // LLM's ticker/company against the known name universe.
    const ticker =
      item.tickerHint ??
      resolveTicker(el.ticker) ??
      resolveTicker(el.company);

    const companyName =
      (el.company && el.company.trim()) || (ticker ? companyDisplayName(ticker) : null);

    let entity = (el.entity && el.entity.trim()) || null;
    if (!entity && isFiling(item.source)) entity = companyName;

    out.push({
      entity,
      ticker,
      companyName,
      claim: (el.claim && el.claim.trim()) || item.title,
      direction: normalizeDirection(el.direction),
      confidence: normalizeConfidence(el.confidence),
      eventDate: item.publishedAt?.slice(0, 10) || today(),
      title: item.title,
      url: item.url,
      source: item.source,
      generatedBy: "llm",
    });
  }
  return out;
}

/** Deterministic fallback for one item when no LLM is available. */
export function fallbackExtract(
  item: RawEventItem,
  knownEntities: string[],
): ExtractedEvent | null {
  const ticker = item.tickerHint ?? findKnownTicker(item.text);
  if (!ticker) return null;

  let entity: string | null;
  if (isFiling(item.source)) {
    entity = companyDisplayName(ticker); // the company is the source of its own filing
  } else {
    const lower = item.text.toLowerCase();
    entity = knownEntities.find((e) => e && lower.includes(e.toLowerCase())) ?? null;
  }
  if (!entity) return null;

  const cls = classifyCatalyst(item.title, item.text);
  return {
    entity,
    ticker,
    companyName: companyDisplayName(ticker),
    claim: item.title,
    direction: impactToMention(cls.impactDirection),
    confidence: "low",
    eventDate: item.publishedAt?.slice(0, 10) || today(),
    title: item.title,
    url: item.url,
    source: item.source,
    generatedBy: "rules",
  };
}

export interface ExtractOptions {
  knownEntities?: string[];
  /** Inject a provider (or null to force fallback). Defaults to Haiku. */
  provider?: LLMProvider | null;
}

/** Extract events from a batch of items — one LLM call, with a rule-based fallback. */
export async function extractEvents(
  items: RawEventItem[],
  opts: ExtractOptions = {},
): Promise<ExtractedEvent[]> {
  if (items.length === 0) return [];
  const provider = opts.provider !== undefined ? opts.provider : getExtractionProvider();

  if (provider) {
    try {
      const raw = await provider.complete(buildExtractionPrompt(items), { maxTokens: 2000 });
      const parsed = parseExtractionResponse(raw, items);
      if (parsed !== null) return parsed;
    } catch (e) {
      console.error(
        "[eventExtraction] LLM extraction failed, using rule-based fallback:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const known = opts.knownEntities ?? [];
  return items
    .map((it) => fallbackExtract(it, known))
    .filter((e): e is ExtractedEvent => e !== null);
}

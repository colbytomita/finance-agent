import { describe, expect, it } from "vitest";
import {
  normalizeDirection,
  normalizeConfidence,
  parseExtractionResponse,
  fallbackExtract,
  extractEvents,
} from "../eventExtraction";
import type { RawEventItem } from "../sources/types";
import type { LLMProvider } from "../researchAgent";

const newsItem: RawEventItem = {
  source: "gdelt:Nvidia",
  title: "Senator praises Nvidia AI chips at hearing",
  text: "Senator Jane Doe praised Nvidia AI chips at a hearing",
  url: "https://news.example/1",
  publishedAt: "2026-06-01",
};

const filingItem: RawEventItem = {
  source: "sec-edgar",
  title: "8-K - Apple Inc. (0000320193) (Filer)",
  text: "8-K - Apple Inc. (0000320193) (Filer)",
  url: "https://sec.gov/apple",
  publishedAt: "2026-06-02",
  tickerHint: "AAPL",
};

describe("normalizers", () => {
  it("normalizeDirection maps synonyms", () => {
    expect(normalizeDirection("Bullish")).toBe("bullish");
    expect(normalizeDirection("positive")).toBe("bullish");
    expect(normalizeDirection("negative")).toBe("bearish");
    expect(normalizeDirection("neutral")).toBe("neutral");
    expect(normalizeDirection("???")).toBe("unknown");
  });
  it("normalizeConfidence clamps to low/medium/high", () => {
    expect(normalizeConfidence("HIGH")).toBe("high");
    expect(normalizeConfidence("med")).toBe("medium");
    expect(normalizeConfidence(undefined)).toBe("low");
  });
});

describe("parseExtractionResponse", () => {
  it("maps a well-formed JSON array back onto items and resolves tickers", () => {
    const raw = `Here you go:
    [
      {"index":0,"entity":"Senator Jane Doe","company":"Nvidia","ticker":"NVDA","claim":"praises AI chips","direction":"bullish","confidence":"medium","relevant":true},
      {"index":1,"entity":"","company":"Apple","ticker":"","claim":"files 8-K","direction":"neutral","confidence":"low"}
    ]`;
    const out = parseExtractionResponse(raw, [newsItem, filingItem]);
    expect(out).not.toBeNull();
    expect(out!).toHaveLength(2);

    expect(out![0].ticker).toBe("NVDA");
    expect(out![0].entity).toBe("Senator Jane Doe");
    expect(out![0].direction).toBe("bullish");
    expect(out![0].eventDate).toBe("2026-06-01");
    expect(out![0].generatedBy).toBe("llm");

    // Filing with empty entity falls back to the company name; empty ticker
    // resolves via the item's tickerHint.
    expect(out![1].ticker).toBe("AAPL");
    expect(out![1].entity).toBe("Apple");
  });

  it("skips items flagged relevant:false", () => {
    const raw = `[{"index":0,"entity":"x","company":"Nvidia","relevant":false}]`;
    expect(parseExtractionResponse(raw, [newsItem])).toEqual([]);
  });

  it("returns null when no JSON array is present (so caller can fall back)", () => {
    expect(parseExtractionResponse("the model refused", [newsItem])).toBeNull();
  });
});

describe("fallbackExtract", () => {
  it("treats a filing's company as the entity", () => {
    const ev = fallbackExtract(filingItem, []);
    expect(ev).not.toBeNull();
    expect(ev!.entity).toBe("Apple");
    expect(ev!.ticker).toBe("AAPL");
    expect(ev!.generatedBy).toBe("rules");
  });

  it("matches a known entity in news text and resolves the company", () => {
    const ev = fallbackExtract(newsItem, ["Senator Jane Doe"]);
    expect(ev).not.toBeNull();
    expect(ev!.entity).toBe("Senator Jane Doe");
    expect(ev!.ticker).toBe("NVDA");
  });

  it("returns null for news with no recognizable entity", () => {
    expect(fallbackExtract(newsItem, [])).toBeNull();
  });

  it("returns null when no known company can be resolved", () => {
    const item: RawEventItem = { ...newsItem, text: "nothing to see here", title: "x" };
    expect(fallbackExtract(item, ["Senator Jane Doe"])).toBeNull();
  });
});

describe("extractEvents (async orchestration, no network)", () => {
  it("uses an injected provider's JSON when it parses", async () => {
    const stub: LLMProvider = {
      name: "stub",
      complete: async () =>
        `[{"index":0,"entity":"Senator Jane Doe","company":"Nvidia","ticker":"NVDA","claim":"c","direction":"bullish","confidence":"high"}]`,
    };
    const out = await extractEvents([newsItem], { provider: stub });
    expect(out).toHaveLength(1);
    expect(out[0].generatedBy).toBe("llm");
    expect(out[0].confidence).toBe("high");
  });

  it("falls back to rules when the provider throws", async () => {
    const boom: LLMProvider = {
      name: "boom",
      complete: async () => {
        throw new Error("api down");
      },
    };
    const out = await extractEvents([filingItem], { provider: boom });
    expect(out).toHaveLength(1);
    expect(out[0].generatedBy).toBe("rules");
    expect(out[0].ticker).toBe("AAPL");
  });

  it("uses the fallback when provider is explicitly null", async () => {
    const out = await extractEvents([newsItem], { provider: null, knownEntities: ["Senator Jane Doe"] });
    expect(out).toHaveLength(1);
    expect(out[0].entity).toBe("Senator Jane Doe");
  });
});

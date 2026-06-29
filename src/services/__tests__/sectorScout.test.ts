import { describe, expect, it } from "vitest";
import {
  curatedTickersFor,
  normalizeIndustryLabel,
  parseTickerList,
  ruleBriefFromAnalysis,
} from "../sectorScout";
import { buildCandidate } from "../discoveryAgent";
import { barsFromCloses, trendCloses, uptrendWithPullback } from "./helpers";

describe("sectorScout.normalizeIndustryLabel", () => {
  it("trims, collapses whitespace, and lower-cases", () => {
    expect(normalizeIndustryLabel("  Nuclear   Fusion ")).toBe("nuclear fusion");
    expect(normalizeIndustryLabel("ENERGY")).toBe("energy");
  });
});

describe("sectorScout.parseTickerList", () => {
  it("parses a JSON array of tickers", () => {
    expect(parseTickerList('["RKLB","ASTS","LUNR"]')).toEqual(["RKLB", "ASTS", "LUNR"]);
  });

  it("extracts a JSON array embedded in prose", () => {
    const raw = 'Here are some names: ["XOM", "CVX", "COP"]. Hope that helps!';
    expect(parseTickerList(raw)).toEqual(["XOM", "CVX", "COP"]);
  });

  it("falls back to delimiter splitting when there is no JSON array", () => {
    expect(parseTickerList("NVDA, AMD; INTC")).toEqual(["NVDA", "AMD", "INTC"]);
  });

  it("uppercases, de-duplicates, and drops invalid symbols + stopwords", () => {
    const raw = '["nvda", "NVDA", "toolongsymbol", "ETF", "AMD", "123"]';
    expect(parseTickerList(raw)).toEqual(["NVDA", "AMD"]);
  });

  it("returns an empty array when nothing looks like a ticker", () => {
    expect(parseTickerList("no tickers here at all")).toEqual([]);
  });
});

describe("sectorScout.curatedTickersFor", () => {
  it("matches a known theme by exact key", () => {
    const t = curatedTickersFor("space");
    expect(t).toContain("RKLB");
    expect(t).toContain("LMT");
  });

  it("matches when the query contains a theme keyword", () => {
    expect(curatedTickersFor("oil and gas")).toContain("XOM");
  });

  it("returns an empty list for an unknown theme", () => {
    expect(curatedTickersFor("underwater basket weaving")).toEqual([]);
  });
});

describe("sectorScout.ruleBriefFromAnalysis", () => {
  it("builds a brief that names the ticker and industry and surfaces positive edges", () => {
    const c = buildCandidate({
      ticker: "RKLB",
      bars: barsFromCloses(trendCloses(10, 30, 260)),
      price: 30,
    })!;
    const brief = ruleBriefFromAnalysis(c, "space", [
      { title: "Influential figure praised RKLB", impactScore: 1.4 },
      { title: "Regulatory probe disclosed", impactScore: -0.9 },
    ]);

    expect(brief.summary).toContain("RKLB");
    expect(brief.summary.toLowerCase()).toContain("space");
    expect(brief.keyCatalysts).toContain("Influential figure praised RKLB");
    expect(brief.recommendedAction).toBe(c.score.recommendation);
    expect(brief.confidence).toBe(c.score.confidence);
    expect(brief.by).toBe("rules");
    expect(Array.isArray(brief.keyRisks)).toBe(true);
  });

  it("notes a meaningful drawdown from the 52-week high as a catalyst", () => {
    // Up to 150, then pull back to 142 — a modest but real drawdown from the high.
    const c = buildCandidate({
      ticker: "PB",
      bars: barsFromCloses(uptrendWithPullback()),
      price: 120, // well below the ~150 high to force a >10% drawdown note
    })!;
    const brief = ruleBriefFromAnalysis(c, "energy");
    expect(brief.keyCatalysts.some((s) => /below its 52-week high/i.test(s))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  checkThemeMembership,
  curatedTickersFor,
  describeIndustry,
  normalizeIndustryLabel,
  parseThemeMisfits,
  parseTickerList,
  ruleBriefFromAnalysis,
} from "../sectorScout";
import { DEFAULT_CONFIG } from "@/lib/config";
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

  it("matches a multi-word query containing a theme keyword as a whole word", () => {
    expect(curatedTickersFor("nuclear fusion")).toContain("CCJ");
    expect(curatedTickersFor("defense contractors")).toContain("LMT");
  });

  it("does not match keywords as substrings inside unrelated words", () => {
    // "ai" is a whole-word key of the AI theme, not a substring of "retail".
    const ai = curatedTickersFor("ai");
    expect(ai).toContain("NVDA");
    expect(ai).not.toContain("WMT"); // used to leak in via "ret-ai-l"
    // "tech" alone is not a theme; it used to leak fintech + biotech via substring.
    expect(curatedTickersFor("tech")).toEqual([]);
  });

  it("folds simple plurals so singular/plural queries match either way", () => {
    expect(curatedTickersFor("restaurant")).toContain("MCD"); // key is "restaurants"
    expect(curatedTickersFor("banking")).toContain("JPM");
    expect(curatedTickersFor("rocket")).toContain("RKLB"); // key is "rockets"
  });
});

describe("sectorScout theme-membership check (roadmap #50)", () => {
  it("parses misfits, ignoring tickers it wasn't asked about", () => {
    const raw = 'Sure: [{"ticker":"alks","reason":"Biotech — CNS therapeutics, no space business"},{"ticker":"NVDA","reason":"chips"}]';
    const m = parseThemeMisfits(raw, ["ALKS", "RTX"]);
    expect(m.get("ALKS")).toMatch(/biotech/i);
    expect(m.has("NVDA")).toBe(false); // not in the asked set
  });

  it("returns empty on unparseable output or an empty array", () => {
    expect(parseThemeMisfits("no json here", ["ALKS"]).size).toBe(0);
    expect(parseThemeMisfits("[]", ["ALKS"]).size).toBe(0);
  });

  it("substitutes a generic reason when the model omits one", () => {
    const m = parseThemeMisfits('[{"ticker":"ALKS"}]', ["ALKS"]);
    expect(m.get("ALKS")).toMatch(/not primarily/i);
  });

  it("exempts curated-theme members and asks only about the rest", async () => {
    const asked: string[] = [];
    const provider = {
      name: "fake",
      complete: async (prompt: string) => {
        asked.push(prompt);
        return '[{"ticker":"ALKS","reason":"biotech"}]';
      },
    };
    const m = await checkThemeMembership(
      "space",
      [
        { ticker: "RKLB", companyName: "Rocket Lab" }, // curated space member — exempt
        { ticker: "ALKS", companyName: "Alkermes" },
      ],
      { provider },
    );
    expect(m?.get("ALKS")).toBe("biotech");
    expect(m?.has("RKLB")).toBe(false);
    expect(asked[0]).not.toContain("RKLB");
    expect(asked[0]).toContain("ALKS");
  });

  it("returns null without an LLM so existing flags are never cleared blind", async () => {
    const m = await checkThemeMembership("space", [{ ticker: "ALKS", companyName: "Alkermes" }], {
      provider: null,
    });
    expect(m).toBeNull();
  });

  it("returns an empty map (ran, all fit) when every pick is curated-exempt", async () => {
    const m = await checkThemeMembership("space", [{ ticker: "RKLB", companyName: "Rocket Lab" }], {
      provider: null,
    });
    expect(m?.size).toBe(0);
  });
});

describe("sectorScout.describeIndustry", () => {
  const cfg = DEFAULT_CONFIG;

  it("describes a curated-matched industry with its keywords and starter tickers", () => {
    const d = describeIndustry("space", { expandedBy: "rules", cfg });
    expect(d.industry).toBe("space");
    expect(d.expansionMode).toBe("rules");
    expect(d.matchedThemeKeywords).toContain("space");
    expect(d.curatedExamples).toContain("RKLB");
    expect(d.whatShowsUp).toContain("space");
    // curated expansion criterion names the matched keyword and seed count
    expect(d.fitCriteria[0]).toMatch(/curated/i);
    expect(d.fitCriteria[0]).toContain('"space"');
    // pipeline always explains validation + scoring gate
    expect(d.fitCriteria.some((c) => /real Alpaca price/i.test(c))).toBe(true);
    expect(d.fitCriteria.some((c) => c.includes(`≥ ${cfg.agentMinScore.toFixed(1)}`))).toBe(true);
  });

  it("explains the empty result for an unrecognized curated theme with no LLM", () => {
    const d = describeIndustry("underwater basket weaving", { expandedBy: "rules", cfg });
    expect(d.matchedThemeKeywords).toEqual([]);
    expect(d.curatedExamples).toEqual([]);
    expect(d.fitCriteria[0]).toMatch(/didn't match any built-in theme keyword/i);
  });

  it("uses an AI expansion criterion when expandedBy is llm", () => {
    const d = describeIndustry("space", { expandedBy: "llm", cfg });
    expect(d.expansionMode).toBe("llm");
    expect(d.fitCriteria[0]).toMatch(/AI/);
    expect(d.fitCriteria[0]).toMatch(/pure-play/i);
  });

  it("includes a thesis gate only when thesis validation is enabled", () => {
    const withThesis = describeIndustry("energy", {
      expandedBy: "rules",
      cfg: { ...cfg, sectorScoutThesisEnabled: true },
    });
    expect(withThesis.fitCriteria.some((c) => /Thesis gate/.test(c))).toBe(true);

    const withoutThesis = describeIndustry("energy", {
      expandedBy: "rules",
      cfg: { ...cfg, sectorScoutThesisEnabled: false },
    });
    expect(withoutThesis.fitCriteria.some((c) => /Thesis gate/.test(c))).toBe(false);
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

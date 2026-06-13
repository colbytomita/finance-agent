import { describe, expect, it } from "vitest";
import {
  buyZoneExplanation,
  explainStockRecommendation,
  explainTradeRecommendation,
  parseReasoning,
  parseTradeReasoning,
} from "@/lib/explain";

describe("buyZoneExplanation", () => {
  it("describes being inside the zone", () => {
    expect(buyZoneExplanation("In Buy Zone", 0)).toMatch(/inside your target buy range/i);
  });

  it("includes the distance when below the zone", () => {
    const text = buyZoneExplanation("Below Buy Zone / Falling Knife Risk", -7.3);
    expect(text).toContain("7.3%");
    expect(text).toMatch(/below your buy zone/i);
  });

  it("falls back gracefully for an unknown/absent status", () => {
    expect(buyZoneExplanation(null, null)).toMatch(/no target buy range/i);
    expect(buyZoneExplanation("No Buy Zone Set", null)).toMatch(/no target buy range/i);
  });

  it("omits the distance when it is not finite", () => {
    const text = buyZoneExplanation("Above Buy Zone / Wait", null);
    expect(text).not.toContain("NaN");
    expect(text).toMatch(/wait for a pullback/i);
  });
});

describe("recommendation explanations", () => {
  it("references the stock score and bands", () => {
    const text = explainStockRecommendation(7.4);
    expect(text).toContain("7.4");
    expect(text).toMatch(/Buy Candidate/);
  });

  it("references the trade score and hard rules", () => {
    const text = explainTradeRecommendation(3.1);
    expect(text).toContain("3.1");
    expect(text).toMatch(/hard.*rules/i);
  });

  it("handles a missing score without crashing", () => {
    expect(explainStockRecommendation(null)).toContain("—");
    expect(explainTradeRecommendation(undefined)).toContain("—");
  });
});

describe("parseReasoning", () => {
  it("parses a valid reasoning object", () => {
    const parsed = parseReasoning(JSON.stringify({ risk: ["High volatility."], momentum: [] }));
    expect(parsed.risk).toEqual(["High volatility."]);
    expect(parsed.momentum).toEqual([]);
  });

  it("returns an empty object for null or malformed JSON", () => {
    expect(parseReasoning(null)).toEqual({});
    expect(parseReasoning("{not json")).toEqual({});
  });
});

describe("parseTradeReasoning", () => {
  it("parses the persisted trade-score shape", () => {
    const parsed = parseTradeReasoning(
      JSON.stringify({ reasons: ["a"], exit: ["Stop-loss hit."], trim: [], components: { technicalScore: 6 } }),
    );
    expect(parsed.reasons).toEqual(["a"]);
    expect(parsed.exit).toEqual(["Stop-loss hit."]);
    expect(parsed.components?.technicalScore).toBe(6);
  });

  it("returns an empty object for null or malformed JSON", () => {
    expect(parseTradeReasoning(null)).toEqual({});
    expect(parseTradeReasoning("nope")).toEqual({});
  });
});

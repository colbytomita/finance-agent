import { describe, expect, it } from "vitest";
import { resolveTicker, findKnownTicker, companyDisplayName, makeResolver } from "../sources/tickerMap";

describe("tickerMap.resolveTicker", () => {
  it("passes through known ticker symbols (any case)", () => {
    expect(resolveTicker("AAPL")).toBe("AAPL");
    expect(resolveTicker("aapl")).toBe("AAPL");
    expect(resolveTicker(" nvda ")).toBe("NVDA");
  });

  it("resolves company names with common suffixes/punctuation", () => {
    expect(resolveTicker("Apple Inc.")).toBe("AAPL");
    expect(resolveTicker("NVIDIA Corporation")).toBe("NVDA");
    expect(resolveTicker("Alphabet")).toBe("GOOGL");
    expect(resolveTicker("JPMorgan Chase & Co.")).toBe("JPM");
  });

  it("returns null for unknown names and empty input", () => {
    expect(resolveTicker("Some Random Startup LLC")).toBeNull();
    expect(resolveTicker("")).toBeNull();
    expect(resolveTicker(null)).toBeNull();
  });
});

describe("tickerMap.findKnownTicker", () => {
  it("finds the first known company mentioned in free text", () => {
    expect(findKnownTicker("Analysts expect Microsoft to beat estimates")).toBe("MSFT");
    expect(findKnownTicker("a big day for Nvidia and its chips")).toBe("NVDA");
  });

  it("returns null when no known company appears", () => {
    expect(findKnownTicker("the weather is nice today")).toBeNull();
  });
});

describe("tickerMap.companyDisplayName", () => {
  it("returns a human-readable name, falling back to the ticker", () => {
    expect(companyDisplayName("AAPL")).toBe("Apple");
    expect(companyDisplayName("ZZZZ")).toBe("ZZZZ");
  });
});

describe("tickerMap.makeResolver", () => {
  const r = makeResolver([
    { ticker: "RKLB", name: "Rocket Lab USA, Inc." },
    { ticker: "ASTS", name: "AST SpaceMobile, Inc." },
    { ticker: "NONAME", name: null },
  ]);

  it("resolves tracked tickers outside the curated universe", () => {
    expect(r.resolve("RKLB")).toBe("RKLB");
    expect(r.resolve("rklb")).toBe("RKLB");
    expect(r.resolve("NONAME")).toBe("NONAME"); // ticker-only hint still resolvable
  });

  it("resolves tracked company names (suffix-insensitive)", () => {
    expect(r.resolve("AST SpaceMobile")).toBe("ASTS");
    expect(r.resolve("AST SpaceMobile, Inc.")).toBe("ASTS");
    expect(r.resolve("Rocket Lab USA")).toBe("RKLB");
  });

  it("still resolves the curated universe and returns null for unknowns", () => {
    expect(r.resolve("Apple")).toBe("AAPL");
    expect(r.resolve("Totally Unknown Co")).toBeNull();
  });

  it("finds a tracked company mentioned in prose (curated names still win)", () => {
    expect(r.findInText("AST SpaceMobile won a launch contract")).toBe("ASTS");
    expect(r.findInText("a big day for Nvidia")).toBe("NVDA");
  });

  it("uses the cleaned tracked name as the display name", () => {
    expect(r.displayName("ASTS")).toBe("AST SpaceMobile");
    expect(r.displayName("AAPL")).toBe("Apple");
  });
});

import { describe, expect, it } from "vitest";
import { resolveTicker, findKnownTicker, companyDisplayName } from "../sources/tickerMap";

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

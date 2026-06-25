import { describe, expect, it } from "vitest";
import { confidenceRank, dedupeKey } from "../eventIngestion";

describe("eventIngestion.confidenceRank", () => {
  it("orders low < medium < high", () => {
    expect(confidenceRank("low")).toBeLessThan(confidenceRank("medium"));
    expect(confidenceRank("medium")).toBeLessThan(confidenceRank("high"));
  });
});

describe("eventIngestion.dedupeKey", () => {
  it("is stable and case-insensitive on the entity", () => {
    const a = dedupeKey("Donald Trump", "AAPL", "2026-06-01", "https://x/1");
    const b = dedupeKey("donald trump", "aapl", "2026-06-01T00:00:00Z", "https://x/1");
    expect(a).toBe(b);
  });

  it("differs when the reference (url/claim) differs", () => {
    const a = dedupeKey("E", "AAPL", "2026-06-01", "u1");
    const b = dedupeKey("E", "AAPL", "2026-06-01", "u2");
    expect(a).not.toBe(b);
  });
});

import { describe, expect, it } from "vitest";
import { confidenceRank, dedupeKey, ingestionRunRecord, type IngestResult } from "../eventIngestion";

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

describe("eventIngestion.ingestionRunRecord", () => {
  const base: IngestResult = {
    fetched: 10,
    extracted: 8,
    persisted: 5,
    catalystsAdded: 2,
    skipped: 3,
    bySource: { "sec-edgar": 4, gdelt: 6 },
    errors: [],
    generatedBy: "mixed",
  };

  it("maps an ingest result into a storable row", () => {
    const row = ingestionRunRecord(base, "scheduled", "2026-06-30T00:00:00Z");
    expect(row.trigger).toBe("scheduled");
    expect(row.fetched).toBe(10);
    expect(row.persisted).toBe(5);
    expect(row.catalystsAdded).toBe(2);
    expect(row.generatedBy).toBe("mixed");
    expect(JSON.parse(row.bySource)).toEqual({ "sec-edgar": 4, gdelt: 6 });
    expect(row.errorCount).toBe(0);
    expect(row.ranAt).toBe("2026-06-30T00:00:00Z");
  });

  it("defaults an unknown trigger to manual and caps stored errors at 10", () => {
    const errors = Array.from({ length: 15 }, (_, i) => `err${i}`);
    const row = ingestionRunRecord({ ...base, errors }, "weird", "t");
    expect(row.trigger).toBe("manual");
    expect(row.errorCount).toBe(15); // full count preserved
    expect(JSON.parse(row.errorsJson)).toHaveLength(10); // stored list capped
  });
});

import { describe, expect, it } from "vitest";
import {
  capAcrossSources,
  confidenceRank,
  dedupeKey,
  ingestionRunRecord,
  type IngestResult,
} from "../eventIngestion";

describe("eventIngestion.capAcrossSources", () => {
  const list = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("keeps items from every source when one source alone would fill the cap", () => {
    // The pre-fix failure mode: 25 SEC items + a cap of 25 dropped all GDELT/IR.
    const out = capAcrossSources([list("sec", 25), list("gdelt", 10), list("ir", 5)], 25);
    expect(out).toHaveLength(25);
    expect(out.filter((x) => x.startsWith("sec"))).toHaveLength(10);
    expect(out.filter((x) => x.startsWith("gdelt"))).toHaveLength(10);
    expect(out.filter((x) => x.startsWith("ir"))).toHaveLength(5);
  });

  it("preserves each source's own order", () => {
    const out = capAcrossSources([list("a", 3), list("b", 3)], 4);
    expect(out.filter((x) => x.startsWith("a"))).toEqual(["a0", "a1"]);
    expect(out.filter((x) => x.startsWith("b"))).toEqual(["b0", "b1"]);
  });

  it("returns everything when under the cap, and stops exactly at the cap", () => {
    expect(capAcrossSources([list("a", 2), list("b", 1)], 10)).toHaveLength(3);
    expect(capAcrossSources([list("a", 9)], 4)).toEqual(["a0", "a1", "a2", "a3"]);
  });

  it("handles empty inputs", () => {
    expect(capAcrossSources([], 5)).toEqual([]);
    expect(capAcrossSources([[], []], 5)).toEqual([]);
    expect(capAcrossSources([list("a", 3)], 0)).toEqual([]);
  });
});

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
    skippedItems: [
      { title: "Acme Corp announces widget", reason: "no ticker resolved" },
      { title: "Old filing", reason: "duplicate of a stored mention" },
    ],
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
    expect(JSON.parse(row.skippedJson)).toEqual(base.skippedItems);
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

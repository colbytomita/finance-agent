import { describe, expect, it } from "vitest";
import { clamp, errorMessage, mapPool, toCsvRow } from "../util";

describe("toCsvRow", () => {
  it("leaves simple fields unquoted and joins with commas", () => {
    expect(toCsvRow(["AAPL", 12.5, "long"])).toBe("AAPL,12.5,long");
  });

  it("quotes fields with commas, quotes, or newlines and doubles inner quotes", () => {
    expect(toCsvRow(["a,b", 'he said "hi"', "line1\nline2"])).toBe('"a,b","he said ""hi""","line1\nline2"');
  });

  it("renders null/undefined as empty fields", () => {
    expect(toCsvRow(["x", null, undefined, 0, false])).toBe("x,,,0,false");
  });
});

describe("clamp", () => {
  it("clamps into the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("errorMessage", () => {
  it("extracts Error messages and stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("mapPool", () => {
  it("preserves input order in the results", async () => {
    // Later items resolve sooner; results must still line up with inputs.
    const out = await mapPool([30, 20, 10, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 40, 20, 0]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  it("handles empty input and limits larger than the list", async () => {
    expect(await mapPool([], 5, async (x) => x)).toEqual([]);
    expect(await mapPool([1, 2], 10, async (x) => x + 1)).toEqual([2, 3]);
  });

  it("rejects when a worker throws", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow("boom");
  });
});

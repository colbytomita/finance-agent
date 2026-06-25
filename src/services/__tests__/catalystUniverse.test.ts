import { describe, expect, it } from "vitest";
import {
  getCatalystUniverse,
  universeMonitoringQueries,
} from "@/lib/catalystUniverse";

// The dataset is parsed from the user's HTML report by scripts/parseUniverse.ts.
// These tests guard the shape and key invariants so a bad re-parse can't silently
// ship empty/garbled reference data into the dashboard.

describe("catalyst research universe dataset", () => {
  const u = getCatalystUniverse();

  it("loads all three ranked sections with matching summary counts", () => {
    expect(u.people.length).toBe(u.summary.people);
    expect(u.events.length).toBe(u.summary.events);
    expect(u.sources.length).toBe(u.summary.sources);
    expect(u.summary.total).toBe(u.people.length + u.events.length + u.sources.length);
    expect(u.summary.total).toBeGreaterThan(100);
  });

  it("every row has a rank, a name, and a well-formed impact direction", () => {
    const rows = [...u.people, ...u.events, ...u.sources];
    for (const r of rows) {
      expect(r.rank).toBeGreaterThan(0);
      expect(r.name.length).toBeGreaterThan(0);
      expect([null, "positive", "negative", "mixed"]).toContain(r.impactDirection);
      for (const l of r.links) expect(l.url).toMatch(/^https?:\/\//);
    }
  });

  it("exposes de-duplicated, non-empty monitoring queries grouped by category", () => {
    expect(u.monitoringQueries.length).toBeGreaterThan(0);
    for (const g of u.monitoringQueries) {
      expect(g.category.length).toBeGreaterThan(0);
      expect(g.queries.length).toBeGreaterThan(0);
    }
    const flat = universeMonitoringQueries();
    expect(flat.length).toBeGreaterThan(0);
    expect(new Set(flat).size).toBe(flat.length); // de-duplicated
    expect(flat.every((q) => q.trim().length > 0)).toBe(true);
  });

  it("includes the playbook note and guidance bullets", () => {
    expect(u.playbookNote.length).toBeGreaterThan(0);
    expect(u.guidance.length).toBeGreaterThan(0);
  });
});

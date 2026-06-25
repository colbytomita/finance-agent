import { describe, expect, it } from "vitest";
import { classifyCatalyst, isCatalystStale, catalystEffectiveTime } from "../catalysts";

describe("catalyst freshness", () => {
  const now = Date.parse("2026-06-24T00:00:00Z");
  const day = 86400000;

  it("treats a 2-year-old event as stale (the Buffett/AAPL case)", () => {
    const stale = { eventDate: "2024-05-04", discoveredAt: "2026-06-20T00:00:00Z" };
    expect(isCatalystStale(stale, 90, now)).toBe(true);
  });

  it("keeps a recent event fresh", () => {
    const recent = { eventDate: "2026-06-01", discoveredAt: "2026-06-01T00:00:00Z" };
    expect(isCatalystStale(recent, 90, now)).toBe(false);
  });

  it("never marks a future (upcoming) event stale", () => {
    const upcoming = { eventDate: "2026-09-01", discoveredAt: "2026-06-20T00:00:00Z" };
    expect(isCatalystStale(upcoming, 90, now)).toBe(false);
  });

  it("falls back to discoveredAt when there is no event date", () => {
    expect(catalystEffectiveTime({ eventDate: null, discoveredAt: "2026-06-20T00:00:00Z" })).toBe(
      Date.parse("2026-06-20T00:00:00Z"),
    );
    expect(isCatalystStale({ eventDate: null, discoveredAt: "2025-01-01T00:00:00Z" }, 90, now)).toBe(true);
    expect(isCatalystStale({ eventDate: null, discoveredAt: "2026-06-20T00:00:00Z" }, 90, now)).toBe(false);
  });

  it("uses the boundary exactly at freshnessDays", () => {
    const exactly90 = { eventDate: new Date(now - 90 * day).toISOString(), discoveredAt: "x" };
    expect(isCatalystStale(exactly90, 90, now)).toBe(false); // 90 days ago is still fresh
    const past90 = { eventDate: new Date(now - 91 * day).toISOString(), discoveredAt: "x" };
    expect(isCatalystStale(past90, 90, now)).toBe(true);
  });
});

describe("classifyCatalyst", () => {
  it("classifies earnings beats as positive", () => {
    const r = classifyCatalyst("Acme Corp beats estimates with record revenue");
    expect(r.catalystType).toBe("earnings");
    expect(r.impactDirection).toBe("positive");
    expect(r.impactScore).toBeGreaterThan(0);
  });

  it("classifies guidance cuts as strongly negative", () => {
    const r = classifyCatalyst("Acme cuts guidance for fiscal 2026");
    expect(r.catalystType).toBe("guidance_update");
    expect(r.impactDirection).toBe("negative");
    expect(r.impactScore).toBeLessThanOrEqual(-3);
  });

  it("classifies analyst actions both ways", () => {
    expect(classifyCatalyst("Morgan upgrades Acme to overweight").impactScore).toBeGreaterThan(0);
    expect(classifyCatalyst("Bank downgrades Acme on valuation").impactScore).toBeLessThan(0);
  });

  it("classifies regulatory approvals as positive", () => {
    const r = classifyCatalyst("Acme wins approval for new device, FDA approval granted");
    expect(r.catalystType).toBe("regulatory");
    expect(r.impactDirection).toBe("positive");
  });

  it("classifies CEO departures as negative executive news", () => {
    const r = classifyCatalyst("Acme CEO steps down effective immediately");
    expect(r.catalystType).toBe("executive_announcement");
    expect(r.impactScore).toBeLessThan(0);
  });

  it("adjusts neutral items by tone words", () => {
    const r = classifyCatalyst("Acme shares plunge as demand warns of shortfall");
    expect(r.impactScore).toBeLessThan(0);
    expect(r.tags).toContain("negative-tone");
  });

  it("falls back to industry_news with unknown impact", () => {
    const r = classifyCatalyst("Acme to attend industry gathering");
    expect(r.catalystType).toBe("industry_news");
    expect(r.confidence).toBe("low");
  });

  it("keeps impact within -5..+5", () => {
    const r = classifyCatalyst(
      "Acme soars on record profit, raises guidance, beats estimates, announces buyback",
    );
    expect(r.impactScore).toBeLessThanOrEqual(5);
    expect(r.impactScore).toBeGreaterThan(0);
  });

  it("classifies dividend cuts as strongly negative", () => {
    const r = classifyCatalyst("Acme announces dividend suspension");
    expect(r.impactScore).toBeLessThanOrEqual(-3);
  });
});

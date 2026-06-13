import { describe, expect, it } from "vitest";
import { classifyCatalyst } from "../catalysts";

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

import { describe, expect, it } from "vitest";
import {
  buildCompanyThesisReport,
  evidenceQualityScore,
  parseClaimDrafts,
  scoreClaim,
  themeFitScore,
  type ThesisEvidenceItem,
} from "../companyThesisScout";

const evidence = (overrides: Partial<ThesisEvidenceItem>): ThesisEvidenceItem => ({
  sourceType: "ir",
  sourceName: "ir-rss:WATR",
  title: "WATR signs pilot agreement to reduce data center water use by 45%",
  text: "WATR announced a named customer pilot for liquid cooling that targets lower water consumption at AI data centers.",
  url: "https://example.com/watr",
  publishedAt: "2026-06-01",
  official: true,
  thirdParty: false,
  ...overrides,
});

describe("companyThesisScout.parseClaimDrafts", () => {
  it("parses strict JSON claim drafts and drops invalid source indexes", () => {
    const parsed = parseClaimDrafts(
      '[{"claim":"WATR is piloting cooling tech for AI data centers","claimType":"commercial_traction","supportIndexes":[0,4],"counterIndexes":[1]}]',
      2,
    );
    expect(parsed).toEqual([
      {
        claim: "WATR is piloting cooling tech for AI data centers",
        claimType: "commercial_traction",
        supportIndexes: [0],
        counterIndexes: [1],
      },
    ]);
  });

  it("returns null when the model response has no JSON array", () => {
    expect(parseClaimDrafts("not json", 2)).toBeNull();
  });
});

describe("companyThesisScout evidence scoring", () => {
  it("rewards theme-matched official and third-party evidence", () => {
    const items = [
      evidence({}),
      evidence({
        sourceType: "news",
        sourceName: "gdelt:water data centers",
        title: "Utility confirms WATR pilot could reduce data center cooling demand",
        text: "A local utility described the pilot as part of a grid and water conservation program.",
        official: false,
        thirdParty: true,
      }),
    ];

    expect(themeFitScore("water solutions for AI data centers", items)).toBeGreaterThanOrEqual(7);
    expect(evidenceQualityScore(items)).toBeGreaterThanOrEqual(5);
  });
});

describe("companyThesisScout.scoreClaim", () => {
  it("scores specific traction claims higher than unsupported hype", () => {
    const supported = scoreClaim(
      {
        claim: "WATR has a named-customer pilot to reduce AI data center water use by 45%",
        claimType: "commercial_traction",
        supportIndexes: [0],
        counterIndexes: [],
      },
      [evidence({})],
    );
    const hype = scoreClaim(
      {
        claim: "WATR will revolutionize the global water crisis",
        claimType: "company_claim",
        supportIndexes: [],
        counterIndexes: [],
      },
      [evidence({ title: "WATR says it has a revolutionary platform", text: "No customer, pilot, revenue, or deployment details were provided." })],
    );

    expect(supported.probabilityScore).toBeGreaterThan(hype.probabilityScore);
    expect(supported.status).toMatch(/validated|partly_validated/);
  });

  it("penalizes counter-evidence such as going-concern risk", () => {
    const claim = scoreClaim(
      {
        claim: "NukeCo can commercialize modular reactors for data center power",
        claimType: "technical",
        supportIndexes: [0],
        counterIndexes: [1],
      },
      [
        evidence({
          sourceType: "ir",
          sourceName: "ir-rss:NUKE",
          title: "NukeCo announces reactor prototype test",
          text: "The company reported a prototype test and a planned pilot facility.",
          official: true,
        }),
        evidence({
          sourceType: "filing",
          sourceName: "SEC EDGAR",
          title: "10-Q warns of going concern risk",
          text: "The filing reports substantial doubt about the company's ability to continue and possible dilution.",
          official: true,
        }),
      ],
    );

    expect(claim.probabilityScore).toBeLessThan(0.7);
    expect(claim.counterEvidenceSummary).toMatch(/going concern/i);
  });
});

describe("companyThesisScout.buildCompanyThesisReport", () => {
  it("builds an auditable thesis report with hype penalty and verdict", () => {
    const report = buildCompanyThesisReport({
      ticker: "WATR",
      industry: "water solutions for AI data centers",
      evidence: [
        evidence({}),
        evidence({
          sourceType: "news",
          sourceName: "gdelt:WATR",
          title: "Customer confirms WATR data center water pilot",
          text: "The customer said the pilot is installed at one data center campus.",
          official: false,
          thirdParty: true,
        }),
      ],
      drafts: [
        {
          claim: "WATR has early commercial traction for data center water reduction",
          claimType: "commercial_traction",
          supportIndexes: [0, 1],
          counterIndexes: [],
        },
      ],
      generatedBy: "rules",
    });

    expect(report.claims).toHaveLength(1);
    expect(report.overallThesisScore).toBeGreaterThan(5);
    expect(report.summary).toContain("WATR thesis");
    expect(report.verdict).not.toBe("weak or hype-heavy");
  });
});


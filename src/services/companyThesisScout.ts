import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AppConfig } from "@/lib/config";
import { loadConfig } from "@/lib/config";
import type { Confidence } from "@/lib/types";
import { clamp, nowIso } from "@/lib/util";
import { extractJson, getProvider, type LLMProvider } from "./llm";
import { getCatalystsForTicker } from "./catalysts";
import { listMentions } from "./entityMentions";
import { fetchGdeltNews } from "./sources/gdelt";
import { fetchIrFeeds } from "./sources/irRss";
import type { RawEventItem } from "./sources/types";

// Company Thesis Scout: evidence-backed validation for Sector Scout.
//
// The LLM, when configured, is used only to extract candidate claims from source
// snippets. The probability/credibility scores are deterministic and bounded so
// every report remains explainable and testable. Scores are evidence ratings,
// not financial advice, price predictions, or autonomous trading signals.

const TRACTION_RE =
  /\b(contract|customer|customers|commercial|commercialization|revenue|sales|backlog|purchase order|po\b|pilot|deployment|deployed|partnership|partner|award|awarded|grant|permit|approved|approval|facility|factory|production|shipment|deliveries|agreement|signed|selected)\b/i;
const SPECIFIC_RE =
  /\b(\d+(\.\d+)?%?|\$[\d,.]+|mw\b|gw\b|gwh\b|kwh\b|acre[- ]feet|gallons?|liters?|tons?|patent|phase [1-3]|named customer|memorandum|mou)\b/i;
const TECH_RE =
  /\b(patent|prototype|pilot|engineering|system|platform|reactor|electrolyzer|cooling|desalination|battery|semiconductor|chip|model|grid|capacity|efficiency|water|energy|power|data center|ai)\b/i;
const HYPE_RE =
  /\b(revolutionary|revolutionize|game[- ]changing|transformative|disruptive|moonshot|massive opportunity|trillion|breakthrough|world[- ]class|unprecedented|paradigm|guaranteed|explosive|to the moon)\b/i;
const RED_FLAG_RE =
  /\b(going concern|substantial doubt|bankrupt|bankruptcy|default|delist|dilution|dilutive|offering|at-the-market|restatement|investigation|subpoena|lawsuit|terminated|delay|delayed|failed|halt|recall|no assurance|material weakness|cash runway|liquidity)\b/i;
const MARKET_PAIN_RE =
  /\b(water crisis|water|drought|desalination|energy crisis|energy|power|grid|electricity|cooling|data center|ai data center|nuclear|fusion|battery|storage|semiconductor shortage|supply chain|critical mineral|carbon|emissions)\b/i;

const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "their",
  "about",
  "company",
  "stock",
  "sector",
  "industry",
  "technology",
]);

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function confidenceFromScore(score: number, evidenceCount: number): Confidence {
  if (score >= 0.7 && evidenceCount >= 3) return "high";
  if (score >= 0.45 && evidenceCount >= 2) return "medium";
  return "low";
}

function claimStatus(score: number): string {
  if (score >= 0.72) return "validated";
  if (score >= 0.52) return "partly_validated";
  if (score >= 0.34) return "speculative";
  return "weak";
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function sourceStrength(e: ThesisEvidenceItem): number {
  if (e.sourceType === "filing") return 1;
  if (e.official) return 0.8;
  if (e.thirdParty) return 0.7;
  if (e.sourceType === "entity_mention") return 0.55;
  if (e.sourceType === "research_note") return 0.45;
  return 0.5;
}

export type ThesisSourceType =
  | "filing"
  | "ir"
  | "news"
  | "catalyst"
  | "entity_mention"
  | "research_note";

export interface ThesisEvidenceItem {
  sourceType: ThesisSourceType;
  sourceName: string;
  title: string;
  text: string;
  url: string | null;
  publishedAt: string | null;
  official: boolean;
  thirdParty: boolean;
}

export interface ThesisClaim {
  claim: string;
  claimType: string;
  probabilityScore: number; // 0..1: evidence-backed chance the claim becomes meaningfully real
  evidenceSummary: string;
  counterEvidenceSummary: string;
  sourceUrls: string[];
  confidence: Confidence;
  status: string;
}

export interface CompanyThesisReport {
  ticker: string;
  companyName: string | null;
  industry: string;
  theme: string;
  summary: string;
  themeFitScore: number;
  claimCredibilityScore: number;
  moonshotScore: number;
  evidenceQualityScore: number;
  hypePenalty: number;
  overallThesisScore: number;
  verdict: string;
  generatedBy: "llm" | "rules";
  sources: ThesisEvidenceItem[];
  claims: ThesisClaim[];
}

export type CompanyClaimRow = typeof schema.companyClaims.$inferSelect;

interface ClaimDraft {
  claim: string;
  claimType: string;
  supportIndexes: number[];
  counterIndexes: number[];
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function evidenceText(evidence: ThesisEvidenceItem[]): string {
  return evidence.map((e) => `${e.title}. ${e.text}`).join(" ");
}

export function themeFitScore(theme: string, evidence: ThesisEvidenceItem[], claims: string[] = []): number {
  const themeTokens = new Set(tokens(theme));
  if (themeTokens.size === 0) return 5;
  const corpus = tokens(`${evidenceText(evidence)} ${claims.join(" ")}`);
  if (corpus.length === 0) return 2;
  const matched = [...themeTokens].filter((t) => corpus.includes(t)).length;
  const directPain = MARKET_PAIN_RE.test(`${theme} ${evidenceText(evidence)} ${claims.join(" ")}`) ? 1.5 : 0;
  return round1(clamp(2 + (matched / themeTokens.size) * 6 + directPain, 0, 10));
}

export function evidenceQualityScore(evidence: ThesisEvidenceItem[]): number {
  if (evidence.length === 0) return 0;
  const official = evidence.filter((e) => e.official).length;
  const thirdParty = evidence.filter((e) => e.thirdParty).length;
  const filings = evidence.filter((e) => e.sourceType === "filing").length;
  const distinctUrls = new Set(evidence.map((e) => e.url).filter(Boolean)).size;
  const strength = evidence.reduce((sum, e) => sum + sourceStrength(e), 0) / evidence.length;
  return round1(
    clamp(
      1.5 +
        Math.min(evidence.length, 8) * 0.55 +
        Math.min(official, 3) * 0.8 +
        Math.min(thirdParty, 3) * 0.65 +
        Math.min(filings, 2) * 0.75 +
        Math.min(distinctUrls, 5) * 0.35 +
        strength * 1.5,
      0,
      10,
    ),
  );
}

function evidenceSummary(items: ThesisEvidenceItem[], fallback: string): string {
  if (items.length === 0) return fallback;
  return items
    .slice(0, 3)
    .map((e) => `${e.sourceName}: ${e.title}`)
    .join(" | ")
    .slice(0, 700);
}

function counterItems(items: ThesisEvidenceItem[]): ThesisEvidenceItem[] {
  return items.filter((e) => RED_FLAG_RE.test(`${e.title} ${e.text}`));
}

export function scoreClaim(draft: ClaimDraft, evidence: ThesisEvidenceItem[]): ThesisClaim {
  const supporting =
    draft.supportIndexes.length > 0
      ? draft.supportIndexes.map((i) => evidence[i]).filter((e): e is ThesisEvidenceItem => Boolean(e))
      : evidence.filter((e) => {
          const et = `${e.title} ${e.text}`.toLowerCase();
          return tokens(draft.claim).some((t) => et.includes(t));
        });
  const counters =
    draft.counterIndexes.length > 0
      ? draft.counterIndexes.map((i) => evidence[i]).filter((e): e is ThesisEvidenceItem => Boolean(e))
      : counterItems(supporting.length > 0 ? supporting : evidence);

  const claimAndEvidence = `${draft.claim} ${supporting.map((e) => `${e.title} ${e.text}`).join(" ")}`;
  const specific = SPECIFIC_RE.test(claimAndEvidence);
  const traction = TRACTION_RE.test(claimAndEvidence);
  const technical = TECH_RE.test(claimAndEvidence);
  const hype = HYPE_RE.test(claimAndEvidence);
  const redFlags = RED_FLAG_RE.test(`${claimAndEvidence} ${counters.map((e) => e.text).join(" ")}`);
  const official = supporting.some((e) => e.official);
  const thirdParty = supporting.some((e) => e.thirdParty);
  const filing = supporting.some((e) => e.sourceType === "filing");
  const sourceDiversity = new Set(supporting.map((e) => e.sourceName)).size;

  let probability = 0.24;
  probability += Math.min(supporting.length, 4) * 0.06;
  if (official) probability += 0.1;
  if (thirdParty) probability += 0.1;
  if (filing) probability += 0.12;
  if (specific) probability += 0.13;
  if (traction) probability += 0.16;
  if (technical) probability += 0.06;
  probability += Math.min(sourceDiversity, 3) * 0.03;
  if (hype && !traction) probability -= 0.13;
  if (redFlags) probability -= 0.18;
  if (supporting.length === 0) probability -= 0.18;
  probability = round2(clamp(probability, 0.05, 0.92));

  return {
    claim: cleanText(draft.claim).slice(0, 220),
    claimType: draft.claimType || "company_claim",
    probabilityScore: probability,
    evidenceSummary: evidenceSummary(supporting, "No direct supporting evidence found in the collected sources."),
    counterEvidenceSummary: evidenceSummary(counters, "No direct counter-evidence found in the collected sources."),
    sourceUrls: [...new Set(supporting.map((e) => e.url).filter((u): u is string => Boolean(u)))].slice(0, 5),
    confidence: confidenceFromScore(probability, supporting.length),
    status: claimStatus(probability),
  };
}

function fallbackClaimDrafts(theme: string, evidence: ThesisEvidenceItem[]): ClaimDraft[] {
  const themeTokens = tokens(theme);
  const scored = evidence
    .map((e, i) => {
      const text = `${e.title} ${e.text}`;
      let score = 0;
      if (TRACTION_RE.test(text)) score += 3;
      if (SPECIFIC_RE.test(text)) score += 2;
      if (TECH_RE.test(text)) score += 1;
      if (e.official) score += 1;
      if (e.thirdParty) score += 1;
      score += themeTokens.filter((t) => text.toLowerCase().includes(t)).length;
      if (HYPE_RE.test(text) && !TRACTION_RE.test(text)) score -= 1;
      return { e, i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return scored.map(({ e, i }) => ({
    claim: e.title,
    claimType: TRACTION_RE.test(`${e.title} ${e.text}`) ? "commercial_traction" : "company_claim",
    supportIndexes: [i],
    counterIndexes: [],
  }));
}

interface RawClaimDraft {
  claim?: string | null;
  claimType?: string | null;
  supportIndexes?: unknown;
  counterIndexes?: unknown;
}

function parseIndexArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is number => Number.isInteger(x) && x >= 0).slice(0, 8);
}

export function parseClaimDrafts(raw: string, evidenceLength: number): ClaimDraft[] | null {
  const arr = extractJson<RawClaimDraft[]>(raw, "array");
  if (!Array.isArray(arr)) return null;
  const out: ClaimDraft[] = [];
  for (const item of arr) {
    const claim = typeof item.claim === "string" ? cleanText(item.claim) : "";
    if (claim.length < 12) continue;
    out.push({
      claim,
      claimType: typeof item.claimType === "string" && item.claimType.trim() ? item.claimType.trim() : "company_claim",
      supportIndexes: parseIndexArray(item.supportIndexes).filter((i) => i < evidenceLength),
      counterIndexes: parseIndexArray(item.counterIndexes).filter((i) => i < evidenceLength),
    });
  }
  return out.slice(0, 6);
}

function buildClaimPrompt(ticker: string, theme: string, evidence: ThesisEvidenceItem[]): string {
  const snippets = evidence
    .slice(0, 14)
    .map((e, i) => {
      const source = `${e.sourceName}${e.official ? " official" : ""}${e.thirdParty ? " third-party" : ""}`;
      return `[${i}] (${source}) ${cleanText(`${e.title}. ${e.text}`).slice(0, 500)}`;
    })
    .join("\n");
  return `Extract concrete, checkable company claims for ${ticker} related to "${theme}". Use ONLY the numbered evidence. Prefer measurable technical/commercial claims over slogans. Include counterIndexes when an item weakens the claim (financing stress, delays, investigations, no assurance, etc.). Do not invent facts.

Evidence:
${snippets}

Respond with strict JSON only:
[{"claim":"short checkable claim","claimType":"technical|commercial_traction|regulatory|financing|company_claim","supportIndexes":[0],"counterIndexes":[1]}]`;
}

export async function extractClaimDrafts(
  ticker: string,
  theme: string,
  evidence: ThesisEvidenceItem[],
  opts: { provider?: LLMProvider | null } = {},
): Promise<{ drafts: ClaimDraft[]; generatedBy: "llm" | "rules" }> {
  const provider = opts.provider !== undefined ? opts.provider : getProvider();
  if (provider && evidence.length > 0) {
    try {
      const raw = await provider.complete(buildClaimPrompt(ticker, theme, evidence), { maxTokens: 1200 });
      const parsed = parseClaimDrafts(raw, evidence.length);
      if (parsed && parsed.length > 0) return { drafts: parsed, generatedBy: "llm" };
    } catch {
      // Fall through to deterministic extraction.
    }
  }
  return { drafts: fallbackClaimDrafts(theme, evidence), generatedBy: "rules" };
}

function hypePenalty(evidence: ThesisEvidenceItem[], claims: ThesisClaim[]): number {
  const text = `${evidenceText(evidence)} ${claims.map((c) => c.claim).join(" ")}`;
  const hypeHits = (text.match(new RegExp(HYPE_RE.source, "gi")) ?? []).length;
  const redHits = (text.match(new RegExp(RED_FLAG_RE.source, "gi")) ?? []).length;
  const avgProb = claims.length > 0 ? claims.reduce((s, c) => s + c.probabilityScore, 0) / claims.length : 0;
  const weakEvidence = avgProb < 0.45 ? 0.5 : 0;
  return round1(clamp(hypeHits * 0.25 + redHits * 0.45 + weakEvidence, 0, 3));
}

function moonshotScore(theme: string, evidence: ThesisEvidenceItem[], claims: ThesisClaim[], fit: number): number {
  const text = `${theme} ${evidenceText(evidence)} ${claims.map((c) => c.claim).join(" ")}`;
  const marketPain = MARKET_PAIN_RE.test(text) ? 8 : 4;
  const ambition = /solve|replace|reduce|enable|scale|commercialize|breakthrough|data center|crisis|grid|water|energy/i.test(text)
    ? 7
    : 4.5;
  const credibility = claims.length > 0 ? claims.reduce((s, c) => s + c.probabilityScore * 10, 0) / claims.length : 2;
  let score = marketPain * 0.3 + ambition * 0.25 + fit * 0.2 + credibility * 0.25;
  if (evidenceQualityScore(evidence) < 4) score = Math.min(score, 6.2);
  return round1(clamp(score, 0, 10));
}

function verdict(score: number, credibility: number, penalty: number): string {
  if (score >= 7.4 && credibility >= 6.5 && penalty < 1.5) return "credible catalyst watch";
  if (score >= 6) return "promising but needs validation";
  if (score >= 4.2) return "speculative / evidence thin";
  return "weak or hype-heavy";
}

export function buildCompanyThesisReport(input: {
  ticker: string;
  companyName?: string | null;
  industry: string;
  theme?: string;
  evidence: ThesisEvidenceItem[];
  drafts: ClaimDraft[];
  generatedBy?: "llm" | "rules";
}): CompanyThesisReport {
  const ticker = input.ticker.toUpperCase();
  const theme = input.theme ?? input.industry;
  const claims = input.drafts.map((d) => scoreClaim(d, input.evidence));
  const fit = themeFitScore(theme, input.evidence, claims.map((c) => c.claim));
  const quality = evidenceQualityScore(input.evidence);
  const credibility =
    claims.length > 0
      ? round1(clamp((claims.reduce((s, c) => s + c.probabilityScore, 0) / claims.length) * 10, 0, 10))
      : round1(clamp(quality * 0.35 + fit * 0.15, 0, 4.5));
  const moonshot = moonshotScore(theme, input.evidence, claims, fit);
  const penalty = hypePenalty(input.evidence, claims);
  const overall = round1(clamp(fit * 0.2 + credibility * 0.35 + quality * 0.25 + moonshot * 0.2 - penalty, 0, 10));
  const topClaim = claims.sort((a, b) => b.probabilityScore - a.probabilityScore)[0];
  const summary =
    topClaim
      ? `${ticker} thesis: ${verdict(overall, credibility, penalty)}. Top claim scored ${(topClaim.probabilityScore * 100).toFixed(0)}% probability from collected evidence: ${topClaim.claim}`
      : `${ticker} thesis: ${verdict(overall, credibility, penalty)}. No concrete, checkable company claim was validated from collected evidence.`;

  return {
    ticker,
    companyName: input.companyName ?? null,
    industry: input.industry,
    theme,
    summary,
    themeFitScore: fit,
    claimCredibilityScore: credibility,
    moonshotScore: moonshot,
    evidenceQualityScore: quality,
    hypePenalty: penalty,
    overallThesisScore: overall,
    verdict: verdict(overall, credibility, penalty),
    generatedBy: input.generatedBy ?? "rules",
    sources: input.evidence.slice(0, 20),
    claims: claims.slice(0, 6),
  };
}

function rawItemToEvidence(item: RawEventItem, sourceType: ThesisSourceType, official: boolean): ThesisEvidenceItem {
  return {
    sourceType,
    sourceName: item.source,
    title: item.title,
    text: item.text,
    url: item.url || null,
    publishedAt: item.publishedAt,
    official,
    thirdParty: sourceType === "news",
  };
}

export function localThesisEvidence(ticker: string): ThesisEvidenceItem[] {
  const t = ticker.toUpperCase();
  const db = getDb();
  const evidence: ThesisEvidenceItem[] = [];

  for (const c of getCatalystsForTicker(t).slice(0, 12)) {
    const sourceName = c.sourceName ?? "catalyst";
    evidence.push({
      sourceType: sourceName.includes("SEC") ? "filing" : sourceName.includes("IR") ? "ir" : "catalyst",
      sourceName,
      title: c.title,
      text: c.summary ? `${c.title}. ${c.summary}` : c.title,
      url: c.sourceUrl,
      publishedAt: c.eventDate ?? c.discoveredAt,
      official: sourceName.includes("SEC") || sourceName.includes("IR") || sourceName === "manual-official",
      thirdParty: sourceName.includes("GDELT") || sourceName.includes("yahoo") || sourceName.includes("news"),
    });
  }

  for (const m of listMentions({ ticker: t }).slice(0, 8)) {
    evidence.push({
      sourceType: "entity_mention",
      sourceName: m.sourceName ?? "entity mention",
      title: m.claim ?? `${m.entity} mentioned ${t}`,
      text: `${m.entity}: ${m.claim ?? "mentioned the company"} (${m.direction})`,
      url: m.sourceUrl,
      publishedAt: m.eventDate,
      official: false,
      thirdParty: Boolean(m.sourceName && !m.sourceName.includes("IR") && !m.sourceName.includes("SEC")),
    });
  }

  const notes = db
    .select()
    .from(schema.researchNotes)
    .where(eq(schema.researchNotes.ticker, t))
    .orderBy(desc(schema.researchNotes.createdAt))
    .limit(3)
    .all();
  for (const n of notes) {
    evidence.push({
      sourceType: "research_note",
      sourceName: `research-note:${n.generatedBy}`,
      title: n.title ?? `Research note for ${t}`,
      text: [n.summary, n.bullCase, n.bearCase, n.risks].filter(Boolean).join(" "),
      url: null,
      publishedAt: n.createdAt,
      official: false,
      thirdParty: false,
    });
  }

  return evidence;
}

export async function gatherThesisEvidence(opts: {
  ticker: string;
  companyName?: string | null;
  industry: string;
  cfg?: AppConfig;
  fetchFn?: typeof fetch;
}): Promise<ThesisEvidenceItem[]> {
  const ticker = opts.ticker.toUpperCase();
  const cfg = opts.cfg ?? loadConfig();
  const evidence = localThesisEvidence(ticker);

  const feed = cfg.irFeeds.find((f) => f.ticker.toUpperCase() === ticker);
  if (cfg.eventSourceIrEnabled && feed) {
    const items = await fetchIrFeeds([feed], { fetchFn: opts.fetchFn }).catch(() => []);
    evidence.push(...items.slice(0, 8).map((it) => rawItemToEvidence(it, "ir", true)));
  }

  if (cfg.eventSourceGdeltEnabled) {
    const q = opts.companyName ? `${opts.companyName} ${opts.industry}` : `${ticker} ${opts.industry}`;
    const items = await fetchGdeltNews([q], {
      fetchFn: opts.fetchFn,
      maxPerQuery: 8,
      maxQueries: 1,
      timespan: "30d",
      spacingMs: 0,
      perRequestTimeoutMs: 8000,
    })
      .then((r) => r.items)
      .catch(() => []);
    evidence.push(...items.slice(0, 8).map((it) => rawItemToEvidence(it, "news", false)));
  }

  const seen = new Set<string>();
  return evidence
    .filter((e) => e.title || e.text)
    .filter((e) => {
      const key = `${e.sourceName}|${e.url ?? ""}|${e.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

export function persistCompanyThesisReport(report: CompanyThesisReport): number {
  const db = getDb();
  const now = nowIso();
  const values = {
    ticker: report.ticker,
    companyName: report.companyName,
    industry: report.industry,
    theme: report.theme,
    summary: report.summary,
    themeFitScore: report.themeFitScore,
    claimCredibilityScore: report.claimCredibilityScore,
    moonshotScore: report.moonshotScore,
    evidenceQualityScore: report.evidenceQualityScore,
    hypePenalty: report.hypePenalty,
    overallThesisScore: report.overallThesisScore,
    verdict: report.verdict,
    generatedBy: report.generatedBy,
    sourcesJson: JSON.stringify(
      report.sources.map((s) => ({
        sourceType: s.sourceType,
        sourceName: s.sourceName,
        title: s.title,
        url: s.url,
        publishedAt: s.publishedAt,
        official: s.official,
        thirdParty: s.thirdParty,
      })),
    ),
    updatedAt: now,
  };
  db.insert(schema.companyThesisReports)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [schema.companyThesisReports.ticker, schema.companyThesisReports.theme],
      set: values,
    })
    .run();
  const row = db
    .select({ id: schema.companyThesisReports.id })
    .from(schema.companyThesisReports)
    .where(and(eq(schema.companyThesisReports.ticker, report.ticker), eq(schema.companyThesisReports.theme, report.theme)))
    .get();
  const reportId = row?.id;
  if (!reportId) throw new Error("failed to persist thesis report");

  db.delete(schema.companyClaims).where(eq(schema.companyClaims.reportId, reportId)).run();
  for (const claim of report.claims) {
    db.insert(schema.companyClaims)
      .values({
        reportId,
        ticker: report.ticker,
        claim: claim.claim,
        claimType: claim.claimType,
        probabilityScore: claim.probabilityScore,
        evidenceSummary: claim.evidenceSummary,
        counterEvidenceSummary: claim.counterEvidenceSummary,
        sourceUrlsJson: JSON.stringify(claim.sourceUrls),
        confidence: claim.confidence,
        status: claim.status,
        createdAt: now,
      })
      .run();
  }
  return reportId;
}

export function listCompanyClaimsForReports(reportIds: number[]): Record<number, CompanyClaimRow[]> {
  const ids = [...new Set(reportIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return {};
  const rows = getDb()
    .select()
    .from(schema.companyClaims)
    .where(inArray(schema.companyClaims.reportId, ids))
    .all()
    .sort((a, b) => b.probabilityScore - a.probabilityScore);
  const out: Record<number, CompanyClaimRow[]> = {};
  for (const row of rows) {
    out[row.reportId] ??= [];
    out[row.reportId].push(row);
  }
  return out;
}

export async function generateCompanyThesisReport(opts: {
  ticker: string;
  companyName?: string | null;
  industry: string;
  cfg?: AppConfig;
  fetchFn?: typeof fetch;
  provider?: LLMProvider | null;
  persist?: boolean;
}): Promise<{ report: CompanyThesisReport; reportId: number | null }> {
  const evidence = await gatherThesisEvidence(opts);
  const extracted = await extractClaimDrafts(opts.ticker, opts.industry, evidence, { provider: opts.provider });
  const report = buildCompanyThesisReport({
    ticker: opts.ticker,
    companyName: opts.companyName,
    industry: opts.industry,
    evidence,
    drafts: extracted.drafts,
    generatedBy: extracted.generatedBy,
  });
  const reportId = opts.persist === false ? null : persistCompanyThesisReport(report);
  return { report, reportId };
}

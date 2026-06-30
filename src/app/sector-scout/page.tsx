import Link from "next/link";
import {
  listIndustryGuides,
  listSectorPicks,
  listSectorScans,
  normalizeIndustryLabel,
  type SectorPick,
} from "@/services/sectorScout";
import {
  listCompanyClaimsForReports,
  type CompanyClaimRow,
} from "@/services/companyThesisScout";
import { loadConfig } from "@/lib/config";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import { Pct, RecBadge, ScoreBadge } from "@/components/badges";
import { SectorScanForm, SectorPickActions, IndustryExplorer } from "@/components/SectorScout";

export const dynamic = "force-dynamic";

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Group picks by industry, preserving the listSectorPicks order. */
function groupByIndustry(picks: SectorPick[]): { industry: string; picks: SectorPick[] }[] {
  const groups: { industry: string; picks: SectorPick[] }[] = [];
  const index = new Map<string, number>();
  for (const p of picks) {
    let i = index.get(p.industry);
    if (i == null) {
      i = groups.length;
      index.set(p.industry, i);
      groups.push({ industry: p.industry, picks: [] });
    }
    groups[i].picks.push(p);
  }
  return groups;
}

function PickCard({ pick, claims }: { pick: SectorPick; claims: CompanyClaimRow[] }) {
  const catalysts = parseList(pick.keyCatalysts);
  const risks = parseList(pick.keyRisks);
  const added = pick.status === "added";

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/stock/${pick.ticker}`} className="text-base font-bold text-sky-300 hover:underline">
          {pick.ticker}
        </Link>
        {pick.companyName && <span className="text-xs text-zinc-400">{pick.companyName}</span>}
        <ScoreBadge score={pick.overallScore} />
        <RecBadge rec={pick.recommendation} />
        <span className="text-xs text-zinc-500">conf: {pick.confidence}</span>
        {pick.briefGeneratedBy === "llm" && (
          <span className="text-xs text-violet-300" title="LLM-written brief">
            · AI brief
          </span>
        )}
        <span className="ml-auto tabular-nums text-sm text-zinc-300">{fmtMoney(pick.price)}</span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>
          DD from 52w high: <Pct value={pick.drawdownPercent} />
        </span>
        <span>
          Suggested buy zone:{" "}
          <span className="tabular-nums text-zinc-300">
            {pick.suggestedBuyLow != null || pick.suggestedBuyHigh != null
              ? `${fmtMoney(pick.suggestedBuyLow)}–${fmtMoney(pick.suggestedBuyHigh)}`
              : "—"}
          </span>
        </span>
        <span>
          Components — val {pick.valuationScore?.toFixed(1) ?? "—"} · mom{" "}
          {pick.momentumScore?.toFixed(1) ?? "—"} · risk {pick.riskScore?.toFixed(1) ?? "—"}
        </span>
      </div>

      {pick.summary && <p className="text-sm text-zinc-200">{pick.summary}</p>}

      {pick.thesisScore != null && (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-sky-300">
              Thesis validation
            </span>
            <ScoreBadge score={pick.thesisScore} />
            {pick.thesisVerdict && <span className="text-xs text-zinc-300">{pick.thesisVerdict}</span>}
            {pick.thesisGeneratedBy === "llm" && (
              <span className="text-xs text-violet-300" title="Claims extracted with the configured LLM; scores are rules-based">
                · AI extracted
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
            <span>claim cred {pick.claimCredibilityScore?.toFixed(1) ?? "—"}</span>
            <span>theme fit {pick.themeFitScore?.toFixed(1) ?? "—"}</span>
            <span>moonshot {pick.moonshotScore?.toFixed(1) ?? "—"}</span>
            <span>evidence {pick.evidenceQualityScore?.toFixed(1) ?? "—"}</span>
            <span>hype penalty {pick.hypePenalty?.toFixed(1) ?? "—"}</span>
          </div>
          {pick.thesisSummary && <p className="mt-1 text-xs text-zinc-300">{pick.thesisSummary}</p>}
          {claims.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-zinc-300">
              {claims.slice(0, 2).map((claim) => (
                <li key={claim.id}>
                  <span className="tabular-nums text-sky-300">
                    {(claim.probabilityScore * 100).toFixed(0)}%
                  </span>{" "}
                  <span>{claim.claim}</span>
                  <span className="text-zinc-500"> · {claim.status.replace(/_/g, " ")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-400">Bull case</div>
          <p className="text-xs text-zinc-300">{pick.bullCase ?? "—"}</p>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-red-400">Bear case</div>
          <p className="text-xs text-zinc-300">{pick.bearCase ?? "—"}</p>
        </div>
      </div>

      {(catalysts.length > 0 || risks.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Key catalysts</div>
            {catalysts.length > 0 ? (
              <ul className="list-disc pl-4 text-xs text-zinc-300">
                {catalysts.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-zinc-600">—</span>
            )}
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Key risks</div>
            {risks.length > 0 ? (
              <ul className="list-disc pl-4 text-xs text-zinc-300">
                {risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-zinc-600">—</span>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-2">
        {pick.recommendedAction && (
          <span className="text-xs text-zinc-400">
            Suggested action: <span className="text-zinc-200">{pick.recommendedAction}</span>
          </span>
        )}
        <span className="ml-auto">
          <SectorPickActions id={pick.id} added={added} />
        </span>
      </div>
    </div>
  );
}

export default async function SectorScoutPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string | string[] }>;
}) {
  const cfg = loadConfig();
  const picks = listSectorPicks();
  const scans = listSectorScans();
  const industryGuides = listIndustryGuides(cfg);

  // ?industry=<label> filters the picks below to one industry and focuses the
  // explorer on it. Only honor it when it's a known scanned industry.
  const sp = await searchParams;
  const rawIndustry = Array.isArray(sp.industry) ? sp.industry[0] : sp.industry;
  const requested = rawIndustry ? normalizeIndustryLabel(rawIndustry) : "";
  const selectedIndustry = industryGuides.some((g) => g.industry === requested) ? requested : "";
  const visiblePicks = selectedIndustry
    ? picks.filter((p) => p.industry === selectedIndustry)
    : picks;
  const groups = groupByIndustry(visiblePicks);
  const claimsByReport = listCompanyClaimsForReports(
    picks.map((p) => p.thesisReportId).filter((id): id is number => id != null),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Sector Scout</h1>
      </div>

      <p className="text-xs text-zinc-500">
        Type an industry or theme. The scout expands it into real, US-listed tickers (LLM-assisted when an
        Anthropic key is configured, a curated list otherwise), drops anything without real price data, scores
        the rest with the same engine used everywhere, validates company claims/evidence when enabled, and writes
        a bull/bear/risk brief for any scoring <span className="text-zinc-300">≥ your min score</span> or clearing
        the thesis-led evidence threshold (defaults to{" "}
        {cfg.agentMinScore.toFixed(1)}, from{" "}
        <Link href="/settings" className="text-sky-300 hover:underline">
          Settings
        </Link>
        ). Nothing is added to your watchlist until you click <span className="text-zinc-300">Add</span>.
      </p>

      <SectorScanForm defaultMinScore={cfg.agentMinScore} />

      {industryGuides.length > 0 && (
        <IndustryExplorer
          guides={industryGuides}
          selected={selectedIndustry}
          favorites={cfg.sectorScoutIndustries}
          autoScanEnabled={cfg.sectorScoutScanEnabled}
        />
      )}

      {scans.length > 0 && (
        <section className="card">
          <h2 className="card-title">Recent scans</h2>
          <ul className="space-y-1 text-xs">
            {scans.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-zinc-200">{s.industry}</span>
                <span className="text-zinc-500">
                  {s.considered} considered · {s.scanned} scored · {s.proposed} pick(s) · ≥{" "}
                  {s.minScore.toFixed(1)}
                  {s.thesisReports > 0 ? ` · ${s.thesisReports} thesis report(s)` : ""}
                </span>
                {s.expandedBy === "rules" && <span className="text-zinc-600">· curated</span>}
                <span className="ml-auto text-zinc-600">{fmtDateTime(s.ranAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length === 0 ? (
        selectedIndustry ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            No surfaced picks for <span className="capitalize text-zinc-300">{selectedIndustry}</span> yet. Use{" "}
            <span className="text-zinc-300">Re-scan now</span> above, or lower your min score, to find names.
          </p>
        ) : (
          <p className="py-10 text-center text-sm text-zinc-500">
            No picks yet. Enter an industry above and click{" "}
            <span className="text-zinc-300">Scan industry</span> to find high-potential names.
          </p>
        )
      ) : (
        groups.map((g) => (
          <section key={g.industry} className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold capitalize text-zinc-200">{g.industry}</h2>
              <span className="text-xs text-zinc-500">
                {g.picks.length} pick{g.picks.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {g.picks.map((p) => (
                <PickCard key={p.id} pick={p} claims={p.thesisReportId ? claimsByReport[p.thesisReportId] ?? [] : []} />
              ))}
            </div>
          </section>
        ))
      )}

      <p className="text-[11px] text-zinc-600">
        Sector Scout findings are heuristic interpretations of price/technical data, source-backed thesis
        evidence, and model-written briefs — not financial advice, not a guarantee, and claim probability
        is not a price prediction. Always review before acting.
      </p>
    </div>
  );
}

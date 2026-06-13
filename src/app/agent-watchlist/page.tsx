import Link from "next/link";
import { listCandidates, lastScanAt, DEFAULT_UNIVERSE } from "@/services/discoveryAgent";
import { loadConfig } from "@/lib/config";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import { Pct, RecBadge, ScoreBadge } from "@/components/badges";
import { AgentScanButton, CandidateActions } from "@/components/AgentPicks";

export const dynamic = "force-dynamic";

export default function AgentWatchlistPage() {
  const cfg = loadConfig();
  const pending = listCandidates("pending");
  const decided = [...listCandidates("accepted"), ...listCandidates("declined")]
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
    .slice(0, 20);
  const last = lastScanAt();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-bold">Agent Picks</h1>
        <div className="ml-auto flex items-center gap-3">
          {last && <span className="text-[11px] text-zinc-500">Last scan {fmtDateTime(last)}</span>}
          <AgentScanButton />
        </div>
      </div>

      <p className="text-xs text-zinc-500">
        The discovery agent scans {DEFAULT_UNIVERSE.length} liquid stocks and proposes any scoring{" "}
        <span className="text-zinc-300">≥ {cfg.agentMinScore.toFixed(1)}</span> (set in{" "}
        <Link href="/settings" className="text-sky-300 hover:underline">Settings</Link>). Accept to add
        a pick to your watchlist with a suggested buy zone, or decline to dismiss it.
      </p>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Company</th>
              <th>Price</th>
              <th>DD from 52w</th>
              <th>Suggested buy zone</th>
              <th>Momentum</th>
              <th>Risk</th>
              <th>Score</th>
              <th>Rec</th>
              <th>Confidence</th>
              <th>Why the agent flagged it</th>
              <th>Proposed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pending.length === 0 && (
              <tr>
                <td colSpan={13} className="py-6 text-center text-zinc-500">
                  No pending picks. Click <span className="text-zinc-300">Run agent scan</span> to look
                  for candidates.
                </td>
              </tr>
            )}
            {pending.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/stock/${c.ticker}`} className="font-semibold text-sky-300 hover:underline">
                    {c.ticker}
                  </Link>
                </td>
                <td className="max-w-40 truncate text-zinc-400">{c.companyName ?? "—"}</td>
                <td className="tabular-nums">{fmtMoney(c.price)}</td>
                <td><Pct value={c.drawdownPercent} /></td>
                <td className="text-xs tabular-nums text-zinc-400">
                  {c.suggestedBuyLow != null || c.suggestedBuyHigh != null
                    ? `${fmtMoney(c.suggestedBuyLow)}–${fmtMoney(c.suggestedBuyHigh)}`
                    : "—"}
                </td>
                <td><ScoreBadge score={c.momentumScore} /></td>
                <td><ScoreBadge score={c.riskScore} /></td>
                <td><ScoreBadge score={c.overallScore} /></td>
                <td><RecBadge rec={c.recommendation} /></td>
                <td className="text-xs text-zinc-400">
                  {c.confidence}
                  {c.generatedBy === "llm" && <span className="ml-1 text-violet-300" title="LLM-written rationale">· AI</span>}
                </td>
                <td className="max-w-72 text-xs text-zinc-300">{c.rationale ?? "—"}</td>
                <td className="text-[11px] text-zinc-500">{fmtDateTime(c.proposedAt)}</td>
                <td><CandidateActions id={c.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {decided.length > 0 && (
        <section className="card">
          <h2 className="card-title">Recently decided</h2>
          <ul className="space-y-1 text-xs">
            {decided.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span className="w-14 font-semibold text-zinc-300">{c.ticker}</span>
                <ScoreBadge score={c.overallScore} />
                <span className={c.status === "accepted" ? "pos" : "text-zinc-500"}>
                  {c.status === "accepted" ? "✓ added to watchlist" : "✕ declined"}
                </span>
                <span className="text-zinc-600">{fmtDateTime(c.decidedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-[11px] text-zinc-600">
        Agent picks are heuristic interpretations of price/technical data — not financial advice, not a
        guarantee. Catalyst/sentiment inputs are usually neutral for untracked names, so picks lean on
        momentum, valuation-by-range, and risk. Always review before accepting.
      </p>
    </div>
  );
}

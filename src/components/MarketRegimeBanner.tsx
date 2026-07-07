import { getMarketRegime, type RegimeLabel } from "@/services/marketRegime";

// Broad-market regime banner (roadmap #21). Server component — reads the SPY
// regime directly. Heuristic context for new entries, never a market call.

const DOT: Record<RegimeLabel, string> = {
  favorable: "bg-emerald-400",
  neutral: "bg-sky-400",
  cautious: "bg-amber-400",
  unknown: "bg-zinc-600",
};

export function MarketRegimeBanner() {
  const r = getMarketRegime();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-xs">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[r.label]}`} />
      <span className="text-zinc-300">{r.headline}</span>
      {r.spyPrice != null && (
        <span className="tabular-nums text-zinc-600">
          SPY {r.spyPrice.toFixed(2)}
          {r.spySma50 != null ? ` · 50-day ${r.spySma50.toFixed(2)}` : ""}
        </span>
      )}
      <span className="ml-auto text-[10px] text-zinc-600">heuristic · not a market call</span>
    </div>
  );
}

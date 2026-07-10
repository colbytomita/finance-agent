import { getBars } from "@/services/bars";
import { portfolioHistory } from "@/services/portfolioHistory";
import { fmtMoney } from "@/lib/format";

// Account-value equity curve (roadmap #31). Server component — plots the
// daily portfolio snapshots with SPY rebased to the same start for context.
// Raw data (last refresh of each day), not interpretation. History
// accumulates from the day the feature shipped — nothing is backfilled.

export function EquityCurve() {
  const snaps = portfolioHistory();
  if (snaps.length === 0) return null; // nothing tracked yet — stay quiet

  if (snaps.length < 2) {
    return (
      <section className="card">
        <h2 className="card-title">Account value</h2>
        <p className="text-xs text-zinc-500">
          Collecting daily snapshots — {snaps.length} day so far (since {snaps[0].snapshotDate}
          ). The curve appears once two or more days are recorded.
        </p>
      </section>
    );
  }

  // Rebase SPY to the portfolio's value on the first date both series share,
  // so the two lines answer "vs just holding the index" over the same window.
  const spyCloseByDate = new Map(getBars("SPY").map((b) => [b.date, b.close]));
  const firstShared = snaps.find((s) => spyCloseByDate.has(s.snapshotDate));
  const spyBase = firstShared ? spyCloseByDate.get(firstShared.snapshotDate)! : null;
  const spySeries = snaps.map((s) => {
    if (!firstShared || spyBase == null) return null;
    const close = spyCloseByDate.get(s.snapshotDate);
    return close != null ? (firstShared.totalValue * close) / spyBase : null;
  });

  const w = 640;
  const h = 120;
  const values = [
    ...snaps.map((s) => s.totalValue),
    ...spySeries.filter((v): v is number => v != null),
  ];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (snaps.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 6 - ((v - lo) / span) * (h - 12);
  const path = (pts: (number | null)[]) => {
    let d = "";
    let pen = false;
    pts.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const first = snaps[0].totalValue;
  const latest = snaps[snaps.length - 1].totalValue;
  const deltaPct = first > 0 ? ((latest - first) / first) * 100 : null;
  const spyLast = [...spySeries].reverse().find((v) => v != null) ?? null;
  const spyDeltaPct =
    firstShared && spyLast != null && firstShared.totalValue > 0
      ? ((spyLast - firstShared.totalValue) / firstShared.totalValue) * 100
      : null;
  const up = latest >= first;

  return (
    <section className="card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="card-title">Account value</h2>
        <span className={`text-sm tabular-nums ${up ? "pos" : "neg"}`}>
          {fmtMoney(latest)}{" "}
          {deltaPct != null && `(${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`}
        </span>
        {spyDeltaPct != null && (
          <span className="text-xs tabular-nums text-zinc-500">
            SPY {spyDeltaPct >= 0 ? "+" : ""}
            {spyDeltaPct.toFixed(1)}% over the same span
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="mt-1 h-28 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="account value over time vs SPY rebased to the same start"
      >
        <path
          d={path(spySeries)}
          fill="none"
          stroke="#71717a"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path(snaps.map((s) => s.totalValue))}
          fill="none"
          stroke={up ? "#34d399" : "#f87171"}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        {snaps.map((s, i) => (
          <circle key={s.id} cx={x(i)} cy={y(s.totalValue)} r={1.6} fill={up ? "#34d399" : "#f87171"}>
            <title>{`${s.snapshotDate} · ${fmtMoney(s.totalValue)} · ${s.holdingCount} holding(s)`}</title>
          </circle>
        ))}
      </svg>
      <p className="mt-1 text-[10px] text-zinc-600">
        {snaps.length} daily snapshots since {snaps[0].snapshotDate} · each point is the last
        refresh of that day · dashed line: SPY rebased to the same start · raw data, not a
        performance guarantee.
      </p>
    </section>
  );
}

import { scoreSeries } from "@/lib/queries";

// Stock-score history sparkline (roadmap #33). Server component — plots the
// last daily overall score per day from the append-only stock_scores table
// (same dependency-free SVG idiom as the Sector Scout trend). Labeled with
// its point count so a short history is never over-read.

export function ScoreSparkline({ ticker }: { ticker: string }) {
  const pts = scoreSeries(ticker);
  if (pts.length === 0) return null;
  if (pts.length < 2) {
    return (
      <p className="text-[10px] text-zinc-600">
        Score history: 1 point ({pts[0].date}) — no trend yet.
      </p>
    );
  }

  const w = 240;
  const h = 36;
  const vals = pts.map((p) => p.overallScore);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * (w - 6) + 3;
  const y = (v: number) => h - 4 - ((v - lo) / span) * (h - 8);
  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.overallScore).toFixed(1)}`)
    .join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? "#34d399" : "#f87171";

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="muted text-xs">Score trend</span>
        <span className="text-[10px] tabular-nums text-zinc-600">
          {lo.toFixed(1)}–{hi.toFixed(1)} · {pts.length} daily points since {pts[0].date}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="mt-0.5 h-9 w-full max-w-60"
        role="img"
        aria-label={`daily overall score trend for ${ticker}`}
      >
        <path d={line} fill="none" stroke={color} strokeWidth={1.5} />
        {pts.map((p, i) => (
          <circle key={p.date} cx={x(i)} cy={y(p.overallScore)} r={1.3} fill={color}>
            <title>{`${p.date} · score ${p.overallScore.toFixed(1)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

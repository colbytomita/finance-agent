import { freshness } from "@/lib/format";

export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null || !isFinite(score)) {
    return <span className="text-zinc-600">—</span>;
  }
  const color =
    score >= 7
      ? "bg-emerald-950 text-emerald-300 border-emerald-800"
      : score >= 5
        ? "bg-zinc-800 text-zinc-300 border-zinc-700"
        : score >= 3
          ? "bg-amber-950 text-amber-300 border-amber-800"
          : "bg-red-950 text-red-300 border-red-800";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold tabular-nums ${color}`}>
      {score.toFixed(1)}
    </span>
  );
}

const REC_COLORS: Record<string, string> = {
  Enter: "bg-emerald-950 text-emerald-300 border-emerald-800",
  Add: "bg-emerald-950 text-emerald-300 border-emerald-800",
  "Strong Buy Candidate": "bg-emerald-950 text-emerald-300 border-emerald-800",
  "Buy Candidate": "bg-emerald-950/60 text-emerald-300 border-emerald-900",
  Hold: "bg-sky-950 text-sky-300 border-sky-900",
  "Strong Hold / Consider Add": "bg-emerald-950/60 text-emerald-300 border-emerald-900",
  Wait: "bg-zinc-800 text-zinc-300 border-zinc-700",
  "Watch / Hold": "bg-zinc-800 text-zinc-300 border-zinc-700",
  "Monitor Closely": "bg-amber-950 text-amber-300 border-amber-800",
  Trim: "bg-amber-950 text-amber-300 border-amber-800",
  "Trim / Prepare Exit": "bg-amber-950 text-amber-300 border-amber-800",
  "Avoid / Risk Elevated": "bg-amber-950 text-amber-300 border-amber-800",
  Exit: "bg-red-950 text-red-300 border-red-800",
  Avoid: "bg-red-950 text-red-300 border-red-800",
  "Strong Avoid": "bg-red-950 text-red-300 border-red-800",
};

export function RecBadge({ rec }: { rec: string | null | undefined }) {
  if (!rec) return <span className="text-zinc-600">—</span>;
  const color = REC_COLORS[rec] ?? "bg-zinc-800 text-zinc-300 border-zinc-700";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {rec}
    </span>
  );
}

export function Freshness({
  capturedAt,
  staleMinutes = 30,
}: {
  capturedAt: string | null | undefined;
  staleMinutes?: number;
}) {
  const f = freshness(capturedAt, staleMinutes);
  return (
    <span
      className={`text-[11px] tabular-nums ${f.isStale ? "text-amber-400" : "text-zinc-500"}`}
      title={capturedAt ?? "no data"}
    >
      {f.label}
    </span>
  );
}

export function Pct({ value, digits = 1 }: { value: number | null | undefined; digits?: number }) {
  if (value == null || !isFinite(value)) return <span className="text-zinc-600">—</span>;
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "text-zinc-400";
  return (
    <span className={`tabular-nums ${cls}`}>
      {value > 0 ? "+" : ""}
      {value.toFixed(digits)}%
    </span>
  );
}

export function SeverityDot({ severity }: { severity: string }) {
  const color =
    severity === "critical" ? "bg-red-500" : severity === "warning" ? "bg-amber-400" : "bg-sky-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

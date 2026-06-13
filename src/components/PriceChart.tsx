// Dependency-free SVG line chart for daily closes with optional level lines.

interface Level {
  value: number;
  label: string;
  color: string; // stroke color
}

export function PriceChart({
  closes,
  dates,
  levels = [],
  width = 720,
  height = 220,
}: {
  closes: number[];
  dates: string[];
  levels?: Level[];
  width?: number;
  height?: number;
}) {
  if (closes.length < 2) {
    return <p className="text-sm text-zinc-500">Not enough price history for a chart.</p>;
  }
  const pad = 8;
  const values = [...closes, ...levels.map((l) => l.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / (closes.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / range) * (height - pad * 2);
  const path = closes.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(" ");
  const last = closes[closes.length - 1];
  const first = closes[0];
  const lineColor = last >= first ? "#34d399" : "#f87171";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full rounded border border-zinc-800 bg-zinc-950"
      role="img"
      aria-label="price chart"
    >
      {levels.map((l) => (
        <g key={l.label}>
          <line
            x1={pad}
            x2={width - pad}
            y1={y(l.value)}
            y2={y(l.value)}
            stroke={l.color}
            strokeDasharray="4 4"
            strokeWidth={1}
            opacity={0.6}
          />
          <text x={width - pad - 4} y={y(l.value) - 3} textAnchor="end" fontSize={10} fill={l.color}>
            {l.label} {l.value.toFixed(2)}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke={lineColor} strokeWidth={1.5} />
      <text x={pad} y={12} fontSize={10} fill="#71717a">
        {dates[0]?.slice(0, 10)}
      </text>
      <text x={width - pad} y={12} textAnchor="end" fontSize={10} fill="#71717a">
        {dates[dates.length - 1]?.slice(0, 10)} · {last.toFixed(2)}
      </text>
    </svg>
  );
}

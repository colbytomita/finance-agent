"use client";

// Dependency-free interactive SVG line chart for daily closes with optional
// level lines, axis labels, an area fill, a hover crosshair + tooltip, and
// client-side time-range filtering (1M / 3M / 6M / 1Y).

import { useRef, useState, type MouseEvent } from "react";

interface Level {
  value: number;
  label: string;
  color: string; // stroke color
}

const RANGES: { label: string; days: number }[] = [
  { label: "1M", days: 21 },
  { label: "3M", days: 63 },
  { label: "6M", days: 126 },
  { label: "1Y", days: 252 },
];

export function PriceChart({
  closes,
  dates,
  levels = [],
  width = 760,
  height = 280,
}: {
  closes: number[];
  dates: string[];
  levels?: Level[];
  width?: number;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [rangeDays, setRangeDays] = useState(252); // default: 1Y (or all available)

  if (closes.length < 2) {
    return <p className="text-sm text-zinc-500">Not enough price history for a chart.</p>;
  }

  // Slice to the selected range (last N trading days).
  const count = Math.min(closes.length, rangeDays);
  const vCloses = closes.slice(-count);
  const vDates = dates.slice(-count);

  // Margins leave gutters for the y-axis (left) and x-axis (bottom) labels so
  // text never overlaps the plotted line.
  const m = { top: 14, right: 16, bottom: 26, left: 52 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  // Scale to the visible closes; only draw levels that fall in view so a distant
  // stop/target can't squash the price action when zoomed in.
  const cMin = Math.min(...vCloses);
  const cMax = Math.max(...vCloses);
  const range = cMax - cMin || 1;
  const padR = range * 0.06;
  const lo = cMin - padR;
  const hi = cMax + padR;
  const span = hi - lo || 1;
  const visibleLevels = levels.filter((l) => l.value >= lo && l.value <= hi);

  const x = (i: number) => m.left + (i / (vCloses.length - 1)) * innerW;
  const y = (v: number) => m.top + (1 - (v - lo) / span) * innerH;

  const line = vCloses
    .map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c).toFixed(1)}`)
    .join(" ");
  const baseY = (m.top + innerH).toFixed(1);
  const area = `${line} L${x(vCloses.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;

  const last = vCloses[vCloses.length - 1];
  const up = last >= vCloses[0];
  const lineColor = up ? "#34d399" : "#f87171";
  const fillId = `pc-grad-${up ? "up" : "dn"}`;
  const changePct = ((last - vCloses[0]) / vCloses[0]) * 100;

  const yTicks = Array.from({ length: 5 }, (_, i) => lo + (span * i) / 4);
  const xTickIdx = Array.from({ length: 5 }, (_, i) =>
    Math.round((i / 4) * (vCloses.length - 1)),
  );
  const fmtDay = (d?: string) => (d ? d.slice(5, 10) : ""); // MM-DD

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * width; // px -> viewBox units
    const frac = (vbX - m.left) / innerW;
    const idx = Math.max(0, Math.min(vCloses.length - 1, Math.round(frac * (vCloses.length - 1))));
    setHover(idx);
  };

  const hv = hover != null ? vCloses[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hv != null ? y(hv) : 0;
  const tipText = hover != null ? `${vDates[hover]?.slice(0, 10)} · ${vCloses[hover].toFixed(2)}` : "";
  const tipW = Math.max(104, tipText.length * 6.3);
  const tipX = Math.min(width - m.right - tipW, Math.max(m.left, hx - tipW / 2));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => {
                setRangeDays(r.days);
                setHover(null);
              }}
              className={`rounded px-2 py-0.5 text-xs ${
                rangeDays === r.days
                  ? "bg-sky-900/60 text-sky-100 border border-sky-700"
                  : "border border-zinc-700 text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs tabular-nums">
          <span className="text-zinc-500">{count}d&nbsp;</span>
          <span className={changePct >= 0 ? "pos" : "neg"}>
            {changePct >= 0 ? "+" : ""}
            {changePct.toFixed(1)}%
          </span>
        </span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full cursor-crosshair rounded border border-zinc-800 bg-zinc-950"
        role="img"
        aria-label="price chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Y gridlines + price labels */}
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth={1} />
            <text x={m.left - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#a1a1aa">
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {/* X date labels */}
        {xTickIdx.map((idx) => (
          <text key={`x${idx}`} x={x(idx)} y={height - 8} textAnchor="middle" fontSize={10} fill="#a1a1aa">
            {fmtDay(vDates[idx])}
          </text>
        ))}

        {/* Area + line */}
        <path d={area} fill={`url(#${fillId})`} stroke="none" />
        <path d={line} fill="none" stroke={lineColor} strokeWidth={1.6} />

        {/* Level lines (support/resistance/stop/target) within view */}
        {visibleLevels.map((l) => (
          <g key={l.label}>
            <line
              x1={m.left}
              x2={width - m.right}
              y1={y(l.value)}
              y2={y(l.value)}
              stroke={l.color}
              strokeDasharray="4 4"
              strokeWidth={1}
              opacity={0.75}
            />
            <text x={width - m.right - 4} y={y(l.value) - 3} textAnchor="end" fontSize={10} fill={l.color}>
              {l.label} {l.value.toFixed(2)}
            </text>
          </g>
        ))}

        {/* Last price marker */}
        <circle cx={x(vCloses.length - 1)} cy={y(last)} r={2.5} fill={lineColor} />

        {/* Hover crosshair + tooltip */}
        {hover != null && hv != null && (
          <g>
            <line x1={hx} x2={hx} y1={m.top} y2={m.top + innerH} stroke="#52525b" strokeWidth={1} />
            <circle cx={hx} cy={hy} r={3.5} fill={lineColor} stroke="#0a0a0a" strokeWidth={1.5} />
            <rect x={tipX} y={m.top + 2} width={tipW} height={18} rx={3} fill="#18181b" stroke="#3f3f46" />
            <text x={tipX + tipW / 2} y={m.top + 14} textAnchor="middle" fontSize={10.5} fill="#fafafa">
              {tipText}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

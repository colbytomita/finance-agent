"use client";

// Dependency-free interactive SVG line chart for daily closes with optional
// level lines, a volume sub-band, event markers, axis labels, an area fill, a
// hover crosshair + tooltip, and client-side range filtering (1M / 3M / 6M / 1Y).

import { useRef, useState, type MouseEvent } from "react";

interface Level {
  value: number;
  label: string;
  color: string; // stroke color
}

export type ChartEventType = "earnings" | "catalyst" | "mention";

export interface ChartEvent {
  date: string; // ISO
  type: ChartEventType;
  title: string;
}

const RANGES: { label: string; days: number }[] = [
  { label: "1M", days: 21 },
  { label: "3M", days: 63 },
  { label: "6M", days: 126 },
  { label: "1Y", days: 252 },
];

const EVENT_STYLE: Record<ChartEventType, { glyph: string; color: string; label: string }> = {
  earnings: { glyph: "▲", color: "#fbbf24", label: "earnings" },
  catalyst: { glyph: "●", color: "#38bdf8", label: "catalyst" },
  mention: { glyph: "◆", color: "#a78bfa", label: "mention" },
};

export function PriceChart({
  closes,
  dates,
  levels = [],
  volumes,
  events = [],
  width = 760,
  height = 300,
}: {
  closes: number[];
  dates: string[];
  levels?: Level[];
  volumes?: number[];
  events?: ChartEvent[];
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
  const hasVol = Array.isArray(volumes) && volumes.length === closes.length;
  const vVols = hasVol ? volumes!.slice(-count) : null;
  const hasEvents = events.length > 0;

  // Margins leave gutters for the y-axis (left) and x-axis (bottom) labels.
  const m = { top: 14, right: 16, bottom: 26, left: 52 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  // Split the inner height into (price pane) + (event marker row) + (volume band).
  const volH = hasVol ? 42 : 0;
  const volGap = hasVol ? 6 : 0;
  const eventsRowH = hasEvents ? 14 : 0;
  const priceH = innerH - volH - volGap - eventsRowH;
  const priceBottom = m.top + priceH;
  const markerY = priceBottom + eventsRowH / 2;
  const volBottom = m.top + innerH;
  const volTop = volBottom - volH;

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
  const y = (v: number) => m.top + (1 - (v - lo) / span) * priceH;

  const line = vCloses
    .map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c).toFixed(1)}`)
    .join(" ");
  const baseY = priceBottom.toFixed(1);
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

  // Volume bars scaled to the visible max.
  const maxVol = vVols && vVols.length > 0 ? Math.max(...vVols, 1) : 1;
  const barW = Math.max(1, (innerW / Math.max(vCloses.length, 1)) * 0.7);

  // Map each event to the nearest visible bar, dropping events outside the window.
  const firstT = Date.parse(vDates[0]);
  const lastT = Date.parse(vDates[vDates.length - 1]);
  const tol = 3 * 86400000;
  const markers = events
    .map((ev) => ({ ev, t: Date.parse(ev.date) }))
    .filter((e) => Number.isFinite(e.t) && e.t >= firstT - tol && e.t <= lastT + tol)
    .map(({ ev, t }) => {
      let best = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < vDates.length; i++) {
        const diff = Math.abs(Date.parse(vDates[i]) - t);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      return { ev, idx: best };
    });

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

        {/* Y gridlines + price labels (price pane only) */}
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

        {/* Volume sub-band */}
        {hasVol && vVols && (
          <g>
            {vVols.map((vol, i) => {
              const h = Math.max(0, (vol / maxVol) * volH);
              const barUp = i === 0 || vCloses[i] >= vCloses[i - 1];
              return (
                <rect
                  key={`v${i}`}
                  x={x(i) - barW / 2}
                  y={volBottom - h}
                  width={barW}
                  height={h}
                  fill={barUp ? "#14532d" : "#4c1d1d"}
                />
              );
            })}
            <text x={m.left} y={volTop - 2} fontSize={9} fill="#52525b">
              volume
            </text>
          </g>
        )}

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

        {/* Event markers on the date axis (native <title> tooltip on hover) */}
        {markers.map((mk, i) => {
          const s = EVENT_STYLE[mk.ev.type];
          return (
            <text
              key={`e${i}`}
              x={x(mk.idx)}
              y={markerY + 4}
              textAnchor="middle"
              fontSize={10}
              fill={s.color}
              style={{ cursor: "help" }}
            >
              {s.glyph}
              <title>{`${mk.ev.date.slice(0, 10)} · ${s.label}: ${mk.ev.title}`}</title>
            </text>
          );
        })}

        {/* Last price marker */}
        <circle cx={x(vCloses.length - 1)} cy={y(last)} r={2.5} fill={lineColor} />

        {/* Hover crosshair + tooltip (price pane) */}
        {hover != null && hv != null && (
          <g>
            <line x1={hx} x2={hx} y1={m.top} y2={priceBottom} stroke="#52525b" strokeWidth={1} />
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

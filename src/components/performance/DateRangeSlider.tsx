"use client";

import { useId } from "react";
import { addDays, dayOffset, type DateRange } from "@/services/performanceFilter";

// Dual-thumb date-range control for the Signal Performance page. Built from two
// overlaid native <input type="range"> elements (see .range-thumb in globals.css)
// rather than a custom pointer-drag widget, so both handles get native keyboard
// support (arrows / Home / End) and screen-reader semantics for free.
//
// Days are addressed as integer offsets from the domain start; the arithmetic
// itself lives in performanceFilter.ts (UTC-only, unit-tested).

/** "Jun 13" / "Jun 13, 2025" — formatted in UTC so the day never shifts. */
function fmtDay(day: string, withYear: boolean): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

const PRESETS = [7, 30, 90] as const;

export interface DateRangeSliderProps {
  /** Full extent of the data — the slider's min/max. */
  domain: DateRange;
  /** Currently selected range (inclusive). */
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** Events inside the current selection, shown in the label. */
  eventCount: number;
}

export function DateRangeSlider({ domain, value, onChange, eventCount }: DateRangeSliderProps) {
  const id = useId();
  const max = dayOffset(domain.from, domain.to);
  const fromIdx = Math.min(Math.max(0, dayOffset(domain.from, value.from)), max);
  const toIdx = Math.min(Math.max(0, dayOffset(domain.from, value.to)), max);
  const spanDays = toIdx - fromIdx + 1;
  const totalDays = max + 1;
  const isFullRange = fromIdx === 0 && toIdx === max;
  // A single-day history has nothing to drag between.
  const disabled = max === 0;

  const pct = (idx: number) => (max === 0 ? 0 : (idx / max) * 100);
  const setFrom = (idx: number) => onChange({ from: addDays(domain.from, Math.min(idx, toIdx)), to: value.to });
  const setTo = (idx: number) => onChange({ from: value.from, to: addDays(domain.from, Math.max(idx, fromIdx)) });
  const applyPreset = (days: number | null) =>
    onChange(
      days == null
        ? { ...domain }
        : { from: addDays(domain.from, Math.max(0, max - days + 1)), to: domain.to },
    );

  const crossYear = domain.from.slice(0, 4) !== domain.to.slice(0, 4);

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Date range</span>
        <span className="text-xs tabular-nums text-zinc-300">
          {fmtDay(value.from, crossYear)} – {fmtDay(value.to, crossYear)}
          <span className="ml-2 text-zinc-500">
            {spanDays} {spanDays === 1 ? "day" : "days"} · {eventCount.toLocaleString()}{" "}
            {eventCount === 1 ? "event" : "events"}
          </span>
        </span>
      </div>

      <div className="relative h-6 select-none">
        {/* Track + selected span. Purely decorative; the inputs above own interaction. */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-800" />
        <div
          className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-sky-700"
          style={{ left: `${pct(fromIdx)}%`, right: `${100 - pct(toIdx)}%` }}
        />
        <input
          type="range"
          className="range-thumb"
          // Sits above the "to" input so the handles stay grabbable when both are
          // parked at the far right.
          style={{ zIndex: fromIdx >= max ? 4 : 3 }}
          min={0}
          max={max}
          step={1}
          value={fromIdx}
          disabled={disabled}
          onChange={(e) => setFrom(Number(e.target.value))}
          aria-label="Range start date"
          aria-describedby={id}
          aria-valuetext={fmtDay(value.from, true)}
        />
        <input
          type="range"
          className="range-thumb"
          style={{ zIndex: 3 }}
          min={0}
          max={max}
          step={1}
          value={toIdx}
          disabled={disabled}
          onChange={(e) => setTo(Number(e.target.value))}
          aria-label="Range end date"
          aria-describedby={id}
          aria-valuetext={fmtDay(value.to, true)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span id={id} className="sr-only">
          Filters every section on this page to signals dated inside the selected range.
        </span>
        {PRESETS.filter((d) => d < totalDays).map((d) => {
          const active = !isFullRange && toIdx === max && spanDays === d;
          return (
            <button
              key={d}
              type="button"
              className={`btn px-2 py-0.5 text-[11px] ${active ? "border-sky-700 bg-sky-900/60 text-sky-100" : ""}`}
              onClick={() => applyPreset(d)}
            >
              {d}d
            </button>
          );
        })}
        <button
          type="button"
          className={`btn px-2 py-0.5 text-[11px] ${isFullRange ? "border-sky-700 bg-sky-900/60 text-sky-100" : ""}`}
          onClick={() => applyPreset(null)}
        >
          All
        </button>
        <span className="ml-auto text-[11px] text-zinc-600">
          {fmtDay(domain.from, crossYear)} – {fmtDay(domain.to, crossYear)} available
        </span>
      </div>
    </div>
  );
}

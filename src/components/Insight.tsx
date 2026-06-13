"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Hover/focus popover used to explain model-derived values. The list tables are
// wrapped in `overflow-x-auto`, which clips absolutely-positioned children, so
// the panel is portaled to <body> and positioned with `position: fixed` from the
// trigger's bounding rect — it can never be clipped by the table.
//
// `children` is the value/badge to hover (server-rendered); `panel` is the
// server-composed explanation. All data logic stays server-side; this component
// only owns hover state + positioning.
export function Insight({ children, panel }: { children: ReactNode; panel: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const PANEL_WIDTH = 288; // matches w-72
    const margin = 8;
    const half = PANEL_WIDTH / 2;
    let left = r.left + r.width / 2;
    // Keep the centered panel within the viewport so edge cells don't overflow.
    left = Math.min(window.innerWidth - half - margin, Math.max(half + margin, left));
    setPos({ left, top: r.bottom + 6 });
  }

  function hide() {
    setPos(null);
  }

  return (
    <span
      ref={ref}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-4 outline-none"
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ left: pos.left, top: pos.top }}
            className="pointer-events-none fixed z-50 w-72 -translate-x-1/2 rounded-md border border-zinc-700 bg-zinc-900 p-2.5 text-left text-xs leading-relaxed text-zinc-300 shadow-xl"
          >
            {panel}
          </div>,
          document.body,
        )}
    </span>
  );
}

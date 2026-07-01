"use client";

import { useApiAction } from "./useApiAction";

export function GenerateBriefButton({ ticker }: { ticker: string }) {
  const { call, busy, error } = useApiAction();

  const generate = () => call(`/api/research/${ticker}`, { errorText: "brief generation failed" });

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn" onClick={generate} disabled={busy}>
        {busy ? "Generating…" : "Generate research brief"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

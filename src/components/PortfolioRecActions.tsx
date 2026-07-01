"use client";

import { useApiAction } from "./useApiAction";

// Accept ("Add") / Dismiss controls for a portfolio-derived watchlist suggestion.
// Accept promotes the holding into the watchlist; Dismiss hides it from future
// suggestions. Both POST to /api/portfolio-recs and refresh the page data.
export function PortfolioRecActions({
  ticker,
  companyName,
}: {
  ticker: string;
  companyName: string | null;
}) {
  const { call, busy, error } = useApiAction();

  const act = (action: "accept" | "dismiss") =>
    call("/api/portfolio-recs", {
      body: { ticker, companyName, action },
      keepBusyOnSuccess: true,
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={() => act("accept")}
        title="Add this holding to your watchlist"
      >
        Add
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => act("dismiss")}
        title="Stop suggesting this holding"
      >
        Dismiss
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

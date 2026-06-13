"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "accept" | "dismiss") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portfolio-recs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker, companyName, action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "failed");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  }

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

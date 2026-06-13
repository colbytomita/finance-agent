"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function GenerateBriefButton({ ticker }: { ticker: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/research/${ticker}`, { method: "POST" });
      if (!res.ok) throw new Error("brief generation failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn" onClick={generate} disabled={busy}>
        {busy ? "Generating…" : "Generate research brief"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

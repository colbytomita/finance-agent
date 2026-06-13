"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AgentScanButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  async function scan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/agent-watchlist", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "scan failed");
      setMsg(
        `Scanned ${data.scanned} — ${data.proposed} new pick(s)` +
          (data.errors?.length ? `, ${data.errors.length} error(s)` : ""),
      );
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "scan failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={scan} disabled={busy}>
        {busy ? "Scanning…" : "Run agent scan"}
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </span>
  );
}

export function CandidateActions({ id }: { id: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent-watchlist/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
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
        title="Add to your watchlist"
      >
        Accept
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => act("decline")}
        title="Dismiss this pick"
      >
        Decline
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </span>
  );
}

"use client";

import { useApiAction } from "./useApiAction";

export function AgentScanButton() {
  const { call, busy, msg, error } = useApiAction();

  const scan = () =>
    call<{ scanned: number; proposed: number; errors?: string[] }>("/api/agent-watchlist", {
      errorText: "scan failed",
      message: (d) =>
        `Scanned ${d.scanned} — ${d.proposed} new pick(s)` +
        (d.errors?.length ? `, ${d.errors.length} error(s)` : ""),
    });

  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn btn-primary" onClick={scan} disabled={busy}>
        {busy ? "Scanning…" : "Run agent scan"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}

export function CandidateActions({ id }: { id: number }) {
  const { call, busy, error } = useApiAction();

  const act = (action: "accept" | "decline") =>
    call(`/api/agent-watchlist/${id}`, { body: { action }, keepBusyOnSuccess: true });

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

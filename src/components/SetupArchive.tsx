"use client";

import { useState } from "react";
import { useApiAction } from "./useApiAction";

// Client actions for the swing recommendation archive (spec 2026-07-16).

export function ArchiveSetupButton({ setupId, ticker }: { setupId: number; ticker: string }) {
  const { call, busy, error } = useApiAction();
  return (
    <button
      className="text-xs text-zinc-400 underline hover:text-zinc-100 disabled:opacity-50"
      disabled={busy}
      title={error ?? `Archive this ${ticker} recommendation — keeps a snapshot and hides it while the setup lasts`}
      onClick={() => void call("/api/setups/archive", { body: { setupId }, errorText: "archive failed" })}
    >
      {error ? "retry archive" : busy ? "archiving…" : "Archive"}
    </button>
  );
}

export function UnarchiveButton({ id, ticker }: { id: number; ticker: string }) {
  const { call, busy, error } = useApiAction();
  return (
    <button
      className="text-xs text-zinc-400 underline hover:text-zinc-100 disabled:opacity-50"
      disabled={busy}
      title={error ?? `Remove the ${ticker} snapshot — it can list again immediately if still detected`}
      onClick={() => void call("/api/setups/unarchive", { body: { id }, errorText: "unarchive failed" })}
    >
      {error ? "retry" : busy ? "…" : "Unarchive"}
    </button>
  );
}

export function ArchiveNoteInput({ id, initial }: { id: number; initial: string | null }) {
  const { call, busy } = useApiAction();
  const [note, setNote] = useState(initial ?? "");
  const save = () => {
    if ((initial ?? "") !== note.trim()) {
      void call("/api/setups/note", { body: { id, note }, errorText: "saving note failed" });
    }
  };
  return (
    <input
      className="w-40 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
      placeholder="note…"
      value={note}
      disabled={busy}
      onChange={(e) => setNote(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

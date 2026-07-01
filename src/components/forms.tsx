"use client";

// Small client-side entry forms. Each POSTs to an API route and refreshes
// the server-rendered page data.

import { useState, type ReactNode } from "react";
import { formValues, useApiAction } from "./useApiAction";

/** POST/PATCH/DELETE a form payload to one URL; onDone fires only on success. */
function useSubmit(url: string, method = "POST") {
  const { call, busy, error } = useApiAction();
  async function submit(payload: Record<string, unknown>, onDone?: () => void) {
    const ok = await call(url, {
      method,
      body: payload,
      errorText: "Validation failed — check the fields.",
    });
    if (ok) onDone?.();
  }
  return { submit, busy, error };
}

function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? "▾ " : "▸ "}
        {label}
      </button>
      {open && <div className="card mt-2">{children}</div>}
    </div>
  );
}

const field = "flex flex-col gap-0.5";

export function AddWatchlistForm() {
  const { submit, busy, error } = useSubmit("/api/watchlist");
  return (
    <Collapsible label="Add to watchlist">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          const form = e.currentTarget;
          submit(formValues(e), () => form.reset());
        }}
      >
        <div className={field}>
          <label>Ticker *</label>
          <input name="ticker" required className="w-24 uppercase" placeholder="MSFT" />
        </div>
        <div className={field}>
          <label>Company</label>
          <input name="companyName" className="w-44" placeholder="Microsoft" />
        </div>
        <div className={field}>
          <label>Buy zone low</label>
          <input name="targetBuyLow" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Buy zone high</label>
          <input name="targetBuyHigh" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Reinvest above</label>
          <input name="reinvestAbovePrice" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Max risk price</label>
          <input name="maxRiskPrice" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Notes</label>
          <input name="notes" className="w-56" />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
    </Collapsible>
  );
}

export function AddHoldingForm() {
  const { submit, busy, error } = useSubmit("/api/portfolio");
  return (
    <Collapsible label="Add holding manually">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          const form = e.currentTarget;
          submit(formValues(e), () => form.reset());
        }}
      >
        <div className={field}>
          <label>Ticker *</label>
          <input name="ticker" required className="w-24 uppercase" />
        </div>
        <div className={field}>
          <label>Company</label>
          <input name="companyName" className="w-44" />
        </div>
        <div className={field}>
          <label>Shares *</label>
          <input name="shares" type="number" step="any" min="0" required className="w-28" />
        </div>
        <div className={field}>
          <label>Avg cost *</label>
          <input name="averageCost" type="number" step="any" min="0" required className="w-28" />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
    </Collapsible>
  );
}

export function AddTradeForm() {
  const { submit, busy, error } = useSubmit("/api/trades");
  return (
    <Collapsible label="Log a swing trade">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          const form = e.currentTarget;
          submit(formValues(e), () => form.reset());
        }}
      >
        <div className={field}>
          <label>Ticker *</label>
          <input name="ticker" required className="w-24 uppercase" />
        </div>
        <div className={field}>
          <label>Direction</label>
          <select name="direction" defaultValue="long">
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </div>
        <div className={field}>
          <label>Entry price *</label>
          <input name="entryPrice" type="number" step="any" min="0" required className="w-28" />
        </div>
        <div className={field}>
          <label>Shares *</label>
          <input name="shares" type="number" step="any" min="0" required className="w-24" />
        </div>
        <div className={field}>
          <label>Stop-loss</label>
          <input name="stopLoss" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Target 1</label>
          <input name="targetPrice1" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Target 2</label>
          <input name="targetPrice2" type="number" step="any" min="0" className="w-28" />
        </div>
        <div className={field}>
          <label>Thesis</label>
          <input name="thesis" className="w-72" placeholder="Why this trade?" />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
    </Collapsible>
  );
}

export function AddCatalystForm() {
  const { submit, busy, error } = useSubmit("/api/catalysts");
  return (
    <Collapsible label="Add catalyst manually">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          const form = e.currentTarget;
          submit(formValues(e), () => form.reset());
        }}
      >
        <div className={field}>
          <label>Ticker</label>
          <input name="ticker" className="w-24 uppercase" placeholder="(or blank)" />
        </div>
        <div className={field}>
          <label>Industry</label>
          <input name="industry" className="w-36" placeholder="e.g. Semis" />
        </div>
        <div className={field}>
          <label>Title *</label>
          <input name="title" required className="w-80" placeholder="Q2 earnings on Jul 25" />
        </div>
        <div className={field}>
          <label>Event date</label>
          <input name="eventDate" type="date" />
        </div>
        <div className={field}>
          <label>Impact (-5..+5)</label>
          <input name="impactScore" type="number" step="1" min="-5" max="5" className="w-20" />
        </div>
        <div className={field}>
          <label>Direction</label>
          <select name="impactDirection" defaultValue="">
            <option value="">auto</option>
            <option value="positive">positive</option>
            <option value="negative">negative</option>
            <option value="mixed">mixed</option>
            <option value="unknown">unknown</option>
          </select>
        </div>
        <div className={field}>
          <label>Source URL</label>
          <input name="sourceUrl" className="w-64" placeholder="https://…" />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
    </Collapsible>
  );
}

export function AddEarningsForm({ ticker }: { ticker: string }) {
  const { submit, busy, error } = useSubmit("/api/earnings");
  return (
    <Collapsible label="Log earnings result">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          const form = e.currentTarget;
          submit({ ...formValues(e), ticker }, () => form.reset());
        }}
      >
        <div className={field}>
          <label>Report date *</label>
          <input name="reportDate" type="date" required />
        </div>
        <div className={field}>
          <label>Period</label>
          <input name="fiscalPeriod" className="w-28" placeholder="Q2 2026" />
        </div>
        <div className={field}>
          <label>EPS estimate</label>
          <input name="epsEstimate" type="number" step="any" className="w-24" />
        </div>
        <div className={field}>
          <label>EPS actual</label>
          <input name="epsActual" type="number" step="any" className="w-24" />
        </div>
        <div className={field}>
          <label>Revenue est ($M)</label>
          <input name="revenueEstimate" type="number" step="any" className="w-28" />
        </div>
        <div className={field}>
          <label>Revenue actual ($M)</label>
          <input name="revenueActual" type="number" step="any" className="w-28" />
        </div>
        <div className={field}>
          <label>Surprise % (optional)</label>
          <input name="surprisePercent" type="number" step="any" className="w-24" placeholder="auto from EPS" />
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </form>
    </Collapsible>
  );
}

export function FetchEarningsButton({ ticker }: { ticker: string }) {
  const { call, busy, msg, error } = useApiAction();
  const go = () =>
    call<{ saved: number }>("/api/earnings/fetch", {
      body: { ticker },
      errorText: "fetch failed",
      message: (d) =>
        d.saved > 0
          ? `Saved ${d.saved} quarter(s) from Yahoo`
          : "No earnings found (Yahoo may be unavailable — try manual entry)",
    });
  return (
    <span className="inline-flex items-center gap-2">
      <button className="btn" onClick={go} disabled={busy} title="Auto-fetch quarterly earnings from Yahoo Finance">
        {busy ? "Fetching…" : "Fetch from Yahoo"}
      </button>
      {(msg ?? error) && <span className="text-xs text-zinc-500">{msg ?? error}</span>}
    </span>
  );
}

export function DeleteButton({ url, label = "✕" }: { url: string; label?: string }) {
  const { submit, busy } = useSubmit(url, "DELETE");
  return (
    <button
      className="text-xs text-zinc-600 hover:text-red-400"
      disabled={busy}
      onClick={() => submit({})}
      title="Delete"
    >
      {label}
    </button>
  );
}

export function CloseTradeButton({ tradeId, ticker }: { tradeId: number; ticker: string }) {
  const { submit, busy, error } = useSubmit(`/api/trades/${tradeId}`, "PATCH");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="text-xs text-zinc-400 hover:text-zinc-100 underline" onClick={() => setOpen(true)}>
        Close
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded border border-zinc-700 bg-zinc-900 p-2"
      onSubmit={(e) => {
        const payload = { ...formValues(e), action: "close" };
        submit(payload, () => setOpen(false));
      }}
    >
      <span className="text-xs font-semibold">{ticker}</span>
      <div className={field}>
        <label>Exit price</label>
        <input name="exitPrice" type="number" step="any" min="0" className="w-24" />
      </div>
      <div className={field}>
        <label>Exit reason</label>
        <input name="exitReason" className="w-40" />
      </div>
      <div className={field}>
        <label>Lessons</label>
        <input name="lessons" className="w-40" />
      </div>
      <button className="btn btn-danger" disabled={busy}>
        {busy ? "…" : "Close trade"}
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </form>
  );
}

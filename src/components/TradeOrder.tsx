"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useApiAction } from "./useApiAction";

// User-initiated trade entry. A "Trade" button on a setup row opens this dialog,
// pre-filled from the setup, where the user sets size/order type/protective legs
// and submits ONE order to Alpaca. On success the trade is logged as an open
// swing trade. Live (real-money) accounts require an explicit confirmation.

export interface PlaceOrderButtonProps {
  ticker: string;
  direction?: "long" | "short";
  suggestedShares?: number;
  /** Setup mid / current price — default limit and the reference for sizing/logging. */
  entryPrice?: number;
  stopLoss?: number | null;
  targetPrice1?: number | null;
  /** Alpaca mode, or null when Alpaca isn't configured. */
  mode: "paper" | "live" | null;
}

interface OrderResult {
  id: string;
  status: string;
  orderClass: string | null;
  filledAvgPrice: number | null;
}

const n2 = (v: number | null | undefined) => (v != null ? v.toFixed(2) : "");
const fieldCls = "flex flex-col gap-0.5";

export function PlaceOrderButton(props: PlaceOrderButtonProps) {
  const { ticker, mode } = props;
  const [open, setOpen] = useState(false);
  const { call, busy, error, reset: resetAction } = useApiAction();
  const [result, setResult] = useState<OrderResult | null>(null);

  const [direction, setDirection] = useState<"long" | "short">(props.direction ?? "long");
  const [shares, setShares] = useState(props.suggestedShares ? String(props.suggestedShares) : "");
  const [orderType, setOrderType] = useState<"market" | "limit">("limit");
  const [limitPrice, setLimitPrice] = useState(n2(props.entryPrice));
  const [timeInForce, setTimeInForce] = useState<"day" | "gtc">("gtc"); // swing trades are multi-day
  const [attachBracket, setAttachBracket] = useState(true);
  const [stopLoss, setStopLoss] = useState(n2(props.stopLoss));
  const [targetPrice1, setTargetPrice1] = useState(n2(props.targetPrice1));
  const [thesis, setThesis] = useState("");
  const [confirmLive, setConfirmLive] = useState(false);

  const configured = mode != null;
  const isLive = mode === "live";

  function reset() {
    resetAction();
    setResult(null);
    setConfirmLive(false);
  }

  function submit() {
    const referencePrice = props.entryPrice ?? (Number(limitPrice) || undefined);
    void call<{ order: OrderResult }>("/api/trades/place", {
      body: {
        ticker,
        direction,
        shares,
        orderType,
        limitPrice: orderType === "limit" ? limitPrice : null,
        timeInForce,
        referencePrice,
        attachBracket,
        stopLoss: attachBracket ? stopLoss : null,
        targetPrice1: attachBracket ? targetPrice1 : null,
        thesis: thesis || null,
        confirmLive,
        logTrade: true,
      },
      errorText: "Order rejected — check the fields.",
      onSuccess: (d) =>
        setResult({
          id: d.order.id,
          status: d.order.status,
          orderClass: d.order.orderClass,
          filledAvgPrice: d.order.filledAvgPrice,
        }),
    });
  }

  const estCost = Number(shares) * Number(orderType === "limit" ? limitPrice : props.entryPrice ?? 0);

  return (
    <>
      <button
        className="btn"
        disabled={!configured}
        onClick={() => {
          reset();
          setOpen(true);
        }}
        title={configured ? "Place an order with Alpaca" : "Connect Alpaca in .env to enable trading"}
      >
        Trade
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setOpen(false)}
          >
          <div
            className="card w-full max-w-lg max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-base font-bold">Trade {ticker}</h2>
              {mode && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    isLive ? "bg-red-950 text-red-300 border border-red-800" : "bg-sky-950 text-sky-300 border border-sky-800"
                  }`}
                >
                  {isLive ? "LIVE • real money" : "Paper"}
                </span>
              )}
              <button className="ml-auto text-zinc-500 hover:text-zinc-200" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>

            {result ? (
              <div className="space-y-3">
                <p className="text-sm text-emerald-300">
                  Order submitted — status <span className="font-semibold">{result.status}</span>
                  {result.orderClass ? ` (${result.orderClass})` : ""}.
                </p>
                <p className="text-xs text-zinc-400">
                  Order id <code className="text-zinc-300">{result.id}</code>
                  {result.filledAvgPrice != null ? ` · filled @ ${result.filledAvgPrice}` : " · not filled yet"}.
                  Logged as an open swing trade below.
                </p>
                <button className="btn btn-primary" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            ) : (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className="flex flex-wrap gap-3">
                  <div className={fieldCls}>
                    <label>Side</label>
                    <select value={direction} onChange={(e) => setDirection(e.target.value as "long" | "short")}>
                      <option value="long">Buy (long)</option>
                      <option value="short">Sell (short)</option>
                    </select>
                  </div>
                  <div className={fieldCls}>
                    <label>Shares *</label>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      required
                      value={shares}
                      onChange={(e) => setShares(e.target.value)}
                      className="w-24"
                    />
                  </div>
                  <div className={fieldCls}>
                    <label>Order type</label>
                    <select value={orderType} onChange={(e) => setOrderType(e.target.value as "market" | "limit")}>
                      <option value="limit">Limit</option>
                      <option value="market">Market</option>
                    </select>
                  </div>
                  {orderType === "limit" && (
                    <div className={fieldCls}>
                      <label>Limit price *</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        required
                        value={limitPrice}
                        onChange={(e) => setLimitPrice(e.target.value)}
                        className="w-28"
                      />
                    </div>
                  )}
                  <div className={fieldCls}>
                    <label>Time in force</label>
                    <select value={timeInForce} onChange={(e) => setTimeInForce(e.target.value as "day" | "gtc")}>
                      <option value="gtc">GTC</option>
                      <option value="day">Day</option>
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={attachBracket}
                    onChange={(e) => setAttachBracket(e.target.checked)}
                    className="h-auto w-auto"
                  />
                  Attach stop-loss &amp; target (bracket order)
                </label>

                {attachBracket && (
                  <div className="flex flex-wrap gap-3">
                    <div className={fieldCls}>
                      <label>Stop-loss</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={stopLoss}
                        onChange={(e) => setStopLoss(e.target.value)}
                        className="w-28"
                      />
                    </div>
                    <div className={fieldCls}>
                      <label>Target</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={targetPrice1}
                        onChange={(e) => setTargetPrice1(e.target.value)}
                        className="w-28"
                      />
                    </div>
                  </div>
                )}

                <div className={fieldCls}>
                  <label>Thesis / note</label>
                  <input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="Why this trade?" />
                </div>

                <p className="text-[11px] text-zinc-500">
                  Est. notional ≈ ${isFinite(estCost) ? estCost.toFixed(0) : "—"} ·{" "}
                  {orderType === "market"
                    ? "Market orders fill at the next available price."
                    : "Limit orders only fill at your price or better."}
                </p>

                {isLive && (
                  <label className="flex items-start gap-2 rounded border border-red-800 bg-red-950/40 p-2 text-xs text-red-200">
                    <input
                      type="checkbox"
                      checked={confirmLive}
                      onChange={(e) => setConfirmLive(e.target.checked)}
                      className="mt-0.5 h-auto w-auto"
                    />
                    This is a LIVE account — I understand this places a real order with real money.
                  </label>
                )}

                <div className="flex items-center gap-2">
                  <button
                    className={`btn ${isLive ? "btn-danger" : "btn-primary"}`}
                    disabled={busy || (isLive && !confirmLive)}
                  >
                    {busy ? "Placing…" : isLive ? "Place LIVE order" : "Place paper order"}
                  </button>
                  <button type="button" className="btn" onClick={() => setOpen(false)}>
                    Cancel
                  </button>
                  {error && <span className="text-xs text-red-400">{error}</span>}
                </div>
              </form>
            )}
          </div>
          </div>,
          document.body,
        )}
    </>
  );
}

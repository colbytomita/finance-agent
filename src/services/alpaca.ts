import type { Bar } from "@/lib/types";

// Alpaca REST client. Mostly read-only (account, positions, market data), plus a
// single, explicitly user-initiated order entry point (`placeOrder`). The app
// never trades autonomously — orders are only sent when the user submits the
// trade dialog and confirms, and default to the paper environment. Credentials
// come from env vars only.

export interface AlpacaConfig {
  apiKey: string;
  apiSecret: string;
  mode: "paper" | "live";
  fetchFn?: typeof fetch; // injectable for tests
}

export interface AlpacaAccount {
  accountNumber: string;
  equity: number;
  cash: number;
  buyingPower: number;
  portfolioValue: number;
  currency: string;
}

export interface AlpacaPosition {
  ticker: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPercent: number | null;
}

export interface AlpacaQuote {
  ticker: string;
  bidPrice: number | null;
  askPrice: number | null;
  midPrice: number | null;
  timestamp: string | null;
}

export interface AlpacaSnapshot {
  ticker: string;
  latestPrice: number | null;
  dailyChangePercent: number | null;
  prevClose: number | null;
  timestamp: string | null;
}

export interface AlpacaClock {
  isOpen: boolean;
  nextOpen: string | null;
  nextClose: string | null;
  timestamp: string | null;
}

export interface AlpacaOrderRequest {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit";
  timeInForce: "day" | "gtc";
  limitPrice?: number | null;
  /** Optional protective stop (creates a bracket/OTO order when set). */
  stopLoss?: number | null;
  /** Optional take-profit target (creates a bracket/OTO order when set). */
  takeProfit?: number | null;
}

export interface AlpacaOrder {
  id: string;
  symbol: string;
  qty: number | null;
  side: string;
  type: string;
  orderClass: string | null;
  status: string;
  limitPrice: number | null;
  filledAvgPrice: number | null;
  filledQty: number | null;
  submittedAt: string | null;
}

export class AlpacaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AlpacaError";
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return isFinite(n) ? n : null;
};

export class AlpacaService {
  private tradingBase: string;
  private dataBase = "https://data.alpaca.markets";
  private fetchFn: typeof fetch;

  constructor(private config: AlpacaConfig) {
    this.tradingBase =
      config.mode === "live"
        ? "https://api.alpaca.markets"
        : "https://paper-api.alpaca.markets";
    this.fetchFn = config.fetchFn ?? fetch;
  }

  static fromEnv(fetchFn?: typeof fetch): AlpacaService | null {
    const apiKey = process.env.ALPACA_API_KEY;
    const apiSecret = process.env.ALPACA_API_SECRET;
    if (!apiKey || !apiSecret) return null;
    const mode = process.env.ALPACA_MODE === "live" ? "live" : "paper";
    return new AlpacaService({ apiKey, apiSecret, mode, fetchFn });
  }

  get mode(): "paper" | "live" {
    return this.config.mode;
  }

  private async request<T>(base: string, path: string): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`, {
      headers: {
        "APCA-API-KEY-ID": this.config.apiKey,
        "APCA-API-SECRET-KEY": this.config.apiSecret,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AlpacaError(
        `Alpaca ${path} failed: ${res.status} ${body.slice(0, 200)}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  async getAccount(): Promise<AlpacaAccount> {
    const a = await this.request<Record<string, unknown>>(this.tradingBase, "/v2/account");
    return {
      accountNumber: String(a.account_number ?? ""),
      equity: num(a.equity) ?? 0,
      cash: num(a.cash) ?? 0,
      buyingPower: num(a.buying_power) ?? 0,
      portfolioValue: num(a.portfolio_value) ?? num(a.equity) ?? 0,
      currency: String(a.currency ?? "USD"),
    };
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const rows = await this.request<Record<string, unknown>[]>(
      this.tradingBase,
      "/v2/positions",
    );
    return rows.map((p) => ({
      ticker: String(p.symbol ?? ""),
      qty: num(p.qty) ?? 0,
      avgEntryPrice: num(p.avg_entry_price) ?? 0,
      currentPrice: num(p.current_price),
      marketValue: num(p.market_value),
      unrealizedPl: num(p.unrealized_pl),
      unrealizedPlPercent:
        num(p.unrealized_plpc) != null ? (num(p.unrealized_plpc) as number) * 100 : null,
    }));
  }

  async getLatestQuote(ticker: string): Promise<AlpacaQuote> {
    const data = await this.request<{
      quote?: { bp?: number; ap?: number; t?: string };
    }>(this.dataBase, `/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`);
    const bid = num(data.quote?.bp);
    const ask = num(data.quote?.ap);
    return {
      ticker,
      bidPrice: bid,
      askPrice: ask,
      midPrice: bid != null && ask != null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null,
      timestamp: data.quote?.t ?? null,
    };
  }

  async getHistoricalBars(
    ticker: string,
    timeframe = "1Day",
    limit = 365,
  ): Promise<Bar[]> {
    // Alpaca returns only the most recent bar when `start` is omitted, so derive
    // a start date from the requested limit (~1.5 calendar days per trading day
    // to cover weekends/holidays). We request newest-first (`sort=desc`): Alpaca
    // caps the response at `limit` rows from `start`, so the default ascending
    // order fills that quota with OLD bars and stops ~`limit×0.04` trading days
    // short of today (a large limit could miss the last couple of weeks). Sorting
    // desc returns the most-recent `limit` bars; we reverse back to ascending —
    // the order every caller (indicators, event study, getBars) expects.
    const startMs = Date.now() - Math.ceil(limit * 1.5) * 86400000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    const data = await this.request<{
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
    }>(
      this.dataBase,
      `/v2/stocks/${encodeURIComponent(ticker)}/bars?timeframe=${timeframe}&limit=${limit}&adjustment=split&feed=iex&sort=desc&start=${start}`,
    );
    return (data.bars ?? [])
      .map((b) => ({
        date: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      }))
      .reverse();
  }

  async getSnapshot(ticker: string): Promise<AlpacaSnapshot> {
    const s = await this.request<{
      latestTrade?: { p?: number; t?: string };
      dailyBar?: { c?: number };
      prevDailyBar?: { c?: number };
    }>(this.dataBase, `/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=iex`);
    const latest = num(s.latestTrade?.p) ?? num(s.dailyBar?.c);
    const prevClose = num(s.prevDailyBar?.c);
    return {
      ticker,
      latestPrice: latest,
      prevClose,
      dailyChangePercent:
        latest != null && prevClose != null && prevClose > 0
          ? ((latest - prevClose) / prevClose) * 100
          : null,
      timestamp: s.latestTrade?.t ?? null,
    };
  }

  async getMarketClock(): Promise<AlpacaClock> {
    const c = await this.request<{
      is_open?: boolean;
      next_open?: string;
      next_close?: string;
      timestamp?: string;
    }>(this.tradingBase, "/v2/clock");
    return {
      isOpen: Boolean(c.is_open),
      nextOpen: c.next_open ?? null,
      nextClose: c.next_close ?? null,
      timestamp: c.timestamp ?? null,
    };
  }

  private async post<T>(base: string, path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${base}${path}`, {
      method: "POST",
      headers: {
        "APCA-API-KEY-ID": this.config.apiKey,
        "APCA-API-SECRET-KEY": this.config.apiSecret,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Alpaca returns a JSON {message} on errors; surface it so the UI can show why.
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j.message) msg = j.message;
      } catch {
        /* not JSON — keep raw text */
      }
      throw new AlpacaError(`Alpaca ${path} failed: ${res.status} ${msg}`, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Build the Alpaca order payload for a trade request. Pure (no IO) so it can be
   * unit-tested. A stop+target becomes a bracket; a single protective leg becomes
   * an OTO; neither yields a plain order.
   */
  buildOrderPayload(req: AlpacaOrderRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      symbol: req.symbol.toUpperCase(),
      qty: String(req.qty),
      side: req.side,
      type: req.type,
      time_in_force: req.timeInForce,
    };
    if (req.type === "limit") {
      if (req.limitPrice == null) throw new AlpacaError("limit order requires a limit price");
      body.limit_price = String(req.limitPrice);
    }
    const hasStop = req.stopLoss != null;
    const hasTarget = req.takeProfit != null;
    if (hasStop && hasTarget) {
      body.order_class = "bracket";
      body.take_profit = { limit_price: String(req.takeProfit) };
      body.stop_loss = { stop_price: String(req.stopLoss) };
    } else if (hasStop || hasTarget) {
      body.order_class = "oto";
      if (hasTarget) body.take_profit = { limit_price: String(req.takeProfit) };
      if (hasStop) body.stop_loss = { stop_price: String(req.stopLoss) };
    }
    return body;
  }

  private parseOrder(o: Record<string, unknown>): AlpacaOrder {
    return {
      id: String(o.id ?? ""),
      symbol: String(o.symbol ?? ""),
      qty: num(o.qty),
      side: String(o.side ?? ""),
      type: String(o.type ?? ""),
      orderClass: (o.order_class as string) ?? null,
      status: String(o.status ?? "unknown"),
      limitPrice: num(o.limit_price),
      filledAvgPrice: num(o.filled_avg_price),
      filledQty: num(o.filled_qty),
      submittedAt: (o.submitted_at as string) ?? null,
    };
  }

  /** Submit an order to Alpaca (paper or live per config.mode). */
  async placeOrder(req: AlpacaOrderRequest): Promise<AlpacaOrder> {
    const o = await this.post<Record<string, unknown>>(
      this.tradingBase,
      "/v2/orders",
      this.buildOrderPayload(req),
    );
    const parsed = this.parseOrder(o);
    // Backstop the echo fields with the request values (Alpaca always returns
    // them, but the caller's intent is the safer default on a sparse response).
    return {
      ...parsed,
      symbol: parsed.symbol || req.symbol,
      side: parsed.side || req.side,
      type: parsed.type || req.type,
    };
  }

  /** Fetch a single order's current state (fill price/qty, status). */
  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const o = await this.request<Record<string, unknown>>(
      this.tradingBase,
      `/v2/orders/${encodeURIComponent(orderId)}`,
    );
    return this.parseOrder(o);
  }
}

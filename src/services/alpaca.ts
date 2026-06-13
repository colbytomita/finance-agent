import type { Bar } from "@/lib/types";

// Alpaca REST client. Read-only usage: account, positions, market data.
// This app NEVER places orders. Credentials come from env vars only.

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

  async getWatchlists(): Promise<{ name: string; tickers: string[] }[]> {
    const lists = await this.request<Record<string, unknown>[]>(
      this.tradingBase,
      "/v2/watchlists",
    );
    const result: { name: string; tickers: string[] }[] = [];
    for (const l of lists) {
      const detail = await this.request<{ assets?: { symbol: string }[]; name?: string }>(
        this.tradingBase,
        `/v2/watchlists/${l.id}`,
      );
      result.push({
        name: String(detail.name ?? l.name ?? "watchlist"),
        tickers: (detail.assets ?? []).map((a) => a.symbol),
      });
    }
    return result;
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
    // to cover weekends/holidays).
    const startMs = Date.now() - Math.ceil(limit * 1.5) * 86400000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    const data = await this.request<{
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
    }>(
      this.dataBase,
      `/v2/stocks/${encodeURIComponent(ticker)}/bars?timeframe=${timeframe}&limit=${limit}&adjustment=split&feed=iex&start=${start}`,
    );
    return (data.bars ?? []).map((b) => ({
      date: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
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
}

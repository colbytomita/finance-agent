import { describe, expect, it, vi } from "vitest";
import { AlpacaError, AlpacaService } from "../alpaca";

function mockFetch(routes: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.entries(routes).find(([path]) => url.includes(path));
    if (!match) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(match[1]), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const cfg = { apiKey: "key", apiSecret: "secret", mode: "paper" as const };

describe("AlpacaService", () => {
  it("uses the paper endpoint in paper mode and sends auth headers", async () => {
    const fetchFn = mockFetch({ "/v2/account": { equity: "50000", account_number: "A1", currency: "USD" } });
    const svc = new AlpacaService({ ...cfg, fetchFn });
    const account = await svc.getAccount();
    expect(account.equity).toBe(50000);
    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("paper-api.alpaca.markets");
    expect(call[1].headers["APCA-API-KEY-ID"]).toBe("key");
  });

  it("parses positions with numeric coercion", async () => {
    const svc = new AlpacaService({
      ...cfg,
      fetchFn: mockFetch({
        "/v2/positions": [
          {
            symbol: "MSFT",
            qty: "10",
            avg_entry_price: "400.5",
            current_price: "420",
            market_value: "4200",
            unrealized_pl: "195",
            unrealized_plpc: "0.0487",
          },
        ],
      }),
    });
    const positions = await svc.getPositions();
    expect(positions[0]).toMatchObject({
      ticker: "MSFT",
      qty: 10,
      avgEntryPrice: 400.5,
      currentPrice: 420,
      unrealizedPlPercent: 4.87,
    });
  });

  it("computes snapshot day change from prev close", async () => {
    const svc = new AlpacaService({
      ...cfg,
      fetchFn: mockFetch({
        "/snapshot": {
          latestTrade: { p: 105, t: "2026-06-12T14:00:00Z" },
          prevDailyBar: { c: 100 },
        },
      }),
    });
    const snap = await svc.getSnapshot("MSFT");
    expect(snap.latestPrice).toBe(105);
    expect(snap.dailyChangePercent).toBeCloseTo(5);
  });

  it("maps historical bars to the Bar shape, requests newest-first, and returns ascending", async () => {
    // Alpaca returns newest-first (sort=desc); getHistoricalBars must reverse to
    // ascending so a large limit still includes today's bar.
    const fetchFn = mockFetch({
      "/bars": {
        bars: [
          { t: "2026-06-12T04:00:00Z", o: 3, h: 4, l: 2.5, c: 3.5, v: 1200 },
          { t: "2026-06-11T04:00:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 1100 },
          { t: "2026-06-10T04:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 },
        ],
      },
    });
    const svc = new AlpacaService({ ...cfg, fetchFn });
    const bars = await svc.getHistoricalBars("MSFT");
    // Returned ascending (oldest first) regardless of Alpaca's desc response.
    expect(bars.map((b) => b.date)).toEqual([
      "2026-06-10T04:00:00Z",
      "2026-06-11T04:00:00Z",
      "2026-06-12T04:00:00Z",
    ]);
    expect(bars[0]).toEqual({ date: "2026-06-10T04:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 });
    const url = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    // Alpaca returns only the latest bar unless `start` is supplied (regression guard),
    // and we must sort desc so a large limit reaches today (the stale-bars fix).
    expect(url).toMatch(/[?&]start=\d{4}-\d{2}-\d{2}/);
    expect(url).toMatch(/[?&]sort=desc/);
  });

  it("throws AlpacaError with status on API failure", async () => {
    const svc = new AlpacaService({
      ...cfg,
      fetchFn: mockFetch({ "/v2/account": { message: "forbidden" } }, 403),
    });
    await expect(svc.getAccount()).rejects.toThrowError(AlpacaError);
    await expect(svc.getAccount()).rejects.toMatchObject({ status: 403 });
  });

  it("handles missing quote fields without crashing", async () => {
    const svc = new AlpacaService({
      ...cfg,
      fetchFn: mockFetch({ "/quotes/latest": { quote: {} } }),
    });
    const quote = await svc.getLatestQuote("MSFT");
    expect(quote.midPrice).toBeNull();
    expect(quote.bidPrice).toBeNull();
  });

  it("fromEnv returns null without credentials", () => {
    const prevKey = process.env.ALPACA_API_KEY;
    const prevSecret = process.env.ALPACA_API_SECRET;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;
    expect(AlpacaService.fromEnv()).toBeNull();
    if (prevKey) process.env.ALPACA_API_KEY = prevKey;
    if (prevSecret) process.env.ALPACA_API_SECRET = prevSecret;
  });

  it("builds a bracket order payload when both protective legs are set", () => {
    const svc = new AlpacaService(cfg);
    const body = svc.buildOrderPayload({
      symbol: "msft",
      qty: 10,
      side: "buy",
      type: "limit",
      timeInForce: "day",
      limitPrice: 400,
      stopLoss: 390,
      takeProfit: 420,
    });
    expect(body).toMatchObject({
      symbol: "MSFT", // upper-cased
      qty: "10",
      side: "buy",
      type: "limit",
      time_in_force: "day",
      limit_price: "400",
      order_class: "bracket",
      take_profit: { limit_price: "420" },
      stop_loss: { stop_price: "390" },
    });
  });

  it("uses OTO for one protective leg and a plain order for none", () => {
    const svc = new AlpacaService(cfg);
    const oto = svc.buildOrderPayload({
      symbol: "AAPL", qty: 5, side: "buy", type: "market", timeInForce: "day", stopLoss: 100,
    });
    expect(oto).toMatchObject({ order_class: "oto", stop_loss: { stop_price: "100" } });
    expect(oto.take_profit).toBeUndefined();

    const plain = svc.buildOrderPayload({
      symbol: "AAPL", qty: 5, side: "buy", type: "market", timeInForce: "day",
    });
    expect(plain.order_class).toBeUndefined();
    expect(plain.limit_price).toBeUndefined();
  });

  it("rejects a limit order with no limit price", () => {
    const svc = new AlpacaService(cfg);
    expect(() =>
      svc.buildOrderPayload({ symbol: "AAPL", qty: 5, side: "buy", type: "limit", timeInForce: "day" }),
    ).toThrowError(AlpacaError);
  });

  it("placeOrder POSTs to /v2/orders and parses the response", async () => {
    const fetchFn = mockFetch({
      "/v2/orders": {
        id: "o1",
        symbol: "MSFT",
        qty: "10",
        side: "buy",
        type: "limit",
        order_class: "bracket",
        status: "accepted",
        limit_price: "400",
        filled_avg_price: null,
        submitted_at: "2026-06-24T00:00:00Z",
      },
    });
    const svc = new AlpacaService({ ...cfg, fetchFn });
    const order = await svc.placeOrder({
      symbol: "MSFT", qty: 10, side: "buy", type: "limit", timeInForce: "day",
      limitPrice: 400, stopLoss: 390, takeProfit: 420,
    });
    expect(order).toMatchObject({ id: "o1", status: "accepted", orderClass: "bracket", qty: 10 });
    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/v2/orders");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toMatchObject({ symbol: "MSFT", order_class: "bracket" });
  });

  it("getOrder fetches one order and parses fill fields with numeric coercion", async () => {
    const fetchFn = mockFetch({
      "/v2/orders/o1": {
        id: "o1",
        symbol: "MSFT",
        qty: "10",
        side: "buy",
        type: "limit",
        status: "partially_filled",
        limit_price: "400",
        filled_avg_price: "399.87",
        filled_qty: "4",
        submitted_at: "2026-06-24T00:00:00Z",
      },
    });
    const svc = new AlpacaService({ ...cfg, fetchFn });
    const order = await svc.getOrder("o1");
    expect(order).toMatchObject({
      id: "o1",
      status: "partially_filled",
      filledAvgPrice: 399.87,
      filledQty: 4,
    });
    const url = String((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toContain("/v2/orders/o1");
    expect(url).toContain("paper-api.alpaca.markets");
  });
});

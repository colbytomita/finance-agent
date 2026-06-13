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

  it("maps historical bars to the Bar shape", async () => {
    const svc = new AlpacaService({
      ...cfg,
      fetchFn: mockFetch({
        "/bars": {
          bars: [{ t: "2026-06-10T04:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 }],
        },
      }),
    });
    const bars = await svc.getHistoricalBars("MSFT");
    expect(bars[0]).toEqual({
      date: "2026-06-10T04:00:00Z",
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 1000,
    });
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
});

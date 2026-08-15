import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { useTestDb } from "@/services/__tests__/dbHarness";
import * as watchlistRoute from "../watchlist/route";
import * as tradesRoute from "../trades/route";
import * as tradesIdRoute from "../trades/[id]/route";
import * as tradesIdExitRoute from "../trades/[id]/exit/route";
import * as portfolioIdExitRoute from "../portfolio/[id]/exit/route";
import * as exitAllRoute from "../trades/exit-all/route";
import * as tradesPlaceRoute from "../trades/place/route";
import * as eventsRoute from "../events/route";
import * as jobsRoute from "../jobs/route";
import * as settingsRoute from "../settings/route";
import * as tradesExportRoute from "../trades/export/route";
import * as ackAllRoute from "../alerts/ack-all/route";
import * as unackedCountRoute from "../alerts/unacked-count/route";
import { emitAlert } from "@/services/alerts";

// Route-handler smoke tests (agent-memory "likely next work"): call the JSON
// handlers directly against the in-memory database — no server, no network.

useTestDb();

const jsonReq = (method: string, body: unknown) =>
  new Request("http://test.local/api", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("POST /api/watchlist", () => {
  it("rejects invalid payloads with 400", async () => {
    const res = await watchlistRoute.POST(jsonReq("POST", { ticker: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects an inverted buy zone", async () => {
    const res = await watchlistRoute.POST(
      jsonReq("POST", { ticker: "MSFT", targetBuyLow: 500, targetBuyHigh: 400 }),
    );
    expect(res.status).toBe(400);
  });

  it("upserts a row and GET returns it", async () => {
    const res = await watchlistRoute.POST(jsonReq("POST", { ticker: "msft", companyName: "Microsoft" }));
    expect(res.status).toBe(200);
    const list = (await (await watchlistRoute.GET()).json()) as { ticker: string }[];
    expect(list.map((w) => w.ticker)).toEqual(["MSFT"]);
  });
});

describe("POST /api/trades — pre-trade risk gate (roadmap #29)", () => {
  it("400s with riskProblems when stop and target are missing", async () => {
    const res = await tradesRoute.POST(
      jsonReq("POST", { ticker: "MSFT", entryPrice: 100, shares: 5 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { riskProblems?: string[] };
    expect(body.riskProblems?.join(" ")).toMatch(/stop-loss/i);
    expect(body.riskProblems?.join(" ")).toMatch(/no target/i);
    expect(getDb().select().from(schema.activeTrades).all()).toHaveLength(0);
  });

  it("logs the same trade when risks are explicitly confirmed", async () => {
    const res = await tradesRoute.POST(
      jsonReq("POST", { ticker: "MSFT", entryPrice: 100, shares: 5, confirmRisks: true }),
    );
    expect(res.status).toBe(200);
    expect(getDb().select().from(schema.activeTrades).all()).toHaveLength(1);
  });

  it("flags thin R/R; a clean trade passes without confirmation", async () => {
    const thin = await tradesRoute.POST(
      jsonReq("POST", {
        ticker: "MSFT",
        entryPrice: 100,
        shares: 5,
        stopLoss: 95,
        targetPrice1: 104, // 0.8:1 vs the default 2:1 minimum
      }),
    );
    expect(thin.status).toBe(400);
    const body = (await thin.json()) as { riskProblems?: string[] };
    expect(body.riskProblems?.join(" ")).toMatch(/minimum/i);

    const clean = await tradesRoute.POST(
      jsonReq("POST", {
        ticker: "AAPL",
        entryPrice: 100,
        shares: 5,
        stopLoss: 95,
        targetPrice1: 111, // 2.2:1
      }),
    );
    expect(clean.status).toBe(200);
  });
});

describe("POST /api/trades/place — risk gate runs before the broker", () => {
  it("returns riskProblems even with Alpaca unconfigured, then the broker error once confirmed", async () => {
    // Tests never load .env; make double-sure no broker creds leak in.
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;

    const gated = await tradesPlaceRoute.POST(
      jsonReq("POST", {
        ticker: "MSFT",
        shares: 5,
        orderType: "limit",
        limitPrice: 100,
        referencePrice: 100,
        attachBracket: false, // no stop, no target
      }),
    );
    expect(gated.status).toBe(400);
    const gBody = (await gated.json()) as { riskProblems?: string[] };
    expect(gBody.riskProblems?.join(" ")).toMatch(/stop-loss/i);

    const confirmed = await tradesPlaceRoute.POST(
      jsonReq("POST", {
        ticker: "MSFT",
        shares: 5,
        orderType: "limit",
        limitPrice: 100,
        referencePrice: 100,
        attachBracket: false,
        confirmRisks: true,
      }),
    );
    expect(confirmed.status).toBe(400);
    const cBody = (await confirmed.json()) as { error?: string; riskProblems?: string[] };
    expect(cBody.riskProblems).toBeUndefined();
    expect(cBody.error).toMatch(/alpaca is not configured/i);
  });
});

describe("PATCH /api/trades/[id]", () => {
  it("404s on an unknown trade", async () => {
    const res = await tradesIdRoute.PATCH(jsonReq("PATCH", { action: "close" }), params(999));
    expect(res.status).toBe(404);
  });

  it("closes a trade and auto-creates the journal entry", async () => {
    getDb()
      .insert(schema.activeTrades)
      .values({
        ticker: "MSFT",
        direction: "long",
        entryPrice: 400,
        entryDate: "2026-06-25T14:30:00Z",
        shares: 10,
        positionSize: 4000,
        status: "open",
        thesis: "Breakout",
        createdAt: "2026-06-25T14:30:00Z",
        updatedAt: "2026-06-25T14:30:00Z",
      })
      .run();
    const id = getDb().select().from(schema.activeTrades).all()[0].id;

    const res = await tradesIdRoute.PATCH(
      jsonReq("PATCH", { action: "close", exitPrice: 440, exitReason: "target" }),
      params(id),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profitLoss: number };
    expect(body.profitLoss).toBeCloseTo(400);

    expect(getDb().select().from(schema.activeTrades).all()[0].status).toBe("closed");
    const journal = getDb().select().from(schema.tradeJournalEntries).all();
    expect(journal).toHaveLength(1);
    expect(journal[0].exitReason).toBe("target");
  });

  // The close form posts strings, and `z.coerce.boolean()` is just Boolean(v) —
  // so "no" coerced to TRUE. Every "the thesis did not play out" would have been
  // recorded as one that did, silently inverting the thesis-played-out rate.
  it.each([
    ["yes", true],
    ["no", false],
    ["true", true],
    ["false", false],
    ["", null],
  ])("records thesisPlayedOut=%s from the form as %s", async (input, expected) => {
    getDb()
      .insert(schema.activeTrades)
      .values({
        ticker: "AMZN",
        direction: "long",
        entryPrice: 100,
        entryDate: "2026-06-25T14:30:00Z",
        shares: 1,
        positionSize: 100,
        status: "open",
        createdAt: "2026-06-25T14:30:00Z",
        updatedAt: "2026-06-25T14:30:00Z",
      })
      .run();
    const trade = getDb().select().from(schema.activeTrades).all().at(-1)!;

    const res = await tradesIdRoute.PATCH(
      jsonReq("PATCH", { action: "close", exitPrice: 110, thesisPlayedOut: input }),
      params(trade.id),
    );
    expect(res.status).toBe(200);
    const journal = getDb()
      .select()
      .from(schema.tradeJournalEntries)
      .all()
      .filter((j) => j.tradeId === trade.id);
    expect(journal[0].thesisPlayedOut).toBe(expected);
  });
});

// The exit routes send REAL orders, so these cover the guards that run BEFORE
// the broker is touched. Alpaca is unconfigured in tests, which is itself one of
// the guards — no order can escape from a test run.
describe("POST /api/trades/[id]/exit", () => {
  const openTrade = () => {
    getDb()
      .insert(schema.activeTrades)
      .values({
        ticker: "NVDA",
        direction: "long",
        entryPrice: 100,
        entryDate: "2026-08-01T14:30:00Z",
        shares: 5,
        positionSize: 500,
        status: "open",
        broker: "alpaca-paper",
        brokerOrderId: "entry-x",
        createdAt: "2026-08-01T14:30:00Z",
        updatedAt: "2026-08-01T14:30:00Z",
      })
      .run();
    return getDb().select().from(schema.activeTrades).all().at(-1)!;
  };

  it("404s an unknown trade", async () => {
    const res = await tradesIdExitRoute.POST(jsonReq("POST", {}), params(9999));
    expect(res.status).toBe(404);
  });

  it("refuses to exit a trade that is already closed", async () => {
    const t = openTrade();
    getDb().update(schema.activeTrades).set({ status: "closed" }).where(eq(schema.activeTrades.id, t.id)).run();
    const res = await tradesIdExitRoute.POST(jsonReq("POST", {}), params(t.id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already closed/i);
  });

  it("refuses when Alpaca is not configured rather than half-unwinding", async () => {
    const t = openTrade();
    const res = await tradesIdExitRoute.POST(jsonReq("POST", {}), params(t.id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not configured/i);
    // Critically, the trade is untouched — no partial state.
    expect(getDb().select().from(schema.activeTrades).all().find((x) => x.id === t.id)!.status).toBe("open");
  });
});

describe("POST /api/trades/exit-all", () => {
  const jsonReqNoParams = (body: unknown) => jsonReq("POST", body);

  it("rejects without the exact typed confirmation", async () => {
    for (const confirm of ["", "exit all", "EXITALL", "yes"]) {
      const res = await exitAllRoute.POST(jsonReqNoParams({ confirm }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/type "EXIT ALL"/i);
    }
  });

  it("passes the confirmation gate but still refuses when Alpaca is unconfigured", async () => {
    // Proves the phrase check is not the only guard standing between a stray
    // request and a batch of real orders.
    const res = await exitAllRoute.POST(jsonReqNoParams({ confirm: "EXIT ALL" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not configured/i);
  });
});

describe("POST /api/portfolio/[id]/exit", () => {
  it("404s an unknown holding", async () => {
    const res = await portfolioIdExitRoute.POST(jsonReq("POST", {}), params(9999));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/events (mentions)", () => {
  it("inserts once, then reports a same-day duplicate without inserting", async () => {
    const body = { entity: "Jane Doe", ticker: "MSFT", eventDate: "2026-07-01" };
    const first = (await (await eventsRoute.POST(jsonReq("POST", body))).json()) as {
      id: number;
      duplicate: boolean;
    };
    expect(first.duplicate).toBe(false);

    const second = (await (
      await eventsRoute.POST(jsonReq("POST", { ...body, entity: "jane doe", ticker: "msft" }))
    ).json()) as { id: number; duplicate: boolean };
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(getDb().select().from(schema.entityMentions).all()).toHaveLength(1);
  });
});

describe("GET /api/jobs", () => {
  it("reports never-ran as stale", async () => {
    const health = (await (await jobsRoute.GET()).json()) as {
      stale: boolean;
      heartbeatAgeMinutes: number | null;
    };
    expect(health.stale).toBe(true);
    expect(health.heartbeatAgeMinutes).toBeNull();
  });
});

describe("settings API", () => {
  it("rejects an out-of-range value", async () => {
    const res = await settingsRoute.POST(jsonReq("POST", { riskPerTradePercent: 99 }));
    expect(res.status).toBe(400);
  });

  it("saves a partial update and GET reflects it without leaking secrets", async () => {
    const res = await settingsRoute.POST(jsonReq("POST", { notifyEnabled: true, ntfyTopic: "t-1" }));
    expect(res.status).toBe(200);

    const got = (await (await settingsRoute.GET()).json()) as {
      config: Record<string, unknown>;
      integrations: Record<string, unknown>;
    };
    expect(got.config.notifyEnabled).toBe(true);
    expect(got.config.ntfyTopic).toBe("t-1");
    // Only booleans/labels about integrations — never key material.
    expect(JSON.stringify(got.integrations)).not.toMatch(/key|secret/i);
  });
});

describe("GET /api/trades/export", () => {
  it("returns a CSV header row and one row per closed trade, escaped", async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const inserted = db
      .insert(schema.activeTrades)
      .values({
        ticker: "MSFT",
        direction: "long",
        entryPrice: 400,
        entryDate: now,
        shares: 10,
        stopLoss: 380,
        exitPrice: 440, // R = (440-400)/(400-380) = 2
        status: "closed",
        unrealizedGainLoss: 400,
        unrealizedGainLossPercent: 10,
        thesis: "Breakout, needs escaping",
        createdAt: now,
        updatedAt: now,
        closedAt: now,
      })
      .run();
    db.insert(schema.tradeJournalEntries)
      .values({
        tradeId: Number(inserted.lastInsertRowid),
        ticker: "MSFT",
        exitReason: 'Target, "hit"',
        holdingPeriodDays: 5,
        thesisPlayedOut: true,
        profitLoss: 400,
        profitLossPercent: 10,
        createdAt: now,
      })
      .run();

    const res = tradesExportRoute.GET();
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await res.text();
    const lines = text.trim().split(/\r\n/);
    expect(lines).toHaveLength(2); // header + one closed trade
    expect(lines[0].startsWith("ticker,direction,entry_date")).toBe(true);
    expect(lines[1]).toContain("MSFT,long,");
    expect(lines[1]).toContain(",2,"); // r_multiple
    // Fields with commas/quotes are RFC-4180 escaped.
    expect(text).toContain('"Breakout, needs escaping"');
    expect(text).toContain('"Target, ""hit"""');
  });
});

describe("POST /api/alerts/ack-all (roadmap #35)", () => {
  it("acks exactly the filtered set and reports the count", async () => {
    emitAlert("near_stop_loss", "warning", "MSFT warn", "MSFT");
    emitAlert("exit_recommended", "critical", "NVDA exit", "NVDA");
    emitAlert("info_note", "info", "AAPL note", "AAPL");

    const res = await ackAllRoute.POST(jsonReq("POST", { severity: "warning" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { acked: number }).acked).toBe(1);
    const rows = getDb().select().from(schema.alerts).all();
    expect(rows.filter((a) => a.acknowledged).map((a) => a.ticker)).toEqual(["MSFT"]);

    // No filter → the rest; already-acked rows are never re-counted.
    const all = await ackAllRoute.POST(jsonReq("POST", {}));
    expect(((await all.json()) as { acked: number }).acked).toBe(2);
    expect(getDb().select().from(schema.alerts).all().every((a) => a.acknowledged)).toBe(true);
  });
});

describe("GET /api/alerts/unacked-count (roadmap #42)", () => {
  it("counts unacked rows and criticals; acked rows don't count", async () => {
    emitAlert("near_stop_loss", "warning", "MSFT warn", "MSFT");
    emitAlert("exit_recommended", "critical", "NVDA exit", "NVDA");
    emitAlert("info_note", "info", "AAPL note", "AAPL");
    getDb().update(schema.alerts).set({ acknowledged: true }).where(eq(schema.alerts.ticker, "AAPL")).run();

    const res = await unackedCountRoute.GET();
    expect((await res.json()) as object).toEqual({ count: 2, critical: 1 });
  });
});

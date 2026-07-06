import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { useTestDb } from "@/services/__tests__/dbHarness";
import * as watchlistRoute from "../watchlist/route";
import * as tradesIdRoute from "../trades/[id]/route";
import * as eventsRoute from "../events/route";
import * as jobsRoute from "../jobs/route";
import * as settingsRoute from "../settings/route";

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

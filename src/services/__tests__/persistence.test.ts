import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { useTestDb } from "./dbHarness";
import { upsertWatchlistItem } from "../watchlist";
import { emitAlert, generateAlerts, listAlerts } from "../alerts";
import { closeTrade } from "../trades";
import { recordJobRun, getJobHealth } from "../jobHealth";
import { addMention, findSameDayMention } from "../entityMentions";
import { runRetention, runSqliteHousekeeping } from "../retention";
import {
  watchEntity,
  unwatchEntity,
  isEntityWatched,
  alertWatchedEntities,
  type EntityMentionBatch,
} from "../watchedEntities";
import {
  addCatalyst,
  upsertUpcomingEarningsCatalyst,
  EARNINGS_CALENDAR_SOURCE,
} from "../catalysts";
import { daysToNextEarnings, getCatalystInputs } from "../marketData";
import { scoreSeries, upcomingEarningsCalendar } from "@/lib/queries";
import { industryScanTrend } from "../sectorScout";
import { portfolioHistory, upsertPortfolioSnapshot } from "../portfolioHistory";
import { dedupeSetups } from "../setupPerformance";
import { saveConfig, loadConfig } from "@/lib/config";

// Write-path integration tests against an in-memory SQLite database
// (roadmap #6). Each test starts from a fresh, fully-migrated schema.

useTestDb();

const daysAgo = (d: number, hour = 12) => {
  const t = new Date(Date.now() - d * 24 * 3600 * 1000);
  t.setUTCHours(hour, 0, 0, 0);
  return t.toISOString();
};

describe("watchlist upsert", () => {
  it("inserts, then updates by ticker preserving createdAt", () => {
    upsertWatchlistItem({ ticker: "msft", companyName: "Microsoft" });
    const first = getDb().select().from(schema.watchlistItems).all()[0];
    expect(first.ticker).toBe("MSFT");

    upsertWatchlistItem({ ticker: "MSFT", companyName: "Microsoft Corp", targetBuyLow: 400 });
    const rows = getDb().select().from(schema.watchlistItems).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].companyName).toBe("Microsoft Corp");
    expect(rows[0].targetBuyLow).toBe(400);
    expect(rows[0].createdAt).toBe(first.createdAt);
  });
});

describe("alert emit dedupe", () => {
  it("drops an identical type+message within 20h, allows a different message", () => {
    expect(emitAlert("near_stop_loss", "warning", "MSFT: within 2% of stop.", "MSFT")).toBe(true);
    expect(emitAlert("near_stop_loss", "warning", "MSFT: within 2% of stop.", "MSFT")).toBe(false);
    expect(emitAlert("near_stop_loss", "warning", "MSFT: within 1% of stop.", "MSFT")).toBe(true);
    expect(getDb().select().from(schema.alerts).all()).toHaveLength(2);
  });

  it("listAlerts filters by severity, ticker, and acknowledged (roadmap #27)", () => {
    emitAlert("near_stop_loss", "warning", "MSFT warn", "MSFT");
    emitAlert("exit", "critical", "NVDA exit", "NVDA");
    emitAlert("info_note", "info", "AAPL note", "AAPL");
    getDb().update(schema.alerts).set({ acknowledged: true }).where(eq(schema.alerts.ticker, "AAPL")).run();

    expect(listAlerts({ severity: "critical" }).map((a) => a.ticker)).toEqual(["NVDA"]);
    expect(listAlerts({ ticker: "msft" }).map((a) => a.message)).toEqual(["MSFT warn"]);
    expect(listAlerts({ acknowledged: false })).toHaveLength(2);
    expect(listAlerts({ acknowledged: true }).map((a) => a.ticker)).toEqual(["AAPL"]);
  });
});

describe("portfolio equity snapshots (roadmap #31)", () => {
  const holding = (ticker: string, marketValue: number) =>
    getDb()
      .insert(schema.portfolioHoldings)
      .values({
        ticker,
        shares: 1,
        averageCost: marketValue,
        marketValue,
        source: "manual",
        updatedAt: new Date().toISOString(),
      })
      .run();

  it("upserts one row per day and two across days", () => {
    holding("MSFT", 4000);
    expect(upsertPortfolioSnapshot("2026-07-08")?.totalValue).toBe(4000);
    // Same day again after a price move → still one row, updated value.
    getDb().update(schema.portfolioHoldings).set({ marketValue: 4100 }).run();
    expect(upsertPortfolioSnapshot("2026-07-08")?.totalValue).toBe(4100);
    expect(portfolioHistory()).toHaveLength(1);
    expect(portfolioHistory()[0].totalValue).toBe(4100);
    // Next day → second row, oldest first.
    upsertPortfolioSnapshot("2026-07-09");
    expect(portfolioHistory().map((s) => s.snapshotDate)).toEqual(["2026-07-08", "2026-07-09"]);
  });

  it("writes nothing when there's no priced value to record", () => {
    expect(upsertPortfolioSnapshot()).toBeNull();
    expect(portfolioHistory()).toHaveLength(0);
  });

  it("adds open trades only for tickers the holdings don't already carry", () => {
    holding("MSFT", 4000);
    const trade = (ticker: string) =>
      getDb()
        .insert(schema.activeTrades)
        .values({
          ticker,
          direction: "long",
          entryPrice: 100,
          entryDate: new Date().toISOString(),
          shares: 10,
          positionSize: 1000,
          currentPrice: 100,
          status: "open",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run();
    trade("MSFT"); // already held — must not double-count
    trade("TSLA"); // not held — counts
    const snap = upsertPortfolioSnapshot("2026-07-08");
    expect(snap?.totalValue).toBe(5000);
    expect(portfolioHistory()[0].holdingsValue).toBe(4000);
    expect(portfolioHistory()[0].openTradesValue).toBe(1000);
  });
});

describe("account concentration alerts (roadmap #30)", () => {
  const holding = (ticker: string, marketValue: number) =>
    getDb()
      .insert(schema.portfolioHoldings)
      .values({
        ticker,
        shares: 1,
        averageCost: marketValue,
        marketValue,
        source: "manual",
        updatedAt: new Date().toISOString(),
      })
      .run();

  it("emits one warning for an oversized holding; rerun is deduped", () => {
    // One holding = 100% of the account — way past the default 20% cap.
    holding("NVDA", 5000);
    generateAlerts();
    const conc = () =>
      getDb().select().from(schema.alerts).all().filter((a) => a.alertType === "concentration");
    expect(conc()).toHaveLength(1);
    expect(conc()[0].ticker).toBe("NVDA");
    expect(conc()[0].severity).toBe("warning");
    expect(conc()[0].message).toMatch(/NVDA is 100% of the account/);

    generateAlerts(); // identical rerun → deduped by the 20h window
    expect(conc()).toHaveLength(1);
  });

  it("stays quiet when every position is under the cap", () => {
    for (const t of ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA"]) holding(t, 1000);
    generateAlerts(); // six equal holdings ≈ 16.7% each, under the 20% cap
    const conc = getDb().select().from(schema.alerts).all().filter((a) => a.alertType === "concentration");
    expect(conc).toHaveLength(0);
  });

  it("counts an open trade the account doesn't already hold", () => {
    // No holdings → account value falls back to the configured 10k;
    // a 3k open trade is 30% of it.
    getDb()
      .insert(schema.activeTrades)
      .values({
        ticker: "TSLA",
        direction: "long",
        entryPrice: 100,
        entryDate: new Date().toISOString(),
        shares: 30,
        positionSize: 3000,
        currentPrice: 100,
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    generateAlerts();
    const conc = getDb().select().from(schema.alerts).all().filter((a) => a.alertType === "concentration");
    expect(conc).toHaveLength(1);
    expect(conc[0].message).toMatch(/TSLA is 30% of the account/);
  });
});

describe("closeTrade", () => {
  it("closes the row and pre-fills the journal with computed P/L", () => {
    const db = getDb();
    db.insert(schema.activeTrades)
      .values({
        ticker: "MSFT",
        direction: "long",
        entryPrice: 400,
        entryDate: daysAgo(10),
        shares: 5,
        positionSize: 2000,
        status: "open",
        thesis: "Breakout hold.",
        tradeScore: 6.5,
        createdAt: daysAgo(10),
        updatedAt: daysAgo(10),
      })
      .run();
    const trade = db.select().from(schema.activeTrades).all()[0];

    const res = closeTrade(trade, { exitPrice: 420, exitReason: "Target reached" });
    expect(res.profitLoss).toBeCloseTo(100);
    expect(res.profitLossPercent).toBeCloseTo(5);

    const closed = db.select().from(schema.activeTrades).all()[0];
    expect(closed.status).toBe("closed");
    expect(closed.exitPrice).toBe(420);
    expect(closed.closedAt).toBeTruthy();

    const journal = db.select().from(schema.tradeJournalEntries).all();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      tradeId: trade.id,
      ticker: "MSFT",
      entryReason: "Breakout hold.",
      exitReason: "Target reached",
      exitScore: 6.5,
    });
    // entryDate is noon-snapped 10 days ago, so the holding period lands in
    // [9.5, 10.5] depending on the wall-clock hour — assert the range, not an exact day.
    expect(journal[0].holdingPeriodDays).toBeGreaterThanOrEqual(9.4);
    expect(journal[0].holdingPeriodDays).toBeLessThanOrEqual(10.6);
  });

  it("shorts profit when price falls", () => {
    const db = getDb();
    db.insert(schema.activeTrades)
      .values({
        ticker: "XYZ",
        direction: "short",
        entryPrice: 100,
        entryDate: daysAgo(3),
        shares: 10,
        positionSize: 1000,
        status: "open",
        createdAt: daysAgo(3),
        updatedAt: daysAgo(3),
      })
      .run();
    const trade = db.select().from(schema.activeTrades).all()[0];
    const res = closeTrade(trade, { exitPrice: 90 });
    expect(res.profitLoss).toBeCloseTo(100);
    expect(res.profitLossPercent).toBeCloseTo(10);
  });
});

describe("job heartbeat", () => {
  it("upserts one row per job and computes staleness", () => {
    expect(getJobHealth().stale).toBe(true); // never ran

    recordJobRun("heartbeat");
    recordJobRun("refresh", "error", "boom");
    recordJobRun("refresh"); // recovers
    const health = getJobHealth();
    expect(health.jobs).toHaveLength(2);
    expect(health.jobs.find((j) => j.job === "refresh")?.status).toBe("ok");
    expect(health.heartbeatAgeMinutes).toBe(0);
    expect(health.stale).toBe(false);
  });
});

describe("retention", () => {
  it("prunes old rows but keeps each ticker's latest, and thins old scores per day", () => {
    const db = getDb();
    for (const [ticker, at] of [
      ["AAPL", daysAgo(30)],
      ["AAPL", daysAgo(1)],
      ["GHOST", daysAgo(40)],
      ["GHOST", daysAgo(20)],
    ] as const)
      db.insert(schema.marketPriceSnapshots).values({ ticker, source: "manual", capturedAt: at }).run();

    const score = (at: string) => ({
      ticker: "AAPL",
      overallScore: 5,
      valuationScore: 5,
      momentumScore: 5,
      catalystScore: 5,
      riskScore: 5,
      sentimentScore: 5,
      recommendation: "hold",
      calculatedAt: at,
    });
    for (const at of [daysAgo(45, 9), daysAgo(45, 15), daysAgo(2, 9)])
      db.insert(schema.stockScores).values(score(at)).run();

    const res = runRetention();
    expect(res.snapshotsDeleted).toBe(2); // AAPL@30d and GHOST@40d
    expect(res.scoresThinned).toBe(1); // old day thinned to its last row

    const snaps = db.select().from(schema.marketPriceSnapshots).all();
    expect(snaps.map((s) => s.ticker).sort()).toEqual(["AAPL", "GHOST"]); // latest per ticker survives
    const scores = db.select().from(schema.stockScores).all();
    expect(scores).toHaveLength(2);
    expect(scores.some((s) => s.calculatedAt === daysAgo(45, 15))).toBe(true); // kept the day's last
  });

  it("thins old setups to first-per-day without changing the backtest's episodes (roadmap #38)", () => {
    const db = getDb();
    const setup = (detectedAt: string, status = "expired", ticker = "MSFT") =>
      db
        .insert(schema.tradeSetups)
        .values({
          ticker,
          setupType: "breakout",
          setupQualityScore: 7,
          entryRangeLow: 100,
          entryRangeHigh: 102,
          stopLoss: 95,
          targetPrice1: 110,
          riskRewardRatio: 2,
          detectedAt,
          status,
        })
        .run();
    // One old episode re-detected across two days (several rows per day),
    // then a second episode after a >10-day gap, plus a recent active row.
    setup(daysAgo(60, 9));
    setup(daysAgo(60, 15));
    setup(daysAgo(59, 9));
    setup(daysAgo(59, 15));
    setup(daysAgo(40, 9)); // new episode (19-day gap)
    setup(daysAgo(1, 9), "active");

    const before = dedupeSetups(db.select().from(schema.tradeSetups).all());
    const res = runRetention();
    expect(res.setupsThinned).toBe(2); // the two later-in-day duplicates
    const after = dedupeSetups(db.select().from(schema.tradeSetups).all());

    // Same episodes, same episode-start rows, before and after thinning.
    expect(after.map((s) => s.detectedAt)).toEqual(before.map((s) => s.detectedAt));
    expect(after.map((s) => s.detectedAt)).toEqual([daysAgo(60, 9), daysAgo(40, 9), daysAgo(1, 9)]);
    // Active row untouched even though hypothetical duplicates would thin.
    expect(db.select().from(schema.tradeSetups).all().filter((s) => s.status === "active")).toHaveLength(1);
  });

  it("auto-acks stale non-critical alerts and prunes old acked ones (roadmap #36)", () => {
    const db = getDb();
    const alert = (severity: string, acknowledged: boolean, createdAt: string, message: string) =>
      db
        .insert(schema.alerts)
        .values({ alertType: "test", severity, message, acknowledged, createdAt })
        .run();
    alert("info", false, daysAgo(20), "stale info — auto-ack");
    alert("warning", false, daysAgo(20), "stale warning — auto-ack");
    alert("critical", false, daysAgo(20), "stale critical — stays unacked");
    alert("info", false, daysAgo(2), "recent info — untouched");
    alert("info", true, daysAgo(120), "ancient acked — deleted");
    alert("info", true, daysAgo(30), "acked but recent — kept");

    const res = runRetention();
    expect(res.alertsAutoAcked).toBe(2);
    expect(res.alertsDeleted).toBe(1);

    const rows = db.select().from(schema.alerts).all();
    expect(rows).toHaveLength(5);
    const byMsg = new Map(rows.map((a) => [a.message, a]));
    expect(byMsg.get("stale info — auto-ack")?.acknowledged).toBe(true);
    expect(byMsg.get("stale warning — auto-ack")?.acknowledged).toBe(true);
    expect(byMsg.get("stale critical — stays unacked")?.acknowledged).toBe(false);
    expect(byMsg.get("recent info — untouched")?.acknowledged).toBe(false);
    expect(byMsg.has("ancient acked — deleted")).toBe(false);
  });
});

describe("sector scout scan trend (roadmap #25)", () => {
  it("returns an industry's scans oldest-first with mean pick scores, isolated per industry", () => {
    const db = getDb();
    const row = (industry: string, ranAt: string, mean: number | null, proposed: number) => ({
      industry,
      considered: 10,
      scanned: 8,
      proposed,
      thesisReports: 0,
      minScore: 7,
      expandedBy: "rules",
      meanPickScore: mean,
      maxPickScore: mean,
      ranAt,
    });
    db.insert(schema.sectorScans).values(row("space", daysAgo(3), 7.2, 2)).run();
    db.insert(schema.sectorScans).values(row("space", daysAgo(2), null, 0)).run(); // a run with no picks
    db.insert(schema.sectorScans).values(row("space", daysAgo(1), 7.8, 3)).run();
    db.insert(schema.sectorScans).values(row("energy", daysAgo(1), 5, 1)).run();

    const trend = industryScanTrend("space");
    expect(trend).toHaveLength(3); // energy excluded
    expect(trend.map((p) => p.meanPickScore)).toEqual([7.2, null, 7.8]); // chronological, oldest first
    expect(trend[0].proposed).toBe(2);
  });
});

describe("watched entities (roadmap #24)", () => {
  const batch = (entries: [string, number, string[]][]): Map<string, EntityMentionBatch> =>
    new Map(entries.map(([e, count, tickers]) => [e, { count, tickers: new Set(tickers) }]));

  it("alerts a watched entity once, ignores unwatched, and dedupes reruns", () => {
    watchEntity("Elon Musk");
    const b = batch([
      ["Elon Musk", 2, ["TSLA", "DJT"]],
      ["Nancy Pelosi", 1, ["NVDA"]], // not watched → no alert
    ]);

    expect(alertWatchedEntities(b)).toBe(1);
    const alerts = getDb().select().from(schema.alerts).all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe("Elon Musk: 2 new mentions — DJT, TSLA");

    // An identical re-run is deduped by emitAlert's 20h window.
    expect(alertWatchedEntities(b)).toBe(0);
    expect(getDb().select().from(schema.alerts).all()).toHaveLength(1);
  });

  it("emits nothing when no entities are watched", () => {
    expect(alertWatchedEntities(batch([["Someone", 3, ["AAPL"]]]))).toBe(0);
    expect(getDb().select().from(schema.alerts).all()).toHaveLength(0);
  });

  it("watch/unwatch is case-insensitive", () => {
    watchEntity("Jerome Powell");
    expect(isEntityWatched("JEROME POWELL")).toBe(true);
    unwatchEntity("jerome powell");
    expect(isEntityWatched("Jerome Powell")).toBe(false);
  });
});

describe("sqlite housekeeping (roadmap #20)", () => {
  it("runs PRAGMA optimize + wal_checkpoint without error on the in-memory DB", () => {
    const hk = runSqliteHousekeeping();
    expect(hk.optimized).toBe(true);
    // A :memory: DB isn't in WAL mode, so the checkpoint no-ops harmlessly —
    // the point is it doesn't throw and returns the expected shape.
    expect(typeof hk.walCheckpointed).toBe("boolean");
    expect(hk).toHaveProperty("walPages");
  });
});

describe("mention duplicate lookup", () => {
  it("finds a same entity/ticker/day mention case-insensitively", () => {
    addMention({ entity: "Donald Trump", ticker: "djt", eventDate: "2026-07-01" });
    expect(findSameDayMention("donald trump", "DJT", "2026-07-01")?.entity).toBe("Donald Trump");
    expect(findSameDayMention("Donald Trump", "DJT", "2026-07-02")).toBeNull();
    expect(findSameDayMention("Elon Musk", "DJT", "2026-07-01")).toBeNull();
  });
});

describe("config round-trip", () => {
  it("persists partial saves merged over defaults", () => {
    expect(loadConfig().notifyEnabled).toBe(false);
    saveConfig({ notifyEnabled: true, ntfyTopic: "my-topic" });
    const cfg = loadConfig();
    expect(cfg.notifyEnabled).toBe(true);
    expect(cfg.ntfyTopic).toBe("my-topic");
    expect(cfg.riskProfile).toBe("balanced"); // untouched default survives
  });

  it("honors the legacy yahooBrowserEnabled key and drops it on the next save", () => {
    getDb()
      .insert(schema.appSettings)
      .values({
        key: "app_config",
        value: JSON.stringify({ yahooBrowserEnabled: false }),
        updatedAt: new Date().toISOString(),
      })
      .run();
    expect(loadConfig().yahooEnabled).toBe(false);

    saveConfig({ notifyEnabled: true }); // unrelated save re-persists under the new key
    const row = getDb().select().from(schema.appSettings).all().find((r) => r.key === "app_config")!;
    const stored = JSON.parse(row.value) as Record<string, unknown>;
    expect(stored.yahooEnabled).toBe(false);
    expect("yahooBrowserEnabled" in stored).toBe(false);
    expect(loadConfig().yahooEnabled).toBe(false);
  });
});

describe("upcoming earnings calendar (roadmap #32)", () => {
  const inDays = (d: number) => daysAgo(-d).slice(0, 10);

  it("lists soonest-first within the horizon, one row per ticker", () => {
    upsertUpcomingEarningsCatalyst("MSFT", inDays(6));
    upsertUpcomingEarningsCatalyst("AAPL", inDays(3));
    upsertUpcomingEarningsCatalyst("NVDA", inDays(30)); // beyond the 14d horizon
    // A hand-entered earnings catalyst for MSFT with an earlier date wins.
    addCatalyst({
      ticker: "MSFT",
      catalystType: "earnings",
      title: "MSFT reports (manual)",
      eventDate: inDays(2),
      status: "upcoming",
      impactScore: 0,
      impactDirection: "unknown",
      confidence: "medium",
      sourceName: "manual",
    });

    const cal = upcomingEarningsCalendar(14);
    expect(cal.map((c) => c.ticker)).toEqual(["MSFT", "AAPL"]);
    expect(cal[0].eventDate).toBe(inDays(2));
    expect(cal.every((c) => c.daysUntil >= 0 && c.daysUntil <= 14)).toBe(true);
  });
});

describe("score series (roadmap #33)", () => {
  it("collapses to the last score of each day, oldest first", () => {
    const ins = (calculatedAt: string, overallScore: number) =>
      getDb()
        .insert(schema.stockScores)
        .values({
          ticker: "MSFT",
          overallScore,
          valuationScore: 5,
          momentumScore: 5,
          catalystScore: 5,
          riskScore: 5,
          sentimentScore: 5,
          recommendation: "Hold / Monitor",
          confidence: "medium",
          calculatedAt,
        })
        .run();
    ins("2026-07-07T14:00:00Z", 5.0);
    ins("2026-07-08T14:00:00Z", 6.0);
    ins("2026-07-08T20:00:00Z", 6.4); // later same day wins
    ins("2026-07-09T14:00:00Z", 7.1);

    const series = scoreSeries("MSFT");
    expect(series.map((p) => p.date)).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]);
    expect(series.map((p) => p.overallScore)).toEqual([5.0, 6.4, 7.1]);
    expect(scoreSeries("NVDA")).toHaveLength(0);
  });
});

describe("upcoming earnings catalyst upsert (roadmap #16)", () => {
  const inDays = (d: number) => daysAgo(-d).slice(0, 10);

  it("inserts once, updates in place when the date moves, never stacks", () => {
    const first = inDays(30);
    expect(upsertUpcomingEarningsCatalyst("msft", first)).toBe("inserted");
    expect(upsertUpcomingEarningsCatalyst("MSFT", first)).toBe("unchanged");

    const moved = inDays(45);
    expect(upsertUpcomingEarningsCatalyst("MSFT", moved)).toBe("updated");

    const rows = getDb()
      .select()
      .from(schema.catalysts)
      .all()
      .filter((c) => c.ticker === "MSFT");
    expect(rows).toHaveLength(1);
    expect(rows[0].eventDate).toBe(moved);
    expect(rows[0].sourceName).toBe(EARNINGS_CALENDAR_SOURCE);
  });

  it("feeds the proximity guard but stays out of the scoring blend", () => {
    upsertUpcomingEarningsCatalyst("NVDA", inDays(30));

    // The proximity guard now has data…
    const dte = daysToNextEarnings("NVDA");
    expect(dte).not.toBeNull();
    expect(dte!).toBeGreaterThanOrEqual(28);
    expect(dte!).toBeLessThanOrEqual(30);

    // …but the marker is excluded from the scoring feed, so a zero-impact future
    // date can't re-activate the neutral catalyst/sentiment components.
    expect(getCatalystInputs("NVDA")).toHaveLength(0);

    // A real catalyst on the same ticker still flows into scoring.
    addCatalyst({ ticker: "NVDA", title: "Analyst upgrade to Buy", impactScore: 3, confidence: "medium" });
    expect(getCatalystInputs("NVDA")).toHaveLength(1);
  });
});

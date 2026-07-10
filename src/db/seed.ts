// Optional demo seed: `npm run db:seed`
// Adds example watchlist items, a sample trade, and catalysts so the
// dashboard has something to show before real data is connected.

import { getDb, schema } from "./index";
import { nowIso } from "@/lib/util";
import { loadDotEnv } from "@/lib/loadEnv";
loadDotEnv(); // tsx doesn't load .env — DATABASE_PATH must match the app's
import { addCatalyst } from "@/services/catalysts";

const db = getDb();
const now = nowIso();
const daysFromNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

const watchlist = [
  {
    ticker: "MSFT",
    companyName: "Microsoft",
    targetBuyLow: 400,
    targetBuyHigh: 430,
    reinvestAbovePrice: 480,
    maxRiskPrice: 380,
    notes: "Core AI/cloud compounder",
  },
  {
    ticker: "NVDA",
    companyName: "NVIDIA",
    targetBuyLow: 110,
    targetBuyHigh: 125,
    reinvestAbovePrice: 150,
    maxRiskPrice: 100,
    notes: "AI capex cycle",
  },
  {
    ticker: "AMD",
    companyName: "Advanced Micro Devices",
    targetBuyLow: 95,
    targetBuyHigh: 110,
    reinvestAbovePrice: 135,
    maxRiskPrice: 85,
    notes: "Datacenter share gains",
  },
];

for (const w of watchlist) {
  db.insert(schema.watchlistItems)
    .values({ ...w, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
}

db.insert(schema.activeTrades)
  .values({
    ticker: "MSFT",
    direction: "long",
    entryPrice: 425,
    entryDate: new Date(Date.now() - 7 * 86400000).toISOString(),
    shares: 10,
    positionSize: 4250,
    stopLoss: 405,
    targetPrice1: 455,
    targetPrice2: 475,
    currentPrice: 425,
    thesis: "Pullback to support in long-term uptrend; AI/cloud catalysts intact.",
    status: "open",
    createdAt: now,
    updatedAt: now,
  })
  .run();

addCatalyst({
  ticker: "MSFT",
  title: "Microsoft quarterly earnings",
  eventDate: daysFromNow(18),
  catalystType: "earnings",
  impactDirection: "unknown",
  impactScore: 0,
  confidence: "high",
  sourceName: "manual-seed",
});
addCatalyst({
  ticker: "NVDA",
  title: "Next-gen GPU launch event expected",
  eventDate: daysFromNow(30),
  catalystType: "product_launch",
  impactDirection: "positive",
  impactScore: 3,
  confidence: "medium",
  sourceName: "manual-seed",
});
addCatalyst({
  industry: "Semiconductors",
  title: "Potential new export restrictions under review",
  catalystType: "regulatory",
  impactDirection: "negative",
  impactScore: -2,
  confidence: "low",
  sourceName: "manual-seed",
});

console.log("Seeded demo watchlist, one open trade, and 3 catalysts.");
console.log("Run the app, then click 'Refresh data' to pull prices and compute scores.");

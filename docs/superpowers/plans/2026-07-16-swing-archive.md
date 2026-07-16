# Swing Recommendation Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive button on recommended swing setups that snapshots the recommendation, hides its (ticker, setup-type) pair from the live table while the scanner keeps re-detecting it, and lists snapshots in a collapsed "Archived recommendations" section with note/unarchive/trade actions.

**Architecture:** New `archived_setups` table (migration 0008) holding exact snapshots + a `suppressing` flag; `scanForSetups()` clears the flag when a scan no longer detects the pair (episode over); `activeSetups()` filters suppressed pairs; three small POST routes; a native `<details>` section on /swing. `trade_setups` and the backtest pipeline are untouched.

**Tech Stack:** TypeScript strict, Next.js 16 route handlers + server components, better-sqlite3 + drizzle (schema.ts is source of truth, `npm run db:generate`), vitest with `useTestDb()`.

**Spec:** `docs/superpowers/specs/2026-07-16-swing-archive-design.md`

## Global Constraints

- Real data only — never seed; the SQLite file under `data/` is live.
- Every timestamp via `nowIso()` from `@/lib/util`.
- Never edit `src/db/legacyBaseline.ts` or applied migrations; new table goes in `src/db/schema.ts` + generated migration.
- Persistence tests use `useTestDb()` from `src/services/__tests__/dbHarness.ts`.
- `npm run typecheck && npm test` before every commit; commit straight to main and push after each task.
- Booleans in schema use `integer("col", { mode: "boolean" })` (repo style).

---

### Task 1: Schema + migration 0008

**Files:**
- Modify: `src/db/schema.ts` (append after the `jobRuns` table)
- Generated: `drizzle/0008_swing-archive.sql`

**Interfaces:**
- Produces: `schema.archivedSetups` — columns as below; `$inferSelect` type used by Task 2.

- [ ] **Step 1: Add the table to `src/db/schema.ts`** (at the end of the file):

```ts
// User-curated archive of recommended swing setups (spec 2026-07-16). A
// snapshot of the trade_setups row at archive time — immune to retention
// thinning — plus `suppressing`: while true, the (ticker, setupType) pair is
// hidden from the live Recommended list; scanForSetups flips it false when a
// scan stops detecting the pair (episode over), so a future NEW episode
// lists normally while the snapshot stays as history.
export const archivedSetups = sqliteTable("archived_setups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticker: text("ticker").notNull(),
  setupType: text("setup_type").notNull(),
  setupQualityScore: real("setup_quality_score").notNull(),
  entryRangeLow: real("entry_range_low").notNull(),
  entryRangeHigh: real("entry_range_high").notNull(),
  stopLoss: real("stop_loss").notNull(),
  targetPrice1: real("target_price_1").notNull(),
  targetPrice2: real("target_price_2"),
  riskRewardRatio: real("risk_reward_ratio").notNull(),
  invalidationCondition: text("invalidation_condition"),
  detectedAt: text("detected_at").notNull(), // from the source setup row
  archivedAt: text("archived_at").notNull(),
  note: text("note"),
  suppressing: integer("suppressing", { mode: "boolean" }).notNull().default(true),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate -- --name swing-archive`
Expected: `drizzle/0008_swing-archive.sql` created containing `CREATE TABLE archived_setups ...`. Do not hand-edit it.

- [ ] **Step 3: Verify the suite still passes (migrations apply in the in-memory harness)**

Run: `npm run typecheck && npm test`
Expected: clean, same test count as before this feature (443).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "archived_setups table (swing archive, migration 0008)" && git push
```

---

### Task 2: setupArchive service (TDD)

**Files:**
- Create: `src/services/setupArchive.ts`
- Create: `src/services/__tests__/setupArchive.test.ts`

**Interfaces:**
- Consumes: `schema.archivedSetups` (Task 1), `schema.tradeSetups`.
- Produces (Tasks 3–5 use these exact signatures):
  - `pairKey(ticker: string, setupType: string): string`
  - `archiveSetup(setupId: number, note?: string): ArchivedSetup | null` (null = setup id not found)
  - `unarchiveSetup(id: number): boolean`
  - `updateArchiveNote(id: number, note: string): boolean`
  - `listArchivedSetups(): ArchivedSetup[]` (newest archivedAt first)
  - `suppressedSetupPairs(): Set<string>`
  - `clearEndedSuppressions(detectedPairs: Set<string>): number` (never throws)
  - `type ArchivedSetup = typeof schema.archivedSetups.$inferSelect`

- [ ] **Step 1: Write the failing tests** — `src/services/__tests__/setupArchive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { useTestDb } from "./dbHarness";
import { activeSetups } from "@/lib/queries";
import {
  archiveSetup,
  unarchiveSetup,
  updateArchiveNote,
  listArchivedSetups,
  suppressedSetupPairs,
  clearEndedSuppressions,
  pairKey,
} from "../setupArchive";

useTestDb();

const insertSetup = (ticker: string, setupType = "breakout", quality = 7) =>
  getDb()
    .insert(schema.tradeSetups)
    .values({
      ticker,
      setupType,
      setupQualityScore: quality,
      entryRangeLow: 100,
      entryRangeHigh: 105,
      stopLoss: 95,
      targetPrice1: 115,
      targetPrice2: 125,
      riskRewardRatio: 3,
      invalidationCondition: "close below 95",
      detectedAt: "2026-07-16T18:00:00.000Z",
      status: "active",
    })
    .returning()
    .get();

describe("setupArchive (swing archive spec 2026-07-16)", () => {
  it("archive snapshots every field and suppresses the pair", () => {
    const s = insertSetup("NVDA");
    const a = archiveSetup(s.id, "wait for earnings");
    expect(a).not.toBeNull();
    expect(a!.ticker).toBe("NVDA");
    expect(a!.setupType).toBe("breakout");
    expect(a!.entryRangeLow).toBe(100);
    expect(a!.entryRangeHigh).toBe(105);
    expect(a!.stopLoss).toBe(95);
    expect(a!.targetPrice1).toBe(115);
    expect(a!.targetPrice2).toBe(125);
    expect(a!.riskRewardRatio).toBe(3);
    expect(a!.invalidationCondition).toBe("close below 95");
    expect(a!.detectedAt).toBe("2026-07-16T18:00:00.000Z");
    expect(a!.note).toBe("wait for earnings");
    expect(a!.suppressing).toBe(true);
    expect(suppressedSetupPairs().has(pairKey("NVDA", "breakout"))).toBe(true);
  });

  it("returns null for a vanished setup id", () => {
    expect(archiveSetup(99999)).toBeNull();
  });

  it("is idempotent per pair while suppressing (no duplicate; note updates)", () => {
    const s1 = insertSetup("AAPL");
    const first = archiveSetup(s1.id, "v1");
    const s2 = insertSetup("AAPL"); // next scan's re-detection row
    const second = archiveSetup(s2.id, "v2");
    expect(second!.id).toBe(first!.id);
    expect(second!.note).toBe("v2");
    expect(listArchivedSetups().filter((r) => r.ticker === "AAPL")).toHaveLength(1);
  });

  it("activeSetups hides suppressed pairs and shows everything else", () => {
    const a = insertSetup("MSFT");
    insertSetup("MSFT", "pullback");
    insertSetup("TSLA");
    archiveSetup(a.id);
    const shown = activeSetups().map((s) => pairKey(s.ticker, s.setupType));
    expect(shown).not.toContain(pairKey("MSFT", "breakout"));
    expect(shown).toContain(pairKey("MSFT", "pullback"));
    expect(shown).toContain(pairKey("TSLA", "breakout"));
  });

  it("clearEndedSuppressions flips only pairs absent from the detected set", () => {
    archiveSetup(insertSetup("NVDA").id);
    archiveSetup(insertSetup("AMD").id);
    const cleared = clearEndedSuppressions(new Set([pairKey("NVDA", "breakout")]));
    expect(cleared).toBe(1); // AMD's episode ended
    const pairs = suppressedSetupPairs();
    expect(pairs.has(pairKey("NVDA", "breakout"))).toBe(true);
    expect(pairs.has(pairKey("AMD", "breakout"))).toBe(false);
    // AMD's snapshot is kept as history and a NEW episode lists again.
    expect(listArchivedSetups().some((r) => r.ticker === "AMD")).toBe(true);
    insertSetup("AMD");
    expect(activeSetups().some((s) => s.ticker === "AMD")).toBe(true);
  });

  it("unarchive deletes the snapshot and the pair reappears", () => {
    const s = insertSetup("META");
    const a = archiveSetup(s.id)!;
    expect(activeSetups().some((r) => r.ticker === "META")).toBe(false);
    expect(unarchiveSetup(a.id)).toBe(true);
    expect(unarchiveSetup(a.id)).toBe(false); // already gone
    expect(listArchivedSetups().some((r) => r.ticker === "META")).toBe(false);
    expect(activeSetups().some((r) => r.ticker === "META")).toBe(true);
  });

  it("note round-trip; empty string clears to null; newest-first list order", () => {
    const a1 = archiveSetup(insertSetup("F").id)!;
    const a2 = archiveSetup(insertSetup("GE").id)!;
    expect(updateArchiveNote(a1.id, "re-check next week")).toBe(true);
    expect(updateArchiveNote(a1.id, "  ")).toBe(true);
    const rows = listArchivedSetups();
    expect(rows.find((r) => r.id === a1.id)!.note).toBeNull();
    expect(updateArchiveNote(99999, "x")).toBe(false);
    // a2 archived after a1 → listed first (archivedAt desc, id desc tiebreak).
    expect(rows.findIndex((r) => r.id === a2.id)).toBeLessThan(rows.findIndex((r) => r.id === a1.id));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/__tests__/setupArchive.test.ts`
Expected: FAIL — `Cannot find module '../setupArchive'`.

- [ ] **Step 3: Implement `src/services/setupArchive.ts`**

```ts
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { nowIso } from "@/lib/util";

// User-curated archive of recommended swing setups (spec 2026-07-16).
// Archive = snapshot + hide: the snapshot lives here (immune to trade_setups
// retention), and `suppressing` hides the (ticker, setupType) pair from the
// live Recommended table while the scanner keeps re-detecting it. The scan
// itself ends suppression (clearEndedSuppressions) when the pair drops out —
// a later NEW episode lists normally. trade_setups keeps recording detections
// throughout, so the setup-outcome backtest never loses data.

export type ArchivedSetup = typeof schema.archivedSetups.$inferSelect;

export const pairKey = (ticker: string, setupType: string): string =>
  `${ticker.toUpperCase()}|${setupType}`;

const cleanNote = (note: string | undefined): string | null => {
  const t = note?.trim();
  return t ? t : null;
};

/** Snapshot + suppress. Idempotent per pair while suppressing. Null = no such setup. */
export function archiveSetup(setupId: number, note?: string): ArchivedSetup | null {
  const db = getDb();
  const s = db.select().from(schema.tradeSetups).where(eq(schema.tradeSetups.id, setupId)).get();
  if (!s) return null;
  const existing = db
    .select()
    .from(schema.archivedSetups)
    .where(
      and(
        eq(schema.archivedSetups.ticker, s.ticker),
        eq(schema.archivedSetups.setupType, s.setupType),
        eq(schema.archivedSetups.suppressing, true),
      ),
    )
    .get();
  if (existing) {
    if (note !== undefined) {
      db.update(schema.archivedSetups)
        .set({ note: cleanNote(note) })
        .where(eq(schema.archivedSetups.id, existing.id))
        .run();
      return { ...existing, note: cleanNote(note) };
    }
    return existing;
  }
  return db
    .insert(schema.archivedSetups)
    .values({
      ticker: s.ticker,
      setupType: s.setupType,
      setupQualityScore: s.setupQualityScore,
      entryRangeLow: s.entryRangeLow,
      entryRangeHigh: s.entryRangeHigh,
      stopLoss: s.stopLoss,
      targetPrice1: s.targetPrice1,
      targetPrice2: s.targetPrice2,
      riskRewardRatio: s.riskRewardRatio,
      invalidationCondition: s.invalidationCondition,
      detectedAt: s.detectedAt,
      archivedAt: nowIso(),
      note: cleanNote(note),
      suppressing: true,
    })
    .returning()
    .get();
}

/** Delete the snapshot; the pair may list again immediately if still detected. */
export function unarchiveSetup(id: number): boolean {
  const res = getDb().delete(schema.archivedSetups).where(eq(schema.archivedSetups.id, id)).run();
  return res.changes > 0;
}

export function updateArchiveNote(id: number, note: string): boolean {
  const res = getDb()
    .update(schema.archivedSetups)
    .set({ note: cleanNote(note) })
    .where(eq(schema.archivedSetups.id, id))
    .run();
  return res.changes > 0;
}

export function listArchivedSetups(): ArchivedSetup[] {
  return getDb()
    .select()
    .from(schema.archivedSetups)
    .orderBy(desc(schema.archivedSetups.archivedAt), desc(schema.archivedSetups.id))
    .all();
}

/** Pairs currently hidden from the live Recommended table. */
export function suppressedSetupPairs(): Set<string> {
  const rows = getDb()
    .select({ ticker: schema.archivedSetups.ticker, setupType: schema.archivedSetups.setupType })
    .from(schema.archivedSetups)
    .where(eq(schema.archivedSetups.suppressing, true))
    .all();
  return new Set(rows.map((r) => pairKey(r.ticker, r.setupType)));
}

/**
 * Called by scanForSetups with the pairs the scan just detected. Any
 * suppressing archive row whose pair was NOT re-detected has reached the end
 * of its episode: stop suppressing (the snapshot stays as history). Never
 * throws — a failure here must not break the refresh.
 */
export function clearEndedSuppressions(detectedPairs: Set<string>): number {
  try {
    const db = getDb();
    const rows = db
      .select()
      .from(schema.archivedSetups)
      .where(eq(schema.archivedSetups.suppressing, true))
      .all();
    let cleared = 0;
    for (const r of rows) {
      if (!detectedPairs.has(pairKey(r.ticker, r.setupType))) {
        db.update(schema.archivedSetups)
          .set({ suppressing: false })
          .where(eq(schema.archivedSetups.id, r.id))
          .run();
        cleared++;
      }
    }
    return cleared;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Wire the activeSetups filter** — in `src/lib/queries.ts`, replace the `activeSetups` function:

```ts
export function activeSetups() {
  // Hide pairs the user archived while their episode is still being
  // re-detected (spec 2026-07-16); scanForSetups ends the suppression when
  // the pair drops out of a scan.
  const suppressed = suppressedSetupPairs();
  return getDb()
    .select()
    .from(schema.tradeSetups)
    .where(eq(schema.tradeSetups.status, "active"))
    .orderBy(desc(schema.tradeSetups.setupQualityScore))
    .all()
    .filter((s) => !suppressed.has(pairKey(s.ticker, s.setupType)));
}
```

Add to the imports at the top of `src/lib/queries.ts`:

```ts
import { pairKey, suppressedSetupPairs } from "@/services/setupArchive";
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/services/__tests__/setupArchive.test.ts`
Expected: 7 passed.

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npm test`
Expected: clean; suite grows by 7 (443 → 450).

```bash
git add src/services/setupArchive.ts src/services/__tests__/setupArchive.test.ts src/lib/queries.ts
git commit -m "setupArchive service: snapshot + episode-scoped suppression" && git push
```

---

### Task 3: Scan hook — end suppressions when an episode ends

**Files:**
- Modify: `src/services/marketData.ts` (`scanForSetups`, ~line 349)

**Interfaces:**
- Consumes: `clearEndedSuppressions`, `pairKey` from `@/services/setupArchive` (Task 2).

- [ ] **Step 1: Wire the scan.** In `src/services/marketData.ts` add to imports:

```ts
import { clearEndedSuppressions, pairKey } from "./setupArchive";
```

In `scanForSetups()`, collect detected pairs and clear ended suppressions. The function currently expires actives, loops tickers, inserts each detected setup, and returns `found`. Change it to:

```ts
export function scanForSetups(): number {
  const db = getDb();
  const tickers = getTrackedTickers();
  let found = 0;
  const detected = new Set<string>();
  // Expire previous active setups before re-scanning.
  db.update(schema.tradeSetups)
    .set({ status: "expired" })
    .where(eq(schema.tradeSetups.status, "active"))
    .run();
  for (const ticker of tickers) {
    const bars = getBars(ticker);
    if (bars.length < 30) continue;
    for (const setup of detectSetups(bars)) {
      detected.add(pairKey(ticker, setup.setupType));
      db.insert(schema.tradeSetups)
        .values({
          ticker,
          setupType: setup.setupType,
          setupQualityScore: setup.setupQualityScore,
          entryRangeLow: setup.entryRangeLow,
          entryRangeHigh: setup.entryRangeHigh,
          stopLoss: setup.stopLoss,
          targetPrice1: setup.targetPrice1,
          targetPrice2: setup.targetPrice2,
          riskRewardRatio: setup.riskRewardRatio,
          invalidationCondition: `${setup.invalidationCondition} ${setup.explanation}`,
          detectedAt: nowIso(),
          status: "active",
        })
        .run();
      found++;
    }
  }
  // Archived pairs the scan no longer detects have finished their episode —
  // stop hiding them so a future NEW episode lists normally (spec 2026-07-16).
  clearEndedSuppressions(detected);
  return found;
}
```

(Keep the exact insert block as it exists in the file — the only changes are the `detected` set, the `detected.add(...)` line, and the `clearEndedSuppressions(detected)` call.)

- [ ] **Step 2: Full check + commit**

Run: `npm run typecheck && npm test`
Expected: clean (behavior covered by Task 2's clearEndedSuppressions tests; the scan wiring is exercised live in Task 6).

```bash
git add src/services/marketData.ts
git commit -m "scanForSetups ends archive suppressions when an episode ends" && git push
```

---

### Task 4: API routes

**Files:**
- Create: `src/app/api/setups/archive/route.ts`
- Create: `src/app/api/setups/unarchive/route.ts`
- Create: `src/app/api/setups/note/route.ts`

**Interfaces:**
- Consumes: `archiveSetup`, `unarchiveSetup`, `updateArchiveNote` (Task 2).
- Produces: `POST /api/setups/archive {setupId, note?}`, `POST /api/setups/unarchive {id}`, `POST /api/setups/note {id, note}` — used by Task 5's client components.

- [ ] **Step 1: Write the three route handlers** (same zod + NextResponse shape as `src/app/api/alerts/ack-all/route.ts`).

`src/app/api/setups/archive/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveSetup } from "@/services/setupArchive";

// Archive a recommended setup: snapshot it and hide its (ticker, setupType)
// pair from the live table while the episode lasts (spec 2026-07-16).

const bodySchema = z.object({
  setupId: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const archived = archiveSetup(parsed.data.setupId, parsed.data.note);
  if (!archived) {
    return NextResponse.json({ error: "setup not found — it may have expired; refresh the page" }, { status: 404 });
  }
  return NextResponse.json({ archived });
}
```

`src/app/api/setups/unarchive/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { unarchiveSetup } from "@/services/setupArchive";

const bodySchema = z.object({ id: z.number().int().positive() });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!unarchiveSetup(parsed.data.id)) {
    return NextResponse.json({ error: "archived setup not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

`src/app/api/setups/note/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateArchiveNote } from "@/services/setupArchive";

const bodySchema = z.object({ id: z.number().int().positive(), note: z.string().max(500) });

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (!updateArchiveNote(parsed.data.id, parsed.data.note)) {
    return NextResponse.json({ error: "archived setup not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Full check + commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/app/api/setups
git commit -m "Archive/unarchive/note API routes for swing setups" && git push
```

---

### Task 5: /swing UI — Archive button + collapsed Archived section

**Files:**
- Create: `src/components/SetupArchive.tsx`
- Modify: `src/app/swing/page.tsx` (Recommended trades section)

**Interfaces:**
- Consumes: Task 4's routes; `listArchivedSetups`, `ArchivedSetup` (Task 2); existing `useApiAction`, `latestSnapshot`, `Freshness`, `PlaceOrderButton`, `fmtMoney`/`fmtDate`.

- [ ] **Step 1: Write the client components** — `src/components/SetupArchive.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useApiAction } from "./useApiAction";

// Client actions for the swing recommendation archive (spec 2026-07-16).

export function ArchiveSetupButton({ setupId, ticker }: { setupId: number; ticker: string }) {
  const { call, busy, error } = useApiAction();
  return (
    <button
      className="text-xs text-zinc-400 underline hover:text-zinc-100 disabled:opacity-50"
      disabled={busy}
      title={error ?? `Archive this ${ticker} recommendation — keeps a snapshot and hides it while the setup lasts`}
      onClick={() => void call("/api/setups/archive", { body: { setupId }, errorText: "archive failed" })}
    >
      {error ? "retry archive" : busy ? "archiving…" : "Archive"}
    </button>
  );
}

export function UnarchiveButton({ id, ticker }: { id: number; ticker: string }) {
  const { call, busy, error } = useApiAction();
  return (
    <button
      className="text-xs text-zinc-400 underline hover:text-zinc-100 disabled:opacity-50"
      disabled={busy}
      title={error ?? `Remove the ${ticker} snapshot — it can list again immediately if still detected`}
      onClick={() => void call("/api/setups/unarchive", { body: { id }, errorText: "unarchive failed" })}
    >
      {error ? "retry" : busy ? "…" : "Unarchive"}
    </button>
  );
}

export function ArchiveNoteInput({ id, initial }: { id: number; initial: string | null }) {
  const { call, busy } = useApiAction();
  const [note, setNote] = useState(initial ?? "");
  const save = () => {
    if ((initial ?? "") !== note.trim()) {
      void call("/api/setups/note", { body: { id, note }, errorText: "saving note failed" });
    }
  };
  return (
    <input
      className="w-40 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
      placeholder="note…"
      value={note}
      disabled={busy}
      onChange={(e) => setNote(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
```

- [ ] **Step 2: Wire the page.** In `src/app/swing/page.tsx`:

Add imports:

```tsx
import { listArchivedSetups } from "@/services/setupArchive";
import { ArchiveSetupButton, UnarchiveButton, ArchiveNoteInput } from "@/components/SetupArchive";
```

In the component body, next to the other queries:

```tsx
const archived = listArchivedSetups();
```

In the Recommended trades table: add `<th />` as the LAST header cell (after `<th>Order</th>`), bump the empty-state `colSpan={13}` to `colSpan={14}`, and add as the last cell of each setup row (after the PlaceOrderButton cell):

```tsx
<td><ArchiveSetupButton setupId={s.id} ticker={s.ticker} /></td>
```

After the closing `</p>` of the section's footnote (still inside the Recommended trades `<section>`), add the collapsed archive:

```tsx
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
            Archived recommendations ({archived.length})
          </summary>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">
              Nothing archived. The Archive button on a recommendation keeps a snapshot here and
              hides it from the list above while the setup lasts.
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Setup</th>
                    <th>Archived</th>
                    <th>Entry range</th>
                    <th>Stop</th>
                    <th>Target 1</th>
                    <th>Target 2</th>
                    <th>R/R</th>
                    <th>Quality</th>
                    <th>Current price</th>
                    <th>Note</th>
                    <th>Order</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {archived.map((a) => {
                    const snap = latestSnapshot(a.ticker);
                    const mid = (a.entryRangeLow + a.entryRangeHigh) / 2;
                    return (
                      <tr key={a.id} className={a.suppressing ? "" : "opacity-60"}>
                        <td>
                          <Link href={`/stock/${a.ticker}`} className="font-semibold text-sky-300 hover:underline">
                            {a.ticker}
                          </Link>
                          {!a.suppressing && (
                            <span className="block text-[10px] text-zinc-600" title="The setup episode this was archived from has ended — this row is history.">
                              episode ended
                            </span>
                          )}
                        </td>
                        <td className="text-zinc-300">{a.setupType.replace(/_/g, " ")}</td>
                        <td className="text-xs">{fmtDate(a.archivedAt)}</td>
                        <td className="tabular-nums">{fmtMoney(a.entryRangeLow)}–{fmtMoney(a.entryRangeHigh)}</td>
                        <td className="tabular-nums text-red-300">{fmtMoney(a.stopLoss)}</td>
                        <td className="tabular-nums text-emerald-300">{fmtMoney(a.targetPrice1)}</td>
                        <td className="tabular-nums">{fmtMoney(a.targetPrice2)}</td>
                        <td className="tabular-nums">{a.riskRewardRatio.toFixed(1)}:1</td>
                        <td className="tabular-nums">{a.setupQualityScore.toFixed(1)}</td>
                        <td className="tabular-nums">
                          {snap?.regularPrice != null ? (
                            <span className="inline-flex items-center gap-1">
                              {fmtMoney(snap.regularPrice)}
                              <Freshness capturedAt={snap.capturedAt} staleMinutes={cfg.staleDataMinutes} />
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td><ArchiveNoteInput id={a.id} initial={a.note} /></td>
                        <td>
                          <PlaceOrderButton
                            ticker={a.ticker}
                            direction="long"
                            entryPrice={mid}
                            stopLoss={a.stopLoss}
                            targetPrice1={a.targetPrice1}
                            mode={alpacaMode}
                            risk={{
                              minRiskReward: cfg.minRiskReward,
                              riskPerTradePercent: cfg.riskPerTradePercent,
                              accountValue,
                              maxPositionWeightPercent: cfg.maxPortfolioConcentrationPercent,
                            }}
                          />
                        </td>
                        <td><UnarchiveButton id={a.id} ticker={a.ticker} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-zinc-600">
                Archived numbers are a snapshot from when you archived — the entry range and stop
                may no longer be valid. Re-check the chart before placing an order.
              </p>
            </div>
          )}
        </details>
```

- [ ] **Step 3: Full check + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all clean (build catches any server/client component slip).

- [ ] **Step 4: Commit**

```bash
git add src/components/SetupArchive.tsx src/app/swing/page.tsx
git commit -m "/swing: Archive button + collapsed Archived recommendations section" && git push
```

---

### Task 6: Live verification + close-out

**Files:**
- Modify: `docs/agent-memory.md` (append to the 2026-07-16 session entry)

- [ ] **Step 1: Verify live** (dev server is already running at localhost:3000):

1. Open /swing → Recommended table has an Archive button per row; "Archived recommendations (0)" collapsed under the section.
2. Archive a real recommendation → its row leaves the table; count becomes (1); expanding shows the snapshot with live price.
3. Type a note, blur → reload page → note persisted.
4. Trigger a refresh (RefreshButton) → the archived pair stays hidden after `scanForSetups` re-runs (still detected → still suppressed).
5. Unarchive → row returns to the Recommended table (after refresh), archive count back to (0).
6. Re-archive one recommendation and leave it archived if desired — user's call; otherwise unarchive to restore the original view.

- [ ] **Step 2: Append a short paragraph to the 2026-07-16 entry in `docs/agent-memory.md`** describing the feature (archive = snapshot + episode-scoped suppression; new archived_setups table; scan clears suppression) and the live-verification result.

- [ ] **Step 3: Final sweep + commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add docs/agent-memory.md docs/superpowers/plans/2026-07-16-swing-archive.md
git commit -m "Swing archive: live-verified; handoff note" && git push
```

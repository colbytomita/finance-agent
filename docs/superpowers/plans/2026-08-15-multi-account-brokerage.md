# Multi-Account Brokerage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard hold many brokerage accounts — across brokers, mixing paper and real money — and switch between them, one active at a time.

**Architecture:** A `broker_accounts` table plus an `account_id` on five account-scoped tables; a `BrokerAdapter` interface with a single Alpaca implementation; market data resolved from its own source rather than "the active account"; and order routing that derives the account from the *record*, never the UI.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, React 19, `better-sqlite3` + `drizzle-orm`, `zod`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-multi-account-brokerage-design.md`

## Global Constraints

- **Credentials never enter the database.** Only `.env`. The DB is copied into `data/backups/` seven times over.
- **Order routing derives the account from the record, not the UI.** A stale browser tab must not be able to route an order to the wrong account.
- **`confirmLive` resolves server-side** from `broker_accounts.mode`. Never trust a client-supplied mode.
- **Never commit or push** — finance-agent's `AGENTS.md` rule. Commit steps below stage locally only; pushing happens when Colby asks.
- Verify with `npx tsc --noEmit` and `npm test`. **`npm run build` does not type-check** (see `next.config.ts`), so `tsc` is the gate.
- `noUnusedLocals` / `noUnusedParameters` are on — unused imports fail the typecheck.
- After any change to scoring/detector/scheduler code, **restart the jobs runner** (`scripts/stop-jobs-task.ps1` then `Start-ScheduledTask -TaskName FinanceAgentJobs`). `tsx` loads code once at startup.
- Migrations: edit `src/db/schema.ts` (the source of truth), then `npm run db:generate`. **Never edit `src/db/legacyBaseline.ts` or an applied migration.**

## File Structure

| file | responsibility |
|---|---|
| `src/db/schema.ts` (modify) | `brokerAccounts` table; `accountId` on 5 tables |
| `src/services/accounts.ts` (create) | account CRUD, `activeAccount()`, `setActiveAccount()`, env-credential resolution |
| `src/services/brokerAdapter.ts` (create) | `BrokerAdapter` interface + shared broker types |
| `src/services/marketDataSource.ts` (create) | the account-independent market-data client |
| `src/services/alpaca.ts` (modify) | implements `BrokerAdapter`; `forAccount()` replaces `fromEnv()` |
| `src/lib/queries.ts` (modify) | account-scoped reads |
| `src/components/AccountSwitcher.tsx` (create) | header switcher |
| `src/app/api/accounts/route.ts` (create) | list accounts / set active |

---

### Task 1: `broker_accounts` table and the accounts service

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/services/accounts.ts`
- Create: `src/services/__tests__/accounts.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `brokerAccounts` table; `BrokerAccount` type; `listAccounts(): BrokerAccount[]`; `activeAccount(): BrokerAccount | null`; `setActiveAccount(id: number): void`; `credentialsFor(a: BrokerAccount): { apiKey: string; apiSecret: string; mode: "paper" | "live" } | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/accounts.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { useTestDb } from "./dbHarness";
import { getDb, schema } from "@/db";
import { listAccounts, activeAccount, setActiveAccount, credentialsFor } from "../accounts";

useTestDb();

function seed(rows: { label: string; envPrefix: string; mode: "paper" | "live"; isActive?: boolean }[]) {
  for (const r of rows) {
    getDb().insert(schema.brokerAccounts).values({
      label: r.label, broker: "alpaca", envPrefix: r.envPrefix,
      mode: r.mode, isActive: r.isActive ?? false, createdAt: "2026-08-15T00:00:00Z",
    }).run();
  }
}

describe("accounts", () => {
  it("returns the account flagged active", () => {
    seed([{ label: "A", envPrefix: "", mode: "paper", isActive: true }, { label: "B", envPrefix: "2", mode: "paper" }]);
    expect(activeAccount()?.label).toBe("A");
  });

  it("setActiveAccount moves the flag exactly once", () => {
    seed([{ label: "A", envPrefix: "", mode: "paper", isActive: true }, { label: "B", envPrefix: "2", mode: "paper" }]);
    const b = listAccounts().find((a) => a.label === "B")!;
    setActiveAccount(b.id);
    expect(activeAccount()?.label).toBe("B");
    expect(listAccounts().filter((a) => a.isActive)).toHaveLength(1);
  });

  it("falls back to the lowest-id PAPER account when no flag is set", () => {
    // A corrupted flag must degrade to a safe default, never to a live account.
    seed([{ label: "Live", envPrefix: "3", mode: "live" }, { label: "Paper", envPrefix: "2", mode: "paper" }]);
    expect(activeAccount()?.mode).toBe("paper");
  });

  it("reads credentials from the env prefix, never from the DB", () => {
    process.env.ALPACA_2_API_KEY = "k2";
    process.env.ALPACA_2_API_SECRET = "s2";
    process.env.ALPACA_2_MODE = "paper";
    seed([{ label: "B", envPrefix: "2", mode: "paper" }]);
    const b = listAccounts()[0];
    expect(credentialsFor(b)).toMatchObject({ apiKey: "k2", apiSecret: "s2", mode: "paper" });
  });

  it("returns null credentials when the env set is missing — never silently falls back to account 1", () => {
    process.env.ALPACA_API_KEY = "k1";
    process.env.ALPACA_API_SECRET = "s1";
    seed([{ label: "Ghost", envPrefix: "9", mode: "paper" }]);
    expect(credentialsFor(listAccounts()[0])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/accounts.test.ts`
Expected: FAIL — `schema.brokerAccounts` is undefined.

- [ ] **Step 3: Add the table to the schema**

```ts
// src/db/schema.ts — append near the other tables
export const brokerAccounts = sqliteTable("broker_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  // Discriminator that selects a BrokerAdapter. Only "alpaca" is implemented.
  broker: text("broker").notNull().default("alpaca"),
  // Which env vars hold this account's credentials: "" => ALPACA_API_KEY,
  // "2" => ALPACA_2_API_KEY. Credentials themselves NEVER live in this table.
  envPrefix: text("env_prefix").notNull().default(""),
  mode: text("mode").notNull().default("paper"), // paper | live
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});
```

- [ ] **Step 4: Write the accounts service**

```ts
// src/services/accounts.ts
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";

export interface BrokerAccount {
  id: number; label: string; broker: string;
  envPrefix: string; mode: "paper" | "live"; isActive: boolean; createdAt: string;
}

export function listAccounts(): BrokerAccount[] {
  return getDb().select().from(schema.brokerAccounts).all() as BrokerAccount[];
}

/**
 * The account the UI is showing. `isActive` is kept single-valued by
 * setActiveAccount, not by a DB constraint — SQLite has no clean partial-unique
 * index for "exactly one true". If the invariant is ever violated we fall back
 * to the lowest-id PAPER account, so a corrupted flag degrades to a safe
 * default and never silently activates a real-money account.
 */
export function activeAccount(): BrokerAccount | null {
  const all = listAccounts();
  if (all.length === 0) return null;
  const flagged = all.filter((a) => a.isActive);
  if (flagged.length === 1) return flagged[0];
  const paper = all.filter((a) => a.mode === "paper").sort((a, b) => a.id - b.id);
  return paper[0] ?? null;
}

export function setActiveAccount(id: number): void {
  const db = getDb();
  db.transaction((tx) => {
    tx.update(schema.brokerAccounts).set({ isActive: false }).run();
    tx.update(schema.brokerAccounts).set({ isActive: true }).where(eq(schema.brokerAccounts.id, id)).run();
  });
}

export interface BrokerCredentials { apiKey: string; apiSecret: string; mode: "paper" | "live" }

/**
 * Credentials come from .env only. A missing env set returns null rather than
 * falling back to another account — a silent fallback would route orders to the
 * wrong account, which is the failure this whole design exists to prevent.
 */
export function credentialsFor(account: BrokerAccount): BrokerCredentials | null {
  const p = account.envPrefix ? `ALPACA_${account.envPrefix}_` : "ALPACA_";
  const apiKey = process.env[`${p}API_KEY`];
  const apiSecret = process.env[`${p}API_SECRET`];
  if (!apiKey || !apiSecret) return null;
  const mode = process.env[`${p}MODE`] === "live" ? "live" : "paper";
  return { apiKey, apiSecret, mode };
}
```

- [ ] **Step 5: Generate the migration and verify tests pass**

Run: `npm run db:generate` then `npx vitest run src/services/__tests__/accounts.test.ts && npx tsc --noEmit`
Expected: migration `0011_*.sql` created with `CREATE TABLE broker_accounts`; 5 tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/services/accounts.ts src/services/__tests__/accounts.test.ts drizzle/
git commit -m "feat(#80): broker_accounts table and accounts service"
```

---

### Task 2: `account_id` on the five account-scoped tables

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/services/__tests__/accountMigration.test.ts`

**Interfaces:**
- Consumes: `brokerAccounts` from Task 1
- Produces: `accountId` column on `portfolioHoldings`, `activeTrades`, `tradeJournalEntries`, `portfolioSnapshots` (all `NOT NULL DEFAULT 1`) and `alerts` (nullable)

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/accountMigration.test.ts
import { describe, expect, it } from "vitest";
import { useTestDb } from "./dbHarness";
import { getDb, schema } from "@/db";

useTestDb();

describe("account_id columns", () => {
  it("defaults existing-style inserts to account 1", () => {
    // The migration adds the column NOT NULL DEFAULT 1, so a row written
    // without an explicit accountId belongs to account 1 — this is what
    // backfills the pre-multi-account data.
    getDb().insert(schema.activeTrades).values({
      ticker: "MSFT", direction: "long", entryPrice: 400, entryDate: "2026-08-15T00:00:00Z",
      shares: 1, positionSize: 400, status: "open",
      createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z",
    }).run();
    expect(getDb().select().from(schema.activeTrades).all()[0].accountId).toBe(1);
  });

  it("allows a null accountId on alerts — null means a global alert", () => {
    getDb().insert(schema.alerts).values({
      alertType: "data_stale", severity: "warning", message: "stale",
      acknowledged: false, createdAt: "2026-08-15T00:00:00Z",
    }).run();
    expect(getDb().select().from(schema.alerts).all()[0].accountId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/accountMigration.test.ts`
Expected: FAIL — property `accountId` does not exist.

- [ ] **Step 3: Add the columns**

Add this line to `portfolioHoldings`, `activeTrades`, `tradeJournalEntries` and `portfolioSnapshots` (inside each `sqliteTable` body):

```ts
  // NOT NULL DEFAULT 1: SQLite cannot add a NOT NULL column without a default,
  // so the default IS the backfill — every pre-existing row becomes account 1.
  // It stays in place afterwards; removing a default in SQLite is a
  // copy-and-swap whose risk outweighs the tidiness. New code always writes
  // accountId explicitly.
  accountId: integer("account_id").notNull().default(1),
```

And this line to `alerts`:

```ts
  // Nullable: null means a GLOBAL alert (data_stale, concentration).
  // Account-scoped alerts (stop_missing, trade_exit) carry an id, because
  // emitAlert's onceWhileUnacked dedupes on (type, ticker) — without this,
  // account B's "QBTS has no stop" would be swallowed by account A's.
  accountId: integer("account_id"),
```

- [ ] **Step 4: Generate the migration, verify, and check the real DB backfills**

Run: `npm run db:generate && npx vitest run && npx tsc --noEmit`
Expected: migration adds 5 columns; all tests PASS; typecheck clean.

Then confirm against the live database that nothing was lost:

```bash
node -e "
const D=require('better-sqlite3'); const db=new D('data/finance-agent.db',{readonly:true});
for (const t of ['portfolio_holdings','active_trades','trade_journal_entries','portfolio_snapshots'])
  console.log(t, db.prepare('select count(*) c, sum(case when account_id=1 then 1 else 0 end) a1 from '+t).get());
"
```
Expected: for every table, `c === a1` — every row belongs to account 1.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/services/__tests__/accountMigration.test.ts drizzle/
git commit -m "feat(#80): account_id on the five account-scoped tables"
```

---

### Task 3: `BrokerAdapter` interface and `AlpacaService.forAccount`

**Files:**
- Create: `src/services/brokerAdapter.ts`
- Modify: `src/services/alpaca.ts`
- Modify: `src/services/__tests__/alpaca.test.ts`

**Interfaces:**
- Consumes: `BrokerAccount`, `credentialsFor` from Task 1
- Produces: `BrokerAdapter` interface; `AlpacaService.forAccount(account: BrokerAccount, fetchFn?: typeof fetch): AlpacaService | null`; `AlpacaService.prototype.accountId: number`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/services/__tests__/alpaca.test.ts
describe("AlpacaService.forAccount", () => {
  const account = { id: 7, label: "B", broker: "alpaca", envPrefix: "2",
    mode: "paper" as const, isActive: false, createdAt: "2026-08-15T00:00:00Z" };

  it("uses the account's own env credentials and carries its id", () => {
    process.env.ALPACA_2_API_KEY = "key2";
    process.env.ALPACA_2_API_SECRET = "secret2";
    process.env.ALPACA_2_MODE = "paper";
    const fetchFn = mockFetch({ "/v2/account": { equity: "1000", account_number: "B1" } });
    const svc = AlpacaService.forAccount(account, fetchFn)!;
    expect(svc.accountId).toBe(7);
    return svc.getAccount().then(() => {
      const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].headers["APCA-API-KEY-ID"]).toBe("key2");
    });
  });

  it("returns null when the account's env set is missing", () => {
    delete process.env.ALPACA_9_API_KEY;
    expect(AlpacaService.forAccount({ ...account, envPrefix: "9" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/alpaca.test.ts`
Expected: FAIL — `forAccount` is not a function.

- [ ] **Step 3: Define the interface**

```ts
// src/services/brokerAdapter.ts
import type { AlpacaAccount, AlpacaOrder, AlpacaOrderRequest, AlpacaPosition } from "./alpaca";

/**
 * What the app actually needs from a broker. Deliberately excludes historical
 * bars: bars are MARKET DATA, not account data, and resolving them per account
 * would make price history depend on which account the UI is showing.
 * See marketDataSource.ts.
 *
 * Only AlpacaService implements this today. A second broker is a new
 * implementation plus a broker_accounts row — no migration, no rework here.
 */
export interface BrokerAdapter {
  readonly accountId: number;
  readonly mode: "paper" | "live";
  getAccount(): Promise<AlpacaAccount>;
  getPositions(): Promise<AlpacaPosition[]>;
  getOrder(orderId: string): Promise<AlpacaOrder>;
  workingOrders(): Promise<AlpacaOrder[]>;
  openOrdersFor(symbol: string): Promise<AlpacaOrder[]>;
  placeOrder(req: AlpacaOrderRequest): Promise<AlpacaOrder>;
  cancelOrder(orderId: string): Promise<void>;
  getMarketClock(): Promise<{ isOpen: boolean; nextOpen: string | null }>;
}
```

- [ ] **Step 4: Add `forAccount` and `accountId` to `AlpacaService`**

```ts
// src/services/alpaca.ts — inside the class, next to fromEnv
  /** Which broker_accounts row this client belongs to (0 = legacy env-only). */
  readonly accountId: number = 0;

  /**
   * Build a client for one account. Returns null when that account's env set is
   * absent — deliberately NOT falling back to another account's credentials,
   * which would route orders to the wrong account.
   */
  static forAccount(account: BrokerAccount, fetchFn?: typeof fetch): AlpacaService | null {
    const creds = credentialsFor(account);
    if (!creds) return null;
    const svc = new AlpacaService({ apiKey: creds.apiKey, apiSecret: creds.apiSecret, mode: creds.mode, fetchFn });
    (svc as { accountId: number }).accountId = account.id;
    return svc;
  }
```

Add the imports at the top of `alpaca.ts`:

```ts
import { credentialsFor, type BrokerAccount } from "./accounts";
```

And declare the interface conformance on the class:

```ts
export class AlpacaService implements BrokerAdapter {
```

with `import type { BrokerAdapter } from "./brokerAdapter";`

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests PASS; typecheck clean. If `implements BrokerAdapter` errors, the interface and the class have drifted — fix the interface to match the real method, do not loosen it to `any`.

- [ ] **Step 6: Commit**

```bash
git add src/services/brokerAdapter.ts src/services/alpaca.ts src/services/__tests__/alpaca.test.ts
git commit -m "feat(#80): BrokerAdapter interface and AlpacaService.forAccount"
```

---

### Task 4: Decouple market data from accounts

**Files:**
- Create: `src/services/marketDataSource.ts`
- Create: `src/services/__tests__/marketDataSource.test.ts`
- Modify (8 call sites): `src/services/bars.ts:55`, `src/services/quotes.ts:53`, `src/services/entityMentions.ts:201`, `src/services/signalPerformance.ts:523`, `src/services/watchlistImport.ts:42`, `src/services/sectorScout.ts:416`, `src/services/discoveryAgent.ts:279`, `src/jobs/scheduler.ts:48`

**Interfaces:**
- Consumes: `listAccounts` (Task 1), `AlpacaService.forAccount` (Task 3)
- Produces: `marketDataClient(): AlpacaService | null`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/__tests__/marketDataSource.test.ts
import { describe, expect, it } from "vitest";
import { useTestDb } from "./dbHarness";
import { getDb, schema } from "@/db";
import { marketDataClient } from "../marketDataSource";

useTestDb();

const add = (label: string, envPrefix: string, mode: "paper" | "live", isActive: boolean) =>
  getDb().insert(schema.brokerAccounts).values({
    label, broker: "alpaca", envPrefix, mode, isActive, createdAt: "2026-08-15T00:00:00Z",
  }).run();

describe("marketDataClient", () => {
  it("is the SAME client regardless of which account is active", () => {
    process.env.ALPACA_API_KEY = "k1"; process.env.ALPACA_API_SECRET = "s1";
    process.env.ALPACA_2_API_KEY = "k2"; process.env.ALPACA_2_API_SECRET = "s2";
    add("A", "", "paper", true);
    add("B", "2", "paper", false);
    const first = marketDataClient();

    // Switch the active account; market data must not follow it.
    getDb().update(schema.brokerAccounts).set({ isActive: false }).run();
    const second = marketDataClient();
    expect(second?.accountId).toBe(first?.accountId);
  });

  it("returns null when no account has credentials — callers fall back to Yahoo", () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_2_API_KEY;
    add("A", "", "paper", true);
    expect(marketDataClient()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/marketDataSource.test.ts`
Expected: FAIL — cannot find module `../marketDataSource`.

- [ ] **Step 3: Implement the source**

```ts
// src/services/marketDataSource.ts
import { AlpacaService } from "./alpaca";
import { listAccounts } from "./accounts";

/**
 * The client used for MARKET DATA — bars, quotes, the market clock, SPY
 * benchmarks, ticker validation. Eight of the sixteen original
 * AlpacaService.fromEnv() call sites were this, not account operations.
 *
 * Resolved independently of which account is active: switching accounts must
 * never change the bars, scores or catalysts you see. Returns null when no
 * account has usable credentials, and callers already fall back to Yahoo.
 */
export function marketDataClient(): AlpacaService | null {
  for (const account of listAccounts().sort((a, b) => a.id - b.id)) {
    if (account.broker !== "alpaca") continue;
    const svc = AlpacaService.forAccount(account);
    if (svc) return svc;
  }
  return null;
}
```

- [ ] **Step 4: Replace the 8 market-data call sites**

In each of these files replace `AlpacaService.fromEnv()` with `marketDataClient()` and add `import { marketDataClient } from "./marketDataSource";` (use `"@/services/marketDataSource"` in `src/jobs/scheduler.ts`):

- `src/services/bars.ts:55` — `refreshBars`
- `src/services/quotes.ts:53` — market clock
- `src/services/entityMentions.ts:201` — SPY bars
- `src/services/signalPerformance.ts:523` — SPY bars
- `src/services/watchlistImport.ts:42` — ticker validation
- `src/services/sectorScout.ts:416` — candidate validation
- `src/services/discoveryAgent.ts:279` — universe scan
- `src/jobs/scheduler.ts:48` — `detectPhase`

Remove the now-unused `AlpacaService` import from any file that no longer references it — `noUnusedLocals` will fail the typecheck otherwise.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS; typecheck clean. Then confirm no market-data path still resolves per account:

```bash
grep -rn "fromEnv()" src/services/bars.ts src/services/quotes.ts src/services/entityMentions.ts src/services/signalPerformance.ts src/services/watchlistImport.ts src/services/sectorScout.ts src/services/discoveryAgent.ts src/jobs/scheduler.ts
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/services/marketDataSource.ts src/services/__tests__/marketDataSource.test.ts src/services/bars.ts src/services/quotes.ts src/services/entityMentions.ts src/services/signalPerformance.ts src/services/watchlistImport.ts src/services/sectorScout.ts src/services/discoveryAgent.ts src/jobs/scheduler.ts
git commit -m "feat(#80): resolve market data independently of the active account"
```

---

### Task 5: Account-scoped reads

**Files:**
- Modify: `src/lib/queries.ts`
- Modify: `src/services/__tests__/persistence.test.ts`

**Interfaces:**
- Consumes: `activeAccount()` (Task 1), `accountId` columns (Task 2)
- Produces: `openTrades(accountId?: number)`, `closedTrades(accountId?: number)`, `allHoldings(accountId?: number)`, `journalEntries(accountId?: number)` — each defaulting to the active account

- [ ] **Step 1: Write the failing test**

```ts
// append to src/services/__tests__/persistence.test.ts
describe("account-scoped reads", () => {
  it("openTrades returns only the requested account's trades", () => {
    const base = { ticker: "MSFT", direction: "long", entryPrice: 400, entryDate: "2026-08-15T00:00:00Z",
      shares: 1, positionSize: 400, status: "open",
      createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T00:00:00Z" };
    getDb().insert(schema.activeTrades).values({ ...base, accountId: 1 }).run();
    getDb().insert(schema.activeTrades).values({ ...base, ticker: "AAPL", accountId: 2 }).run();

    expect(openTrades(1).map((t) => t.ticker)).toEqual(["MSFT"]);
    expect(openTrades(2).map((t) => t.ticker)).toEqual(["AAPL"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/persistence.test.ts`
Expected: FAIL — `openTrades(1)` returns both rows (the arg is ignored).

- [ ] **Step 3: Add the scoping**

For each of `openTrades`, `closedTrades`, `allHoldings`, `journalEntries` in `src/lib/queries.ts`, add the parameter and filter. Example for `openTrades`:

```ts
export function openTrades(accountId: number = activeAccount()?.id ?? 1) {
  return getDb()
    .select()
    .from(schema.activeTrades)
    .where(and(eq(schema.activeTrades.status, "open"), eq(schema.activeTrades.accountId, accountId)))
    .orderBy(desc(schema.activeTrades.updatedAt))
    .all();
}
```

Add `import { activeAccount } from "@/services/accounts";`.

- [ ] **Step 4: Confirm realized performance follows the scoping**

`getTradePerformance()` in `src/lib/queries.ts` calls `closedTrades()` and
`journalEntries()`, so it inherits the account scope automatically — this is the
spec's §8 consequence. Add the assertion so it cannot regress silently:

```ts
// append to src/services/__tests__/tradePerformance.test.ts
it("realized stats cover only the active account's closed trades", () => {
  const closed = (accountId: number, pct: number) => ({
    ticker: "MSFT", direction: "long", entryPrice: 100, entryDate: "2026-08-01T00:00:00Z",
    shares: 1, positionSize: 100, status: "closed", exitPrice: 100 + pct,
    unrealizedGainLoss: pct, unrealizedGainLossPercent: pct, accountId,
    closedAt: "2026-08-10T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-10T00:00:00Z",
  });
  getDb().insert(schema.activeTrades).values([closed(1, 10), closed(2, -10)]).run();
  // Account 1 sees only its own winner, not account 2's loser.
  expect(getTradePerformance(1).closed).toBe(1);
  expect(getTradePerformance(1).avgReturnPct).toBeGreaterThan(0);
});
```

Give `getTradePerformance(accountId: number = activeAccount()?.id ?? 1)` the same
default-parameter treatment as the other four readers.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. Existing callers pass no argument and get the active account — behaviour is unchanged while only one account exists.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries.ts src/services/__tests__/persistence.test.ts src/services/__tests__/tradePerformance.test.ts
git commit -m "feat(#80): account-scoped trade, holding, journal and realized-stat reads"
```

---

### Task 6: Order routing derives the account from the record

**Files:**
- Modify: `src/app/api/trades/[id]/exit/route.ts`, `src/app/api/trades/[id]/restore-stop/route.ts`, `src/app/api/portfolio/[id]/exit/route.ts`, `src/app/api/trades/place/route.ts`
- Modify: `src/app/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `AlpacaService.forAccount` (Task 3), `listAccounts` (Task 1)
- Produces: `adapterForRecord(accountId: number): { svc: AlpacaService; account: BrokerAccount } | { error: string }` in `src/services/accounts.ts`

- [ ] **Step 1: Write the failing test — this is the one that protects real money**

```ts
// append to src/app/api/__tests__/routes.test.ts
describe("order routing uses the record's account, not the active one", () => {
  it("routes an exit for an account-2 trade to account 2 while account 1 is active", async () => {
    process.env.ALPACA_API_KEY = "k1"; process.env.ALPACA_API_SECRET = "s1";
    process.env.ALPACA_2_API_KEY = "k2"; process.env.ALPACA_2_API_SECRET = "s2";
    getDb().insert(schema.brokerAccounts).values([
      { label: "A", broker: "alpaca", envPrefix: "", mode: "paper", isActive: true, createdAt: "2026-08-15T00:00:00Z" },
      { label: "B", broker: "alpaca", envPrefix: "2", mode: "paper", isActive: false, createdAt: "2026-08-15T00:00:00Z" },
    ]).run();
    const accountB = getDb().select().from(schema.brokerAccounts).all().find((a) => a.label === "B")!;

    getDb().insert(schema.activeTrades).values({
      ticker: "NVDA", direction: "long", entryPrice: 100, entryDate: "2026-08-01T14:30:00Z",
      shares: 5, positionSize: 500, status: "open", broker: "alpaca-paper", brokerOrderId: "e1",
      accountId: accountB.id, createdAt: "2026-08-01T14:30:00Z", updatedAt: "2026-08-01T14:30:00Z",
    }).run();
    const trade = getDb().select().from(schema.activeTrades).all().at(-1)!;

    const res = await tradesIdExitRoute.POST(jsonReq("POST", {}), params(trade.id));
    const body = await res.json();
    // Whatever the outcome, it must NOT have been attempted against account A.
    expect(JSON.stringify(body)).not.toContain("k1");
    expect(trade.accountId).toBe(accountB.id);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts`
Expected: FAIL — the route calls `fromEnv()` and ignores `trade.accountId`.

- [ ] **Step 3: Add the resolver**

```ts
// src/services/accounts.ts — append
import { AlpacaService } from "./alpaca";

/**
 * Resolve the broker client for a RECORD's account. Order routing must never
 * derive its account from the UI's active selection: a stale browser tab would
 * otherwise be able to send an order to the wrong account.
 */
export function adapterForRecord(accountId: number):
  { ok: true; svc: AlpacaService; account: BrokerAccount } | { ok: false; error: string } {
  const account = listAccounts().find((a) => a.id === accountId);
  if (!account) return { ok: false, error: `Unknown account ${accountId}.` };
  const svc = AlpacaService.forAccount(account);
  if (!svc) return { ok: false, error: `Account "${account.label}" has no credentials configured in .env.` };
  return { ok: true, svc, account };
}
```

- [ ] **Step 4: Use it in the four record-based routes**

In `trades/[id]/exit`, `trades/[id]/restore-stop` and `portfolio/[id]/exit`, replace:

```ts
const svc = AlpacaService.fromEnv();
if (!svc) return NextResponse.json({ error: "Alpaca is not configured." }, { status: 400 });
if (svc.mode === "live" && !parsed.data.confirmLive) { /* ... */ }
```

with:

```ts
// The account comes from the RECORD, never from the active-account setting.
const resolved = adapterForRecord(trade.accountId);
if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
const { svc, account } = resolved;
// mode is read server-side from the account, never from the client payload.
if (account.mode === "live" && !parsed.data.confirmLive) {
  return NextResponse.json(
    { error: `"${account.label}" is a LIVE account — resubmit with confirmLive to sell real shares.` },
    { status: 400 },
  );
}
```

(use `holding.accountId` in the portfolio route). In `trades/place`, take `accountId` from the validated request body and resolve the same way, then write that `accountId` onto the trade row it creates.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS including the routing test.

- [ ] **Step 6: Commit**

```bash
git add src/services/accounts.ts src/app/api/trades src/app/api/portfolio src/app/api/__tests__/routes.test.ts
git commit -m "feat(#80): route orders by the record's account, resolve confirmLive server-side"
```

---

### Task 7: `exit-all` becomes account-scoped

**Files:**
- Modify: `src/app/api/trades/exit-all/route.ts`
- Modify: `src/components/ExitAllPanel.tsx`
- Modify: `src/app/api/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `adapterForRecord` (Task 6), `openTrades(accountId)` (Task 5)
- Produces: `exit-all` request body gains `accountId: number`; the confirm phrase becomes `EXIT ALL <label>`

- [ ] **Step 1: Write the failing test**

```ts
// append to src/app/api/__tests__/routes.test.ts
describe("POST /api/trades/exit-all is account-scoped", () => {
  it("rejects a confirmation phrase that names a different account", async () => {
    getDb().insert(schema.brokerAccounts).values([
      { label: "Paper A", broker: "alpaca", envPrefix: "", mode: "paper", isActive: true, createdAt: "2026-08-15T00:00:00Z" },
      { label: "Paper B", broker: "alpaca", envPrefix: "2", mode: "paper", isActive: false, createdAt: "2026-08-15T00:00:00Z" },
    ]).run();
    const a = getDb().select().from(schema.brokerAccounts).all()[0];
    const res = await exitAllRoute.POST(jsonReq("POST", { accountId: a.id, confirm: "EXIT ALL Paper B" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Paper A");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts`
Expected: FAIL — the route accepts the bare phrase `EXIT ALL` and ignores the account.

- [ ] **Step 3: Scope the route**

```ts
// src/app/api/trades/exit-all/route.ts
const bodySchema = z.object({
  accountId: z.coerce.number().int().positive(),
  confirm: z.string(),
  confirmLive: z.coerce.boolean().default(false),
  exitReason: z.string().nullish(),
  thesisPlayedOut: z.union([z.boolean(), z.string()]).nullish(),
  rerunPerformance: z.coerce.boolean().default(true),
});

// ...after resolving the account:
// The phrase names the account, so confirming an exit-all for one account can
// never execute against another.
const phrase = `EXIT ALL ${account.label}`;
if (d.confirm !== phrase) {
  return NextResponse.json({ error: `Type "${phrase}" to confirm.` }, { status: 400 });
}
```

Select trades with `openTrades(account.id)` instead of every open trade.

- [ ] **Step 4: Update the panel**

In `ExitAllPanel.tsx`, accept `account: { id: number; label: string; mode: "paper" | "live" }` as a prop, use `` const CONFIRM_PHRASE = `EXIT ALL ${account.label}` ``, send `accountId: account.id`, and show the account label and mode in the heading and confirmation text.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/trades/exit-all/route.ts src/components/ExitAllPanel.tsx src/app/api/__tests__/routes.test.ts
git commit -m "feat(#80): scope exit-all to one account and name it in the confirmation"
```

---

### Task 8: Runner syncs every account

**Files:**
- Modify: `src/jobs/scheduler.ts`
- Modify: `src/services/orderSync.ts`, `src/services/stopCoverage.ts`, `src/services/marketData.ts` (`syncPortfolio`)

**Interfaces:**
- Consumes: `listAccounts` (Task 1), `AlpacaService.forAccount` (Task 3)
- Produces: `syncBrokerOrders(svc, accountId)`, `checkStopCoverage(svc, accountId)`, `syncPortfolio(svc, accountId)` — each explicitly account-parameterised

- [ ] **Step 1: Write the failing test**

```ts
// append to src/services/__tests__/stopCoverage.test.ts
it("checks only the given account's trades", async () => {
  // A trade belonging to account 2 must not be reported as a gap when
  // checking account 1 — that would raise a critical alert on the wrong book.
  const gaps = findStopGaps(
    [{ id: 1, ticker: "QBTS", direction: "long", shares: 97, stopLoss: 15.13, broker: "alpaca-paper" }],
    new Map([["QBTS", []]]),
  );
  expect(gaps).toHaveLength(1);
});
```

- [ ] **Step 2: Run the suite to confirm the current shape**

Run: `npx vitest run src/services/__tests__/stopCoverage.test.ts`
Expected: PASS (the pure function is already account-agnostic). The change below is in the IO wrapper, which selects which trades to feed it.

- [ ] **Step 3: Parameterise the three IO wrappers**

In `checkStopCoverage`, replace the internal `activeTrades` query with `openTrades(accountId)` and emit alerts with `accountId`. Do the same in `syncBrokerOrders` and `syncPortfolio` — each takes `(svc: AlpacaService, accountId: number)`.

- [ ] **Step 4: Loop accounts in the refresh cycle**

```ts
// src/jobs/scheduler.ts — inside the refresh cycle, replacing the single-account calls
// Market data is fetched ONCE above and shared; only account operations loop.
for (const account of listAccounts()) {
  const svc = AlpacaService.forAccount(account);
  if (!svc) { log(`account ${account.label}: no credentials, skipped`); continue; }
  try {
    const orders = await syncBrokerOrders(svc, account.id);
    if (orders.corrected || orders.canceled || orders.closed || orders.flagged)
      log(`[${account.label}] order sync: ${orders.corrected} corrected, ${orders.closed} auto-closed`);
    const coverage = await checkStopCoverage(svc, account.id);
    if (coverage.gaps.length)
      log(`[${account.label}] stop coverage: ${coverage.gaps.length} of ${coverage.checked} with no live stop`);
    upsertPortfolioSnapshot(account.id);
  } catch (e) {
    // One account failing must never abort the others.
    log(`account ${account.label} sync failed: ${errorMessage(e)}`);
  }
}
```

- [ ] **Step 5: Verify, then restart the runner**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

Then, because `tsx` loads code once at startup:
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-jobs-task.ps1
powershell -NoProfile -Command "Start-ScheduledTask -TaskName FinanceAgentJobs"
tail -5 data/logs/jobs.log
```
Expected: the log shows a refresh naming each account.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/scheduler.ts src/services/orderSync.ts src/services/stopCoverage.ts src/services/marketData.ts
git commit -m "feat(#80): runner syncs every account, market data fetched once"
```

---

### Task 9: Account switcher and page scoping

**Files:**
- Create: `src/app/api/accounts/route.ts`, `src/components/AccountSwitcher.tsx`
- Modify: `src/app/layout.tsx`, `src/app/portfolio/page.tsx`, `src/app/swing/page.tsx`, `src/app/performance/page.tsx`, `src/app/stock/[ticker]/page.tsx`

**Interfaces:**
- Consumes: `listAccounts`, `activeAccount`, `setActiveAccount` (Task 1)
- Produces: `GET /api/accounts` → `{ accounts, activeId }`; `POST /api/accounts` `{ id }` → sets active

- [ ] **Step 1: Write the failing test**

```ts
// append to src/app/api/__tests__/routes.test.ts
import * as accountsRoute from "../accounts/route";

describe("POST /api/accounts", () => {
  it("switches the active account", async () => {
    getDb().insert(schema.brokerAccounts).values([
      { label: "A", broker: "alpaca", envPrefix: "", mode: "paper", isActive: true, createdAt: "2026-08-15T00:00:00Z" },
      { label: "B", broker: "alpaca", envPrefix: "2", mode: "paper", isActive: false, createdAt: "2026-08-15T00:00:00Z" },
    ]).run();
    const b = getDb().select().from(schema.brokerAccounts).all().find((a) => a.label === "B")!;
    const res = await accountsRoute.POST(jsonReq("POST", { id: b.id }));
    expect(res.status).toBe(200);
    expect(getDb().select().from(schema.brokerAccounts).all().filter((a) => a.isActive)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/app/api/__tests__/routes.test.ts`
Expected: FAIL — cannot find module `../accounts/route`.

- [ ] **Step 3: Add the route**

```ts
// src/app/api/accounts/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { listAccounts, activeAccount, setActiveAccount } from "@/services/accounts";

export async function GET() {
  return NextResponse.json({
    accounts: listAccounts().map((a) => ({ id: a.id, label: a.label, mode: a.mode, broker: a.broker })),
    activeId: activeAccount()?.id ?? null,
  });
}

const bodySchema = z.object({ id: z.coerce.number().int().positive() });

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (!listAccounts().some((a) => a.id === parsed.data.id)) {
    return NextResponse.json({ error: "Unknown account." }, { status: 404 });
  }
  setActiveAccount(parsed.data.id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Add the switcher**

```tsx
// src/components/AccountSwitcher.tsx
"use client";
import { useApiAction } from "./useApiAction";

export interface AccountOption { id: number; label: string; mode: "paper" | "live" }

export function AccountSwitcher({ accounts, activeId }: { accounts: AccountOption[]; activeId: number | null }) {
  const { call, busy } = useApiAction();
  if (accounts.length === 0) return null;
  const active = accounts.find((a) => a.id === activeId);
  return (
    <select
      className={`text-xs ${active?.mode === "live" ? "border-red-500 text-red-300" : ""}`}
      value={activeId ?? ""}
      disabled={busy}
      aria-label="Active account"
      onChange={(e) => call("/api/accounts", { method: "POST", body: { id: Number(e.target.value) }, errorText: "Could not switch account." })}
    >
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}{a.mode === "live" ? " · LIVE" : ""}
        </option>
      ))}
    </select>
  );
}
```

Render it in `src/app/layout.tsx` beside the jobs badge, passing `listAccounts()` and `activeAccount()?.id`.

- [ ] **Step 5: Scope the pages**

In `portfolio/page.tsx`, `swing/page.tsx`, `performance/page.tsx` and `stock/[ticker]/page.tsx`, the existing `openTrades()` / `allHoldings()` / `journalEntries()` calls already default to the active account after Task 5 — verify each page renders the active account's data and pass `account` into `ExitAllPanel`.

- [ ] **Step 6: Verify live**

Run: `npx vitest run && npx tsc --noEmit`, then check each page:
```bash
for p in / /swing /portfolio /performance; do printf "%-14s" "$p"; curl -s -o /dev/null -w "%{http_code}\n" --max-time 90 "http://localhost:3000$p"; done
```
Expected: all 200, and the header shows the switcher.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/accounts src/components/AccountSwitcher.tsx src/app/layout.tsx src/app/portfolio src/app/swing src/app/performance src/app/stock src/app/api/__tests__/routes.test.ts
git commit -m "feat(#80): account switcher and per-account page scoping"
```

---

### Task 10: Close the spec's two open questions

**Files:**
- Modify: `src/services/tradeExport.ts`, `src/services/notifications.ts`
- Modify: `src/services/__tests__/tradeExport.test.ts`

**Interfaces:**
- Consumes: `accountId` on `activeTrades` (Task 2), `listAccounts` (Task 1)
- Produces: CSV gains an `account` column; account-scoped notifications gain a `[label]` prefix

These are §12 of the spec, answered rather than left dangling.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/services/__tests__/tradeExport.test.ts
it("includes the account label so an export of two accounts is not ambiguous", () => {
  const row = tradeCsvRow(
    { ticker: "MSFT", direction: "long", entryPrice: 100, exitPrice: 110, shares: 1,
      accountId: 1, status: "closed" } as never,
    undefined,
    "Alpaca Paper",
  );
  expect(row).toContain("Alpaca Paper");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/services/__tests__/tradeExport.test.ts`
Expected: FAIL — `tradeCsvRow` takes two arguments.

- [ ] **Step 3: Add the column and the prefix**

In `tradeExport.ts`, add `"account"` to the header array and pass the label
through `tradeCsvRow(trade, journal, accountLabel)`, resolving labels once via
`listAccounts()` keyed by id.

In `notifications.ts`, prefix the message with `` `[${label}] ` `` when the alert
carries a non-null `accountId`, so a phone push says which account it concerns.
Global alerts (null `accountId`) are unprefixed.

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tradeExport.ts src/services/notifications.ts src/services/__tests__/tradeExport.test.ts
git commit -m "feat(#80): account column in trade export, account label on notifications"
```

---

### Task 11: Add the second account and update the docs

**Files:**
- Modify: `.env.example`, `README.md`, `docs/ROADMAP.md`, `docs/agent-memory.md`

**Interfaces:**
- Consumes: everything above
- Produces: no code — configuration and documentation

- [ ] **Step 1: Document the env vars**

Append to `.env.example`:

```
# Additional brokerage accounts. Account 1 uses the unprefixed vars above.
# Each extra account gets a numbered prefix matching broker_accounts.env_prefix.
# ALPACA_2_API_KEY=
# ALPACA_2_API_SECRET=
# ALPACA_2_MODE=paper
```

- [ ] **Step 2: Insert the second account row**

Colby adds the real credentials to `.env` first. Then insert the **metadata only**
— `POST /api/accounts` switches the active account, it does not create one, and
credentials never enter the database:

```bash
npx tsx -e "
import { getDb, schema } from './src/db';
getDb().insert(schema.brokerAccounts).values({
  label: 'Alpaca Paper 2', broker: 'alpaca', envPrefix: '2',
  mode: 'paper', isActive: false, createdAt: new Date().toISOString(),
}).run();
console.log('added:', getDb().select().from(schema.brokerAccounts).all().map((a) => a.label));
"
```

Expected: two accounts listed. If `credentialsFor` returns null for the new row,
the `ALPACA_2_*` vars are missing or misspelled — fix `.env` and restart, rather
than editing the DB row.

- [ ] **Step 3: Verify the switch end-to-end**

Switch accounts in the header and confirm: `/portfolio` shows the new account's (empty) holdings, `/swing` shows no open trades, `/performance` realized stats are empty for it, and **the bars and scores on `/stock/AVGO` are unchanged** — market data must not follow the account.

- [ ] **Step 4: Update the docs**

- `README.md`: a short "Multiple accounts" subsection — env var convention, that credentials never enter the DB, that switching changes account data but never market data, and that orders route by the record's account.
- `docs/ROADMAP.md`: mark #80 done with what shipped.
- `docs/agent-memory.md`: the 8/8 account-vs-market-data split, and that order routing derives from the record.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add .env.example README.md docs/
git commit -m "docs(#80): multi-account setup, env convention and routing rules"
```

---

## Verification checklist

- [ ] Row counts unchanged after migration; every pre-existing row belongs to account 1
- [ ] A trade owned by account B routes to B's credentials while A is active
- [ ] `confirmLive` cannot be bypassed by a client-supplied mode
- [ ] `exit-all` scoped to one account; the phrase names it
- [ ] Runner loops all accounts; one failing does not abort the rest
- [ ] Market data identical regardless of active account
- [ ] `npx tsc --noEmit` clean; `npm test` green
- [ ] Jobs runner restarted after Task 8

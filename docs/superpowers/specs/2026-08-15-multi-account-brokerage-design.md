# Multi-account, multi-broker support — design

**Status:** proposed, awaiting review
**Date:** 2026-08-15
**Roadmap:** v11 #80

## Goal

Let the dashboard hold **many brokerage accounts** — across **different brokers**
and mixing **paper and real-money** — and switch between them, with one account
active at a time.

Today the app assumes exactly one Alpaca account, sourced from a single set of
env vars in nine places. Every account-scoped table implicitly belongs to it.

## What gets built now, and what does not

**Now:** an account layer whose *seams* are broker-agnostic, with **only the
Alpaca adapter implemented**. Adding a broker later is a new adapter plus a new
row — not a migration and not a rework of the account layer.

**Not now, deliberately:** any second broker's API integration; capability
negotiation for brokers that lack bracket orders, a market clock, or fractional
shares; and cross-account aggregate views. Each needs a real second broker in
hand to design against. Building them speculatively produces abstractions that
fit nothing.

## Decisions already taken

| Question | Decision |
|---|---|
| Watchlist scope | **Shared** across accounts — it is research, not an account property |
| Background runner | **Syncs every account**, not just the active one |
| Switching | **One active account at a time** |
| Credential storage | **Env vars only.** Never the DB |
| Live-money accounts | **Orders allowed**, with explicit per-order confirmation |

---

## 1. Data model

### New table `broker_accounts`

| column | notes |
|---|---|
| `id` | pk |
| `label` | user-facing, e.g. "Alpaca Paper", "Schwab Roth" |
| `broker` | `'alpaca'` today; the discriminator that picks an adapter |
| `envPrefix` | which env vars hold this account's credentials (see §3) |
| `mode` | `'paper' \| 'live'` |
| `isActive` | exactly one row true; the account the UI is showing |
| `createdAt` | |

`isActive` is kept single-valued by the **setter** (`setActiveAccount` clears the
flag on all rows inside one transaction, then sets it on the target), not by a DB
constraint — SQLite has no clean partial-unique index for "exactly one true".
Readers use `activeAccount()`, which falls back to the lowest-id paper account if
the invariant is ever violated, so a corrupted flag degrades to a safe default
rather than an error.

**No credentials in this table.** See §3.

### `account_id` added to five tables

`portfolio_holdings`, `active_trades`, `trade_journal_entries`,
`portfolio_snapshots`, and — **nullable** — `alerts`.

`alerts` is included on purpose. `stop_missing` and `trade_exit` are
account-specific, and `emitAlert`'s `onceWhileUnacked` dedupes on
(type, ticker). Without an account dimension, account B's "QBTS has no stop"
would be silently swallowed by account A's identical alert. A null `account_id`
means a global alert (`data_stale`, `concentration`).

### Unchanged — shared market data

`price_bars` (126k rows), `catalysts` (9k), `stock_scores`,
`market_price_snapshots`, `drawdown_metrics`, `trade_setups`, `entity_mentions`,
`earnings_reports`, `watchlist_items`, `agent_candidates`.

This is the reason the change is tractable: the large tables do not move.

### Migration (0011)

1. Create `broker_accounts`.
2. Insert account 1 from the existing env vars, `isActive = true`.
3. Add the `account_id` columns **`NOT NULL DEFAULT 1`** on the four
   account-scoped tables, and nullable on `alerts`.

SQLite cannot add a `NOT NULL` column without a default, so the default *is* the
backfill: every existing row becomes account 1 in the same statement. The default
stays in place afterwards rather than being dropped — rewriting a table in SQLite
to remove a default is a copy-and-swap, and the risk of that outweighs the tidiness
of not having one. New code always writes `account_id` explicitly, so the default
is a safety net rather than a behaviour anyone relies on.

Existing data keeps working untouched. The migration is additive and does not
delete or rewrite any row's meaning.

---

## 2. `BrokerAdapter`

One interface covering what the app actually uses today — no speculative
surface:

```ts
interface BrokerAdapter {
  readonly accountId: number;
  readonly mode: "paper" | "live";
  getAccount(): Promise<BrokerAccountSnapshot>;
  getPositions(): Promise<BrokerPosition[]>;
  getOrder(id: string): Promise<BrokerOrder>;
  workingOrders(): Promise<BrokerOrder[]>;
  placeOrder(req: BrokerOrderRequest): Promise<BrokerOrder>;
  cancelOrder(id: string): Promise<void>;
  getMarketClock(): Promise<{ isOpen: boolean; nextOpen: string | null }>;
}
```

`AlpacaService` implements it — largely a rename of its existing surface.

**Explicitly out of the interface:** historical bars. Bars are market data, not
account data (§4).

---

## 3. Credentials

Numbered env vars, resolved through `envPrefix`:

```
ALPACA_API_KEY / ALPACA_API_SECRET / ALPACA_MODE          # envPrefix ""   (account 1, existing)
ALPACA_2_API_KEY / ALPACA_2_API_SECRET / ALPACA_2_MODE    # envPrefix "2"
```

**Credentials never enter the database.** The README's security section states
secrets live only in `.env`, and the DB is copied into `data/backups/` seven
times over — putting keys there would spread them across seven files. Adding an
account therefore means editing `.env` and restarting, which is acceptable for
an operation performed rarely.

`mode` is stored in **both** places: `.env` is the source of truth at load time,
and it is mirrored into `broker_accounts.mode` so server-side guards can check it
without re-reading env per request. A mismatch is a startup error, not a silent
disagreement.

---

## 4. Market data is decoupled from accounts

Today `bars.ts:55` and `discoveryAgent.ts:279` call `AlpacaService.fromEnv()` to
fetch **bars**. With one account that is harmless. With a second broker it means
"which account is active" would silently determine where price history comes
from — different data depending on a UI toggle.

A single **market-data source** is resolved independently: the first configured
Alpaca account, falling back to Yahoo (which `bars.ts` already supports when
Alpaca is absent). Switching accounts must never change the bars, scores or
catalysts you see.

---

## 5. Order routing — the safety core

**Order routing derives the account from the record, never from the UI.**

Exiting a trade uses the credentials of the account that *owns that trade*, even
if the browser is showing another account. Deriving it from the active-account
setting would let a stale tab route an order to the wrong account — the single
most dangerous failure mode this feature introduces, and the reason it matters
now that real money is in scope.

Concretely, all five order paths resolve their adapter from the record:

| route | account comes from |
|---|---|
| `POST /api/trades/place` | explicit `accountId` in the request body, validated |
| `POST /api/trades/[id]/exit` | `active_trades.account_id` |
| `POST /api/trades/[id]/restore-stop` | `active_trades.account_id` |
| `POST /api/portfolio/[id]/exit` | `portfolio_holdings.account_id` |
| `POST /api/trades/exit-all` | explicit `accountId`, **scoped to that account only** |

### `exit-all` needs extra protection

Today it closes every open trade. Once accounts exist it must be **scoped to one
account**, and the typed confirmation becomes account-specific — the phrase
includes the account label, so confirming an exit-all for "Alpaca Paper" cannot
execute against "Schwab Roth".

### Live accounts

- `confirmLive` is resolved **server-side from `broker_accounts.mode`**, never
  from a client-supplied value. A client claiming `mode: paper` cannot bypass it.
- Every order path on a live account requires the explicit confirmation that
  order placement already enforces.
- The active-account selector shows live accounts in a visually distinct,
  unmistakable style, and the confirmation text names the account and its mode.
- **After a restart the active account resets to a paper account when one
  exists.** A live account should never become active by default.

---

## 6. Background runner

Market data is fetched **once** per refresh and shared. Then, per account:
`syncBrokerOrders`, `checkStopCoverage`, `upsertPortfolioSnapshot`.

Roughly 2× the broker calls on a loop that currently uses a small fraction of the
rate limit; no additional market-data cost. A failure against one account is
logged and must not abort the others.

---

## 7. UI

- Account switcher in the header beside the jobs badge, showing label and mode.
- `/portfolio`, `/swing`, `/performance` and the stock pages scope to the active
  account.
- The stock page's open-trades panel shows only the active account's trades.

---

## 8. Consequence: performance stats become per-account

`/performance` realized stats (win rate, avg R, profit factor) become
account-scoped. The existing 11-trade sample stays with account 1 rather than
blending with a new account's trades — correct, since mixing a paper and a live
track record would make both meaningless.

Score calibration, pick performance and setup outcomes are **unaffected**: they
measure the app's *analysis*, which is account-independent.

---

## 9. Testing

- Migration: backfill assigns every existing row to account 1; counts unchanged.
- `forAccount` resolves the right credentials per `envPrefix`; a missing env set
  is a clear startup error, not a silent fallback to account 1.
- **Routing:** a trade owned by account B routes to B's credentials while A is
  active. This is the test that protects real money.
- `confirmLive` cannot be bypassed by a client-supplied mode.
- `exit-all` scoped to one account leaves the other account's trades open.
- Runner loops all accounts; one account failing does not abort the rest.
- Market data is identical regardless of which account is active.

---

## 10. Phasing

Four phases, each independently shippable and verifiable. The app keeps working
with one account throughout — the second account is only added at phase 4, so
nothing is half-migrated at any point.

| phase | delivers | verifiable by |
|---|---|---|
| **1. Data model** | `broker_accounts`, migration 0011, `account_id` backfilled, `activeAccount()` / `setActiveAccount()` | row counts unchanged; every existing row belongs to account 1; app behaves exactly as before |
| **2. Adapter seam** | `BrokerAdapter`, `AlpacaService` implements it, all 9 `fromEnv()` call sites resolve per account, market data decoupled (§4) | still one account, still green; bars identical regardless of active account |
| **3. Routing + safety** | order paths derive the account from the record; `exit-all` scoped; `confirmLive` resolved server-side; live never active by default | the routing test in §9 — a trade owned by B routes to B while A is active |
| **4. Second account + UI** | header switcher, page scoping, `.env` gains the second key set | switching changes holdings/trades/performance and nothing else |

Phases 1–3 are invisible to you day to day. Only phase 4 changes what the
dashboard looks like.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Order routed to the wrong account | Account derived from the record, never the UI; covered by a dedicated test |
| Live account active by default after restart | Active account resets to a paper account when one exists |
| `exit-all` fires against the wrong account | Account-scoped, and the typed phrase includes the account label |
| Credentials leaking via backups | Credentials never leave `.env` |
| A future broker lacking bracket orders | Out of scope until a real second broker exists; the exit path is documented as Alpaca-specific |

## 12. Open questions

1. **Should closed/excluded trades keep their account on export?** Assumed yes —
   `tradeExport` gains an account column.
2. **Alert notifications** (desktop/ntfy) currently carry no account. Assumed the
   account label is prefixed for account-scoped alerts.

## 13. Out of scope

Cross-account aggregate views; per-account watchlists; non-Alpaca adapters;
capability negotiation; transferring positions between accounts.

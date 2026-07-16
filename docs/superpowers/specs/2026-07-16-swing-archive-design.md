# Swing Recommendation Archive — Design

**Date:** 2026-07-16
**Requested:** archive recommended swing trades; view archived ones on /swing in a hidden/toggleable section.

## Decisions (from brainstorming)

- **Archive = keep + remove:** archiving snapshots the recommendation exactly as
  it looked AND removes it from the "Recommended trades" table.
- **Episode-scoped suppression:** while the scanner keeps re-detecting the same
  (ticker, setup type) continuously, the pair stays hidden. Once a scan no
  longer detects it (episode over), suppression ends — a genuinely new episode
  weeks later lists normally. The snapshot itself is kept forever either way.
- **UI:** collapsible "Archived recommendations (N)" section under the live
  table (native `<details>`, collapsed by default). No modal.
- **Actions on archived rows:** unarchive (deletes the snapshot; the pair can
  list again immediately if still detected), place order (Trade button, with a
  stale-numbers caveat), edit a free-text note. No separate permanent-delete —
  unarchive is the only removal.

## Why a new table (approach chosen over alternatives)

`trade_setups` is detection/backtest data: `scanForSetups()` expires all active
rows and re-inserts what it currently sees on every scan (daily maintenance +
manual refresh); `dedupeSetups`/`resolveSetupOutcome` replay it; retention (#38)
thins non-active rows >30d. Storing user curation there would need
special-casing in all three. A separate `archived_setups` table keeps the
snapshot immune to retention and the detection stream untouched (rows keep
being inserted while suppressed, so the backtest still sees the episode).

Rejected: `archived` status on trade_setups (entangles curation with backtest
data, retention would thin snapshots); suppression-flags-only without snapshot
(retention degrades the archived view).

## Schema (migration 0008)

`archived_setups`:
- `id` integer PK autoincrement
- `ticker`, `setup_type` text NOT NULL
- snapshot of the source row: `setup_quality_score`, `entry_range_low`,
  `entry_range_high`, `stop_loss`, `target_price_1` (real NOT NULL),
  `target_price_2` (real), `risk_reward_ratio` (real NOT NULL),
  `invalidation_condition` (text), `detected_at` (text NOT NULL)
- `archived_at` text NOT NULL (nowIso)
- `note` text (nullable)
- `suppressing` integer NOT NULL default 1 — 1 while the archived episode is
  still being re-detected; 0 once the episode ended (row becomes pure history)

Generated via `npm run db:generate` from `schema.ts` (source of truth; never
touch legacyBaseline or applied migrations).

## Service: `src/services/setupArchive.ts`

- `archiveSetup(setupId, note?)` — reads the trade_setups row (must exist);
  idempotent per (ticker, setupType): if a `suppressing=1` archive row already
  exists for the pair, return it (update note if provided) instead of
  duplicating. Otherwise insert the snapshot with `suppressing=1`.
- `unarchiveSetup(id)` — deletes the row.
- `updateArchiveNote(id, note)` — sets note (empty string clears to null).
- `listArchivedSetups()` — newest archivedAt first.
- `suppressedSetupPairs()` — Set of `"TICKER|setup_type"` with suppressing=1,
  for the live-table filter.
- `clearEndedSuppressions(detectedPairs)` — sets `suppressing=0` on rows whose
  pair is NOT in this scan's detected set. Called at the end of
  `scanForSetups()` with the pairs it just inserted. A ticker skipped for
  missing bars counts as not-detected (data gap = episode break) — consistent
  with how a future re-detection is a new episode.

All timestamps via `nowIso()`.

## Wiring

- `activeSetups()` (lib/queries.ts) excludes rows whose (ticker, setupType) is
  in `suppressedSetupPairs()`.
- `scanForSetups()` (marketData.ts) calls `clearEndedSuppressions()` after its
  insert loop.
- API routes (Next route handlers, same shape as existing POST routes):
  - `POST /api/setups/archive` `{setupId, note?}`
  - `POST /api/setups/unarchive` `{id}`
  - `POST /api/setups/note` `{id, note}`

## UI (/swing)

- Each "Recommended trades" row gains a small **Archive** button
  (`ArchiveSetupButton`, client, useApiAction → /api/setups/archive, then
  router.refresh()).
- Below the section: `<details>` with `<summary>Archived recommendations (N)
  </summary>`, collapsed by default (native toggle, no JS state). Inside, a
  table: Ticker · Setup · Archived date · snapshot entry range/stop/targets/R:R
  /quality · current live price (latestSnapshot + freshness) · Note (inline
  editable, client) · Unarchive · Trade button (PlaceOrderButton fed the
  snapshot numbers). Footnote: archived numbers are a snapshot — entry/stop may
  no longer be valid; re-check before ordering.
- When N = 0 the details section still renders with "(0)" and an empty-state
  line (cheap, consistent).

## Error handling

- Archive of a vanished setupId → 404-style error message through useApiAction.
- Unarchive/note on a deleted row → same.
- Service functions never throw for the suppression-clearing path inside the
  scan (a failure there must not break the refresh) — wrap in try/catch + log.

## Testing

Persistence tests (`useTestDb()`), new file
`src/services/__tests__/setupArchive.test.ts`:
- archive copies every snapshot field and sets suppressing=1
- archive is idempotent per pair while suppressing; note updates on re-archive
- activeSetups hides suppressed pairs, shows others
- clearEndedSuppressions flips only pairs absent from the detected set;
  re-detection after clearing shows the pair again (new episode)
- unarchive deletes and the pair reappears in activeSetups
- note update round-trip; listArchivedSetups order

Live verify: archive a real recommendation on /swing → row leaves the table,
appears in the collapsed section with count; refresh scan keeps it hidden;
unarchive → row returns.

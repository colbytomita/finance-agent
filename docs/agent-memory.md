# Agent Memory

Last updated: 2026-06-26.

## Current State

`finance-agent` is a market-research and swing-trading decision-support
dashboard. It tracks portfolio/watchlist/trades, pulls market data, scores
stocks and trades, detects swing setups, monitors catalysts, proposes Agent
Picks, tracks earnings surprises, and runs Catalyst Edge event studies.

The work described in `docs/build-prompt-event-catalyst-engine.md` has largely
been implemented:

- `entity_mentions` exists in both Drizzle schema and SQLite DDL.
- `/events` exists as the Catalyst Edge page.
- Event-study math lives in `src/services/eventStudy.ts`.
- Entity mention CRUD and analysis/backfill orchestration live in
  `src/services/entityMentions.ts`.
- Event ingestion lives in `src/services/eventIngestion.ts`, with SEC EDGAR,
  GDELT, and IR RSS connectors under `src/services/sources/*`.
- Event extraction uses Haiku by default when Anthropic is configured and has a
  deterministic fallback in `src/services/eventExtraction.ts`.
- Edge-to-scoring catalyst creation lives in `src/services/catalystEdge.ts`.
- Scheduler wiring exists in `src/jobs/scheduler.ts`.
- Settings for ingestion sources/caps/confidence exist in config, API
  validation, and settings UI.
- Tests currently cover event-study math, extraction fallback, ingestion helpers,
  ticker/CIK resolution, and edge impact mapping.

## Recent Review Note

On 2026-06-26, Catalyst Edge and ingestion were reviewed. A stale-edge drift risk
was fixed: edge catalysts are now only created and surfaced for mentions inside
the configured `catalystFreshnessDays` window. Historical analysis remains
available on `/events`, but old mentions should not reappear as current scoring
signals or Agent Picks rationale.

Later on 2026-06-26, the Catalyst Edge source configuration was made editable in
Settings: `gdeltQueries` are edited one query per line, and `irFeeds` are edited
as `TICKER, URL` lines. The `/events` ingestion button now shows a richer run
summary with source counts, extraction mode, skipped count, catalyst writes, and
source/extraction errors.

## Important Constraints

- This is real-data-first. Do not seed demo data or fabricate rows.
- Existing SQLite data may be the user's working data.
- Scoring and UI must keep the "decision support only" framing.
- Catalyst Edge statistics must always be labeled as historical correlation, not
  advice or prediction.
- Social platforms are not scraped directly; ingest news coverage or official
  sources instead.
- Alpaca bars are expected to be ascending, oldest to newest.
- `getDb()` caches the connection and runs DDL once per process, so schema/table
  changes require restarting the dev server.

## Likely Next Work

- Consider adding per-item skipped reasons to ingestion results. The UI now shows
  aggregate skipped counts and source/extraction errors, but the service does not
  yet return one reason per skipped item.
- Add stronger duplicate controls for manually added mentions if duplicate
  entries become noisy.
- Consider filtering or labeling stale catalysts on stock detail timelines, not
  just scoring and Catalyst Edge surfaces.
- Add end-to-end route smoke tests or lightweight API tests if the project starts
  accepting broader changes.

## Standard Commands

```bash
npm run typecheck
npm test
npm run dev
npm run jobs
```


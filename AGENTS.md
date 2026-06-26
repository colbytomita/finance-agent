# Agent Instructions

This repo is a single-user localhost finance dashboard. Treat it as a real-data
decision-support tool, not a demo app and not an autonomous trader.

## Project Shape

- Stack: Next.js App Router, React, strict TypeScript, Tailwind, SQLite via
  `better-sqlite3` + Drizzle, Vitest.
- Core services live in `src/services/*`.
- DB schema is split across `src/db/schema.ts` and the DDL string in
  `src/db/index.ts`.
- Pages and JSON routes live under `src/app/*`.
- Non-secret settings live in the DB through `src/lib/config.ts`; secrets stay in
  `.env`.
- The durable project handoff is `docs/agent-memory.md`.
- `docs/build-prompt-event-catalyst-engine.md` is useful historical context from
  Claude Code, but it is not the current todo list. Read the code and
  `docs/agent-memory.md` before deciding what remains.

## Hard Rules

- Do not run `npm run db:seed` unless the user explicitly asks for demo data.
- Do not insert placeholder/demo rows into the user's SQLite DB.
- Do not commit, push, or create a PR unless the user explicitly asks.
- Keep safety language intact: decision support only, not financial advice, no
  autonomous trading, historical correlation is not a prediction.
- Order placement must remain explicitly user-initiated.
- Validate API input with `zod`; return `{ error }` with an appropriate status
  on failure.
- Long-running API routes should use `export const maxDuration = 300`.
- New DB tables/columns need both Drizzle schema and SQLite DDL/additive
  migration coverage.
- New app settings need updates in config, settings API validation, and settings
  UI.

## Verification

Run these after code changes:

```bash
npm run typecheck
npm test
```

Use `npm run dev` for the app and `npm run jobs` for the background scheduler.
The app runs at `http://localhost:3000`.


<div align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/7659/174594540-5e29e523-396a-465b-9a6e-6cab5b15a568.svg">
        <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/7659/174594559-0b3ddaa7-e75b-4f10-9dee-b51431a9fd4c.svg">
        <img src="https://user-images.githubusercontent.com/7659/174594540-5e29e523-396a-465b-9a6e-6cab5b15a568.svg" alt="Dependabot" width="336">
    </picture>
</div>

## Finance Agent

A market research and swing-trading **decision-support** dashboard (Next.js + TypeScript + Tailwind + SQLite). It tracks your portfolio, watchlist, and active swing trades; scores stocks (1–10) and trades (1–10); detects swing setups; tracks drawdowns, buy zones, and catalysts; and recommends **Enter / Wait / Hold / Add / Trim / Exit / Avoid** with plain-language explanations.

> **Safety boundary:** this app never places trades, never guarantees returns, and labels all model-generated interpretation separately from raw data. Every data point carries a timestamp and staleness warning.

### Quick start

```bash
npm install
npx playwright install chromium   # for the Yahoo Finance pre/after-hours connector
cp .env.example .env              # add Alpaca + (optional) Anthropic keys
npm run db:seed                   # optional demo data
npm run dev                       # dashboard at http://localhost:3000
npm run jobs                      # (separate terminal) background refresh scheduler
```

Without any API keys the app still runs: manual entry works everywhere, scores degrade to neutral/low-confidence, and the UI flags missing data. Alpaca enables price history, indicators, setups, and portfolio sync; an Anthropic key upgrades research briefs from rule-based to LLM-generated.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run jobs` | cron scheduler (market-state-aware refresh, catalyst scan, daily maintenance) |
| `npm run db:seed` | demo watchlist/trade/catalysts |
| `npm test` | vitest suite (scoring, buy zones, risk, exits, parsers — 100 tests) |
| `npm run typecheck` | strict TypeScript check |

### Layout

`src/services/*` — scoring, trade scoring, setup detection, risk management, buy zones, indicators, Alpaca, Yahoo browser connector, catalysts, research agent, alerts · `src/db/*` — Drizzle/SQLite schema (Postgres-ready) · `src/app/*` — dashboard views + API routes · `src/jobs/scheduler.ts` — background jobs.

---

## Dependabot Demo Repository

This repo contains some projects with outdated dependencies. Fork it to try out
Dependabot :dependabot:!

### Enabling Security Updates

- In your fork, click the **Settings** tab
- In the left hand side navigation, click **Code security and analysis**
- Enable **Dependabot security updates** or **Grouped security updates**
- Dependabot will now start creating PRs for detected security vulnerabilities
- Go into the **Security** tab and click **Dependabot** in the left hand side navigation to see what Dependabot is working on

<img width="929" alt="screenshot showing Dependabot working on Security Updates" src="https://github.com/dependabot/demo/assets/886768/9295c61a-631b-4c56-9c00-ff078874f362">

After about 5 minutes you should see some PRs open. Merge them and the Securty Alerts will close 🎉

### Enabling Version Updates

This demo includes a `dependabot.yml` which configures [Version Updates](https://docs.github.com/github/administering-a-repository/keeping-your-dependencies-updated-automatically), but forks don't automatically start with Dependabot enabled.

The enable Dependabot on your fork:
- Click the **Insights** tab
- In the left hand side navigation, click **Dependency Graph**
- Click on the **Dependabot** tab
- Click on the **Enable Dependabot** button
- After a moment, refresh the page and you should see Dependabot hard at work

<img width="917" alt="screenshot showing Dependabot working on Version Updates" src="https://github.com/dependabot/demo/assets/886768/4adf5727-255a-4ae1-97f7-70e94dc1134b">

After a few minutes, you should get some more PRs!

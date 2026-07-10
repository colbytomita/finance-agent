import { readFileSync } from "node:fs";

// .env loading for standalone tsx entrypoints (roadmap #40). Next.js loads
// .env for the app, but `npm run jobs` / `db:restore` / `db:seed` run under
// plain tsx, which does not — so the background scheduler silently ran
// without ALPACA_*/ANTHROPIC_* etc. (quotes fell back to Yahoo, broker order
// sync never ran from the scheduler). No new deps — a minimal parser.

/**
 * Parse .env text into `env` for keys it doesn't already have — real
 * environment variables always win, matching dotenv convention. Handles
 * comments, `export ` prefixes, and single/double-quoted values. Pure
 * (mutates only the passed object); returns the keys it set.
 */
export function applyDotEnv(text: string, env: Record<string, string | undefined>): string[] {
  const set: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values may carry a trailing comment.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    if (!(m[1] in env)) {
      env[m[1]] = value;
      set.push(m[1]);
    }
  }
  return set;
}

/** Load `.env` from the working directory into process.env. Best-effort. */
export function loadDotEnv(path = ".env"): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // no .env — fine, run on real env alone
  }
  return applyDotEnv(text, process.env);
}

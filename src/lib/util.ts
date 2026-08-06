// Tiny shared helpers. Keep this file dependency-free (no db, no config) so
// anything — services, lib, jobs — can import it without cycles.

/** Current time as an ISO string — the app's canonical timestamp format. */
export const nowIso = () => new Date().toISOString();

/** Clamp `v` into [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/** Human-readable message from an unknown thrown value. */
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Whether two ISO timestamps fall on the same UTC day. UTC deliberately, not
 * local: every `*_at` column in this app is written by `nowIso()`, and the
 * daily readers (`scoreSeries`, `buildScoreEvents`, retention's per-day
 * thinning) all bucket on `substr(ts, 1, 10)` — comparing in local time would
 * disagree with them by a day for a UTC-10 user (roadmap #61/#62).
 */
export const isSameUtcDay = (a: string, b: string): boolean =>
  a.slice(0, 10) === b.slice(0, 10);

/**
 * Format one CSV row from a list of fields (RFC-4180 quoting). A field is quoted
 * only when it contains a comma, double-quote, or newline; embedded quotes are
 * doubled. null/undefined render as an empty field. No trailing newline.
 */
export function toCsvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields
    .map((f) => {
      if (f == null) return "";
      const s = String(f);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

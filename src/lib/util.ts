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

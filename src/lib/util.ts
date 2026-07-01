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

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "playwright"],
  // `next build` was broken from 2026-07-25 until 2026-08-14, so no production
  // build existed and the dev server was the only way to run the app.
  //
  // Cause: TypeScript 7 is the native rewrite, and its package `exports` map
  // points "." at `lib/version.cjs` — which exports a version string, not the
  // classic compiler API. Next 16.2.10's build step still expects that API
  // (`typescript.sys`, `readConfigFile`, `formatDiagnostic`), so it resolved the
  // package, got an object with no `.sys`, and failed with the opaque
  // `The "id" argument must be of type string. Received undefined`.
  //
  // Skipping Next's type-check step sidesteps it. **Type safety is NOT lost** —
  // `npm run typecheck` (`tsc --noEmit`) is this project's type gate and passes
  // under TS7 with `noUnusedLocals`/`noUnusedParameters` on. Run it before
  // shipping; the build no longer does it for you.
  //
  // Revisit when Next supports TypeScript 7 natively, then delete this.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;

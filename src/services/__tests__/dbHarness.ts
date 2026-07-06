import { beforeEach, afterAll } from "vitest";
import { resetDbForTests } from "@/db";

// Integration-test harness (roadmap #6): point getDb() at an in-memory SQLite
// database and rebuild it fresh (full DDL + migrations) before every test, so
// write-path tests are isolated and never touch data/finance-agent.db.
//
// Usage: call useTestDb() at the top of a describe-less test file (or inside
// a describe block), then exercise services that use getDb() normally.

export function useTestDb(): void {
  process.env.DATABASE_PATH = ":memory:";
  beforeEach(() => {
    resetDbForTests();
  });
  afterAll(() => {
    resetDbForTests();
    delete process.env.DATABASE_PATH;
  });
}

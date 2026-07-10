import { describe, expect, it } from "vitest";
import { applyDotEnv } from "../loadEnv";

describe("applyDotEnv (roadmap #40)", () => {
  it("parses assignments, quotes, export prefixes, and skips comments", () => {
    const env: Record<string, string | undefined> = {};
    const set = applyDotEnv(
      [
        "# comment line",
        "ALPACA_API_KEY=abc123",
        'ALPACA_API_SECRET="s3cr3t=with=equals"',
        "export ALPACA_MODE='paper'",
        "SEC_USER_AGENT=finance-agent me@example.com",
        "EMPTY=",
        "TRAILING=value # not part of the value",
        "not a valid line",
      ].join("\n"),
      env,
    );
    expect(env.ALPACA_API_KEY).toBe("abc123");
    expect(env.ALPACA_API_SECRET).toBe("s3cr3t=with=equals");
    expect(env.ALPACA_MODE).toBe("paper");
    expect(env.SEC_USER_AGENT).toBe("finance-agent me@example.com");
    expect(env.EMPTY).toBe("");
    expect(env.TRAILING).toBe("value");
    expect(set).toHaveLength(6);
  });

  it("never overwrites variables the real environment already set", () => {
    const env: Record<string, string | undefined> = { ALPACA_MODE: "live" };
    applyDotEnv("ALPACA_MODE=paper\nNEW_KEY=x", env);
    expect(env.ALPACA_MODE).toBe("live"); // real env wins
    expect(env.NEW_KEY).toBe("x");
  });

  it("handles CRLF files", () => {
    const env: Record<string, string | undefined> = {};
    applyDotEnv("A=1\r\nB=2\r\n", env);
    expect(env).toEqual({ A: "1", B: "2" });
  });
});

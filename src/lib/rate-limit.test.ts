import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  clientIpFromRequest,
  enforceIpRateLimit,
  enforceUserRateLimit,
  hashClientIp,
  secondsUntilWindowEnds,
  tryConsumeUserRateLimit,
} from "./rate-limit";

/** Fixed-window counter shared by both RPCs, like the SQL functions. */
function installCounter() {
  const counts = new Map<string, number>();
  mocks.rpc.mockImplementation(
    async (
      name: string,
      args: { p_bucket_key: string; p_limit: number; p_user_id?: string; p_ip_hash?: string },
    ) => {
      const key = `${name}:${args.p_user_id ?? args.p_ip_hash}:${args.p_bucket_key}`;
      const next = (counts.get(key) ?? 0) + 1;
      if (next > args.p_limit) {
        return { data: null, error: { message: "Rate limit exceeded." } };
      }
      counts.set(key, next);
      return { data: next, error: null };
    },
  );
}

const policy = { userId: "user-1", bucketKey: "market-estimate", limit: 30, windowSeconds: 60 };

describe("rate limiting", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("allows 30 calls per minute and rejects the 31st with a RateLimitError", async () => {
    installCounter();
    for (let call = 1; call <= 30; call += 1) {
      await expect(enforceUserRateLimit(policy)).resolves.toBe(call);
    }
    const failure = await enforceUserRateLimit(policy).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimitError);
    expect((failure as RateLimitError).retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((failure as RateLimitError).retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("keeps buckets independent per user and per bucket key", async () => {
    installCounter();
    for (let call = 0; call < 30; call += 1) await enforceUserRateLimit(policy);

    await expect(enforceUserRateLimit({ ...policy, userId: "user-2" })).resolves.toBe(1);
    await expect(enforceUserRateLimit({ ...policy, bucketKey: "other" })).resolves.toBe(1);
  });

  it("reports an exhausted budget as false from tryConsumeUserRateLimit", async () => {
    installCounter();
    const daily = { userId: "user-1", bucketKey: "weather", limit: 5, windowSeconds: 86_400 };
    for (let call = 0; call < 5; call += 1) {
      await expect(tryConsumeUserRateLimit(daily)).resolves.toBe(true);
    }
    await expect(tryConsumeUserRateLimit(daily)).resolves.toBe(false);
  });

  it("surfaces unexpected database errors from the user limiter", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    await expect(enforceUserRateLimit(policy)).rejects.toThrow("connection refused");
  });

  it("limits anonymous callers per IP and never stores the raw address", async () => {
    installCounter();
    const request = new Request("https://example.test/api/x", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    const ipPolicy = { request, bucketKey: "lawyers.directory", limit: 60, windowSeconds: 60 };
    for (let call = 0; call < 60; call += 1) await enforceIpRateLimit(ipPolicy);

    await expect(enforceIpRateLimit(ipPolicy)).rejects.toBeInstanceOf(RateLimitError);
    const sent = mocks.rpc.mock.calls[0]?.[1] as { p_ip_hash: string };
    expect(sent.p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("203.0.113.9");
  });

  it("fails open when the IP limiter itself is unavailable", async () => {
    mocks.rpc.mockRejectedValue(new Error("network down"));
    const request = new Request("https://example.test/api/x");
    await expect(
      enforceIpRateLimit({ request, bucketKey: "k", limit: 1, windowSeconds: 60 }),
    ).resolves.toBeUndefined();
  });

  it("resolves the client IP from platform headers and hashes it with a salt", () => {
    const direct = new Request("https://example.test", {
      headers: { "x-real-ip": "198.51.100.4" },
    });
    const forwarded = new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
    });
    expect(clientIpFromRequest(direct)).toBe("198.51.100.4");
    expect(clientIpFromRequest(forwarded)).toBe("198.51.100.7");
    expect(clientIpFromRequest(new Request("https://example.test"))).toBe("unknown");
    expect(hashClientIp("198.51.100.4", "a")).not.toBe(hashClientIp("198.51.100.4", "b"));
  });

  it("computes Retry-After from the end of the fixed window", () => {
    expect(secondsUntilWindowEnds(60, new Date("2026-10-09T10:00:15.000Z"))).toBe(45);
    expect(secondsUntilWindowEnds(60, new Date("2026-10-09T10:00:00.000Z"))).toBe(60);
  });
});

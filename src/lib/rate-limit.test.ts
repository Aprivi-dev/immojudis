import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  clientIpFromRequest,
  clientNetworkKey,
  enforceIpRateLimit,
  enforceUserRateLimit,
  hashClientIp,
  ipRateLimitTarget,
  ipRateLimiterStats,
  resetIpRateLimiterStats,
  secondsUntilWindowEnds,
  tryConsumeUserRateLimit,
  UNKNOWN_CLIENT_LIMIT,
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
    resetIpRateLimiterStats();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

  describe("failures of the IP limiter are counted in the logs, and still fail open", () => {
    const request = new Request("https://example.test/api/x", {
      headers: { "x-real-ip": "198.51.100.4" },
    });
    const logged = () =>
      vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(String(line)));

    it("logs one JSON line per failure with the counters of the instance", async () => {
      mocks.rpc.mockRejectedValue(new Error("network down"));
      const input = { request, bucketKey: "catalogue.preview", limit: 180, windowSeconds: 60 };

      await expect(enforceIpRateLimit(input)).resolves.toBeUndefined();
      await expect(enforceIpRateLimit(input)).resolves.toBeUndefined();

      expect(logged()).toEqual([
        expect.objectContaining({
          scope: "rate-limit",
          event: "ip_limiter_failure",
          outcome: "fail_open",
          reason: "exception",
          bucket: "catalogue.preview",
          message: "network down",
          failures: 1,
          calls: 1,
        }),
        expect.objectContaining({ failures: 2, calls: 2 }),
      ]);
      expect(ipRateLimiterStats()).toMatchObject({ calls: 2, failures: 2, unidentified: 0 });
      // Ni l'adresse ni son empreinte ne sont journalisées.
      expect(JSON.stringify(logged())).not.toContain("198.51.100.4");
    });

    it("also counts an error answered by the database (not a refusal) and lets the call through", async () => {
      mocks.rpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

      await expect(
        enforceIpRateLimit({ request, bucketKey: "k", limit: 1, windowSeconds: 60 }),
      ).resolves.toBeUndefined();

      expect(logged()).toEqual([
        expect.objectContaining({ reason: "rpc_error", message: "permission denied", failures: 1 }),
      ]);
    });

    it("does not count a refusal as a failure of the limiter", async () => {
      installCounter();
      const input = { request, bucketKey: "k", limit: 1, windowSeconds: 60 };
      await enforceIpRateLimit(input);

      await expect(enforceIpRateLimit(input)).rejects.toBeInstanceOf(RateLimitError);

      expect(console.error).not.toHaveBeenCalled();
      expect(ipRateLimiterStats()).toMatchObject({ calls: 2, failures: 0 });
    });

    it("bounds the length of the logged message", async () => {
      mocks.rpc.mockRejectedValue(new Error("x".repeat(5000)));

      await enforceIpRateLimit({ request, bucketKey: "k", limit: 1, windowSeconds: 60 });

      expect(logged()[0].message).toHaveLength(200);
    });
  });

  describe("a request without a usable address", () => {
    const anonymous = (headers: Record<string, string> = {}) =>
      new Request("https://example.test/api/x", { headers });
    const sent = () =>
      mocks.rpc.mock.calls.map(
        ([, args]) => args as { p_bucket_key: string; p_ip_hash: string; p_limit: number },
      );

    it("gets a dedicated bucket and a very low quota, whatever the policy", async () => {
      installCounter();
      const policy = { bucketKey: "catalogue.preview", limit: 180, windowSeconds: 60 };

      await enforceIpRateLimit({ ...policy, request: anonymous() });

      expect(sent()[0]).toMatchObject({ p_limit: UNKNOWN_CLIENT_LIMIT });
      expect(sent()[0].p_bucket_key).toMatch(/^catalogue\.preview\.unknown\.[0-9a-f]{16}$/);
      expect(UNKNOWN_CLIENT_LIMIT).toBeLessThanOrEqual(10);
    });

    it("never gets more than the policy allows", async () => {
      installCounter();

      await enforceIpRateLimit({
        request: anonymous(),
        bucketKey: "k",
        limit: 3,
        windowSeconds: 60,
      });

      expect(sent()[0].p_limit).toBe(3);
    });

    it("is refused once the low quota is used, while an identified address keeps its own", async () => {
      installCounter();
      const policy = { bucketKey: "catalogue.preview", limit: 180, windowSeconds: 60 };
      for (let call = 0; call < UNKNOWN_CLIENT_LIMIT; call += 1) {
        await enforceIpRateLimit({ ...policy, request: anonymous() });
      }

      await expect(enforceIpRateLimit({ ...policy, request: anonymous() })).rejects.toBeInstanceOf(
        RateLimitError,
      );
      await expect(
        enforceIpRateLimit({
          ...policy,
          request: anonymous({ "x-real-ip": "198.51.100.4" }),
        }),
      ).resolves.toBeUndefined();
    });

    it("does not make every anonymous client share one bucket", async () => {
      installCounter();
      const policy = { bucketKey: "k", limit: 180, windowSeconds: 60 };
      for (let call = 0; call < UNKNOWN_CLIENT_LIMIT; call += 1) {
        await enforceIpRateLimit({ ...policy, request: anonymous({ "user-agent": "client-a" }) });
      }

      await expect(
        enforceIpRateLimit({ ...policy, request: anonymous({ "user-agent": "client-a" }) }),
      ).rejects.toBeInstanceOf(RateLimitError);
      await expect(
        enforceIpRateLimit({ ...policy, request: anonymous({ "user-agent": "client-b" }) }),
      ).resolves.toBeUndefined();
      const buckets = new Set(sent().map((call) => call.p_bucket_key));
      expect(buckets.size).toBe(2);
    });

    it("keeps the bucket of an identified address apart from the one of an anonymous request", async () => {
      installCounter();
      await enforceIpRateLimit({
        request: anonymous(),
        bucketKey: "k",
        limit: 60,
        windowSeconds: 60,
      });
      await enforceIpRateLimit({
        request: anonymous({ "x-real-ip": "198.51.100.4" }),
        bucketKey: "k",
        limit: 60,
        windowSeconds: 60,
      });

      const [unknown, identified] = sent();
      expect(identified.p_bucket_key).toBe("k");
      expect(unknown.p_bucket_key).not.toBe("k");
      expect(identified.p_limit).toBe(60);
    });

    it("is counted in the logs: first occurrence, then every hundredth", async () => {
      installCounter();
      const policy = { bucketKey: "k", limit: 180, windowSeconds: 60 };

      for (let call = 0; call < 200; call += 1) {
        await enforceIpRateLimit({
          ...policy,
          request: anonymous({ "user-agent": `client-${call}` }),
        });
      }

      const lines = vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines.map((line) => line.unidentified)).toEqual([1, 100, 200]);
      expect(lines[0]).toMatchObject({
        scope: "rate-limit",
        event: "ip_unidentified",
        bucket: "k",
      });
      expect(ipRateLimiterStats().unidentified).toBe(200);
    });
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

  it("hashes an IPv6 address by its /64 prefix: the interface identifier does not make a new bucket", () => {
    const salt = "s";
    const hash = (ip: string) => hashClientIp(ip, salt);
    // Même /64, 64 bits de poids faible différents (adresses « temporaires » de la vie courante).
    expect(hash("2001:db8:abcd:12::1")).toBe(hash("2001:db8:abcd:12:ffff:eeee:dddd:cccc"));
    expect(hash("2001:db8:abcd:12::1")).toBe(hash("2001:0db8:ABCD:0012:0:0:0:2"));
    expect(hash("2001:db8:abcd:12::1")).toBe(hash("2001:db8:abcd:12::1%eth0"));
    // Un autre /64 (même /48) a son propre seau.
    expect(hash("2001:db8:abcd:12::1")).not.toBe(hash("2001:db8:abcd:13::1"));
    expect(hash("2001:db8:abcd:12::1")).not.toBe(hash("2001:db8:abce:12::1"));
    // Adresses courtes et IPv4 incorporée.
    expect(clientNetworkKey("::1")).toBe("0:0:0:0::/64");
    expect(clientNetworkKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    expect(clientNetworkKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("keeps an IPv4 address whole, maps IPv4-in-IPv6 to it, and leaves other values alone", () => {
    expect(clientNetworkKey("198.51.100.4")).toBe("198.51.100.4");
    expect(clientNetworkKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(clientNetworkKey("unknown")).toBe("unknown");
    expect(hashClientIp("::ffff:198.51.100.4", "a")).toBe(hashClientIp("198.51.100.4", "a"));
    expect(hashClientIp("198.51.100.4", "a")).not.toBe(hashClientIp("198.51.100.5", "a"));
  });

  it("gives every address of an IPv6 /64 the same rate-limit bucket", () => {
    const target = (ip: string) =>
      ipRateLimitTarget(
        new Request("https://example.test", { headers: { "x-real-ip": ip } }),
        "k",
        60,
      );
    expect(target("2001:db8::1").ipHash).toBe(target("2001:db8::dead:beef").ipHash);
    expect(target("2001:db8::1").bucketKey).toBe("k");
  });

  it("computes Retry-After from the end of the fixed window", () => {
    expect(secondsUntilWindowEnds(60, new Date("2026-10-09T10:00:15.000Z"))).toBe(45);
    expect(secondsUntilWindowEnds(60, new Date("2026-10-09T10:00:00.000Z"))).toBe(60);
  });
});

describe("RateLimit headers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    installCounter();
  });

  it("records the quota left on the request context and writes it as RateLimit-* headers", async () => {
    const context = createApiRequestContext(new Request("https://example.test/api/v1/x"), "test");
    await enforceUserRateLimit({ ...policy, limit: 5, context });
    expect(context.rateLimit).toEqual({ limit: 5, remaining: 4 });
    await enforceUserRateLimit({ ...policy, limit: 5, context });
    const response = apiJson({ ok: true }, context);
    expect(response.headers.get("ratelimit-limit")).toBe("5");
    expect(response.headers.get("ratelimit-remaining")).toBe("3");
  });

  it("answers the refused call with remaining 0 next to Retry-After", async () => {
    const context = createApiRequestContext(new Request("https://example.test/api/v1/x"), "test");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let call = 0; call < 2; call += 1) {
      await enforceUserRateLimit({ ...policy, limit: 2, context });
    }
    const refused = await enforceUserRateLimit({ ...policy, limit: 2, context }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RateLimitError);
    const response = apiError(refused, context, { fallbackMessage: "Indisponible." });
    expect(response.status).toBe(429);
    expect(response.headers.get("ratelimit-limit")).toBe("2");
    expect(response.headers.get("ratelimit-remaining")).toBe("0");
    expect(response.headers.get("retry-after")).toBeTruthy();
  });

  it("adds nothing without a context (routes that do not publish a quota)", async () => {
    await expect(enforceUserRateLimit({ ...policy, limit: 5 })).resolves.toBe(1);
    const response = apiJson(
      { ok: true },
      createApiRequestContext(new Request("https://x.test"), "t"),
    );
    expect(response.headers.has("ratelimit-limit")).toBe(false);
  });
});

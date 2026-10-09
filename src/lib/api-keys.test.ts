import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: fromMock } }));

import {
  API_KEY_MAX_LIFETIME_DAYS,
  apiKeyAuthContextFromRequest,
  apiKeyLookupPrefix,
  createApiKeyReader,
  resolveApiKeyExpiry,
  apiKeySecretFromRequest,
  generateApiKeySecret,
  hashApiKey,
  isApiKeySecret,
  safeCompareHexDigests,
} from "@/lib/api-keys";

describe("API key helpers", () => {
  it("generates opaque ImmoJudis API secrets and stable lookup prefixes", () => {
    const secret = generateApiKeySecret();

    expect(isApiKeySecret(secret)).toBe(true);
    expect(apiKeyLookupPrefix(secret)).toBe(secret.slice(0, 18));
    expect(apiKeyLookupPrefix(secret).startsWith("ij_live_")).toBe(true);
  });

  it("hashes API keys without exposing the raw secret", () => {
    const secret = "ij_live_test_abcdefghijklmnopqrstuvwxyz";
    const hash = hashApiKey(secret);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(secret);
    expect(safeCompareHexDigests(hash, hashApiKey(secret))).toBe(true);
    expect(safeCompareHexDigests(hash, hashApiKey(`${secret}_other`))).toBe(false);
    expect(safeCompareHexDigests("invalid", hash)).toBe(false);
  });

  it("extracts API keys from dedicated and bearer headers", () => {
    const secret = "ij_live_test_abcdefghijklmnopqrstuvwxyz";

    expect(
      apiKeySecretFromRequest(
        new Request("https://app.test", { headers: { "x-immojudis-api-key": secret } }),
      ),
    ).toBe(secret);
    expect(
      apiKeySecretFromRequest(
        new Request("https://app.test", { headers: { authorization: `Bearer ${secret}` } }),
      ),
    ).toBe(secret);
    expect(
      apiKeySecretFromRequest(
        new Request("https://app.test", { headers: { authorization: "Bearer supabase-token" } }),
      ),
    ).toBeNull();
  });
});

describe("API key authorization hardening", () => {
  const NOW = new Date("2026-10-09T10:00:00.000Z");

  it("always expires keys: default and maximum lifetime are 365 days", () => {
    expect(API_KEY_MAX_LIFETIME_DAYS).toBe(365);
    expect(resolveApiKeyExpiry(null, NOW)).toBe("2027-10-09T10:00:00.000Z");
    expect(resolveApiKeyExpiry(undefined, NOW)).toBe("2027-10-09T10:00:00.000Z");
    expect(resolveApiKeyExpiry("2027-01-01T00:00:00.000Z", NOW)).toBe("2027-01-01T00:00:00.000Z");
  });

  it("refuses a past expiry date and a lifetime above 365 days", () => {
    expect(() => resolveApiKeyExpiry("2026-10-08T10:00:00.000Z", NOW)).toThrow("future");
    expect(() => resolveApiKeyExpiry("2027-10-10T10:00:01.000Z", NOW)).toThrow("365 jours");
  });

  it("only exposes read access to the catalogue views and the owner's plan", () => {
    const select = vi.fn().mockReturnValue("query");
    const reader = createApiKeyReader({ from: vi.fn().mockReturnValue({ select }) } as never);

    expect(reader.from("v_auction_sales_app" as never).select("id")).toBe("query");
    expect(() => reader.from("auction_sales" as never)).toThrow("clé API");
    expect(() => reader.from("user_profiles" as never)).toThrow("clé API");
    expect(Object.keys(reader.from("v_auction_sales_app" as never))).toEqual(["select"]);
  });

  describe("key-authenticated context", () => {
    const secret = "ij_live_test_abcdefghijklmnopqrstuvwxyz";
    beforeEach(() => fromMock.mockReset());

    it("never grants administrator rights and never hands out the service-role client", async () => {
      const keyRow = {
        id: "key-1",
        user_id: "admin-user",
        key_hash: hashApiKey(secret),
        key_prefix: apiKeyLookupPrefix(secret),
        scopes: ["sales.feed:read"],
        expires_at: null,
        revoked_at: null,
      };
      const keyQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [keyRow], error: null }),
        update: vi.fn().mockReturnThis(),
      };
      keyQuery.update.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
      const profileQuery = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { account_tier: "premium", user_role: "admin" },
          error: null,
        }),
      };
      fromMock.mockImplementation((table: string) =>
        table === "user_api_keys" ? keyQuery : profileQuery,
      );

      const context = await apiKeyAuthContextFromRequest(
        new Request("https://app.test", { headers: { "x-immojudis-api-key": secret } }),
      );

      expect(context?.isAdmin).toBe(false);
      expect(context?.userId).toBe("admin-user");
      expect(context?.claims.api_key_id).toBe("key-1");
      expect(() => context?.supabase.from("user_api_keys" as never)).toThrow();
    });
  });
});

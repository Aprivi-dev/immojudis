import { describe, expect, it } from "vitest";
import {
  apiKeyLookupPrefix,
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

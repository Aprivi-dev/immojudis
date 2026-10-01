import { describe, expect, it, vi } from "vitest";
import {
  buildProviderCanaryMessage,
  RESEND_DELIVERY_TEST_ADDRESS,
  resolveProviderCanaryConfig,
  sendProviderCanary,
} from "./send-information-agent-provider-canary.mjs";

const validEnv = {
  INFORMATION_AGENT_PROVIDER_CANARY: "true",
  INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
  INFORMATION_AGENT_OUTBOUND_CANARY_ONLY: "true",
  INFORMATION_AGENT_CANARY_CONFIRM: RESEND_DELIVERY_TEST_ADDRESS,
  INFORMATION_AGENT_CANARY_FROM: "ImmoJudis <onboarding@resend.dev>",
  RESEND_API_KEY: "re_test_canary_fixture",
};

describe("provider canary harness", () => {
  it("requires the explicit canary flags, a sender, and the fixed confirmation", () => {
    expect(() => resolveProviderCanaryConfig({})).toThrow("INFORMATION_AGENT_PROVIDER_CANARY");
    expect(() =>
      resolveProviderCanaryConfig({
        ...validEnv,
        INFORMATION_AGENT_CANARY_CONFIRM: "contact@example.test",
      }),
    ).toThrow("delivered@resend.dev");
    expect(() =>
      resolveProviderCanaryConfig({
        ...validEnv,
        INFORMATION_AGENT_CANARY_FROM: "\ncontact@example.test",
      }),
    ).toThrow("expéditeur invalide");
  });

  it("refuses any Supabase configuration before a provider request", () => {
    expect(() =>
      resolveProviderCanaryConfig({
        ...validEnv,
        SUPABASE_URL: "https://production.supabase.co",
      }),
    ).toThrow("configuration Supabase");
  });

  it("does not call the provider when the explicit confirmation is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendProviderCanary({
        env: { ...validEnv, INFORMATION_AGENT_CANARY_CONFIRM: "" },
        fetchImpl,
      }),
    ).rejects.toThrow("delivered@resend.dev");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cannot be pointed at a real contact by the message builder", () => {
    expect(() =>
      buildProviderCanaryMessage({
        from: validEnv.INFORMATION_AGENT_CANARY_FROM,
        to: "contact@example.test",
      }),
    ).toThrow("adresse de test Resend");
  });

  it("sends only the fixed Resend test recipient and no sale or database data", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(_url).toBe("https://api.resend.com/emails");
      const payload = JSON.parse(String(init.body));
      expect(payload).toMatchObject({
        from: validEnv.INFORMATION_AGENT_CANARY_FROM,
        to: [RESEND_DELIVERY_TEST_ADDRESS],
      });
      expect(payload).not.toHaveProperty("sale_id");
      expect(payload).not.toHaveProperty("mission_id");
      expect(payload).not.toHaveProperty("attachments");
      expect(init.headers.authorization).toBe(`Bearer ${validEnv.RESEND_API_KEY}`);
      return Response.json({ id: "email_canary_fixture" });
    });

    await expect(sendProviderCanary({ env: validEnv, fetchImpl })).resolves.toEqual({
      ok: true,
      provider: "resend",
      recipient: RESEND_DELIVERY_TEST_ADDRESS,
      messageId: "email_canary_fixture",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not hide a provider rejection", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: "invalid sender" }, { status: 403 }),
    );
    await expect(sendProviderCanary({ env: validEnv, fetchImpl })).rejects.toThrow(
      "invalid sender",
    );
  });
});

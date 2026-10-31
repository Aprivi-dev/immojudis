import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ process: vi.fn() }));

vi.mock("@/lib/account-email-delivery-events", () => ({
  processAccountEmailDeliveryWebhook: mocks.process,
}));

import { POST } from "./route";

const call = () =>
  POST(
    new Request("https://immojudis.test/api/webhooks/resend/account-emails", { method: "POST" }),
  );

function failure(name: string, message = "x") {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("POST /api/webhooks/resend/account-emails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("acknowledges a processed event", async () => {
    mocks.process.mockResolvedValue({ accepted: true, kind: "complaint", revokedAccounts: 1 });

    const response = await call();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      kind: "complaint",
      revokedAccounts: 1,
    });
  });

  it("answers 400 on an invalid signature", async () => {
    mocks.process.mockRejectedValue(failure("InvalidAccountEmailWebhookSignatureError"));

    const response = await call();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Signature webhook invalide." });
  });

  it("answers 413 on an oversized body", async () => {
    mocks.process.mockRejectedValue(failure("AccountEmailWebhookPayloadTooLargeError"));

    expect((await call()).status).toBe(413);
  });

  it("answers 500 on an internal failure, without echoing its message, so that Resend retries", async () => {
    mocks.process.mockRejectedValue(
      new Error("password authentication failed for user alice@example.test"),
    );

    const response = await call();
    const text = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("password");
  });
});

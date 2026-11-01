import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ handle: vi.fn() }));

vi.mock("@/lib/billing", () => ({ handleStripeWebhook: mocks.handle }));

import { POST } from "./route";

function post(headers: Record<string, string> = { "stripe-signature": "t=1,v1=abc" }) {
  return POST(
    new Request("https://immojudis.test/api/stripe/webhook", {
      method: "POST",
      body: '{"id":"evt_1"}',
      headers,
    }),
  );
}

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.handle.mockResolvedValue({ eventId: "evt_1", type: "x", handled: true });
  });

  it("acknowledges a handled event", async () => {
    const response = await post();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ received: true, eventId: "evt_1" });
    expect(mocks.handle).toHaveBeenCalledWith({
      payload: '{"id":"evt_1"}',
      signature: "t=1,v1=abc",
    });
  });

  it("answers 400 when the signature header is missing", async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it("answers 400 when Stripe rejects the signature", async () => {
    mocks.handle.mockRejectedValue(
      Object.assign(new Error("No signatures found matching the expected signature"), {
        type: "StripeSignatureVerificationError",
      }),
    );

    const response = await post();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("answers 500 on an internal failure so that Stripe retries", async () => {
    mocks.handle.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const response = await post();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("answers 500 even when the failure message looks like a business message", async () => {
    mocks.handle.mockRejectedValue(new Error("Impossible d'enregistrer l'événement."));

    const response = await post();

    expect(response.status).toBe(500);
  });

  it("answers 503 when the webhook is not configured", async () => {
    mocks.handle.mockRejectedValue(new Error("Stripe webhook non configuré."));

    const response = await post();

    expect(response.status).toBe(503);
  });

  it("keeps the retryable status of an event still being processed", async () => {
    mocks.handle.mockRejectedValue(new PublicApiError("Événement en cours de traitement.", 503));

    const response = await post();

    expect(response.status).toBe(503);
  });
});

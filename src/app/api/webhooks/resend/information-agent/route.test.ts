import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";

vi.mock("@/lib/information-agent-inbound", () => ({
  processInformationAgentInboundWebhook: vi.fn(),
}));

describe("information-agent inbound webhook route", () => {
  it("rejects invalid signatures before returning a successful receipt", async () => {
    const invalidSignature = new Error("Signature webhook invalide.");
    invalidSignature.name = "InvalidInformationAgentWebhookSignatureError";
    vi.mocked(processInformationAgentInboundWebhook).mockRejectedValueOnce(invalidSignature);

    const response = await POST(new Request("https://example.test/webhook", { method: "POST" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Signature webhook invalide." });
  });

  it("asks the provider to retry a processing failure", async () => {
    vi.mocked(processInformationAgentInboundWebhook).mockRejectedValueOnce(
      new Error("Webhook storage unavailable"),
    );

    const response = await POST(new Request("https://example.test/webhook", { method: "POST" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Réception email impossible." });
  });
});

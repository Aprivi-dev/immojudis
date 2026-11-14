import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: async () => ({ userId: "admin-1", isAdmin: true }),
}));
vi.mock("@/lib/contract-withdrawal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contract-withdrawal")>()),
  executeContractWithdrawal: mocks.execute,
}));

import { POST } from "./route";

const REQUEST_ID = "76000000-0000-4000-8000-000000000103";
const post = (body: unknown) =>
  POST(
    new Request("https://example.test/api/admin/privacy-requests/withdrawal", {
      method: "POST",
      headers: { authorization: "Bearer jeton-admin", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/**
 * Audit de l'administration du 14/11/2026 (D3) : la rétractation résilie l'abonnement Stripe et
 * rembourse. Comme l'effacement (`confirmEmail`), elle exige une confirmation explicite dans le
 * corps, envoyée par l'écran Conformité après la confirmation de l'administrateur.
 */
describe("POST /api/admin/privacy-requests/withdrawal", () => {
  beforeEach(() => {
    mocks.execute.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it.each([
    ["sans confirmation", { requestId: REQUEST_ID, refundMode: "prorata" }],
    ["avec une confirmation fausse", { requestId: REQUEST_ID, refundMode: "full", confirm: false }],
    [
      "avec une confirmation en texte",
      { requestId: REQUEST_ID, refundMode: "full", confirm: "oui" },
    ],
  ])("refuse en 400 une rétractation %s, sans rien exécuter", async (_case, body) => {
    expect((await post(body)).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("exécute la rétractation confirmée", async () => {
    mocks.execute.mockResolvedValue({ refundedCents: 1200, subscriptionCancelled: true });

    const response = await post({ requestId: REQUEST_ID, refundMode: "prorata", confirm: true });

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith({
      auth: expect.objectContaining({ userId: "admin-1", isAdmin: true }),
      input: { requestId: REQUEST_ID, refundMode: "prorata", confirm: true },
    });
  });
});

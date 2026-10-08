import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "./route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), rpc: vi.fn(), send: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: mocks.send }));

const saleId = "11111111-1111-4111-8111-111111111111";
const sendAction = {
  action: "approve_and_send",
  missionId: "22222222-2222-4222-8222-222222222222",
  approvalConfirmed: true,
  recipientEmail: "contact@example.test",
  subject: "Demande de précisions",
  bodyText: "Bonjour, pourriez-vous nous transmettre les pièces du dossier ?",
};

function request(method: string, payload?: unknown, authenticated = true) {
  return new Request("https://immojudis.test/api/admin/information-agent/missions", {
    method,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: "Bearer test-token" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("admin information request authorization", () => {
  it.each(["free", "premium"])("denies %s users every mission operation", async (tier) => {
    mocks.auth.mockResolvedValue({ isAdmin: false, accountTier: tier, userRole: "user" });
    const responses = await Promise.all([
      GET(request("GET")),
      POST(request("POST", { saleId })),
      PATCH(request("PATCH", sendAction)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("denies visitors before loading a sale or a mission", async () => {
    expect((await POST(request("POST", { saleId }, false))).status).toBe(401);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([false, undefined])("rejects send without explicit confirmation (%s)", async (value) => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const response = await PATCH(request("PATCH", { ...sendAction, approvalConfirmed: value }));
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

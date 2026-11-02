import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));

import {
  attestAdminInformationAgentRoundtrip,
  getAdminInformationAgentOperations,
} from "./admin-information-agent-operations";

const rawIndicators = {
  since: "2026-10-03T12:00:00Z",
  sent: 4,
  delivered: 4,
  delayed: 0,
  bounced_permanent: 0,
  bounced_temporary: 0,
  complained: 0,
  failed: 0,
  oppositions: 0,
  replies: 1,
  response_median_seconds: 7200,
  response_mean_seconds: 7200,
  unrouted_pending: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "information_agent_indicators"
      ? { data: rawIndicators, error: null }
      : { data: "2026-11-02T12:00:00Z", error: null },
  );
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq"]) query[name] = () => query;
  query.maybeSingle = async () => ({
    data: { inbound_roundtrip_verified_at: "2026-10-30T12:00:00Z" },
    error: null,
  });
  mocks.from.mockReturnValue(query);
});

describe("indicateurs d'exploitation de l'agent (serveur)", () => {
  it("lit les indicateurs des 30 derniers jours et la date de l'aller-retour", async () => {
    const view = await getAdminInformationAgentOperations(
      "token",
      new Date("2026-11-02T12:00:00Z"),
    );

    expect(mocks.rpc).toHaveBeenCalledWith("information_agent_indicators", {
      p_since: "2026-10-03T12:00:00.000Z",
      p_now: "2026-11-02T12:00:00.000Z",
    });
    expect(view.rows.find((row) => row.key === "replies")?.value).toBe("1 sur 4 (25 %)");
    expect(view.roundtrip).toMatchObject({ stale: false, verifiedAt: "2026-10-30T12:00:00Z" });
  });

  it("refuse un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });

    await expect(getAdminInformationAgentOperations("token")).rejects.toThrow(
      "accès administrateur",
    );
    await expect(attestAdminInformationAgentRoundtrip("token")).rejects.toThrow(
      "accès administrateur",
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("l'attestation passe l'identifiant de l'administrateur à la fonction de la base", async () => {
    await attestAdminInformationAgentRoundtrip("token");

    expect(mocks.rpc).toHaveBeenCalledWith("attest_information_agent_roundtrip", {
      p_admin_id: "admin-1",
    });
  });

  it("propage une erreur de la base : jamais d'indicateurs inventés", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getAdminInformationAgentOperations("token")).rejects.toMatchObject({
      code: "XX000",
    });
  });
});

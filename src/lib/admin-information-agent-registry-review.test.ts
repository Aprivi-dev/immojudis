import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * « Accepter et mettre à jour la fiche » (lot C, T4) : le fait de l'agent est accepté par le rôle de service,
 * puis la décision d'acceptation est écrite au registre des pièces avec le client de la SESSION (jeton de
 * l'administrateur), jamais avec le client de service.
 */
const mocks = vi.hoisted(() => ({
  fact: null as { fact_key: string; proposed_value: unknown } | null,
  claim: { id: "claim-1", auction_sale_id: "sale-1" } as {
    id: string;
    auction_sale_id: string;
  } | null,
  adminRpc: vi.fn(),
  sessionRpc: vi.fn(),
  claimFilters: [] as Array<[string, unknown]>,
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn(async () => ({
    isAdmin: true,
    userId: "admin-1",
    supabase: { rpc: mocks.sessionRpc },
  })),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.adminRpc,
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          if (table === "auction_fact_claims") mocks.claimFilters.push([column, value]);
          return query;
        },
        single: async () =>
          // Chemin des pièces jointes (stageApprovedEvidencePublication) : un fait ordinaire n'en est pas une.
          ({ data: { id: "fact-1", ...mocks.fact, status: "pending" }, error: null }),
        maybeSingle: async () =>
          table === "auction_fact_claims"
            ? { data: mocks.claim, error: null }
            : { data: mocks.fact, error: null },
      };
      return query;
    },
  },
}));

import { reviewAdminInformationAgentFact } from "@/lib/admin-information-agent";

const FACT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  mocks.fact = { fact_key: "surface_m2", proposed_value: { value: 54, unit: "m2" } };
  mocks.claim = { id: "claim-1", auction_sale_id: "sale-1" };
  mocks.claimFilters.length = 0;
  mocks.adminRpc.mockReset().mockResolvedValue({ data: { status: "accepted" }, error: null });
  mocks.sessionRpc.mockReset().mockResolvedValue({
    data: {
      claim_id: "claim-1",
      decision_id: "decision-1",
      decision: "accepted",
      sale_id: "sale-1",
      field_key: "property.surface_m2",
      state: "held",
    },
    error: null,
  });
});

describe("accepter une réponse d'avocat passe par le registre des pièces", () => {
  it("accepte le fait, puis décide au registre avec le jeton de l'administrateur", async () => {
    const response = await reviewAdminInformationAgentFact({
      authToken: "token",
      input: { factId: FACT_ID, decision: "accepted", lotAttachment: "single_lot" },
    });

    expect(mocks.adminRpc).toHaveBeenCalledWith("review_information_agent_fact_candidate", {
      p_reviewer_id: "admin-1",
      p_fact_id: FACT_ID,
      p_decision: "accepted",
      p_notes: null,
    });
    // L'observation est celle que le pont a créée pour CE fait.
    expect(mocks.claimFilters).toContainEqual([
      "evidence_locator->>information_agent_fact_id",
      FACT_ID,
    ]);
    expect(mocks.sessionRpc).toHaveBeenCalledWith("accept_auction_fact_claim", {
      p_claim_id: "claim-1",
      p_lot_attachment: "single_lot",
      p_lot_ref: undefined,
      p_supersedes_decision_id: undefined,
    });
    // La décision n'est jamais écrite par le rôle de service, qui n'a pas d'auteur.
    expect(mocks.adminRpc.mock.calls.map(([name]) => name)).not.toContain(
      "accept_auction_fact_claim",
    );
    // Le fait est accepté avant la décision : l'observation n'existe qu'après lui.
    expect(mocks.adminRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sessionRpc.mock.invocationCallOrder[0]!,
    );
    expect(response.registry).toEqual({
      claimId: "claim-1",
      saleId: "sale-1",
      state: "held",
      error: null,
    });
  });

  it("exige le rattachement au lot avant toute écriture", async () => {
    await expect(
      reviewAdminInformationAgentFact({
        authToken: "token",
        input: { factId: FACT_ID, decision: "accepted" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.sessionRpc).not.toHaveBeenCalled();
  });

  it.each(["owner_occupied", "squatted"])(
    "refuse l'occupation « %s » avec un message clair, sans rien écrire",
    async (value) => {
      mocks.fact = { fact_key: "occupancy_status", proposed_value: { value } };
      await expect(
        reviewAdminInformationAgentFact({
          authToken: "token",
          input: { factId: FACT_ID, decision: "accepted", lotAttachment: "single_lot" },
        }),
      ).rejects.toMatchObject({
        status: 409,
        message:
          "Occupation non affichable : la fiche ne dit que « libre », « occupé » ou « loué », jamais qui occupe ni pourquoi. Rejetez cette information.",
      });
      expect(mocks.adminRpc).not.toHaveBeenCalled();
      expect(mocks.sessionRpc).not.toHaveBeenCalled();
    },
  );

  it("décision refusée par le registre : le fait reste accepté, la réponse le dit sans échouer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.sessionRpc.mockResolvedValue({
      data: null,
      error: { code: "55P03", message: "sale_busy" },
    });

    const response = await reviewAdminInformationAgentFact({
      authToken: "token",
      input: { factId: FACT_ID, decision: "accepted", lotAttachment: "matched" },
    });

    expect(response.ok).toBe(true);
    expect(response.registry).toEqual({
      claimId: "claim-1",
      saleId: "sale-1",
      state: null,
      error: "Import en cours sur cette vente, réessayez dans une minute.",
    });
  });

  it("un rejet ou un fait hors registre ne décide rien au registre", async () => {
    await reviewAdminInformationAgentFact({
      authToken: "token",
      input: { factId: FACT_ID, decision: "rejected", notes: "Hors lot" },
    });
    mocks.fact = { fact_key: "visit_information", proposed_value: { value: "Visite le 20" } };
    const visit = await reviewAdminInformationAgentFact({
      authToken: "token",
      input: { factId: FACT_ID, decision: "accepted" },
    });

    expect(mocks.adminRpc).toHaveBeenCalledTimes(2);
    expect(mocks.sessionRpc).not.toHaveBeenCalled();
    expect(visit.registry).toBeNull();
  });
});

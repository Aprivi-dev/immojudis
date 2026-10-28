import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  availability: vi.fn(),
  searchEnabled: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn(async () => ({ isAdmin: true })),
}));
vi.mock("@/lib/admin-information-agent-sale", () => ({
  loadAdminInformationAgentEmailAvailability: mocks.availability,
}));
vi.mock("@/lib/information-agent/address-search", () => ({
  isInformationAgentAddressSearchEnabled: mocks.searchEnabled,
}));

import { getAdminCatalogueReadinessOverview } from "./admin-catalogue-readiness";
import { INFORMATION_AGENT_NO_EMAIL_MESSAGE } from "./information-agent/email-address";

const withEmailId = "11111111-1111-4111-8111-111111111111";
const phoneOnlyId = "22222222-2222-4222-8222-222222222222";

function queueRow(id: string) {
  return {
    id,
    title: `Vente ${id.slice(0, 4)}`,
    city: "Bordeaux",
    department: "33",
    sale_date: "2026-11-10T10:00:00Z",
    source_name: "licitor",
    premium_readiness_score: 40,
    premium_readiness_status: "needs_enrichment",
    premium_readiness_policy_version: "v1",
    premium_readiness_factors: {},
    premium_readiness_blockers: [],
    premium_readiness_missing_fields: [],
    premium_readiness_evaluated_at: "2026-10-08T08:00:00Z",
    premium_readiness_override: null,
    premium_readiness_override_reason: null,
    premium_readiness_override_expires_at: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  const policy = {
    enforcement_enabled: false,
    policy_version: "v1",
    premium_ready_min: 70,
    minimum_score_confidence: "0.8",
    updated_at: "2026-10-08T08:00:00Z",
  };
  mocks.from.mockImplementation((table: string) => {
    const result = {
      data:
        table === "catalogue_readiness_policy"
          ? policy
          : table === "v_auction_sales_app"
            ? [
                { id: withEmailId, lawyer_name: "Me A", lawyer_contact: "a@cabinet-a.test" },
                { id: phoneOnlyId, lawyer_name: "Me B", lawyer_contact: "Tél. : 05 56 00 00 01" },
              ]
            : [queueRow(withEmailId), queueRow(phoneOnlyId)],
      error: null,
      count: 2,
    };
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "or", "order", "range", "neq"]) {
      query[name] = () => query;
    }
    query.single = async () => result;
    query.then = (resolve: (value: typeof result) => unknown) =>
      Promise.resolve(result).then(resolve);
    return query;
  });
  mocks.searchEnabled.mockReturnValue(false);
  mocks.availability.mockResolvedValue(
    new Map([
      [withEmailId, true],
      [phoneOnlyId, false],
    ]),
  );
});

describe("file d'enrichissement : brouillon de l'agent d'information", () => {
  it("donne le motif aux ventes sans adresse email connue, et seulement à elles", async () => {
    const overview = await getAdminCatalogueReadinessOverview("token");

    expect(mocks.availability).toHaveBeenCalledWith([withEmailId, phoneOnlyId]);
    const byId = Object.fromEntries(overview.items.map((item) => [item.id, item]));
    expect(byId[withEmailId]?.informationAgentBlockedReason).toBeNull();
    expect(byId[phoneOnlyId]?.informationAgentBlockedReason).toBe(
      INFORMATION_AGENT_NO_EMAIL_MESSAGE,
    );
  });

  it("n'écarte aucune vente d'avance tant que la recherche automatique d'adresse est active", async () => {
    mocks.searchEnabled.mockReturnValue(true);

    const overview = await getAdminCatalogueReadinessOverview("token");

    expect(overview.items.map((item) => item.informationAgentBlockedReason)).toEqual([null, null]);
  });
});

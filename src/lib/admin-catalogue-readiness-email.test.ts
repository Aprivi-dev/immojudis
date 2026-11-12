import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  classify: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: vi.fn(async () => ({ isAdmin: true })),
}));
vi.mock("@/lib/admin-information-agent-sale", () => ({
  classifyInformationAgentSaleContacts: mocks.classify,
}));

import {
  getAdminCatalogueReadinessOverview,
  impossibleContactReason,
} from "./admin-catalogue-readiness";

const lawyerId = "11111111-1111-4111-8111-111111111111";
const greffeId = "22222222-2222-4222-8222-222222222222";
const toConfirmId = "33333333-3333-4333-8333-333333333333";
const sqlOnlyId = "44444444-4444-4444-8444-444444444444";
const phoneId = "55555555-5555-4555-8555-555555555555";
const nameId = "66666666-6666-4666-8666-666666666666";
const emptyId = "77777777-7777-4777-8777-777777777777";

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

const ALL = [lawyerId, greffeId, toConfirmId, sqlOnlyId, phoneId, nameId, emptyId];
const CONTACTS = [
  { id: lawyerId, lawyer_name: "Me A", lawyer_contact: "a@cabinet-a.test" },
  { id: phoneId, lawyer_name: "Me B", lawyer_contact: "Tél. : 05 56 00 00 01" },
  { id: nameId, lawyer_name: "Me C", lawyer_contact: null },
  { id: emptyId, lawyer_name: null, lawyer_contact: null },
];

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
    let requested: string[] = [];
    const query: Record<string, unknown> = {};
    for (const name of ["select", "eq", "or", "order", "range", "neq"]) query[name] = () => query;
    query.in = (_column: string, ids: string[]) => {
      requested = ids;
      return query;
    };
    const result = () => ({
      data:
        table === "catalogue_readiness_policy"
          ? policy
          : table === "v_auction_sales_app"
            ? CONTACTS.filter((contact) => requested.includes(contact.id))
            : ALL.filter((id) => requested.includes(id)).map(queueRow),
      error: null,
      count: 0,
    });
    query.single = async () => result();
    query.then = (resolve: (value: ReturnType<typeof result>) => unknown) =>
      Promise.resolve(result()).then(resolve);
    return query;
  });
  mocks.rpc.mockResolvedValue({
    data: {
      counts: { A: 2, B: 1, C: 1, D: 3 },
      total: 4,
      items: [
        { id: lawyerId, class: "A" },
        { id: greffeId, class: "C" },
        { id: toConfirmId, class: "B" },
        { id: sqlOnlyId, class: "A" },
      ],
      impossible: [phoneId, nameId, emptyId],
    },
    error: null,
  });
  mocks.classify.mockResolvedValue(
    new Map([
      [lawyerId, "A"],
      [greffeId, "C"],
      [toConfirmId, "B"],
      // Classé A par l'approximation SQL, mais le résolveur exact ne trouve aucun contact.
      [sqlOnlyId, "D"],
    ]),
  );
});

describe("file d'enrichissement : file de travail de l'agent d'information", () => {
  it("filtre avant la pagination : la page demandée est transmise à la RPC", async () => {
    await getAdminCatalogueReadinessOverview("token", { offset: 50, limit: 25 });

    expect(mocks.rpc).toHaveBeenCalledWith("admin_information_agent_queue", {
      p_limit: 25,
      p_offset: 50,
    });
  });

  it("montre A, C puis B dans l'ordre de la RPC et vérifie exactement la page affichée", async () => {
    const overview = await getAdminCatalogueReadinessOverview("token");

    expect(mocks.classify).toHaveBeenCalledWith([lawyerId, greffeId, toConfirmId, sqlOnlyId]);
    expect(overview.items.map((item) => [item.id, item.contactClass])).toEqual([
      [lawyerId, "A"],
      [greffeId, "C"],
      [toConfirmId, "B"],
    ]);
    expect(overview.items.every((item) => item.informationAgentBlockedReason === null)).toBe(true);
    expect(overview).toMatchObject({ total: 4, offset: 0, limit: 50, hasMore: false });
    expect(overview.classCounts).toEqual({ A: 2, B: 1, C: 1, D: 3 });
  });

  it("range sous « contact impossible » une vente que la vérification exacte écarte, avec son motif", async () => {
    const overview = await getAdminCatalogueReadinessOverview("token");

    const byId = Object.fromEntries(
      (overview.impossibleItems ?? []).map((item) => [item.id, item]),
    );
    expect(Object.keys(byId).sort()).toEqual([sqlOnlyId, phoneId, nameId, emptyId].sort());
    expect(byId[phoneId]?.informationAgentBlockedReason).toBe(
      "Téléphone seul : aucune adresse email dans l’annonce.",
    );
    expect(byId[nameId]?.informationAgentBlockedReason).toContain("Nom seul");
    expect(byId[emptyId]?.informationAgentBlockedReason).toBe("Aucune coordonnée dans l’annonce.");
    expect(byId[phoneId]?.contactClass).toBe("D");
  });

  it("ne dépend plus de la recherche automatique d'adresse", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
    const overview = await getAdminCatalogueReadinessOverview("token");
    vi.unstubAllEnvs();

    expect(overview.impossibleItems?.map((item) => item.id)).toContain(phoneId);
    expect(overview.items.map((item) => item.id)).not.toContain(phoneId);
  });

  it("propage l'erreur de la RPC : jamais de file vide silencieuse", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(getAdminCatalogueReadinessOverview("token")).rejects.toMatchObject({
      code: "XX000",
    });
  });
});

describe("motif d'un contact impossible", () => {
  it.each([
    [{ lawyer_name: "Me B", lawyer_contact: "05 56 00 00 01" }, "Téléphone seul"],
    [{ lawyer_name: "Me C", lawyer_contact: null }, "Nom seul"],
    [{ lawyer_name: null, lawyer_contact: "Cabinet Dupont" }, "Nom seul"],
    [{ lawyer_name: null, lawyer_contact: null }, "Aucune coordonnée"],
    [undefined, "Aucune coordonnée"],
  ])("%j", (contact, expected) => {
    expect(impossibleContactReason(contact)).toContain(expected);
  });
});

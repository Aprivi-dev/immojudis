import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminInformationAgentDraft } from "@/lib/information-agent";
import { DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE } from "@/lib/information-agent-email-template";
import type { AuctionSale } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  sale: vi.fn(),
  template: vi.fn(),
  claims: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/admin-information-agent-sale", () => ({
  loadAdminInformationAgentSale: mocks.sale,
}));
vi.mock("@/lib/admin-information-agent-email-template", () => ({
  getPublishedInformationAgentEmailTemplate: mocks.template,
}));
vi.mock("@/lib/auction-fact-claims", () => ({ readSaleFactClaims: mocks.claims }));
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: mocks.send }));

const saleId = "11111111-1111-4111-8111-111111111111";
const admin = { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never;
let inserted: Record<string, unknown> | null;
let observed: Array<Record<string, unknown>>;
let opposedIdentityKeys: string[];
let listed: Record<string, Array<Record<string, unknown>>>;
let updates: Array<{ table: string; values: Record<string, unknown> }>;

beforeEach(() => {
  vi.resetAllMocks();
  inserted = null;
  observed = [];
  opposedIdentityKeys = [];
  listed = {};
  updates = [];
  mocks.sale.mockResolvedValue({
    id: saleId,
    title: "Appartement Bordeaux",
    property_type: "apartment",
    address: "12 rue du Palais",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    postal_code: "33000",
    sale_date: null,
    starting_price_eur: null,
    lawyer_name: "Maître Jean Dupont",
    lawyer_contact: "cabinet@example.test",
  } as AuctionSale);
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    const result = () => ({
      data:
        table === "information_agent_missions"
          ? {
              id: "22222222-2222-4222-8222-222222222222",
              status: "draft",
              case_id: null,
              ...inserted,
            }
          : table === "information_agent_identity_oppositions"
            ? opposedIdentityKeys.map((identity_key) => ({ identity_key }))
            : [],
      error: null,
    });
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      in: () => query,
      ilike: () => query,
      gte: () => query,
      neq: () => query,
      overlaps: () => query,
      update: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return query;
      },
      // Lists (recent solicitations, sent cases): none by default.
      limit: () => Promise.resolve({ data: listed[table] ?? [], error: null }),
      upsert: (values: unknown) => {
        if (table === "information_agent_contacts") {
          observed = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
        }
        return query;
      },
      insert: (values: Record<string, unknown>) => {
        inserted = values;
        return query;
      },
      single: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return query;
  });
});

describe("manual admin draft preparation", () => {
  it("prepares a complete targeted draft from only a sale id without approving or sending", async () => {
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission).toMatchObject({
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Jean Dupont",
      status: "draft",
    });
    expect(result.mission.bodyText).toContain("12 rue du Palais");
    expect(result.mission.bodyText).toContain("vérifier avec vous quelques points de la fiche");
    expect(result.mission.bodyText).not.toContain("service indépendant");
    expect(result.mission.bodyText).not.toContain("compte professionnel");
    expect(result.mission.bodyText).not.toContain("mode=professional");
    expect(result.mission.bodyText).toContain("confirmer la date");
    expect(result.mission.questionKeys).toHaveLength(4);
    expect(
      result.mission.questionKeys.every((key) => result.gaps.some((gap) => gap.key === key)),
    ).toBe(true);
    expect(inserted).toMatchObject({ share_requester_email: false });
    // L'adresse observée dans l'annonce est enregistrée avec sa source typée et sa date.
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      email: "cabinet@example.test",
      source_kind: "sale_listing",
      observed_by: "agent",
      identity_keys: ["lawyer|bordeaux|dupont jean"],
    });
    expect(observed[0]?.observed_at).toEqual(expect.any(String));
    // Le brouillon garde les clés d'identité (jamais l'adresse) pour le contrôle avant envoi.
    expect(inserted).toMatchObject({ recipient_identity_keys: ["lawyer|bordeaux|dupont jean"] });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("subscribe_information_agent_mission", {
      p_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_mission_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("never addresses a manual contact by an unrelated lawyer's name", async () => {
    const result = await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, recipientEmail: "notaire@example.test" },
    });
    expect(result.mission.recipientName).toBeNull();
    expect(result.mission.bodyText).toContain("Madame, Monsieur,");
    expect(result.mission.bodyText).not.toContain("Maître Jean Dupont");
  });

  it.each([null, "premier@example.test et second@example.test"])(
    "requires a manual choice when a recipient cannot be reliably selected (%s)",
    async (contact) => {
      const sale = await mocks.sale();
      mocks.sale.mockResolvedValue({ ...sale, lawyer_contact: contact });
      await expect(
        createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
      ).rejects.toThrow("Requête invalide");
      expect(inserted).toBeNull();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it("ne retient ni ne stocke l'adresse d'un professionnel opposé sous une autre adresse", async () => {
    opposedIdentityKeys = ["lawyer|bordeaux|dupont jean"];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("s'est opposé à être contacté");
    expect(observed).toEqual([]);
    expect(inserted).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuse une adresse saisie à la main pour un professionnel opposé", async () => {
    opposedIdentityKeys = ["lawyer|bordeaux|dupont jean"];
    await expect(
      createAdminInformationAgentDraft({
        auth: admin,
        input: {
          saleId,
          recipientEmail: "autre-adresse@example.test",
          recipientName: "Me Jean Dupont",
        },
      }),
    ).rejects.toThrow("s'est opposé à être contacté");
    expect(inserted).toBeNull();
  });

  it("refuse une adresse de juridiction, de RPVA, de l'Ordre ou technique saisie à la main", async () => {
    for (const recipientEmail of [
      "greffe@tj-bordeaux.justice.fr",
      "me.dupont@avocat-conseil.fr",
      "contact@ordre-avocats-bordeaux.test",
      "noreply@cabinet.example.test",
    ]) {
      await expect(
        createAdminInformationAgentDraft({ auth: admin, input: { saleId, recipientEmail } }),
      ).rejects.toThrow("n’est jamais sollicitée par l’agent");
    }
    expect(inserted).toBeNull();
  });

  it("refuse un nouveau brouillon quand la vente a déjà été sollicitée à cette adresse", async () => {
    listed.information_agent_cases = [
      { status: "sent", sent_at: "2026-10-02T09:00:00.000Z", created_at: "2026-10-01T09:00:00Z" },
    ];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("déjà été sollicité pour cette vente le 02/10/2026");
    expect(inserted).toBeNull();
  });

  it("refuse dès le brouillon un destinataire sollicité depuis moins de 30 jours", async () => {
    listed.information_agent_missions = [{ id: "other", approved_at: new Date().toISOString() }];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("Prochain envoi possible à partir du");
    expect(inserted).toBeNull();
  });

  it("annule l'ancien brouillon de la même vente et de la même adresse quand il est régénéré", async () => {
    await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(updates).toContainEqual({
      table: "information_agent_missions",
      values: expect.objectContaining({ status: "cancelled" }),
    });
  });
});

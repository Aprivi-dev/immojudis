import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminInformationAgentDraft } from "@/lib/information-agent/draft";
import { informationAgentCreateSchema } from "@/lib/information-agent/schemas";
import { INFORMATION_AGENT_NO_EMAIL_MESSAGE } from "@/lib/information-agent/email-address";
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
    // Vente au tribunal : `lawyer_contact` y porte l'avocat poursuivant.
    sale_procedure: { organizer_type: "pursuing_lawyer" },
  } as unknown as AuctionSale);
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    // Comme en base : seules les clés d'opposition demandées sont rendues.
    let requested: unknown[] | null = null;
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
            ? opposedIdentityKeys
                .filter((key) => requested?.includes(key))
                .map((identity_key) => ({ identity_key }))
            : [],
      error: null,
    });
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      in: (_column: string, values: unknown[]) => {
        requested = values;
        return query;
      },
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
      // Adresse générique : elle porte aussi la clé de sa structure (domaine propre du cabinet).
      identity_keys: ["lawyer|bordeaux|dupont jean", "structure|domain|example.test"],
    });
    expect(observed[0]?.observed_at).toEqual(expect.any(String));
    // Le brouillon garde les clés d'identité (jamais l'adresse) pour le contrôle avant envoi.
    expect(inserted).toMatchObject({
      recipient_identity_keys: ["lawyer|bordeaux|dupont jean", "structure|domain|example.test"],
    });
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

  it("requires a manual choice when several recipients are possible", async () => {
    const sale = await mocks.sale();
    mocks.sale.mockResolvedValue({
      ...sale,
      lawyer_contact: "premier@example.test et second@example.test",
    });
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("Requête invalide");
    expect(inserted).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  // L'agent ne fonctionne que par email : ni brouillon, ni mission, ni dossier sans adresse valide.
  it.each([
    ["aucun contact", null, null],
    ["un champ vide", "   ", ""],
    ["un téléphone seul", "Tél. : 05 56 00 00 01", "Tél. : 05 56 00 00 01"],
    ["un nom seul", "Maître Jean Dupont", "Maître Jean Dupont"],
    ["une adresse sans domaine", "cabinet@", "cabinet@"],
  ])("refuse de préparer un brouillon quand le contact est %s", async (_label, contact, name) => {
    const sale = await mocks.sale();
    mocks.sale.mockResolvedValue({ ...sale, lawyer_contact: contact, lawyer_name: name });
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow(INFORMATION_AGENT_NO_EMAIL_MESSAGE);
    expect(observed).toEqual([]);
    expect(inserted).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("le schéma de création refuse un téléphone, un nom ou un champ vide comme destinataire", () => {
    for (const recipientEmail of ["05 56 00 00 01", "Maître Jean Dupont", "jean@dupont", ""]) {
      expect(informationAgentCreateSchema.safeParse({ saleId, recipientEmail }).success).toBe(
        false,
      );
    }
    expect(informationAgentCreateSchema.safeParse({ saleId }).success).toBe(true);
  });

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

describe("brouillon pour un notaire lu dans l'annonce", () => {
  const listingUrl = "https://annonces.example.test/notaires/vente-1";
  const notarySale = {
    id: saleId,
    title: "Maison Bordeaux",
    property_type: "house",
    address: "3 rue des Vignes",
    city: "Bordeaux",
    tribunal: null,
    postal_code: "33000",
    sale_date: null,
    starting_price_eur: null,
    lawyer_name: null,
    lawyer_contact: "jean.martin@example.test",
    source_name: "notaires",
    source_url: listingUrl,
    information_agent_organizer_type: "notary",
    listing_contact_blocks: [
      {
        sourceName: "notaires",
        sourceUrl: listingUrl,
        officeCode: "33001",
        contact: [
          {
            email: "jean.martin@example.test",
            name: "Jean Martin",
            field: "source_property_features.contact.email",
            principal: true,
            addressKind: "nominative",
          },
        ],
        manager: [],
        lawyer: [],
      },
    ],
  };

  beforeEach(() => {
    mocks.sale.mockResolvedValue(notarySale as never);
  });

  it("prépare un brouillon au notaire, avec les seules questions admises, sans rien envoyer", async () => {
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission).toMatchObject({
      recipientEmail: "jean.martin@example.test",
      recipientName: "Jean Martin",
      recipientKind: "source_contact",
      status: "draft",
      recipientProfile: {
        roleLabel: "Notaire",
        addressKind: "nominative",
        originLabel: "Adresse publiée dans l’annonce",
        originSourceName: "notaires",
        originUrl: listingUrl,
      },
    });
    const allowed = ["surface", "composition", "occupancy", "visit", "documents"];
    expect(result.mission.questionKeys.length).toBeGreaterThan(0);
    for (const key of result.mission.questionKeys) expect(allowed).toContain(key);
    // Les lacunes de date et de mise à prix existent, mais ne sont pas demandées à un notaire.
    expect(result.gaps.map((gap) => gap.key)).toEqual(
      expect.arrayContaining(["sale_date", "starting_price_eur"]),
    );
    const questions = result.mission.bodyText
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .join("\n");
    expect(questions).not.toBe("");
    expect(questions).not.toMatch(
      /mise à prix|garantie|audience|date de la vente|loyer|transmettre/i,
    );
    // Texte propre au notaire : ni pièces de procédure, ni invitation à joindre des documents.
    const message = `${result.mission.subject}\n${result.mission.bodyText}`;
    expect(message).toContain(
      "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats acquéreurs : celles de l’annonce et du cahier des charges. Ne nous transmettez rien d’autre : votre secret professionnel prime sur notre demande.",
    );
    expect(message).not.toMatch(
      /cahier des conditions de vente|procès-verbal descriptif|garantie|audience|documents ou photos|joindre|mise à prix/i,
    );
    expect(result.mission.subject).toBe("Maison Bordeaux : vérification de l’annonce");
    expect(inserted).toMatchObject({
      recipient_kind: "source_contact",
      // Adresse nominative : la clé de la structure n'est pas parmi ses clés d'identité.
      recipient_identity_keys: ["notary|bordeaux|jean martin"],
      metadata: {
        contact_identity: { role: "notary", structure_kind: "notary_office", office_code: "33001" },
        question_audience: "notary",
      },
    });
    expect(observed[0]).toMatchObject({
      email: "jean.martin@example.test",
      role: "notary",
      source_kind: "sale_listing",
      source_url: listingUrl,
      metadata: {
        structure_kind: "notary_office",
        address_kind: "nominative",
        office_code: "33001",
      },
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "subscribe_information_agent_mission",
      expect.anything(),
    );
  });

  it("refuse une question hors liste choisie par l'administrateur, sans la retirer en silence", async () => {
    await expect(
      createAdminInformationAgentDraft({
        auth: admin,
        input: { saleId, questionKeys: ["surface", "sale_terms"] },
      }),
    ).rejects.toThrow("l'agent ne demande que la surface");
    expect(inserted).toBeNull();
  });

  it("ne retient aucune adresse d'un office qui s'est opposé", async () => {
    opposedIdentityKeys = ["structure|office|33001"];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("Cette structure (cabinet, office ou service) s'est opposée");
    expect(observed).toEqual([]);
    expect(inserted).toBeNull();
  });

  it("occupation demandée à un notaire : selon l'annonce ou le cahier des charges, sans le loyer", async () => {
    const result = await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, questionKeys: ["occupancy", "documents"] },
    });
    expect(result.mission.bodyText).toContain(
      "- Selon l’annonce ou le cahier des charges, le bien est-il libre, occupé ou loué ?",
    );
    expect(result.mission.bodyText).toContain(
      "- Où et comment le cahier des charges de la vente peut-il être consulté",
    );
    expect(result.mission.bodyText).not.toMatch(/loyer|cahier des conditions de vente/i);
  });

  it("vente notariale, adresse saisie par l'administrateur : la liste courte s'applique par défaut", async () => {
    const result = await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, recipientEmail: "autre.adresse@example.test" },
    });
    const allowed = ["surface", "composition", "occupancy", "visit", "documents"];
    expect(result.mission.questionKeys.length).toBeGreaterThan(0);
    for (const key of result.mission.questionKeys) expect(allowed).toContain(key);
    expect(inserted).toMatchObject({
      recipient_kind: "manual_professional",
      metadata: { contact_identity: { role: null }, question_audience: "notary" },
    });
    expect(result.mission.bodyText).toContain("votre secret professionnel prime sur notre demande");
    await expect(
      createAdminInformationAgentDraft({
        auth: admin,
        input: {
          saleId,
          recipientEmail: "autre.adresse@example.test",
          questionKeys: ["sale_date"],
        },
      }),
    ).rejects.toThrow("l'agent ne demande que la surface");
  });

  it("source `notaires` sans organisateur déclaré, adresse saisie : la source donne la liste courte", async () => {
    mocks.sale.mockResolvedValue({
      ...notarySale,
      lawyer_contact: null,
      information_agent_organizer_type: undefined,
      sale_procedure: null,
      listing_contact_blocks: [],
    } as never);
    const result = await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, recipientEmail: "autre.adresse@example.test" },
    });
    const allowed = ["surface", "composition", "occupancy", "visit", "documents"];
    for (const key of result.mission.questionKeys) expect(allowed).toContain(key);
    expect(inserted).toMatchObject({
      recipient_kind: "manual_professional",
      metadata: { contact_identity: { role: null }, question_audience: "notary" },
    });
    expect(result.mission.bodyText).toContain("votre secret professionnel prime sur notre demande");
  });

  it("office opposé : une adresse saisie sur le domaine partagé garde l'office de la vente et est refusée", async () => {
    opposedIdentityKeys = ["structure|office|33001"];
    inserted = null;
    await expect(
      createAdminInformationAgentDraft({
        auth: admin,
        input: { saleId, recipientEmail: "autre.notaire@exemple-fictif.notaires.fr" },
      }),
    ).rejects.toThrow("Cette structure (cabinet, office ou service) s'est opposée");
    expect(inserted).toBeNull();
  });

  it("service de l'État d'une cession : son propre texte, la liste courte", async () => {
    const listing = "https://annonces.example.test/cessions/bien-2";
    mocks.sale.mockResolvedValue({
      ...notarySale,
      lawyer_contact: null,
      source_name: "cessions_etat",
      source_url: listing,
      information_agent_organizer_type: "state_service",
      listing_contact_blocks: [
        {
          sourceName: "cessions_etat",
          sourceUrl: listing,
          officeCode: null,
          contact: [],
          lawyer: [],
          manager: [
            {
              email: "pgp.domaine@example.test",
              name: null,
              field: "source_property_features.manager.direction_email",
              principal: true,
              addressKind: "generic",
            },
          ],
        },
      ],
    } as never);
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission.recipientEmail).toBe("pgp.domaine@example.test");
    expect(result.mission.bodyText).toContain(
      "Répondre est facultatif. Nous ne demandons que des informations déjà destinées aux candidats à l’acquisition. Les règles de votre administration priment sur notre demande.",
    );
    expect(result.mission.bodyText).not.toContain("secret professionnel");
    expect(inserted).toMatchObject({
      // Adresse générique sur un domaine propre : elle porte la clé de sa structure.
      recipient_identity_keys: ["structure|domain|example.test"],
      metadata: {
        contact_identity: {
          role: "organizer",
          structure_kind: "state_service",
          address_kind: "generic",
        },
        question_audience: "state_service",
      },
    });
  });
});

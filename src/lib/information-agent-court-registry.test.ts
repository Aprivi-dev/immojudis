import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminInformationAgentDraft,
  previewAdminInformationAgentMission,
  runAdminInformationAgentAction,
  informationAgentPreviewFingerprint,
} from "@/lib/information-agent";
import { assertInformationAgentContactAllowed } from "@/lib/information-agent/contacts";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import {
  assertCourtRegistryFallbackLimits,
  courtRegistryFallbackOfMission,
  startOfParisDay,
} from "@/lib/information-agent/court-registry";
import {
  courtRegistryDailyCap,
  COURT_REGISTRY_DAILY_CAP_DEFAULT,
} from "@/lib/information-agent/court-registry-fallback";
import {
  COURT_REGISTRY_EMAIL_TEMPLATE,
  COURT_REGISTRY_QUESTION,
} from "@/lib/information-agent/court-registry-template";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";
import { assertNoInformationAgentCommercialMention } from "@/lib/information-agent-commercial-guard";
import {
  informationAgentAddressOrigin,
  informationAgentLegalFooterLines,
  type informationAgentLegalFooterSections,
} from "@/lib/information-agent-compliance";
import type { AuctionSale } from "@/lib/types";

/**
 * Greffe de secours : une vente au tribunal sans aucun avocat ni cabinet exploitable peut donner lieu à
 * une demande au greffe de SON tribunal (adresse du référentiel), avec un message adapté, et à cette
 * seule condition. La base, l'envoi et la lecture des sites sont simulés ; aucun réseau.
 */

type Filter = [string, string, unknown];
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sale: vi.fn(),
  template: vi.fn(),
  claims: vi.fn(),
  send: vi.fn(),
}));
const db = vi.hoisted(() => ({
  court: null as { court_code: string; name: string; emails: string[] } | null,
  contacts: [] as Array<Record<string, unknown>>,
  identityOppositions: [] as Array<Record<string, unknown>>,
  courtMissionsForSale: [] as Array<Record<string, unknown>>,
  courtMissionsToday: [] as Array<Record<string, unknown>>,
  courtMissionsUnverified: [] as Array<Record<string, unknown>>,
  cooldownMissions: [] as Array<Record<string, unknown>>,
  mission: null as Record<string, unknown> | null,
  inserted: null as Record<string, unknown> | null,
  observed: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  courtQueries: [] as Filter[][],
  writes: [] as Array<[string, string, unknown]>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Filter[] = [];
    private patch: Record<string, unknown> | null = null;
    constructor(private readonly table: string) {}
    // Seule la mission visée par son identifiant est modifiée (pas les brouillons remplacés).
    private applyPatch() {
      const targeted = this.filters.some(([op, column]) => op === "eq" && column === "id");
      if (this.patch && targeted && this.table === "information_agent_missions" && db.mission) {
        Object.assign(db.mission, this.patch);
      }
    }
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push(["eq", column, value]);
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push(["is", column, value]);
      return this;
    }
    in(column: string, value: unknown) {
      this.filters.push(["in", column, value]);
      return this;
    }
    neq(column: string, value: unknown) {
      this.filters.push(["neq", column, value]);
      return this;
    }
    gte(column: string, value: unknown) {
      this.filters.push(["gte", column, value]);
      return this;
    }
    lte(column: string, value: unknown) {
      this.filters.push(["lte", column, value]);
      return this;
    }
    ilike() {
      return this;
    }
    overlaps() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    upsert(values: unknown) {
      if (this.table === "information_agent_contacts") {
        db.observed.push(...((Array.isArray(values) ? values : [values]) as never[]));
      }
      return this;
    }
    update(values: Record<string, unknown>) {
      db.writes.push([this.table, "update", values]);
      this.patch = values;
      return this;
    }
    insert(values: Record<string, unknown>) {
      if (this.table === "information_agent_missions") {
        db.inserted = values;
        db.mission = {
          id: "22222222-2222-4222-8222-222222222222",
          user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          status: "draft",
          case_id: "33333333-3333-4333-8333-333333333333",
          created_at: "2026-10-14T12:00:00.000Z",
          ...values,
        };
      }
      if (this.table === "information_agent_messages") db.messages.push(values);
      return this;
    }
    async single() {
      this.applyPatch();
      return { data: db.mission ? { ...db.mission } : null, error: null };
    }
    async maybeSingle() {
      if (this.table === "court_registry_contacts") return { data: db.court, error: null };
      return {
        data:
          this.table === "auction_sales"
            ? { status: "active", sale_date: null, starting_price_eur: null }
            : null,
        error: null,
      };
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      this.applyPatch();
      let data: unknown[] = [];
      if (this.table === "information_agent_contacts") {
        data = db.contacts.filter((row) =>
          this.filters.every(([, column, value]) => (row[column] ?? null) === value),
        );
      } else if (this.table === "information_agent_identity_oppositions") {
        data = db.identityOppositions;
      } else if (
        this.table === "information_agent_missions" &&
        this.filters.some(
          ([, column]) => column === "metadata->court_registry_fallback->>court_code",
        )
      ) {
        db.courtQueries.push(this.filters);
        const has = (column: string) => this.filters.some(([, name]) => name === column);
        data =
          has("status") && this.filters.some(([, , value]) => value === "failed")
            ? db.courtMissionsUnverified
            : has("sale_id")
              ? db.courtMissionsForSale
              : db.courtMissionsToday;
      } else if (this.table === "information_agent_missions") {
        data = db.cooldownMissions;
      }
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table), rpc: mocks.rpc } };
});
vi.mock("@/lib/admin-information-agent-sale", () => ({
  loadAdminInformationAgentSale: mocks.sale,
  isAvailableInformationAgentStatus: () => true,
}));
vi.mock("@/lib/admin-information-agent-email-template", () => ({
  getPublishedInformationAgentEmailTemplate: mocks.template,
}));
vi.mock("@/lib/auction-fact-claims", () => ({ readSaleFactClaims: mocks.claims }));
vi.mock("@/lib/email-alerts", () => ({ sendResendEmail: mocks.send }));

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const admin = { isAdmin: true, userId: ADMIN_ID } as never;
const COURT_EMAIL = "accueil.exemple-agen@justice.fr";
const PORTAL_SECRET = "portal-secret-that-is-at-least-32-characters-long";

function courtSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: SALE_ID,
    title: "Maison à Agen",
    property_type: "house",
    address: "12 rue du Palais",
    city: "Agen",
    tribunal: "TJ Agen",
    tribunal_code: "agen",
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    quality_flags: [],
    postal_code: "47000",
    sale_date: null,
    starting_price_eur: null,
    lawyer_name: null,
    lawyer_contact: null,
    source_name: "licitor",
    primary_source: "licitor",
    source_url: "https://www.licitor.com/annonce/1.html",
    ...overrides,
  } as AuctionSale;
}

const draft = (input: Record<string, unknown> = {}) =>
  createAdminInformationAgentDraft({ auth: admin, input: { saleId: SALE_ID, ...input } as never });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  vi.resetAllMocks();
  vi.stubEnv("SITE_URL", "https://immojudis.example");
  db.court = { court_code: "agen", name: "Tribunal judiciaire d'Agen", emails: [COURT_EMAIL] };
  db.contacts = [];
  db.identityOppositions = [];
  db.courtMissionsForSale = [];
  db.courtMissionsToday = [];
  db.courtMissionsUnverified = [];
  db.cooldownMissions = [];
  db.mission = null;
  db.inserted = null;
  db.observed = [];
  db.messages = [];
  db.courtQueries = [];
  db.writes = [];
  mocks.sale.mockResolvedValue(courtSale());
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("brouillon pour une vente au tribunal sans aucun avocat : le greffe de secours", () => {
  it("adresse le brouillon au greffe du référentiel, avec la question du greffe seulement", async () => {
    const result = await draft();

    expect(result.mission).toMatchObject({
      recipientEmail: COURT_EMAIL,
      recipientName: null,
      recipientKind: "source_contact",
      recipientOrigin: "court_registry_fallback",
      questionKeys: ["documents"],
      status: "draft",
    });
    expect(result.mission.bodyText.startsWith("Madame, Monsieur,")).toBe(true);
    expect(result.mission.bodyText).toContain(`- ${COURT_REGISTRY_QUESTION}`);
    expect(result.mission.subject).toContain("avocat poursuivant ou pièces publiques");
    // Aucune des questions posées à un avocat.
    for (const forbidden of ["mise à prix", "garantie", "occupé", "visite", "DPE", "Carrez"]) {
      expect(result.mission.bodyText).not.toContain(forbidden);
    }
    expect(result.contactCandidates).toHaveLength(1);
    expect(db.inserted!.metadata).toMatchObject({
      draft_source: "admin_court_registry_fallback",
      address_origin: "court_registry_fallback",
      court_registry_fallback: { court_code: "agen", court_name: "Tribunal judiciaire d'Agen" },
      contact_discovery: { method: "court_registry_fallback", selected_email: COURT_EMAIL },
    });
    // L'origine est enregistrée au registre des contacts, distincte de toute autre.
    expect(db.observed).toHaveLength(1);
    expect(db.observed[0]).toMatchObject({
      email: COURT_EMAIL,
      source_kind: "court_registry_fallback",
      source_name: "Tribunal judiciaire d'Agen",
      source_url: null,
      observed_by: "agent",
      identity_keys: [],
    });
    // Un brouillon ne part jamais seul.
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'écrit pas au greffe quand l'annonce donne un avocat", async () => {
    mocks.sale.mockResolvedValue(courtSale({ lawyer_contact: "cabinet@example.test" }));
    const result = await draft();
    expect(result.mission.recipientEmail).toBe("cabinet@example.test");
    expect(result.mission.recipientOrigin).toBeNull();
    expect(db.inserted!.metadata).not.toHaveProperty("court_registry_fallback");
  });

  it("garde l'adresse de greffe lue dans l'annonce exclue : seul le référentiel sert", async () => {
    mocks.sale.mockResolvedValue(courtSale({ lawyer_contact: "greffe.autre@justice.fr" }));
    const result = await draft();
    expect(result.mission.recipientEmail).toBe(COURT_EMAIL);
  });

  it.each([
    ["une vente de notaire", { sale_venue_type: "notary" }],
    ["une cession de l'État", { sale_venue_type: "state", source_name: "cessions_etat" }],
    ["l'AGRASC", { source_name: "agrasc", primary_source: "agrasc" }],
    ["un tribunal seulement déduit", { sale_verification_status: "pending" }],
    ["un tribunal incohérent", { quality_flags: ["tribunal_inconsistent"] }],
    ["une vente sans tribunal reconnu", { tribunal_code: null }],
  ] as const)("n'écrit pas au greffe pour %s", async (_name, overrides) => {
    mocks.sale.mockResolvedValue(courtSale(overrides as Partial<AuctionSale>));
    await expect(draft()).rejects.toThrow("Aucune adresse email de contact");
    expect(db.inserted).toBeNull();
  });

  it("n'écrit pas au greffe d'un tribunal absent du référentiel ou sans adresse", async () => {
    db.court = null;
    await expect(draft()).rejects.toThrow("Aucune adresse email de contact");
    db.court = { court_code: "agen", name: "Tribunal judiciaire d'Agen", emails: [] };
    await expect(draft()).rejects.toThrow("Aucune adresse email de contact");
    expect(db.inserted).toBeNull();
  });

  it("respecte l'opposition : adresse du greffe opposée, ou professionnel opposé par identité", async () => {
    db.contacts = [
      {
        normalized_email: COURT_EMAIL,
        scope_sale_id: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    await expect(draft()).rejects.toThrow("Aucune adresse email de contact");
    expect(db.inserted).toBeNull();

    db.contacts = [];
    db.identityOppositions = [{ identity_key: "lawyer|agen|dupont jean" }];
    mocks.sale.mockResolvedValue(
      courtSale({ lawyer_name: "Maître Jean Dupont", lawyer_contact: "dupont@cabinet.test" }),
    );
    await expect(draft()).rejects.toThrow("s'est opposé");
    expect(db.inserted).toBeNull();
  });

  it("une adresse saisie par l'administrateur n'est jamais remplacée par le greffe", async () => {
    const result = await draft({ recipientEmail: "manuel@example.test" });
    expect(result.mission.recipientEmail).toBe("manuel@example.test");
    expect(result.mission.recipientOrigin).toBeNull();
  });

  it("une adresse de juridiction saisie à la main reste refusée", async () => {
    await expect(draft({ recipientEmail: "greffe.autre@justice.fr" })).rejects.toThrow(
      "n’est jamais sollicitée",
    );
    await expect(draft({ recipientEmail: COURT_EMAIL })).rejects.toThrow("n’est jamais sollicitée");
  });

  it("une seule sollicitation par tribunal et par vente", async () => {
    db.courtMissionsForSale = [{ id: "autre", approved_at: "2026-10-01T10:00:00.000Z" }];
    await expect(draft()).rejects.toThrow(
      "une seule demande est autorisée par tribunal et par vente",
    );
    expect(db.inserted).toBeNull();
  });

  it("plafond par tribunal et par jour : 3 par défaut, réglable", async () => {
    db.courtMissionsToday = [{ id: "a" }, { id: "b" }];
    await expect(draft()).resolves.toBeDefined();

    db.courtMissionsToday = [{ id: "a" }, { id: "b" }, { id: "c" }];
    await expect(draft()).rejects.toThrow("Plafond atteint : 3 demandes");

    vi.stubEnv("INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP", "4");
    await expect(draft()).resolves.toBeDefined();

    vi.stubEnv("INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP", "0");
    await expect(draft()).rejects.toThrow("Plafond atteint : 0 demande ");
  });
});

describe("plafond quotidien des greffes", () => {
  it("vaut 3 sans configuration, le réglage lisible sinon, jamais une valeur illisible", () => {
    expect(COURT_REGISTRY_DAILY_CAP_DEFAULT).toBe(3);
    expect(courtRegistryDailyCap({})).toBe(3);
    expect(courtRegistryDailyCap({ INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP: " 5 " })).toBe(5);
    expect(courtRegistryDailyCap({ INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP: "0" })).toBe(0);
    for (const raw of ["", "-1", "abc", "2.5", "101", "1e3"]) {
      expect(courtRegistryDailyCap({ INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP: raw })).toBe(3);
    }
  });

  it("compte le jour calendaire de Paris, pas une fenêtre de 24 heures", () => {
    expect(startOfParisDay(new Date("2026-10-14T12:00:00Z")).toISOString()).toBe(
      "2026-10-13T22:00:00.000Z",
    );
    expect(startOfParisDay(new Date("2026-10-13T22:30:00Z")).toISOString()).toBe(
      "2026-10-13T22:00:00.000Z",
    );
    expect(startOfParisDay(new Date("2026-12-14T12:00:00Z")).toISOString()).toBe(
      "2026-12-13T23:00:00.000Z",
    );
  });

  it("interroge le tribunal, la vente, le jour et les envois à vérifier, hors la mission elle-même", async () => {
    await assertCourtRegistryFallbackLimits({
      courtCode: "agen",
      saleId: SALE_ID,
      missionId: MISSION_ID,
      approvedAt: "2026-10-14T11:00:00.000Z",
      now: new Date("2026-10-14T12:00:00Z"),
    });
    expect(db.courtQueries).toHaveLength(4);
    for (const filters of db.courtQueries) {
      expect(filters).toContainEqual([
        "eq",
        "metadata->court_registry_fallback->>court_code",
        "agen",
      ]);
      expect(filters).toContainEqual(["neq", "id", MISSION_ID]);
      expect(filters).toContainEqual(["lte", "approved_at", "2026-10-14T11:00:00.000Z"]);
    }
    const day = db.courtQueries.filter((filters) =>
      filters.some(
        ([, column]) => column === "approved_at" && filters.some(([op]) => op === "gte"),
      ),
    );
    expect(day).toHaveLength(2);
    expect(day[0]).toContainEqual(["gte", "approved_at", "2026-10-13T22:00:00.000Z"]);
    expect(
      db.courtQueries.filter((filters) => filters.some(([, column]) => column === "sale_id")),
    ).toHaveLength(2);
  });

  it("un envoi à vérifier compte dans le plafond", async () => {
    db.courtMissionsUnverified = [{ id: "a" }, { id: "b" }, { id: "c" }];
    await expect(
      assertCourtRegistryFallbackLimits({ courtCode: "agen", saleId: null }),
    ).rejects.toThrow("Plafond atteint");
  });
});

describe("exclusion des adresses de juridiction", () => {
  it("reste en vigueur, sauf pour l'adresse de greffe vérifiée par l'appelant", async () => {
    await expect(
      assertInformationAgentContactAllowed({ email: COURT_EMAIL, saleId: SALE_ID }),
    ).rejects.toThrow("n’est jamais sollicitée");
    await expect(
      assertInformationAgentContactAllowed({
        email: COURT_EMAIL,
        saleId: SALE_ID,
        courtRegistryAddress: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("ne lève que l'exclusion « juridiction » : RPVA, Ordre, CARPA et adresses techniques restent refusés", async () => {
    for (const email of [
      "tribunal@avocat-conseil.fr",
      "ordre@barreau-agen.example",
      "noreply@cabinet.example",
      "carpa@cabinet.example",
    ]) {
      await expect(
        assertInformationAgentContactAllowed({
          email,
          saleId: SALE_ID,
          courtRegistryAddress: true,
        }),
      ).rejects.toThrow("n’est jamais sollicitée");
    }
  });

  it("l'opposition et le rebond restent contrôlés pour le greffe", async () => {
    db.contacts = [
      {
        normalized_email: COURT_EMAIL,
        scope_sale_id: SALE_ID,
        opposition_status: "none",
        bounce_status: "permanent",
      },
    ];
    await expect(
      assertInformationAgentContactAllowed({
        email: COURT_EMAIL,
        saleId: SALE_ID,
        courtRegistryAddress: true,
      }),
    ).rejects.toThrow("rebond permanent");
  });
});

describe("le greffe d'une mission", () => {
  const mission = (metadata: unknown, recipient = COURT_EMAIL) => ({
    metadata,
    recipient_email: recipient,
  });
  const trace = {
    contact_discovery: { method: "court_registry_fallback" },
    court_registry_fallback: { court_code: "agen", court_name: "Tribunal judiciaire d'Agen" },
  };

  it("n'est reconnu que pour l'adresse retenue au brouillon", () => {
    expect(courtRegistryFallbackOfMission(mission(trace), COURT_EMAIL.toUpperCase())).toEqual({
      courtCode: "agen",
      courtName: "Tribunal judiciaire d'Agen",
    });
    expect(courtRegistryFallbackOfMission(mission(trace), "greffe.autre@justice.fr")).toBeNull();
    expect(courtRegistryFallbackOfMission(mission({}), COURT_EMAIL)).toBeNull();
    expect(courtRegistryFallbackOfMission(mission(null), COURT_EMAIL)).toBeNull();
    expect(
      courtRegistryFallbackOfMission(
        mission({ ...trace, contact_discovery: { method: "source_data" } }),
        COURT_EMAIL,
      ),
    ).toBeNull();
  });
});

describe("message au greffe", () => {
  const values = {
    recipient_name: "Madame, Monsieur",
    salutation: "Madame, Monsieur,",
    sale_title: "Maison à Agen",
    sale_subject_title: "Maison à Agen",
    sale_reference: "Maison à Agen — 47000 Agen — TJ Agen",
    location: "47000 Agen",
    tribunal: "TJ Agen",
    hearing_date: "14 septembre 2026",
    hearing_line: "Audience annoncée : 14 septembre 2026",
    subject_date: "audience du 14/09/2026",
    starting_price: "85 000 €",
    price_line: "Mise à prix annoncée : 85 000 €",
    questions: `- ${COURT_REGISTRY_QUESTION}`,
  };

  it("demande l'avocat poursuivant ou les pièces publiques, sans nom de personne ni question d'avocat", () => {
    const rendered = renderInformationAgentEmailContent({
      template: COURT_REGISTRY_EMAIL_TEMPLATE,
      values,
    });
    expect(rendered.subject).toBe(
      "Maison à Agen, audience du 14/09/2026 : avocat poursuivant ou pièces publiques",
    );
    expect(rendered.bodyText.startsWith("Madame, Monsieur,")).toBe(true);
    expect(rendered.bodyText).toContain("l’avocat poursuivant");
    expect(rendered.bodyText).toContain("pièces publiques");
    expect(rendered.bodyText).toContain("Audience annoncée : 14 septembre 2026");
    expect(rendered.bodyText).not.toContain("85 000");
    expect(rendered.bodyText).not.toMatch(/Bonjour|Maître/);
    // Le message d'un avocat contient d'autres questions : celui du greffe n'en a qu'une.
    expect(rendered.bodyText.match(/^- /gm)).toHaveLength(1);
    expect(() =>
      assertNoInformationAgentCommercialMention(`${rendered.subject}\n${rendered.bodyText}`),
    ).not.toThrow();
  });

  it("l'origine de l'adresse est celle du référentiel, jamais une page consultée ni une recherche automatique", () => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "court_registry_fallback",
      sourceName: "Tribunal judiciaire d'Agen",
      observedAt: "2026-10-14T12:00:00Z",
      observedBy: "agent",
    });
    expect(origin).toEqual({
      text: "adresse de contact de votre juridiction, issue du référentiel des tribunaux tenu par Immojudis, relevée le 14/10/2026 ; l’annonce ne donne aucune adresse d’avocat.",
      url: null,
      automated: false,
      courtRegistry: true,
    });
  });
});

describe("aperçu et envoi d'une demande au greffe", () => {
  function greffeMission(overrides: Record<string, unknown> = {}) {
    return {
      id: MISSION_ID,
      user_id: ADMIN_ID,
      sale_id: SALE_ID,
      case_id: "33333333-3333-4333-8333-333333333333",
      status: "draft",
      created_at: "2026-10-13T09:30:00Z",
      recipient_kind: "source_contact",
      recipient_email: COURT_EMAIL,
      recipient_name: null,
      reply_to_email: null,
      recipient_identity_keys: [],
      subject: "Maison à Agen, date à confirmer : avocat poursuivant ou pièces publiques",
      body_text: `Madame, Monsieur,\n\n- ${COURT_REGISTRY_QUESTION}`,
      question_keys: ["documents"],
      missing_information: ["documents"],
      sale_snapshot: { title: "Maison à Agen", tribunal: "TJ Agen" },
      contribution_token_version: 1,
      metadata: {
        contact_discovery: { method: "court_registry_fallback" },
        court_registry_fallback: { court_code: "agen", court_name: "Tribunal judiciaire d'Agen" },
        address_origin: "court_registry_fallback",
      },
      ...overrides,
    };
  }
  const content = {
    missionId: MISSION_ID,
    recipientEmail: COURT_EMAIL,
    recipientName: "Prénom Nom du greffier",
    subject: "Maison à Agen, date à confirmer : avocat poursuivant ou pièces publiques",
    bodyText: `Madame, Monsieur,\n\n- ${COURT_REGISTRY_QUESTION}`,
  };

  beforeEach(() => {
    db.mission = greffeMission();
    db.contacts = [
      {
        normalized_email: COURT_EMAIL,
        scope_sale_id: SALE_ID,
        source_kind: "court_registry_fallback",
        source_name: "Tribunal judiciaire d'Agen",
        source_url: null,
        observed_at: "2026-10-13T09:30:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", PORTAL_SECRET);
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "true");
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_CANARY_ONLY", "false");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("INFORMATION_AGENT_EMAIL_FROM", "agent@example.test");
    vi.stubEnv("INFORMATION_AGENT_INBOUND_DOMAIN", "reply.example.test");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de la Paix, 33000 Bordeaux");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
  });

  it("l'aperçu ne bloque pas le greffe du référentiel et dit d'où vient l'adresse", async () => {
    const result = await previewAdminInformationAgentMission({ auth: admin, input: content });
    expect(result.blockers).toEqual([]);
    expect(result.addressOrigin).toEqual({
      text: expect.stringContaining(
        "adresse de contact de votre juridiction, issue du référentiel",
      ),
      url: null,
      automated: false,
      courtRegistry: true,
      known: true,
    });
    expect(result.preview.text).toContain("Madame, Monsieur,");
    expect(result.preview.text).toContain("issue du référentiel des tribunaux tenu par Immojudis");
    // Pied de la variante « greffe » : une fois par vente et plafond du tribunal, jamais « 30 jours ».
    expect(result.preview.text).toContain("Nous écrivons au plus une fois par vente");
    expect(result.preview.text).toContain("au plus 3 messages par jour, sans relance");
    expect(result.preview.text).toContain("l’adresse de contact de votre greffe");
    expect(result.preview.text).not.toContain("30 jours");
    expect(result.preview.text).not.toContain("votre adresse professionnelle");
    expect(result.preview.text).not.toContain("retrouvée automatiquement");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("l'aperçu bloque quand le plafond du jour est atteint ou quand la vente a déjà été sollicitée", async () => {
    db.courtMissionsToday = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(
      (await previewAdminInformationAgentMission({ auth: admin, input: content })).blockers,
    ).toEqual([expect.stringContaining("Plafond atteint")]);
    db.courtMissionsToday = [];
    db.courtMissionsForSale = [{ id: "a", approved_at: "2026-10-01T10:00:00.000Z" }];
    expect(
      (await previewAdminInformationAgentMission({ auth: admin, input: content })).blockers,
    ).toEqual([expect.stringContaining("une seule demande est autorisée")]);
  });

  it("l'aperçu bloque une adresse qui n'est plus celle du référentiel", async () => {
    db.court = {
      court_code: "agen",
      name: "Tribunal judiciaire d'Agen",
      emails: ["autre@justice.fr"],
    };
    const { blockers } = await previewAdminInformationAgentMission({ auth: admin, input: content });
    expect(blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("n’est plus celle du greffe")]),
    );
  });

  it("une adresse de juridiction substituée par l'administrateur reste exclue", async () => {
    const input = { ...content, recipientEmail: "greffe.autre@justice.fr" };
    const { blockers } = await previewAdminInformationAgentMission({ auth: admin, input });
    expect(blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("n’est jamais sollicitée")]),
    );
  });

  it("l'origine saisie à la main ne remplace pas la ligne de registre du greffe", async () => {
    db.contacts = [];
    const { blockers } = await previewAdminInformationAgentMission({
      auth: admin,
      input: { ...content, recipientOriginUrl: "https://annuaire.example.test/greffe" },
    });
    expect(blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("n’a plus de ligne de registre")]),
    );
  });

  it("envoie la demande au greffe, journalise son origine et revérifie les limites après l'approbation", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name !== "approve_information_agent_mission_admin") return { data: null, error: null };
      Object.assign(db.mission!, { approved_at: "2026-10-14T12:00:00.000Z" });
      return {
        data: [
          {
            case_id: "33333333-3333-4333-8333-333333333333",
            should_send: true,
            inbound_token: "44444444-4444-4444-8444-444444444444",
          },
        ],
        error: null,
      };
    });
    // Le délai de 30 jours par adresse est levé pour le greffe : un envoi récent à la même adresse ne bloque pas.
    db.cooldownMissions = [{ id: "autre", approved_at: "2026-10-10T10:00:00.000Z" }];
    mocks.send.mockResolvedValue({ id: "provider-message-id" });
    const fingerprint = informationAgentPreviewFingerprint(
      { adminId: ADMIN_ID, ...content },
      { INFORMATION_AGENT_PORTAL_SECRET: PORTAL_SECRET },
    )!;

    await runAdminInformationAgentAction({
      auth: admin,
      input: {
        action: "approve_and_send",
        approvalConfirmed: true,
        ...content,
        previewFingerprint: fingerprint,
      },
    });

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0]![0].message).toMatchObject({
      to: COURT_EMAIL,
      text: expect.stringContaining(
        "adresse de contact de votre juridiction, issue du référentiel",
      ),
    });
    expect(db.messages[0]).toMatchObject({
      to_email: COURT_EMAIL,
      metadata: expect.objectContaining({
        address_origin: "court_registry_fallback",
        court_code: "agen",
        court_name: "Tribunal judiciaire d'Agen",
      }),
    });
    expect(db.mission).toMatchObject({ status: "sent", recipient_kind: "source_contact" });
    // Jamais de nom de greffier dans un champ structuré, même saisi à la main.
    expect(db.mission).toMatchObject({ recipient_name: null, recipient_identity_keys: [] });
    // Les 4 requêtes de limites avant l'approbation, puis les 4 après (seules les approbations plus
    // anciennes comptent : les approbations concurrentes se départagent).
    const isOlderOnly = (filters: Filter[]) =>
      filters.some(([op, column]) => op === "lte" && column === "approved_at");
    expect(db.courtQueries).toHaveLength(8);
    expect(db.courtQueries.slice(0, 4).some(isOlderOnly)).toBe(false);
    expect(db.courtQueries.slice(4).every(isOlderOnly)).toBe(true);
    expect(mocks.send.mock.calls[0]![0].message.text).toContain("au plus 3 messages par jour");
  });

  it("n'envoie rien quand le plafond du jour est atteint", async () => {
    db.courtMissionsToday = [{ id: "a" }, { id: "b" }, { id: "c" }];
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const fingerprint = informationAgentPreviewFingerprint(
      { adminId: ADMIN_ID, ...content },
      { INFORMATION_AGENT_PORTAL_SECRET: PORTAL_SECRET },
    )!;
    await expect(
      runAdminInformationAgentAction({
        auth: admin,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          previewFingerprint: fingerprint,
        },
      }),
    ).rejects.toThrow("Plafond atteint");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("délai de 30 jours : levé pour le greffe seulement", () => {
  const recent = [{ id: "autre", approved_at: "2026-10-10T10:00:00.000Z" }];

  it("un avocat déjà sollicité récemment reste bloqué", async () => {
    mocks.sale.mockResolvedValue(courtSale({ lawyer_contact: "cabinet@example.test" }));
    db.cooldownMissions = recent;
    await expect(draft()).rejects.toThrow("déjà été sollicité");
  });

  it("le greffe n'est pas bloqué par un envoi récent à la même adresse, mais par ses limites", async () => {
    db.cooldownMissions = recent;
    await expect(draft()).resolves.toBeDefined();
    db.courtMissionsForSale = [{ id: "a", approved_at: "2026-10-01T10:00:00.000Z" }];
    await expect(draft()).rejects.toThrow("une seule demande est autorisée");
  });

  it("le paramètre n'est passé que pour l'origine greffe", async () => {
    db.cooldownMissions = recent;
    await expect(
      assertInformationAgentRecipientCooldown({ email: COURT_EMAIL, courtRegistryFallback: true }),
    ).resolves.toBeUndefined();
    await expect(assertInformationAgentRecipientCooldown({ email: COURT_EMAIL })).rejects.toThrow(
      "déjà été sollicité",
    );
  });

  it("le pied d'un avocat garde les 30 jours, celui d'un greffe annonce le plafond configuré", () => {
    const base = {
      controllerName: "Immojudis SAS",
      controllerAddress: "1 rue de la Paix",
      contactEmail: "contact@immojudis.example",
      saleReference: null,
      addressOrigin: "Origine",
      aiProvider: { name: "Replicate", country: "États-Unis" },
      privacyUrl: "https://immojudis.example/privacy",
      optOutUrl: "https://immojudis.example/opt-out",
    } as unknown as Parameters<typeof informationAgentLegalFooterSections>[0];
    const lawyer = informationAgentLegalFooterLines(base).join("\n");
    expect(lawyer).toContain("une fois par période de 30 jours");
    expect(lawyer).toContain("votre adresse professionnelle");
    const court = informationAgentLegalFooterLines({ ...base, courtRegistryDailyCap: 2 }).join(
      "\n",
    );
    expect(court).toContain(
      "Nous écrivons au plus une fois par vente et, pour un même tribunal, au plus 2 messages par jour, sans relance.",
    );
    expect(court).toContain("le nom, la fonction et les coordonnées de la personne qui répond");
    expect(court).not.toContain("30 jours");
    expect(
      informationAgentLegalFooterLines({ ...base, courtRegistryDailyCap: 1 }).join("\n"),
    ).toContain("au plus 1 message par jour");
  });
});

describe("vente relue à l'aperçu et à l'envoi d'une demande au greffe", () => {
  const content = {
    missionId: MISSION_ID,
    recipientEmail: COURT_EMAIL,
    recipientName: null,
    subject: "Maison à Agen, date à confirmer : avocat poursuivant ou pièces publiques",
    bodyText: `Madame, Monsieur,\n\n- ${COURT_REGISTRY_QUESTION}`,
  };

  beforeEach(() => {
    db.mission = {
      id: MISSION_ID,
      user_id: ADMIN_ID,
      sale_id: SALE_ID,
      case_id: "33333333-3333-4333-8333-333333333333",
      status: "draft",
      created_at: "2026-10-13T09:30:00Z",
      recipient_email: COURT_EMAIL,
      recipient_identity_keys: [],
      sale_snapshot: { title: "Maison à Agen" },
      metadata: {
        contact_discovery: { method: "court_registry_fallback" },
        court_registry_fallback: { court_code: "agen", court_name: "Tribunal judiciaire d'Agen" },
      },
    };
    db.contacts = [
      {
        normalized_email: COURT_EMAIL,
        scope_sale_id: SALE_ID,
        source_kind: "court_registry_fallback",
        source_name: "Tribunal judiciaire d'Agen",
        observed_at: "2026-10-13T09:30:00Z",
        observed_by: "agent",
        opposition_status: "unknown",
        bounce_status: "none",
      },
    ];
    vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", PORTAL_SECRET);
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "true");
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_CANARY_ONLY", "false");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("INFORMATION_AGENT_EMAIL_FROM", "agent@example.test");
    vi.stubEnv("INFORMATION_AGENT_INBOUND_DOMAIN", "reply.example.test");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de la Paix, 33000 Bordeaux");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
  });

  const blockers = async () =>
    (await previewAdminInformationAgentMission({ auth: admin, input: content })).blockers;

  it("sans changement, aucun motif de blocage", async () => {
    expect(await blockers()).toEqual([]);
  });

  it.each([
    ["le tribunal a changé", { tribunal_code: "bordeaux" }, "le tribunal de la vente a changé"],
    [
      "la vente n'est plus confirmée",
      { sale_verification_status: "pending" },
      "vente non confirmée",
    ],
    ["la vente est incohérente", { quality_flags: ["tribunal_inconsistent"] }, "incohérente"],
    ["la vente est une vente de notaire", { sale_venue_type: "notary" }, "hors tribunal"],
    [
      "l'annonce donne un email d'avocat",
      { lawyer_contact: "cabinet@example.test" },
      "adresse d’avocat",
    ],
  ] as const)("refuse quand %s", async (_name, change, reason) => {
    mocks.sale.mockResolvedValue(courtSale(change as Partial<AuctionSale>));
    expect(await blockers()).toEqual([expect.stringContaining(reason)]);
  });

  it("refuse l'envoi lui-même, avant toute approbation", async () => {
    mocks.sale.mockResolvedValue(courtSale({ lawyer_contact: "cabinet@example.test" }));
    const fingerprint = informationAgentPreviewFingerprint(
      { adminId: ADMIN_ID, ...content },
      { INFORMATION_AGENT_PORTAL_SECRET: PORTAL_SECRET },
    )!;
    await expect(
      runAdminInformationAgentAction({
        auth: admin,
        input: {
          action: "approve_and_send",
          approvalConfirmed: true,
          ...content,
          previewFingerprint: fingerprint,
        },
      }),
    ).rejects.toThrow("adresse d’avocat");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

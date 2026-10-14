import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminInformationAgentDraft } from "@/lib/information-agent";
import { DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE } from "@/lib/information-agent-email-template";
import type { AuctionSale } from "@/lib/types";

/**
 * Brouillon avec recherche autonome de l'adresse (niveau 1) : la base et la lecture du site du
 * cabinet sont simulées. Aucune requête réelle vers un site de cabinet.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sale: vi.fn(),
  template: vi.fn(),
  claims: vi.fn(),
  send: vi.fn(),
  firm: vi.fn(),
}));
const db = vi.hoisted(() => ({
  otherSales: [] as Array<Record<string, unknown>>,
  opposedKeys: [] as string[],
  recentMissions: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
  insertError: null as { message: string } | null,
  observed: [] as Array<Record<string, unknown>>,
  tables: [] as string[],
  order: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private inValues: unknown[] = [];
    private isInsert = false;
    constructor(private readonly table: string) {
      db.tables.push(table);
    }
    select() {
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    in(_column: string, values: unknown[]) {
      this.inValues = values;
      return this;
    }
    ilike() {
      return this;
    }
    neq() {
      return this;
    }
    gte() {
      return this;
    }
    lte() {
      return this;
    }
    or() {
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
        db.order.push("contact_upsert");
        db.observed = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
      }
      return this;
    }
    insert(values: Record<string, unknown>) {
      this.isInsert = true;
      db.order.push("mission_insert");
      if (!db.insertError) db.inserted = values;
      return this;
    }
    async single() {
      if (this.isInsert && db.insertError) return { data: null, error: db.insertError };
      return {
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          status: "draft",
          case_id: null,
          ...db.inserted,
        },
        error: null,
      };
    }
    then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
      const data =
        this.table === "auction_sales"
          ? db.otherSales
          : this.table === "information_agent_identity_oppositions"
            ? db.opposedKeys
                .filter((key) => (this.inValues as string[]).includes(key))
                .map((identity_key) => ({ identity_key }))
            : this.table === "information_agent_missions"
              ? db.recentMissions
              : [];
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table), rpc: mocks.rpc } };
});
vi.mock("@/lib/information-agent/firm-site-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/firm-site-search")>()),
  searchFirmWebsiteAddress: mocks.firm,
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
type SavedMetadata = {
  contact_discovery: { method: string; selected_email: string | null };
  address_search: { attempts: Array<{ method: string }> } | null;
};

function baseSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
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
    lawyer_contact: "12 rue du Palais | Tél.: 05 56 00 00 01 | www.cabinet-dupont.test",
    source_url: "https://www.licitor.com/annonce/1.html",
    ...overrides,
  } as AuctionSale;
}

const otherListing = {
  id: "33333333-3333-4333-8333-333333333333",
  source_name: "licitor",
  source_url: "https://www.licitor.com/annonce/2.html",
  sale_date: "2026-09-20T09:00:00Z",
  last_seen_at: "2026-10-12T04:00:00Z",
  lawyer_name: "Me Jean DUPONT",
  lawyer_contact: "Tél.: 05.56.00.00.01 | jean.dupont@cabinet-dupont.test",
};

const firmFound = {
  status: "found",
  host: "cabinet-dupont.test",
  pagesFetched: 2,
  email: "contact@cabinet-dupont.test",
  pageUrl: "https://www.cabinet-dupont.test/mentions-legales",
  reason: "generic",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  vi.resetAllMocks();
  vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "true");
  vi.stubEnv("SITE_URL", "https://immojudis.com");
  db.otherSales = [];
  db.opposedKeys = [];
  db.recentMissions = [];
  db.inserted = null;
  db.insertError = null;
  db.observed = [];
  db.tables = [];
  db.order = [];
  mocks.sale.mockResolvedValue(baseSale());
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.firm.mockResolvedValue({ status: "none", host: "cabinet-dupont.test", pagesFetched: 3 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const draft = (input: Record<string, unknown> = {}) =>
  createAdminInformationAgentDraft({ auth: admin, input: { saleId, ...input } as never });

describe("brouillon sans adresse dans l'annonce : recherche autonome", () => {
  it("A : réemploie l'adresse d'une autre annonce du même professionnel (nom + téléphone)", async () => {
    db.otherSales = [otherListing];
    const result = await draft();

    expect(result.mission).toMatchObject({
      recipientEmail: "jean.dupont@cabinet-dupont.test",
      recipientName: "Maître Jean Dupont",
      status: "draft",
    });
    expect(db.observed).toHaveLength(1);
    expect(db.observed[0]).toMatchObject({
      email: "jean.dupont@cabinet-dupont.test",
      source_kind: "other_listing",
      source_url: "https://www.licitor.com/annonce/2.html",
      source_name: "licitor",
      observed_at: "2026-10-14T12:00:00.000Z",
      observed_by: "agent",
      verification_status: "source_observed",
      identity_keys: ["lawyer|bordeaux|dupont jean"],
      metadata: expect.objectContaining({ match_rule: "same_name_and_phone" }),
    });
    expect(db.inserted).toMatchObject({
      recipient_email: "jean.dupont@cabinet-dupont.test",
      recipient_kind: "source_lawyer",
      recipient_identity_keys: ["lawyer|bordeaux|dupont jean"],
    });
    const metadata = db.inserted!.metadata as SavedMetadata;
    expect(metadata.contact_discovery).toMatchObject({
      method: "agent_search_other_listing",
      selected_email: "jean.dupont@cabinet-dupont.test",
    });
    expect(metadata.address_search?.attempts).toEqual([
      { method: "other_listing", outcome: "found", detail: null, host: null, pages: null },
    ]);
    // Une adresse trouvée ne part jamais seule : aucun envoi, aucun site consulté.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.firm).not.toHaveBeenCalled();
  });

  it("A : une adresse de l'autre annonce qui ne rappelle ni le nom ni le cabinet n'est pas réemployée", async () => {
    db.otherSales = [{ ...otherListing, lawyer_contact: "Tél.: 05.56.00.00.01 | archives@x.test" }];
    await expect(draft()).rejects.toThrow("renseignez l'adresse email");
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
  });

  it("B : sans autre annonce, lit le site du cabinet cité par l'annonce avec le user-agent d'Immojudis", async () => {
    mocks.firm.mockResolvedValue(firmFound);
    const result = await draft();

    expect(mocks.firm).toHaveBeenCalledOnce();
    expect(mocks.firm.mock.calls[0]![0]).toMatchObject({
      startUrl: "https://www.cabinet-dupont.test/",
      lawyerName: "Maître Jean Dupont",
      userAgent: "ImmojudisAdresses/1.0 (+https://immojudis.com/contact)",
    });
    expect(result.mission.recipientEmail).toBe("contact@cabinet-dupont.test");
    expect(db.observed[0]).toMatchObject({
      email: "contact@cabinet-dupont.test",
      source_kind: "firm_website",
      source_url: "https://www.cabinet-dupont.test/mentions-legales",
      observed_at: "2026-10-14T12:00:00.000Z",
      observed_by: "agent",
      metadata: expect.objectContaining({ match_rule: "firm_site_generic" }),
    });
    expect(db.observed[0]!.source_directory_name).toBeNull();
    const metadata = db.inserted!.metadata as SavedMetadata;
    expect(metadata.contact_discovery.method).toBe("agent_search_firm_website");
    expect(metadata.address_search?.attempts.map((a) => a.method)).toEqual([
      "other_listing",
      "firm_website",
    ]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'effectue aucune recherche quand l'annonce donne déjà une adresse", async () => {
    mocks.sale.mockResolvedValue(baseSale({ lawyer_contact: "cabinet@example.test" }));
    const result = await draft();
    expect(result.mission.recipientEmail).toBe("cabinet@example.test");
    expect(db.observed[0]).toMatchObject({ source_kind: "sale_listing" });
    expect(mocks.firm).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
    expect((db.inserted!.metadata as SavedMetadata).address_search).toBeNull();
  });

  it("n'effectue aucune recherche quand l'administrateur saisit l'adresse", async () => {
    await draft({ recipientEmail: "manuel@example.test" });
    expect(mocks.firm).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
    expect(db.inserted).toMatchObject({ recipient_kind: "manual_professional" });
  });

  it("une adresse de greffe dans l'annonce ne compte pas : la recherche démarre", async () => {
    mocks.sale.mockResolvedValue(
      baseSale({ lawyer_contact: "greffe@tj-bordeaux.justice.fr | Tél.: 05 56 00 00 01" }),
    );
    db.otherSales = [otherListing];
    const result = await draft();
    expect(result.mission.recipientEmail).toBe("jean.dupont@cabinet-dupont.test");
  });

  it("professionnel opposé : ni lecture des annonces, ni requête réseau, ni adresse stockée", async () => {
    db.opposedKeys = ["lawyer|bordeaux|dupont jean"];
    db.otherSales = [otherListing];
    await expect(draft()).rejects.toThrow("s'est opposé à être contacté");
    expect(mocks.firm).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
  });

  it("délai de 30 jours : l'adresse retrouvée n'est ni stockée ni proposée", async () => {
    db.otherSales = [otherListing];
    db.recentMissions = [{ id: "m1", approved_at: "2026-10-05T10:00:00Z" }];
    await expect(draft()).rejects.toThrow("30 derniers jours");
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
    expect(mocks.firm).not.toHaveBeenCalled();
  });

  it("rien de sûr trouvé : l'administrateur doit saisir l'adresse, sans brouillon créé", async () => {
    db.otherSales = [
      { ...otherListing, sale_date: "2026-01-10T09:00:00Z", last_seen_at: "2026-02-01T00:00:00Z" },
    ];
    mocks.firm.mockResolvedValue({
      status: "robots_disallowed",
      host: "cabinet-dupont.test",
      pagesFetched: 0,
    });
    await expect(draft()).rejects.toThrow(/renseignez l'adresse email.*recherche automatique/s);
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("ambiguïté sur le site : aucune adresse n'est retenue", async () => {
    mocks.firm.mockResolvedValue({
      status: "ambiguous",
      host: "cabinet-dupont.test",
      pagesFetched: 3,
    });
    await expect(draft()).rejects.toThrow("renseignez l'adresse email");
    expect(db.observed).toEqual([]);
  });
});

describe("interrupteur et origine de production", () => {
  it.each([undefined, "", "false", "TRUE", "1"])(
    "recherche coupée (variable %j) : ni annonces ni site consultés, message à l'administrateur",
    async (value) => {
      if (value === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", value);
      vi.stubEnv("SITE_URL", "https://immojudis.com");
      db.otherSales = [otherListing];
      mocks.firm.mockResolvedValue(firmFound);
      await expect(draft()).rejects.toThrow(
        "La recherche automatique d’adresse est désactivée : indiquez l’adresse et la page publique où vous l’avez relevée.",
      );
      expect(db.tables).not.toContain("auction_sales");
      expect(mocks.firm).not.toHaveBeenCalled();
      expect(db.observed).toEqual([]);
      expect(db.inserted).toBeNull();
    },
  );

  it("recherche coupée : la saisie d'une adresse par l'administrateur reste possible", async () => {
    vi.stubEnv("INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", "false");
    const result = await draft({ recipientEmail: "manuel@example.test" });
    expect(result.mission.recipientEmail).toBe("manuel@example.test");
  });

  it("origine publique hors production (aperçu Vercel, poste local) : aucune recherche", async () => {
    vi.stubEnv("SITE_URL", "https://immojudis-git-feature.vercel.app");
    db.otherSales = [otherListing];
    await expect(draft()).rejects.toThrow("n’est active que sur le site de production");
    expect(db.tables).not.toContain("auction_sales");
    expect(mocks.firm).not.toHaveBeenCalled();
  });
});

describe("enregistrement de l'adresse trouvée", () => {
  it("n'est écrite qu'après le contrôle et la création du brouillon", async () => {
    db.otherSales = [otherListing];
    await draft();
    expect(db.order).toEqual(["mission_insert", "contact_upsert"]);
  });

  it("n'est jamais écrite si la création du brouillon échoue", async () => {
    db.otherSales = [otherListing];
    db.insertError = { message: "insertion refusée" };
    await expect(draft()).rejects.toMatchObject({ message: "insertion refusée" });
    expect(db.observed).toEqual([]);
    expect(db.order).toEqual(["mission_insert"]);
  });

  it("n'est jamais écrite si l'abonnement du brouillon échoue avant l'enregistrement", async () => {
    db.otherSales = [otherListing];
    mocks.rpc.mockResolvedValue({ error: { message: "abonnement refusé" } });
    await expect(draft()).rejects.toMatchObject({ message: "abonnement refusé" });
    expect(db.observed).toEqual([]);
  });

  it("l'adresse de l'annonce de la vente garde son enregistrement habituel, avant le brouillon", async () => {
    mocks.sale.mockResolvedValue(baseSale({ lawyer_contact: "cabinet@example.test" }));
    await draft();
    expect(db.order).toEqual(["contact_upsert", "mission_insert"]);
  });
});

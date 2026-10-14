import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminInformationAgentDraft } from "@/lib/information-agent";
import { DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE } from "@/lib/information-agent-email-template";
import type { AuctionSale } from "@/lib/types";

/**
 * Brouillon avec recherche autonome de l'adresse (niveau 1) : la base, le DNS et le réseau sont
 * simulés. Aucune requête réelle vers un site de cabinet.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  sale: vi.fn(),
  template: vi.fn(),
  claims: vi.fn(),
  send: vi.fn(),
}));
const db = vi.hoisted(() => ({
  otherSales: [] as Array<Record<string, unknown>>,
  opposedKeys: [] as string[],
  recentMissions: [] as Array<Record<string, unknown>>,
  inserted: null as Record<string, unknown> | null,
  observed: [] as Array<Record<string, unknown>>,
  tables: [] as string[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private inValues: unknown[] = [];
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
        db.observed = (Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>;
      }
      return this;
    }
    insert(values: Record<string, unknown>) {
      db.inserted = values;
      return this;
    }
    async single() {
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
vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.216.34" }] }));
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
const fetchMock = vi.fn();
type SavedMetadata = {
  contact_discovery: { method: string; selected_email: string | null };
  address_search: { attempts: Array<{ method: string }> };
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
  lawyer_contact: "Tél.: 05.56.00.00.01 | archives@cabinet-dupont.test",
};

function respond(routes: Record<string, { status?: number; body: string; type?: string }>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) return new Response("introuvable", { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { "content-type": route.type ?? "text/html" },
    });
  });
}

const fetchedUrls = () => fetchMock.mock.calls.map(([input]) => String(input));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.resetAllMocks();
  db.otherSales = [];
  db.opposedKeys = [];
  db.recentMissions = [];
  db.inserted = null;
  db.observed = [];
  db.tables = [];
  mocks.sale.mockResolvedValue(baseSale());
  mocks.template.mockResolvedValue({
    id: "published-template",
    revision: 3,
    content: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  });
  mocks.claims.mockResolvedValue({ claims: [], claimsBacked: true });
  mocks.rpc.mockResolvedValue({ error: null });
  fetchMock.mockImplementation(async () => new Response("introuvable", { status: 404 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("brouillon sans adresse dans l'annonce : recherche autonome", () => {
  it("A : réemploie l'adresse d'une autre annonce du même professionnel (nom + téléphone)", async () => {
    db.otherSales = [otherListing];
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });

    expect(result.mission).toMatchObject({
      recipientEmail: "archives@cabinet-dupont.test",
      recipientName: "Maître Jean Dupont",
      status: "draft",
    });
    expect(db.observed).toHaveLength(1);
    expect(db.observed[0]).toMatchObject({
      email: "archives@cabinet-dupont.test",
      source_kind: "other_listing",
      source_url: "https://www.licitor.com/annonce/2.html",
      source_name: "licitor",
      observed_at: "2026-10-14T12:00:00.000Z",
      observed_by: "agent",
      verification_status: "source_observed",
      identity_keys: ["lawyer|bordeaux|dupont jean"],
    });
    expect(db.inserted).toMatchObject({
      recipient_email: "archives@cabinet-dupont.test",
      recipient_kind: "source_lawyer",
      recipient_identity_keys: ["lawyer|bordeaux|dupont jean"],
    });
    const metadata = db.inserted!.metadata as SavedMetadata;
    expect(metadata.contact_discovery).toMatchObject({
      method: "agent_search_other_listing",
      selected_email: "archives@cabinet-dupont.test",
    });
    expect(metadata.address_search.attempts).toEqual([
      { method: "other_listing", outcome: "found", detail: null, host: null, pages: null },
    ]);
    // Une adresse trouvée ne part jamais seule : aucun envoi, aucun site consulté.
    expect(mocks.send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("B : sans autre annonce, lit le site du cabinet cité par l'annonce (3 pages au plus, même domaine)", async () => {
    respond({
      "https://www.cabinet-dupont.test/robots.txt": {
        body: "User-agent: *\nDisallow: /admin",
        type: "text/plain",
      },
      "https://www.cabinet-dupont.test/": {
        body: '<a href="/mentions-legales">Mentions légales</a><a href="https://www.linkedin.com/in/dupont">LinkedIn</a>',
      },
      "https://www.cabinet-dupont.test/mentions-legales": {
        body: '<p>Éditeur : <a href="mailto:contact@cabinet-dupont.test">contact@cabinet-dupont.test</a></p>',
      },
    });
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });

    expect(result.mission.recipientEmail).toBe("contact@cabinet-dupont.test");
    expect(db.observed[0]).toMatchObject({
      email: "contact@cabinet-dupont.test",
      source_kind: "firm_website",
      source_url: "https://www.cabinet-dupont.test/mentions-legales",
      observed_at: "2026-10-14T12:00:00.000Z",
      observed_by: "agent",
    });
    expect(db.observed[0]!.source_directory_name).toBeNull();
    expect(fetchedUrls()).toEqual([
      "https://www.cabinet-dupont.test/robots.txt",
      "https://www.cabinet-dupont.test/",
      "https://www.cabinet-dupont.test/mentions-legales",
    ]);
    const metadata = db.inserted!.metadata as SavedMetadata;
    expect(metadata.contact_discovery.method).toBe("agent_search_firm_website");
    expect(metadata.address_search.attempts.map((a: { method: string }) => a.method)).toEqual([
      "other_listing",
      "firm_website",
    ]);
    // Aucune copie de page dans la trace.
    expect(JSON.stringify(db.inserted)).not.toContain("Éditeur");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'effectue aucune recherche quand l'annonce donne déjà une adresse", async () => {
    mocks.sale.mockResolvedValue(baseSale({ lawyer_contact: "cabinet@example.test" }));
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission.recipientEmail).toBe("cabinet@example.test");
    expect(db.observed[0]).toMatchObject({ source_kind: "sale_listing" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
  });

  it("n'effectue aucune recherche quand l'administrateur saisit l'adresse", async () => {
    await createAdminInformationAgentDraft({
      auth: admin,
      input: { saleId, recipientEmail: "manuel@example.test" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
    expect(db.inserted).toMatchObject({ recipient_kind: "manual_professional" });
  });

  it("une adresse de greffe dans l'annonce ne compte pas : la recherche démarre", async () => {
    mocks.sale.mockResolvedValue(
      baseSale({ lawyer_contact: "greffe@tj-bordeaux.justice.fr | Tél.: 05 56 00 00 01" }),
    );
    db.otherSales = [otherListing];
    const result = await createAdminInformationAgentDraft({ auth: admin, input: { saleId } });
    expect(result.mission.recipientEmail).toBe("archives@cabinet-dupont.test");
  });

  it("professionnel opposé : ni lecture des annonces, ni requête réseau, ni adresse stockée", async () => {
    db.opposedKeys = ["lawyer|bordeaux|dupont jean"];
    db.otherSales = [otherListing];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("s'est opposé à être contacté");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.tables).not.toContain("auction_sales");
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
  });

  it("délai de 30 jours : l'adresse retrouvée n'est ni stockée ni proposée", async () => {
    db.otherSales = [otherListing];
    db.recentMissions = [{ id: "m1", approved_at: "2026-10-05T10:00:00Z" }];
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("30 derniers jours");
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rien de sûr trouvé : l'administrateur doit saisir l'adresse, sans brouillon créé", async () => {
    // Autre annonce trop ancienne, site qui interdit les robots.
    db.otherSales = [
      { ...otherListing, sale_date: "2026-01-10T09:00:00Z", last_seen_at: "2026-02-01T00:00:00Z" },
    ];
    respond({
      "https://www.cabinet-dupont.test/robots.txt": {
        body: "User-agent: *\nDisallow: /",
        type: "text/plain",
      },
    });
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow(/renseignez l'adresse email.*recherche automatique/s);
    expect(fetchedUrls()).toEqual(["https://www.cabinet-dupont.test/robots.txt"]);
    expect(db.observed).toEqual([]);
    expect(db.inserted).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("ambiguïté sur le site : aucune adresse n'est retenue", async () => {
    respond({
      "https://www.cabinet-dupont.test/robots.txt": { status: 404, body: "" },
      "https://www.cabinet-dupont.test/": {
        body: "<p>marie.martin@cabinet-dupont.test paul.durand@cabinet-dupont.test</p>",
      },
    });
    await expect(
      createAdminInformationAgentDraft({ auth: admin, input: { saleId } }),
    ).rejects.toThrow("renseignez l'adresse email");
    expect(db.observed).toEqual([]);
  });
});

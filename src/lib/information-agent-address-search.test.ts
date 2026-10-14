import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  contacts: [] as Array<Record<string, unknown>>,
  opposedKeys: [] as string[],
  recentMissions: [] as Array<Record<string, unknown>>,
  identityLookups: [] as string[][],
  failTable: null as string | null,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<[string, unknown]> = [];
    private inValues: unknown[] | null = null;
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    is(column: string, value: unknown) {
      this.filters.push([column, value]);
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
    limit() {
      return this;
    }
    then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown) {
      if (db.failTable === this.table) {
        return Promise.resolve({ data: null, error: { message: "base indisponible" } }).then(
          onFulfilled,
        );
      }
      let data: unknown[] = [];
      if (this.table === "information_agent_contacts") {
        data = db.contacts.filter((row) =>
          this.filters.every(([column, value]) => (row[column] ?? null) === value),
        );
      } else if (this.table === "information_agent_identity_oppositions") {
        const keys = (this.inValues ?? []) as string[];
        db.identityLookups.push(keys);
        data = db.opposedKeys
          .filter((key) => keys.includes(key))
          .map((identity_key) => ({ identity_key }));
      } else if (this.table === "information_agent_missions") {
        data = db.recentMissions;
      }
      return Promise.resolve({ data, error: null }).then(onFulfilled);
    }
  }
  return { supabaseAdmin: { from: (table: string) => new Query(table) } };
});

const reuse = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("@/lib/information-agent/address-reuse", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/address-reuse")>()),
  findReusableInformationAgentAddress: reuse.find,
}));

const firm = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/information-agent/firm-site-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/firm-site-search")>()),
  searchFirmWebsiteAddress: firm.search,
}));

import {
  assertInformationAgentSearchedAddressAllowed,
  isInformationAgentAddressSearchEnabled,
  RECIPIENT_COOLDOWN_MESSAGE_PREFIX,
  searchInformationAgentAddress,
  searchInformationAgentAddressForDraft,
  type InformationAgentAddressSearchSale,
} from "@/lib/information-agent/address-search";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";

const NOW = new Date("2026-10-14T12:00:00Z");
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const PLACE = { bar: "Bordeaux", city: "Bordeaux" };
const KEY = "lawyer|bordeaux|dupont jean";

function sale(
  overrides: Partial<InformationAgentAddressSearchSale> = {},
): InformationAgentAddressSearchSale {
  return {
    id: SALE_ID,
    lawyer_name: "Maître Jean Dupont",
    lawyer_contact: "Tél.: 05 56 00 00 01 | www.cabinet-dupont.test",
    source_blocks: null,
    source_blocks_by_source: null,
    source_url: "https://www.licitor.com/annonce/1.html",
    source_urls: null,
    ...overrides,
  };
}

const reusable = {
  status: "found",
  address: {
    email: "cabinet@cabinet-dupont.test",
    listingLawyerName: "Me Jean DUPONT",
    listing: {
      saleId: "22222222-2222-4222-8222-222222222222",
      sourceName: "licitor",
      sourceUrl: "https://www.licitor.com/annonce/2.html",
      referenceAt: "2026-10-10T04:00:00.000Z",
    },
  },
};

const found = {
  status: "found",
  host: "cabinet-dupont.test",
  pagesFetched: 2,
  email: "contact@cabinet-dupont.test",
  pageUrl: "https://www.cabinet-dupont.test/contact",
  reason: "single",
};

function run(overrides: Partial<InformationAgentAddressSearchSale> = {}) {
  return searchInformationAgentAddress({
    sale: sale(overrides),
    identityPlace: PLACE,
    siteOrigin: "https://immojudis.com",
    now: NOW,
  });
}

beforeEach(() => {
  db.contacts = [];
  db.opposedKeys = [];
  db.recentMissions = [];
  db.identityLookups = [];
  db.failTable = null;
  reuse.find.mockReset();
  firm.search.mockReset();
  reuse.find.mockResolvedValue({ status: "none", reason: "no_match" });
  firm.search.mockResolvedValue({ status: "none", host: "cabinet-dupont.test", pagesFetched: 3 });
});

describe("recherche autonome de l'adresse (niveau 1)", () => {
  it("A d'abord : l'adresse d'une autre annonce est proposée en `other_listing`, sans toucher au site", async () => {
    reuse.find.mockResolvedValue(reusable);
    const outcome = await run();

    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.method).toBe("other_listing");
    expect(outcome.candidate).toMatchObject({
      email: "cabinet@cabinet-dupont.test",
      name: "Maître Jean Dupont",
      role: "lawyer",
      recipientKind: "source_lawyer",
      source: {
        kind: "other_listing",
        url: "https://www.licitor.com/annonce/2.html",
        observedAt: "2026-10-14T12:00:00.000Z",
        observedBy: "agent",
      },
      identityKeys: [KEY],
      matchRule: "same_name_and_phone",
    });
    expect(outcome.candidate.provenance).toEqual([
      {
        kind: "agent_search",
        field: "other_listing",
        sourceName: "licitor",
        sourceUrl: "https://www.licitor.com/annonce/2.html",
      },
    ]);
    expect(firm.search).not.toHaveBeenCalled();
  });

  it("B ensuite : sans réemploi, le site cité par l'annonce est consulté avec le user-agent d'Immojudis", async () => {
    firm.search.mockResolvedValue(found);
    const outcome = await run();

    expect(reuse.find).toHaveBeenCalledOnce();
    expect(firm.search).toHaveBeenCalledOnce();
    expect(firm.search.mock.calls[0]![0]).toMatchObject({
      startUrl: "https://www.cabinet-dupont.test/",
      lawyerName: "Maître Jean Dupont",
      userAgent: "ImmojudisAdresses/1.0 (+https://immojudis.com/contact)",
    });
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.method).toBe("firm_website");
    expect(outcome.candidate).toMatchObject({
      email: "contact@cabinet-dupont.test",
      source: {
        kind: "firm_website",
        url: "https://www.cabinet-dupont.test/contact",
        observedAt: "2026-10-14T12:00:00.000Z",
        observedBy: "agent",
      },
      matchRule: "firm_site_single",
    });
    expect(outcome.attempts.map((attempt) => [attempt.method, attempt.outcome])).toEqual([
      ["other_listing", "none"],
      ["firm_website", "found"],
    ]);
  });

  it("l'URL de départ vient de l'annonce uniquement : sans site cité, aucune requête", async () => {
    const outcome = await run({ lawyer_contact: "Tél.: 05 56 00 00 01" });
    expect(outcome.status).toBe("none");
    expect(firm.search).not.toHaveBeenCalled();
    expect(outcome.attempts).toContainEqual({
      method: "firm_website",
      outcome: "none",
      detail: "no_site_in_listing",
    });
  });

  it("opposition par identité : ni lecture des annonces ni requête réseau", async () => {
    db.opposedKeys = [KEY];
    reuse.find.mockResolvedValue(reusable);
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "opposed", scope: "identity" });
    expect(reuse.find).not.toHaveBeenCalled();
    expect(firm.search).not.toHaveBeenCalled();
    // Sans rôle sûr, tous les rôles sont contrôlés.
    expect(db.identityLookups[0]).toEqual(
      expect.arrayContaining([
        KEY,
        "notary|bordeaux|dupont jean",
        "commissaire_de_justice|bordeaux|dupont jean",
      ]),
    );
  });

  it("opposition par adresse sur l'adresse d'une autre annonce : arrêt, sans chercher ailleurs", async () => {
    reuse.find.mockResolvedValue(reusable);
    db.contacts = [
      {
        normalized_email: "cabinet@cabinet-dupont.test",
        scope_sale_id: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "opposed", scope: "address" });
    expect(firm.search).not.toHaveBeenCalled();
  });

  it("opposition par identité sous le nom imprimé par l'annonce d'origine", async () => {
    reuse.find.mockResolvedValue({
      ...reusable,
      address: { ...reusable.address, listingLawyerName: "Me Jean-Pierre DUPONT" },
    });
    db.opposedKeys = ["lawyer|bordeaux|dupont jean pierre"];
    expect(await run()).toMatchObject({ status: "opposed", scope: "identity" });
    expect(firm.search).not.toHaveBeenCalled();
  });

  it("opposition par adresse sur l'adresse trouvée sur le site : rien n'est proposé", async () => {
    firm.search.mockResolvedValue(found);
    db.contacts = [
      {
        normalized_email: "contact@cabinet-dupont.test",
        scope_sale_id: null,
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    expect(await run()).toMatchObject({ status: "opposed", scope: "address" });
  });

  it("une opposition limitée à une autre vente ne bloque pas celle-ci", async () => {
    firm.search.mockResolvedValue(found);
    db.contacts = [
      {
        normalized_email: "contact@cabinet-dupont.test",
        scope_sale_id: "99999999-9999-4999-8999-999999999999",
        opposition_status: "opposed",
        bounce_status: "none",
      },
    ];
    // Le registre est lu pour la portée globale et pour cette vente seulement.
    expect((await run()).status).toBe("found");
  });

  it("délai de 30 jours : l'adresse déjà sollicitée n'est pas proposée et B n'est pas tentée", async () => {
    reuse.find.mockResolvedValue(reusable);
    db.recentMissions = [{ id: "m1", approved_at: "2026-10-01T10:00:00Z" }];
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "cooldown", method: "other_listing" });
    expect(firm.search).not.toHaveBeenCalled();

    reuse.find.mockResolvedValue({ status: "none", reason: "no_match" });
    firm.search.mockResolvedValue(found);
    expect(await run()).toMatchObject({ status: "cooldown", method: "firm_website" });
  });

  it("le message du délai de 30 jours reste reconnu par la recherche", async () => {
    db.recentMissions = [{ id: "m1", approved_at: "2026-10-01T10:00:00Z" }];
    await expect(
      assertInformationAgentRecipientCooldown({
        email: "cabinet@cabinet-dupont.test",
        missionId: "00000000-0000-0000-0000-000000000000",
        now: NOW,
      }),
    ).rejects.toThrow(RECIPIENT_COOLDOWN_MESSAGE_PREFIX);
  });

  it("adresse en rebond permanent : écartée, B reste possible", async () => {
    reuse.find.mockResolvedValue(reusable);
    firm.search.mockResolvedValue(found);
    db.contacts = [
      {
        normalized_email: "cabinet@cabinet-dupont.test",
        scope_sale_id: SALE_ID,
        opposition_status: "unknown",
        bounce_status: "permanent",
      },
    ];
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "found", method: "firm_website" });
    expect(outcome.attempts[0]).toMatchObject({ method: "other_listing", outcome: "bounced" });
  });

  it("adresse exclue renvoyée par le site : jamais proposée", async () => {
    firm.search.mockResolvedValue({ ...found, email: "greffe@tj-bordeaux.justice.fr" });
    const outcome = await run();
    expect(outcome.status).toBe("none");
    expect(outcome.attempts.at(-1)).toMatchObject({ outcome: "refused", detail: "excluded" });
  });

  it("page de l'adresse issue d'un hôte exclu : jamais proposée", async () => {
    firm.search.mockResolvedValue({ ...found, pageUrl: "https://www.linkedin.com/in/dupont" });
    expect((await run()).status).toBe("none");
  });

  it("ambiguïté, refus du site ou blocage : rien n'est proposé, la raison est tracée", async () => {
    for (const [status, outcome] of [
      ["ambiguous", "ambiguous"],
      ["robots_disallowed", "refused"],
      ["blocked", "blocked"],
    ] as const) {
      firm.search.mockResolvedValue({ status, host: "cabinet-dupont.test", pagesFetched: 1 });
      const result = await run();
      expect(result.status).toBe("none");
      expect(result.attempts.at(-1)).toMatchObject({
        method: "firm_website",
        outcome,
        host: "cabinet-dupont.test",
        pages: 1,
      });
    }
  });

  it("une panne de A ou de B ne casse pas la préparation du brouillon", async () => {
    reuse.find.mockRejectedValue(new Error("base indisponible"));
    firm.search.mockRejectedValue(new Error("réseau"));
    const outcome = await run();
    expect(outcome.status).toBe("none");
    expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual(["error", "error"]);
  });

  it("un contrôle d'opposition indisponible empêche toute recherche", async () => {
    db.failTable = "information_agent_identity_oppositions";
    reuse.find.mockResolvedValue(reusable);
    const outcome = await run();
    expect(outcome.status).toBe("none");
    expect(outcome.attempts).toEqual([
      { method: "other_listing", outcome: "error", detail: "opposition_check" },
    ]);
    expect(reuse.find).not.toHaveBeenCalled();
    expect(firm.search).not.toHaveBeenCalled();
  });

  it("un registre des contacts indisponible n'autorise pas l'adresse trouvée", async () => {
    db.failTable = "information_agent_contacts";
    firm.search.mockResolvedValue(found);
    const outcome = await run();
    expect(outcome.status).toBe("none");
    expect(outcome.attempts.at(-1)).toMatchObject({ outcome: "error" });
  });

  it("sans clé d'identité (nom incomplet ou lieu inconnu) : ni annonces ni site, rien n'est consulté", async () => {
    reuse.find.mockResolvedValue(reusable);
    firm.search.mockResolvedValue(found);
    for (const [name, place] of [
      ["Me Dupont", PLACE],
      [null, PLACE],
      ["Maître Jean Dupont", { bar: null, city: null }],
    ] as const) {
      const outcome = await searchInformationAgentAddress({
        sale: sale({ lawyer_name: name }),
        identityPlace: place,
        siteOrigin: "https://immojudis.com",
        now: NOW,
      });
      expect(outcome.status).toBe("none");
      expect(outcome.attempts).toEqual([
        { method: "other_listing", outcome: "refused", detail: "no_identity_keys" },
        { method: "firm_website", outcome: "refused", detail: "no_identity_keys" },
      ]);
    }
    expect(reuse.find).not.toHaveBeenCalled();
    expect(firm.search).not.toHaveBeenCalled();
    expect(db.identityLookups).toEqual([]);
  });

  it("la lecture des annonces est bornée par le budget de la recherche", async () => {
    await searchInformationAgentAddress({
      sale: sale(),
      identityPlace: PLACE,
      siteOrigin: "https://immojudis.com",
      now: NOW,
      budgetMs: 4_000,
    });
    expect(reuse.find.mock.calls[0]![0]).toMatchObject({ timeoutMs: 4_000 });
  });
});

const ENABLED = { INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED: "true" };
const draftSearch = (
  env: Record<string, string | undefined>,
  overrides: Partial<Parameters<typeof searchInformationAgentAddressForDraft>[0]> = {},
) =>
  searchInformationAgentAddressForDraft({
    sale: sale(),
    identityPlace: PLACE,
    siteOrigin: "https://immojudis.com",
    now: NOW,
    skip: false,
    env,
    ...overrides,
  });

describe("interrupteur INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED", () => {
  const DISABLED =
    "La recherche automatique d’adresse est désactivée : indiquez l’adresse et la page publique où vous l’avez relevée.";

  it.each([undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true "])(
    "coupe la recherche pour les deux sources quand la variable vaut %j",
    async (value) => {
      reuse.find.mockResolvedValue(reusable);
      firm.search.mockResolvedValue(found);
      const result = await draftSearch({ INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED: value });
      expect(result.candidate).toBeNull();
      expect(result.noAddressNote).toBe(` ${DISABLED}`);
      expect(reuse.find).not.toHaveBeenCalled();
      expect(firm.search).not.toHaveBeenCalled();
      expect(db.identityLookups).toEqual([]);
      expect(
        isInformationAgentAddressSearchEnabled({ INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED: value }),
      ).toBe(false);
    },
  );

  it("n'active la recherche que pour la valeur exacte `true`", async () => {
    reuse.find.mockResolvedValue(reusable);
    const result = await draftSearch(ENABLED);
    expect(result.candidate).toMatchObject({ email: "cabinet@cabinet-dupont.test" });
    expect(result.discoveryMethod).toBe("agent_search_other_listing");
    expect(isInformationAgentAddressSearchEnabled(ENABLED)).toBe(true);
  });

  it("source B aussi : l'interrupteur actif laisse la recherche du site se faire", async () => {
    firm.search.mockResolvedValue(found);
    const result = await draftSearch(ENABLED);
    expect(result.discoveryMethod).toBe("agent_search_firm_website");
    expect(firm.search).toHaveBeenCalledOnce();
  });

  it("accepte l'origine de production avec ou sans www", async () => {
    firm.search.mockResolvedValue(found);
    for (const siteOrigin of ["https://immojudis.com", "https://www.immojudis.com"]) {
      const result = await draftSearch(ENABLED, { siteOrigin });
      expect(result.candidate, siteOrigin).not.toBeNull();
    }
    // L'origine est comparée exactement : ni sous-domaine tiers ni autre schéma.
    for (const siteOrigin of [
      "https://evil.immojudis.com",
      "https://immojudis.com.evil.example",
      "http://www.immojudis.com",
      "https://immojudis.com:8443",
    ]) {
      expect((await draftSearch(ENABLED, { siteOrigin })).candidate, siteOrigin).toBeNull();
    }
  });

  it("refuse la recherche hors de l'origine de production, même interrupteur actif", async () => {
    reuse.find.mockResolvedValue(reusable);
    firm.search.mockResolvedValue(found);
    for (const siteOrigin of [
      "https://immojudis-dezt.vercel.app",
      "https://immojudis.example",
      "http://immojudis.com",
      "http://localhost:3000",
      "pas une origine",
    ]) {
      const result = await draftSearch(ENABLED, { siteOrigin });
      expect(result.candidate, siteOrigin).toBeNull();
      expect(result.noAddressNote, siteOrigin).toContain(
        "n’est active que sur le site de production",
      );
    }
    expect(reuse.find).not.toHaveBeenCalled();
    expect(firm.search).not.toHaveBeenCalled();
  });

  it("ne cherche rien quand l'annonce ou l'administrateur donne déjà l'adresse (`skip`)", async () => {
    const result = await draftSearch(ENABLED, { skip: true });
    expect(result).toEqual({
      candidate: null,
      discoveryMethod: null,
      snapshot: null,
      noAddressNote: "",
    });
    expect(reuse.find).not.toHaveBeenCalled();
  });

  it("dit pourquoi la recherche n'a pas eu lieu (contrôle d'opposition indisponible, identité insuffisante)", async () => {
    db.failTable = "information_agent_identity_oppositions";
    expect((await draftSearch(ENABLED)).noAddressNote).toContain(
      "contrôle d’opposition est indisponible",
    );
    db.failTable = null;
    const result = await draftSearch(ENABLED, { sale: sale({ lawyer_name: "Me Dupont" }) });
    expect(result.noAddressNote).toContain("manque pour contrôler l’opposition");
    const nothing = await draftSearch(ENABLED);
    expect(nothing.noAddressNote).toContain("n’a retrouvé aucune adresse sûre");
  });
});

describe("garde d'envoi d'une adresse trouvée par l'agent", () => {
  it("refuse l'envoi quand la recherche est coupée, l'autorise sinon", () => {
    const refused =
      "La recherche automatique d’adresse est désactivée : cette adresse ne peut pas être utilisée pour un envoi.";
    expect(() => assertInformationAgentSearchedAddressAllowed({ automated: true }, {})).toThrow(
      refused,
    );
    expect(() =>
      assertInformationAgentSearchedAddressAllowed(
        { automated: true },
        { INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED: "TRUE" },
      ),
    ).toThrow(refused);
    expect(() =>
      assertInformationAgentSearchedAddressAllowed({ automated: true }, ENABLED),
    ).not.toThrow();
    expect(() =>
      assertInformationAgentSearchedAddressAllowed({ automated: false }, {}),
    ).not.toThrow();
  });
});

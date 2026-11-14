import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sélection des candidats du pilote : une adresse générique porte la clé de sa structure parmi ses clés
 * d'opposition, mais cette clé ne dit pas QUI est le professionnel. La règle « identité complète » et
 * l'identité rendue au pilote ne retiennent donc que les clés de la personne.
 */
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  contactSales: vi.fn(),
  sale: vi.fn(),
  allowed: vi.fn(),
  persist: vi.fn(),
  registry: vi.fn(),
  history: vi.fn(),
  excluded: vi.fn(),
  pending: vi.fn(),
  cooldown: vi.fn(),
  firstRecorded: vi.fn(),
  informed: vi.fn(),
  /** Missions en base (brouillons) et lectures faites, par table. */
  missions: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  // Filtres d'égalité et d'appartenance appliqués aux missions en mémoire ; toute autre table est vide.
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, [value]]);
        return query;
      },
      in: (column: string, values: unknown[]) => {
        filters.push([column, values]);
        return query;
      },
      limit: async () => {
        mocks.reads.push({ table, filters });
        const rows = table === "information_agent_missions" ? mocks.missions : [];
        return {
          data: rows.filter((row) =>
            filters.every(([column, values]) => (values as unknown[]).includes(row[column])),
          ),
          error: null,
        };
      },
    };
    return query;
  };
  return { supabaseAdmin: { rpc: mocks.rpc, from } };
});
vi.mock("@/lib/admin-information-agent-sale", () => ({
  loadInformationAgentContactSales: mocks.contactSales,
  loadAdminInformationAgentSale: mocks.sale,
}));
vi.mock("@/lib/auction-fact-claims", () => ({
  readSaleFactClaims: async () => ({ claims: [], claimsBacked: true }),
}));
vi.mock("@/lib/information-agent/address-deliverability", () => ({
  checkMailDomain: async () => "ok",
  informationAgentAddressCheckEnabled: () => false,
}));
vi.mock("@/lib/information-agent/autopilot-facts", () => ({
  loadAutopilotRegistryFacts: mocks.registry,
  loadAutopilotHistoryFacts: mocks.history,
  loadAutopilotFirstRecordedAt: mocks.firstRecorded,
  loadAutopilotAlreadyInformed: mocks.informed,
}));
vi.mock("@/lib/information-agent/autopilot-settings", () => ({
  loadExcludedIdentityKeys: mocks.excluded,
  loadPendingSimulatedDrafts: mocks.pending,
}));
vi.mock("@/lib/information-agent/recipient-cooldown", () => ({
  assertInformationAgentRecipientCooldown: mocks.cooldown,
}));
vi.mock("@/lib/information-agent/contacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent/contacts")>()),
  assertInformationAgentContactAllowed: mocks.allowed,
  persistInformationAgentContactObservations: mocks.persist,
}));

import { findAutopilotCandidates } from "@/lib/information-agent/autopilot-candidates";
import type { AutopilotSettings } from "@/lib/information-agent/autopilot-rules";
import { PublicApiError } from "@/lib/api-errors";

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-03T09:30:00Z");
const settings = {
  mode: "simulation",
  allowLicitorDecoded: false,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
} as AutopilotSettings;

function sale(overrides: Record<string, unknown>) {
  return {
    id: SALE_ID,
    title: "Appartement Bordeaux",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    tribunal_code: "bordeaux",
    sale_date: "2026-12-20T10:00:00Z",
    starting_price_eur: null,
    source_name: "avoventes",
    source_url: "https://annonces.example.test/avoventes/lot-4",
    sale_procedure: { organizer_type: "pursuing_lawyer" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: { items: [{ id: SALE_ID }] }, error: null });
  // Lecture légère des ventes de la file (annonce et registre interne) : même fiche que la lecture complète.
  mocks.contactSales.mockImplementation(async ({ saleIds }: { saleIds: string[] }) => ({
    sales: new Map(
      await Promise.all(
        saleIds.map(async (saleId) => [saleId, await mocks.sale({ saleId })] as const),
      ),
    ),
    registryReadable: true,
  }));
  mocks.allowed.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined);
  mocks.excluded.mockResolvedValue(new Set());
  mocks.pending.mockResolvedValue({ rows: [], total: 0 });
  mocks.cooldown.mockResolvedValue(undefined);
  mocks.registry.mockResolvedValue({
    firstRecordedAt: "2026-11-01T10:00:00Z",
    observedAt: "2026-11-01T10:00:00Z",
    originKinds: ["sale_listing"],
    licitorDecoded: false,
  });
  mocks.history.mockResolvedValue({
    alreadyInformed: false,
    lastReplyAt: null,
    silentSendsInSixMonths: 0,
    lastSendAt: null,
  });
  // Lectures groupées du tri de la file : adresses enregistrées récemment, personne déjà informé.
  mocks.firstRecorded.mockImplementation(
    async (emails: string[]) => new Map(emails.map((email) => [email, "2026-11-01T10:00:00Z"])),
  );
  mocks.informed.mockImplementation(async (recipients: unknown[]) => recipients.map(() => false));
  mocks.missions = [];
  mocks.reads = [];
});

const search = () => findAutopilotCandidates({ settings, now: NOW, limit: 3, env: {} });

describe("sélection du pilote : identité du professionnel et clé de structure", () => {
  it("adresse générique d'un cabinet sans nom de personne : identité incomplète, écartée par la file", async () => {
    mocks.sale.mockResolvedValue(
      sale({ lawyer_name: "Cabinet", lawyer_contact: "contact@cabinet-durand.example.test" }),
    );
    const result = await search();
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual({ identity_incomplete: 1 });
    // La clé de structure ne suffit pas : refus décidé sur l'annonce, sans examen.
    expect(result.examined).toBe(0);
    expect(mocks.allowed).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("adresse générique d'un avocat nommé : retenue, avec les seules clés de la personne", async () => {
    mocks.sale.mockResolvedValue(
      sale({
        lawyer_name: "Maître Jean Dupont",
        lawyer_contact: "contact@cabinet-durand.example.test",
      }),
    );
    const result = await search();
    expect(result.skipped).toEqual({});
    expect(result.candidates).toEqual([
      {
        saleId: SALE_ID,
        tribunalCode: "bordeaux",
        email: "contact@cabinet-durand.example.test",
        domain: "cabinet-durand.example.test",
        officeCode: null,
        identityKeys: ["lawyer|bordeaux|dupont jean"],
      },
    ]);
    expect(mocks.allowed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        identityKeys: [
          "lawyer|bordeaux|dupont jean",
          "structure|domain|cabinet-durand.example.test",
        ],
        checkKeys: [
          "lawyer|bordeaux|dupont jean",
          "structure|domain|cabinet-durand.example.test",
          "structure|domain|example.test",
        ],
      }),
    );
  });
});

describe("file du pilote : les ventes refusées d'avance ne consomment pas les 25 examens", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  /** Vente dont la seule adresse est une adresse Licitor décodée (registre interne). */
  const licitorOnly = (n: number) =>
    sale({
      id: id(n),
      source_name: "licitor",
      lawyer_name: null,
      lawyer_contact: null,
      registry_contacts: [
        {
          email: `me.avocat${n}@cabinet-licitor-${n}.example.test`,
          displayName: `Maître Paul Licitor${n}`,
          role: "lawyer",
          sourceName: "licitor",
          sourceUrl: `https://annonces.example.test/licitor/${n}`,
          observedAt: "2026-11-01T10:00:00Z",
        },
      ],
    });
  const eligible = (n: number) =>
    sale({
      id: id(n),
      lawyer_name: `Maître Jean Dupont${n}`,
      lawyer_contact: `me.dupont${n}@cabinet-dupont-${n}.example.test`,
    });

  function queue(sales: Array<ReturnType<typeof sale>>) {
    const byId = new Map(sales.map((item) => [item.id as string, item]));
    mocks.rpc.mockImplementation(
      async (_name: string, args: { p_limit: number; p_offset: number }) => ({
        data: {
          items: sales
            .slice(args.p_offset, args.p_offset + args.p_limit)
            .map((item) => ({ id: item.id })),
        },
        error: null,
      }),
    );
    mocks.sale.mockImplementation(async ({ saleId }: { saleId: string }) => byId.get(saleId));
    mocks.registry.mockImplementation(async (email: string) => ({
      firstRecordedAt: "2026-11-01T10:00:00Z",
      observedAt: "2026-11-01T10:00:00Z",
      originKinds: ["sale_listing"],
      licitorDecoded: email.includes("licitor"),
    }));
  }

  it("30 ventes Licitor décodées en tête de file : des candidats au-delà, sans examen de ces 30", async () => {
    queue([
      ...Array.from({ length: 30 }, (_, n) => licitorOnly(n)),
      ...Array.from({ length: 10 }, (_, n) => eligible(100 + n)),
    ]);
    const result = await search();
    expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([
      id(100),
      id(101),
      id(102),
    ]);
    expect(result.skipped).toEqual({ licitor_decoded_refused: 30 });
    expect(result.examined).toBe(3);
    // Aucun relevé enregistré ni aucune lecture du registre pour les ventes écartées d'avance.
    expect(mocks.persist).toHaveBeenCalledTimes(3);
    expect(mocks.registry).toHaveBeenCalledTimes(3);
  });

  it("toute une page de ventes refusées d'avance : la page suivante de la file est lue", async () => {
    const soon = (n: number) => ({ ...eligible(n), sale_date: "2026-11-08T10:00:00Z" });
    queue([
      ...Array.from({ length: 60 }, (_, n) => licitorOnly(n)),
      ...Array.from({ length: 60 }, (_, n) => soon(200 + n)),
      eligible(300),
    ]);
    const result = await search();
    expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(300)]);
    expect(result.skipped).toEqual({ licitor_decoded_refused: 60, sale_too_soon: 60 });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "admin_information_agent_queue",
      expect.objectContaining({ p_offset: 100, p_class: "A" }),
    );
  });

  it("la borne de 25 examens réels par passage tient", async () => {
    // Ventes examinées puis refusées par la vérification complète (réponse reçue il y a moins de 90 jours).
    queue(Array.from({ length: 40 }, (_, n) => eligible(400 + n)));
    mocks.history.mockResolvedValue({
      alreadyInformed: false,
      lastReplyAt: "2026-11-01T10:00:00Z",
      silentSendsInSixMonths: 0,
      lastSendAt: null,
    });
    const result = await search();
    expect(result.examined).toBe(25);
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual({ reply_pause: 25 });
  });

  it("borne de temps (passage à la demande) : aucun examen n'est entamé une fois l'heure passée", async () => {
    queue(Array.from({ length: 40 }, (_, n) => eligible(400 + n)));
    mocks.history.mockResolvedValue({
      alreadyInformed: false,
      lastReplyAt: "2026-11-01T10:00:00Z",
      silentSendsInSixMonths: 0,
      lastSendAt: null,
    });
    // L'heure est passée après le 4e examen (chaque examen lit le registre une fois).
    const result = await findAutopilotCandidates({
      settings,
      now: NOW,
      limit: 3,
      env: {},
      shouldStop: () => mocks.registry.mock.calls.length >= 4,
    });
    expect(result.examined).toBe(4);
    expect(mocks.registry).toHaveBeenCalledTimes(4);
  });

  describe("avocat d'une annonce de vente notariale : la garde des envois aux notaires le refusera", () => {
    // Organisateur déclaré « avocat poursuivant » sur une annonce de `notaires` : le bloc avocat est un avocat,
    // mais la vente est notariale (`sale_audience = notary`), dont les envois restent fermés par défaut.
    const notarialSale = () =>
      sale({
        source_name: "notaires",
        source_url: "https://annonces.example.test/notaires/vente-1",
        lawyer_name: null,
        lawyer_contact: null,
        information_agent_organizer_type: "pursuing_lawyer",
        listing_contact_blocks: [
          {
            sourceName: "notaires",
            sourceUrl: "https://annonces.example.test/notaires/vente-1",
            officeCode: null,
            contact: [],
            manager: [],
            lawyer: [
              {
                email: "me.durand@cabinet-durand.example.test",
                name: "Maître Paul Durand",
                field: "source_blocks.lawyer.email",
                principal: true,
                addressKind: "nominative",
              },
            ],
          },
        ],
      });

    it("écarté par la file, sans examen ni rejet de politique à l'aperçu", async () => {
      mocks.sale.mockResolvedValue(notarialSale());
      const result = await search();
      expect(result.candidates).toEqual([]);
      expect(result.skipped).toEqual({ notary_send_closed: 1 });
      expect(result.examined).toBe(0);
      expect(mocks.persist).not.toHaveBeenCalled();
    });

    it("retenu quand le réglage ouvre les envois aux notaires (même règle que la garde)", async () => {
      mocks.sale.mockResolvedValue(notarialSale());
      const result = await findAutopilotCandidates({
        settings,
        now: NOW,
        limit: 3,
        env: { INFORMATION_AGENT_NOTARY_SEND_ENABLED: "true" },
      });
      expect(result.skipped).toEqual({});
      expect(result.candidates.map((candidate) => candidate.email)).toEqual([
        "me.durand@cabinet-durand.example.test",
      ]);
    });
  });

  describe("article 14 et brouillon d'administrateur : décidés par lectures groupées, sans examen", () => {
    const DAY_MS = 86_400_000;
    const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
    const emailOf = (n: number) => `me.dupont${n}@cabinet-dupont-${n}.example.test`;
    /** Premier enregistrement de chaque adresse au registre ; absente : inconnue du registre. */
    function firstRecorded(dates: Map<string, string>) {
      mocks.firstRecorded.mockImplementation(
        async (emails: string[]) =>
          new Map(
            emails.flatMap((email) => (dates.has(email) ? [[email, dates.get(email)!]] : [])),
          ),
      );
    }

    it("30 ventes hors délai de l'article 14 en tête de file : des candidats au-delà, sans examen de ces 30", async () => {
      queue([
        ...Array.from({ length: 30 }, (_, n) => eligible(500 + n)),
        ...Array.from({ length: 10 }, (_, n) => eligible(600 + n)),
      ]);
      firstRecorded(
        new Map([
          ...Array.from({ length: 30 }, (_, n) => [emailOf(500 + n), daysAgo(60)] as const),
          ...Array.from({ length: 10 }, (_, n) => [emailOf(600 + n), daysAgo(5)] as const),
        ]),
      );
      const result = await search();
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([
        id(600),
        id(601),
        id(602),
      ]);
      expect(result.skipped).toEqual({ art14_window_expired: 30 });
      expect(result.examined).toBe(3);
      expect(mocks.persist).toHaveBeenCalledTimes(3);
      expect(mocks.registry).toHaveBeenCalledTimes(3);
      // Envois précédents lus pour les seules adresses hors délai, en une fois.
      expect(mocks.informed).toHaveBeenCalledOnce();
      expect(mocks.informed.mock.calls[0][0]).toHaveLength(30);
    });

    it("adresse vue il y a 29 jours : retenue ; 31 jours : écartée par la file", async () => {
      queue([eligible(510), eligible(511)]);
      firstRecorded(
        new Map([
          [emailOf(510), daysAgo(31)],
          [emailOf(511), daysAgo(29)],
        ]),
      );
      const result = await search();
      expect(result.skipped).toEqual({ art14_window_expired: 1 });
      expect(result.examined).toBe(1);
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(511)]);
    });

    it("réglage `art14RuleEnabled` faux en base : la règle s'applique quand même (J9, décision du 14/11/2026)", async () => {
      queue(Array.from({ length: 5 }, (_, n) => eligible(520 + n)));
      firstRecorded(
        new Map(Array.from({ length: 5 }, (_, n) => [emailOf(520 + n), daysAgo(60)] as const)),
      );
      const result = await findAutopilotCandidates({
        settings: { ...settings, art14RuleEnabled: false },
        now: NOW,
        limit: 3,
        env: {},
      });
      expect(result.skipped).toEqual({ art14_window_expired: 5 });
      expect(result.candidates).toEqual([]);
      expect(result.examined).toBe(0);
      expect(mocks.firstRecorded).toHaveBeenCalledOnce();
    });

    it("délai enregistré au-delà de 90 jours : plafonné à 90 dans la file aussi", async () => {
      queue([eligible(525), eligible(526)]);
      firstRecorded(
        new Map([
          [emailOf(525), daysAgo(120)],
          [emailOf(526), daysAgo(80)],
        ]),
      );
      const result = await findAutopilotCandidates({
        settings: { ...settings, art14MaxAgeDays: 365 },
        now: NOW,
        limit: 3,
        env: {},
      });
      expect(result.skipped).toEqual({ art14_window_expired: 1 });
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(526)]);
    });

    it("une seule lecture groupée par page de 100 ventes (premier enregistrement, brouillons)", async () => {
      queue(Array.from({ length: 150 }, (_, n) => eligible(1000 + n)));
      firstRecorded(
        new Map(Array.from({ length: 150 }, (_, n) => [emailOf(1000 + n), daysAgo(60)] as const)),
      );
      const result = await search();
      expect(result.examined).toBe(0);
      expect(result.skipped).toEqual({ art14_window_expired: 150 });
      expect(mocks.firstRecorded).toHaveBeenCalledTimes(2);
      expect(mocks.firstRecorded.mock.calls.map(([emails]) => emails.length)).toEqual([100, 50]);
      // Brouillons simulés en attente (T1) : lus avec le même tri, une fois par page.
      expect(mocks.pending.mock.calls.map(([args]) => args.saleIds.length)).toEqual([100, 50]);
      expect(mocks.informed).toHaveBeenCalledTimes(2);
      const draftReads = mocks.reads.filter((read) => read.table === "information_agent_missions");
      expect(draftReads).toHaveLength(2);
    });

    it("adresse hors délai déjà informée : laissée à l'examen, qui l'admet (même règle)", async () => {
      queue([eligible(530)]);
      firstRecorded(new Map([[emailOf(530), daysAgo(60)]]));
      mocks.informed.mockResolvedValue([true]);
      mocks.registry.mockResolvedValue({
        firstRecordedAt: daysAgo(60),
        observedAt: daysAgo(1),
        originKinds: ["sale_listing"],
        licitorDecoded: false,
      });
      mocks.history.mockResolvedValue({
        alreadyInformed: true,
        lastReplyAt: null,
        silentSendsInSixMonths: 0,
        lastSendAt: null,
      });
      const result = await search();
      expect(result.skipped).toEqual({});
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(530)]);
    });

    it("envois précédents illisibles en entier : rien n'est écarté pour l'article 14, l'examen décide", async () => {
      queue([eligible(540)]);
      firstRecorded(new Map([[emailOf(540), daysAgo(60)]]));
      mocks.informed.mockResolvedValue(null);
      mocks.registry.mockResolvedValue({
        firstRecordedAt: daysAgo(60),
        observedAt: daysAgo(1),
        originKinds: ["sale_listing"],
        licitorDecoded: false,
      });
      const result = await search();
      expect(result.examined).toBe(1);
      // La vérification complète reste la garde finale.
      expect(result.skipped).toEqual({ art14_window_expired: 1 });
    });

    it("adresse inconnue du registre : laissée à l'examen, qui l'enregistre d'abord", async () => {
      queue([eligible(550)]);
      firstRecorded(new Map());
      const result = await search();
      expect(result.examined).toBe(1);
      expect(mocks.informed).not.toHaveBeenCalled();
      expect(mocks.persist).toHaveBeenCalledOnce();
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(550)]);
    });

    it("brouillon d'un administrateur sur la vente : écartée par la file ; brouillon du pilote : non", async () => {
      queue([eligible(560), eligible(561), eligible(562), eligible(563)]);
      mocks.missions = [
        { sale_id: id(560), status: "draft", metadata: { trigger: "manual" } },
        { sale_id: id(561), status: "draft", metadata: { trigger: "autopilot" } },
        { sale_id: id(562), status: "sent", metadata: {} },
      ];
      const result = await search();
      expect(result.skipped).toEqual({ admin_draft_exists: 1 });
      expect(result.examined).toBe(3);
      expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([
        id(561),
        id(562),
        id(563),
      ]);
    });
  });
});

describe("T1 (14/11/2026) : aucun brouillon caduc ne part en aperçu", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const DUPONT = "me.dupont@cabinet-dupont.example.test";
  /** Vente de Maître Dupont (même avocat, même adresse) ou d'un autre avocat. */
  const saleOf = (n: number, lawyer: "dupont" | "autre") =>
    sale({
      id: id(n),
      lawyer_name: lawyer === "dupont" ? "Maître Jean Dupont" : `Maître Paul Martin${n}`,
      lawyer_contact:
        lawyer === "dupont" ? DUPONT : `me.martin${n}@cabinet-martin-${n}.example.test`,
    });

  function queue(sales: Array<ReturnType<typeof sale>>) {
    const byId = new Map(sales.map((item) => [item.id as string, item]));
    mocks.rpc.mockResolvedValue({
      data: { items: sales.map((item) => ({ id: item.id })) },
      error: null,
    });
    mocks.sale.mockImplementation(async ({ saleId }: { saleId: string }) => byId.get(saleId));
  }

  it("envoi manuel à un avocat qui a 3 ventes candidates : ses autres ventes sont écartées avant tout brouillon", async () => {
    // Ventes 1 à 3 : Maître Dupont. Le propriétaire a envoyé à la main le brouillon de la vente 1 (elle quitte
    // la file) ; les ventes 2 et 3 ont un brouillon simulé en attente ; la vente 4 (Dupont) n'en a pas ; la
    // vente 5 est celle d'un autre avocat.
    queue([saleOf(2, "dupont"), saleOf(3, "dupont"), saleOf(4, "dupont"), saleOf(5, "autre")]);
    mocks.pending.mockResolvedValue({
      rows: [
        { id: "draft-2", sale_id: id(2), created_at: "2026-11-16T08:30:00Z" },
        { id: "draft-3", sale_id: id(3), created_at: "2026-11-16T08:30:00Z" },
      ],
      total: 2,
    });
    mocks.cooldown.mockImplementation(async ({ email }: { email: string }) => {
      if (email === DUPONT) {
        throw new PublicApiError("Ce destinataire a déjà été sollicité le 17/11/2026.", 409);
      }
    });

    const result = await search();

    expect(result.candidates.map((candidate) => candidate.saleId)).toEqual([id(5)]);
    expect(result.skipped).toEqual({ simulated_draft_pending: 2, recipient_cooldown: 1 });
    // Les ventes déjà simulées sont écartées par la file : ni examen, ni relevé enregistré.
    expect(result.examined).toBe(2);
    expect(mocks.persist).toHaveBeenCalledTimes(2);
    expect(mocks.pending).toHaveBeenCalledWith(
      expect.objectContaining({ saleIds: [id(2), id(3), id(4), id(5)] }),
    );
  });

  it("délai de 30 jours : vérifié avec l'adresse et toutes les clés d'identité, comme à la création du brouillon", async () => {
    mocks.sale.mockResolvedValue(
      sale({
        lawyer_name: "Maître Jean Dupont",
        lawyer_contact: "contact@cabinet-durand.example.test",
      }),
    );
    await search();
    expect(mocks.cooldown).toHaveBeenCalledExactlyOnceWith({
      email: "contact@cabinet-durand.example.test",
      identityKeys: ["lawyer|bordeaux|dupont jean", "structure|domain|cabinet-durand.example.test"],
      now: NOW,
    });
  });

  it("une lecture impossible du délai de 30 jours remonte : elle n'écarte ni n'admet personne", async () => {
    mocks.sale.mockResolvedValue(
      sale({ lawyer_name: "Maître Jean Dupont", lawyer_contact: DUPONT }),
    );
    mocks.cooldown.mockRejectedValue(new Error("base indisponible"));
    await expect(search()).rejects.toThrow("base indisponible");
  });
});

describe("contrôle d'opposition à la sélection : un motif par cause, fermé en cas de panne", () => {
  beforeEach(() => {
    mocks.sale.mockResolvedValue(
      sale({
        lawyer_name: "Maître Jean Dupont",
        lawyer_contact: "me.dupont@cabinet-dupont.example.test",
      }),
    );
  });

  it.each([
    [
      "opposition ou rebond définitif (409)",
      new PublicApiError("Le contact est opposé.", 409),
      "opposed",
    ],
    [
      "adresse exclue ou structure inconnue (400)",
      new PublicApiError("Adresse exclue.", 400),
      "address_excluded",
    ],
  ])("%s", async (_name, error, code) => {
    mocks.allowed.mockRejectedValue(error);
    const result = await search();
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual({ [code]: 1 });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("panne (base, registre) : candidat écarté sous son propre code, journalisé sans message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.allowed.mockRejectedValue({
      code: "57014",
      message: "timeout me.dupont@cabinet-dupont.example.test",
    });
    const result = await search();
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual({ opposition_check_failed: 1 });
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      code: "opposition_check_failed",
      saleId: SALE_ID,
      error: { code: "57014" },
    });
    expect(line).not.toContain("@");
    logged.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Seul `createClient` de supabase-js est remplacé : la garde d'accès, la lecture et l'écriture
 * réelles tournent. Chaque client créé garde la clé et l'en-tête `Authorization` reçus, et son
 * `rpc` RÉUSSIT quel que soit le client : un appel par le client de service ne ferait donc pas
 * échouer la route, seule l'assertion sur le client appelé le détecte.
 */
type FakeClient = {
  key: string;
  authorization: string | null;
  rpc: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  auth: { getClaims: ReturnType<typeof vi.fn> };
};

const state = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  profileRole: "admin" as string | null,
  rpcResult: { data: null as unknown, error: null as unknown },
  tables: {} as Record<string, unknown[]>,
  filters: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock("@supabase/supabase-js", async () => {
  const { vi: mockVi } = await import("vitest");
  return {
    createClient: (
      _url: string,
      key: string,
      options?: { global?: { headers?: Record<string, string> } },
    ) => {
      const client: FakeClient = {
        key,
        authorization: options?.global?.headers?.Authorization ?? null,
        rpc: mockVi.fn(async () => state.rpcResult),
        auth: {
          getClaims: mockVi.fn(async () => ({
            data: { claims: { sub: ADMIN_ID } },
            error: null,
          })),
        },
        from: mockVi.fn((table: string) => {
          const result = {
            data: state.tables[table] ?? [],
            error: null,
            count: (state.tables[table] ?? []).length,
          };
          const query: Record<string, unknown> = {
            maybeSingle: async () => ({
              data: state.profileRole
                ? { account_tier: "premium", user_role: state.profileRole }
                : null,
              error: null,
            }),
            then: (onFulfilled: (value: typeof result) => unknown) =>
              Promise.resolve(result).then(onFulfilled),
          };
          for (const method of ["select", "eq", "in", "not", "order", "range"]) {
            query[method] = (...args: unknown[]) => {
              state.filters.push({ table, method, args });
              return query;
            };
          }
          return query;
        }),
      };
      state.clients.push(client);
      return client;
    },
  };
});

import { FACT_CLAIM_DATABASE_ERROR_CODES } from "@/lib/fact-claim-database-errors";
import { GET, POST } from "./route";

const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const DECISION_ID = "44444444-4444-4444-8444-444444444444";
const USER_TOKEN = "jeton-de-l-administrateur";
const SERVICE_KEY = "cle-de-service";
const PUBLISHABLE_KEY = "cle-publique";
const URL = "https://example.test/api/admin/fact-claims/decisions";

function post(body: unknown, token: string | null = USER_TOKEN): Promise<Response> {
  return POST(
    new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

const sessionClients = () => state.clients.filter((client) => client.key === PUBLISHABLE_KEY);
const serviceClients = () => state.clients.filter((client) => client.key === SERVICE_KEY);
const rpcCalls = (clients: FakeClient[]) => clients.flatMap((client) => client.rpc.mock.calls);

beforeEach(() => {
  // Le client de service est créé une fois par processus : il reste, son historique est vidé.
  state.clients = state.clients.filter((client) => client.key === SERVICE_KEY);
  for (const client of state.clients) client.rpc.mockClear();
  state.filters.length = 0;
  state.profileRole = "admin";
  state.tables = {};
  state.rpcResult = {
    data: {
      claim_id: CLAIM_ID,
      decision_id: DECISION_ID,
      decision: "accepted",
      sale_id: SALE_ID,
      field_key: "property.occupancy_status",
      state: "held",
    },
    error: null,
  };
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("route des décisions du registre des pièces : garde d'accès", () => {
  it("répond 401 sans jeton, quel que soit le corps, sans rien appeler", async () => {
    const response = await post({ n: "importe quoi" }, null);

    expect(response.status).toBe(401);
    expect(rpcCalls(state.clients)).toEqual([]);
  });

  it("répond 403 à un compte qui n'est pas administrateur, avant de lire le corps", async () => {
    state.profileRole = "user";

    // Corps invalide : une réponse 400 voudrait dire que le corps a été lu avant la garde.
    const response = await post({ action: "inconnue" });

    expect(response.status).toBe(403);
    expect(rpcCalls(state.clients)).toEqual([]);
  });

  it("répond 403 sur la liste à un compte qui n'est pas administrateur, sans lire la base", async () => {
    state.profileRole = "user";

    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${USER_TOKEN}` } }),
    );

    expect(response.status).toBe(403);
    expect(state.filters.filter((filter) => filter.table !== "user_profiles")).toEqual([]);
  });

  it("ne crée aucun client de service pour la liste d'un compte non administrateur", async () => {
    state.profileRole = "user";
    // Modules neufs : le client de service, créé à sa première utilisation puis gardé pour le
    // processus, n'existe pas encore pour cette route.
    vi.resetModules();
    const fresh = await import("./route");
    const before = serviceClients().length;

    const response = await fresh.GET(
      new Request(URL, { headers: { authorization: `Bearer ${USER_TOKEN}` } }),
    );

    expect(response.status).toBe(403);
    expect(serviceClients()).toHaveLength(before);

    // Contre-épreuve : le même module en crée un dès qu'un administrateur lit la liste.
    state.profileRole = "admin";
    await fresh.GET(new Request(URL, { headers: { authorization: `Bearer ${USER_TOKEN}` } }));
    expect(serviceClients()).toHaveLength(before + 1);
  });
});

describe("route des décisions du registre des pièces : validation", () => {
  it.each([
    [
      "identifiant d'observation invalide",
      { action: "reject", claimId: "abc", reasonCode: "other" },
    ],
    ["décision hors liste", { action: "delete", claimId: CLAIM_ID }],
    ["décision absente", { claimId: CLAIM_ID }],
    ["rejet sans motif", { action: "reject", claimId: CLAIM_ID }],
    ["motif hors liste", { action: "reject", claimId: CLAIM_ID, reasonCode: "parce que" }],
    [
      "motif de retrait donné à un rejet",
      { action: "reject", claimId: CLAIM_ID, reasonCode: "authorization_withdrawn" },
    ],
    ["motif trop long", { action: "withdraw", claimId: CLAIM_ID, reasonCode: "x".repeat(5000) }],
    ["acceptation sans rattachement au lot", { action: "accept", claimId: CLAIM_ID }],
    [
      "rattachement hors liste",
      { action: "accept", claimId: CLAIM_ID, lotAttachment: "peut-être" },
    ],
    [
      "libellé de lot trop long",
      { action: "accept", claimId: CLAIM_ID, lotAttachment: "matched", lotRef: "1".repeat(41) },
    ],
    [
      "décision remplacée invalide",
      {
        action: "accept",
        claimId: CLAIM_ID,
        lotAttachment: "single_lot",
        supersedesDecisionId: "x",
      },
    ],
    ["auteur fourni par le navigateur", { action: "oppose", claimId: CLAIM_ID, actorId: ADMIN_ID }],
    [
      "motif libre sur une opposition",
      { action: "oppose", claimId: CLAIM_ID, reasonCode: "other" },
    ],
  ])("refuse en 400 : %s", async (_name, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(rpcCalls(state.clients)).toEqual([]);
  });
});

describe("route des décisions du registre des pièces : écriture au nom de l'administrateur", () => {
  it("appelle la base avec le client de la session, jamais avec le client de service", async () => {
    // La liste fait d'abord travailler le client de service : il existe donc bien, avec un rpc
    // qui réussirait.
    await GET(new Request(URL, { headers: { authorization: `Bearer ${USER_TOKEN}` } }));
    expect(serviceClients().length).toBeGreaterThan(0);

    const response = await post({
      action: "accept",
      claimId: CLAIM_ID,
      lotAttachment: "matched",
      lotRef: " lot 2 ",
      supersedesDecisionId: DECISION_ID,
    });

    expect(response.status).toBe(200);
    expect(rpcCalls(serviceClients())).toEqual([]);
    const callers = sessionClients().filter((client) => client.rpc.mock.calls.length > 0);
    expect(callers).toHaveLength(1);
    expect(callers[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(callers[0].rpc.mock.calls).toEqual([
      [
        "accept_auction_fact_claim",
        {
          p_claim_id: CLAIM_ID,
          p_lot_attachment: "matched",
          p_lot_ref: "lot 2",
          p_supersedes_decision_id: DECISION_ID,
        },
      ],
    ]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        claimId: CLAIM_ID,
        decisionId: DECISION_ID,
        decision: "accepted",
        saleId: SALE_ID,
        fieldKey: "property.occupancy_status",
        state: "held",
      },
    });
  });

  it.each([
    [
      { action: "reject", claimId: CLAIM_ID, reasonCode: "doubtful_statement" },
      ["reject_auction_fact_claim", { p_claim_id: CLAIM_ID, p_reason_code: "doubtful_statement" }],
    ],
    [
      { action: "withdraw", claimId: CLAIM_ID, reasonCode: "authorization_withdrawn" },
      [
        "withdraw_auction_fact_claim",
        { p_claim_id: CLAIM_ID, p_reason_code: "authorization_withdrawn" },
      ],
    ],
    [
      { action: "oppose", claimId: CLAIM_ID },
      ["oppose_auction_fact_claim", { p_claim_id: CLAIM_ID }],
    ],
  ])(
    "appelle la fonction de la décision demandée (%o), sans paramètre d'auteur",
    async (body, call) => {
      const response = await post(body);

      expect(response.status).toBe(200);
      expect(rpcCalls(sessionClients())).toEqual([call]);
      expect(rpcCalls(serviceClients())).toEqual([]);
    },
  );
});

describe("route des décisions du registre des pièces : erreurs de la base", () => {
  // Figé en dur : SQLSTATE levé par la base, statut HTTP et message attendus. La table de
  // l'application n'est pas comparée à elle-même.
  const SALE_BUSY = "Import en cours sur cette vente, réessayez dans une minute.";
  const FINAL = "Décision définitive, elle ne peut plus être modifiée.";
  const EXPECTED: Array<[code: string, sqlstate: string, status: number, message: string]> = [
    ["admin_required", "42501", 403, "Action réservée aux administrateurs."],
    [
      "second_factor_required",
      "42501",
      403,
      "Cette décision demande la double authentification. Activez-la dans Sécurité, puis reconnectez-vous.",
    ],
    [
      "rate_limited",
      "53400",
      429,
      "Plafond de décisions atteint pour cette heure. Réessayez plus tard.",
    ],
    [
      "final_rate_limited",
      "53400",
      429,
      "Plafond de décisions définitives atteint pour aujourd'hui. Réessayez demain.",
    ],
    [
      "decision_in_progress",
      "55000",
      409,
      "Une autre décision est en cours avec votre compte. Attendez quelques secondes, puis réessayez.",
    ],
    ["sale_busy", "55P03", 409, SALE_BUSY],
    ["retry", "40001", 409, SALE_BUSY],
    ["invalid_transition", "55000", 409, "Cette observation a déjà été traitée."],
    ["opposed_final", "55000", 409, FINAL],
    ["withdrawal_final", "55000", 409, FINAL],
    [
      "origin_cannot_hold",
      "55000",
      409,
      "L'origine de cette observation ne permet pas d'afficher sa valeur sur la fiche. Elle ne peut pas être acceptée.",
    ],
    [
      "field_not_applicable",
      "55000",
      409,
      "Une surface bâtie ne peut pas être acceptée sur une vente de terrain.",
    ],
    [
      "claim_detached",
      "55000",
      409,
      "Cette observation n'est plus rattachée à une vente (doublons fusionnés). Elle reviendra sur la vente conservée.",
    ],
    ["claim_not_found", "P0002", 404, "Observation introuvable."],
    ["sale_not_found", "P0002", 404, "Vente introuvable."],
    ["invalid_reason_code", "22023", 400, "Motif non reconnu."],
    ["invalid_lot_attachment", "22023", 400, "Rattachement au lot non reconnu."],
    [
      "invalid_argument",
      "22023",
      400,
      "Cette valeur ne peut pas être affichée sur la fiche, ou la demande est incomplète.",
    ],
    [
      "registry_unavailable",
      "55000",
      503,
      "Le registre des pièces est indisponible. Aucune décision n'a été enregistrée. Prévenez l'équipe technique.",
    ],
    [
      "registry_write_failed",
      "P0001",
      500,
      "La décision n'a pas pu être enregistrée et rien n'a été modifié. Réessayez ; si l'erreur persiste, prévenez l'équipe technique.",
    ],
  ];

  it("fige un statut et un message pour chaque code traduit", () => {
    expect(EXPECTED.map(([code]) => code).sort()).toEqual(
      Object.keys(FACT_CLAIM_DATABASE_ERROR_CODES).sort(),
    );
    for (const [, , , message] of EXPECTED) expect(message).not.toMatch(/[—–]/);
  });

  it.each(EXPECTED)("traduit %s (%s) en %i", async (code, sqlstate, status, message) => {
    state.rpcResult = {
      data: null,
      error: { code: sqlstate, message: code, details: null, hint: null },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toBe(message);
    expect(body.ok).toBe(false);
    // Ni le code de la base ni son SQLSTATE ne partent vers le navigateur.
    const text = JSON.stringify(body);
    expect(text).not.toContain(code);
    expect(text).not.toContain(sqlstate);
  });

  it("ne dit pas « déjà traité » pour un 55000 au code inconnu, et ne journalise que deux codes", async () => {
    const warn = vi.mocked(console.warn);
    const error = vi.mocked(console.error);
    state.rpcResult = {
      data: null,
      error: {
        code: "55000",
        message: "code_pas_encore_traduit",
        details: "Failing row contains (12 rue des Lilas).",
        hint: null,
      },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("La décision n'a pas pu être enregistrée.");
    expect(JSON.stringify(body)).not.toContain("code_pas_encore_traduit");
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(logged).toContain("Unhandled database error [55000] [code_pas_encore_traduit]");
    expect(logged).not.toContain("Lilas");
  });

  it("ne journalise pas le texte d'une erreur qui n'a pas la forme d'un code", async () => {
    const error = vi.mocked(console.error);
    state.rpcResult = {
      data: null,
      error: {
        code: "55000",
        message: "Row (12 rue des Lilas) is locked",
        details: null,
        hint: null,
      },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(500);
    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toContain("Unhandled database error [55000] [-]");
    expect(logged).not.toContain("Lilas");
  });

  it("ne relaie rien d'une erreur de la base hors liste", async () => {
    state.rpcResult = {
      data: null,
      error: {
        code: "23514",
        message:
          'new row for relation "auction_sales" violates check constraint "auction_sales_rooms_check"',
        details: "Failing row contains (12 rue des Lilas, 54, vacant).",
        hint: null,
      },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("La décision n'a pas pu être enregistrée.");
    for (const leak of ["23514", "auction_sales", "constraint", "Lilas", "Failing"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("traduit un refus de droit de PostgREST (fonction pas encore ouverte) sans le citer", async () => {
    state.rpcResult = {
      data: null,
      error: {
        code: "42501",
        message: "permission denied for function oppose_auction_fact_claim",
        details: null,
        hint: null,
      },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Action non autorisée.");
    expect(JSON.stringify(body)).not.toContain("permission denied");
  });
});

describe("route des décisions du registre des pièces : liste", () => {
  const claim = (id: string, kind: string) => ({
    claim_id: id,
    auction_sale_id: SALE_ID,
    field_key: "property.occupancy_status",
    value_jsonb: "vacant",
    evidence_kind: kind,
    source_url: "javascript:alert(1)",
    captured_at: "2026-11-10T09:00:00Z",
    created_at: "2026-11-10T09:00:00Z",
  });
  const OTHER_CLAIM = "55555555-5555-4555-8555-555555555555";

  beforeEach(() => {
    state.tables = {
      v_auction_fact_claims_read_model: [
        claim(CLAIM_ID, "professional_email"),
        claim(OTHER_CLAIM, "admin_entry"),
      ],
      auction_sales: [
        {
          id: SALE_ID,
          title: "Appartement T3",
          city: "Bordeaux",
          sale_date: null,
          occupancy_status: "occupied",
        },
      ],
      // Rendu par seq décroissant : la première ligne d'une observation est sa dernière décision.
      auction_fact_claim_decisions: [
        {
          id: DECISION_ID,
          claim_id: CLAIM_ID,
          decision: "withdrawn",
          reason_code: "authorization_withdrawn",
          lot_attachment: "single_lot",
          decided_at: "2026-11-12T10:00:00Z",
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          claim_id: CLAIM_ID,
          decision: "accepted",
          reason_code: null,
          lot_attachment: "single_lot",
          decided_at: "2026-11-11T10:00:00Z",
        },
      ],
    };
  });

  it("rend, par observation, la valeur proposée, la valeur affichée, l'état et les actions", async () => {
    const response = await GET(
      new Request(`${URL}?saleId=${SALE_ID}`, {
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      claimId: CLAIM_ID,
      saleId: SALE_ID,
      fieldKey: "property.occupancy_status",
      value: "vacant",
      currentValue: "occupied",
      origin: "professional_email",
      // Un lien qui n'est pas en http(s) n'est pas rendu.
      sourceUrl: null,
      sale: { title: "Appartement T3", city: "Bordeaux" },
      latestDecision: { id: DECISION_ID, decision: "withdrawn" },
      allowedActions: ["oppose"],
    });
    expect(body.items[1]).toMatchObject({
      claimId: OTHER_CLAIM,
      latestDecision: null,
      allowedActions: ["accept", "reject", "oppose"],
    });
    expect(state.filters).toContainEqual({
      table: "v_auction_fact_claims_read_model",
      method: "eq",
      args: ["auction_sale_id", SALE_ID],
    });
    expect(state.filters).toContainEqual({
      table: "auction_fact_claim_decisions",
      method: "order",
      args: ["seq", { ascending: false }],
    });
  });

  it("n'invente pas de valeur affichée pour un champ sans colonne connue", async () => {
    state.tables.v_auction_fact_claims_read_model = [
      { ...claim(CLAIM_ID, "professional_email"), field_key: "property.property_type" },
    ];

    const response = await GET(
      new Request(`${URL}?saleId=${SALE_ID}`, {
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }),
    );

    const [item] = (await response.json()).items;
    expect(item.fieldKey).toBe("property.property_type");
    expect("currentValue" in item).toBe(false);
  });

  it("sans vente choisie, ne lit que les origines réservées au registre", async () => {
    await GET(new Request(URL, { headers: { authorization: `Bearer ${USER_TOKEN}` } }));

    expect(state.filters).toContainEqual({
      table: "v_auction_fact_claims_read_model",
      method: "in",
      args: ["evidence_kind", ["professional_email", "professional_form", "admin_entry"]],
    });
  });

  it("refuse un identifiant de vente invalide", async () => {
    const response = await GET(
      new Request(`${URL}?saleId=1%20or%201=1`, {
        headers: { authorization: `Bearer ${USER_TOKEN}` },
      }),
    );

    expect(response.status).toBe(400);
  });
});

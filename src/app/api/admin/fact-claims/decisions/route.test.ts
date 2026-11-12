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
      field_key: "property.surface_m2",
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
    expect(serviceClients()).toHaveLength(1);

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
        fieldKey: "property.surface_m2",
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
  const SQLSTATES: Record<string, string> = {
    admin_required: "42501",
    second_factor_required: "42501",
    rate_limited: "53400",
    final_rate_limited: "53400",
    sale_busy: "55P03",
    retry: "40001",
    claim_not_found: "P0002",
    sale_not_found: "P0002",
    invalid_reason_code: "22023",
    invalid_lot_attachment: "22023",
    invalid_argument: "22023",
    registry_write_failed: "P0001",
  };

  it.each(Object.entries(FACT_CLAIM_DATABASE_ERROR_CODES))("traduit %s", async (code, expected) => {
    const sqlstate = SQLSTATES[code] ?? "55000";
    state.rpcResult = {
      data: null,
      error: { code: sqlstate, message: code, details: null, hint: null },
    };

    const response = await post({ action: "oppose", claimId: CLAIM_ID });

    expect(response.status).toBe(expected.status);
    const body = await response.json();
    expect(body.error).toBe(expected.message);
    expect(body.ok).toBe(false);
    // Ni le code de la base ni son SQLSTATE ne partent vers le navigateur.
    const text = JSON.stringify(body);
    expect(text).not.toContain(code);
    expect(text).not.toContain(sqlstate);
  });

  it("donne les messages attendus par l'écran", () => {
    expect(FACT_CLAIM_DATABASE_ERROR_CODES.sale_busy.message).toBe(
      "Import en cours sur cette vente, réessayez dans une minute.",
    );
    expect(FACT_CLAIM_DATABASE_ERROR_CODES.invalid_transition.message).toBe(
      "Cette observation a déjà été traitée.",
    );
    expect(FACT_CLAIM_DATABASE_ERROR_CODES.opposed_final.message).toBe(
      "Décision définitive, elle ne peut plus être modifiée.",
    );
    expect(FACT_CLAIM_DATABASE_ERROR_CODES.withdrawal_final.message).toBe(
      FACT_CLAIM_DATABASE_ERROR_CODES.opposed_final.message,
    );
    for (const { message } of Object.values(FACT_CLAIM_DATABASE_ERROR_CODES)) {
      expect(message).not.toMatch(/[—–]/);
    }
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
    field_key: "property.surface_m2",
    value_jsonb: 54,
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
        { id: SALE_ID, title: "Appartement T3", city: "Bordeaux", sale_date: null, surface_m2: 50 },
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
      fieldKey: "property.surface_m2",
      value: 54,
      currentValue: 50,
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  ip: vi.fn(),
  // Clés d'identité que l'adresse porte au registre et dans ses demandes (lecture seule de la page).
  contactKeys: [] as string[],
  missionKeys: [] as string[],
  // Panne de la lecture d'information (registre ou demandes) : elle ne doit rien empêcher.
  readError: null as { code: string; message: string } | null,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const query = {
        upsert: mocks.upsert,
        select: () => query,
        eq: () => query,
        ilike: () => query,
        limit: async () =>
          mocks.readError
            ? { data: null, error: mocks.readError }
            : {
                data:
                  table === "information_agent_contacts"
                    ? [{ identity_keys: mocks.contactKeys }]
                    : [{ recipient_identity_keys: mocks.missionKeys }],
                error: null,
              },
      };
      return query;
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ip }));

import { RateLimitError } from "@/lib/api-errors";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-signed-link";
import { GET, POST } from "./route";

const SECRET = "portal-secret-that-is-at-least-32-characters-long";
const EMAIL = "Maitre.Dupont@cabinet.example";

function signedUrl(email = EMAIL) {
  return buildInformationAgentOptOutUrl({ appUrl: "https://immojudis.com", email, secret: SECRET });
}

beforeEach(() => {
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  mocks.ip.mockReset().mockResolvedValue(undefined);
  mocks.contactKeys = ["lawyer|bordeaux|dupont jean"];
  mocks.missionKeys = [];
  mocks.readError = null;
  vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/information-agent/opt-out", () => {
  it("affiche la confirmation sans rien écrire", async () => {
    const response = await GET(new Request(signedUrl()));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Confirmer : ne plus me contacter");
    expect(html).toContain("maitre.dupont@cabinet.example");
    // Adresse d'une personne : l'opposition ne vaut que pour elle, la page ne parle pas de structure.
    expect(html).not.toContain("aucune adresse de cette structure");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("dit que l'opposition vaudra pour toute la structure quand l'adresse en porte la clé", async () => {
    mocks.missionKeys = ["structure|domain|cabinet.example"];
    const html = await (await GET(new Request(signedUrl("contact@cabinet.example")))).text();

    expect(html).toContain(
      "Si vous vous opposez depuis l’adresse de contact d’une étude, d’un cabinet ou d’un service, nous n’écrirons plus à aucune adresse de cette structure.",
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("ne promet pas toute la structure sur une clé qui ne vaut pas pour l'adresse (messagerie partagée, gouv.fr)", async () => {
    for (const [email, key] of [
      ["cabinet.dupont@avocat.fr", "structure|domain|avocat.fr"],
      ["ddfip33@dgfip.finances.gouv.fr", "structure|domain|gouv.fr"],
      ["etude.martin@notaires.fr", "structure|domain|notaires.fr"],
    ]) {
      mocks.missionKeys = [key];
      const html = await (await GET(new Request(signedUrl(email)))).text();
      expect(html, email).toContain("Confirmer : ne plus me contacter");
      expect(html, email).not.toContain("aucune adresse de cette structure");
    }
  });

  it("lecture d'information en panne : la page et son bouton s'affichent quand même, sans adresse au journal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.readError = { code: "57014", message: `timeout while reading ${EMAIL}` };
    mocks.missionKeys = ["structure|domain|cabinet.example"];

    const response = await GET(new Request(signedUrl()));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Confirmer : ne plus me contacter");
    // Texte neutre : la portée sur la structure n'est pas affirmée sans avoir pu la lire.
    expect(html).not.toContain("aucune adresse de cette structure");
    expect(mocks.upsert).not.toHaveBeenCalled();
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("structure_scope");
    expect(logged.toLowerCase()).not.toContain("maitre.dupont");
    expect(logged).not.toContain("@");
  });

  it("refuse un lien falsifié", async () => {
    const forged = new URL(signedUrl());
    forged.searchParams.set("e", Buffer.from("victime@cabinet.example").toString("base64url"));

    expect((await GET(new Request(forged))).status).toBe(400);
  });

  it("limite le débit avec 429 et Retry-After, pas avec le 503 d'une panne", async () => {
    mocks.ip.mockRejectedValueOnce(new RateLimitError(undefined, 37));

    const response = await GET(new Request(signedUrl()));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.text()).not.toContain("n’a pas pu être enregistrée");
  });
});

describe("POST /api/information-agent/opt-out", () => {
  it("enregistre l'opposition globale de l'adresse normalisée et propose l'accès aux données", async () => {
    const response = await POST(new Request(signedUrl(), { method: "POST" }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Opposition enregistrée");
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "maitre.dupont@cabinet.example",
        scope_sale_id: null,
        opposition_status: "opposed",
      }),
      { onConflict: "scope_sale_id,normalized_email" },
    );
    expect(html).not.toContain("les autres adresses de votre étude");
    // Le même lien signé mène à la demande d'accès ou d'effacement.
    const search = new URL(signedUrl()).search;
    expect(html).toContain(`/api/information-agent/rights${search.replace(/&/g, "&amp;")}`);
  });

  it("lecture d'information en panne : l'opposition est enregistrée quand même", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.readError = { code: "57014", message: `timeout while reading ${EMAIL}` };

    const response = await POST(new Request(signedUrl(), { method: "POST" }));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Opposition enregistrée");
    expect(html).toContain(
      "Votre adresse et votre identité professionnelle ne seront plus contactées",
    );
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "maitre.dupont@cabinet.example",
        opposition_status: "opposed",
      }),
      { onConflict: "scope_sale_id,normalized_email" },
    );
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("structure_scope");
    expect(logged).not.toContain("@");
  });

  it("confirme que les autres adresses de la structure ne seront plus contactées", async () => {
    mocks.contactKeys = ["structure|office|33001"];
    const response = await POST(
      new Request(signedUrl("etude@cabinet.example"), { method: "POST" }),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(
      "les autres adresses de votre étude, de votre cabinet ou de votre service ne seront plus contactées",
    );
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it("limite le débit avec 429 et Retry-After, sans écrire, en disant que l'opposition n'est pas enregistrée", async () => {
    mocks.ip.mockRejectedValueOnce(new RateLimitError(undefined, 12));

    const response = await POST(new Request(signedUrl(), { method: "POST" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.text()).toContain("n’a pas encore été enregistrée");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("utilise des seaux de débit distincts pour GET et POST", async () => {
    await GET(new Request(signedUrl()));
    await POST(new Request(signedUrl(), { method: "POST" }));

    const buckets = mocks.ip.mock.calls.map(
      ([options]) => (options as { bucketKey: string }).bucketKey,
    );
    expect(buckets).toEqual(["information-agent.opt-out.get", "information-agent.opt-out.post"]);
  });

  it("répond 503 et journalise l'erreur sans l'adresse ni le message de la base", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.upsert.mockResolvedValue({
      error: {
        code: "23505",
        message: `duplicate key value violates unique constraint (email)=(${EMAIL})`,
      },
    });

    const response = await POST(new Request(signedUrl(), { method: "POST" }));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("n’a pas pu être enregistrée");
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("information-agent.opt-out");
    expect(line).toContain("23505");
    expect(line.toLowerCase()).not.toContain("dupont");
    expect(line).not.toContain("duplicate key");
  });
});

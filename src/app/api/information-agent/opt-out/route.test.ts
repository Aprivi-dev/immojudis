import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  ip: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ upsert: mocks.upsert }) },
}));
vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ip }));

import { RateLimitError } from "@/lib/api-errors";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-opt-out";
import { GET, POST } from "./route";

const SECRET = "portal-secret-that-is-at-least-32-characters-long";
const EMAIL = "Maitre.Dupont@cabinet.example";

function signedUrl(email = EMAIL) {
  return buildInformationAgentOptOutUrl({ appUrl: "https://immojudis.com", email, secret: SECRET });
}

beforeEach(() => {
  mocks.upsert.mockReset().mockResolvedValue({ error: null });
  mocks.ip.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.upsert).not.toHaveBeenCalled();
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
    // Le même lien signé mène à la demande d'accès ou d'effacement.
    const search = new URL(signedUrl()).search;
    expect(html).toContain(`/api/information-agent/rights${search.replace(/&/g, "&#38;")}`);
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

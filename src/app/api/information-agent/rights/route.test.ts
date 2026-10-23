import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ip: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({ enforceIpRateLimit: mocks.ip }));
vi.mock("@/lib/information-agent-professional-rights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/information-agent-professional-rights")>()),
  createProfessionalPrivacyRequest: mocks.create,
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { RateLimitError } from "@/lib/api-errors";
import { buildInformationAgentOptOutUrl } from "@/lib/information-agent-opt-out";
import { GET, POST } from "./route";

const SECRET = "portal-secret-that-is-at-least-32-characters-long";

function linkUrl(email = "Maitre.Dupont@cabinet.example") {
  const url = new URL(
    buildInformationAgentOptOutUrl({ appUrl: "https://immojudis.com", email, secret: SECRET }),
  );
  url.pathname = "/api/information-agent/rights";
  return url;
}

function formPost(url: URL, requestType?: string) {
  const body = new URLSearchParams(requestType ? { requestType } : {});
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

beforeEach(() => {
  mocks.ip.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockResolvedValue({ created: true });
  vi.stubEnv("INFORMATION_AGENT_PORTAL_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("/api/information-agent/rights", () => {
  it("GET propose l'accès et l'effacement sans rien enregistrer", async () => {
    const response = await GET(new Request(linkUrl()));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Obtenir une copie de mes données");
    expect(html).toContain("Demander l’effacement de mes données");
    expect(html).toContain("maitre.dupont@cabinet.example");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["access", "erasure"] as const)(
    "POST %s enregistre la demande de l'adresse du lien signé",
    async (requestType) => {
      const response = await POST(formPost(linkUrl(), requestType));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Demande enregistrée");
      expect(mocks.create).toHaveBeenCalledWith({
        email: "maitre.dupont@cabinet.example",
        requestType,
      });
    },
  );

  it("refuse un type de demande inconnu ou absent", async () => {
    expect((await POST(formPost(linkUrl(), "portability"))).status).toBe(400);
    expect((await POST(formPost(linkUrl()))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuse un lien falsifié : l'adresse ne se choisit pas", async () => {
    const forged = linkUrl();
    forged.searchParams.set("e", Buffer.from("victime@cabinet.example").toString("base64url"));

    expect((await GET(new Request(forged))).status).toBe(400);
    expect((await POST(formPost(forged, "erasure"))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("limite le débit avec 429 et Retry-After, par seau GET / POST", async () => {
    mocks.ip.mockRejectedValueOnce(new RateLimitError(undefined, 21));
    const limited = await POST(formPost(linkUrl(), "access"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("21");
    expect(mocks.create).not.toHaveBeenCalled();

    await GET(new Request(linkUrl()));
    await POST(formPost(linkUrl(), "access"));
    const buckets = mocks.ip.mock.calls.map(
      ([options]) => (options as { bucketKey: string }).bucketKey,
    );
    expect(buckets).toEqual([
      "information-agent.rights.post",
      "information-agent.rights.get",
      "information-agent.rights.post",
    ]);
  });

  it("journalise une panne sans donnée personnelle", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.create.mockRejectedValue(
      Object.assign(new Error("insert failed for maitre.dupont@cabinet.example"), {
        code: "XX000",
      }),
    );

    const response = await POST(formPost(linkUrl(), "erasure"));

    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("information-agent.rights");
    expect(line).toContain("XX000");
    expect(line.toLowerCase()).not.toContain("dupont");
  });
});

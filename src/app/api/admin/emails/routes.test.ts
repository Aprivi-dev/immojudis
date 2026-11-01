import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  designs: vi.fn(),
  addresses: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));
vi.mock("@/lib/admin-emails/designs", () => ({ getEmailDesigns: mocks.designs }));
vi.mock("@/lib/admin-emails/addresses", () => ({ getEmailAddressesReport: mocks.addresses }));

import { GET as getAddresses } from "./addresses/route";
import { GET as getDesigns } from "./designs/route";
import { GET as getTemplates } from "./templates/route";

const ROUTES = [
  ["designs", getDesigns],
  ["addresses", getAddresses],
  ["templates", getTemplates],
] as const;

const request = (name: string, init: RequestInit & { query?: string } = {}) =>
  new Request(`https://example.test/api/admin/emails/${name}${init.query ?? ""}`, init);
const withToken = { headers: { authorization: "Bearer jeton" } };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.designs.mockResolvedValue({ dark: false, templates: [] });
  mocks.addresses.mockResolvedValue({
    checkedAt: "2026-11-02T10:00:00.000Z",
    addresses: [],
    secrets: [],
    resend: { ok: true, domains: [] },
    webhooks: { ok: true, items: [] },
    dns: [],
    dmarcRecommended: "v=DMARC1; p=none",
    alerts: [],
  });
});
afterEach(() => vi.resetAllMocks());

describe.each(ROUTES)("/api/admin/emails/%s", (name, handler) => {
  it("refuse en 401 une requête sans jeton, sans rien calculer", async () => {
    const response = await handler(request(name));
    expect(response.status).toBe(401);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.designs).not.toHaveBeenCalled();
    expect(mocks.addresses).not.toHaveBeenCalled();
  });

  it("refuse en 403 un compte qui n'est pas administrateur, sans rien calculer", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false });
    const response = await handler(request(name, withToken));
    expect(response.status).toBe(403);
    expect(mocks.designs).not.toHaveBeenCalled();
    expect(mocks.addresses).not.toHaveBeenCalled();
  });

  it("répond à un administrateur sans mise en cache", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const response = await handler(request(name, withToken));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("paramètres de lecture", () => {
  it("passe le thème sombre à la galerie", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    await getDesigns(request("designs", { ...withToken, query: "?theme=dark" }));
    expect(mocks.designs).toHaveBeenLastCalledWith({ dark: true });
    await getDesigns(request("designs", { ...withToken, query: "?theme=autre" }));
    expect(mocks.designs).toHaveBeenLastCalledWith({ dark: false });
  });

  it("passe la demande de revérification au rapport des adresses", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    await getAddresses(request("addresses", { ...withToken, query: "?refresh=1" }));
    expect(mocks.addresses).toHaveBeenLastCalledWith({ refresh: true });
    await getAddresses(request("addresses", withToken));
    expect(mocks.addresses).toHaveBeenLastCalledWith({ refresh: false });
  });

  it("n'expose que des lectures : pas de méthode d'écriture", async () => {
    for (const file of [
      await import("./designs/route"),
      await import("./addresses/route"),
      await import("./templates/route"),
    ]) {
      expect(
        Object.keys(file).filter((key) => ["POST", "PUT", "PATCH", "DELETE"].includes(key)),
      ).toEqual([]);
    }
  });

  it("liste les modèles avec leur niveau, sans fonction d'aperçu", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: true });
    const body = await (await getTemplates(request("templates", withToken))).json();
    const [section] = body.sections;
    expect(section.items.length).toBeGreaterThan(10);
    expect(section.items[0]).toMatchObject({
      title: "Alerte de recherche",
      code: "alert · ALERT_EMAIL_FROM",
      badges: [{ text: "Textes éditables (bientôt)" }, { text: "Catégorie : alert" }],
    });
    expect(JSON.stringify(body)).not.toContain("sample");
  });
});

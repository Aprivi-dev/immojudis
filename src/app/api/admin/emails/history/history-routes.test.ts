import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), read: vi.fn() }));

vi.mock("@/integrations/supabase/auth-middleware", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations/supabase/auth-middleware")>()),
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn(), auth: { admin: {} } },
}));
vi.mock("@/lib/admin-emails/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-emails/history")>()),
  listEmailHistory: mocks.list,
  readEmailMessage: mocks.read,
}));

import { GET as getList, POST as postList } from "./route";
import { GET as getMessage } from "./[id]/route";

const ID = "00000000-0000-4000-8000-000000000001";
const withToken = { headers: { authorization: "Bearer jeton" } };
const listRequest = (query = "", init: RequestInit = {}) =>
  new Request(`https://example.test/api/admin/emails/history${query}`, init);
const messageRequest = (init: RequestInit = {}) =>
  new Request(`https://example.test/api/admin/emails/history/log%3A${ID}`, init);
const context = { params: Promise.resolve({ id: `log:${ID}` }) };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.auth.mockResolvedValue({ isAdmin: true, userId: "admin-1" });
  mocks.list.mockResolvedValue({ rows: [], next: null });
  mocks.read.mockResolvedValue({ title: "t", lines: [], kind: "text", body: "b", attachments: [] });
});
afterEach(() => vi.resetAllMocks());

describe("/api/admin/emails/history", () => {
  it("refuse en 401 sans jeton, sans rien lire", async () => {
    expect((await getList(listRequest())).status).toBe(401);
    expect((await getMessage(messageRequest(), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("refuse en 403 un compte qui n'est pas administrateur, sans rien lire", async () => {
    mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });
    expect((await getList(listRequest("", withToken))).status).toBe(403);
    expect((await getMessage(messageRequest(withToken), context)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("passe la boîte, le curseur et l'actualisation, sans adresse, sans mise en cache", async () => {
    const response = await getList(listRequest("?box=received&cursor=abc&refresh=1", withToken));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      box: "received",
      cursor: "abc",
      address: null,
      refresh: true,
    });
  });

  it("liste les envoyés par défaut et n'actualise que sur demande", async () => {
    await getList(listRequest("?box=autre", withToken));
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ box: "sent", refresh: false, cursor: null, address: null }),
    );
  });

  it("refuse une adresse dans l'URL du GET : elle se cherche en POST", async () => {
    const response = await getList(
      listRequest("?box=sent&address=alice%40example.test", withToken),
    );
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  describe("POST (recherche par adresse)", () => {
    const post = (body: unknown, query = "", init: RequestInit = withToken) =>
      new Request(`https://example.test/api/admin/emails/history${query}`, {
        ...init,
        method: "POST",
        headers: {
          ...(init.headers as Record<string, string>),
          "content-type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    it("refuse en 401 sans jeton et en 403 pour un non-administrateur, sans rien lire", async () => {
      expect((await postList(post({ box: "sent" }, "", {}))).status).toBe(401);
      mocks.auth.mockResolvedValue({ isAdmin: false, userId: "user-1" });
      expect((await postList(post({ box: "sent" }))).status).toBe(403);
      expect(mocks.list).not.toHaveBeenCalled();
    });

    it("lit l'adresse dans le corps, sans mise en cache", async () => {
      const response = await postList(
        post({ box: "received", address: "alice@example.test", cursor: "abc", refresh: false }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocks.list).toHaveBeenCalledWith({
        adminUserId: "admin-1",
        box: "received",
        cursor: "abc",
        address: "alice@example.test",
        refresh: false,
      });
    });

    it("refuse toute chaîne de requête, un champ inconnu et un corps invalide", async () => {
      expect((await postList(post({ box: "sent" }, "?address=alice"))).status).toBe(400);
      expect((await postList(post({ box: "sent", extra: 1 }))).status).toBe(400);
      expect((await postList(post({ box: "autre" }))).status).toBe(400);
      expect((await postList(post("pas du json"))).status).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    });
  });

  it("lit un message par son identifiant, sans mise en cache", async () => {
    const response = await getMessage(messageRequest(withToken), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith({ adminUserId: "admin-1", id: `log:${ID}` });
  });

  it("répond 404 pour un message inconnu", async () => {
    mocks.read.mockResolvedValue(null);
    const response = await getMessage(messageRequest(withToken), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("répond 400 pour une entrée invalide, sans détail interne", async () => {
    const { EmailHistoryInputError } = await import("@/lib/admin-emails/history");
    mocks.list.mockRejectedValue(new EmailHistoryInputError("Curseur invalide."));
    const response = await getList(listRequest("?cursor=x", withToken));
    expect(response.status).toBe(400);
  });
});

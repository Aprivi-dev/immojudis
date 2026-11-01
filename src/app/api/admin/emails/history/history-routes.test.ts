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

import { GET as getList } from "./route";
import { GET as getMessage } from "./[id]/route";

const ID = "00000000-0000-4000-8000-000000000001";
const withToken = { headers: { authorization: "Bearer jeton" } };
const listRequest = (query = "", init: RequestInit = {}) =>
  new Request(`https://example.test/api/admin/emails/history${query}`, init);
const messageRequest = (init: RequestInit = {}) =>
  new Request(`https://example.test/api/admin/emails/history/log%3A${ID}`, init);
const context = { params: Promise.resolve({ id: `log%3A${ID}` }) };

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

  it("passe la boîte, le curseur, l'adresse et l'actualisation, sans mise en cache", async () => {
    const response = await getList(
      listRequest("?box=received&cursor=abc&address=Alice&refresh=1", withToken),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      box: "received",
      cursor: "abc",
      address: "Alice",
      refresh: true,
    });
  });

  it("liste les envoyés par défaut et n'actualise que sur demande", async () => {
    await getList(listRequest("?box=autre", withToken));
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ box: "sent", refresh: false, cursor: null, address: null }),
    );
  });

  it("lit un message par son identifiant décodé, sans mise en cache", async () => {
    const response = await getMessage(messageRequest(withToken), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.read).toHaveBeenCalledWith({ adminUserId: "admin-1", id: `log:${ID}` });
  });

  it("répond 404 pour un message inconnu", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await getMessage(messageRequest(withToken), context)).status).toBe(404);
  });

  it("répond 400 pour une entrée invalide, sans détail interne", async () => {
    const { EmailHistoryInputError } = await import("@/lib/admin-emails/history");
    mocks.list.mockRejectedValue(new EmailHistoryInputError("Curseur invalide."));
    const response = await getList(listRequest("?cursor=x", withToken));
    expect(response.status).toBe(400);
  });
});

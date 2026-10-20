import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ audience: vi.fn(), test: vi.fn(), send: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-offer-opening-notifier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-offer-opening-notifier")>()),
  getOfferOpeningAudience: mocks.audience,
  sendOfferOpeningTest: mocks.test,
  sendOfferOpeningBatch: mocks.send,
}));
vi.mock("server-only", () => ({}));

import { GET, POST } from "./route";

const url = "https://example.test/api/admin/offer-opening-notifier";
const headers = { authorization: "Bearer admin-token" };
const post = (body: unknown, requestHeaders: Record<string, string> = headers) =>
  POST(new Request(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }));

describe("/api/admin/offer-opening-notifier", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit les destinataires et l'aperçu sans cache, avec le jeton de l'administrateur", async () => {
    mocks.audience.mockResolvedValue({ recipients: 3 });
    const response = await GET(new Request(url, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recipients: 3 });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.audience).toHaveBeenCalledWith({ authToken: "admin-token" });
  });

  it("refuse sans jeton, sans rien lire ni envoyer", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await post({ action: "test" }, {})).status).toBe(401);
    expect(mocks.audience).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.send.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    expect((await post({ action: "send", confirm: true })).status).toBe(403);
  });

  it("envoie l'essai à l'administrateur", async () => {
    mocks.test.mockResolvedValue({ sentTo: "admin@immojudis.test" });
    const response = await post({ action: "test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sentTo: "admin@immojudis.test" });
    expect(mocks.test).toHaveBeenCalledWith({ authToken: "admin-token" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("envoie un lot seulement sur confirmation explicite", async () => {
    mocks.send.mockResolvedValue({ sent: 2, failed: 0, skipped: 0, remaining: 0 });
    const response = await post({ action: "send", confirm: true, limit: 50 });
    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith({ authToken: "admin-token", limit: 50 });
  });

  it("refuse un corps sans confirmation, un lot de plus de 200 ou une action inconnue", async () => {
    expect((await post({ action: "send" })).status).toBe(400);
    expect((await post({ action: "send", confirm: true, limit: 201 })).status).toBe(400);
    expect((await post({ action: "tout-envoyer", confirm: true })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

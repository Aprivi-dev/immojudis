import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  setDate: vi.fn(),
  test: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: (request: Request) => {
    const header = request.headers.get("authorization");
    if (!header) throw new Error("Unauthorized: No authorization header provided");
    return header.replace("Bearer ", "");
  },
}));
vi.mock("@/lib/admin-launch-offer-end", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-launch-offer-end")>()),
  getAdminLaunchOfferEnd: mocks.state,
  setAdminLaunchOfferEnd: mocks.setDate,
  sendLaunchOfferEndTest: mocks.test,
  sendLaunchOfferEndBatch: mocks.send,
}));
vi.mock("server-only", () => ({}));

import { GET, POST } from "./route";

const url = "https://example.test/api/admin/launch-offer-end";
const headers = { authorization: "Bearer admin-token" };
const post = (body: unknown, requestHeaders: Record<string, string> = headers) =>
  POST(new Request(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }));

describe("/api/admin/launch-offer-end", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit l'état sans cache, avec le jeton de l'administrateur", async () => {
    mocks.state.mockResolvedValue({ endsOn: "2026-12-01" });
    const response = await GET(new Request(url, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ endsOn: "2026-12-01" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.state).toHaveBeenCalledWith({ authToken: "admin-token" });
  });

  it("refuse sans jeton, sans rien lire ni envoyer", async () => {
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await post({ action: "test" }, {})).status).toBe(401);
    expect(mocks.state).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuse un compte non administrateur", async () => {
    mocks.send.mockRejectedValue(new Error("Forbidden: accès administrateur requis."));
    expect((await post({ action: "send", confirm: true, endsOn: "2026-12-01" })).status).toBe(403);
  });

  it("enregistre la date puis rend l'état, sans rien envoyer", async () => {
    mocks.setDate.mockResolvedValue(undefined);
    mocks.state.mockResolvedValue({ endsOn: "2026-12-01" });
    const response = await post({ action: "set-date", endsOn: "2026-12-01" });
    expect(response.status).toBe(200);
    expect(mocks.setDate).toHaveBeenCalledWith({ authToken: "admin-token", endsOn: "2026-12-01" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it("envoie l'essai à l'administrateur", async () => {
    mocks.test.mockResolvedValue({ sentTo: "admin@immojudis.test" });
    const response = await post({ action: "test" });
    expect(await response.json()).toEqual({ sentTo: "admin@immojudis.test" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("n'envoie jamais sans confirmation explicite ni date affichée", async () => {
    expect((await post({ action: "send", endsOn: "2026-12-01" })).status).toBe(400);
    expect((await post({ action: "send", confirm: true })).status).toBe(400);
    expect((await post({ action: "send", confirm: false, endsOn: "2026-12-01" })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("envoie un lot sur confirmation, avec la date affichée", async () => {
    mocks.send.mockResolvedValue({
      sent: 2,
      failed: 0,
      skipped: 0,
      remaining: 0,
      stoppedEarly: false,
    });
    const response = await post({ action: "send", confirm: true, endsOn: "2026-12-01", limit: 50 });
    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith({
      authToken: "admin-token",
      endsOn: "2026-12-01",
      limit: 50,
    });
  });
});

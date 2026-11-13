import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ token: "token" as string | null }));
vi.mock("@/integrations/supabase/lazy", () => ({
  hasSupabaseAuthHint: () => session.token !== null,
  getSupabase: async () => ({
    auth: {
      getSession: async () => ({
        data: { session: session.token ? { access_token: session.token } : null },
      }),
    },
  }),
}));

import { fetchSalePepite } from "./sale-pepite";

const fetchMock = vi.fn();
const saleId = "11111111-1111-4111-8111-111111111111";

const reply = (status: number, body: unknown = {}) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

describe("fetchSalePepite", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    session.token = "token";
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("le niveau criteria n'envoie aucun jeton : il est ouvert aux visiteurs", async () => {
    fetchMock.mockResolvedValue(reply(200, { access: "criteria", count: 1, criteria: [] }));
    await fetchSalePepite(saleId, "criteria");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/sales/${saleId}/pepite?view=criteria`);
  });

  it("le niveau detail envoie le jeton du compte", async () => {
    fetchMock.mockResolvedValue(reply(200, { access: "detail" }));
    await fetchSalePepite(saleId, "detail");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer token" });
    expect(fetchMock.mock.calls[0][0]).toContain("view=detail");
  });

  it("sans session lisible, le niveau detail retombe sur les critères sans rien envoyer", async () => {
    session.token = null;
    const criteria = { access: "criteria", count: 1, criteria: [] };
    fetchMock.mockResolvedValue(reply(200, criteria));
    await expect(fetchSalePepite(saleId, "detail")).resolves.toEqual(criteria);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("view=criteria");
  });

  it("404 : pas une pépite (null)", async () => {
    fetchMock.mockResolvedValue(reply(404));
    await expect(fetchSalePepite(saleId, "criteria")).resolves.toBeNull();
  });

  it("403 au niveau detail : retombe sur les critères, sans montant", async () => {
    const criteria = { access: "criteria", count: 2, criteria: [] };
    fetchMock.mockResolvedValueOnce(reply(403)).mockResolvedValueOnce(reply(200, criteria));
    await expect(fetchSalePepite(saleId, "detail")).resolves.toEqual(criteria);
    expect(fetchMock.mock.calls[1][0]).toContain("view=criteria");
  });

  it("une autre erreur est levée", async () => {
    fetchMock.mockResolvedValue(reply(500, { error: "Indisponible" }));
    await expect(fetchSalePepite(saleId, "criteria")).rejects.toThrow("Indisponible");
  });
});

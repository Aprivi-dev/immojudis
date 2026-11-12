import { beforeEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => ({
  hasSupabaseAuthHint: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("@/integrations/supabase/lazy", () => lazy);

import { authHeaders, readJson, responseError } from "./client-api-core";
import { exportPropertyReportPdf } from "./client-api/property-reports";
import { exportSalesCsv } from "./client-api/sale-analysis";

describe("authHeaders", () => {
  beforeEach(() => {
    lazy.hasSupabaseAuthHint.mockReset();
    lazy.getSupabase.mockReset();
  });

  it("does not load supabase-js for an anonymous visitor", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(false);

    await expect(authHeaders()).rejects.toThrow("Connexion requise.");
    expect(lazy.getSupabase).not.toHaveBeenCalled();
  });

  it("reads the stored session when there is one", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: { access_token: "jeton" } } }) },
    });

    await expect(authHeaders()).resolves.toEqual({ Authorization: "Bearer jeton" });
  });

  it("still refuses when the hint was wrong and no session is found", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: null } }) },
    });

    await expect(authHeaders()).rejects.toThrow("Connexion requise.");
  });
});

describe("erreur d'une réponse refusée", () => {
  it("garde le message de la réponse et son statut", async () => {
    const response = Response.json({ error: "Trop de demandes." }, { status: 429 });
    await expect(readJson(response)).rejects.toMatchObject({
      message: "Trop de demandes.",
      status: 429,
    });
    expect(responseError(503, null)).toMatchObject({ message: "Erreur HTTP 503", status: 503 });
  });

  it("donne aussi le statut aux téléchargements (PDF d'un rapport, export CSV)", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: { access_token: "jeton" } } }) },
    });
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ error: "Limite atteinte." }, { status: 429 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(exportPropertyReportPdf({ reportId: "r1" })).rejects.toMatchObject({
        message: "Limite atteinte.",
        status: 429,
      });
      await expect(exportSalesCsv({ search: {} as never })).rejects.toMatchObject({
        status: 429,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

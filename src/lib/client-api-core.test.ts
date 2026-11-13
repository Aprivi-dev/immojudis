import { beforeEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => ({
  hasSupabaseAuthHint: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("@/integrations/supabase/lazy", () => lazy);

import {
  apiDownload,
  apiFetch,
  apiRequest,
  authHeaders,
  readJson,
  responseError,
} from "./client-api-core";
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

describe("apiRequest", () => {
  const signedIn = () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(true);
    lazy.getSupabase.mockResolvedValue({
      auth: { getSession: async () => ({ data: { session: { access_token: "jeton" } } }) },
    });
  };

  it("envoie le jeton et le corps en JSON ; une écriture hors administration n'a pas de délai", async () => {
    signedIn();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        apiRequest("/api/favorites", { method: "POST", body: { saleId: "s1" } }),
      ).resolves.toEqual({ ok: true });
      const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe("/api/favorites");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Authorization: "Bearer jeton",
        "Content-Type": "application/json",
      });
      expect(init.body).toBe(JSON.stringify({ saleId: "s1" }));
      expect(init.signal).toBeUndefined();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("30 s pour une lecture et pour l'administration, aucun délai pour un fichier", async () => {
    signedIn();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response("x", { headers: { "content-type": "text/csv" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await apiFetch("/api/favorites");
      expect(timeout).toHaveBeenLastCalledWith(30_000);
      await apiFetch("/api/admin/signups/search", { method: "POST", body: {} });
      expect(timeout).toHaveBeenLastCalledWith(30_000);
      timeout.mockClear();
      await apiDownload("/api/sales/export", {}, "ventes.csv");
      expect(timeout).not.toHaveBeenCalled();
      expect((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].signal).toBeUndefined();
      await apiFetch("/api/sales/s1/unlock", { method: "POST", timeoutMs: 15_000 });
      expect(timeout).toHaveBeenLastCalledWith(15_000);
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("une lecture n'a ni méthode ni corps ; une route publique part sans jeton", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(false);
    lazy.getSupabase.mockReset();
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ lawyers: [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await apiRequest("/api/lawyers/directory", { anonymous: true });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({});
      expect(lazy.getSupabase).not.toHaveBeenCalled();
      await expect(apiRequest("/api/favorites")).rejects.toThrow("Connexion requise.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("garde le statut et le code d'un refus", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { ok: false, error: "Tribunal à confirmer.", code: "COURT_UNRESOLVED" },
            { status: 422 },
          ),
        ),
    );
    try {
      await expect(apiRequest("/api/v1/tribunals/listing-statistics")).rejects.toMatchObject({
        message: "Tribunal à confirmer.",
        status: 422,
        code: "COURT_UNRESOLVED",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

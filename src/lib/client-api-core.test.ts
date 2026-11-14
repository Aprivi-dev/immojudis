import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("ajoute l'abandon de l'appelant au délai d'une lecture, et le transmet seul à une écriture", async () => {
    signedIn();
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    const signalOf = () => (fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].signal;
    try {
      const caller = new AbortController();
      await apiRequest("/api/sales/s1/risks", { anonymous: true, signal: caller.signal });
      const read = signalOf();
      expect(read).not.toBe(caller.signal);
      expect(read?.aborted).toBe(false);
      caller.abort();
      expect(read?.aborted).toBe(true);

      const writer = new AbortController();
      await apiFetch("/api/favorites", { method: "POST", signal: writer.signal });
      expect(signalOf()).toBe(writer.signal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("garde l'abandon de l'appelant, sans délai, quand le navigateur ignore `AbortSignal.any`", async () => {
    signedIn();
    const any = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const caller = new AbortController();
      await apiRequest("/api/sales/s1/weather", { anonymous: true, signal: caller.signal });
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(caller.signal);
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: any, configurable: true });
      vi.unstubAllGlobals();
    }
  });

  it("un fichier garde le délai qu'on lui impose", async () => {
    signedIn();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("%PDF", { status: 200 })),
    );
    try {
      await apiDownload("/api/v1/sales/s1/land-report?format=pdf", { timeoutMs: 175_000 }, "x.pdf");
      expect(timeout).toHaveBeenLastCalledWith(175_000);
      timeout.mockClear();
      await apiDownload("/api/admin/lawyers/statement.csv", {}, "releve.csv");
      expect(timeout).toHaveBeenLastCalledWith(30_000);
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

/**
 * Audit de l'administration du 14/11/2026 (I2) : un délai dépassé affichait « signal timed out »,
 * une coupure réseau « Failed to fetch ». Les deux sont traduits ici, pour tous les écrans ; une
 * annulation voulue (changement de page, démontage) reste une annulation, sans message.
 */
describe("délai dépassé, coupure réseau et annulation", () => {
  const TIMEOUT_MESSAGE = "Le serveur met trop de temps à répondre. Réessayez dans un instant.";
  const NETWORK_MESSAGE = "Connexion impossible. Vérifiez votre réseau puis réessayez.";

  /** `fetch` qui ne répond jamais et rejette comme le navigateur quand son signal est abandonné. */
  const hangingFetch = (rejection?: (signal: AbortSignal) => unknown) =>
    vi.fn(
      (_path: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          const abort = () => reject(rejection ? rejection(signal) : signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort);
        }),
    );

  afterEach(() => vi.unstubAllGlobals());

  it("traduit le délai dépassé (TimeoutError) d'une lecture d'administration", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const error = await apiRequest("/api/admin/dashboard", { anonymous: true, timeoutMs: 5 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(TIMEOUT_MESSAGE);
    expect(((error as Error).cause as Error).name).toBe("TimeoutError");
  });

  it("traduit aussi le délai d'un navigateur qui le rapporte comme un AbortError", async () => {
    vi.stubGlobal(
      "fetch",
      hangingFetch(() => new DOMException("The operation was aborted.", "AbortError")),
    );

    await expect(
      apiRequest("/api/sales/s1/risks", { anonymous: true, timeoutMs: 5 }),
    ).rejects.toThrow(TIMEOUT_MESSAGE);
  });

  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])(
    "traduit la coupure réseau « %s »",
    async (browserMessage) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(browserMessage)));

      await expect(
        apiRequest("/api/admin/pipeline", { anonymous: true, method: "PATCH", body: {} }),
      ).rejects.toThrow(NETWORK_MESSAGE);
    },
  );

  it("ne prend pas un corps qui ne se sérialise pas pour une coupure réseau", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = (await apiRequest("/api/admin/pipeline", {
      anonymous: true,
      method: "PATCH",
      body: { limit: 1n },
    }).catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).not.toBe(NETWORK_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("laisse passer telle quelle une annulation voulue par l'appelant, sans message traduit", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const caller = new AbortController();

    const pending = apiRequest("/api/admin/dashboard", { anonymous: true, signal: caller.signal });
    caller.abort();
    const error = (await pending.catch((caught: unknown) => caught)) as Error;

    expect(error.name).toBe("AbortError");
    expect([TIMEOUT_MESSAGE, NETWORK_MESSAGE]).not.toContain(error.message);
  });

  it("une requête annulée par React Query (page quittée) ne laisse aucune erreur à afficher", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const client = new QueryClient();
    const queryKey = ["admin-dashboard"];

    const pending = client.prefetchQuery({
      queryKey,
      queryFn: ({ signal }) => apiRequest("/api/admin/dashboard", { anonymous: true, signal }),
    });
    await client.cancelQueries({ queryKey });
    await pending;

    expect(client.getQueryState(queryKey)?.error ?? null).toBeNull();
    client.clear();
  });
});

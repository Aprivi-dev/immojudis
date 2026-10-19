import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => ({
  hasSupabaseAuthHint: vi.fn(),
  getSupabase: vi.fn(),
}));

vi.mock("@/integrations/supabase/lazy", () => lazy);
// Le client complet ne doit jamais être chargé par ce module : l'importer ferait échouer le test.
vi.mock("@/integrations/supabase/client", () => {
  throw new Error("Le client Supabase complet ne doit pas être importé.");
});

import {
  fetchAdjudicationPriceStatistics,
  fetchAdjudicationPriceStatisticsDirectory,
} from "./adjudication-price-statistics-client";

function withSession(token: string | null) {
  lazy.hasSupabaseAuthHint.mockReturnValue(true);
  lazy.getSupabase.mockResolvedValue({
    auth: {
      getSession: async () => ({ data: { session: token ? { access_token: token } : null } }),
    },
  });
}

describe("adjudication-price-statistics-client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    lazy.hasSupabaseAuthHint.mockReset();
    lazy.getSupabase.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("n'appelle ni le réseau ni supabase-js pour un visiteur anonyme", async () => {
    lazy.hasSupabaseAuthHint.mockReturnValue(false);

    await expect(fetchAdjudicationPriceStatisticsDirectory()).rejects.toThrow("Connexion requise.");
    await expect(fetchAdjudicationPriceStatistics("vente-1")).rejects.toThrow("Connexion requise.");
    expect(lazy.getSupabase).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuse quand l'indice de session était faux et qu'aucune session n'existe", async () => {
    withSession(null);

    await expect(fetchAdjudicationPriceStatisticsDirectory()).rejects.toThrow("Connexion requise.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie le jeton de la session lue par le client chargé à la demande", async () => {
    withSession("jeton");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Accès Analyse requis." }), { status: 403 }),
    );

    await expect(fetchAdjudicationPriceStatistics("a b")).rejects.toThrow("Accès Analyse requis.");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/sales/a%20b/adjudication-statistics", {
      headers: { Authorization: "Bearer jeton" },
      cache: "no-store",
    });
  });

  it("transmet aussi le jeton pour l'annuaire des tribunaux", async () => {
    withSession("jeton");
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));

    await expect(fetchAdjudicationPriceStatisticsDirectory()).rejects.toThrow("Erreur HTTP 500");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/tribunals/adjudication-statistics", {
      headers: { Authorization: "Bearer jeton" },
      cache: "no-store",
    });
  });
});

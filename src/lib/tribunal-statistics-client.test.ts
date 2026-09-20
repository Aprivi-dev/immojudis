import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRIBUNAL_STATISTICS_WARNING,
  tribunalStatisticsResponseSchema,
} from "@/lib/tribunal-statistics";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));

import { fetchTribunalStatistics } from "./tribunal-statistics-client";

describe("fetchTribunalStatistics", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuse de charger les statistiques sans session authentifiée", async () => {
    await expect(fetchTribunalStatistics({ windowMonths: 36 })).rejects.toThrow(
      "Connexion requise.",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("transmet le token et les paramètres nettoyés au endpoint", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse(validResponse()));

    const result = await fetchTribunalStatistics({
      windowMonths: 24,
      courtCode: "  TJ-BDX  ",
    });

    expect(result.national.scope).toBe("national");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/v1/tribunals/statistics?windowMonths=24&courtCode=TJ-BDX",
      {
        headers: { Authorization: "Bearer test-access-token" },
        cache: "no-store",
      },
    );
  });

  it("n’ajoute pas de code tribunal vide aux paramètres", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse(validResponse()));

    await fetchTribunalStatistics({ windowMonths: 12, courtCode: "   " });

    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/v1/tribunals/statistics?windowMonths=12",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-access-token" },
        cache: "no-store",
      }),
    );
  });

  it("expose le message d’erreur renvoyé par l’API", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ error: "Statistiques indisponibles" }, 503));

    await expect(fetchTribunalStatistics({ windowMonths: 36 })).rejects.toThrow(
      "Statistiques indisponibles",
    );
  });

  it("reporte le statut HTTP lorsque la réponse d’erreur ne contient pas de JSON", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(new Response("pas du json", { status: 502 }));

    await expect(fetchTribunalStatistics({ windowMonths: 36 })).rejects.toThrow("Erreur HTTP 502");
  });

  it("rejette un payload 2xx malformé au lieu de le transmettre au dashboard", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ national: null, tribunals: [] }));

    await expect(fetchTribunalStatistics({ windowMonths: 36 })).rejects.toThrow();
  });

  it("rejette aussi un JSON 2xx invalide", async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
      error: null,
    });
    mocks.fetch.mockResolvedValueOnce(new Response("{", { status: 200 }));

    await expect(fetchTribunalStatistics({ windowMonths: 36 })).rejects.toThrow();
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validResponse() {
  const metric = suppressedMetric();
  const distribution = suppressedDistribution();

  return tribunalStatisticsResponseSchema.parse({
    national: {
      scope: "national",
      tribunal: null,
      roundKind: "initial",
      period: {
        start: "2023-07-01",
        end: "2026-06-30",
        windowMonths: 36,
        knowledgeCutoffAt: "2026-07-31T09:00:00.000Z",
      },
      reliability: {
        level: "insufficient_data",
        label: "Données insuffisantes",
        qualityGatePassed: false,
        coverage: null,
        warnings: [TRIBUNAL_STATISTICS_WARNING.REVIEW_GATE_FAILED],
      },
      samples: {
        eligibleRounds: null,
        status: null,
        initialPrice: null,
        effectivePrice: null,
        marketPrice: null,
        surenchere: null,
        resultDelay: null,
        postponementDelay: null,
        doubleReviewed: null,
      },
      flow: {
        held: metric,
        postponed: metric,
        cancelled: metric,
        notRequested: metric,
        noBidIfHeld: metric,
        adjudicatedIfHeld: metric,
      },
      surenchere: { filed: metric },
      priceRatios: {
        finalToInitial: distribution,
        finalToEffective: distribution,
        finalToMarket: distribution,
      },
      delays: {
        hearingToKnownResult: distribution,
        postponementToNextHearing: distribution,
      },
      fallback: { scope: "none", parentLabel: null, localWeight: 1 },
      methodology: {
        builderVersion: "tribunal_statistics_builder_v1",
        eligibilityRuleVersion: "claim_ab_reviewed_frozen_round_as_of_v1",
        smoothingRuleVersion: "jeffreys_beta_log_shrinkage_v1",
      },
      limitations: ["Réponse de test uniquement."],
    },
    tribunals: [],
    meta: {
      generatedAt: "2026-07-31T10:00:00.000Z",
      experimental: true,
      windowMonths: 36,
      roundKind: "initial",
      warnings: ["Réponse de test uniquement."],
    },
  });
}

function suppressedMetric() {
  return {
    rawValue: null,
    adjustedValue: null,
    numerator: null,
    knownDenominator: null,
    eligibleUniverse: null,
    unknownCount: null,
    excludedCount: null,
    exclusionReasons: {},
    confidenceInterval: null,
    method: "suppressed" as const,
  };
}

function suppressedDistribution() {
  return {
    sampleSize: null,
    eligibleUniverse: null,
    unknownCount: null,
    raw: null,
    adjusted: null,
    method: "suppressed" as const,
    parentSampleSize: null,
    excludedCount: null,
    exclusionReasons: {},
  };
}

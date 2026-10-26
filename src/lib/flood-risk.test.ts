import { describe, expect, it } from "vitest";
import {
  FLOOD_DERIVE_VERSION,
  FLOOD_REFRESH_DAYS,
  FLOOD_RETRY_HOURS,
  FLOOD_STREET_BUFFER_METERS,
  FLOOD_VALID_DAYS,
  classifyFloodPosition,
  deriveFloodVerdict,
  effectiveFloodVerdict,
  floodFacts,
  floodProbePoints,
  floodRefreshReason,
  type FloodPositionInput,
  type FloodProbeObservation,
  type FloodRiskObservation,
  type StoredFloodRisk,
} from "./flood-risk";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function position(overrides: Partial<FloodPositionInput> = {}): FloodPositionInput {
  return {
    latitude: 47.399,
    longitude: 0.689,
    precision: "address",
    flags: [],
    communeInsee: "37261",
    ...overrides,
  };
}

const IN_ZONE: FloodProbeObservation = { triScenarios: ["01For"], ppri: false };
const OUT_OF_ZONE: FloodProbeObservation = { triScenarios: [], ppri: false };

describe("classifyFloodPosition", () => {
  it.each(["address", "parcel", "ADDRESS"])("une position %s est précise", (precision) => {
    expect(classifyFloodPosition(position({ precision }))).toBe("point");
  });

  it("une rue passe par un tampon", () => {
    expect(classifyFloodPosition(position({ precision: "street" }))).toBe("street");
  });

  it.each([
    ["centre de commune", { precision: "municipality" }],
    ["précision absente", { precision: null }],
    ["précision inconnue", { precision: "approximate" }],
    ["coordonnées absentes", { latitude: null, longitude: null }],
    ["coordonnées hors limites", { latitude: 120, longitude: 0.5 }],
    ["coordonnées non numériques", { latitude: Number.NaN }],
    ["coordonnées de la source non vérifiées", { flags: ["unverified_source_coordinates"] }],
    ["coordonnées invraisemblables", { flags: ["implausible_coordinates"] }],
  ] as Array<[string, Partial<FloodPositionInput>]>)("%s : position imprécise", (_name, change) => {
    expect(classifyFloodPosition(position(change))).toBe("approximate");
  });

  it("un autre drapeau de qualité n'ôte pas la précision", () => {
    expect(classifyFloodPosition(position({ flags: ["probable_duplicate"] }))).toBe("point");
  });
});

describe("floodProbePoints", () => {
  it("un point précis : un seul point à tester", () => {
    expect(floodProbePoints(position())).toEqual([{ latitude: 47.399, longitude: 0.689 }]);
  });

  it("une position imprécise : aucun point, donc aucun appel de position", () => {
    expect(floodProbePoints(position({ precision: "municipality" }))).toEqual([]);
    expect(floodProbePoints(position({ latitude: null, longitude: null }))).toEqual([]);
  });

  it("une rue : le point et quatre points du tampon à la distance du tampon", () => {
    const points = floodProbePoints(position({ precision: "street" }));
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ latitude: 47.399, longitude: 0.689 });
    const metersNorth = (points[1].latitude - 47.399) * 111_195;
    expect(Math.abs(metersNorth - FLOOD_STREET_BUFFER_METERS)).toBeLessThan(1);
    const metersEast = (points[3].longitude - 0.689) * 111_195 * Math.cos((47.399 * Math.PI) / 180);
    expect(Math.abs(metersEast - FLOOD_STREET_BUFFER_METERS)).toBeLessThan(1);
  });
});

describe("deriveFloodVerdict (table de décision)", () => {
  const point = (probe: FloodProbeObservation): FloodRiskObservation => ({
    kind: "point",
    communeHasTri: null,
    probes: [probe],
  });

  it("position précise dans la zone de crue fréquente d'un TRI : élevé, quel que soit le PPRi", () => {
    expect(deriveFloodVerdict(point({ triScenarios: ["01For"], ppri: false })).verdict).toBe(
      "high",
    );
    expect(deriveFloodVerdict(point({ triScenarios: ["01For"], ppri: true })).verdict).toBe("high");
    expect(
      deriveFloodVerdict(point({ triScenarios: ["04Fai", "01For"], ppri: null })).verdict,
    ).toBe("high");
  });

  it("Loire à Tours : une entrée 01/01For donne un risque élevé", () => {
    expect(deriveFloodVerdict(point({ triScenarios: ["01For"], ppri: true }))).toEqual({
      verdict: "high",
      ppriChecked: true,
    });
  });

  it("Bordeaux : scénarios faible et moyen seulement, pas de risque élevé", () => {
    expect(
      deriveFloodVerdict(point({ triScenarios: ["04Fai", "02Moy"], ppri: false })).verdict,
    ).toBe("none_found");
  });

  it.each(["02Moy", "03Mcc", "04Fai"])("le scénario %s seul n'exclut pas", (code) => {
    expect(deriveFloodVerdict(point({ triScenarios: [code], ppri: false })).verdict).not.toBe(
      "high",
    );
  });

  it("hors zone TRI ou hors zone de crue fréquente, dans le périmètre d'un PPRi : exposé (sans exclusion)", () => {
    expect(deriveFloodVerdict(point({ triScenarios: [], ppri: true })).verdict).toBe("exposed");
    expect(deriveFloodVerdict(point({ triScenarios: ["04Fai"], ppri: true })).verdict).toBe(
      "exposed",
    );
  });

  it("hors zone et hors périmètre : aucun risque identifié", () => {
    expect(deriveFloodVerdict(point(OUT_OF_ZONE))).toEqual({
      verdict: "none_found",
      ppriChecked: true,
    });
  });

  it("le périmètre PPRi illisible n'empêche pas le verdict d'exclusion, et demande un nouvel essai", () => {
    expect(deriveFloodVerdict(point({ triScenarios: [], ppri: null }))).toEqual({
      verdict: "none_found",
      ppriChecked: false,
    });
    expect(deriveFloodVerdict(point({ triScenarios: ["01For"], ppri: null })).verdict).toBe("high");
  });

  it("position imprécise dans une commune qui a un TRI : inconnu (aucune pépite)", () => {
    expect(
      deriveFloodVerdict({ kind: "approximate", communeHasTri: true, probes: [] }).verdict,
    ).toBe("unknown");
  });

  it("position imprécise dans une commune sans TRI : aucun signal (la vente reste admissible)", () => {
    expect(
      deriveFloodVerdict({ kind: "approximate", communeHasTri: false, probes: [] }).verdict,
    ).toBe("no_signal");
  });

  it("position imprécise et commune inconnue : inconnu", () => {
    expect(
      deriveFloodVerdict({ kind: "approximate", communeHasTri: null, probes: [] }).verdict,
    ).toBe("unknown");
  });

  describe("rue (tampon de cinq points)", () => {
    const street = (...probes: FloodProbeObservation[]): FloodRiskObservation => ({
      kind: "street",
      communeHasTri: null,
      probes,
    });

    it("entièrement dans la zone : élevé", () => {
      expect(deriveFloodVerdict(street(...Array(5).fill(IN_ZONE))).verdict).toBe("high");
    });

    it("entièrement hors zone : pas d'exclusion", () => {
      expect(deriveFloodVerdict(street(...Array(5).fill(OUT_OF_ZONE))).verdict).toBe("none_found");
    });

    it("tampon à cheval sur la limite de la zone : inconnu", () => {
      expect(
        deriveFloodVerdict(street(IN_ZONE, OUT_OF_ZONE, OUT_OF_ZONE, OUT_OF_ZONE, OUT_OF_ZONE))
          .verdict,
      ).toBe("unknown");
    });

    it("un point du tampon dans le périmètre d'un PPRi : exposé", () => {
      const inPerimeter = { triScenarios: [], ppri: true };
      expect(
        deriveFloodVerdict(street(OUT_OF_ZONE, inPerimeter, OUT_OF_ZONE, OUT_OF_ZONE, OUT_OF_ZONE))
          .verdict,
      ).toBe("exposed");
    });
  });

  it("une observation sans aucun point précis ne conclut rien", () => {
    expect(deriveFloodVerdict({ kind: "point", communeHasTri: null, probes: [] }).verdict).toBe(
      "unknown",
    );
  });
});

function stored(overrides: Partial<StoredFloodRisk> = {}): StoredFloodRisk {
  return {
    verdict: "none_found",
    positionKey: "point:address:abc",
    observedAt: daysAgo(10),
    attemptedAt: daysAgo(10),
    failureCount: 0,
    ppriChecked: true,
    deriveVersion: FLOOD_DERIVE_VERSION,
    mapDate: "2013-12-18",
    ...overrides,
  };
}

describe("effectiveFloodVerdict", () => {
  it("rend le verdict stocké pour la position actuelle", () => {
    expect(effectiveFloodVerdict(stored({ verdict: "high" }), "point:address:abc", NOW)).toBe(
      "high",
    );
  });

  it("sans ligne, ou pour une autre position : inconnu", () => {
    expect(effectiveFloodVerdict(null, "point:address:abc", NOW)).toBe("unknown");
    expect(effectiveFloodVerdict(stored(), "point:address:other", NOW)).toBe("unknown");
  });

  it("la dernière valeur valable reste utilisée 180 jours, pas davantage", () => {
    const key = "point:address:abc";
    expect(
      effectiveFloodVerdict(stored({ observedAt: daysAgo(FLOOD_VALID_DAYS - 1) }), key, NOW),
    ).toBe("none_found");
    expect(effectiveFloodVerdict(stored({ observedAt: daysAgo(FLOOD_VALID_DAYS) }), key, NOW)).toBe(
      "unknown",
    );
  });

  it("une panne récente n'efface pas un verdict connu", () => {
    const afterOutage = stored({
      failureCount: 4,
      attemptedAt: hoursAgo(1),
      observedAt: daysAgo(40),
    });
    expect(effectiveFloodVerdict(afterOutage, "point:address:abc", NOW)).toBe("none_found");
  });

  it("jamais observée, ou valeur illisible : inconnu", () => {
    expect(effectiveFloodVerdict(stored({ observedAt: null }), "point:address:abc", NOW)).toBe(
      "unknown",
    );
    expect(effectiveFloodVerdict(stored({ verdict: "dangerous" }), "point:address:abc", NOW)).toBe(
      "unknown",
    );
  });
});

describe("floodFacts", () => {
  const key = "point:address:abc";

  it("donne la date du contrôle et celle de la carte d'un verdict connu", () => {
    expect(floodFacts(stored(), key, NOW)).toEqual({
      verdict: "none_found",
      observedAt: daysAgo(10),
      mapDate: "2013-12-18",
      ppriChecked: true,
    });
  });

  it("un verdict connu expiré garde la date du dernier contrôle réussi", () => {
    const expired = stored({ observedAt: daysAgo(200) });
    expect(floodFacts(expired, key, NOW)).toEqual({
      verdict: "unknown",
      observedAt: daysAgo(200),
      mapDate: "2013-12-18",
      ppriChecked: true,
    });
  });

  it("un verdict « inconnu » par nature n'a pas de date de contrôle", () => {
    expect(floodFacts(stored({ verdict: "unknown" }), key, NOW)).toEqual({
      verdict: "unknown",
      observedAt: null,
      mapDate: null,
      ppriChecked: true,
    });
  });

  it("pour une autre position : inconnu, sans date (le contrôle ne vaut pas pour ce point)", () => {
    expect(floodFacts(stored(), "point:address:other", NOW)).toEqual({
      verdict: "unknown",
      observedAt: null,
      mapDate: null,
      ppriChecked: true,
    });
    expect(floodFacts(null, key, NOW)).toEqual({
      verdict: "unknown",
      observedAt: null,
      mapDate: null,
      ppriChecked: true,
    });
  });

  it("porte le drapeau « périmètre des PPRi lu » du dernier contrôle réussi", () => {
    expect(floodFacts(stored({ ppriChecked: false }), key, NOW)).toMatchObject({
      verdict: "none_found",
      ppriChecked: false,
    });
    // Pour une autre position, le drapeau d'une autre observation ne compte pas.
    expect(floodFacts(stored({ ppriChecked: false }), "point:address:other", NOW)).toMatchObject({
      verdict: "unknown",
      ppriChecked: true,
    });
  });
});

describe("floodRefreshReason", () => {
  const key = "point:address:abc";

  it("jamais observée : à observer", () => {
    expect(floodRefreshReason(null, key, NOW)).toBe("missing");
  });

  it("à jour : rien à faire", () => {
    expect(floodRefreshReason(stored(), key, NOW)).toBeNull();
  });

  it("tous les 90 jours", () => {
    expect(
      floodRefreshReason(stored({ observedAt: daysAgo(FLOOD_REFRESH_DAYS - 1) }), key, NOW),
    ).toBe(null);
    expect(floodRefreshReason(stored({ observedAt: daysAgo(FLOOD_REFRESH_DAYS) }), key, NOW)).toBe(
      "aged",
    );
  });

  it("dès que la position ou sa précision change", () => {
    expect(floodRefreshReason(stored(), "point:parcel:abc", NOW)).toBe("position_changed");
    expect(floodRefreshReason(stored(), "approx:37261", NOW)).toBe("position_changed");
  });

  it("une tentative en échec est retentée après le délai, pas avant", () => {
    const failed = (hours: number) =>
      stored({ failureCount: 1, attemptedAt: hoursAgo(hours), observedAt: daysAgo(20) });
    expect(floodRefreshReason(failed(FLOOD_RETRY_HOURS - 1), key, NOW)).toBeNull();
    expect(floodRefreshReason(failed(FLOOD_RETRY_HOURS), key, NOW)).toBe("retry");
    // Même pour une position modifiée : on ne martèle pas une source en panne.
    expect(floodRefreshReason(failed(1), "point:parcel:abc", NOW)).toBeNull();
    expect(floodRefreshReason(failed(FLOOD_RETRY_HOURS), "point:parcel:abc", NOW)).toBe(
      "position_changed",
    );
  });

  it("un périmètre PPRi non lu est retenté après le délai", () => {
    expect(
      floodRefreshReason(stored({ ppriChecked: false, attemptedAt: hoursAgo(1) }), key, NOW),
    ).toBe(null);
    expect(
      floodRefreshReason(stored({ ppriChecked: false, attemptedAt: hoursAgo(7) }), key, NOW),
    ).toBe("retry");
  });

  it("une autre version de dérivation fait réobserver", () => {
    expect(floodRefreshReason(stored({ deriveVersion: "flood-v0" }), key, NOW)).toBe("version");
  });
});

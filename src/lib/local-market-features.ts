import { latLngToCell } from "h3-js";

/**
 * Variables de marché local du modèle LightGBM (`local_median_log`, `local_spread_log`,
 * `local_sample_size_log`) : port TypeScript de `lookup_exported_local_market` et de
 * `resolve_local_market` (`services/data-pipeline/src/valuation_training.py`).
 *
 * Définition unique : à l'entraînement, chaque vente reçoit les statistiques des ventes qui la
 * précèdent dans sa cellule H3 ; le modèle publié emporte dans son artefact (`localMarket`) les
 * statistiques de chaque cellule (effectif, moyenne et écart-type du logarithme du prix au m²). Au
 * service, on relit ces statistiques pour le point du bien, avec la même règle de sélection :
 *
 * 1. la cellule H3 du point à chaque résolution listée dans `resolutions` (la plus fine d'abord) ;
 * 2. la première cellule qui compte au moins `algorithm.minSample` ventes (moyenne et écart-type
 *    finis) fournit les trois variables :
 *    - `local_median_log` = moyenne du log du prix au m² de la cellule ;
 *    - `local_spread_log` = max(`spreadFloor`, écart-type × `spreadMultiplier`), largeur d'une bande
 *      P10-P90 en log ;
 *    - `local_sample_size_log` = log1p(min(effectif, `sampleSizeCap`)) ;
 * 3. sans cellule qualifiante : `fallback.mean`, `fallback.spread` et un effectif nul
 *    (`local_sample_size_log` = 0).
 *
 * Les constantes viennent de l'artefact (bloc `algorithm`), donc de Python : elles ne sont pas
 * dupliquées ici. `src/lib/local-market-features.test.ts` et
 * `services/data-pipeline/tests/test_local_market_parity.py` partagent le jeu de référence
 * `services/data-pipeline/tests/fixtures/local_market_parity.json` pour que les deux
 * implémentations restent identiques.
 */
export const SUPPORTED_LOCAL_MARKET_FORMAT_VERSION = 1;

export type LocalMarketFeatures = {
  local_median_log: number;
  local_spread_log: number;
  local_sample_size_log: number;
};

type LocalMarketExport = {
  formatVersion: number;
  algorithm: {
    minSample: number;
    spreadMultiplier: number;
    spreadFloor: number;
    sampleSizeCap: number;
  };
  resolutions: number[];
  fallback: { mean: number; spread: number };
  cells: Record<string, Record<string, unknown>>;
};

/** Vrai si l'artefact porte une section `localMarket` (modèles entraînés depuis la correction). */
export function hasLocalMarketExport(artifact: unknown): boolean {
  return (
    artifact != null &&
    typeof artifact === "object" &&
    (artifact as Record<string, unknown>).localMarket != null
  );
}

/**
 * Variables locales d'un point, calculées comme à l'entraînement. Renvoie `null` si l'export est
 * absent, d'un format que ce code ne connaît pas ou mal formé : l'appelant n'applique alors pas le
 * modèle plutôt que de lui donner des variables calculées autrement.
 */
export function localMarketFeaturesFromArtifact(
  artifact: unknown,
  latitude: number,
  longitude: number,
): LocalMarketFeatures | null {
  if (!artifact || typeof artifact !== "object") return null;
  const localMarket = parseLocalMarket((artifact as Record<string, unknown>).localMarket);
  if (!localMarket) return null;
  return lookupLocalMarket(localMarket, latitude, longitude);
}

function lookupLocalMarket(
  localMarket: LocalMarketExport,
  latitude: number,
  longitude: number,
): LocalMarketFeatures {
  const { algorithm } = localMarket;
  for (const resolution of localMarket.resolutions) {
    const cell = cellAt(latitude, longitude, resolution);
    const entry = cell ? localMarket.cells[String(resolution)]?.[cell] : undefined;
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [count, mean, std] = entry as unknown[];
    if (
      typeof count !== "number" ||
      typeof mean !== "number" ||
      typeof std !== "number" ||
      !Number.isFinite(count) ||
      !Number.isFinite(mean) ||
      !Number.isFinite(std) ||
      count < algorithm.minSample
    ) {
      continue;
    }
    return {
      local_median_log: mean,
      local_spread_log: Math.max(algorithm.spreadFloor, std * algorithm.spreadMultiplier),
      local_sample_size_log: Math.log1p(Math.min(count, algorithm.sampleSizeCap)),
    };
  }
  return {
    local_median_log: localMarket.fallback.mean,
    local_spread_log: localMarket.fallback.spread,
    local_sample_size_log: 0,
  };
}

function cellAt(latitude: number, longitude: number, resolution: number): string | null {
  try {
    return latLngToCell(latitude, longitude, resolution);
  } catch {
    return null;
  }
}

function parseLocalMarket(value: unknown): LocalMarketExport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.formatVersion !== SUPPORTED_LOCAL_MARKET_FORMAT_VERSION) return null;
  const algorithm = raw.algorithm as Record<string, unknown> | undefined;
  const fallback = raw.fallback as Record<string, unknown> | undefined;
  if (!algorithm || !fallback || !Array.isArray(raw.resolutions)) return null;
  if (!raw.cells || typeof raw.cells !== "object") return null;
  const minSample = algorithm.minSample;
  const spreadMultiplier = algorithm.spreadMultiplier;
  const spreadFloor = algorithm.spreadFloor;
  const sampleSizeCap = algorithm.sampleSizeCap;
  const fallbackMean = fallback.mean;
  const fallbackSpread = fallback.spread;
  const numbers = [
    minSample,
    spreadMultiplier,
    spreadFloor,
    sampleSizeCap,
    fallbackMean,
    fallbackSpread,
  ];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  if (!raw.resolutions.every((item) => Number.isInteger(item) && item >= 0 && item <= 15)) {
    return null;
  }
  return {
    formatVersion: SUPPORTED_LOCAL_MARKET_FORMAT_VERSION,
    algorithm: {
      minSample: minSample as number,
      spreadMultiplier: spreadMultiplier as number,
      spreadFloor: spreadFloor as number,
      sampleSizeCap: sampleSizeCap as number,
    },
    resolutions: raw.resolutions as number[],
    fallback: { mean: fallbackMean as number, spread: fallbackSpread as number },
    cells: raw.cells as Record<string, Record<string, unknown>>,
  };
}

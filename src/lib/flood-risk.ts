// Risque d'inondation d'une vente : module pur (aucune donnée, aucun import serveur, aucun réseau).
//
// Il décide du verdict d'inondation d'un bien à partir d'une observation normalisée (`FloodRiskObservation`),
// que le traitement planifié (`src/lib/sale-flood-risk-batch.ts`) construit à partir de Géorisques et du
// Géoportail de l'urbanisme. Le calcul des pépites (`pepite-policy.ts`) ne lit jamais que ce verdict, stocké par vente
// (table privée `auction_sale_flood_risk`) : il ne fait aucun appel réseau.
//
// Table de décision (compte-rendu `docs/equipe/2026-10-26-pepite-v2-inondation-loyers.md`, décisions du
// fondateur du 26/10/2026) :
//
//   position précise (adresse ou parcelle ; rue : voir plus bas)
//     · dans la zone du scénario « forte probabilité » (crue fréquente) d'un TRI  -> `high` (exclusion)
//     · sinon, dans le périmètre d'un PPRi (servitude PM1, aléa inondation)      -> `exposed` (affichage seul)
//     · sinon                                                                     -> `none_found`
//   parcelle multiple : chaque centroïde est testé (au plus `FLOOD_PARCEL_MAX_PROBES`) ; `high` si tous sont dans
//   la zone, `unknown` si les résultats divergent (le centroïde moyen peut tomber hors de toute parcelle) ;
//   position imprécise (centre de commune, absente, drapeau de position douteuse, lieu-dit de la BAN, numéro
//   de la BAN dont le score est inférieur à `FLOOD_ADDRESS_MIN_SCORE`)
//     · commune qui a un TRI                                                      -> `unknown` (pas d'entrée)
//     · commune sans TRI                                                          -> `no_signal` (admissible)
//     · commune inconnue                                                          -> `unknown`
//   rue : un tampon est appliqué autour du point (le point et quatre points à `FLOOD_STREET_BUFFER_METERS`) ;
//   le point BAN d'une rue est au milieu de la voie, parfois à plusieurs centaines de mètres du numéro réel
//   (mesuré le 27/10/2026 : 766 m) ; un tampon « hors zone » ne dit donc rien du bien. Seul `high` (les cinq points
//   dans la zone) est retenu ; tout autre résultat donne `unknown` (n° 39).
//
// Source indisponible : l'adaptateur n'appelle pas `deriveFloodVerdict` (il n'écrase jamais un verdict connu) ;
// la dernière valeur valable reste utilisée `FLOOD_VALID_DAYS` jours (`effectiveFloodVerdict`).
//
// Minimisation : la table stockée ne copie aucune coordonnée ; la position n'y figure que sous la forme d'une
// empreinte tronquée (`floodPositionKey`, dans `flood-risk-position.server.ts`). Ce n'est pas une anonymisation :
// c'est une pseudonymisation (une empreinte se recalcule à partir d'une position connue).

/** Version de la dérivation du verdict : une autre version fait réobserver la vente. */
export const FLOOD_DERIVE_VERSION = "flood-v2";

export const FLOOD_VERDICTS = ["high", "exposed", "none_found", "no_signal", "unknown"] as const;
export type FloodVerdict = (typeof FLOOD_VERDICTS)[number];

/** Scénario « forte probabilité » (crue fréquente) de la cartographie des TRI : code de l'API Géorisques. */
export const FLOOD_HIGH_SCENARIO_CODE = "01For";
/** Précisions de position qui permettent de tester un point : adresse et parcelle (la rue passe par un tampon). */
export const FLOOD_POINT_PRECISIONS: readonly string[] = ["address", "parcel"];
export const FLOOD_STREET_PRECISION = "street";
/**
 * Drapeaux de qualité de position qui rendent le point douteux : la position compte alors comme imprécise.
 * Les deux de la décision du fondateur (`services/data-pipeline/src/position_quality.py`).
 */
export const FLOOD_DOUBTFUL_POSITION_FLAGS: readonly string[] = [
  "unverified_source_coordinates",
  "implausible_coordinates",
  "geocode_outside_department",
];
/** Un numéro de la BAN dont le score est inférieur compte pour approximatif (l'inondation seulement). */
export const FLOOD_ADDRESS_MIN_SCORE = 0.8;
/** Type de résultat de la BAN pour un lieu-dit : rangé « rue » par le pipeline, approximatif pour l'inondation. */
export const FLOOD_LOCALITY_GEOCODE_TYPE = "locality";
/** Une parcelle multiple est sondée centroïde par centroïde, au plus 5 appels. */
export const FLOOD_PARCEL_MAX_PROBES = 5;
/** Rayon du tampon appliqué à une position « rue », en mètres. */
export const FLOOD_STREET_BUFFER_METERS = 100;
/** Un verdict est réobservé tous les 90 jours. */
export const FLOOD_REFRESH_DAYS = 90;
/** La dernière valeur valable reste utilisée 180 jours ; au-delà, le verdict compte pour inconnu. */
export const FLOOD_VALID_DAYS = 180;
/** Une observation en échec (ou sans périmètre PPRi) est retentée après ce délai, en heures. */
export const FLOOD_RETRY_HOURS = 6;

export type FloodProbePoint = { latitude: number; longitude: number };

export type FloodPositionKind = "point" | "street" | "approximate";

export type FloodPositionInput = {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  /** `location_precision` de la vente : address, parcel, street, municipality ou absente. */
  precision: string | null | undefined;
  /** `quality_flags` de la vente. */
  flags: readonly string[] | null | undefined;
  /** Code INSEE de la commune pour GASPAR (arrondissements ramenés à la commune). */
  communeInsee: string | null | undefined;
  /** Type du résultat de la BAN (`raw_payload.geocode.type`) : housenumber, street, locality, municipality. */
  geocodeType?: string | null;
  /** Score du résultat de la BAN (`raw_payload.geocode.score`, de 0 à 1) ; absent : non mesurable. */
  geocodeScore?: number | null;
  /** Centroïdes des parcelles d'une vente à plusieurs parcelles (résumé cadastral du pipeline). */
  parcelCentroids?: readonly FloodProbePoint[] | null;
};

/** Les coordonnées de la position quand elles sont valides, sinon `null`. */
export function validFloodCoordinates(
  position: FloodPositionInput,
): { lat: number; lon: number } | null {
  const { latitude: lat, longitude: lon } = position;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Nature de la position : « point » (adresse ou parcelle, sans drapeau douteux), « street » (rue : tampon) ou
 * « approximate » (centre de commune, précision absente, drapeau de position douteuse, coordonnées absentes).
 */
export function classifyFloodPosition(position: FloodPositionInput): FloodPositionKind {
  if (!validFloodCoordinates(position)) return "approximate";
  const flags = position.flags ?? [];
  if (flags.some((flag) => FLOOD_DOUBTFUL_POSITION_FLAGS.includes(flag))) return "approximate";
  const precision = (position.precision ?? "").trim().toLowerCase();
  if (precision === "address") {
    // Un numéro accepté à 0,6 par le géocodage est souvent une autre voie du même nom : pas de point précis.
    const score = position.geocodeScore;
    if (typeof score === "number" && Number.isFinite(score) && score < FLOOD_ADDRESS_MIN_SCORE) {
      return "approximate";
    }
  }
  if (FLOOD_POINT_PRECISIONS.includes(precision)) return "point";
  if (precision === FLOOD_STREET_PRECISION) {
    // Un lieu-dit de la BAN (rangé « rue » par le pipeline) est un point incertain à plus de 100 m.
    if ((position.geocodeType ?? "").trim().toLowerCase() === FLOOD_LOCALITY_GEOCODE_TYPE) {
      return "approximate";
    }
    return "street";
  }
  return "approximate";
}

const EARTH_RADIUS_M = 6_371_000;

/** Les centroïdes valides d'une parcelle multiple (au moins deux, sinon le point de la vente suffit). */
export function floodParcelCentroids(position: FloodPositionInput): FloodProbePoint[] {
  if ((position.precision ?? "").trim().toLowerCase() !== "parcel") return [];
  const centroids = (position.parcelCentroids ?? []).filter(
    (point) =>
      validFloodCoordinates({
        ...position,
        latitude: point.latitude,
        longitude: point.longitude,
      }) !== null,
  );
  return centroids.length >= 2 ? centroids : [];
}

/**
 * Vrai quand une parcelle multiple compte plus de `FLOOD_PARCEL_MAX_PROBES` centroïdes : seuls les premiers sont
 * testés, donc un résultat autre que `high` ne prouve rien pour les autres parcelles.
 */
export function isFloodProbeSetPartial(position: FloodPositionInput): boolean {
  return (
    classifyFloodPosition(position) === "point" &&
    floodParcelCentroids(position).length > FLOOD_PARCEL_MAX_PROBES
  );
}

/**
 * Les points à tester : le point lui-même (adresse, parcelle), chaque centroïde d'une parcelle multiple (au plus
 * `FLOOD_PARCEL_MAX_PROBES`), ou le point et quatre points du tampon (rue) ; aucun pour une position approximative
 * (aucun appel n'est fait).
 */
export function floodProbePoints(position: FloodPositionInput): FloodProbePoint[] {
  const kind = classifyFloodPosition(position);
  const coordinates = validFloodCoordinates(position);
  if (kind === "approximate" || !coordinates) return [];
  const { lat, lon } = coordinates;
  const center = { latitude: lat, longitude: lon };
  if (kind === "point") {
    const centroids = floodParcelCentroids(position);
    return centroids.length > 0 ? centroids.slice(0, FLOOD_PARCEL_MAX_PROBES) : [center];
  }
  const dLat = (FLOOD_STREET_BUFFER_METERS / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return [
    center,
    { latitude: round(lat + dLat), longitude: lon },
    { latitude: round(lat - dLat), longitude: lon },
    { latitude: lat, longitude: round(lon + dLon) },
    { latitude: lat, longitude: round(lon - dLon) },
  ];
}

/** Ce que l'API Géorisques `tri_zonage` rend pour un point : le code de scénario de chaque entrée. */
export type FloodProbeObservation = {
  /** Codes de scénario des entrées rendues (`01For`, `02Moy`, `03Mcc`, `04Fai`) ; vide : hors zone TRI. */
  triScenarios: string[];
  /** Le point est dans un périmètre de PPRi (PM1, aléa inondation) ; `null` : source indisponible. */
  ppri: boolean | null;
};

/** L'observation normalisée d'une vente, hors échec de la source TRI (qui n'en produit aucune). */
export type FloodRiskObservation = {
  kind: FloodPositionKind;
  /** Position approximative : la commune compte-t-elle un TRI ? `null` : commune inconnue ou source en échec. */
  communeHasTri: boolean | null;
  /** Position précise ou rue : une observation par point testé. */
  probes: FloodProbeObservation[];
  /** Date de la carte du TRI (`date_arrete_carte`), quand l'API la fournit (AAAA-MM-JJ). */
  mapDate?: string | null;
  /** Une partie seulement des parcelles a été testée (`isFloodProbeSetPartial`) : seul `high` est retenu. */
  partial?: boolean;
};

export type FloodDerivation = {
  verdict: FloodVerdict;
  /** Le périmètre PPRi a pu être lu partout où il le fallait (sinon : nouvel essai plus tard). */
  ppriChecked: boolean;
};

const isHigh = (probe: FloodProbeObservation) =>
  probe.triScenarios.includes(FLOOD_HIGH_SCENARIO_CODE);

/** Le verdict d'une observation, d'après la table de décision de l'en-tête. */
export function deriveFloodVerdict(observation: FloodRiskObservation): FloodDerivation {
  if (observation.kind === "approximate") {
    const verdict: FloodVerdict =
      observation.communeHasTri === true
        ? "unknown"
        : observation.communeHasTri === false
          ? "no_signal"
          : "unknown";
    return { verdict, ppriChecked: true };
  }
  const probes = observation.probes;
  if (probes.length === 0) return { verdict: "unknown", ppriChecked: true };
  const highCount = probes.filter(isHigh).length;
  const ppriChecked = probes.every((probe) => probe.ppri !== null);
  // Tous les points dans la zone : `high`. Résultats qui divergent (parcelles, tampon) : `unknown`.
  if (highCount === probes.length) return { verdict: "high", ppriChecked };
  if (highCount > 0) return { verdict: "unknown", ppriChecked };
  // Rue (le point BAN peut être à plusieurs centaines de mètres du numéro) ou parcelles non toutes testées :
  // « hors zone » ne dit rien du bien, seul `high` est retenu.
  if (observation.kind === "street" || observation.partial)
    return { verdict: "unknown", ppriChecked };
  return {
    verdict: probes.some((probe) => probe.ppri === true) ? "exposed" : "none_found",
    ppriChecked,
  };
}

/** Un verdict dont le calcul des pépites peut se servir (ni inconnu ni expiré). */
export function isKnownFloodVerdict(verdict: FloodVerdict): boolean {
  return verdict !== "unknown";
}

export type StoredFloodRisk = {
  verdict: string;
  positionKey: string;
  /** Dernière observation réussie (ISO) ; `null` : jamais observée. */
  observedAt: string | null;
  /** Dernière tentative (ISO). */
  attemptedAt: string | null;
  /** Échecs consécutifs depuis la dernière observation réussie. */
  failureCount: number;
  /** Le périmètre PPRi a pu être lu lors de la dernière observation. */
  ppriChecked: boolean;
  deriveVersion: string;
  /** Date de la carte du TRI (AAAA-MM-JJ) lue lors de la dernière observation, quand la source la donne. */
  mapDate: string | null;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asVerdict(value: string): FloodVerdict {
  return (FLOOD_VERDICTS as readonly string[]).includes(value)
    ? (value as FloodVerdict)
    : "unknown";
}

/**
 * Le verdict stocké, lu sous la règle actuelle : pour une position « rue » (clé `street:…`), la règle ne garde que
 * `high` (n° 39). Un verdict `none_found` ou `exposed` enregistré avant ce changement ne compte plus, sans attendre
 * la nouvelle observation de la vente.
 */
function storedVerdictOf(stored: StoredFloodRisk): FloodVerdict {
  const verdict = asVerdict(stored.verdict);
  return stored.positionKey.startsWith("street:") && verdict !== "high" ? "unknown" : verdict;
}

/**
 * Le verdict que la règle des pépites lit : celui qui est stocké, pour la position ACTUELLE du bien et tant que
 * sa dernière observation réussie a moins de `FLOOD_VALID_DAYS` jours ; sinon « inconnu ». Une panne de la source
 * n'efface donc jamais un verdict connu avant 180 jours.
 */
export function effectiveFloodVerdict(
  stored: StoredFloodRisk | null | undefined,
  currentPositionKey: string,
  now: Date,
): FloodVerdict {
  if (!stored || stored.positionKey !== currentPositionKey) return "unknown";
  const observedMs = timeOf(stored.observedAt);
  if (observedMs == null || now.getTime() - observedMs >= FLOOD_VALID_DAYS * DAY_MS) {
    return "unknown";
  }
  return storedVerdictOf(stored);
}

/** Ce que la règle des pépites et la fiche lisent du verdict d'une vente. */
export type FloodFacts = {
  verdict: FloodVerdict;
  /**
   * Date du dernier contrôle RÉUSSI qui a donné un verdict connu pour la position actuelle (ISO) ; `null` quand il
   * n'y en a jamais eu. Un verdict « inconnu » par nature (rien n'a pu être contrôlé) n'a pas de date.
   */
  observedAt: string | null;
  mapDate: string | null;
  /**
   * Le périmètre des PPRi a pu être lu au dernier contrôle réussi. Faux : un verdict « aucun risque élevé
   * identifié » ne repose que sur les TRI ; vrai aussi quand le périmètre ne s'applique pas (position imprécise).
   */
  ppriChecked: boolean;
};

export function floodFacts(
  stored: StoredFloodRisk | null | undefined,
  currentPositionKey: string,
  now: Date,
): FloodFacts {
  const verdict = effectiveFloodVerdict(stored, currentPositionKey, now);
  if (!stored || stored.positionKey !== currentPositionKey) {
    return { verdict, observedAt: null, mapDate: null, ppriChecked: true };
  }
  const storedVerdict = storedVerdictOf(stored);
  return {
    verdict,
    observedAt: storedVerdict === "unknown" ? null : stored.observedAt,
    mapDate: storedVerdict === "unknown" ? null : stored.mapDate,
    ppriChecked: stored.ppriChecked,
  };
}

export type FloodRefreshReason = "missing" | "position_changed" | "retry" | "version" | "aged";

/**
 * Pourquoi une vente doit être réobservée, ou `null`. Par ordre d'urgence : jamais observée, position ou
 * précision modifiée, tentative en échec (retentée après `FLOOD_RETRY_HOURS`), autre version de la dérivation,
 * observation de plus de `FLOOD_REFRESH_DAYS` jours.
 */
export function floodRefreshReason(
  stored: StoredFloodRisk | null | undefined,
  currentPositionKey: string,
  now: Date,
): FloodRefreshReason | null {
  if (!stored) return "missing";
  const attemptedMs = timeOf(stored.attemptedAt);
  const retryDue =
    attemptedMs == null || now.getTime() - attemptedMs >= FLOOD_RETRY_HOURS * HOUR_MS;
  // Une tentative en échec n'est pas répétée avant `FLOOD_RETRY_HOURS` heures, quelle qu'en soit la raison.
  if (stored.failureCount > 0 && !retryDue) return null;
  if (stored.positionKey !== currentPositionKey) return "position_changed";
  if (retryDue && (stored.failureCount > 0 || !stored.ppriChecked)) return "retry";
  if (stored.deriveVersion !== FLOOD_DERIVE_VERSION) return "version";
  const observedMs = timeOf(stored.observedAt);
  if (observedMs == null) return retryDue ? "retry" : null;
  if (now.getTime() - observedMs >= FLOOD_REFRESH_DAYS * DAY_MS) return "aged";
  return null;
}

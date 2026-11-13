import { departmentCode } from "@/lib/department-code";
import { propertyFamily, type PropertyFamily } from "@/lib/property-type-family";

// Loyer de référence en €/m²/mois : carte des loyers de l'ANIL à la commune (table `anil_rents`,
// lue côté serveur par `rent-reference.server.ts`), ou, faute de donnée ANIL, la table
// départementale ci-dessous.
//
// Ce module est pur et sans accès réseau : il sert aussi au navigateur, qui reçoit la référence
// déjà résolue par le serveur. Le loyer ANIL est un loyer d'ANNONCE, CHARGES COMPRISES, non meublé :
// ce n'est ni un loyer constaté, ni un loyer garanti, ni un loyer hors charges.

/** Seuils de la règle de fiabilité d'une estimation ANIL à la commune. */
const RENT_RELIABLE_MIN_OBSERVATIONS = 30;
const RENT_RELIABLE_MIN_R2 = 0.5;

export type RentSegment = "apt_all" | "apt_1_2" | "apt_3p" | "house";
export const RENT_SEGMENTS: readonly RentSegment[] = ["apt_all", "apt_1_2", "apt_3p", "house"];

export type RentReferenceSource =
  | "anil_commune"
  | "anil_maille"
  | "anil_epci"
  /** Paris, Lyon ou Marseille sans arrondissement connu : médiane de leurs arrondissements. */
  | "anil_arrondissements_median"
  /** Médiane des communes du département, calculée sur la carte (repli avant la table codée en dur). */
  | "anil_department_median"
  | "department_estimate";

/** Sources tirées de la carte de l'ANIL : leur affichage demande le crédit et le millésime. */
export const ANIL_RENT_SOURCES: readonly RentReferenceSource[] = [
  "anil_commune",
  "anil_maille",
  "anil_epci",
  "anil_arrondissements_median",
  "anil_department_median",
];

/**
 * `reliable` : estimation calculée sur la commune elle-même (`TYPPRED` = commune) avec au moins 30
 * observations et un R² ajusté d'au moins 0,5. Tout le reste (maille, EPCI, peu d'observations,
 * repli départemental) est `indicative`.
 */
export type RentReliability = "reliable" | "indicative";

export type RentReference = {
  rentPerM2: number;
  source: RentReferenceSource;
  reliability: RentReliability;
  /** Segment ANIL retenu ; `null` pour le repli départemental. */
  segment?: RentSegment | null;
  communeCode?: string | null;
  lowPerM2?: number | null;
  highPerM2?: number | null;
  /** Annonces observées dans la commune (`nbobs_com`). */
  observations?: number | null;
  /** Millésime et date de mise à jour de la donnée réellement utilisée (ISO `AAAA-MM-JJ`). */
  vintage?: number | null;
  sourceUpdatedOn?: string | null;
};

/** Une ligne de `anil_rents`, telle que le serveur la lit. */
export type AnilRentRow = {
  commune_code: string;
  segment: string;
  rent_per_m2: number;
  rent_low_per_m2: number | null;
  rent_high_per_m2: number | null;
  prediction_type: string;
  observations_commune: number | null;
  r2_adj: number | null;
  vintage: number;
  source_updated_on: string | null;
};

/** Référence d'une vente (l'identifiant sert de clé), ou `null` : aucune référence locale. */
export type RentLookup = (sale: { id: string }) => RentReference | null;

// Loyers de référence départementaux, en €/m²/mois : repli quand la commune n'a pas de donnée ANIL.
//
// Ce ne sont que des ordres de grandeur pour les grandes agglomérations. Un département absent n'a
// PAS de référence : on n'affiche alors aucun rendement plutôt que d'inventer un loyer (l'ancien
// repli à 11 €/m² faussait les ventes de Creuse, de Corrèze, etc.).
//
// Statut (31/10/2026) : cette table n'a PAS de source. Elle ne sert qu'à afficher un loyer et un
// rendement « indicatifs », toujours étiquetés `department_estimate` / `indicative`. Elle ne doit
// alimenter aucun autre montant : la taxe foncière par défaut du plafond en dépendait, elle n'existe
// plus (`bid-ceiling-defaults.ts` : le champ est « à renseigner »).
const RENT_BY_DEPARTMENT: Record<string, number> = {
  "75": 32,
  "92": 26,
  "93": 19,
  "94": 21,
  "78": 18,
  "77": 14,
  "91": 15,
  "95": 15,
  "69": 15,
  "13": 14,
  "06": 17,
  "33": 14,
  "31": 13,
  "44": 13,
  "67": 12,
  "59": 11,
  "35": 13,
  "34": 13,
  "76": 11,
  "38": 12,
  "83": 14,
  "42": 9,
  "29": 11,
  "21": 11,
};

/** Familles qui ne sont pas un logement : leur segment de loyer ne dépend pas des pièces. */
const NOT_A_HOME: ReadonlySet<PropertyFamily> = new Set([
  "building",
  "land",
  "parking",
  "commercial",
]);

/**
 * Segment de la carte des loyers d'une vente : maison pour une maison ; pour un appartement,
 * T1-T2 jusqu'à 2 pièces et T3 et plus au-delà ; tous appartements quand le nombre de pièces est
 * inconnu ou que le type n'est pas un logement.
 */
export function rentSegmentFor(sale: {
  property_type?: string | null;
  rooms_count?: number | null;
}): RentSegment {
  const family = propertyFamily(sale.property_type);
  if (family === "house") return "house";
  const rooms = sale.rooms_count;
  if (NOT_A_HOME.has(family) || typeof rooms !== "number" || !(rooms >= 1)) return "apt_all";
  return rooms <= 2 ? "apt_1_2" : "apt_3p";
}

/** Ce que `isRentApplicable` lit d'une vente : son type et, à défaut de type, la surface publiée. */
export type RentApplicableSale = {
  property_type?: string | null;
  app_surface_m2?: number | null;
  habitable_surface_m2?: number | null;
  carrez_surface_m2?: number | null;
};

/**
 * Seul un logement a une référence de loyer. Liste blanche : une maison ou un appartement (codes du pipeline
 * `house` et `apartment`, et leurs variantes françaises). Un terrain, un parking, un garage, un local, un bureau ou
 * un immeuble n'en a aucune (« Loyer de référence indisponible »), ni ANIL ni départementale ; les lots « mixed »
 * (local mixte) et « other » (annexes, lots divers) non plus. Un type « unknown » ou absent n'a de référence que si la
 * vente publie une surface (un logement sans type se reconnaît à sa surface, un lot sans rien n'est pas chiffrable).
 */
export function isRentApplicable(sale: RentApplicableSale): boolean {
  const family = propertyFamily(sale.property_type);
  if (family === "house" || family === "apartment") return true;
  if (family === "unknown") {
    const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2;
    return typeof surface === "number" && Number.isFinite(surface) && surface > 0;
  }
  return false;
}

export function rentReliability(row: {
  prediction_type: string;
  observations_commune: number | null;
  r2_adj: number | null;
}): RentReliability {
  return row.prediction_type === "commune" &&
    (row.observations_commune ?? 0) >= RENT_RELIABLE_MIN_OBSERVATIONS &&
    (row.r2_adj ?? 0) >= RENT_RELIABLE_MIN_R2
    ? "reliable"
    : "indicative";
}

const ANIL_SOURCE_BY_TYPE: Record<string, RentReferenceSource> = {
  commune: "anil_commune",
  maille: "anil_maille",
  epci: "anil_epci",
};

/** Référence tirée d'une ligne ANIL, ou `null` pour une ligne inexploitable. */
export function rentReferenceFromAnilRow(row: AnilRentRow): RentReference | null {
  const source = ANIL_SOURCE_BY_TYPE[row.prediction_type];
  const rentPerM2 = Number(row.rent_per_m2);
  if (!source || !Number.isFinite(rentPerM2) || rentPerM2 <= 0) return null;
  const segment = RENT_SEGMENTS.find((item) => item === row.segment) ?? null;
  const optional = (value: number | null) =>
    value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    rentPerM2,
    source,
    reliability: rentReliability(row),
    segment,
    communeCode: row.commune_code,
    lowPerM2: optional(row.rent_low_per_m2),
    highPerM2: optional(row.rent_high_per_m2),
    observations: optional(row.observations_commune),
    vintage: row.vintage,
    sourceUpdatedOn: row.source_updated_on,
  };
}

/**
 * Référence calculée sur la carte de l'ANIL sans ligne pour la commune elle-même (médiane des arrondissements
 * ou du département) : toujours `indicative`, avec le millésime et la date de la carte utilisée.
 */
export function rentReferenceFromAnilMedian(input: {
  rentPerM2: number;
  source: "anil_arrondissements_median" | "anil_department_median";
  segment: RentSegment | null;
  communeCode?: string | null;
  vintage: number | null;
  sourceUpdatedOn: string | null;
}): RentReference | null {
  if (!Number.isFinite(input.rentPerM2) || input.rentPerM2 <= 0) return null;
  return {
    rentPerM2: Math.round(input.rentPerM2 * 10_000) / 10_000,
    source: input.source,
    reliability: "indicative",
    segment: input.segment,
    communeCode: input.communeCode ?? null,
    vintage: input.vintage,
    sourceUpdatedOn: input.sourceUpdatedOn,
  };
}

/** Repli : loyer départemental, ou `null` quand le département n'a aucune référence. */
export function rentReference(department: string | null | undefined): RentReference | null {
  const code = departmentCode(department);
  const rentPerM2 = code ? RENT_BY_DEPARTMENT[code] : undefined;
  return rentPerM2 == null
    ? null
    : {
        rentPerM2,
        source: "department_estimate",
        reliability: "indicative",
      };
}

/** La référence ANIL quand elle existe, sinon le repli départemental. */
export function resolveRentReference(
  anil: RentReference | null | undefined,
  department: string | null | undefined,
): RentReference | null {
  return anil ?? rentReference(department);
}

/** Loyer de référence en €/m²/mois, ou `null` quand aucune référence locale n'existe. */
export function defaultRentPerM2(
  department: string | null | undefined,
  reference?: RentReference | null,
): number | null {
  return resolveRentReference(reference, department)?.rentPerM2 ?? null;
}

export const RENT_REFERENCE_UNAVAILABLE = "Loyer de référence indisponible";

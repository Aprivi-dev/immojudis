/**
 * Famille de bien, seule règle de classement d'un type de bien : le code du pipeline
 * (`auction_sales.property_type` : apartment, house, building, land, commercial, parking, mixed,
 * other, unknown), un libellé français (« Maison avec terrain », « Local commercial »), un libellé
 * DVF (« Local industriel. commercial ou assimilé », « BATI MIXTE - LOGEMENT/ACTIVITE ») ou un
 * titre. Chaque module garde sa propre découpe (segment d'estimation, classe des statistiques de
 * tribunal, segment de loyer…), mais la tire de cette famille.
 *
 * - `unknown` : rien de lisible (absent, vide, « unknown », « inconnu », « non précisé »).
 * - `other` : un type écrit qu'aucune famille ne reconnaît (« other », « Dépendance », « Cave »).
 *
 * Les familles sont essayées dans l'ordre de `FAMILY_PATTERNS` : le logement avant l'immeuble, le
 * terrain, le parking et le local (« Maison avec terrain » est une maison, « Appartement avec
 * parking » un appartement) ; l'immeuble avant le mixte (« Immeuble mixte » est un immeuble).
 */
export type PropertyFamily =
  | "apartment"
  | "house"
  | "building"
  | "mixed"
  | "land"
  | "parking"
  | "commercial"
  | "other"
  | "unknown";

const FAMILY_PATTERNS: ReadonlyArray<readonly [PropertyFamily, RegExp]> = [
  [
    "apartment",
    /appartement|apartment|\bappart|\bapt\b|studio|duplex|triplex|loft|\bflat\b|\bt[1-9]\b/,
  ],
  ["house", /maison|house|villa|pavillon|chalet|\blongere\b|\bferme\b|\bchateau\b|\bmas\b|bastide/],
  ["building", /immeuble|batiment|building/],
  ["mixed", /mixte|mixed/],
  ["land", /terrain|\bland\b|parcelle|\bpre\b|\bbois\b|agricole/],
  ["parking", /parking|garage|\bbox\b/],
  ["commercial", /commerc|\blocal\b|\blocaux\b|bureau|retail|entrepot|hangar|atelier|usine/],
  // « Propriété » (un domaine) est une maison, mais en dernier : « Local en pleine propriété » est un
  // local, « Terrain en pleine propriété » un terrain.
  ["house", /\bpropriete\b/],
];

const UNKNOWN_TYPE = /^(?:unknown|inconnu|non precise?e?)$/;

export function propertyFamily(value: string | null | undefined): PropertyFamily {
  const text = (value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR");
  if (!text || UNKNOWN_TYPE.test(text)) return "unknown";
  return FAMILY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

/**
 * Filtre « Type de bien » de la recherche et des alertes : une vente le passe quand son type est de la
 * famille du filtre. Chaque code de la base est le nom de sa propre famille : la recherche serveur,
 * qui compare la colonne au code du filtre (`queries.ts`, recherche publique), suit la même règle.
 */
export function matchesPropertyTypeFilter(
  propertyType: string | null | undefined,
  filter: string,
): boolean {
  return propertyFamily(propertyType) === propertyFamily(filter);
}

/**
 * Un bien de type `candidate` est-il comparable à un bien de type `subject` (même famille) ? Un
 * sujet de type inconnu accepte tout ; un sujet « autre » n'accepte rien : deux types qu'aucune
 * famille ne reconnaît (une dépendance, une cave) ne se ressemblent pas pour autant.
 */
export function matchesPropertyFamily(
  candidate: string | null | undefined,
  subject: string | null | undefined,
): boolean {
  const subjectFamily = propertyFamily(subject);
  if (subjectFamily === "unknown") return true;
  return subjectFamily !== "other" && propertyFamily(candidate) === subjectFamily;
}

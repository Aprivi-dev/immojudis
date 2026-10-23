/**
 * Cross-checks the official land report against what the listing itself says:
 * the PLU zone quoted by the seller's lawyer and the land surface announced.
 * Neither proves anything on its own; a disagreement is a point to verify.
 */
import type {
  LandParcel,
  LandPlanningResult,
  LandSourceCheck,
  LandZone,
} from "./land-report-types";

// A short code: one to three capitals, then (if anything follows) a lowercase letter, a digit or « * »
// to open the sub-sector, as in « UP1*1L40 ». The lookahead keeps a long capitalised word such as
// « NATURELLE » from being cut into « NAT ».
const ZONE_CODE = String.raw`([A-Z]{1,3}(?:[a-z0-9*][A-Za-z0-9*]{0,11})?)(?![A-Za-z0-9*])`;
// Words that look like a code once capitalised (« Nord », « Sud ») but are not a PLU zone.
const NOT_A_ZONE = /^(?:nord|sud|est|ouest|naturelle?s?|agricoles?|urbaine?s?|forest\w*)$/i;
const KEYWORD = String.raw`(?:[Zz]one|ZONE|[Zz]onage|[Ss]ecteur)`;
const PLU = String.raw`P\.?\s?L\.?\s?U(?:i\b|\.|\b)`;
const LISTING_ZONE_PATTERNS = [
  // « Zone UP1*1L40 du PLU », « classé en zone UB au PLUi »
  new RegExp(String.raw`\b${KEYWORD}\s*:?\s*${ZONE_CODE}[^.;\n]{0,30}?\b${PLU}`, "u"),
  // « PLU : zone UB », « au PLU en zone Nh »
  new RegExp(String.raw`\b${PLU}[^.;\n]{0,20}?\b${KEYWORD}\s*:?\s*${ZONE_CODE}`, "u"),
];

/** The PLU zone quoted in the listing text, as written (« UP1*1L40 »). */
export function listingPluZone(...texts: Array<string | null | undefined>): string | null {
  for (const value of texts) {
    if (!value) continue;
    for (const pattern of LISTING_ZONE_PATTERNS) {
      const code = pattern.exec(value)?.[1];
      // « zone du PLU » or « zone PLU » is not a zone code.
      if (code && !/^PLU/i.test(code) && !NOT_A_ZONE.test(code)) return code;
    }
  }
  return null;
}

export type ListingZoneCheck = {
  zone: string;
  /** null when the report found no official zone to compare with. */
  matches: boolean | null;
};

/**
 * `longer` refines `shorter` when it is the same code followed by a sub-sector mark (a digit, a
 * lowercase letter or « * »): « UP1*1L40 » refines « UP1 », « UCa2 » refines « UC ». A capital after
 * the code is another family (« AU » is not « A », « UA » is not « U »), and a digit after a digit
 * is another zone (« UP10 » is not « UP1 »).
 */
function refinesZone(longer: string, shorter: string): boolean {
  if (longer.length <= shorter.length) return false;
  if (longer.slice(0, shorter.length).toUpperCase() !== shorter.toUpperCase()) return false;
  const mark = longer[shorter.length];
  if (!/[0-9a-z*]/.test(mark)) return false;
  return !(/[0-9]/.test(mark) && /[0-9]$/.test(shorter));
}

function sameZone(quoted: string, label: string): boolean {
  return (
    quoted.toUpperCase() === label.toUpperCase() ||
    refinesZone(quoted, label) ||
    refinesZone(label, quoted)
  );
}

/**
 * A listing code « UP1*1L40 » agrees with the official zone « UP1 » it refines. Never across
 * families: « A » and « AU », « N » and « NA », « U » and « UA » are different zones.
 */
export function compareListingZone(
  listingZone: string | null,
  zones: Pick<LandZone, "label">[],
): ListingZoneCheck | null {
  if (!listingZone) return null;
  const labels = zones.map((zone) => zone.label.replace(/\s+/g, "")).filter(Boolean);
  if (!labels.length) return { zone: listingZone, matches: null };
  const quoted = listingZone.replace(/\s+/g, "");
  return { zone: listingZone, matches: labels.some((label) => sameZone(quoted, label)) };
}

/**
 * The parcels found against the land surface announced. A gap of more than a
 * quarter (and 50 m²) means the report does not describe the whole lot, or not
 * the right parcel.
 */
export function parcelSurfaceGap(
  parcels: Pick<LandParcel, "surfaceM2">[],
  landSurfaceM2: number | null | undefined,
): string | null {
  if (!landSurfaceM2 || !Number.isFinite(landSurfaceM2) || landSurfaceM2 <= 0) return null;
  const surfaces = parcels.map((parcel) => parcel.surfaceM2);
  if (!surfaces.length || surfaces.some((surface) => surface == null)) return null;
  const total = surfaces.reduce<number>((sum, surface) => sum + (surface ?? 0), 0);
  if (Math.abs(total - landSurfaceM2) <= Math.max(50, landSurfaceM2 * 0.25)) return null;
  const format = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const found = `${format.format(total)} m²`;
  const announced = `${format.format(landSurfaceM2)} m²`;
  return total < landSurfaceM2
    ? `Le cadastre retrouvé couvre ${found} alors que l’annonce indique ${announced} de terrain : d’autres parcelles font sans doute partie de la vente.`
    : `La parcelle retrouvée (${found}) est plus grande que le terrain annoncé (${announced}) : elle peut englober d’autres lots ou ne pas être la bonne.`;
}

export type LandReportReliability = {
  tone: "good" | "watch" | "weak";
  text: string;
};

/** One line saying how far the parcel, hence the zone and the rules, belong to the property. */
export function landReportReliability(
  planning: Pick<LandPlanningResult, "parcels" | "locationStatus">,
): LandReportReliability {
  const matches = new Set(planning.parcels.map((parcel) => parcel.match));
  if (matches.has("listing_reference")) {
    return { tone: "good", text: "Parcelle identifiée par la référence cadastrale de l’annonce." };
  }
  if (matches.has("document_reference") || matches.has("stored_reference")) {
    return { tone: "good", text: "Parcelle identifiée par une référence cadastrale du dossier." };
  }
  if (planning.parcels.length === 1) {
    return {
      tone: "watch",
      text: "Parcelle probable d’après l’adresse : à confirmer dans le cahier des conditions de vente.",
    };
  }
  if (planning.parcels.length > 1) {
    return {
      tone: "watch",
      text: "Plusieurs parcelles possibles autour de l’adresse : à confirmer dans le cahier des conditions de vente.",
    };
  }
  return {
    tone: "weak",
    text: "Parcelle non identifiée : le zonage et les règles ne peuvent pas être rattachés au bien.",
  };
}

/** Why no article could be read, in words a buyer understands. */
export function rulesUnavailableReason(checks: Pick<LandSourceCheck, "message">[]): string {
  const messages = checks.map((check) => check.message ?? "").join(" ");
  if (/taille supérieure|trop volumineu/i.test(messages)) {
    return "Le règlement est trop volumineux pour être lu automatiquement.";
  }
  if (/pas de texte lisible|illisible/i.test(messages)) {
    return "Le règlement publié est un document numérisé, sans texte lisible.";
  }
  if (/délai dépassé|indisponible|HTTP/i.test(messages)) {
    return "Le règlement n’a pas pu être téléchargé pour le moment.";
  }
  return "Aucun article de la zone n’a pu être extrait automatiquement.";
}

export type LandZoneFamily = "U" | "AU" | "A" | "N";

/** What each family of PLU zone means, in words a buyer understands. */
export const LAND_ZONE_FAMILY_TEXT: Record<LandZoneFamily, { name: string; hint: string }> = {
  U: { name: "zone urbaine (U)", hint: "secteur déjà bâti ou équipé" },
  AU: {
    name: "zone à urbaniser (AU)",
    hint: "secteur destiné à être construit, souvent sous conditions d’aménagement",
  },
  A: {
    name: "zone agricole (A)",
    hint: "terres agricoles, où les constructions sont en principe très limitées",
  },
  N: {
    name: "zone naturelle (N)",
    hint: "espaces naturels, où les constructions sont en principe très limitées",
  },
};

/** « UCa2 » → U, « AUs » → AU, « 1AUh » → AU, « Nh » → N, « Ap » → A; null when unknown. */
function zoneFamily(value: string | null | undefined): LandZoneFamily | null {
  const code = (value ?? "").trim().replace(/^[0-9]+/, "");
  // Case-sensitive on purpose: the GPU type « unknown » is not a U zone.
  if (/^AU/.test(code)) return "AU";
  if (/^U/.test(code)) return "U";
  if (/^A/.test(code)) return "A";
  if (/^N/.test(code)) return "N";
  return null;
}

/** The families (U, AU, A, N) of the official zones found, in this order, without repeats. */
export function landZoneFamilies(zones: Pick<LandZone, "label" | "type">[]): LandZoneFamily[] {
  const found = new Set(zones.map((zone) => zoneFamily(zone.type) ?? zoneFamily(zone.label)));
  return (["U", "AU", "A", "N"] as const).filter((family) => found.has(family));
}

/** The headline verdict: the zone family in plain words, or null when no zone was identified. */
export function landZoneVerdict(zones: Pick<LandZone, "label" | "type">[]): string | null {
  const families = landZoneFamilies(zones);
  if (!families.length) return null;
  const [first, ...others] = families.map((family) => LAND_ZONE_FAMILY_TEXT[family]);
  if (!others.length) return `Terrain en ${first.name} : ${first.hint}.`;
  const names = [first, ...others].map((entry) => entry.name);
  return `Terrain à cheval sur plusieurs zones : ${names.slice(0, -1).join(", ")} et ${names.at(-1)}.`;
}

export type LandConstraintsOverview =
  | { status: "found"; count: number }
  | { status: "none" }
  | { status: "unverified"; reason: string };

/** Planning layers that carry servitudes, prescriptions and information perimeters. */
const CONSTRAINT_LAYER_CHECK = /^gpu\.(?:prescription-|info-|assiette-sup-)/;

/**
 * Whether the servitudes were really looked up. An empty list proves nothing when the parcel is
 * unknown or a source was down: it is « not verified », never « none found ».
 */
export function landConstraintsOverview(
  planning: Pick<LandPlanningResult, "parcels" | "constraints" | "checks">,
): LandConstraintsOverview {
  if (planning.constraints.length) return { status: "found", count: planning.constraints.length };
  if (!planning.parcels.length) {
    return {
      status: "unverified",
      reason: "la parcelle n’est pas identifiée, les servitudes ne peuvent pas lui être rattachées",
    };
  }
  const layers = planning.checks.filter((check) => CONSTRAINT_LAYER_CHECK.test(check.key));
  if (!layers.length) {
    return {
      status: "unverified",
      reason: "la source officielle des servitudes n’a pas pu être consultée",
    };
  }
  if (layers.some((check) => check.status !== "available" && check.status !== "empty")) {
    return {
      status: "unverified",
      reason: "une partie des couches de servitudes n’a pas pu être consultée",
    };
  }
  return { status: "none" };
}

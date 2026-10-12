/**
 * Cross-checks the official land report against what the listing itself says:
 * the PLU zone quoted by the seller's lawyer and the land surface announced.
 * Neither proves anything on its own; a disagreement is a point to verify.
 */
import type { LandParcel, LandZone } from "./land-report-types";

const ZONE_CODE = String.raw`([A-Z]{1,4}[A-Za-z0-9*]{0,12})`;
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
      if (code && !/^PLU/i.test(code)) return code;
    }
  }
  return null;
}

export type ListingZoneCheck = {
  zone: string;
  /** null when the report found no official zone to compare with. */
  matches: boolean | null;
};

/** A listing code « UP1*1L40 » agrees with the official zone « UP1 » it starts with. */
export function compareListingZone(
  listingZone: string | null,
  zones: Pick<LandZone, "label">[],
): ListingZoneCheck | null {
  if (!listingZone) return null;
  const labels = zones.map((zone) => zone.label.trim().toUpperCase()).filter(Boolean);
  if (!labels.length) return { zone: listingZone, matches: null };
  const quoted = listingZone.toUpperCase();
  return {
    zone: listingZone,
    matches: labels.some((label) => quoted.startsWith(label) || label.startsWith(quoted)),
  };
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

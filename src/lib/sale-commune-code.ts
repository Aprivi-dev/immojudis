import { asRecordOrNull } from "@/lib/guards";

// POINT DE RACCORD : code INSEE de la commune d'une vente. C'est ICI, et nulle part ailleurs, qu'il faut
// rebrancher la source du code ; `rent-reference.server.ts` n'appelle que `saleCommuneCode`.
//
// Ordre de lecture :
//  1. `raw_payload.commune.arrondissement_insee`, puis `raw_payload.commune.insee` : ce que le
//     pipeline du lot « code commune » écrira (arrondissements de Paris, Lyon et Marseille compris) ;
//  2. `raw_payload.geocode.citycode`, là où le pipeline l'écrit déjà à chaque géocodage accepté.
// Pour 75056, 69123 et 13055 (la commune, sans arrondissement), l'arrondissement se déduit du code
// postal de la vente (75008 donne 75108, 69003 donne 69383, 13008 donne 13208).
// Quand la table `auction_sale_communes` sera fusionnée, la lire en premier ici.
//
// `raw_payload` n'est exposé ni au navigateur ni aux vues de liste : hors lecture serveur, la fonction
// rend `null` et le loyer retombe sur le repli départemental.

const INSEE_PATTERN = /^[0-9][0-9AB][0-9]{3}$/;

/** Code INSEE valide (majuscules), ou `null`. */
export function normalizeCommuneCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return INSEE_PATTERN.test(code) ? code : null;
}

/**
 * Code commune d'une géocodification du pipeline (`raw_payload.geocode`) : seulement quand elle est
 * acceptée (`accepted` n'est pas explicitement faux).
 */
export function communeCodeFromGeocode(geocode: unknown): string | null {
  const record = asRecordOrNull(geocode);
  if (!record || record.accepted === false || record.accepted === "false") return null;
  return normalizeCommuneCode(record.citycode);
}

/**
 * Arrondissement d'une des trois communes à arrondissements, déduit du code postal ; le code reçu
 * sinon (autre commune, arrondissement déjà connu, code postal absent ou d'une autre ville).
 */
export function arrondissementCode(
  communeCode: string | null,
  postalCode: string | null | undefined,
): string | null {
  const postal = (postalCode ?? "").trim();
  if (communeCode === "75056") {
    if (postal === "75116") return "75116";
    const match = /^750(0[1-9]|1\d|20)$/.exec(postal);
    return match ? `751${match[1]}` : communeCode;
  }
  if (communeCode === "69123") {
    const match = /^6900([1-9])$/.exec(postal);
    return match ? `6938${match[1]}` : communeCode;
  }
  if (communeCode === "13055") {
    const match = /^130(0[1-9]|1[0-6])$/.exec(postal);
    return match ? `132${match[1]}` : communeCode;
  }
  return communeCode;
}

export function saleCommuneCode(sale: {
  raw_payload?: unknown;
  postal_code?: string | null;
}): string | null {
  const payload = asRecordOrNull(sale.raw_payload);
  const commune = asRecordOrNull(payload?.commune);
  const code =
    normalizeCommuneCode(commune?.arrondissement_insee) ??
    normalizeCommuneCode(commune?.insee) ??
    communeCodeFromGeocode(payload?.geocode);
  return arrondissementCode(code, sale.postal_code);
}

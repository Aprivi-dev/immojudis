// DPE retenu pour le coût de rénovation énergétique de la règle pepite-v1.2 et suivantes. Fonctions PURES : les
// lectures (`auction_dpe_diagnostics`, `raw_payload`) sont faites par l'appelant (`pepite-context.server.ts`).
//
// Source du DPE (décision du 29/10/2026) : le diagnostic de l'ADEME rapproché de la vente
// (`auction_dpe_diagnostics`) est prioritaire quand sa confiance est d'au moins `PEPITE_DPE_MIN_CONFIDENCE` (0,8) ;
// sinon la classe publiée par l'annonce (`raw_payload.source_energy_diagnostics.dpe_class`). Pas de DPE : classe
// nulle, aucun coût ajouté, et la règle le signale dans les détails. La sélection de la classe ADEME est celle de
// la fiche (`extractDpe`, `dpe.ts`).
import {
  extractDpe,
  normalizeDpeClass,
  type DpeClass,
  type StructuredDpeDiagnostic,
} from "@/lib/dpe";
import { PEPITE_DPE_MIN_CONFIDENCE, type PepiteEnergyInput } from "@/lib/pepite-policy";

/** Ce que la règle lit d'une ligne de `auction_dpe_diagnostics`. */
export type PepiteDpeRow = {
  diagnostic_number: string | null;
  dpe_class: string | null;
  established_at: string | null;
  confidence: number | null;
};

/** Une ligne lue, au format des diagnostics structurés de la fiche (les champs que la règle ne lit pas restent nuls). */
export function pepiteDpeDiagnostic(row: PepiteDpeRow): StructuredDpeDiagnostic {
  return {
    diagnosticNumber: row.diagnostic_number,
    dpeClass: normalizeDpeClass(row.dpe_class),
    gesClass: null,
    establishedAt: row.established_at,
    validUntil: null,
    propertyType: null,
    address: null,
    city: null,
    postalCode: null,
    inseeCode: null,
    department: null,
    surfaceM2: null,
    energyConsumptionKwhM2Year: null,
    emissionsKgCo2M2Year: null,
    latitude: null,
    longitude: null,
    matchKind: null,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    sourceApi: null,
  };
}

/**
 * Le DPE retenu : ADEME de confiance d'au moins 0,8 d'abord, sinon l'annonce, sinon inconnu. Une classe ADEME
 * rapprochée avec une confiance plus faible n'est jamais retenue, même si l'annonce ne dit rien.
 */
export function selectPepiteDpe({
  diagnostics,
  listingClass,
}: {
  diagnostics: readonly StructuredDpeDiagnostic[];
  /** `raw_payload.source_energy_diagnostics.dpe_class` de la vente. */
  listingClass: unknown;
}): PepiteEnergyInput {
  const confident = diagnostics.filter(
    (diagnostic) => (diagnostic.confidence ?? 0) >= PEPITE_DPE_MIN_CONFIDENCE,
  );
  const ademe = extractDpe({ source_blocks: null, documents_rich: null }, confident);
  if (ademe.source === "ademe" && ademe.class) {
    return { dpeClass: ademe.class, dpeSource: "ademe" };
  }
  const listing: DpeClass | null = normalizeDpeClass(listingClass);
  return listing
    ? { dpeClass: listing, dpeSource: "listing" }
    : { dpeClass: null, dpeSource: null };
}

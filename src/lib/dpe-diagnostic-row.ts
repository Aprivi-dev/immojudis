import type { DpeDiagnosticRow } from "@/lib/property-reports";
import type { StructuredDpeDiagnostic } from "@/lib/dpe";
import { normalizeDpeClass } from "@/lib/dpe";

export function dpeDiagnosticRowToStructured(row: DpeDiagnosticRow): StructuredDpeDiagnostic {
  return {
    diagnosticNumber: row.diagnostic_number ?? null,
    dpeClass: normalizeDpeClass(row.dpe_class),
    gesClass: normalizeDpeClass(row.ges_class),
    establishedAt: row.established_at ?? null,
    validUntil: row.valid_until ?? null,
    propertyType: row.property_type ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    inseeCode: row.insee_code ?? null,
    department: row.department ?? null,
    surfaceM2: row.surface_m2 ?? null,
    energyConsumptionKwhM2Year: row.energy_consumption_kwh_m2_year ?? null,
    emissionsKgCo2M2Year: row.emissions_kg_co2_m2_year ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    matchKind: row.match_kind ?? null,
    confidence: row.confidence ?? null,
    sourceApi: row.source_api ?? null,
  };
}

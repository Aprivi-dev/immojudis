import { propertyTypeLabel } from "@/lib/format";
import {
  AI_REVIEW_ENERGY_FIELD_KEYS,
  AI_REVIEW_SURFACE_FIELD_KEYS,
  getAiReviewFieldResult,
  type AiReviewFieldKey,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import type { AuctionSale } from "@/lib/types";

/**
 * Builds the value object passed to authenticated display components. The API
 * deliberately returns review status without a value; clearing a blocked
 * source field here prevents a secondary child component from bypassing the
 * guard while the request is loading or unavailable.
 */
export function saleForAiReviewDisplay(
  sale: AuctionSale,
  projections: readonly AiReviewProjectionReadModel[] | null,
  requestStatus: AiReviewRequestStatus,
): AuctionSale {
  if (requestStatus === "disabled") return sale;

  const guarded = { ...sale };
  const blocked = (fieldKey: Parameters<typeof getAiReviewFieldResult>[1]) =>
    getAiReviewFieldResult(projections, fieldKey, requestStatus).blocked;

  const propertyTypeBlocked = blocked("property.property_type");
  const cityBlocked = blocked("property.city");
  if (propertyTypeBlocked) guarded.property_type = null;
  if (cityBlocked) {
    guarded.city = null;
    guarded.postal_code = null;
    guarded.address = null;
    guarded.tribunal_city = null;
    guarded.title = propertyTypeBlocked
      ? "Type de bien à confirmer"
      : `${propertyTypeLabel(sale.property_type)} · Localisation à confirmer`;
  }
  if (blocked("sale.sale_date")) {
    guarded.sale_date = null;
    guarded.visit_dates = null;
    guarded.sale_procedure = stripSaleDateFields(guarded.sale_procedure);
    guarded.source_blocks = stripSaleDateFields(guarded.source_blocks);
    guarded.source_blocks_by_source = stripSaleDateFieldsBySource(guarded.source_blocks_by_source);
    // `listingVisits` also derives a compact visit excerpt from the source
    // description when structured slots are absent. Keep that fallback from
    // bypassing the blocked sale-date field while retaining the raw data in
    // the server-side dossier.
    guarded.source_description = null;
    guarded.description = null;
    guarded.llm_display_description = null;
    guarded.about_description = null;
  }
  if (blocked("sale.starting_price_eur")) {
    guarded.starting_price_eur = null;
    guarded.adjudication_price_eur = null;
  }
  if (blocked("property.rooms_count")) {
    guarded.rooms_count = null;
    guarded.bedrooms_count = null;
  }
  if (blocked("property.occupancy_status")) guarded.occupancy_status = null;
  if (blocked("property.parking_count")) guarded.parking_count = null;

  const blockedConflictFields = new Set(
    (
      [
        "property.property_type",
        "property.city",
        "sale.sale_date",
        "sale.starting_price_eur",
        ...AI_REVIEW_SURFACE_FIELD_KEYS,
        "property.occupancy_status",
        "property.rooms_count",
        "property.parking_count",
        "property.source_energy_dpe_class",
        "property.source_energy_ges_class",
      ] as const satisfies readonly AiReviewFieldKey[]
    )
      .filter((fieldKey) => blocked(fieldKey))
      .flatMap((fieldKey) => [fieldKey, fieldKey.replace(/^property\.|^sale\./, "")]),
  );
  if (guarded.source_conflicts) {
    guarded.source_conflicts = guarded.source_conflicts.filter(
      (conflict) => !conflict.field || !blockedConflictFields.has(conflict.field),
    );
  }

  if (AI_REVIEW_SURFACE_FIELD_KEYS.some((fieldKey) => blocked(fieldKey))) {
    guarded.app_surface_m2 = null;
    guarded.habitable_surface_m2 = null;
    guarded.carrez_surface_m2 = null;
    guarded.land_surface_m2 = null;
    guarded.app_surface_kind = null;
    guarded.surface_scope = null;
    guarded.surface_source = null;
    guarded.surface_confidence = null;
    guarded.surface_evidence = null;
  }

  if (AI_REVIEW_ENERGY_FIELD_KEYS.some((fieldKey) => blocked(fieldKey))) {
    guarded.source_blocks = stripEnergyFields(guarded.source_blocks);
    guarded.source_blocks_by_source = stripEnergyFieldsBySource(guarded.source_blocks_by_source);
  }

  return guarded;
}

const ENERGY_SOURCE_KEYS = new Set([
  "dpe",
  "dpe_classe",
  "dpe_class",
  "ges",
  "ges_classe",
  "ges_class",
  "energy_dpe_class",
  "energy_ges_class",
  "source_energy_dpe_class",
  "source_energy_ges_class",
]);

function stripEnergyFields(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const sanitized = stripFields(value, ENERGY_SOURCE_KEYS);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : null;
}

function stripEnergyFieldsBySource(
  value: Record<string, Record<string, unknown>> | null,
): Record<string, Record<string, unknown>> | null {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value).map(([source, blocks]) => [source, stripEnergyFields(blocks) ?? {}]),
  );
}

function stripSaleDateFields(
  value: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!value) return null;
  const dateKeys = new Set([
    "sale_date",
    "opens_at",
    "closes_at",
    "starts_at",
    "ends_at",
    "start_at",
    "end_at",
    "visit",
    "visite",
    "visites",
    "visits",
    "date_visite",
    "date_de_visite",
    "detail_date_de_visite",
    "visit_date",
    "visit_dates",
    "visits_dates",
  ]);
  const sanitized = stripFields(value, dateKeys);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : null;
}

function stripSaleDateFieldsBySource(
  value: Record<string, Record<string, unknown>> | null,
): Record<string, Record<string, unknown>> | null {
  if (!value) return null;
  return Object.fromEntries(
    Object.entries(value).map(([source, blocks]) => [source, stripSaleDateFields(blocks) ?? {}]),
  );
}

function stripFields(value: unknown, blockedKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripFields(item, blockedKeys));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blockedKeys.has(key.toLocaleLowerCase("fr-FR")))
      .map(([key, entry]) => [key, stripFields(entry, blockedKeys)]),
  );
}

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DETAIL_VIEW } from "@/lib/queries";
import {
  AI_REVIEW_FIELD_KEYS,
  type AiReviewCitationStatus,
  type AiReviewProjectionReadModel,
  type AiReviewState,
} from "@/lib/ai-review-guard";

const saleIdsSchema = z.array(z.string().uuid()).min(1).max(500);

const PROJECTION_COLUMNS =
  "auction_sale_id,field_key,review_state,citation_status,is_publishable,source_name,source_url";
const CASE_STATUS_COLUMNS = "auction_sale_id,mapping_status,access_state";
const PUBLISHABLE_COLUMNS =
  "auction_sale_id,field_key,review_state,citation_status,is_publishable,source_name,source_url,value_jsonb";
const CANONICAL_COLUMNS =
  "id,property_type,city,sale_date,starting_price_eur,habitable_surface_m2,carrez_surface_m2,land_surface_m2,occupancy_status,rooms_count,parking_count,source_blocks,source_blocks_by_source";
const projectionFieldKeys = new Set<string>(AI_REVIEW_FIELD_KEYS);
const reviewStates = new Set<AiReviewState>([
  "resolved",
  "unknown",
  "absent",
  "unresolved",
  "unverified",
]);
const citationStatuses = new Set<AiReviewCitationStatus>([
  "verified",
  "unverified",
  "not_required",
]);

type ProjectionQuery = {
  select: (columns: string) => ProjectionQuery;
  in: (
    column: string,
    values: string[],
  ) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
};

type ProjectionReader = {
  from: (table: string) => ProjectionQuery;
};

const projectionReader = supabaseAdmin as unknown as ProjectionReader;

export type SaleAiReviewResponse = {
  projections: AiReviewProjectionReadModel[];
};

function response(payload: SaleAiReviewResponse | { error: string }, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "authorization",
      "referrer-policy": "no-referrer",
    },
  });
}

function sanitizeProjectionRows(
  rows: unknown[] | null,
  visibleSaleIds: ReadonlySet<string>,
  canonicalMismatches: ReadonlySet<string> = new Set(),
): AiReviewProjectionReadModel[] {
  return (rows ?? []).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const auctionSaleId = row.auction_sale_id;
    const fieldKey = row.field_key;
    const reviewState = row.review_state;
    const citationStatus = row.citation_status;
    const isPublishable = row.is_publishable;
    if (
      typeof auctionSaleId !== "string" ||
      !visibleSaleIds.has(auctionSaleId) ||
      typeof fieldKey !== "string" ||
      !projectionFieldKeys.has(fieldKey) ||
      typeof reviewState !== "string" ||
      !reviewStates.has(reviewState as AiReviewState) ||
      typeof citationStatus !== "string" ||
      !citationStatuses.has(citationStatus as AiReviewCitationStatus) ||
      typeof isPublishable !== "boolean"
    ) {
      return [];
    }

    const sourceName = row.source_name;
    const sourceUrl = row.source_url;
    const canonicalMismatch = canonicalMismatches.has(`${auctionSaleId}:${fieldKey}`);
    return [
      {
        auction_sale_id: auctionSaleId,
        field_key: fieldKey,
        review_state: reviewState as AiReviewState,
        citation_status: citationStatus as AiReviewCitationStatus,
        is_publishable: isPublishable && !canonicalMismatch,
        ...(canonicalMismatch ? { canonical_value_matches: false } : {}),
        source_name: typeof sourceName === "string" ? sourceName : null,
        source_url: typeof sourceUrl === "string" ? sourceUrl : null,
      },
    ];
  });
}

function unavailableSaleRows(
  requestedSaleIds: readonly string[],
  visibleSaleIds: ReadonlySet<string>,
): AiReviewProjectionReadModel[] {
  return requestedSaleIds
    .filter((id) => !visibleSaleIds.has(id))
    .flatMap((id) =>
      AI_REVIEW_FIELD_KEYS.map((fieldKey) => ({
        auction_sale_id: id,
        field_key: fieldKey,
        review_state: "unresolved" as const,
        citation_status: "not_required" as const,
        is_publishable: false,
        sale_unavailable: true,
        source_name: null,
        source_url: null,
      })),
    );
}

function missingProjectionRows(
  scopedSaleIds: ReadonlySet<string>,
  projections: readonly AiReviewProjectionReadModel[],
): AiReviewProjectionReadModel[] {
  const coveredFields = new Set(
    projections
      .filter(
        (projection): projection is AiReviewProjectionReadModel =>
          typeof projection.auction_sale_id === "string",
      )
      .map((projection) => `${projection.auction_sale_id}:${projection.field_key}`),
  );
  return [...scopedSaleIds].flatMap((id) =>
    AI_REVIEW_FIELD_KEYS.filter((fieldKey) => !coveredFields.has(`${id}:${fieldKey}`)).map(
      (fieldKey) => ({
        auction_sale_id: id,
        field_key: fieldKey,
        review_state: "unresolved" as const,
        citation_status: "not_required" as const,
        is_publishable: false,
        projection_missing: true,
        source_name: null,
        source_url: null,
      }),
    ),
  );
}

/**
 * Only an exact source mapping belongs to the frozen AI review sample. The
 * catalogue contains many ordinary sales with no review projection; those
 * rows must remain explicitly not_reviewed instead of being masked by a
 * synthetic missing-projection block.
 */
function sampledSaleIds(rows: unknown[] | null, visibleSaleIds: ReadonlySet<string>): Set<string> {
  return new Set(
    (rows ?? []).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const row = candidate as AiReviewCaseStatusRow;
      return row.mapping_status === "exact" &&
        typeof row.auction_sale_id === "string" &&
        visibleSaleIds.has(row.auction_sale_id)
        ? [row.auction_sale_id]
        : [];
    }),
  );
}

type CanonicalSaleRow = {
  id?: unknown;
  property_type?: unknown;
  city?: unknown;
  sale_date?: unknown;
  starting_price_eur?: unknown;
  habitable_surface_m2?: unknown;
  carrez_surface_m2?: unknown;
  land_surface_m2?: unknown;
  occupancy_status?: unknown;
  rooms_count?: unknown;
  parking_count?: unknown;
  source_blocks?: unknown;
  source_blocks_by_source?: unknown;
};

type PrivatePublishableRow = CanonicalSaleRow & {
  auction_sale_id?: unknown;
  field_key?: unknown;
  review_state?: unknown;
  citation_status?: unknown;
  is_publishable?: unknown;
  value_jsonb?: unknown;
};

type AiReviewCaseStatusRow = {
  auction_sale_id?: unknown;
  mapping_status?: unknown;
  access_state?: unknown;
};

function canonicalMismatchKeys(
  projections: AiReviewProjectionReadModel[],
  publishableRows: unknown[] | null,
  canonicalRows: unknown[] | null,
): Set<string> {
  const canonicalBySaleId = new Map<string, CanonicalSaleRow>();
  for (const candidate of canonicalRows ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as CanonicalSaleRow;
    if (typeof row.id === "string") canonicalBySaleId.set(row.id, row);
  }

  const matched = new Set<string>();
  const mismatches = new Set<string>();
  for (const candidate of publishableRows ?? []) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as PrivatePublishableRow;
    if (
      typeof row.auction_sale_id !== "string" ||
      typeof row.field_key !== "string" ||
      row.is_publishable !== true
    ) {
      continue;
    }
    const key = `${row.auction_sale_id}:${row.field_key}`;
    const canonical = canonicalBySaleId.get(row.auction_sale_id);
    if (
      canonical &&
      isCanonicalValueMatch(
        row.field_key as AiReviewProjectionReadModel["field_key"],
        row.value_jsonb,
        canonical,
      )
    ) {
      matched.add(key);
    } else {
      mismatches.add(key);
    }
  }

  // A publishable metadata row without a corresponding value row is a server
  // drift. Mark it blocked instead of allowing the browser to fall back to the
  // raw auction_sales value.
  for (const projection of projections) {
    if (!projection.is_publishable || !projection.auction_sale_id) continue;
    const key = `${projection.auction_sale_id}:${projection.field_key}`;
    if (!matched.has(key)) mismatches.add(key);
  }
  return mismatches;
}

function isCanonicalValueMatch(
  fieldKey: AiReviewProjectionReadModel["field_key"],
  reviewedValue: unknown,
  sale: CanonicalSaleRow,
): boolean {
  const canonicalValue = canonicalValueForField(fieldKey, sale);
  if (canonicalValue == null || reviewedValue == null) return false;
  if (fieldKey === "sale.sale_date") {
    return dateOnly(reviewedValue) !== null && dateOnly(reviewedValue) === dateOnly(canonicalValue);
  }
  if (
    [
      "sale.starting_price_eur",
      "property.habitable_surface_m2",
      "property.carrez_surface_m2",
      "property.land_surface_m2",
      "property.rooms_count",
      "property.parking_count",
    ].includes(fieldKey)
  ) {
    const reviewedNumber = numericValue(reviewedValue);
    const canonicalNumber = numericValue(canonicalValue);
    return (
      reviewedNumber !== null && canonicalNumber !== null && reviewedNumber === canonicalNumber
    );
  }
  if (fieldKey === "property.source_energy_dpe_class") {
    const reviewedClass = energyClass(reviewedValue, "dpe");
    return reviewedClass !== null && reviewedClass === energyClass(canonicalValue, "dpe");
  }
  if (fieldKey === "property.source_energy_ges_class") {
    const reviewedClass = energyClass(reviewedValue, "ges");
    return reviewedClass !== null && reviewedClass === energyClass(canonicalValue, "ges");
  }
  return normalizedText(reviewedValue) === normalizedText(canonicalValue);
}

function canonicalValueForField(fieldKey: string, sale: CanonicalSaleRow): unknown {
  switch (fieldKey) {
    case "property.property_type":
      return sale.property_type;
    case "property.city":
      return sale.city;
    case "sale.sale_date":
      return sale.sale_date;
    case "sale.starting_price_eur":
      return sale.starting_price_eur;
    case "property.habitable_surface_m2":
      return sale.habitable_surface_m2;
    case "property.carrez_surface_m2":
      return sale.carrez_surface_m2;
    case "property.land_surface_m2":
      return sale.land_surface_m2;
    case "property.occupancy_status":
      return sale.occupancy_status;
    case "property.rooms_count":
      return sale.rooms_count;
    case "property.parking_count":
      return sale.parking_count;
    case "property.source_energy_dpe_class":
      return energyValue(sale, "dpe");
    case "property.source_energy_ges_class":
      return energyValue(sale, "ges");
    default:
      return null;
  }
}

function energyValue(sale: CanonicalSaleRow, kind: "dpe" | "ges"): unknown {
  const keys =
    kind === "dpe"
      ? ["dpe_classe", "dpe", "diagnostic_dpe", "classe_energie"]
      : ["ges_classe", "ges", "diagnostic_ges", "classe_ges"];
  return findNestedKeyValue([sale.source_blocks, sale.source_blocks_by_source], keys);
}

function findNestedKeyValue(values: unknown[], keys: readonly string[]): unknown {
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] != null) return record[key];
    }
    const nested = findNestedKeyValue(Object.values(record), keys);
    if (nested != null) return nested;
  }
  return null;
}

function energyClass(value: unknown, kind: "dpe" | "ges"): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value)
    .trim()
    .toUpperCase()
    .match(new RegExp(`^(?:${kind.toUpperCase()}\\s*[:=-]?\\s*)?([A-G])$`));
  return match?.[1] ?? null;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
  return text || null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

export async function GET(request: Request) {
  const ids = [...new Set(new URL(request.url).searchParams.getAll("id"))];
  const parsedIds = saleIdsSchema.safeParse(ids);
  if (!parsedIds.success) {
    return response({ error: "Identifiants de vente invalides." }, 400);
  }

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { data: visibleSales, error: visibilityError } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(CANONICAL_COLUMNS)
      .in("id", parsedIds.data);
    if (visibilityError) throw visibilityError;

    const visibleSaleRows = (visibleSales ?? []) as CanonicalSaleRow[];
    const visibleSaleIds = new Set(
      visibleSaleRows.map((sale) => sale.id).filter((id): id is string => typeof id === "string"),
    );
    const unavailableRows = unavailableSaleRows(parsedIds.data, visibleSaleIds);
    if (visibleSaleIds.size === 0) return response({ projections: unavailableRows });

    const { data: projections, error: projectionError } = await projectionReader
      .from("v_auction_ai_review_projection_read_model")
      .select(PROJECTION_COLUMNS)
      .in("auction_sale_id", [...visibleSaleIds]);
    if (projectionError) throw projectionError;

    const { data: caseStatuses, error: caseStatusError } = await projectionReader
      .from("auction_ai_review_case_status")
      .select(CASE_STATUS_COLUMNS)
      .in("auction_sale_id", [...visibleSaleIds]);
    if (caseStatusError) throw caseStatusError;

    const safeProjections = sanitizeProjectionRows(projections, visibleSaleIds);
    const missingRows = missingProjectionRows(
      sampledSaleIds(caseStatuses, visibleSaleIds),
      safeProjections,
    );
    const publishableKeys = safeProjections
      .filter((projection) => projection.is_publishable && projection.auction_sale_id)
      .map((projection) => `${projection.auction_sale_id}:${projection.field_key}`);
    let canonicalMismatches = new Set<string>();
    if (publishableKeys.length) {
      const { data: publishableRows, error: publishableError } = await projectionReader
        .from("v_auction_ai_review_publishable")
        .select(PUBLISHABLE_COLUMNS)
        .in("auction_sale_id", [...visibleSaleIds]);
      if (publishableError) throw publishableError;
      canonicalMismatches = canonicalMismatchKeys(
        safeProjections,
        publishableRows,
        visibleSaleRows,
      );
    }

    return response({
      projections: [
        ...sanitizeProjectionRows(projections, visibleSaleIds, canonicalMismatches),
        ...missingRows,
        ...unavailableRows,
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relecture IA indisponible.";
    const status = message.startsWith("Unauthorized") ? 401 : 503;
    return response(
      {
        error:
          status === 401
            ? message
            : "La relecture IA de cette annonce est momentanément indisponible.",
      },
      status,
    );
  }
}

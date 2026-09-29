/**
 * Public display contract for the private AI review projection.
 *
 * The server adapter must project rows from
 * `auction_ai_review_projections` (or its reviewed read model) without
 * exposing capture text or private evidence.  A row is considered safe for
 * display only when the database generated `is_publishable` flag is true.
 * Keeping this contract separate from `AuctionSale` prevents a raw sale value
 * from silently bypassing the review guard.
 */

export const AI_REVIEW_FIELD_KEYS = [
  "property.property_type",
  "property.city",
  "sale.sale_date",
  "sale.starting_price_eur",
  "property.habitable_surface_m2",
  "property.carrez_surface_m2",
  "property.land_surface_m2",
  "property.occupancy_status",
  "property.rooms_count",
  "property.parking_count",
  "property.source_energy_dpe_class",
  "property.source_energy_ges_class",
] as const;

export type AiReviewFieldKey = (typeof AI_REVIEW_FIELD_KEYS)[number];

export type AiReviewState = "resolved" | "unknown" | "absent" | "unresolved" | "unverified";

export type AiReviewCitationStatus = "verified" | "unverified" | "not_required";

/**
 * The deliberately small browser read model. Do not add capture text,
 * evidence excerpts or private artifact paths here.
 */
export type AiReviewProjectionReadModel = {
  auction_sale_id: string | null;
  field_key: string;
  review_state: AiReviewState;
  citation_status: AiReviewCitationStatus;
  is_publishable: boolean;
  /** Set by the trusted server adapter when a reviewed value drifted from the canonical row. */
  canonical_value_matches?: boolean;
  /** The requested sale disappeared from the caller's current catalogue view. */
  sale_unavailable?: boolean;
  /** The authenticated read model had no row at all for the requested sale. */
  projection_missing?: boolean;
  source_name: string | null;
  source_url: string | null;
};

export type AiReviewDisplayStatus = "not_reviewed" | "publishable" | "blocked";

/** Lifecycle of the authenticated read-model request used by display guards. */
export type AiReviewRequestStatus = "disabled" | "loading" | "ready" | "error";

export const AI_REVIEW_SURFACE_FIELD_KEYS = [
  "property.habitable_surface_m2",
  "property.carrez_surface_m2",
  "property.land_surface_m2",
] as const satisfies readonly AiReviewFieldKey[];

export const AI_REVIEW_ENERGY_FIELD_KEYS = [
  "property.source_energy_dpe_class",
  "property.source_energy_ges_class",
] as const satisfies readonly AiReviewFieldKey[];

export type AiReviewFieldResult = {
  fieldKey: AiReviewFieldKey;
  status: AiReviewDisplayStatus;
  blocked: boolean;
  /** A publishable row permits the raw canonical value but never labels it verified. */
  label: "À confirmer" | null;
  reason: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
};

const BLOCKED_STATES = new Set<AiReviewState>(["unresolved", "unverified"]);

/** A successful read-model response with no row for a sale is a coverage gap. */
const MISSING_PROJECTION_REASON =
  "La relecture IA de cette annonce n’a pas encore produit de projection exploitable.";

/**
 * Resolves one field without trying to infer a value from the AI review.
 *
 * An explicit projection row blocks publication when its generated flag is
 * false, its state is unresolved/unverified, or its citation is unverified.
 * Unknown/absent rows remain visible according to the database visibility
 * policy but never claim a verified label. Multiple rows are safe only when
 * every row is publishable and none is unknown/absent.
 */
export function getAiReviewFieldResult(
  projections: readonly AiReviewProjectionReadModel[] | null | undefined,
  fieldKey: AiReviewFieldKey,
  requestStatus: AiReviewRequestStatus = "ready",
): AiReviewFieldResult {
  const rows = (projections ?? []).filter((row) => row.field_key === fieldKey);
  if (requestStatus === "loading" || requestStatus === "error") {
    // The catalogue contains ordinary sales outside the frozen review sample.
    // A request that has not returned any scoped row must not blank all of
    // those canonical values. Sampled sales are quarantined server-side and
    // still arrive with explicit rows when they need to be blocked.
    if (!rows.length) {
      return {
        fieldKey,
        status: "not_reviewed",
        blocked: false,
        label: null,
        reason: null,
        sourceName: null,
        sourceUrl: null,
      };
    }
    const source = rows.find((row) => !row.is_publishable) ?? rows[0];
    return {
      fieldKey,
      status: "blocked",
      blocked: true,
      label: "À confirmer",
      reason:
        requestStatus === "loading"
          ? "La vérification de cette valeur est en cours."
          : "La vérification de cette valeur est momentanément indisponible.",
      sourceName: cleanText(source?.source_name ?? null),
      sourceUrl: cleanText(source?.source_url ?? null),
    };
  }

  if (!rows.length) {
    return {
      fieldKey,
      status: "not_reviewed",
      blocked: false,
      label: null,
      reason: null,
      sourceName: null,
      sourceUrl: null,
    };
  }

  const blockedRow = rows.find(
    (row) =>
      row.canonical_value_matches === false ||
      !row.is_publishable ||
      BLOCKED_STATES.has(row.review_state) ||
      row.citation_status === "unverified",
  );
  const source = blockedRow ?? rows[0];

  if (blockedRow) {
    return {
      fieldKey,
      status: "blocked",
      blocked: true,
      label: "À confirmer",
      reason: displayReason(blockedRow),
      sourceName: cleanText(source.source_name),
      sourceUrl: cleanText(source.source_url),
    };
  }

  const notReviewedRow = rows.find((row) => ["unknown", "absent"].includes(row.review_state));
  if (notReviewedRow) {
    return {
      fieldKey,
      status: "not_reviewed",
      blocked: false,
      label: null,
      reason: null,
      sourceName: cleanText(notReviewedRow.source_name),
      sourceUrl: cleanText(notReviewedRow.source_url),
    };
  }

  return {
    fieldKey,
    status: "publishable",
    blocked: false,
    label: null,
    reason: null,
    sourceName: cleanText(source.source_name),
    sourceUrl: cleanText(source.source_url),
  };
}

/** Returns the first blocked key in a grouped field, useful for one fallback label. */
export function firstBlockedAiReviewField(
  projections: readonly AiReviewProjectionReadModel[] | null | undefined,
  fieldKeys: readonly AiReviewFieldKey[],
  requestStatus: AiReviewRequestStatus = "ready",
): AiReviewFieldKey | null {
  return (
    fieldKeys.find(
      (fieldKey) => getAiReviewFieldResult(projections, fieldKey, requestStatus).blocked,
    ) ?? null
  );
}

export function aiReviewDisplayValue<T>(value: T, result: AiReviewFieldResult, fallback: T): T {
  return result.blocked ? fallback : value;
}

function displayReason(row: AiReviewProjectionReadModel): string {
  if (row.sale_unavailable) {
    return "Cette annonce n’est plus disponible dans le catalogue actuel.";
  }
  if (row.projection_missing) {
    return MISSING_PROJECTION_REASON;
  }
  if (row.canonical_value_matches === false) {
    return "La valeur relue ne correspond plus à la valeur canonique actuelle.";
  }
  if (row.review_state === "unresolved") return "La relecture IA n’a pas permis de trancher.";
  if (row.review_state === "unverified" || row.citation_status === "unverified") {
    return "La citation de la relecture IA n’est pas vérifiée dans la capture source.";
  }
  if (!row.is_publishable) return "Cette valeur n’est pas validée pour publication.";
  return "Cette valeur doit être confirmée.";
}

function cleanText(value: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

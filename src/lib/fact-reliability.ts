import { getDisplaySurface } from "@/lib/surface";
import { saleTimeConflict } from "@/lib/listing-evidence";
import type { AuctionSale } from "@/lib/types";

export type KeyFact = "sale_date" | "starting_price_eur" | "surface" | "occupancy_status";

export type FactReliabilityStatus = "observed" | "inferred" | "to_confirm" | "conflict";

export type FactReliability = {
  field: KeyFact;
  label: string;
  status: FactReliabilityStatus;
  statusLabel: string;
  detail: string;
  checkedAt: string | null;
};

/**
 * The claim data used by the server-side fiche adapter.
 *
 * The database read model contains source URLs, artifact ids and locators for
 * internal review. The API adapter deliberately projects those columns and
 * the observed value away before anything reaches a browser. Keeping this
 * type limited to the comparison inputs makes that boundary explicit in the
 * TypeScript contract as well.
 */
export type AuctionFactClaimSummary = {
  field_key: string;
  fact_status: "candidate" | "accepted" | "conflicted";
  value_jsonb?: unknown;
  confidence_score?: number | null;
  captured_at: string | null;
};

export type FactReliabilityMap = Record<KeyFact, FactReliability>;

const FACT_LABELS: Record<KeyFact, string> = {
  sale_date: "Date de vente",
  starting_price_eur: "Mise à prix",
  surface: "Surface",
  occupancy_status: "Occupation",
};

const STATUS_LABELS: Record<FactReliabilityStatus, string> = {
  observed: "Observé",
  inferred: "Inféré",
  to_confirm: "À confirmer",
  conflict: "Conflit",
};

const CONFLICT_FIELDS: Record<KeyFact, string[]> = {
  sale_date: ["sale_date", "sale.sale_date", "date", "event_date", "auction_date"],
  starting_price_eur: [
    "starting_price_eur",
    "sale.starting_price_eur",
    "starting_price",
    "price",
    "mise_a_prix",
  ],
  surface: [
    "surface",
    "surface_m2",
    "property.surface_m2",
    "app_surface_m2",
    "property.app_surface_m2",
    "habitable_surface_m2",
    "property.habitable_surface_m2",
    "carrez_surface_m2",
    "property.carrez_surface_m2",
    "land_surface_m2",
    "property.land_surface_m2",
  ],
  occupancy_status: ["occupancy_status", "property.occupancy_status", "occupancy", "occupation"],
};

const CONFLICT_FLAGS: Record<KeyFact, string[]> = {
  sale_date: ["date_conflict", "sale_date_conflict", "sale_time_conflict"],
  starting_price_eur: ["price_conflict", "starting_price_conflict", "starting_price_eur_conflict"],
  surface: ["surface_conflict", "surface_contradiction"],
  occupancy_status: ["occupancy_conflict", "occupation_conflict"],
};

const CONFIRMATION_FLAGS: Record<KeyFact, string[]> = {
  sale_date: [],
  starting_price_eur: [],
  surface: [
    "ambiguous_surface",
    "surface_type_unverified",
    "surface_scope_unverified",
    "parcel_surface_scope_unverified",
    "surface_unit_or_consistency_warning",
  ],
  occupancy_status: [],
};

const SURFACE_INFERENCE_FLAGS = ["surface_calculated_from_rooms"];

type SurfaceClaimKind = "built" | "land";

const GENERIC_SURFACE_CLAIM_FIELDS = new Set(["surface", "surface_m2", "app_surface_m2"]);

const EXPLICIT_BUILT_SURFACE_CLAIM_FIELDS = new Set(["habitable_surface_m2", "carrez_surface_m2"]);

function surfaceClaimKind(sale: AuctionSale, fieldKey: string): SurfaceClaimKind | null {
  const normalized = normalize(fieldKey).replace(/^(?:sale|property)\./, "");
  if (normalized === "land_surface_m2") return "land";
  if (GENERIC_SURFACE_CLAIM_FIELDS.has(normalized) && isLandTypedSurface(sale)) {
    return "land";
  }
  return EXPLICIT_BUILT_SURFACE_CLAIM_FIELDS.has(normalized) ||
    GENERIC_SURFACE_CLAIM_FIELDS.has(normalized)
    ? "built"
    : null;
}

function isLandTypedSurface(sale: AuctionSale): boolean {
  const appKind = normalize(sale.app_surface_kind ?? "");
  const scope = normalize(sale.surface_scope ?? "");
  return appKind === "land" || scope === "land";
}

function displaySurfaceClaimKind(sale: AuctionSale): SurfaceClaimKind | null {
  const kind = getDisplaySurface(sale).kind;
  if (kind === "land") return "land";
  if (kind === "recorded" || kind === "estimated") return "built";
  return null;
}

function isRelevantSurfaceField(sale: AuctionSale, fieldKey: string): boolean {
  const claimKind = surfaceClaimKind(sale, fieldKey);
  return claimKind != null && claimKind === displaySurfaceClaimKind(sale);
}

function surfaceEvidenceKind(value: string): SurfaceClaimKind | null {
  const normalized = normalize(value);
  const land = /\b(?:terrain|parcelle|cadastr|hectare|foncier)\w*/.test(normalized);
  const built = /\b(?:habitable|carrez|bati|batie|logement|appartement|maison)\w*/.test(normalized);
  if (land && built) return null;
  return land ? "land" : "built";
}

function hasRelevantSurfaceEvidence(sale: AuctionSale): boolean {
  const evidence = sale.surface_evidence?.trim();
  const displayKind = displaySurfaceClaimKind(sale);
  return Boolean(evidence && displayKind && surfaceEvidenceKind(evidence) === displayKind);
}

export function getFactReliability(
  sale: AuctionSale,
  field: KeyFact,
  displayedValue?: string | null,
): FactReliability {
  const latestCheck = latestSourceCheck(sale);
  const checkedAt = sourceCheckForField(sale, field);
  const flags = qualityFlags(sale);
  const label = FACT_LABELS[field];

  if (hasConflict(sale, field, flags)) {
    return result(
      field,
      "conflict",
      checkedAt,
      `${label} : plusieurs signaux contradictoires sont enregistrés.`,
    );
  }

  if (field === "sale_date" && displayedValue && displayedValue !== sale.sale_date) {
    return result(
      field,
      "to_confirm",
      null,
      "L'échéance affichée provient des modalités de vente et n'est pas reliée au contrôle de la date canonique.",
    );
  }

  if (!hasFactValue(sale, field)) {
    return result(
      field,
      "to_confirm",
      checkedAt,
      `${label} n'est pas renseignée dans les données collectées.`,
    );
  }

  if (hasConfirmationReservation(sale, field, flags)) {
    return result(field, "to_confirm", checkedAt, confirmationDetail(field, flags));
  }

  const inferredDetail = inferenceDetail(sale, field, flags);
  if (inferredDetail) {
    return result(field, "inferred", checkedAt, inferredDetail);
  }

  if (field === "surface" && hasLowConfidenceSurfaceEvidence(sale)) {
    return result(
      field,
      "to_confirm",
      checkedAt,
      "Un extrait de surface est disponible, mais la confiance enregistrée reste faible.",
    );
  }

  if (checkedAt || (field === "surface" && hasRelevantSurfaceEvidence(sale))) {
    return result(field, "observed", checkedAt, observedDetail(field, checkedAt, sale));
  }

  return result(
    field,
    "to_confirm",
    checkedAt,
    latestCheck
      ? `${label} est présente. Un contrôle global de source est enregistré le ${formatCheckedAt(latestCheck)}, mais il n'est pas rattaché à cette valeur.`
      : `${label} est présente, mais aucun contrôle de source ou extrait de preuve n'est enregistré pour cette valeur.`,
  );
}

export function getKeyFactReliabilities(sale: AuctionSale): Record<KeyFact, FactReliability> {
  return {
    sale_date: getFactReliability(sale, "sale_date"),
    starting_price_eur: getFactReliability(sale, "starting_price_eur"),
    surface: getFactReliability(sale, "surface"),
    occupancy_status: getFactReliability(sale, "occupancy_status"),
  };
}

/**
 * Applies the trusted fact-claim read model to one fiche.
 *
 * Candidate claims are intentionally conservative: they never make a value
 * observed. A candidate beside an accepted value also keeps the field at
 * "À confirmer" until a reviewer resolves the new observation. Explicit
 * conflicts take precedence over every other status.
 *
 * An empty claim set falls back to the legacy source_checks/quality_flags
 * contract. This keeps old rows readable while the append-only claims table is
 * populated progressively.
 */
export function getFactReliabilitiesFromClaims(
  sale: AuctionSale,
  claims: readonly AuctionFactClaimSummary[],
): FactReliabilityMap {
  const legacy = getKeyFactReliabilities(sale);
  if (!claims.length) return legacy;

  return {
    sale_date: claimReliabilityForField(sale, "sale_date", claims, legacy.sale_date),
    starting_price_eur: claimReliabilityForField(
      sale,
      "starting_price_eur",
      claims,
      legacy.starting_price_eur,
    ),
    surface: claimReliabilityForField(sale, "surface", claims, legacy.surface),
    occupancy_status: claimReliabilityForField(
      sale,
      "occupancy_status",
      claims,
      legacy.occupancy_status,
    ),
  };
}

/**
 * Preserves the existing date-window guard when a fiche displays a derived
 * event time instead of the canonical sale_date.
 */
export function getFactReliabilityForDisplay(
  sale: AuctionSale,
  field: KeyFact,
  displayedValue?: string | null,
  claims?: FactReliabilityMap | null,
): FactReliability {
  const fact = claims?.[field] ?? getFactReliability(sale, field, displayedValue);
  if (
    field === "sale_date" &&
    displayedValue &&
    displayedValue !== sale.sale_date &&
    fact.status === "observed"
  ) {
    return result(
      field,
      "to_confirm",
      null,
      "L'échéance affichée provient des modalités de vente et n'est pas reliée au contrôle de la date canonique.",
    );
  }
  return fact;
}

const CLAIM_FIELD_ALIASES: Record<KeyFact, ReadonlySet<string>> = {
  sale_date: new Set(CONFLICT_FIELDS.sale_date),
  starting_price_eur: new Set(CONFLICT_FIELDS.starting_price_eur),
  surface: new Set(CONFLICT_FIELDS.surface),
  occupancy_status: new Set(CONFLICT_FIELDS.occupancy_status),
};

function claimReliabilityForField(
  sale: AuctionSale,
  field: KeyFact,
  claims: readonly AuctionFactClaimSummary[],
  legacy: FactReliability,
): FactReliability {
  // The additive claim view has no link to the legacy conflict it would
  // resolve. An accepted claim can therefore corroborate a displayed value,
  // but it cannot silently clear an unresolved conflict already recorded on
  // the sale. The conflict must be cleared by the existing review workflow or
  // represented by an explicit supersession in a future projection.
  if (legacy.status === "conflict") return legacy;

  const fieldClaims = claims.filter((claim) =>
    field === "surface"
      ? isRelevantSurfaceField(sale, claim.field_key)
      : CLAIM_FIELD_ALIASES[field].has(normalize(claim.field_key)),
  );
  if (!fieldClaims.length) return legacy;

  if (fieldClaims.some((claim) => claim.fact_status === "conflicted")) {
    return result(
      field,
      "conflict",
      null,
      `${FACT_LABELS[field]} : plusieurs observations sourcées sont en conflit et nécessitent une revue.`,
    );
  }

  if (fieldClaims.some((claim) => claim.fact_status === "candidate")) {
    return result(
      field,
      "to_confirm",
      null,
      `${FACT_LABELS[field]} : une observation candidate est disponible, mais elle n'est pas encore vérifiée.`,
    );
  }

  const acceptedClaims = fieldClaims.filter((claim) => claim.fact_status === "accepted");
  if (acceptedClaims.some((claim) => scalarClaimValue(claim.value_jsonb) == null)) {
    return result(
      field,
      "to_confirm",
      null,
      `${FACT_LABELS[field]} : l'observation validée ne contient pas une valeur comparable à la fiche.`,
    );
  }
  if (acceptedClaims.some((claim) => !claimMatchesSale(sale, field, claim))) {
    return result(
      field,
      "conflict",
      null,
      `${FACT_LABELS[field]} : une observation validée ne correspond pas à la valeur affichée et nécessite une revue.`,
    );
  }

  if (acceptedClaims.length) {
    return result(
      field,
      "observed",
      latestAcceptedClaimDate(acceptedClaims),
      `${FACT_LABELS[field]} est rattachée à une observation sourcée validée.`,
    );
  }

  return legacy;
}

function claimMatchesSale(
  sale: AuctionSale,
  field: KeyFact,
  claim: AuctionFactClaimSummary,
): boolean {
  const scalar = scalarClaimValue(claim.value_jsonb);
  if (scalar == null) return false;

  if (field === "sale_date") {
    if (!hasMeaningfulText(sale.sale_date)) return false;
    if (typeof scalar !== "string") return false;
    const saleTime = Date.parse(sale.sale_date);
    const claimTime = Date.parse(scalar);
    return Number.isFinite(saleTime) && Number.isFinite(claimTime)
      ? saleTime === claimTime
      : normalize(sale.sale_date) === normalize(scalar);
  }

  if (field === "starting_price_eur") {
    const price = Number(scalar);
    return (
      Number.isFinite(price) &&
      typeof sale.starting_price_eur === "number" &&
      Number.isFinite(sale.starting_price_eur) &&
      price === sale.starting_price_eur
    );
  }

  if (field === "surface") {
    const value = Number(scalar);
    const display = getDisplaySurface(sale);
    const claimKind = surfaceClaimKind(sale, claim.field_key);
    const displayKind = displaySurfaceClaimKind(sale);
    return (
      Number.isFinite(value) &&
      claimKind != null &&
      claimKind === displayKind &&
      display.value != null &&
      value === display.value
    );
  }

  const occupancy = sale.occupancy_status;
  if (typeof scalar !== "string" || occupancy == null || !hasKnownOccupancy(occupancy)) {
    return false;
  }
  return equivalentOccupancy(occupancy, scalar);
}

function scalarClaimValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return scalarClaimValue((value as { value?: unknown }).value);
  }
  return null;
}

function equivalentOccupancy(left: string, right: string): boolean {
  const group = (value: string): string => {
    const normalized = normalize(value);
    if (["vacant", "free", "libre"].includes(normalized)) return "vacant";
    if (["occupied", "occupe", "occupe", "occupee"].includes(normalized)) return "occupied";
    if (["rented", "loue", "louee"].includes(normalized)) return "rented";
    return normalized;
  };
  return group(left) === group(right);
}

function latestAcceptedClaimDate(claims: readonly AuctionFactClaimSummary[]): string | null {
  const timestamps = claims
    .filter((claim) => claim.fact_status === "accepted")
    .map((claim) => claim.captured_at)
    .filter(
      (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
    );
  if (!timestamps.length) return null;
  return timestamps.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function result(
  field: KeyFact,
  status: FactReliabilityStatus,
  checkedAt: string | null,
  detail: string,
): FactReliability {
  return {
    field,
    label: FACT_LABELS[field],
    status,
    statusLabel: STATUS_LABELS[status],
    detail,
    checkedAt,
  };
}

function hasFactValue(sale: AuctionSale, field: KeyFact): boolean {
  if (field === "sale_date") return hasMeaningfulText(sale.sale_date);
  if (field === "starting_price_eur") {
    return (
      typeof sale.starting_price_eur === "number" &&
      Number.isFinite(sale.starting_price_eur) &&
      sale.starting_price_eur > 0
    );
  }
  if (field === "occupancy_status") return hasKnownOccupancy(sale.occupancy_status);
  return getDisplaySurface(sale).value != null;
}

function hasKnownOccupancy(value: string | null): boolean {
  if (!hasMeaningfulText(value)) return false;
  const normalized = normalize(value);
  return !["unknown", "inconnu", "non_renseigne", "non_precise", "n/a"].includes(normalized);
}

function hasConflict(sale: AuctionSale, field: KeyFact, flags: string[]): boolean {
  const conflicts = Array.isArray(sale.source_conflicts) ? sale.source_conflicts : [];
  const fields = new Set(CONFLICT_FIELDS[field]);
  if (
    conflicts.some((conflict) => {
      const conflictField = normalize(String(conflict.field ?? ""));
      return field === "surface"
        ? isRelevantSurfaceField(sale, conflictField)
        : fields.has(conflictField);
    })
  ) {
    return true;
  }
  if (CONFLICT_FLAGS[field].some((flag) => flags.includes(flag))) return true;
  return field === "sale_date" && Boolean(saleTimeConflict(sale));
}

function hasConfirmationReservation(sale: AuctionSale, field: KeyFact, flags: string[]): boolean {
  if (
    CONFIRMATION_FLAGS[field].some(
      (flag) =>
        flags.includes(flag) &&
        !(
          field === "surface" &&
          flag === "parcel_surface_scope_unverified" &&
          displaySurfaceClaimKind(sale) !== "land"
        ),
    )
  ) {
    return true;
  }
  if (field === "sale_date" && ["cancelled", "canceled", "postponed"].includes(sale.status ?? "")) {
    return true;
  }
  return false;
}

function confirmationDetail(field: KeyFact, flags: string[]): string {
  if (field === "sale_date") {
    return "La date conservée dans le dossier doit être confirmée auprès de l'organisateur.";
  }
  if (flags.includes("surface_type_unverified")) {
    return "La surface est présente, mais sa nature habitable ou Carrez reste à confirmer.";
  }
  if (flags.includes("surface_scope_unverified")) {
    return "La surface est présente, mais son périmètre reste à confirmer.";
  }
  if (flags.includes("parcel_surface_scope_unverified")) {
    return "La surface de terrain est présente, mais le total des parcelles reste à confirmer.";
  }
  if (flags.includes("surface_unit_or_consistency_warning")) {
    return "La surface présente un avertissement d'unité ou de cohérence et doit être confirmée.";
  }
  return "La valeur présente une ambiguïté signalée par les données et doit être confirmée.";
}

function inferenceDetail(sale: AuctionSale, field: KeyFact, flags: string[]): string | null {
  if (field !== "surface") return null;
  const display = getDisplaySurface(sale);
  if (display.kind === "estimated") {
    return "Surface provisoire calculée à partir des informations disponibles ; elle doit être confirmée dans les pièces.";
  }
  if (SURFACE_INFERENCE_FLAGS.some((flag) => flags.includes(flag))) {
    return "Surface calculée à partir d'autres caractéristiques du bien ; elle doit être confirmée dans les pièces.";
  }
  const source = `${sale.surface_source ?? ""} ${sale.surface_evidence ?? ""}`;
  if (
    /\b(?:inferred|derived|calculated|reasoning|estimated|estim[ée]e?|calcul[ée]e?|provisoire)\b/i.test(
      source,
    )
  ) {
    return "Surface dérivée ou provisoire signalée par les données ; elle doit être confirmée dans les pièces.";
  }
  return null;
}

function hasLowConfidenceSurfaceEvidence(sale: AuctionSale): boolean {
  return Boolean(
    hasRelevantSurfaceEvidence(sale) &&
    sale.surface_confidence != null &&
    Number.isFinite(sale.surface_confidence) &&
    sale.surface_confidence < 0.7,
  );
}

function observedDetail(field: KeyFact, checkedAt: string | null, sale: AuctionSale): string {
  if (field === "surface" && hasRelevantSurfaceEvidence(sale) && !checkedAt) {
    return "Un extrait de preuve de surface est enregistré dans le dossier.";
  }
  return checkedAt
    ? `La valeur est présente et un contrôle de source est enregistré le ${formatCheckedAt(checkedAt)}.`
    : "La valeur est accompagnée d'une preuve enregistrée dans le dossier.";
}

function sourceCheckForField(sale: AuctionSale, field: KeyFact): string | null {
  const aliases = new Set([field, ...CONFLICT_FIELDS[field]]);
  for (const [key, rawCheck] of Object.entries(sale.source_checks ?? {})) {
    if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) continue;
    const check = rawCheck as unknown as Record<string, unknown>;
    const explicitFields = [
      check.field,
      ...(Array.isArray(check.fields) ? check.fields : []),
    ].filter((value): value is string => typeof value === "string");
    const candidateKeys = [key, ...explicitFields].map(normalize);
    const matches =
      field === "surface"
        ? candidateKeys.some((candidate) => isRelevantSurfaceField(sale, candidate))
        : candidateKeys.some((candidate) => aliases.has(candidate));
    if (!matches) continue;
    const checkedAt = check.checked_at;
    if (typeof checkedAt === "string" && Number.isFinite(Date.parse(checkedAt))) return checkedAt;
  }
  return null;
}

function latestSourceCheck(sale: AuctionSale): string | null {
  const timestamps = Object.values(sale.source_checks ?? {})
    .map((check) => (typeof check?.checked_at === "string" ? check.checked_at : null))
    .filter((value): value is string => value != null && Number.isFinite(Date.parse(value)));
  if (!timestamps.length) return null;
  return timestamps.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function qualityFlags(sale: AuctionSale): string[] {
  return Array.isArray(sale.quality_flags)
    ? sale.quality_flags.filter((flag): flag is string => typeof flag === "string").map(normalize)
    : [];
}

function hasMeaningfulText(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return !["-", "—", "a_confirmer", "inconnu", "n/a", "non_renseigne", "unknown"].includes(
    normalize(value),
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[\s-]+/g, "_")
    .trim();
}

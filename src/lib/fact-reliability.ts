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
  sale_date: ["sale_date", "date", "event_date", "auction_date"],
  starting_price_eur: ["starting_price_eur", "starting_price", "price", "mise_a_prix"],
  surface: [
    "surface",
    "surface_m2",
    "app_surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
  ],
  occupancy_status: ["occupancy_status", "occupancy", "occupation"],
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

  if (checkedAt || (field === "surface" && Boolean(sale.surface_evidence?.trim()))) {
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
  if (conflicts.some((conflict) => fields.has(normalize(String(conflict.field ?? ""))))) {
    return true;
  }
  if (CONFLICT_FLAGS[field].some((flag) => flags.includes(flag))) return true;
  return field === "sale_date" && Boolean(saleTimeConflict(sale));
}

function hasConfirmationReservation(sale: AuctionSale, field: KeyFact, flags: string[]): boolean {
  if (CONFIRMATION_FLAGS[field].some((flag) => flags.includes(flag))) return true;
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
    sale.surface_evidence?.trim() &&
    sale.surface_confidence != null &&
    Number.isFinite(sale.surface_confidence) &&
    sale.surface_confidence < 0.7,
  );
}

function observedDetail(field: KeyFact, checkedAt: string | null, sale: AuctionSale): string {
  if (field === "surface" && sale.surface_evidence?.trim() && !checkedAt) {
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
    if (!candidateKeys.some((candidate) => aliases.has(candidate))) continue;
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

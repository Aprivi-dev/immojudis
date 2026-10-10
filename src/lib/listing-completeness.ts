import { collectSaleDocuments } from "./sale-documents";
import { listingVisits } from "./sale-listing";
import { saleSession, saleWindow } from "./sale-window";
import type {
  AuctionSale,
  SaleLegalFramework,
  SaleVenueType,
  SaleVerificationStatus,
} from "./types";
import { asRecordOrNull } from "@/lib/guards";
import {
  type CatalogField,
  CATALOGUE,
  COMPLETENESS_STATES,
  type CompletenessCategoryId,
  type CompletenessClass,
  type CompletenessImportance,
  type CompletenessProcedure,
  type CompletenessState,
  RAW_FEATURE_CATEGORIES,
  RAW_FEATURE_EXCEPTIONS,
} from "@/lib/listing-completeness/catalogue";

export {
  COMPLETENESS_STATES,
  LISTING_COMPLETENESS_CATALOGUE,
  LISTING_COMPLETENESS_FIELD_IDS,
  LISTING_COMPLETENESS_FIELD_COUNT,
} from "@/lib/listing-completeness/catalogue";
export type {
  CompletenessState,
  CompletenessImportance,
  CompletenessCategoryId,
  CompletenessProcedure,
  CompletenessClass,
} from "@/lib/listing-completeness/catalogue";

const MISSING_TEXT_MARKERS = new Set([
  "",
  "-",
  "—",
  "a confirmer",
  "a confirmer dans les documents",
  "inconnu",
  "n/a",
  "non communique",
  "non renseigne",
  "non renseigné",
  "unknown",
]);

const SOURCE_UNAVAILABLE_REASONS = new Set([
  "document_locked",
  "page_inaccessible",
  "paywall",
  "source_not_disclosed",
  "inaccessible",
  "access_denied",
]);

const IMPORTANCE_FACTOR: Record<CompletenessImportance, number> =
  CATALOGUE.scoring.importance_factors;

const STATE_FACTOR: Record<CompletenessState, number> = {
  observed: CATALOGUE.scoring.state_factors.observed ?? 0,
  explicitly_absent: CATALOGUE.scoring.state_factors.explicitly_absent ?? 0,
  inferred: CATALOGUE.scoring.state_factors.inferred ?? 0,
  unknown: CATALOGUE.scoring.state_factors.unknown ?? 0,
  not_applicable: CATALOGUE.scoring.state_factors.not_applicable ?? 0,
  conflict: CATALOGUE.scoring.state_factors.conflict ?? 0,
};

export type CompletenessEvidence = {
  grade?: "A" | "B" | "C" | "none" | string;
  source?: string | null;
  source_name?: string | null;
  url?: string | null;
  source_url?: string | null;
  excerpt?: string | null;
  quote?: string | null;
  text?: string | null;
  snippet?: string | null;
  locator?: string | null;
  page?: number | null;
  page_number?: number | null;
  captured_at?: string | null;
  [key: string]: unknown;
};

export type CompletenessReason = {
  code?: string | null;
  explanation?: string | null;
  availability_reason?: string | null;
  [key: string]: unknown;
};

export type CompletenessInference = {
  method?: string | null;
  input_fields?: string[] | null;
  confidence?: number | null;
  [key: string]: unknown;
};

export type FieldObservation = {
  field: string;
  state: CompletenessState;
  value: unknown;
  canonicalValue: unknown;
  evidence: CompletenessEvidence[];
  reason: CompletenessReason | null;
  inference: CompletenessInference | null;
  conflicts: unknown[];
  sourceNames: string[];
};

export type CompletenessFieldResult = FieldObservation & {
  id: string;
  label: string;
  category: CompletenessCategoryId;
  categoryLabel: string;
  definition: string;
  type: string;
  unit: string | null;
  importance: CompletenessImportance;
  applicable: boolean;
  extractionExcluded: boolean;
};

export type CompletenessCategorySummary = {
  id: CompletenessCategoryId;
  label: string;
  weight: number;
  ratio: number | null;
  applicableCount: number;
  knownCount: number;
  missingCount: number;
  conflictCount: number;
  notApplicableCount: number;
};

export type CompletenessGate = {
  id: string;
  label: string;
  passed: boolean;
  blocking: "identity" | "critical";
  reason: string;
  fields: string[];
};

export type CompletenessMissingField = {
  id: string;
  label: string;
  category: CompletenessCategoryId;
  importance: CompletenessImportance;
  state: CompletenessState;
  reason: string;
  nextAction: string;
  sourceContext: string;
};

export type CompletenessKnownField = {
  id: string;
  label: string;
  state: CompletenessState;
  value: unknown;
  sourceNames: string[];
  evidence: CompletenessEvidence[];
};

export type CompletenessProfileId =
  | "judicial_tribunal"
  | "public_auction_structured"
  | "state_disposal"
  | "agrasc_operator"
  | "notarial"
  | "online"
  | "generic";

export type CompletenessSourceProfile = {
  id: CompletenessProfileId;
  label: string;
  procedure: CompletenessProcedure;
  verified: boolean;
  sourceName: string | null;
  selectionReason: string;
};

export type ListingCompletenessResult = {
  score: number;
  completenessScore: number;
  extractionCoverageScore: number;
  classification: CompletenessClass;
  rawClassification: CompletenessClass;
  contextLabel: string;
  propertyType: string;
  procedure: CompletenessProcedure;
  profile: CompletenessSourceProfile;
  fields: CompletenessFieldResult[];
  known: CompletenessKnownField[];
  missing: CompletenessMissingField[];
  toConfirm: CompletenessMissingField[];
  knownBySource: Record<string, string[]>;
  categories: CompletenessCategorySummary[];
  gates: CompletenessGate[];
  gateFailures: CompletenessGate[];
  identityGateFailed: boolean;
  criticalGateFailed: boolean;
  applicableFieldCount: number;
  notApplicableFieldCount: number;
  observedFieldCount: number;
  inferredFieldCount: number;
  unknownFieldCount: number;
  conflictFieldCount: number;
  notApplicableReason: string;
};

type ProcedureContext = {
  procedure: CompletenessProcedure;
  verified: boolean;
  venueType: SaleVenueType | null;
  legalFramework: SaleLegalFramework | null;
  participationMode: string | null;
  verificationStatus: SaleVerificationStatus | null;
};

type DirectValue = {
  value: unknown;
  state?: CompletenessState;
  reason?: CompletenessReason | null;
  inference?: CompletenessInference | null;
};

type CollectedDocuments = ReturnType<typeof collectSaleDocuments>;

function isMeaningfulText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR");
  return !MISSING_TEXT_MARKERS.has(normalized);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function objectHasContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return isMeaningfulText(value);
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value != null;
}

function normalized(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLocaleLowerCase("fr-FR")
    : "";
}

function rawPayload(sale: AuctionSale): Record<string, unknown> {
  return asRecordOrNull(sale.raw_payload) ?? {};
}

/**
 * The detail view currently projects the completeness payload through
 * source_blocks. Keep raw_payload as the preferred input when a private
 * caller has it, then fall back to the published projection.
 */
function completenessPayloads(sale: AuctionSale): Record<string, unknown>[] {
  const raw = rawPayload(sale);
  const rawBlocks = asRecordOrNull(raw.source_blocks);
  const projectedFromBlocks = asRecordOrNull(sale.source_blocks?.listing_completeness);
  const projectedFromRawBlocks = asRecordOrNull(rawBlocks?.listing_completeness);
  const projectedRoot = asRecordOrNull(raw.listing_completeness);
  return [raw, projectedFromRawBlocks, projectedFromBlocks, projectedRoot].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  );
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function pathValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecordOrNull(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

function firstPathValue(root: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const value = pathValue(root, path);
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function evidenceList(value: unknown): CompletenessEvidence[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap((entry) => {
    if (typeof entry === "string") return [{ excerpt: entry }];
    const record = asRecordOrNull(entry);
    return record ? [record as CompletenessEvidence] : [];
  });
}

function evidenceSourceNames(evidence: CompletenessEvidence[]): string[] {
  return [
    ...new Set(
      evidence
        .map((item) => item.source_name ?? item.source ?? null)
        .filter((source): source is string => isMeaningfulText(source)),
    ),
  ];
}

function hasEvidenceLocator(item: CompletenessEvidence): boolean {
  return Boolean(
    isMeaningfulText(item.excerpt) ||
    isMeaningfulText(item.quote) ||
    isMeaningfulText(item.text) ||
    isMeaningfulText(item.snippet) ||
    isMeaningfulText(item.locator) ||
    typeof item.page === "number" ||
    typeof item.page_number === "number",
  );
}

function validObservedEvidence(evidence: CompletenessEvidence[]): boolean {
  return evidence.some(
    (item) =>
      ["A", "B"].includes(String(item.grade ?? "").toUpperCase()) && hasEvidenceLocator(item),
  );
}

function validExplicitAbsenceEvidence(evidence: CompletenessEvidence[]): boolean {
  return evidence.some((item) => {
    const quote = [item.excerpt, item.quote, item.text, item.snippet]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLocaleLowerCase("fr-FR");
    return (
      hasEvidenceLocator(item) &&
      /\b(?:aucun|aucune|sans|non|n'est pas|ne comporte pas)\b/.test(quote)
    );
  });
}

function validNotApplicableReason(reason: CompletenessReason | null): boolean {
  const code = normalized(reason?.code);
  const explanation = reason?.explanation;
  if (!code || !isMeaningfulText(explanation)) return false;
  return !SOURCE_UNAVAILABLE_REASONS.has(code);
}

function validInference(inference: CompletenessInference | null): boolean {
  return Boolean(
    isMeaningfulText(inference?.method) &&
    Array.isArray(inference?.input_fields) &&
    inference.input_fields.length > 0 &&
    typeof inference?.confidence === "number" &&
    Number.isFinite(inference.confidence),
  );
}

function makeObservation(
  field: string,
  state: CompletenessState,
  value: unknown = null,
  options: {
    canonicalValue?: unknown;
    evidence?: CompletenessEvidence[];
    reason?: CompletenessReason | null;
    inference?: CompletenessInference | null;
    conflicts?: unknown[];
  } = {},
): FieldObservation {
  const evidence = options.evidence ?? [];
  return {
    field,
    state,
    value,
    canonicalValue: options.canonicalValue ?? value,
    evidence,
    reason: options.reason ?? null,
    inference: options.inference ?? null,
    conflicts: options.conflicts ?? [],
    sourceNames: evidenceSourceNames(evidence),
  };
}

function unknownObservation(field: string, reason?: CompletenessReason | null): FieldObservation {
  return makeObservation(field, "unknown", null, { reason });
}

function featureCandidate(sale: AuctionSale, field: string): Record<string, unknown> | null {
  const payloads = completenessPayloads(sale).reverse();
  const candidates: Record<string, unknown>[] = [];
  for (const payload of payloads) {
    const containers: unknown[] = [
      payload.source_property_features,
      payload.source_field_observations,
      payload.source_facts,
    ];
    for (const containerValue of containers) {
      if (Array.isArray(containerValue)) {
        for (const entry of containerValue) {
          const record = asRecordOrNull(entry);
          if (record?.field === field) candidates.push(record);
        }
        continue;
      }
      const container = asRecordOrNull(containerValue);
      const nestedArray = Array.isArray(container?.fields) ? container.fields : [];
      for (const entry of nestedArray) {
        const record = asRecordOrNull(entry);
        if (record?.field === field) candidates.push(record);
      }
      const nestedFields = asRecordOrNull(container?.fields);
      const candidate = container?.[field] ?? nestedFields?.[field];
      if (candidate !== undefined) {
        const record = asRecordOrNull(candidate);
        if (record) candidates.push(record);
      }
    }
  }
  if (candidates.length === 0) return null;
  const merged: Record<string, unknown> = {};
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  if (!merged.field) merged.field = field;
  return merged;
}

function observationFromFeature(
  field: string,
  candidate: Record<string, unknown>,
): FieldObservation {
  const rawState = candidate.state;
  const state = COMPLETENESS_STATES.includes(rawState as CompletenessState)
    ? (rawState as CompletenessState)
    : "unknown";
  const evidence = evidenceList(candidate.evidence);
  const reason = asRecordOrNull(candidate.reason) as CompletenessReason | null;
  const inference = asRecordOrNull(candidate.inference) as CompletenessInference | null;
  const conflicts = Array.isArray(candidate.conflicts) ? candidate.conflicts : [];
  const value = candidate.value ?? null;
  const canonicalValue = candidate.canonical_value ?? value;

  if (["observed", "inferred"].includes(state) && !objectHasContent(canonicalValue)) {
    return unknownObservation(field, {
      code: "empty_value",
      explanation: "Valeur exploitable requise.",
    });
  }
  if (state === "observed" && !validObservedEvidence(evidence)) {
    return unknownObservation(field, {
      code: "invalid_observed_evidence",
      explanation: "Preuve A/B et extrait ou localisateur requis.",
    });
  }
  if (state === "inferred" && !validInference(inference)) {
    return unknownObservation(field, {
      code: "invalid_inference",
      explanation: "Méthode, entrées ou confiance manquantes.",
    });
  }
  if (state === "explicitly_absent" && !validExplicitAbsenceEvidence(evidence)) {
    return unknownObservation(field, {
      code: "invalid_explicit_absence",
      explanation: "Négation citée et rattachée au lot requise.",
    });
  }
  if (state === "not_applicable" && !validNotApplicableReason(reason)) {
    return unknownObservation(field, {
      code: "invalid_not_applicable",
      explanation: "Raison contrôlée requise ; page inaccessible = inconnu.",
    });
  }
  if (state === "conflict" && conflicts.length === 0) {
    return unknownObservation(field, {
      code: "invalid_conflict",
      explanation: "Valeurs concurrentes et preuves manquantes.",
    });
  }
  return makeObservation(field, state, value, {
    canonicalValue,
    evidence,
    reason,
    inference,
    conflicts,
  });
}

function directObservation(field: string, value: DirectValue | unknown): FieldObservation {
  const direct = asRecordOrNull(value);
  if (direct && "value" in direct) {
    const state = COMPLETENESS_STATES.includes(direct.state as CompletenessState)
      ? (direct.state as CompletenessState)
      : objectHasContent(direct.value)
        ? "observed"
        : "unknown";
    return makeObservation(field, state, direct.value, {
      reason: (direct.reason as CompletenessReason | null | undefined) ?? null,
      inference: (direct.inference as CompletenessInference | null | undefined) ?? null,
    });
  }
  if (!objectHasContent(value)) return unknownObservation(field);
  return makeObservation(field, "observed", value);
}

function inferredDirect(field: string, value: unknown, method: string): FieldObservation {
  if (value === undefined || value === null) return unknownObservation(field);
  if (typeof value === "string" && !isMeaningfulText(value)) return unknownObservation(field);
  if (typeof value === "boolean" && !value) return unknownObservation(field);
  if (Array.isArray(value) && value.length === 0) return unknownObservation(field);
  return makeObservation(field, "inferred", value, {
    inference: { method, input_fields: [field], confidence: 0.6 },
  });
}

function normalizedPropertyType(value: unknown): string {
  const key = normalized(value);
  if (!key) return "unknown";
  if (/appartement|apartment|studio|duplex|loft|t[1-9]/.test(key)) return "apartment";
  if (/maison|villa|pavillon/.test(key)) return "house";
  if (/terrain|parcelle|pre(?:$|[^a-z])|bois|agricole/.test(key)) return "land";
  if (/parking|garage|box/.test(key)) return "parking";
  if (/commerce|commercial|bureau|local/.test(key)) return "commercial";
  if (/immeuble|batiment|building/.test(key)) return "building";
  if (/mixte|mixed/.test(key)) return "mixed";
  if (key === "other" || key === "autre") return "other";
  return "unknown";
}

function procedureContext(sale: AuctionSale): ProcedureContext {
  const rawProcedure = asRecordOrNull(sale.sale_procedure);
  const verification = asRecordOrNull(rawProcedure?.verification);
  const rawStatus = verification?.status ?? sale.sale_verification_status;
  const verificationStatus = ["verified", "cross_checked", "pending", "conflict"].includes(
    String(rawStatus),
  )
    ? (String(rawStatus) as SaleVerificationStatus)
    : null;
  const venueRaw = rawProcedure?.venue_type ?? sale.sale_venue_type;
  const venueType = ["tribunal", "notary", "state", "online", "unknown"].includes(String(venueRaw))
    ? (String(venueRaw) as SaleVenueType)
    : null;
  const legalRaw = rawProcedure?.legal_framework ?? sale.sale_legal_framework;
  const legalFramework = [
    "judicial_seizure",
    "judicial_partition",
    "insolvency",
    "voluntary_notarial",
    "state_sale",
    "unknown",
  ].includes(String(legalRaw))
    ? (String(legalRaw) as SaleLegalFramework)
    : null;
  const participationMode = isMeaningfulText(rawProcedure?.participation_mode)
    ? String(rawProcedure?.participation_mode)
    : null;
  const verified = verificationStatus === "verified" || verificationStatus === "cross_checked";
  if (!verified) {
    return {
      procedure: "unknown",
      verified: false,
      venueType,
      legalFramework,
      participationMode,
      verificationStatus,
    };
  }
  let procedure: CompletenessProcedure = "unknown";
  if (legalFramework === "state_sale") procedure = "state";
  else if (legalFramework?.startsWith("judicial")) procedure = "judicial";
  else if (legalFramework === "voluntary_notarial") procedure = "notarial";
  else if (venueType === "state") procedure = "state";
  else if (venueType === "tribunal") procedure = "judicial";
  else if (venueType === "notary") procedure = "notarial";
  else if (venueType === "online" || ["online", "hybrid"].includes(participationMode ?? ""))
    procedure = "online";
  return {
    procedure,
    verified: procedure !== "unknown",
    venueType,
    legalFramework,
    participationMode,
    verificationStatus,
  };
}

function sourceName(sale: AuctionSale): string | null {
  return isMeaningfulText(sale.source_name)
    ? sale.source_name.trim()
    : isMeaningfulText(sale.primary_source)
      ? sale.primary_source.trim()
      : null;
}

function selectProfile(sale: AuctionSale, context: ProcedureContext): CompletenessSourceProfile {
  const source = sourceName(sale);
  const sourceKey = normalized(source);
  if (!context.verified) {
    return {
      id: "generic",
      label: "Profil générique",
      procedure: "unknown",
      verified: false,
      sourceName: source,
      selectionReason: "Le portail seul ne qualifie pas la procédure ; vérification requise.",
    };
  }
  if (context.procedure === "state" && sourceKey.includes("agrasc")) {
    return {
      id: "agrasc_operator",
      label: "Opérateur AGRASC",
      procedure: "state",
      verified: true,
      sourceName: source,
      selectionReason: "Cadre domanial vérifié, connecteur AGRASC identifié.",
    };
  }
  if (context.procedure === "state") {
    return {
      id: "state_disposal",
      label: "Cession d’État",
      procedure: "state",
      verified: true,
      sourceName: source,
      selectionReason: "Cadre de cession d’État vérifié.",
    };
  }
  if (context.procedure === "online") {
    return {
      id: "online",
      label: "Vente en ligne",
      procedure: "online",
      verified: true,
      sourceName: source,
      selectionReason: "Participation en ligne vérifiée.",
    };
  }
  if (context.procedure === "notarial") {
    return {
      id: "notarial",
      label: "Vente notariale",
      procedure: "notarial",
      verified: true,
      sourceName: source,
      selectionReason: "Cadre notarial vérifié ; portail indicatif.",
    };
  }
  if (sourceKey.includes("encheres_publiques") || sourceKey.includes("encheres publiques")) {
    return {
      id: "public_auction_structured",
      label: "Enchères publiques structurées",
      procedure: "judicial",
      verified: true,
      sourceName: source,
      selectionReason: "Procédure judiciaire vérifiée.",
    };
  }
  return {
    id: "judicial_tribunal",
    label: "Vente au tribunal",
    procedure: "judicial",
    verified: true,
    sourceName: source,
    selectionReason: "Cadre judiciaire vérifié.",
  };
}

function contextLabel(procedure: CompletenessProcedure): string {
  return {
    judicial: "Tribunal",
    notarial: "Notaire",
    state: "Cession d’État",
    online: "Vente en ligne",
    unknown: "Procédure à confirmer",
  }[procedure];
}

function procedureRecord(sale: AuctionSale): Record<string, unknown> {
  const direct = asRecordOrNull(sale.sale_procedure);
  const fromBlocks = asRecordOrNull(sale.source_blocks?.sale_procedure);
  return direct ?? fromBlocks ?? {};
}

function procedureRules(sale: AuctionSale): Record<string, unknown> {
  return asRecordOrNull(procedureRecord(sale).rules) ?? {};
}

function rawFeatureValue(sale: AuctionSale, field: string): unknown {
  const candidate = featureCandidate(sale, field);
  return candidate?.canonical_value ?? candidate?.value ?? null;
}

function mediaUrls(sale: AuctionSale): string[] {
  const media = Array.isArray(sale.media) ? sale.media : [];
  const rawImageValue = rawPayload(sale).source_images;
  const rawImages: unknown[] = Array.isArray(rawImageValue) ? rawImageValue : [];
  return [
    ...new Set(
      [
        ...media.map((item) => asRecordOrNull(item)?.url),
        ...rawImages.map((item) => (typeof item === "string" ? item : asRecordOrNull(item)?.url)),
      ].filter((value): value is string => isMeaningfulText(value)),
    ),
  ];
}

function directFieldValue(
  sale: AuctionSale,
  field: string,
  fieldIndex: number,
  documents: CollectedDocuments,
): FieldObservation {
  const raw = rawPayload(sale);
  const evidencePayloads = completenessPayloads(sale);
  const blocks = sale.source_blocks ?? asRecordOrNull(raw.source_blocks) ?? {};
  const procedure = procedureRecord(sale);
  const rules = procedureRules(sale);
  const docsWithType = documents.filter(
    (document) => isMeaningfulText(document.type) || isMeaningfulText(document.label),
  );
  const sourceChecks = asRecordOrNull(sale.source_checks) ?? asRecordOrNull(raw.source_checks);
  const sourceCheckValues = sourceChecks
    ? Object.values(sourceChecks).map(asRecordOrNull).filter(Boolean)
    : [];
  const rawValue = (...paths: string[][]): unknown =>
    firstDefined(...evidencePayloads.map((payload) => firstPathValue(payload, paths)));
  const blockValue = (...keys: string[]): unknown =>
    firstDefined(...keys.map((key) => blocks[key]));
  const direct = (value: unknown): FieldObservation => directObservation(field, value);

  const catalogCategory = CATALOGUE.fields[fieldIndex]?.category;
  if (
    catalogCategory &&
    RAW_FEATURE_CATEGORIES.has(catalogCategory) &&
    !RAW_FEATURE_EXCEPTIONS.has(field)
  ) {
    return direct(rawFeatureValue(sale, field));
  }

  const directSaleValues: Record<number, unknown> = {
    0: sale.id,
    1: sale.source_name,
    2: sale.source_url,
    3: sale.primary_source,
    16: sale.property_type,
    17: sale.sale_venue_type,
    18: sale.sale_legal_framework,
    19: sale.sale_verification_status,
    20: sale.status,
    22: sale.sale_date,
    25: sale.tribunal_name ?? sale.tribunal,
    26: sale.starting_price_eur,
    27: sale.adjudication_price_eur,
    31: listingVisits(sale),
    35: procedure.eligible_bar,
    36: sale.lawyer_name,
    37: sale.lawyer_contact,
    42: sale.address,
    43: sale.postal_code,
    44: sale.city,
    45: sale.department,
    52: sale.land_surface_m2,
    54: sale.habitable_surface_m2,
    55: sale.carrez_surface_m2,
    57: sale.surface_scope,
    59: sale.rooms_count,
    60: sale.bedrooms_count,
    61: sale.bathrooms_count,
    104: sale.occupancy_status,
    115: sale.risks,
    118: documents,
  };
  if (fieldIndex in directSaleValues) return direct(directSaleValues[fieldIndex]);

  switch (fieldIndex) {
    case 4:
      return direct(Array.isArray(sale.source_urls) ? sale.source_urls : null);
    case 5:
      return direct(
        rawValue(["external_id"], ["source_external_id"], ["source_record", "external_id"]),
      );
    case 6:
      return direct(rawValue(["source_title"]) ?? sale.title);
    case 7:
      return direct(rawValue(["source_description"]) ?? sale.source_description);
    case 8:
      return direct(rawValue(["capture_text"], ["raw_text"], ["source_blocks", "page_text"]));
    case 9:
      return direct(
        Object.fromEntries(
          Object.entries(blocks).filter(
            ([key, value]) => key !== "listing_completeness" && objectHasContent(value),
          ),
        ),
      );
    case 10:
      return direct(sale.source_presence ?? asRecordOrNull(raw.source_presence));
    case 11:
      {
        const conflicts = Array.isArray(sale.source_conflicts)
          ? sale.source_conflicts
          : Array.isArray(raw.source_conflicts)
            ? raw.source_conflicts
            : [];
        if (conflicts.length > 0) {
          return makeObservation(field, "conflict", conflicts, {
            conflicts,
          });
        }
      }
      return unknownObservation(field);
    case 12:
      return direct(
        firstDefined(
          rawValue(["capture_checked_at"], ["source_last_seen_at"]),
          ...sourceCheckValues.map((item) => item?.checked_at),
        ),
      );
    case 13:
      return direct(
        firstDefined(
          rawValue(["extractor_version"]),
          ...sourceCheckValues.map((item) => item?.extractor_version),
        ),
      );
    case 14:
      return direct(rawValue(["source_detail_status"], ["detail_status"]));
    case 15:
      return direct(rawValue(["source_last_seen_at"], ["last_seen_at"]));
    case 21:
      return direct(rawValue(["auction_round"], ["sale_procedure", "auction_round"]));
    case 23:
      return direct(
        rawValue(["source_sale_schedule"], ["sale_schedule"]) ??
          saleWindow(sale) ??
          saleSession(sale),
      );
    case 24:
      return direct(objectHasContent(procedure) ? procedure : null);
    case 28:
      return direct(rawValue(["outcome_status"], ["result", "status"]));
    case 29:
      return direct(
        procedure.venue_name ?? (sale.sale_venue_type === "tribunal" ? sale.tribunal_name : null),
      );
    case 30:
      return direct(procedure.venue_address);
    case 32:
      return direct(procedure.participation_mode);
    case 33:
      return direct(rules.bid_method);
    case 34:
      return direct(rules.lawyer_required);
    case 38:
      return direct(
        firstDefined(
          asRecordOrNull(rules.guarantee)?.amount_eur,
          rawValue(["consignation"]),
          blockValue("consignation"),
        ),
      );
    case 39:
      return direct(
        rawValue(["sale_fees"], ["fees"], ["auction_fees"]) ??
          blockValue("sale_fees", "fees", "frais"),
      );
    case 40:
      return direct(
        firstDefined(
          rawValue(["payment_terms"]),
          asRecordOrNull(rules)?.payment_deadline_days,
          blockValue("payment_terms", "seance_paiement"),
        ),
      );
    case 41:
      return direct(
        firstDefined(rawValue(["surenchere_window"]), asRecordOrNull(rules.overbid)?.window_days),
      );
    case 46:
      return direct(
        rawValue(["insee_code"], ["tribunal_assignment", "insee_code"], ["location", "insee_code"]),
      );
    case 47:
      return direct(
        typeof sale.latitude === "number" && typeof sale.longitude === "number"
          ? { latitude: sale.latitude, longitude: sale.longitude }
          : null,
      );
    case 48:
      return direct(rawValue(["location_precision"], ["location", "precision"]));
    case 49:
      return direct(rawValue(["lot_reference"], ["lot_number"], ["lot"]));
    case 50:
      return direct(rawValue(["lot_count"], ["lots_count"]));
    case 51:
      return direct(rawValue(["cadastral_references"], ["cadastre", "references"], ["parcels"]));
    case 53:
      return direct(rawValue(["land_surface_scope"], ["surface", "land_scope"]));
    case 56:
      return direct(
        firstDefined(
          sale.app_surface_m2 &&
            ["built", "surface_built", "sol", "generic"].includes(normalized(sale.app_surface_kind))
            ? sale.app_surface_m2
            : null,
          rawValue(["surface_built_m2"]),
        ),
      );
    case 58:
      return direct(
        firstDefined(sale.surface_source, rawValue(["surface_provenance"]), sale.surface_evidence),
      );
    case 93:
      return inferredDirect(
        field,
        sale.has_garden,
        "normalized_boolean_without_explicit_negative_proof",
      );
    case 94:
      return inferredDirect(
        field,
        sale.has_terrace,
        "normalized_boolean_without_explicit_negative_proof",
      );
    case 96:
      return inferredDirect(
        field,
        sale.has_garage,
        "normalized_boolean_without_explicit_negative_proof",
      );
    case 97:
      return direct(
        firstDefined(
          rawFeatureValue(sale, field),
          isFinitePositive(sale.parking_count) ? sale.parking_count : null,
        ),
      );
    case 116:
      return direct(rawValue(["technical_diagnostics"], ["source_energy_diagnostics"]));
    case 120:
      return direct(
        docsWithType.filter((doc) =>
          /pv|proc[eè]s|descriptif/i.test(`${doc.type ?? ""} ${doc.label ?? ""}`),
        ),
      );
    case 121:
      return direct(
        docsWithType.filter((doc) =>
          /cahier|conditions|ccv/i.test(`${doc.type ?? ""} ${doc.label ?? ""}`),
        ),
      );
    case 122:
      return direct(
        docsWithType.filter((doc) =>
          /dpe|diagnostic|ges/i.test(`${doc.type ?? ""} ${doc.label ?? ""}`),
        ),
      );
    case 123:
      return direct(
        docsWithType.filter((doc) =>
          /bail|lease|location/i.test(`${doc.type ?? ""} ${doc.label ?? ""}`),
        ),
      );
    case 124: {
      const urls = mediaUrls(sale);
      return direct(urls.length > 0 ? urls.length : null);
    }
    case 125:
      // A URL proves availability in the manifest, not a decoded property photo.
      // Explicit usability observations are handled by fieldObservation above.
      return unknownObservation(field);
    case 126: {
      const floorplans = mediaUrls(sale).filter((url) => /plan|floor|schema/i.test(url));
      return direct(floorplans.length > 0 ? floorplans.length : null);
    }
    case 127: {
      const cadastre = mediaUrls(sale).filter((url) => /cadastre|parcelle|plan/i.test(url));
      return direct(cadastre.length > 0 ? cadastre.length : null);
    }
    default:
      return unknownObservation(field);
  }
}

function fieldApplicable(
  field: CatalogField,
  propertyType: string,
  procedure: CompletenessProcedure,
): boolean {
  const propertyTypes = field.applicability.property_types ?? ["all"];
  const procedures = field.applicability.procedures ?? ["all"];
  const propertyMatches =
    propertyType === "unknown"
      ? propertyTypes.includes("all") || propertyTypes.length > 0
      : propertyTypes.includes("all") || propertyTypes.includes(propertyType);
  const procedureMatches =
    procedure === "unknown"
      ? procedures.includes("all") || procedures.length > 0
      : procedures.includes("all") || procedures.includes(procedure);
  return propertyMatches && procedureMatches;
}

function fieldObservation(
  sale: AuctionSale,
  field: CatalogField,
  fieldIndex: number,
  documents: CollectedDocuments,
): FieldObservation {
  const candidate = featureCandidate(sale, field.id);
  if (candidate) return observationFromFeature(field.id, candidate);
  return directFieldValue(sale, field.id, fieldIndex, documents);
}

function extractionUnavailable(sale: AuctionSale, observation: FieldObservation): boolean {
  if (observation.state !== "unknown") return false;
  const availability = normalized(observation.reason?.availability_reason);
  if (SOURCE_UNAVAILABLE_REASONS.has(availability)) return true;
  const presence = asRecordOrNull(sale.source_presence);
  const rawPresence = asRecordOrNull(rawPayload(sale).source_presence);
  const projectedPresence = completenessPayloads(sale)
    .map((payload) => asRecordOrNull(payload.source_presence)?.[observation.field])
    .find((value) => value !== undefined);
  const entry = asRecordOrNull(
    presence?.[observation.field] ?? rawPresence?.[observation.field] ?? projectedPresence,
  );
  const entryAvailability = normalized(entry?.availability ?? entry?.state);
  return SOURCE_UNAVAILABLE_REASONS.has(entryAvailability);
}

function fieldReason(field: CompletenessFieldResult): string {
  if (field.state === "conflict") return "Résoudre les valeurs concurrentes.";
  if (field.state === "unknown") {
    if (field.extractionExcluded) return "Source inaccessible/verrouillée : absence non conclue.";
    return "Aucune valeur prouvée conservée.";
  }
  return field.state === "inferred" ? "Rapprocher la valeur inférée d’une preuve." : "";
}

function nextAction(field: CompletenessFieldResult, profile: CompletenessSourceProfile): string {
  if (field.state === "conflict") return "Comparer les extraits et rattacher au lot exact.";
  if (field.extractionExcluded)
    return "Réessayer la capture ou garder la raison d’inaccessibilité.";
  if (field.state === "inferred") return "Confirmer dans la source ou les pièces du dossier.";
  if (field.category === "documents_and_media")
    return `Contrôler les pièces du profil ${profile.label}.`;
  if (field.category === "procedure")
    return `Compléter la procédure ${profile.label.toLocaleLowerCase("fr-FR")}.`;
  return "Rechercher dans la source et les documents du lot.";
}

function fieldDisplayValue(observation: FieldObservation): unknown {
  return observation.canonicalValue ?? observation.value;
}

function stateAccepted(
  field: CompletenessFieldResult | undefined,
  states: CompletenessState[],
  values?: unknown[],
): boolean {
  if (!field || !states.includes(field.state)) return false;
  if (values && !values.some((value) => sameCanonicalValue(fieldDisplayValue(field), value)))
    return false;
  return true;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left === "boolean" && typeof right === "boolean") return left === right;
  if (typeof left === "string" && typeof right === "string") {
    return normalized(left) === normalized(right);
  }
  return left === right;
}

function hasField(
  fields: Map<string, CompletenessFieldResult>,
  id: string,
  states: CompletenessState[] = ["observed"],
  values?: unknown[],
): boolean {
  return stateAccepted(fields.get(id), states, values);
}

function nonEmptyProofField(fields: Map<string, CompletenessFieldResult>, id: string): boolean {
  const field = fields.get(id);
  return Boolean(
    field &&
    ["observed", "explicitly_absent"].includes(field.state) &&
    objectHasContent(fieldDisplayValue(field)),
  );
}

function buildGates(
  sale: AuctionSale,
  fields: Map<string, CompletenessFieldResult>,
  propertyType: string,
  context: ProcedureContext,
): CompletenessGate[] {
  const sourceIdentity =
    hasField(fields, "listing_id") &&
    hasField(fields, "source_name") &&
    hasField(fields, "source_url");
  const propertyIdentity =
    hasField(fields, "property_type") &&
    (hasField(fields, "source_title") || hasField(fields, "source_description"));
  const preciseLocation = (() => {
    const exactAddress =
      hasField(fields, "address") &&
      hasField(fields, "location_precision", ["observed"], ["exact", "address"]);
    const parcel =
      hasField(fields, "cadastral_references") &&
      hasField(fields, "insee_code") &&
      hasField(fields, "location_precision", ["observed"], ["exact", "cadastral", "parcel"]);
    return exactAddress || parcel;
  })();
  const schedule = hasField(fields, "sale_date") || hasField(fields, "sale_schedule");
  const qualifiedSurface = (() => {
    if (propertyType === "land") {
      return hasField(fields, "land_surface_m2") && hasField(fields, "land_surface_scope");
    }
    if (propertyType === "mixed") {
      const oneLotOnly =
        hasField(fields, "lot_count", ["observed"], [1]) ||
        hasField(fields, "lot_count", ["not_applicable"]);
      return (
        (hasField(fields, "surface_built_m2") &&
          hasField(fields, "surface_scope", ["observed"], ["asset"])) ||
        (oneLotOnly &&
          hasField(fields, "surface_built_m2") &&
          hasField(fields, "lot_reference") &&
          hasField(fields, "surface_scope", ["observed"], ["lot"]))
      );
    }
    if (propertyType === "parking") {
      return (
        (hasField(fields, "surface_built_m2") &&
          hasField(fields, "surface_scope", ["observed"], ["asset", "lot", "annex"])) ||
        hasField(fields, "parking")
      );
    }
    return (
      hasField(fields, "surface_habitable_m2") ||
      hasField(fields, "surface_carrez_m2") ||
      hasField(fields, "surface_built_m2")
    );
  })();
  const stateMethod = normalized(
    asRecordOrNull(procedureRecord(sale).rules)?.state_sale_method ??
      procedureRecord(sale).state_sale_method,
  );
  const noStartingPriceConcept =
    context.procedure === "state" && ["appel_offres", "cession_amiable"].includes(stateMethod);
  const startingPrice =
    hasField(fields, "starting_price_eur") ||
    (noStartingPriceConcept &&
      hasField(fields, "starting_price_eur", ["not_applicable"]) &&
      hasField(fields, "procedure_record") &&
      hasField(fields, "source_blocks"));
  const sourceProof =
    nonEmptyProofField(fields, "capture_text") ||
    nonEmptyProofField(fields, "source_blocks") ||
    collectSaleDocuments(sale).some(
      (document) =>
        ["extracted", "incomplete", "partial"].includes(document.extraction_status ?? "") &&
        !["blocked", "failed", "unavailable", "not_found"].includes(
          document.download_status ?? "",
        ) &&
        typeof document.text_chars === "number" &&
        Number.isFinite(document.text_chars) &&
        document.text_chars > 0,
    ) ||
    (hasField(fields, "photos_usable_count") &&
      Number(fieldDisplayValue(fields.get("photos_usable_count")!)) >= 1);
  const criticalConflictFields = [
    "listing_id",
    "source_name",
    "source_url",
    "property_type",
    "lot_reference",
    "address",
    "sale_venue_type",
    "sale_legal_framework",
    "sale_verification_status",
    "procedure_record",
    "participation_mode",
    "bid_method",
    "payment_terms",
    "sale_date",
    "sale_schedule",
    "starting_price_eur",
    "sale_fees",
    "adjudication_price_eur",
    "surface_habitable_m2",
    "surface_carrez_m2",
    "surface_built_m2",
    "land_surface_m2",
    "occupancy_status",
  ];
  const criticalConflict =
    !criticalConflictFields.some((id) => fields.get(id)?.state === "conflict") &&
    fields.get("source_conflicts")?.state !== "conflict" &&
    fields.get("sale_verification_status")?.canonicalValue !== "conflict";
  const conditions =
    context.procedure !== "unknown" &&
    (hasField(fields, "conditions_sale") ||
      hasField(fields, "conditions_sale", ["not_applicable"]));
  const gate = (
    id: string,
    label: string,
    passed: boolean,
    blocking: "identity" | "critical",
    reason: string,
    gateFields: string[],
  ): CompletenessGate => ({ id, label, passed, blocking, reason, fields: gateFields });
  return [
    gate(
      "source_identity",
      "Identité de la source",
      sourceIdentity,
      "identity",
      "Identifiant, source et URL canonique requis.",
      ["listing_id", "source_name", "source_url"],
    ),
    gate(
      "property_identity",
      "Identité du bien",
      propertyIdentity,
      "identity",
      "Type de bien et titre ou description requis.",
      ["property_type", "source_title", "source_description"],
    ),
    gate(
      "location_precision",
      "Localisation précise",
      preciseLocation,
      "critical",
      "Adresse précise ou couple parcelle/INSEE requis.",
      ["address", "location_precision", "cadastral_references", "insee_code"],
    ),
    gate(
      "sale_schedule",
      "Calendrier de vente",
      schedule && context.procedure !== "unknown",
      "critical",
      "Date/fenêtre de vente et procédure vérifiée requises.",
      ["sale_date", "sale_schedule"],
    ),
    gate(
      "qualified_surface",
      "Surface qualifiée",
      qualifiedSurface,
      "critical",
      "Surface rattachée au bon actif, lot ou place requise.",
      [
        "surface_habitable_m2",
        "surface_carrez_m2",
        "surface_built_m2",
        "land_surface_m2",
        "land_surface_scope",
        "surface_scope",
        "parking",
      ],
    ),
    gate(
      "starting_price",
      "Prix ou méthode de vente",
      startingPrice,
      "critical",
      "Mise à prix ou méthode d’État justifiée.",
      ["starting_price_eur", "procedure_record", "source_blocks"],
    ),
    gate(
      "source_proof",
      "Preuve de capture",
      sourceProof,
      "critical",
      "Texte ou pièce lisible requis.",
      ["capture_text", "source_blocks", "documents_inventory", "photos_usable_count"],
    ),
    gate(
      "critical_conflict_free",
      "Absence de conflit critique",
      criticalConflict,
      "critical",
      "Tout conflit critique bloque la qualification.",
      criticalConflictFields,
    ),
    gate(
      "conditions_document",
      "Pièce de conditions",
      conditions,
      "critical",
      "Pièce observée ou non-applicable justifiée.",
      ["conditions_sale"],
    ),
  ];
}

export function classifyListingCompletenessScore(score: number): CompletenessClass {
  if (score < 55) return "incomplet";
  if (score < 75) return "a_enrichir";
  if (score < 90) return "decision_prete";
  return "riche";
}

function percentage(value: number): number {
  return Math.round(value * 10) / 10;
}

function scoreFields(
  fields: CompletenessFieldResult[],
  extraction: boolean,
): { score: number; categories: CompletenessCategorySummary[] } {
  const categoryScores = CATALOGUE.categories.map((category) => {
    const applicable = fields.filter(
      (field) =>
        field.category === category.id &&
        field.applicable &&
        field.state !== "not_applicable" &&
        (!extraction || !field.extractionExcluded),
    );
    const denominator = applicable.reduce(
      (total, field) => total + IMPORTANCE_FACTOR[field.importance],
      0,
    );
    const numerator = applicable.reduce(
      (total, field) => total + IMPORTANCE_FACTOR[field.importance] * STATE_FACTOR[field.state],
      0,
    );
    const categoryFields = fields.filter((field) => field.category === category.id);
    const ratio = denominator ? (numerator / denominator) * 100 : null;
    return {
      summary: {
        id: category.id,
        label: category.label,
        weight: category.weight,
        ratio: ratio == null ? null : percentage(ratio),
        applicableCount: applicable.length,
        knownCount: categoryFields.filter(
          (field) =>
            ["observed", "explicitly_absent", "inferred"].includes(field.state) && field.applicable,
        ).length,
        missingCount: categoryFields.filter(
          (field) => ["unknown", "conflict"].includes(field.state) && field.applicable,
        ).length,
        conflictCount: categoryFields.filter(
          (field) => field.state === "conflict" && field.applicable,
        ).length,
        notApplicableCount: categoryFields.filter(
          (field) => field.state === "not_applicable" || !field.applicable,
        ).length,
      } satisfies CompletenessCategorySummary,
      ratio,
    };
  });
  const active = categoryScores.filter((category) => category.ratio !== null);
  const weight = active.reduce((total, category) => total + category.summary.weight, 0);
  const score = weight
    ? active.reduce(
        (total, category) => total + (category.ratio ?? 0) * category.summary.weight,
        0,
      ) / weight
    : 0;
  return { score, categories: categoryScores.map((category) => category.summary) };
}

function buildKnownBySource(fields: CompletenessFieldResult[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const field of fields) {
    if (!field.applicable || !["observed", "explicitly_absent", "inferred"].includes(field.state))
      continue;
    const sources = field.sourceNames.length ? field.sourceNames : ["Projection canonique"];
    for (const source of sources) {
      grouped[source] = [...new Set([...(grouped[source] ?? []), field.id])];
    }
  }
  return grouped;
}

/**
 * Computes the 130-field completeness contract for one listing.
 *
 * Product completeness keeps inaccessible fields in the denominator. The
 * extraction view excludes only fields whose source presence explicitly proves
 * that the artifact could not be read. A portal name never selects a judicial,
 * notarial, state or online profile by itself.
 */
export function getListingCompleteness(sale: AuctionSale): ListingCompletenessResult {
  const propertyType = normalizedPropertyType(sale.property_type);
  const context = procedureContext(sale);
  const profile = selectProfile(sale, context);
  const documents = collectSaleDocuments(sale);
  const categoryLabels = new Map(
    CATALOGUE.categories.map((category) => [category.id, category.label]),
  );
  const fields = CATALOGUE.fields.map((catalogField, fieldIndex) => {
    const applicable = fieldApplicable(catalogField, propertyType, context.procedure);
    const observation = applicable
      ? fieldObservation(sale, catalogField, fieldIndex, documents)
      : makeObservation(catalogField.id, "not_applicable", null, {
          reason: {
            code: "property_or_procedure_scope",
            explanation: `Le champ ne s’applique pas au type de bien ${propertyType} ou à cette procédure.`,
          },
        });
    return {
      ...observation,
      id: catalogField.id,
      label: catalogField.label,
      category: catalogField.category,
      categoryLabel: categoryLabels.get(catalogField.category) ?? catalogField.category,
      definition: catalogField.definition ?? "",
      type: catalogField.type ?? "unknown",
      unit: catalogField.unit ?? null,
      importance: catalogField.importance,
      applicable,
      extractionExcluded: applicable && extractionUnavailable(sale, observation),
    } satisfies CompletenessFieldResult;
  });
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const productScore = scoreFields(fields, false);
  const extractionScore = scoreFields(fields, true);
  const gates = buildGates(sale, fieldMap, propertyType, context);
  const gateFailures = gates.filter((gate) => !gate.passed);
  const identityGateFailed = gateFailures.some((gate) => gate.blocking === "identity");
  const criticalGateFailed = gateFailures.some((gate) => gate.blocking === "critical");
  const rawClassification = classifyListingCompletenessScore(productScore.score);
  const publishedClassification = identityGateFailed
    ? "incomplet"
    : criticalGateFailed
      ? "a_enrichir"
      : rawClassification;
  const missing = fields
    .filter((field) => field.applicable && ["unknown", "conflict"].includes(field.state))
    .sort((left, right) => IMPORTANCE_FACTOR[right.importance] - IMPORTANCE_FACTOR[left.importance])
    .map((field) => ({
      id: field.id,
      label: field.label,
      category: field.category,
      importance: field.importance,
      state: field.state,
      reason: fieldReason(field),
      nextAction: nextAction(field, profile),
      sourceContext: `${contextLabel(context.procedure)} · ${profile.label}`,
    }));
  const toConfirm = fields
    .filter((field) => field.applicable && ["inferred", "conflict"].includes(field.state))
    .sort((left, right) => IMPORTANCE_FACTOR[right.importance] - IMPORTANCE_FACTOR[left.importance])
    .map((field) => ({
      id: field.id,
      label: field.label,
      category: field.category,
      importance: field.importance,
      state: field.state,
      reason: fieldReason(field),
      nextAction: nextAction(field, profile),
      sourceContext: `${contextLabel(context.procedure)} · ${profile.label}`,
    }));
  const known = fields
    .filter(
      (field) =>
        field.applicable && ["observed", "explicitly_absent", "inferred"].includes(field.state),
    )
    .map((field) => ({
      id: field.id,
      label: field.label,
      state: field.state,
      value: fieldDisplayValue(field),
      sourceNames: field.sourceNames,
      evidence: field.evidence,
    }));
  const counts = {
    applicable: fields.filter((field) => field.applicable && field.state !== "not_applicable")
      .length,
    notApplicable: fields.filter((field) => !field.applicable || field.state === "not_applicable")
      .length,
    observed: fields.filter((field) => field.applicable && field.state === "observed").length,
    inferred: fields.filter((field) => field.applicable && field.state === "inferred").length,
    unknown: fields.filter((field) => field.applicable && field.state === "unknown").length,
    conflict: fields.filter((field) => field.applicable && field.state === "conflict").length,
  };
  return {
    score: percentage(productScore.score),
    completenessScore: percentage(productScore.score),
    extractionCoverageScore: percentage(extractionScore.score),
    classification: publishedClassification,
    rawClassification,
    contextLabel: contextLabel(context.procedure),
    propertyType,
    procedure: context.procedure,
    profile,
    fields,
    known,
    missing,
    toConfirm,
    knownBySource: buildKnownBySource(fields),
    categories: productScore.categories,
    gates,
    gateFailures,
    identityGateFailed,
    criticalGateFailed,
    applicableFieldCount: counts.applicable,
    notApplicableFieldCount: counts.notApplicable,
    observedFieldCount: counts.observed,
    inferredFieldCount: counts.inferred,
    unknownFieldCount: counts.unknown,
    conflictFieldCount: counts.conflict,
    notApplicableReason: "Le non-applicable sort du score ; l’inaccessible reste inconnu.",
  };
}

export const computeListingCompleteness = getListingCompleteness;

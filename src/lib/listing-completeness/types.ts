import { collectSaleDocuments } from "../sale-documents";
import type { SaleLegalFramework, SaleVenueType, SaleVerificationStatus } from "../types";
import type {
  CompletenessCategoryId,
  CompletenessClass,
  CompletenessImportance,
  CompletenessProcedure,
  CompletenessState,
} from "@/lib/listing-completeness/catalogue";

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

export type ProcedureContext = {
  procedure: CompletenessProcedure;
  verified: boolean;
  venueType: SaleVenueType | null;
  legalFramework: SaleLegalFramework | null;
  participationMode: string | null;
  verificationStatus: SaleVerificationStatus | null;
};

export type DirectValue = {
  value: unknown;
  state?: CompletenessState;
  reason?: CompletenessReason | null;
  inference?: CompletenessInference | null;
};

export type CollectedDocuments = ReturnType<typeof collectSaleDocuments>;

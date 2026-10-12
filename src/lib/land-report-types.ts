/** Shared serializable contracts for the official land dossier. No browser or server imports. */
export type LandGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
};

export type LandCoordinates = { longitude: number; latitude: number };
export type LandScope = "parcel" | "point" | "commune" | "radius" | "document";
export type LandSourceStatus =
  | "available"
  | "empty"
  | "partial"
  | "unavailable"
  | "not_configured"
  | "not_checked";

export type LandSourceCheck = {
  key: string;
  label: string;
  status: LandSourceStatus;
  scope: LandScope;
  sourceUrl: string;
  checkedAt: string;
  message?: string;
  httpStatus?: number;
  version?: string;
  sourceUpdatedAt?: string;
  parcelIds?: string[];
};

export type LandParcelReference = {
  codeInsee?: string | null;
  section: string;
  number: string;
  prefix?: string | null;
  source: "document" | "listing" | "stored";
};

export type LandLocationInput = {
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  codeInsee?: string | null;
  coordinates?: LandCoordinates | null;
  references?: LandParcelReference[];
};

export type LandProviderOptions = {
  fetcher?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  token?: string | null;
};

export type LandParcel = {
  id: string;
  codeInsee: string;
  section: string;
  number: string;
  prefix: string;
  city?: string;
  surfaceM2: number | null;
  geometry: LandGeometry;
  match: "document_reference" | "listing_reference" | "stored_reference" | "address_point";
  sourceUrl: string;
};

export type LandPlanningDocument = {
  id: string;
  name: string;
  type: string;
  title: string;
  legalStatus: string | null;
  effectiveStatus: string | null;
  publicationDate: string | null;
  updatedAt: string | null;
  sourceUrl: string;
  files: { name: string; url: string }[];
  downloadable: boolean;
};

export type LandZone = {
  id: string;
  label: string;
  description: string;
  type: string;
  documentId: string;
  documentName: string;
  parcelIds: string[];
  regulationUrl?: string | null;
  regulationFile?: string | null;
  startPage?: number | null;
  geometry?: LandGeometry;
};

export type LandConstraint = {
  id: string;
  kind: "prescription" | "information" | "servitude";
  label: string;
  typeCode: string | null;
  layer: string;
  parcelIds: string[];
  documentId: string | null;
  documentUrl?: string | null;
  detail?: string;
  /** Envelopes must not be interpreted as a parcel-specific regulatory class. */
  isEnvelope?: boolean;
  geometry?: LandGeometry;
};

export type LandPlanningResult = {
  locationStatus: "references_matched" | "point_candidate" | "ambiguous" | "unresolved";
  coordinates: LandCoordinates | null;
  codeInsee: string | null;
  parcels: LandParcel[];
  zones: LandZone[];
  documents: LandPlanningDocument[];
  constraints: LandConstraint[];
  checks: LandSourceCheck[];
  warnings: string[];
  completeCoverage: boolean;
};

export type LandRiskCategory =
  | "flood"
  | "fire"
  | "ground_movement"
  | "clay"
  | "cavity_mining"
  | "pollution"
  | "technological"
  | "earthquake"
  | "radon"
  | "coastal"
  | "other";

export type LandRiskFinding = {
  id: string;
  category: LandRiskCategory;
  label: string;
  scope: LandScope;
  status: "mapped" | "nearby" | "communal" | "history";
  level?: string | null;
  description: string;
  consequences: string[];
  regulatory: boolean | null;
  sourceUrl: string;
  sourceLabel: string;
  checkedAt: string;
  sourceUpdatedAt?: string | null;
  vintage?: string | null;
  parcelIds?: string[];
  distanceM?: number | null;
  precision?: string | null;
  documentUrls?: { label: string; url: string }[];
};

export type LandRisksInput = {
  parcels: LandParcel[];
  coordinates: LandCoordinates | null;
  codeInsee: string | null;
};
export type LandRisksResult = {
  findings: LandRiskFinding[];
  checks: LandSourceCheck[];
  warnings: string[];
};

export type LandRuleTopic =
  | "destination"
  | "footprint"
  | "height"
  | "setbacks"
  | "green_space"
  | "parking"
  | "access_networks"
  | "appearance"
  | "other";

export type LandRuleEvidence = {
  id: string;
  topic: LandRuleTopic;
  title: string;
  text: string;
  zoneLabels: string[];
  documentId: string;
  sourceUrl: string;
  page: number;
  article?: string | null;
  conditions: string[];
  confidence: "extracted" | "reviewed";
};

export type LandRulesResult = {
  rules: LandRuleEvidence[];
  checks: LandSourceCheck[];
  warnings: string[];
  completeCoverage: boolean;
};

export type LandProjectKind = "extension" | "height" | "construction" | "division" | "destination";
export type LandProjectParameters = {
  kind: LandProjectKind;
  addedSurfaceM2?: number | null;
  existingFootprintM2?: number | null;
  plannedFootprintM2?: number | null;
  currentHeightM?: number | null;
  plannedHeightM?: number | null;
  intendedUse?: string | null;
};
export type LandProjectAnalysis = {
  kind: LandProjectKind;
  title: string;
  status: "conditions_to_review" | "insufficient_information";
  summary: string;
  rules: LandRuleEvidence[];
  checks: string[];
  missingInformation: string[];
};

export type LandReport = {
  version: "land-report-v1";
  generatedAt: string;
  planning: LandPlanningResult;
  risks: LandRisksResult;
  rules: LandRulesResult;
  projects: LandProjectAnalysis[];
};

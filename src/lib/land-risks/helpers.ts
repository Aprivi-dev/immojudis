import type {
  LandCoordinates,
  LandParcel,
  LandRiskCategory,
  LandRiskFinding,
  LandRisksInput,
  LandScope,
} from "../land-report-types";
import { asRecordOrNull } from "@/lib/guards";

export type ApiVersion = "v1" | "v2";
export type LocationMode = "point" | "radius" | "ppr" | "radon" | "commune" | "geographic";

export type QueryContext = {
  input: LandRisksInput;
  version: ApiVersion;
  parcels: LandParcel[];
  parcelIds: string[];
  coordinates: LandCoordinates | null;
  codeInsee: string | null;
  queryScope: LandScope;
  locationMessage: string | null;
};

export type RawFinding = {
  category: LandRiskCategory;
  label: string;
  scope?: LandScope;
  status?: LandRiskFinding["status"];
  level?: string | null;
  description: string;
  consequences: string[];
  regulatory?: boolean | null;
  sourceUpdatedAt?: string | null;
  vintage?: string | null;
  parcelIds?: string[];
  distanceM?: number | null;
  precision?: string | null;
  documentUrls?: { label: string; url: string }[];
};

export type SourceSpec = {
  key: string;
  label: string;
  v1Path?: string;
  v2Path?: string;
  mode: LocationMode;
  parser: (payload: unknown, context: QueryContext) => RawFinding[];
};

export function numberFrom(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function records(value: unknown, directKeys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value
      .map(asRecordOrNull)
      .filter((item): item is Record<string, unknown> => Boolean(item));
  const record = asRecordOrNull(value);
  if (!record) return [];
  for (const key of ["content", "results", "data"]) {
    const list = record[key];
    if (Array.isArray(list))
      return list
        .map(asRecordOrNull)
        .filter((item): item is Record<string, unknown> => Boolean(item));
  }
  if (directKeys.some((key) => key in record)) return [record];
  return [];
}

export function matchesRequestedCommune(
  record: Record<string, unknown>,
  requestedCodeInsee: string | null,
): boolean {
  if (!requestedCodeInsee) return true;
  const returnedCode = text(record, ["code_insee", "codeInsee"]);
  return !returnedCode || normalizeCodeInsee(returnedCode) === requestedCodeInsee;
}

export function payloadHasNoRecords(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  const record = asRecordOrNull(value);
  if (!record) return true;
  const pagedLists = ["content", "results", "data"].map((key) => record[key]).filter(Array.isArray);
  if (pagedLists.length > 0) return pagedLists.every((list) => list.length === 0);
  const nestedLists = [
    "casias",
    "instructions",
    "conclusions_sis",
    "conclusionsSis",
    "conclusions_sup",
    "conclusionsSup",
  ]
    .map((key) => record[key])
    .filter(Array.isArray);
  if (nestedLists.length > 0) return nestedLists.every((list) => list.length === 0);
  const nestedValues = [
    "casias",
    "instructions",
    "conclusions_sis",
    "conclusionsSis",
    "conclusions_sup",
    "conclusionsSup",
  ]
    .map((key) => record[key])
    .filter((item): item is Record<string, unknown> => Boolean(asRecordOrNull(item)));
  if (nestedValues.length > 0) return nestedValues.every((item) => payloadHasNoRecords(item));
  return Object.keys(record).length === 0;
}

export function values(
  record: Record<string, unknown> | null,
  keys: string[],
): Record<string, unknown>[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value))
      return value
        .map(asRecordOrNull)
        .filter((item): item is Record<string, unknown> => Boolean(item));
    const nested = asRecordOrNull(value);
    if (nested) return [nested];
  }
  return [];
}

export function recordValue(record: Record<string, unknown> | null, keys: string[]): unknown {
  if (!record) return null;
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return null;
}

export function text(record: Record<string, unknown> | null, keys: string[]): string | null {
  const value = recordValue(record, keys);
  if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function valuesAsText(record: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => formatUnknown(record[key]))
    .filter(Boolean)
    .join(" ");
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatUnknown).filter(Boolean).join(" ");
  const record = asRecordOrNull(value);
  return record ? Object.values(record).map(formatUnknown).filter(Boolean).join(" ") : "";
}

export function dateFrom(
  record: Record<string, unknown> | null,
  extraKeys: string[] = [],
): string | null {
  const value = text(record, [
    ...extraKeys,
    "dateMaj",
    "date_maj",
    "dateModification",
    "date_modification",
    "dateApprobation",
    "date_approbation",
    "date_publication_jo",
    "datePublicationJo",
  ]);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function urlFromRecord(
  record: Record<string, unknown> | null,
): { label: string; url: string }[] | undefined {
  const urls: { label: string; url: string }[] = [];
  for (const key of ["url", "lienPpr", "lien", "documentUrl", "document_url"]) {
    const url = recordValue(record, [key]);
    if (typeof url === "string" && /^https?:\/\//i.test(url))
      urls.push({ label: "Document Géorisques", url });
  }
  return urls.length ? urls : undefined;
}

export function distanceFrom(record: Record<string, unknown> | null): number | null {
  const value = recordValue(record, ["distance", "distanceM", "distance_m"]);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function categoryFromText(value: string): LandRiskCategory {
  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/recul.*cote|trait.*cote|littoral|submersion marine|erosion cotiere/.test(normalized))
    return "coastal";
  if (/pprn[-_ ]?i\b|ppri|ppr.*inond|inond|ruissel|remontee|submersion|crue/.test(normalized))
    return "flood";
  if (/feu.*foret|incendie.*foret|debrouss|forestier/.test(normalized)) return "fire";
  if (/argile|retrait.*gonflement/.test(normalized)) return "clay";
  if (/cavite|carriere|minier|mine/.test(normalized)) return "cavity_mining";
  if (
    /pprn[-_ ]?(?:mvt|mouv)\b|mouvement|glissement|effondrement|affaissement|avalanche|eboulement/.test(
      normalized,
    )
  )
    return "ground_movement";
  if (/pollution|casias|sis|sol pollue|ancien site/.test(normalized)) return "pollution";
  if (
    /icpe|technolog|nucleaire|seveso|canalisation|barrage|marchandises dangereuses|transport.*dangereux|\btmd\b/.test(
      normalized,
    )
  )
    return "technological";
  if (/sism|seisme/.test(normalized)) return "earthquake";
  if (/radon/.test(normalized)) return "radon";
  return "other";
}

export function normalizeCodeInsee(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[0-9A-Z]{5}$/.test(normalized) ? normalized : null;
}

export function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

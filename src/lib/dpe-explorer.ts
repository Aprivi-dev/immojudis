import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  DPE_CLASSES,
  extractDpe,
  normalizeDpeClass,
  type DpeClass,
  type DpeSource,
  type StructuredDpeDiagnostic,
} from "@/lib/dpe";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import type { SaleDocumentRich } from "@/lib/types";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AppSaleRow = Database["public"]["Views"]["v_auction_sales_app"]["Row"];
type DpeDiagnosticRow = Database["public"]["Tables"]["auction_dpe_diagnostics"]["Row"];

const DPE_COLUMNS = [
  "id",
  "title",
  "city",
  "department",
  "postal_code",
  "address",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "updated_at",
  "latitude",
  "longitude",
  "documents_rich",
  "source_blocks",
  "source_name",
  "source_url",
].join(",");

const optionalText = (max = 140) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

const booleanParam = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const dpeExplorerQuerySchema = z.object({
  department: optionalText(12),
  city: optionalText(140),
  propertyType: optionalText(80),
  dpeClasses: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
        : value,
    z.array(z.enum(DPE_CLASSES)).default([]),
  ),
  includeMap: booleanParam.default(true),
  limit: z.coerce.number().int().min(1).max(500).default(120),
});

export type DpeExplorerQueryInput = z.input<typeof dpeExplorerQuerySchema>;
export type DpeExplorerQuery = z.output<typeof dpeExplorerQuerySchema>;

export type DpeExplorerItem = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  postalCode: string | null;
  address: string | null;
  propertyType: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  updatedAt: string | null;
  dpeClass: DpeClass | null;
  gesClass: DpeClass | null;
  dpeLabel: string | null;
  dpeSource: DpeSource;
  diagnosticNumber: string | null;
  dpeConfidence: number | null;
  latitude: number | null;
  longitude: number | null;
  sourceName: string | null;
  sourceUrl: string | null;
};

export type DpeExplorerMapPoint = {
  id: string;
  city: string | null;
  department: string | null;
  latitude: number;
  longitude: number;
  dpeClass: DpeClass | null;
  label: string | null;
};

export type DpeExplorerSummary = {
  total: number;
  knownClassCount: number;
  documentOnlyCount: number;
  mapPointCount: number;
  classCounts: Record<DpeClass, number>;
  sourceCounts: {
    ademe: number;
    sourceBlocks: number;
    documents: number;
  };
};

export type DpeExplorerResponse = {
  items: DpeExplorerItem[];
  mapPoints: DpeExplorerMapPoint[];
  summary: DpeExplorerSummary;
  scope: {
    department: string | null;
    city: string | null;
    propertyType: string | null;
    dpeClasses: DpeClass[];
    includeMap: boolean;
    limit: number;
  };
};

export async function getDpeExplorer({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: DpeExplorerQuery;
}): Promise<DpeExplorerResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "dpe.latest")) {
    throw new Error("Explorateur DPE réservé au plan Analyse.");
  }
  if (input.dpeClasses.length && !featureIncluded(plan.plan, "dpe.filters")) {
    throw new Error("Filtres DPE réservés au plan Analyse.");
  }
  if (input.includeMap && !featureIncluded(plan.plan, "dpe.map")) {
    throw new Error("Carte DPE réservée au plan Analyse.");
  }

  const rows = await queryDpeSales({ auth, input });
  const dpeBySourceUrl = await getDpeDiagnosticsBySourceUrl(rows.map((row) => row.source_url));
  const items = rows
    .map((row) => rowToDpeItem(row, dpeBySourceUrl.get(row.source_url ?? "") ?? []))
    .filter((item): item is DpeExplorerItem => Boolean(item))
    .filter((item) => !input.dpeClasses.length || dpeClassMatches(item.dpeClass, input.dpeClasses))
    .slice(0, input.limit);
  const mapPoints = input.includeMap ? buildDpeMapPoints(items) : [];
  const summary = buildDpeExplorerSummary(items, mapPoints);

  await recordFeatureUsageEvent({
    auth,
    eventKey: "dpe.explorer_viewed",
    subjectType: "dpe_explorer_scope",
    metadata: {
      total: summary.total,
      known_class_count: summary.knownClassCount,
      map_point_count: summary.mapPointCount,
      department: input.department ?? null,
      city: input.city ?? null,
      property_type: input.propertyType ?? null,
      dpe_classes: input.dpeClasses,
      include_map: input.includeMap,
    },
  });

  return {
    items,
    mapPoints,
    summary,
    scope: {
      department: input.department ?? null,
      city: input.city ?? null,
      propertyType: input.propertyType ?? null,
      dpeClasses: input.dpeClasses,
      includeMap: input.includeMap,
      limit: input.limit,
    },
  };
}

export function buildDpeExplorerSummary(
  items: DpeExplorerItem[],
  mapPoints: DpeExplorerMapPoint[] = buildDpeMapPoints(items),
): DpeExplorerSummary {
  const classCounts = emptyDpeCounts();

  for (const item of items) {
    if (item.dpeClass) classCounts[item.dpeClass] += 1;
  }

  return {
    total: items.length,
    knownClassCount: items.filter((item) => item.dpeClass).length,
    documentOnlyCount: items.filter((item) => item.dpeSource === "documents").length,
    mapPointCount: mapPoints.length,
    classCounts,
    sourceCounts: {
      ademe: items.filter((item) => item.dpeSource === "ademe").length,
      sourceBlocks: items.filter((item) => item.dpeSource === "source_blocks").length,
      documents: items.filter((item) => item.dpeSource === "documents").length,
    },
  };
}

export function buildDpeMapPoints(items: DpeExplorerItem[]): DpeExplorerMapPoint[] {
  return items
    .filter((item) => item.latitude != null && item.longitude != null)
    .map((item) => ({
      id: item.id,
      city: item.city,
      department: item.department,
      latitude: item.latitude as number,
      longitude: item.longitude as number,
      dpeClass: item.dpeClass,
      label: item.dpeLabel,
    }));
}

async function queryDpeSales({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: DpeExplorerQuery;
}): Promise<AppSaleRow[]> {
  let query = auth.supabase
    .from("v_auction_sales_app")
    .select(DPE_COLUMNS)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(input.limit * 3, 1000));

  if (input.department) query = query.eq("department", input.department);
  if (input.city) query = query.ilike("city", `%${input.city}%`);
  if (input.propertyType) query = query.eq("property_type", input.propertyType);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as AppSaleRow[];
}

async function getDpeDiagnosticsBySourceUrl(
  sourceUrls: Array<string | null>,
): Promise<Map<string, StructuredDpeDiagnostic[]>> {
  const unique = [...new Set(sourceUrls.filter((value): value is string => Boolean(value)))];
  if (!unique.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("auction_dpe_diagnostics")
    .select("*")
    .in("source_url", unique.slice(0, 1000))
    .order("confidence", { ascending: false })
    .order("established_at", { ascending: false, nullsFirst: false });

  if (error) {
    console.warn("Unable to load DPE diagnostics for explorer", { message: error.message });
    return new Map();
  }

  const bySource = new Map<string, StructuredDpeDiagnostic[]>();
  for (const row of data ?? []) {
    const sourceUrl = row.source_url;
    if (!sourceUrl) continue;
    const items = bySource.get(sourceUrl) ?? [];
    if (items.length < 8) items.push(dpeDiagnosticRowToExplorer(row));
    bySource.set(sourceUrl, items);
  }
  return bySource;
}

function dpeDiagnosticRowToExplorer(row: DpeDiagnosticRow): StructuredDpeDiagnostic {
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

function rowToDpeItem(
  row: AppSaleRow,
  structuredDiagnostics: StructuredDpeDiagnostic[] = [],
): DpeExplorerItem | null {
  const dpe = extractDpe(
    {
      source_blocks:
        row.source_blocks && typeof row.source_blocks === "object"
          ? (row.source_blocks as Record<string, unknown>)
          : null,
      documents_rich: Array.isArray(row.documents_rich)
        ? (row.documents_rich as unknown as SaleDocumentRich[])
        : null,
    },
    structuredDiagnostics,
  );

  if (!dpe.source) return null;

  return {
    id: row.id ?? "",
    title: row.title,
    city: row.city,
    department: row.department,
    postalCode: row.postal_code,
    address: row.address,
    propertyType: row.property_type,
    startingPriceEur: positiveNumber(row.starting_price_eur),
    saleDate: row.sale_date,
    updatedAt: row.updated_at,
    dpeClass: dpe.class,
    gesClass: dpe.diagnostic?.gesClass ?? null,
    dpeLabel: dpe.label,
    dpeSource: dpe.source,
    diagnosticNumber: dpe.diagnostic?.diagnosticNumber ?? null,
    dpeConfidence: dpe.diagnostic?.confidence ?? null,
    latitude: finiteNumber(row.latitude),
    longitude: finiteNumber(row.longitude),
    sourceName: row.source_name,
    sourceUrl: row.source_url,
  };
}

function dpeClassMatches(value: DpeClass | null, accepted: DpeClass[]): boolean {
  if (!accepted.length) return true;
  return value != null && accepted.includes(normalizeDpeClass(value) as DpeClass);
}

function emptyDpeCounts(): Record<DpeClass, number> {
  return DPE_CLASSES.reduce(
    (acc, dpeClass) => {
      acc[dpeClass] = 0;
      return acc;
    },
    {} as Record<DpeClass, number>,
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

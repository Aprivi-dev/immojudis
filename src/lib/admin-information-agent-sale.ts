import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { AuctionSale, SaleDocumentRich, SaleMedia } from "@/lib/types";

/**
 * The admin information workflow is allowed to inspect a sale that is kept out
 * of the public catalogue while its source data is being reviewed.  Do not
 * replace this query with `v_auction_sales_app`: that projection deliberately
 * hides quarantined rows and is therefore the wrong source for an internal
 * request draft.
 */
const ADMIN_INFORMATION_AGENT_SALE_SELECT = [
  "id",
  "title",
  "description",
  "city",
  "department",
  "postal_code",
  "address",
  "tribunal",
  "tribunal_code",
  "property_type",
  "starting_price_eur",
  "sale_date",
  "visit_dates",
  "lawyer_name",
  "lawyer_contact",
  "occupancy_status",
  "surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "surface_confidence",
  "surface_evidence",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "parking_count",
  "has_garden",
  "has_terrace",
  "has_garage",
  "has_pool",
  "has_air_conditioning",
  "has_double_glazing",
  "investment_score",
  "investment_summary",
  "score_version",
  "risk_notes",
  "source_name",
  "primary_source",
  "source_url",
  "source_urls",
  "dedupe_confidence",
  "documents",
  "quality_flags",
  "sale_venue_type",
  "sale_legal_framework",
  "sale_verification_status",
  "sale_procedure",
  "status",
  "created_at",
  "updated_at",
  "raw_payload",
  "observations",
  "adjudication_price_eur",
].join(",");

/** Statuses for which it still makes sense to contact a sale interlocutor. */
export const ADMIN_INFORMATION_AGENT_AVAILABLE_STATUSES = [
  "active",
  "upcoming",
  "unknown",
  "postponed",
] as const;

type AdminInformationAgentAvailableStatus =
  (typeof ADMIN_INFORMATION_AGENT_AVAILABLE_STATUSES)[number];

type AdminInformationAgentSaleRow = Record<string, unknown> & {
  id?: unknown;
  source_url?: unknown;
  source_name?: unknown;
  raw_payload?: unknown;
  observations?: unknown;
};

type AuctionDocumentRow = Record<string, unknown>;

type DatabaseResult = { data: unknown; error: { code?: string; message: string } | null };
type SourcePresenceQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): SourcePresenceQuery;
  eq(column: string, value: unknown): SourcePresenceQuery;
};

const sourcePresenceAdmin = supabaseAdmin as unknown as {
  from(table: string): SourcePresenceQuery;
};

export type AdminInformationAgentSaleAuth = Pick<SupabaseAuthContext, "isAdmin">;

/**
 * Loads the private sale snapshot consumed by the admin information-agent
 * draft builder.  The return value is an internal `AuctionSale` shape; callers
 * must only return derived draft/gap/contact data to the browser.
 */
export async function loadAdminInformationAgentSale({
  auth,
  saleId,
}: {
  auth: AdminInformationAgentSaleAuth;
  saleId: string;
}): Promise<AuctionSale> {
  requireAdminInformationAgentSaleAccess(auth);

  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select(ADMIN_INFORMATION_AGENT_SALE_SELECT)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  const row = asSaleRow(data);
  if (!row?.id) throw new Error("Vente introuvable.");

  const status = nullableString(row.status);
  if (!isAvailableInformationAgentStatus(status)) {
    throw new Error("Cette vente n'est plus disponible pour une demande d'informations.");
  }

  const [documents, sourcePresence] = await Promise.all([
    loadAdminInformationAgentDocuments(row.source_url),
    loadAdminInformationAgentSourcePresence(saleId, row.raw_payload),
  ]);
  return toInformationAgentSale(row, documents, sourcePresence);
}

export function requireAdminInformationAgentSaleAccess(auth: AdminInformationAgentSaleAuth): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
}

function isAvailableInformationAgentStatus(
  status: string | null,
): status is AdminInformationAgentAvailableStatus {
  return (ADMIN_INFORMATION_AGENT_AVAILABLE_STATUSES as readonly string[]).includes(status ?? "");
}

async function loadAdminInformationAgentDocuments(sourceUrl: unknown): Promise<SaleDocumentRich[]> {
  if (typeof sourceUrl !== "string" || !sourceUrl.trim()) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_documents")
    .select(
      "document_url,label,document_type,extraction_status,download_status,docling_status,text_chars",
    )
    .eq("source_url", sourceUrl)
    .order("created_at", { ascending: true });
  if (error) throw error;

  return (data ?? [])
    .map((value) => toDocument(value as unknown as AuctionDocumentRow))
    .filter((document): document is SaleDocumentRich => document !== null);
}

async function loadAdminInformationAgentSourcePresence(
  saleId: string,
  rawPayload: unknown,
): Promise<AuctionSale["source_presence"]> {
  const { data, error } = await sourcePresenceAdmin
    .from("auction_sale_source_presence")
    .select("source_name,availability,state,attempted_at,checked_at,run_id,extras")
    .eq("sale_id", saleId);
  if (error) {
    // The web rollout may precede the single atomic migration. Keep the
    // quarantined admin path available only while the projection relation is
    // genuinely absent; any other projection error must fail closed.
    if (isMissingSourcePresenceProjection(error)) {
      return sourcePresenceObject(asRecord(rawPayload).source_presence);
    }
    throw error;
  }
  return sourcePresenceRows(data);
}

function isMissingSourcePresenceProjection(error: { code?: string; message: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01";
}

function toInformationAgentSale(
  row: AdminInformationAgentSaleRow,
  documents: SaleDocumentRich[],
  sourcePresence: AuctionSale["source_presence"],
): AuctionSale {
  const rawPayload = asRecord(row.raw_payload);
  const observations = asArray(row.observations);
  const sourceBlocks = asRecordOrNull(rawPayload.source_blocks);

  return {
    id: stringValue(row.id, ""),
    title: nullableString(row.title),
    description: nullableString(row.description),
    source_description: nullableString(rawPayload.source_description),
    llm_display_description: nullableString(rawPayload.llm_display_description),
    about_description: nullableString(rawPayload.llm_display_description),
    source_checks: sourceChecks(rawPayload.source_checks),
    source_conflicts: sourceConflicts(rawPayload.source_conflicts),
    source_presence: sourcePresence,
    city: nullableString(row.city),
    department: nullableString(row.department),
    postal_code: nullableString(row.postal_code),
    address: nullableString(row.address),
    tribunal: nullableString(row.tribunal),
    tribunal_code: nullableString(row.tribunal_code),
    tribunal_name: null,
    tribunal_city: null,
    sale_venue_type: nullableString(row.sale_venue_type) as AuctionSale["sale_venue_type"],
    sale_legal_framework: nullableString(
      row.sale_legal_framework,
    ) as AuctionSale["sale_legal_framework"],
    sale_verification_status: nullableString(
      row.sale_verification_status,
    ) as AuctionSale["sale_verification_status"],
    sale_procedure: asRecordOrNull(row.sale_procedure),
    property_type: nullableString(row.property_type),
    starting_price_eur: numberValue(row.starting_price_eur),
    sale_date: nullableString(row.sale_date),
    visit_dates: row.visit_dates ?? null,
    lawyer_name: nullableString(row.lawyer_name),
    lawyer_contact: nullableString(row.lawyer_contact),
    adjudication_price_eur: numberValue(row.adjudication_price_eur),
    latitude: numberValue(row.latitude),
    longitude: numberValue(row.longitude),
    occupancy_status: nullableString(row.occupancy_status),
    habitable_surface_m2: numberValue(row.habitable_surface_m2),
    carrez_surface_m2: numberValue(row.carrez_surface_m2),
    land_surface_m2: numberValue(row.land_surface_m2),
    app_surface_m2: numberValue(row.app_surface_m2),
    app_surface_kind: nullableString(row.app_surface_kind),
    surface_scope: nullableString(row.surface_scope),
    surface_source: nullableString(row.surface_source),
    surface_confidence: numberValue(row.surface_confidence),
    surface_evidence: nullableString(row.surface_evidence),
    rooms_count: numberValue(row.rooms_count),
    bedrooms_count: numberValue(row.bedrooms_count),
    bathrooms_count: numberValue(row.bathrooms_count),
    parking_count: numberValue(row.parking_count),
    has_garden: booleanValue(row.has_garden),
    has_terrace: booleanValue(row.has_terrace),
    has_garage: booleanValue(row.has_garage),
    has_pool: booleanValue(row.has_pool),
    has_air_conditioning: booleanValue(row.has_air_conditioning),
    has_double_glazing: booleanValue(row.has_double_glazing),
    investment_score: numberValue(row.investment_score),
    investment_summary: nullableString(row.investment_summary),
    score_version: nullableString(row.score_version),
    score_confidence: numberValue(row.score_confidence),
    score_factors: null,
    risk_notes: nullableString(row.risk_notes),
    risks: null,
    source_name: nullableString(row.source_name),
    source_url: nullableString(row.source_url),
    primary_source: nullableString(row.primary_source),
    source_urls: row.source_urls ?? null,
    dedupe_confidence: nullableString(row.dedupe_confidence),
    quality_flags: row.quality_flags ?? null,
    documents: row.documents ?? null,
    documents_rich: documents,
    media: collectSaleMedia(row),
    status: nullableString(row.status),
    created_at: nullableString(row.created_at),
    updated_at: nullableString(row.updated_at),
    source_blocks: sourceBlocks,
    source_blocks_by_source: collectSourceBlocksBySource(row, sourceBlocks, observations),
    // Do not copy raw_payload into this internal snapshot.  The draft builder
    // only needs the explicitly mapped source blocks and descriptions, which
    // also keeps accidental browser serialization from exposing raw evidence.
  };
}

function collectSourceBlocksBySource(
  row: AdminInformationAgentSaleRow,
  primaryBlocks: Record<string, unknown> | null,
  observations: unknown[],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const sourceName = nullableString(row.source_name) || "source";
  if (primaryBlocks) result[`${sourceName}:primary`] = primaryBlocks;

  observations.forEach((value, index) => {
    const observation = asRecord(value);
    const blocks = asRecordOrNull(asRecord(observation.raw_payload).source_blocks);
    if (!blocks) return;
    const observationSource = nullableString(observation.source_name) || "source";
    result[`${observationSource}:${index + 1}`] = blocks;
  });
  return result;
}

function collectSaleMedia(row: AdminInformationAgentSaleRow): SaleMedia[] {
  const rawPayload = asRecord(row.raw_payload);
  const observations = asArray(row.observations);
  const media: SaleMedia[] = [];
  const seen = new Set<string>();

  const add = (value: unknown, source: string | null) => {
    const url = typeof value === "string" ? value.trim() : "";
    if (!isUsableImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    media.push({ type: "image", url, source });
  };

  add(rawPayload.raw_image_url, nullableString(row.source_name));
  for (const value of asArray(rawPayload.source_images)) {
    add(value, nullableString(row.source_name));
  }

  for (const value of observations) {
    const observation = asRecord(value);
    const observationPayload = asRecord(observation.raw_payload);
    const source = nullableString(observation.source_name) || nullableString(row.source_name);
    add(observationPayload.raw_image_url, source);
    for (const image of asArray(observationPayload.source_images)) add(image, source);
  }

  return media;
}

function isUsableImageUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  if (/\.(?:pdf|docx?|svg)(?:[?#].*)?$/i.test(value)) return false;
  return !/(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)/i.test(
    value,
  );
}

function toDocument(row: AuctionDocumentRow): SaleDocumentRich | null {
  const url = nullableString(row.document_url);
  if (!url) return null;
  return {
    url,
    label: nullableString(row.label),
    type: nullableString(row.document_type),
    document_type: nullableString(row.document_type),
    extraction_status: nullableString(row.extraction_status),
    download_status: nullableString(row.download_status),
    docling_status: nullableString(row.docling_status),
    text_chars: numberValue(row.text_chars),
  };
}

function sourceChecks(value: unknown): AuctionSale["source_checks"] {
  const input = asRecord(value);
  const output: NonNullable<AuctionSale["source_checks"]> = {};
  for (const [key, raw] of Object.entries(input)) {
    const check = asRecord(raw);
    output[key] = { checked_at: nullableString(check.checked_at) ?? undefined };
  }
  return Object.keys(output).length ? output : null;
}

function sourceConflicts(value: unknown): AuctionSale["source_conflicts"] {
  if (!Array.isArray(value)) return null;
  const conflicts = value
    .map((raw) => {
      const conflict = asRecord(raw);
      return {
        field: nullableString(conflict.field) ?? undefined,
        selected: nullableString(conflict.selected) ?? undefined,
        alternative: nullableString(conflict.alternative) ?? undefined,
        selected_source: nullableString(conflict.selected_source) ?? undefined,
        alternative_source: nullableString(conflict.alternative_source) ?? undefined,
      };
    })
    .filter((conflict) => Object.values(conflict).some((value) => value !== undefined));
  return conflicts.length ? conflicts : null;
}

function sourcePresenceRows(value: unknown): AuctionSale["source_presence"] {
  if (!Array.isArray(value)) return null;
  const output: NonNullable<AuctionSale["source_presence"]> = {};
  for (const raw of value) {
    const presence = asRecord(raw);
    const key = nullableString(presence.source_name);
    if (!key) continue;
    const normalized = {
      ...asRecord(presence.extras),
    } as NonNullable<AuctionSale["source_presence"]>[string];
    const state = nullableString(presence.state);
    const availability = nullableString(presence.availability);
    const attemptedAt = nullableString(presence.attempted_at);
    const checkedAt = nullableString(presence.checked_at);
    const runId = nullableString(presence.run_id);
    if (state) normalized.state = state;
    if (availability) normalized.availability = availability;
    if (attemptedAt) normalized.attempted_at = attemptedAt;
    if (checkedAt) normalized.checked_at = checkedAt;
    if (runId) normalized.run_id = runId;
    output[key] = normalized;
  }
  return Object.keys(output).length ? output : null;
}

function sourcePresenceObject(value: unknown): AuctionSale["source_presence"] {
  const input = asRecord(value);
  const rows = Object.entries(input).map(([source_name, raw]) => ({
    source_name,
    ...asRecord(raw),
  }));
  return sourcePresenceRows(rows);
}

function asSaleRow(value: unknown): AdminInformationAgentSaleRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AdminInformationAgentSaleRow;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const result = asRecord(value);
  return Object.keys(result).length ? result : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

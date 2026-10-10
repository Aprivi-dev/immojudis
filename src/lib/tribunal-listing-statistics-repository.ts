import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildSaleValuationInput,
  marketContextFromStoredRow,
  saleValuationFingerprint,
} from "@/lib/sale-market-estimates";
import { isPublicationQuarantinedMarker } from "@/lib/sale-publication-guard";
import { extractTribunalListingEvidence } from "@/lib/tribunal-listing-evidence";
import { resolveCourtCodeFromSale } from "@/lib/tribunal-judicial-activity-repository";
import { TribunalCourtUnresolvedError } from "@/lib/tribunal-judicial-activity";
import {
  buildTribunalListingStatistics,
  type TribunalListingStatisticsMarketEstimate,
  type TribunalListingStatisticsQuery,
  type TribunalListingStatisticsResponse,
} from "@/lib/tribunal-listing-statistics";
import { asRecordOrNull } from "@/lib/guards";
import {
  normalizeLabel,
  normalizeLegalReference,
  positive,
  type StoredListingSale,
} from "@/lib/tribunal-listing-statistics/shared";
import {
  deduplicateListingSales,
  sourceFamily,
} from "@/lib/tribunal-listing-statistics/deduplication";

export { deduplicateTribunalListingSales } from "@/lib/tribunal-listing-statistics/deduplication";

const PAGE_SIZE = 1_000;
const MAX_SALES_PER_COURT = 5_000;
const MAX_NATIONAL_NULL_CODE_SCAN = 25_000;

const SALE_COLUMNS = [
  "id",
  "source_name",
  "source_url",
  "source_urls",
  "external_id",
  "content_hash",
  "tribunal",
  "tribunal_code",
  "sale_venue_type",
  "sale_verification_status",
  "status",
  "sale_date",
  "starting_price_eur",
  "property_type",
  "visit_dates",
  "occupancy_status",
  "city",
  "address",
  "postal_code",
  "lawyer_name",
  "title",
  "first_seen_at",
  "raw_payload",
  "latitude",
  "longitude",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "rooms_count",
  "bedrooms_count",
  "updated_at",
  "publication_quarantine:raw_payload->>publication_quarantine",
].join(",");
const SALE_SCAN_COLUMNS = [
  "id",
  "tribunal",
  "tribunal_code",
  "sale_venue_type",
  "sale_verification_status",
  "status",
  "first_seen_at",
  "publication_quarantine:raw_payload->>publication_quarantine",
].join(",");
const MARKET_ESTIMATE_CHUNK_SIZE = 500;

const numericSchema = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .transform(Number),
]);

const storedCourtSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    judicial_region: z.string().min(1).nullable(),
  })
  .strict();

const storedTribunalReferenceSchema = z
  .object({
    code: z.string().min(1),
    canonical_name: z.string().min(1),
    aliases: z.unknown().optional().nullable(),
  })
  .passthrough();

const storedOfficialCourtReferenceSchema = z
  .object({
    court_code: z.string().min(1),
    official_name: z.string().min(1),
  })
  .passthrough();

const storedSaleSchema = z
  .object({
    id: z.string().min(1),
    source_name: z.string().min(1).nullable().optional(),
    source_url: z.string().min(1).nullable().optional(),
    source_urls: z.unknown().nullable().optional(),
    external_id: z.string().nullable().optional(),
    content_hash: z.string().nullable().optional(),
    tribunal: z.string().nullable().optional(),
    tribunal_code: z.string().nullable().optional(),
    sale_venue_type: z.string().min(1).nullable().optional(),
    sale_verification_status: z.string().min(1).nullable().optional(),
    status: z.string().nullable().optional(),
    sale_date: z.string().nullable().optional(),
    starting_price_eur: numericSchema.nullable().optional(),
    property_type: z.string().nullable().optional(),
    visit_dates: z.unknown().nullable().optional(),
    occupancy_status: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    postal_code: z.string().nullable().optional(),
    lawyer_name: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    first_seen_at: z.string().nullable().optional(),
    raw_payload: z.unknown().nullable().optional(),
    latitude: numericSchema.nullable().optional(),
    longitude: numericSchema.nullable().optional(),
    app_surface_m2: numericSchema.nullable().optional(),
    habitable_surface_m2: numericSchema.nullable().optional(),
    carrez_surface_m2: numericSchema.nullable().optional(),
    land_surface_m2: numericSchema.nullable().optional(),
    app_surface_kind: z.string().nullable().optional(),
    surface_scope: z.string().nullable().optional(),
    rooms_count: z.number().int().nullable().optional(),
    bedrooms_count: z.number().int().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    publication_quarantine: z.string().nullable().optional(),
  })
  .passthrough();

const storedSaleScanSchema = z
  .object({
    id: z.string().min(1),
    tribunal: z.string().nullable().optional(),
    tribunal_code: z.string().nullable().optional(),
    sale_venue_type: z.string().min(1).nullable().optional(),
    sale_verification_status: z.string().min(1).nullable().optional(),
    status: z.string().nullable().optional(),
    first_seen_at: z.string().nullable().optional(),
    publication_quarantine: z.string().nullable().optional(),
  })
  .passthrough();

const storedSaleCourtLookupSchema = z
  .object({
    tribunal_code: z.string().min(1).nullable().optional(),
    tribunal: z.string().min(1).nullable().optional(),
    sale_venue_type: z.string().min(1).nullable().optional(),
    sale_verification_status: z.string().min(1).nullable().optional(),
    status: z.string().nullable().optional(),
    publication_quarantine: z.string().nullable().optional(),
  })
  .passthrough();

const storedEstimateSchema = z
  .object({
    auction_sale_id: z.string().min(1),
    estimate: z.unknown().nullable().optional(),
    status: z.string().nullable().optional(),
    computed_at: z.string().nullable().optional(),
    source_updated_at: z.string().nullable().optional(),
    input_fingerprint: z.string().nullable().optional(),
    actionable: z.boolean().optional(),
    next_refresh_at: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
  })
  .passthrough();

export class TribunalListingStatisticsUnavailableError extends Error {
  constructor(
    message = "Les statistiques d’annonces du tribunal sont temporairement indisponibles.",
  ) {
    super(message);
    this.name = "TribunalListingStatisticsUnavailableError";
  }
}

export async function getTribunalListingStatistics(
  input: TribunalListingStatisticsQuery,
  options: { asOf?: Date; generatedAt?: Date } = {},
): Promise<TribunalListingStatisticsResponse> {
  const asOf = options.asOf ?? new Date();
  const courtCode = input.courtCode ?? (await resolveListingSaleCourtCode(input.saleId!));
  const court = await fetchCourt(courtCode);
  const aliases = await fetchCourtAliases(court);
  const loaded = await loadEligibleSales(court.code, aliases);
  // Resolve estimates before cross-source merging. A source row that loses the
  // deterministic winner can still carry the only fresh actionable DVF result.
  const marketEstimates = await loadMarketEstimates(loaded.rows);
  const rowsWithEstimates = loaded.rows.map((sale) => ({
    ...sale,
    marketEstimate: marketEstimates.get(sale.id) ?? null,
    marketEstimateEligible: marketEstimates.has(sale.id),
  }));
  const deduplicated = deduplicateListingSales(rowsWithEstimates);
  const sales = deduplicated.sales;

  return buildTribunalListingStatistics({
    court: {
      code: court.code,
      name: court.name,
      judicialRegion: court.judicial_region,
    },
    sales,
    asOf,
    historyMonths: input.historyMonths,
    generatedAt: options.generatedAt,
    rawAnnouncements: loaded.rawAnnouncements,
    unresolvedStrongAddressDuplicates: deduplicated.unresolvedStrongAddressDuplicates,
  });
}

async function resolveListingSaleCourtCode(saleId: string): Promise<string> {
  try {
    return await resolveCourtCodeFromSale(saleId);
  } catch (error) {
    // The historical resolver intentionally keeps a narrow canonical-name
    // lookup for its existing API. The listing endpoint also accepts source
    // labels such as “Tribunal judiciaire de Saint-Etienne”; retry only its
    // unresolved-court branch through the bounded official alias registry.
    if (!(error instanceof TribunalCourtUnresolvedError)) throw error;
  }

  const saleResult = await supabaseAdmin
    .from("auction_sales")
    .select(
      "tribunal_code,tribunal,sale_venue_type,sale_verification_status,status,publication_quarantine:raw_payload->>publication_quarantine",
    )
    .eq("id", saleId)
    .limit(1)
    .maybeSingle();
  if (saleResult.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Annonce judiciaire indisponible : ${saleResult.error.message}`,
    );
  }
  if (!saleResult.data) {
    throw new TribunalCourtUnresolvedError("Aucune annonce judiciaire disponible.");
  }
  const sale = storedSaleCourtLookupSchema.parse(saleResult.data);
  if (
    sale.sale_venue_type !== "tribunal" ||
    !["verified", "cross_checked"].includes(sale.sale_verification_status ?? "") ||
    !["upcoming", "past", "adjudicated"].includes(sale.status ?? "") ||
    isPublicationQuarantinedMarker(sale.publication_quarantine, sale.status) ||
    !sale.tribunal?.trim()
  ) {
    throw new TribunalCourtUnresolvedError(
      "L’annonce ne porte pas une affectation judiciaire officielle exploitable.",
    );
  }

  const [referenceResult, officialResult] = await Promise.all([
    supabaseAdmin
      .from("tribunals")
      .select("code,canonical_name,aliases")
      .order("code", { ascending: true })
      .range(0, 250),
    supabaseAdmin
      .from("outcome_court_official_references")
      .select("court_code,official_name")
      .order("observed_on", { ascending: false })
      .range(0, 250),
  ]);
  if (referenceResult.error || officialResult.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Répertoire des alias judiciaires indisponible : ${(referenceResult.error ?? officialResult.error)?.message}`,
    );
  }
  const references = z.array(storedTribunalReferenceSchema).parse(referenceResult.data ?? []);
  const officialReferences = z
    .array(storedOfficialCourtReferenceSchema)
    .parse(officialResult.data ?? []);
  if (references.length > 250) {
    throw new TribunalListingStatisticsUnavailableError(
      "Le répertoire borné des alias judiciaires dépasse 250 tribunaux.",
    );
  }
  const matches = references.filter((reference) =>
    matchesOfficialCourt(
      sale.tribunal,
      new Set([reference.canonical_name, ...aliasesFromJson(reference.aliases)]),
    ),
  );
  const officialMatches = officialReferences.filter((reference) =>
    matchesOfficialCourt(sale.tribunal, new Set([reference.official_name])),
  );
  const codes = [
    ...new Set([
      ...matches.map((reference) => normalizeCourtCode(reference.code)),
      ...officialMatches.map((reference) => normalizeCourtCode(reference.court_code)),
    ]),
  ];
  if (codes.length !== 1) {
    throw new TribunalCourtUnresolvedError(
      codes.length
        ? "Plusieurs tribunaux officiels correspondent à l’annonce."
        : "Aucun tribunal officiel ne correspond exactement à l’annonce.",
    );
  }
  return codes[0]!;
}

async function fetchCourt(courtCode: string) {
  const normalizedCode = normalizeCourtCode(courtCode);
  const result = await supabaseAdmin
    .from("outcome_courts")
    .select("code,name,judicial_region")
    .eq("code", normalizedCode)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (result.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Référence tribunal indisponible : ${result.error.message}`,
    );
  }
  if (result.data) return storedCourtSchema.parse(result.data);

  // Older auction rows may carry a legacy code such as `tj-bordeaux`, while
  // outcome_courts stores the canonical justice code. Resolve this only
  // through an exact legacy tribunal reference or a prefix-bearing tribunal
  // code; a bare city name must never become a geographic guess.
  const legacyResult = await supabaseAdmin
    .from("tribunals")
    .select("code,canonical_name,aliases")
    .eq("code", normalizedCode)
    .limit(1)
    .maybeSingle();
  if (legacyResult.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Référence legacy du tribunal indisponible : ${legacyResult.error.message}`,
    );
  }

  const legacyAliases = legacyResult.data
    ? (() => {
        const reference = storedTribunalReferenceSchema.parse(legacyResult.data);
        return [reference.canonical_name, ...aliasesFromJson(reference.aliases)];
      })()
    : [];
  const codeLabel = legacyAliases.length ? null : legacyCourtLabelFromCode(normalizedCode);
  if (!legacyAliases.length && !codeLabel) {
    throw new TribunalCourtUnresolvedError(
      "Aucun tribunal officiel actif ne correspond à ce code.",
    );
  }

  const courtsResult = await supabaseAdmin
    .from("outcome_courts")
    .select("code,name,judicial_region")
    .eq("active", true)
    .order("code", { ascending: true })
    .range(0, 250);
  if (courtsResult.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Répertoire officiel des tribunaux indisponible : ${courtsResult.error.message}`,
    );
  }
  const courts = z.array(storedCourtSchema).parse(courtsResult.data ?? []);
  const candidates = courts.filter((candidate) =>
    (legacyAliases.length ? legacyAliases : [codeLabel!]).some((label) =>
      matchesOfficialCourt(candidate.name, new Set([label])),
    ),
  );
  if (candidates.length === 1) return candidates[0]!;
  throw new TribunalCourtUnresolvedError(
    candidates.length
      ? "Plusieurs tribunaux officiels correspondent à ce code legacy."
      : "Aucun tribunal officiel actif ne correspond à ce code.",
  );
}

function legacyCourtLabelFromCode(code: string): string | null {
  const normalized = normalizeLabel(code);
  const match = /^(?:tj|tribunal)\s+(.+)$/.exec(normalized);
  if (!match?.[1]) return null;
  return `TJ ${match[1]}`;
}

async function fetchCourtAliases(court: z.infer<typeof storedCourtSchema>): Promise<Set<string>> {
  const [legacyResult, officialResult] = await Promise.all([
    supabaseAdmin
      .from("tribunals")
      .select("code,canonical_name,aliases")
      .eq("code", court.code)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("outcome_court_official_references")
      .select("court_code,official_name")
      .eq("court_code", court.code)
      .order("observed_on", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (legacyResult.error || officialResult.error) {
    throw new TribunalListingStatisticsUnavailableError(
      `Alias officiel du tribunal indisponible : ${(legacyResult.error ?? officialResult.error)?.message}`,
    );
  }
  const values = new Set<string>([court.name]);
  if (legacyResult.data) {
    const reference = storedTribunalReferenceSchema.parse(legacyResult.data);
    values.add(reference.canonical_name);
    for (const alias of aliasesFromJson(reference.aliases)) values.add(alias);
  }
  if (officialResult.data) {
    const reference = storedOfficialCourtReferenceSchema.parse(officialResult.data);
    values.add(reference.official_name);
  }
  return values;
}

async function loadEligibleSales(
  courtCode: string,
  officialAliases: Set<string>,
): Promise<{ rows: StoredListingSale[]; rawAnnouncements: number }> {
  const [directRows, unresolvedRows] = await Promise.all([
    loadPagedRows({ courtCode, maxRows: MAX_SALES_PER_COURT }),
    loadNullCodeRows({ officialAliases, maxRows: MAX_NATIONAL_NULL_CODE_SCAN }),
  ]);
  const rows = [...directRows, ...unresolvedRows];
  const byId = new Map<string, StoredListingSale>();
  for (const row of rows) byId.set(row.id, row);
  return { rows: [...byId.values()], rawAnnouncements: byId.size };
}

async function loadPagedRows(input: {
  courtCode: string;
  maxRows: number;
}): Promise<StoredListingSale[]> {
  const rows: StoredListingSale[] = [];
  for (let offset = 0; offset < input.maxRows; offset += PAGE_SIZE) {
    let query = supabaseAdmin
      .from("auction_sales")
      .select(SALE_COLUMNS)
      .eq("sale_venue_type", "tribunal")
      .in("sale_verification_status", ["verified", "cross_checked"])
      .in("status", ["upcoming", "past", "adjudicated"]);
    query = query.eq("tribunal_code", input.courtCode);
    const result = await query
      .order("first_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) {
      throw new TribunalListingStatisticsUnavailableError(
        `Annonces judiciaires indisponibles : ${result.error.message}`,
      );
    }
    const page = z.array(storedSaleSchema).parse(result.data ?? []);
    for (const row of page) {
      if (isPublicationQuarantinedMarker(row.publication_quarantine, row.status)) continue;
      const mapped = mapStoredSale(row);
      if (mapped) rows.push(mapped);
    }
    if (page.length < PAGE_SIZE) return rows;
    if (offset + page.length >= input.maxRows) {
      throw new TribunalListingStatisticsUnavailableError(
        "Le scan du tribunal dépasse 5 000 annonces.",
      );
    }
  }
  throw new TribunalListingStatisticsUnavailableError(
    "Le scan borné des annonces a dépassé sa limite.",
  );
}

async function loadNullCodeRows(input: {
  officialAliases: Set<string>;
  maxRows: number;
}): Promise<StoredListingSale[]> {
  const matchingIds: string[] = [];
  for (let offset = 0; offset < input.maxRows; offset += PAGE_SIZE) {
    const result = await supabaseAdmin
      .from("auction_sales")
      .select(SALE_SCAN_COLUMNS)
      .is("tribunal_code", null)
      .eq("sale_venue_type", "tribunal")
      .in("sale_verification_status", ["verified", "cross_checked"])
      .in("status", ["upcoming", "past", "adjudicated"])
      .order("first_seen_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) {
      throw new TribunalListingStatisticsUnavailableError(
        `Scan national des tribunaux indisponible : ${result.error.message}`,
      );
    }
    const page = z.array(storedSaleScanSchema).parse(result.data ?? []);
    for (const row of page) {
      if (isPublicationQuarantinedMarker(row.publication_quarantine, row.status)) continue;
      if (matchesOfficialCourt(row.tribunal, input.officialAliases)) matchingIds.push(row.id);
    }
    if (page.length < PAGE_SIZE) break;
    if (offset + page.length >= input.maxRows) {
      throw new TribunalListingStatisticsUnavailableError(
        "Le scan national borné dépasse 25 000 annonces.",
      );
    }
  }

  const rows: StoredListingSale[] = [];
  for (let offset = 0; offset < matchingIds.length; offset += MARKET_ESTIMATE_CHUNK_SIZE) {
    const ids = matchingIds.slice(offset, offset + MARKET_ESTIMATE_CHUNK_SIZE);
    const result = await supabaseAdmin.from("auction_sales").select(SALE_COLUMNS).in("id", ids);
    if (result.error) {
      throw new TribunalListingStatisticsUnavailableError(
        `Détails des annonces sans code tribunal indisponibles : ${result.error.message}`,
      );
    }
    const page = z.array(storedSaleSchema).parse(result.data ?? []);
    for (const row of page) {
      if (isPublicationQuarantinedMarker(row.publication_quarantine, row.status)) continue;
      const mapped = mapStoredSale(row);
      if (mapped) rows.push(mapped);
    }
  }
  return rows;
}

function mapStoredSale(row: z.infer<typeof storedSaleSchema>): StoredListingSale | null {
  const sourceUrl = row.source_url ?? null;
  const sourceUrls = parseStringArray(row.source_urls);
  if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.push(sourceUrl);
  const raw = row.raw_payload;
  const sourceName = row.source_name?.trim() || null;
  const evidence = extractTribunalListingEvidence(raw, sourceName);
  if (evidence.procedureConflict) return null;
  // The source evidence extractor is the sole authority for publication
  // dates. Internal `published_at`/collection timestamps are deliberately
  // excluded; when no source label is trusted, the builder uses first_seen_at
  // and reports it under discoveryDatesUsed.
  const publicationAt = evidence.publicationAt;
  const overbidStatus = evidence.overbidStatus ?? extractExplicitOverbidStatus(raw);
  const overbidEvidence = [...evidence.overbidEvidence, row.title].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    id: row.id,
    tribunal: row.tribunal ?? null,
    title: row.title ?? null,
    city: row.city ?? null,
    address: row.address ?? null,
    sourceName,
    sourceNames: sourceName ? [sourceName] : [],
    sourceUrls,
    saleDate: row.sale_date ?? null,
    status: row.status ?? null,
    startingPriceEur: row.starting_price_eur ?? null,
    propertyType: row.property_type ?? null,
    visitDates: row.visit_dates ?? [],
    occupancyStatus: row.occupancy_status ?? null,
    lawyerName: row.lawyer_name ?? null,
    publicationAt,
    firstSeenAt: row.first_seen_at ?? null,
    overbidStatus,
    overbidEvidence,
    sourceUrl,
    externalId: row.external_id ?? null,
    contentHash: row.content_hash ?? null,
    identityAddress: extractTribunalIdentityAddress(raw, sourceName),
    legalReference: extractTribunalLegalReference(raw, sourceName),
    lotNumber: extractLotNumber(raw),
    valuationSource: {
      id: row.id,
      address: row.address ?? null,
      city: row.city ?? null,
      postal_code: row.postal_code ?? null,
      property_type: row.property_type ?? null,
      latitude: row.latitude ?? null,
      longitude: row.longitude ?? null,
      app_surface_m2: row.app_surface_m2 ?? null,
      habitable_surface_m2: row.habitable_surface_m2 ?? null,
      carrez_surface_m2: row.carrez_surface_m2 ?? null,
      land_surface_m2: row.land_surface_m2 ?? null,
      app_surface_kind: row.app_surface_kind ?? null,
      surface_scope: row.surface_scope ?? null,
      rooms_count: row.rooms_count ?? null,
      bedrooms_count: row.bedrooms_count ?? null,
      updated_at: row.updated_at ?? new Date(0).toISOString(),
    },
  };
}

function matchesOfficialCourt(label: string | null | undefined, aliases: Set<string>): boolean {
  if (!label?.trim()) return false;
  const raw = normalizeLabel(label);
  const prefixed = hasCourtPrefix(raw);
  for (const alias of aliases) {
    const aliasRaw = normalizeLabel(alias);
    // Exact official source labels are accepted. A prefix-stripped match is
    // accepted only when the source itself names a TJ/tribunal, never from a
    // bare city string that would turn this into a geographic guess.
    if (raw === aliasRaw) return true;
    if (prefixed && stripCourtPrefix(raw) === stripCourtPrefix(aliasRaw)) return true;
  }
  return false;
}

export function courtAliasMatchesOfficialName(label: string, aliases: string[]): boolean {
  return matchesOfficialCourt(label, new Set(aliases));
}

function normalizeCourtCode(value: string): string {
  return value.trim().toLocaleLowerCase("fr-FR");
}

function hasCourtPrefix(value: string): boolean {
  return /^(?:tj|tribunal)\b/.test(value);
}

function stripCourtPrefix(value: string): string {
  return value
    .replace(/^(?:tj|tribunal\s+judiciaire|tribunal\s+de\s+grande\s+instance)\s+/, "")
    .replace(/^(?:de|du|des|d)\s+/, "")
    .trim();
}

function aliasesFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function extractExplicitOverbidStatus(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["surenchere_status", "surenchereStatus", "overbid_status", "overbidStatus"]) {
    if (typeof record[key] === "string" || typeof record[key] === "boolean") return record[key];
  }
  for (const containerKey of ["auction_outcome", "outcome", "outcome_graph"]) {
    const container = record[containerKey];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const nested = extractExplicitOverbidStatus(container);
    if (nested != null) return nested;
  }
  for (const eventsKey of ["events", "auction_events", "outcome_events"]) {
    const events = record[eventsKey];
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const eventRecord = event as Record<string, unknown>;
      const eventType = eventRecord.event_type ?? eventRecord.eventType ?? eventRecord.type;
      if (typeof eventType !== "string") continue;
      const normalized = eventType.trim().toLocaleLowerCase("fr-FR");
      if (normalized.includes("surenchere_filed") || normalized.includes("surenchere-filed")) {
        return "filed";
      }
      if (
        normalized.includes("surenchere_not_filed") ||
        normalized.includes("surenchere-not-filed") ||
        normalized.includes("deadline_expired")
      ) {
        return "not_filed";
      }
    }
  }
  return null;
}

/**
 * Return an address used only for cross-source identity. The displayed sale
 * address remains the persisted `address` column; this parser reads only
 * source-attributed blocks with a numbered street and deliberately ignores
 * generic page text, prices, commune-only labels and lawyer/footer content.
 */
export function extractTribunalIdentityAddress(
  raw: unknown,
  sourceName: string | null,
): string | null {
  const record = asRecordOrNull(raw);
  if (!record) return null;
  const source = sourceFamily(sourceName);
  const blocks = sourceBlocksForIdentity(record, source);

  if (source === "licitor") {
    return firstValidIdentityAddress(blocks.map((block) => textValue(block.adresse)));
  }

  if (source === "vench") {
    const pageText = firstTextValue(blocks, "page_text");
    const labelled = pageText ? extractAddressAfterLabel(pageText, /adresse|localisation/i) : null;
    if (labelled) return labelled;
    const descriptions = [
      ...blocks.map((block) => textValue(block.description)),
      textValue(record.source_description),
    ];
    return firstValidIdentityAddress(descriptions.map((value) => extractLocatedAddress(value)));
  }

  if (source === "encheresimmobilieres") {
    const pageText = firstTextValue(blocks, "page_text");
    const labelled = pageText ? extractAddressAfterLabel(pageText, /adresse\s+du\s+bien/i) : null;
    if (labelled) return labelled;
    const descriptions = [
      textValue(record.source_description),
      ...blocks.map((block) => textValue(block.description)),
    ];
    return firstValidIdentityAddress(descriptions.map((value) => extractLocatedAddress(value)));
  }

  return null;
}

/**
 * Extract the court/legal reference only when the source attributes it to an
 * explicit PA `Ref.` or Enchères Immobilières `RG` label. Source listing ids,
 * prices and unlabelled numbers are deliberately not references.
 */
export function extractTribunalLegalReference(
  raw: unknown,
  sourceName: string | null,
): string | null {
  const record = asRecordOrNull(raw);
  if (!record) return null;
  const source = sourceFamily(sourceName);
  if (source !== "petitesaffiches" && source !== "encheresimmobilieres") return null;

  const blocks = sourceBlocksForIdentity(record, source);
  const structuredKeys = source === "petitesaffiches" ? ["reference", "ref"] : ["rg", "reference"];
  for (const block of blocks) {
    for (const key of structuredKeys) {
      const reference = normalizeLegalReference(textValue(block[key]));
      if (reference) return reference;
    }
  }

  const texts = [
    ...blocks.flatMap((block) =>
      ["page_text", "raw_text", "description"].map((key) => textValue(block[key])),
    ),
    ...["source_description", "description", "raw_text"].map((key) => textValue(record[key])),
  ].filter((value): value is string => value != null);
  const pattern =
    source === "petitesaffiches"
      ? /\b(?:r[ée]f(?:[ée]rence)?|reference)\s*\.?\s*(?:n[°ºo]?\.?\s*)?[:#-]?\s*(\d{1,4}\s*\/\s*\d{1,8})\b/iu
      : /\b(?:n[°ºo]?\.?\s*)?(?:r\.?\s*g\.?)\s*(?:n[°ºo]?\.?\s*)?[:#-]?\s*(\d{1,4}\s*\/\s*\d{1,8})\b/iu;
  for (const text of texts) {
    const match = pattern.exec(text);
    if (!match) continue;
    const reference = normalizeLegalReference(match[1] ?? null);
    if (reference) return reference;
  }
  return null;
}

function sourceBlocksForIdentity(
  record: Record<string, unknown>,
  source: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const direct = asRecordOrNull(record.source_blocks);
  if (direct) blocks.push(direct);
  const bySource = asRecordOrNull(record.source_blocks_by_source);
  if (bySource) {
    for (const [key, value] of Object.entries(bySource)) {
      if (sourceFamily(key) !== source) continue;
      const scoped = asRecordOrNull(value);
      if (scoped) blocks.push(scoped);
    }
  }
  return blocks;
}

function firstTextValue(blocks: Array<Record<string, unknown>>, key: string): string | null {
  for (const block of blocks) {
    const value = textValue(block[key]);
    if (value) return value;
  }
  return null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstValidIdentityAddress(values: Array<string | null>): string | null {
  for (const value of values) {
    const address = validIdentityAddress(value);
    if (address) return address;
  }
  return null;
}

function extractAddressAfterLabel(text: string, label: RegExp): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const normalizedLine = normalizeLabel(line);
    if (
      label.source.includes("adresse|localisation") &&
      /^adresse\s+(?:de|du|des|a|au|aux|l)\b/.test(normalizedLine) &&
      !/^adresse\s+du\s+bien\b/.test(normalizedLine)
    ) {
      continue;
    }
    const match = label.exec(line);
    label.lastIndex = 0;
    if (!match) continue;
    const tail = line.slice(match.index + match[0].length).replace(/^\s*:\s*/, "");
    const following: string[] = [];
    for (const nextLine of lines.slice(index + 1, index + 4)) {
      if (
        /^(?:avocat|cabinet|contact|tel(?:ephone)?|documents?|mise\s+a\s+prix|date\s+de)\b/i.test(
          nextLine,
        )
      ) {
        break;
      }
      following.push(nextLine);
    }
    for (const candidate of [tail, ...following].filter(Boolean)) {
      const address = validIdentityAddress(candidate);
      if (address) return address;
    }
  }
  return null;
}

function extractLocatedAddress(value: string | null): string | null {
  if (!value) return null;
  // A location phrase is required for description fallbacks so a lawyer
  // footer containing a numbered office address cannot become an asset key.
  const situated =
    /\b(?:situ[ée]e?|sis|sise|se\s+trouvant)\s*:?[\s-]*(\d{1,5}\s*(?:bis|ter|quater)?\s*,?\s*(?:rue|avenue|av\.?|boulevard|bd\.?|chemin|route|place|impasse|allee|all[ée]e|cours|quai|faubourg|voie|sentier|passage)\b[^;\n]*)/i.exec(
      value,
    );
  if (situated) return validIdentityAddress(situated[1] ?? null);
  const municipality =
    /(?:^|[.;]\s*)(?:à|a)\s+[^,\n]+(?:\s*\(\d{2,3}\))?\s*,\s*(\d{1,5}\s*(?:bis|ter|quater)?\s*,?\s*(?:rue|avenue|av\.?|boulevard|bd\.?|chemin|route|place|impasse|allee|all[ée]e|cours|quai|faubourg|voie|sentier|passage)\b[^;\n]*)/i.exec(
      value,
    );
  return validIdentityAddress(municipality?.[1] ?? null);
}

function validIdentityAddress(value: string | null): string | null {
  if (!value || /\b\d[\d\s.,]*\s*€\b/i.test(value)) return null;
  const match =
    /\b(\d{1,5}\s*(?:bis|ter|quater)?\s*,?\s*(?:rue|avenue|av\.?|boulevard|bd\.?|chemin|route|place|impasse|allee|all[ée]e|cours|quai|faubourg|voie|sentier|passage)\b[^;\n]*)/i.exec(
      value,
    );
  if (!match) return null;
  let address = match[1]!.replace(/\s+/g, " ").trim();
  address = address
    .split(/\s*,?\s*\d{5}\b/i)[0]!
    .split(
      /\s*,?\s*(?:cadastr[ée]?(?:\s+section)?|comprenant|r[ée]f[ée]rences?\s+(?:du\s+)?greffe)\b/i,
    )[0]!
    .split(/\s+(?:avocat|cabinet|contact|tel(?:ephone)?|documents?)\b/i)[0]!
    .replace(/[\s,;:.]+$/, "")
    .trim();
  if (!/\b[a-zà-ÿ]{2,}\b/i.test(address) || /\b(?:mise\s+a\s+prix|prix)\b/i.test(address)) {
    return null;
  }
  return address;
}

function extractLotNumber(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of ["source_lots", "sourceLots"]) {
    const values = record[key];
    if (Array.isArray(values)) {
      const signatures = values
        .map((value) => sourceLotSignature(value))
        .filter((value): value is string => value != null);
      const unique = [...new Set(signatures)].sort((left, right) => left.localeCompare(right));
      if (unique.length > 1) return `multi:${unique.join("||")}`;
      if (unique.length === 1 && typeof values[0] === "string") return unique[0]!;
    }
  }
  for (const key of ["lot_number", "lotNumber", "lot_id", "lotId", "source_lot", "sourceLot"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLocaleLowerCase("fr-FR");
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sourceLotSignature(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return normalizeLabel(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parts = [
    firstText(record, ["lot_number", "lotNumber", "lot_id", "lotId"]),
    firstText(record, [
      "starting_price_eur",
      "startingPriceEur",
      "starting_price",
      "startingPrice",
    ]),
    firstText(record, ["address", "lot_address", "lotAddress"]),
    firstText(record, ["title", "lot_title", "lotTitle"]),
  ]
    .filter((value): value is string => value != null && value.trim().length > 0)
    .map((value) => normalizeLabel(value));
  return parts.length ? parts.join("|") : null;
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

async function loadMarketEstimates(
  sales: StoredListingSale[],
): Promise<Map<string, TribunalListingStatisticsMarketEstimate>> {
  const map = new Map<string, TribunalListingStatisticsMarketEstimate>();
  if (!sales.length) return map;
  for (let offset = 0; offset < sales.length; offset += MARKET_ESTIMATE_CHUNK_SIZE) {
    const chunk = sales.slice(offset, offset + MARKET_ESTIMATE_CHUNK_SIZE);
    const result = await supabaseAdmin
      .from("auction_sale_market_estimates")
      .select("*")
      .in(
        "auction_sale_id",
        chunk.map((sale) => sale.id),
      );
    if (result.error) {
      throw new TribunalListingStatisticsUnavailableError(
        `Estimations DVF indisponibles : ${result.error.message}`,
      );
    }
    const rows = z.array(storedEstimateSchema).parse(result.data ?? []);
    const byId = new Map(rows.map((row) => [row.auction_sale_id, row]));
    for (const sale of chunk) {
      const row = byId.get(sale.id);
      if (!row) continue;
      const source = saleValuationSource(sale);
      const input = buildSaleValuationInput(
        source as Parameters<typeof buildSaleValuationInput>[0],
      );
      const context = marketContextFromStoredRow(
        row as Parameters<typeof marketContextFromStoredRow>[0],
        saleValuationFingerprint(input),
      );
      // A pending/processing row may still expose its previous estimate via
      // the shared market-context helper. Do not publish that stale value in
      // tribunal ratios; this endpoint has no explicit refreshing opt-in.
      if (row.status !== "ready") continue;
      const estimate = context.estimate;
      if (!estimate || estimate.actionable !== true || !positive(estimate.estimatedValueEur))
        continue;
      if (!/^dvf(?:\s|$)/i.test(estimate.source.trim())) continue;
      map.set(sale.id, {
        source: estimate.source,
        estimatedValueEur: estimate.estimatedValueEur,
        actionable: true,
        sampleSize: estimate.sampleSize,
      });
    }
  }
  return map;
}

function saleValuationSource(sale: StoredListingSale): Record<string, unknown> {
  return sale.valuationSource;
}

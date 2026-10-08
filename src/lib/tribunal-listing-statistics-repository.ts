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
  normalizeOccupationStatus,
  type TribunalListingStatisticsMarketEstimate,
  type TribunalListingStatisticsQuery,
  type TribunalListingStatisticsResponse,
  type TribunalListingStatisticsSale,
} from "@/lib/tribunal-listing-statistics";

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

type DatabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

type ListingQuery = PromiseLike<DatabaseResult> & {
  select(columns: string): ListingQuery;
  eq(column: string, value: unknown): ListingQuery;
  is(column: string, value: null): ListingQuery;
  in(column: string, values: unknown[]): ListingQuery;
  order(column: string, options?: { ascending?: boolean }): ListingQuery;
  limit(count: number): ListingQuery;
  range(from: number, to: number): PromiseLike<DatabaseResult>;
  maybeSingle(): PromiseLike<DatabaseResult>;
};

const listingAdmin = supabaseAdmin as unknown as { from(table: string): ListingQuery };

export class TribunalListingStatisticsUnavailableError extends Error {
  constructor(
    message = "Les statistiques d’annonces du tribunal sont temporairement indisponibles.",
  ) {
    super(message);
    this.name = "TribunalListingStatisticsUnavailableError";
  }
}

type StoredListingSale = TribunalListingStatisticsSale & {
  tribunal: string | null;
  sourceUrl: string | null;
  externalId: string | null;
  contentHash: string | null;
  identityAddress: string | null;
  legalReference: string | null;
  lotNumber: string | null;
  valuationSource: Record<string, unknown>;
};

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

  const saleResult = await listingAdmin
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
    listingAdmin
      .from("tribunals")
      .select("code,canonical_name,aliases")
      .order("code", { ascending: true })
      .range(0, 250),
    listingAdmin
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
  const result = await listingAdmin
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
  const legacyResult = await listingAdmin
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

  const courtsResult = await listingAdmin
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
    listingAdmin
      .from("tribunals")
      .select("code,canonical_name,aliases")
      .eq("code", court.code)
      .limit(1)
      .maybeSingle(),
    listingAdmin
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
    let query = listingAdmin
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
    const result = await listingAdmin
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
    const result = await listingAdmin.from("auction_sales").select(SALE_COLUMNS).in("id", ids);
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

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  const record = asRecord(raw);
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
  const record = asRecord(raw);
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

function normalizeLegalReference(value: string | null): string | null {
  if (!value) return null;
  const match = /^\s*(\d{1,4})\s*\/\s*(\d{1,8})\s*$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const serial = Number(match[2]);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(serial) || serial <= 0) return null;
  return `${year}/${serial}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceBlocksForIdentity(
  record: Record<string, unknown>,
  source: string,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const direct = asRecord(record.source_blocks);
  if (direct) blocks.push(direct);
  const bySource = asRecord(record.source_blocks_by_source);
  if (bySource) {
    for (const [key, value] of Object.entries(bySource)) {
      if (sourceFamily(key) !== source) continue;
      const scoped = asRecord(value);
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
    const result = await listingAdmin
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

function positive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function deduplicateTribunalListingSales(sales: StoredListingSale[]): {
  sales: StoredListingSale[];
  unresolvedStrongAddressDuplicates: number;
} {
  const parent = sales.map((_, index) => index);
  const groupMembers = new Map<number, number[]>(sales.map((_, index) => [index, [index]]));
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const canJoinGroups = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const leftMembers = groupMembers.get(leftRoot) ?? [leftRoot];
    const rightMembers = groupMembers.get(rightRoot) ?? [rightRoot];
    return leftMembers.every((leftIndex) =>
      rightMembers.every((rightIndex) =>
        canMergeSaleIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
  };
  const canJoinLegalReferenceGroups = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    const leftMembers = groupMembers.get(leftRoot) ?? [leftRoot];
    const rightMembers = groupMembers.get(rightRoot) ?? [rightRoot];
    const everyFactualGuardPasses = leftMembers.every((leftIndex) =>
      rightMembers.every((rightIndex) =>
        canMergeSaleIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
    if (!everyFactualGuardPasses) return false;
    // At least one cross-group pair must carry the legal proof. Other
    // observations (for example Vench) may be part of the already grouped
    // announcement without exposing a Ref./RG of their own.
    return leftMembers.some((leftIndex) =>
      rightMembers.some((rightIndex) =>
        canMergeLegalReferenceIdentity(sales[leftIndex]!, sales[rightIndex]!),
      ),
    );
  };
  const union = (left: number, right: number): boolean => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return true;
    if (!canJoinGroups(leftRoot, rightRoot)) return false;
    parent[rightRoot] = leftRoot;
    groupMembers.set(leftRoot, [
      ...(groupMembers.get(leftRoot) ?? [leftRoot]),
      ...(groupMembers.get(rightRoot) ?? [rightRoot]),
    ]);
    groupMembers.delete(rightRoot);
    return true;
  };

  // The source adapters persist two useful identity signals which are not
  // necessarily represented by the canonical row id: repeated observations
  // from one source can retain the same external id/content hash, while PA
  // and Vench intentionally expose the same source announcement id. Scope
  // each key to its source family and keep the existing factual guards below.
  const identityOwners = new Map<string, number[]>();
  for (let index = 0; index < sales.length; index += 1) {
    const sale = sales[index]!;

    const sameSourceKeys = [sourceExternalIdentityKey(sale), sourceContentHashKey(sale)].filter(
      (value): value is string => value != null,
    );
    for (const key of sameSourceKeys) {
      const owners = identityOwners.get(key) ?? [];
      const owner = owners.find((ownerIndex) => canJoinGroups(ownerIndex, index));
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(key, owners);
    }

    const sharedKey = sharedPaVenchIdentityKey(sale);
    if (sharedKey) {
      const owners = identityOwners.get(sharedKey) ?? [];
      const owner = owners.find(
        (ownerIndex) =>
          sourceFamily(sales[ownerIndex]!.sourceName) !== sourceFamily(sale.sourceName) &&
          canJoinGroups(ownerIndex, index),
      );
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(sharedKey, owners);
    }

    // Source URLs remain the strongest alias when they are available. Keep
    // their exact canonicalization in the same guarded identity pass.
    for (const url of sale.sourceUrls ?? []) {
      const key = canonicalUrl(url);
      if (!key) continue;
      const owners = identityOwners.get(`url:${key}`) ?? [];
      const owner = owners.find((ownerIndex) => canJoinGroups(ownerIndex, index));
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(`url:${key}`, owners);
    }

    // PA Ref. and Enchères Immobilières RG are a court-issued identity
    // signal. Reapply every factual guard at group level so a shared
    // reference cannot bridge different hearings, cities or prices.
    const legalKey = legalReferenceIdentityKey(sale);
    if (legalKey) {
      const owners = identityOwners.get(legalKey) ?? [];
      const owner = owners.find(
        (ownerIndex) =>
          legalReferenceSourcePair(sales[ownerIndex]!, sale) &&
          canJoinLegalReferenceGroups(ownerIndex, index),
      );
      if (owner != null) union(owner, index);
      owners.push(index);
      identityOwners.set(legalKey, owners);
    }
  }

  const addressBuckets = new Map<string, number[]>();
  let unresolvedStrongAddressDuplicates = 0;
  for (let index = 0; index < sales.length; index += 1) {
    const sale = sales[index]!;
    const key = strongAddressDateKey(sale);
    if (!key) continue;
    const candidates = addressBuckets.get(key) ?? [];
    let merged = false;
    let ambiguous = false;
    for (const candidateIndex of candidates) {
      if (!canJoinGroups(candidateIndex, index)) {
        ambiguous = true;
        continue;
      }
      if (union(candidateIndex, index)) {
        merged = true;
        break;
      }
      ambiguous = true;
    }
    candidates.push(index);
    addressBuckets.set(key, candidates);
    if (!merged && ambiguous) unresolvedStrongAddressDuplicates += 1;
  }

  const groups = new Map<number, StoredListingSale[]>();
  for (let index = 0; index < sales.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(sales[index]!);
    groups.set(root, group);
  }
  return {
    sales: [...groups.values()].map(mergeSaleGroup),
    unresolvedStrongAddressDuplicates,
  };
}

function sourceExternalIdentityKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const externalId = normalizeExternalId(sale.externalId);
  if (!source || !externalId) return null;
  return `external:${source}:${externalId}`;
}

function sourceContentHashKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const contentHash = normalizeExternalId(sale.contentHash);
  if (!source || !contentHash) return null;
  return `content:${source}:${contentHash}`;
}

function sharedPaVenchIdentityKey(sale: StoredListingSale): string | null {
  const source = sourceFamily(sale.sourceName);
  const externalId = normalizeExternalId(sale.externalId);
  if (!externalId || (source !== "petitesaffiches" && source !== "vench")) return null;
  return `shared-pa-vench:${externalId}`;
}

function legalReferenceIdentityKey(sale: StoredListingSale): string | null {
  const reference = normalizeLegalReference(sale.legalReference);
  const source = sourceFamily(sale.sourceName);
  if (!reference || (source !== "petitesaffiches" && source !== "encheresimmobilieres")) {
    return null;
  }
  return `legal:${reference}`;
}

function legalReferenceSourcePair(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftSource = sourceFamily(left.sourceName);
  const rightSource = sourceFamily(right.sourceName);
  return (
    leftSource !== rightSource &&
    [leftSource, rightSource].every(
      (source) => source === "petitesaffiches" || source === "encheresimmobilieres",
    )
  );
}

function sourceFamily(value: string | null | undefined): string {
  return normalizeLabel(value ?? "").replace(/\s+/g, "");
}

function normalizeExternalId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  return normalized ? normalized : null;
}

function deduplicateListingSales(sales: StoredListingSale[]) {
  return deduplicateTribunalListingSales(sales);
}

function mergeSaleGroup(group: StoredListingSale[]): StoredListingSale {
  const ordered = [...group].sort(
    (left, right) =>
      saleRichnessScore(right) - saleRichnessScore(left) || left.id.localeCompare(right.id),
  );
  const winner = ordered[0]!;
  const names = [...new Set(group.flatMap((sale) => sale.sourceNames ?? []))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );
  const urls = [...new Set(group.flatMap((sale) => sale.sourceUrls ?? []))];
  const firstWith = <K extends keyof StoredListingSale>(key: K): StoredListingSale[K] => {
    for (const sale of ordered) {
      const value = sale[key];
      if (value != null && value !== "") return value;
    }
    return winner[key];
  };
  return {
    ...winner,
    title: firstWith("title"),
    city: firstWith("city"),
    address: firstWith("address"),
    identityAddress: firstKnownIdentityAddress(group) ?? firstWith("identityAddress"),
    legalReference: firstWith("legalReference"),
    sourceName: winner.sourceName,
    sourceNames: names,
    sourceUrls: urls,
    saleDate: firstWith("saleDate"),
    startingPriceEur: firstWith("startingPriceEur"),
    propertyType: firstKnownPropertyType(group) ?? firstWith("propertyType"),
    visitDates: unionVisitDates(group),
    occupancyStatus: firstKnownOccupancy(group) ?? firstWith("occupancyStatus"),
    lawyerName: firstWith("lawyerName"),
    publicationAt: earliestDate(group.map((sale) => sale.publicationAt)),
    firstSeenAt: earliestDate(group.map((sale) => sale.firstSeenAt)),
    overbidStatus: firstWith("overbidStatus"),
    overbidEvidence: group.flatMap((sale) =>
      Array.isArray(sale.overbidEvidence) ? sale.overbidEvidence : [],
    ),
    marketEstimate: firstWith("marketEstimate"),
    marketEstimateEligible: group.some((sale) => sale.marketEstimateEligible === true),
  };
}

function saleRichnessScore(sale: StoredListingSale): number {
  const fields = [
    sale.title,
    sale.address,
    sale.city,
    sale.saleDate,
    sale.startingPriceEur,
    sale.propertyType && isKnownPropertyType(sale.propertyType) ? sale.propertyType : null,
    sale.occupancyStatus && normalizeOccupationStatus(sale.occupancyStatus)
      ? sale.occupancyStatus
      : null,
    sale.lawyerName,
    sale.publicationAt,
    sale.firstSeenAt,
  ];
  const fieldScore = fields.reduce<number>(
    (score, value) => score + (value != null && value !== "" ? 1 : 0),
    0,
  );
  const visitScore = Array.isArray(sale.visitDates) && sale.visitDates.length > 0 ? 1 : 0;
  const sourcePriority = Math.max(
    ...(sale.sourceNames ?? []).map((source) => {
      const normalized = source.toLocaleLowerCase("fr-FR");
      if (normalized.includes("avovente")) return 4;
      if (normalized.includes("petitesaffiche")) return 3;
      if (normalized.includes("vench")) return 2;
      if (normalized.includes("licitor")) return 1;
      return 0;
    }),
    0,
  );
  return fieldScore * 10 + visitScore + sourcePriority;
}

function firstKnownPropertyType(group: StoredListingSale[]): string | null {
  return group.find((sale) => isKnownPropertyType(sale.propertyType))?.propertyType ?? null;
}

function firstKnownOccupancy(group: StoredListingSale[]): string | null {
  return (
    group.find((sale) => normalizeOccupationStatus(sale.occupancyStatus))?.occupancyStatus ?? null
  );
}

function isKnownPropertyType(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  return Boolean(normalized && normalized !== "unknown");
}

function unionVisitDates(group: StoredListingSale[]): unknown[] {
  const values = group.flatMap((sale) => (Array.isArray(sale.visitDates) ? sale.visitDates : []));
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function earliestDate(values: Array<string | null | undefined>): string | null {
  const dates = values
    .map((value) => (value ? new Date(value) : null))
    .filter((value): value is Date => value != null && Number.isFinite(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0]?.toISOString() ?? null;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLocaleLowerCase("fr-FR");
  } catch {
    return value.trim().toLocaleLowerCase("fr-FR");
  }
}

function conflictingLot(left: StoredListingSale, right: StoredListingSale): boolean {
  if (left.lotNumber != null && right.lotNumber != null) {
    return left.lotNumber !== right.lotNumber;
  }
  // A multi-lot source row cannot be safely matched to a row without the
  // same lot evidence: the latter may describe only one of its lots.
  return isMultiLot(left.lotNumber) || isMultiLot(right.lotNumber);
}

function identityAddressFingerprint(sale: StoredListingSale): string | null {
  return strongAddressFingerprint(sale.identityAddress ?? sale.address, sale.city);
}

function conflictingIdentityAddress(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftAddress = identityAddressFingerprint(left);
  const rightAddress = identityAddressFingerprint(right);
  return leftAddress != null && rightAddress != null && leftAddress !== rightAddress;
}

function conflictingLegalReference(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftReference = normalizeLegalReference(left.legalReference);
  const rightReference = normalizeLegalReference(right.legalReference);
  return leftReference != null && rightReference != null && leftReference !== rightReference;
}

function canMergeSaleIdentity(left: StoredListingSale, right: StoredListingSale): boolean {
  if (conflictingLot(left, right)) return false;
  if (conflictingIdentityAddress(left, right)) return false;
  if (conflictingLegalReference(left, right)) return false;
  if (!sameKnownCity(left.city, right.city)) return false;
  if (!sameKnownHearingDay(left.saleDate, right.saleDate)) return false;
  if (!samePositiveStartingPrice(left.startingPriceEur, right.startingPriceEur)) return false;
  if (!sameKnownPropertyClass(left.propertyType, right.propertyType)) return false;
  if (materiallyDifferentSurface(left, right)) return false;
  return true;
}

function canMergeLegalReferenceIdentity(
  left: StoredListingSale,
  right: StoredListingSale,
): boolean {
  const leftReference = normalizeLegalReference(left.legalReference);
  const rightReference = normalizeLegalReference(right.legalReference);
  if (!leftReference || leftReference !== rightReference) return false;
  if (!legalReferenceSourcePair(left, right)) return false;

  const leftCity = left.city ? normalizeLabel(left.city) : "";
  const rightCity = right.city ? normalizeLabel(right.city) : "";
  if (!leftCity || !rightCity || leftCity !== rightCity) return false;

  const leftDay = left.saleDate ? parseDay(left.saleDate) : null;
  const rightDay = right.saleDate ? parseDay(right.saleDate) : null;
  if (!leftDay || !rightDay || leftDay !== rightDay) return false;
  if (!positive(left.startingPriceEur) || !positive(right.startingPriceEur)) return false;
  if (!sameStartingPrice(left.startingPriceEur, right.startingPriceEur)) return false;
  return canMergeSaleIdentity(left, right);
}

function isMultiLot(value: string | null | undefined): boolean {
  return value?.startsWith("multi:") ?? false;
}

function sameKnownCity(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftCity = left ? normalizeLabel(left) : "";
  const rightCity = right ? normalizeLabel(right) : "";
  return !leftCity || !rightCity || leftCity === rightCity;
}

function sameKnownHearingDay(left: string | null, right: string | null): boolean {
  const leftDay = left ? parseDay(left) : null;
  const rightDay = right ? parseDay(right) : null;
  return leftDay == null || rightDay == null || leftDay === rightDay;
}

function samePositiveStartingPrice(left: number | null, right: number | null): boolean {
  return (
    left == null ||
    right == null ||
    !positive(left) ||
    !positive(right) ||
    sameStartingPrice(left, right)
  );
}

function sameKnownPropertyClass(left: string | null | undefined, right: string | null | undefined) {
  const leftClass = propertyClass(left);
  const rightClass = propertyClass(right);
  return leftClass == null || rightClass == null || leftClass === rightClass;
}

function propertyClass(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase("fr-FR");
  if (!normalized || normalized === "unknown") return null;
  if (/appartement|apartment|studio|loft/.test(normalized)) return "apartment";
  if (/maison|house|villa|pavillon/.test(normalized)) return "house";
  // The source vocabulary for parking, garages, buildings and commercial
  // units is not stable enough to make those labels identity conflicts.
  return "other";
}

function materiallyDifferentSurface(left: StoredListingSale, right: StoredListingSale): boolean {
  const leftSource = left.valuationSource ?? {};
  const rightSource = right.valuationSource ?? {};
  for (const key of [
    "app_surface_m2",
    "habitable_surface_m2",
    "carrez_surface_m2",
    "land_surface_m2",
  ]) {
    const leftValue = positiveNumberFromUnknown(leftSource[key]);
    const rightValue = positiveNumberFromUnknown(rightSource[key]);
    if (leftValue == null || rightValue == null) continue;
    const difference = Math.abs(leftValue - rightValue);
    const tolerance = Math.max(5, Math.max(leftValue, rightValue) * 0.1);
    if (difference > tolerance) return true;
  }
  return false;
}

function positiveNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const number = Number(value);
    return number > 0 ? number : null;
  }
  return null;
}

function strongAddressDateKey(sale: StoredListingSale): string | null {
  const address = identityAddressFingerprint(sale);
  const city = sale.city ? normalizeLabel(sale.city) : "";
  const date = sale.saleDate ? parseDay(sale.saleDate) : null;
  if (!address || !city || !date) return null;
  return `${address}|${city}|${date}`;
}

function firstKnownIdentityAddress(group: StoredListingSale[]): string | null {
  return (
    group.find((sale) => identityAddressFingerprint(sale) != null)?.identityAddress ??
    group.find((sale) => strongAddressFingerprint(sale.address, sale.city) != null)?.address ??
    null
  );
}

function strongAddressFingerprint(
  value: string | null | undefined,
  city?: string | null,
): string | null {
  if (!value?.trim()) return null;
  const normalized = normalizeAddressLabel(value)
    .replace(/\b\d{5}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedCity = city ? normalizeAddressLabel(city) : "";
  const addressWithoutCity =
    normalizedCity && normalized.endsWith(` ${normalizedCity}`)
      ? normalized.slice(0, -normalizedCity.length).trim()
      : normalized;
  const number = /\b\d+[a-z]?\b/.exec(normalized)?.[0];
  const words = addressWithoutCity.split(" ").filter(Boolean);
  if (!number || words.length < 3) return null;
  const street = words
    .filter(
      (word) => word !== number && !["d", "de", "du", "des", "la", "le", "les"].includes(word),
    )
    .join(" ");
  if (!/[a-z]/.test(street)) return null;
  return `${number}|${street}`;
}

function normalizeAddressLabel(value: string): string {
  return normalizeLabel(
    value
      .replace(/([a-zà-ÿ])([A-ZÀ-Ý])/g, "$1 $2")
      .replace(/([0-9])([A-Za-zÀ-ÿ])/g, "$1 $2")
      .replace(/([A-Za-zÀ-ÿ])([0-9])/g, "$1 $2"),
  );
}

function parseDay(value: string): string | null {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function sameStartingPrice(left: number | null, right: number | null): boolean {
  if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right))
    return false;
  return Math.round(left * 100) === Math.round(right * 100);
}

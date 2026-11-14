import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { AuctionSale, SaleDocumentRich, SaleMedia } from "@/lib/types";
import type { InformationAgentInventorySignals } from "@/lib/information-agent-inventory";
import {
  discoverInformationAgentContacts,
  INFORMATION_AGENT_PIPELINE_CHANNEL,
  selectInformationAgentContact,
  type InformationAgentRegistryContact,
} from "@/lib/information-agent/contact-resolution";
import { informationAgentAddressHygieneIssue } from "@/lib/information-agent/address-hygiene";
import { informationAgentAddressCheckEnabled } from "@/lib/information-agent/address-deliverability";
import { findCourtRegistryFallback } from "@/lib/information-agent/court-registry";
import { isCourtRegistryFallbackSale } from "@/lib/information-agent/court-registry-fallback";
import {
  readInformationAgentListingContactBlock,
  readInformationAgentOrganizerType,
  type InformationAgentListingContactBlock,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";

/**
 * The admin information workflow is allowed to inspect a sale that is kept out
 * of the public catalogue while its source data is being reviewed.  Do not
 * replace this query with `v_auction_sales_app`: that projection deliberately
 * hides quarantined rows and is therefore the wrong source for an internal
 * request draft.
 */ import { asRecord, parsedNumberValue, stringValueOr } from "@/lib/guards";

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
const ADMIN_INFORMATION_AGENT_AVAILABLE_STATUSES = [
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

export type AdminInformationAgentSaleAuth = Pick<SupabaseAuthContext, "isAdmin">;

/**
 * Instantané interne de la vente pour l'agent : la forme `AuctionSale`, plus les signaux tirés de
 * `raw_payload` pour l'inventaire et l'URL source de chaque bloc (provenance exacte des contacts).
 */
export type AdminInformationAgentSale = AuctionSale & {
  information_agent_signals: InformationAgentInventorySignals;
  source_block_urls: Record<string, string | null>;
  /** Adresses du registre interne (relevées par le pipeline, jamais publiées) pour cette vente. */
  registry_contacts: InformationAgentRegistryContact[];
  /** Blocs de contact publiés dans l'annonce (`source_property_features`), vente puis observations. */
  listing_contact_blocks: InformationAgentListingContactBlock[];
  /** Organisateur de la vente (`sale_procedure.organizer_type`) : il fixe le rôle de l'interlocuteur. */
  information_agent_organizer_type: InformationAgentOrganizerType;
};

/** Nombre maximal d'URL sources dont on lit les pièces (vente + observations). */
const MAX_DOCUMENT_SOURCE_URLS = 12;

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
}): Promise<AdminInformationAgentSale> {
  assertAdmin(auth);

  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select(ADMIN_INFORMATION_AGENT_SALE_SELECT)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  const row = asSaleRow(data);
  if (!row?.id) throw new NotFoundError("Vente introuvable.");

  const status = nullableString(row.status);
  if (!isAvailableInformationAgentStatus(status)) {
    throw new PublicApiError(
      "Cette vente n'est plus disponible pour une demande d'informations.",
      409,
    );
  }

  const [documents, sourcePresence, registryContacts] = await Promise.all([
    loadAdminInformationAgentDocuments(saleSourceUrls(row)),
    loadAdminInformationAgentSourcePresence(saleId),
    loadAdminInformationAgentRegistryContacts(saleId),
  ]);
  return {
    ...toInformationAgentSale(row, documents, sourcePresence),
    registry_contacts: registryContacts,
  };
}

/**
 * Adresses que le pipeline relève pour l'agent sans les publier (email Licitor décodé) : lignes du
 * registre interne de cette vente, de type `sale_listing`, ni opposées ni en rebond permanent. Le
 * registre n'est lisible que par le service ; ces adresses ne passent par aucune vue publique. Une
 * erreur de lecture donne une liste vide (avertissement sans adresse), jamais un échec du brouillon.
 */
async function loadAdminInformationAgentRegistryContacts(
  saleId: string,
): Promise<InformationAgentRegistryContact[]> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("email,display_name,role,source_name,source_url,observed_at")
    .eq("scope_sale_id", saleId)
    .eq("source_kind", "sale_listing")
    .eq("metadata->>observation_channel", INFORMATION_AGENT_PIPELINE_CHANNEL)
    .neq("opposition_status", "opposed")
    .neq("bounce_status", "permanent")
    .order("observed_at", { ascending: false })
    .limit(20);
  if (error) {
    // Le registre est un complément : s'il est illisible, l'agent travaille avec les données de l'annonce
    // et l'administrateur saisit l'adresse. Aucune adresse ni détail de ligne dans le journal.
    console.warn("Registre des contacts de l'agent illisible", { code: error.code ?? null });
    return [];
  }
  return (data ?? []).map((row) => ({
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    observedAt: row.observed_at,
  }));
}

/**
 * Colonnes lues pour savoir si une adresse email est connue (blocs et descriptions, sans le reste), plus la date de
 * la vente et le lieu de l'identité du professionnel (tribunal, ville : `saleIdentityPlace`), que le tri préalable du
 * pilote automatique lit dans cette même lecture (`autopilot-candidates.ts`).
 */
const EMAIL_AVAILABILITY_SELECT = [
  "id",
  "sale_date",
  "tribunal",
  "city",
  "lawyer_name",
  "lawyer_contact",
  "description",
  "source_name",
  "primary_source",
  "source_url",
  "source_urls",
  "observations",
  "source_blocks:raw_payload->source_blocks",
  "source_description:raw_payload->>source_description",
  "source_property_features:raw_payload->source_property_features",
  "payload_sale_procedure:raw_payload->sale_procedure",
  "sale_procedure",
  "sale_venue_type",
  "sale_verification_status",
  "tribunal_code",
  "quality_flags",
].join(",");
const EMAIL_AVAILABILITY_CHUNK = 50;

/**
 * Classe de contact d'une vente, vérifiée avec le même résolveur que la préparation du brouillon :
 *   A  un destinataire non ambigu (confiance au moins moyenne, écart de 12 points sur le suivant) ;
 *   B  une ou plusieurs adresses, mais aucune que l'agent choisit seul (à confirmer par l'administrateur) ;
 *   C  aucune adresse d'avocat, mais le greffe du tribunal en a une (référentiel des tribunaux) ;
 *   D  contact impossible : téléphone, nom ou rien.
 * Une adresse mal formée (hygiène : longueur, artefact, domaine réservé) n'est pas un contact. Une vente
 * introuvable est absente du résultat. Une erreur de lecture des ventes est propagée. Quand le REGISTRE
 * est illisible, une vente sans email dans l'annonce vaut B (inconnu) : elle n'est pas écartée à tort, et
 * la création du brouillon refuse de toute façon s'il n'y a pas d'adresse.
 */
export type InformationAgentSaleContactClass = "A" | "B" | "C" | "D";

export async function classifyInformationAgentSaleContacts(
  saleIds: readonly string[],
): Promise<Map<string, InformationAgentSaleContactClass>> {
  const result = new Map<string, InformationAgentSaleContactClass>();
  const ids = [...new Set(saleIds)];
  for (let index = 0; index < ids.length; index += EMAIL_AVAILABILITY_CHUNK) {
    const chunk = ids.slice(index, index + EMAIL_AVAILABILITY_CHUNK);
    const { sales, registryReadable } = await readInformationAgentContactSales(chunk);
    const registry = { readable: registryReadable };
    const classified = await Promise.all(
      [...sales].map(async ([id, sale]) => {
        const checkAddresses = informationAgentAddressCheckEnabled();
        const candidates = discoverInformationAgentContacts(sale).filter(
          (candidate) => !checkAddresses || !informationAgentAddressHygieneIssue(candidate.email),
        );
        if (candidates.length) {
          const cls: InformationAgentSaleContactClass = selectInformationAgentContact(candidates)
            ? "A"
            : "B";
          return [id, cls] as const;
        }
        if (!registry.readable) return [id, "B"] as const;
        if (isCourtRegistryFallbackSale(sale) && (await findCourtRegistryFallback(sale))) {
          return [id, "C"] as const;
        }
        return [id, "D"] as const;
      }),
    );
    for (const entry of classified) if (entry) result.set(entry[0], entry[1]);
  }
  return result;
}

/**
 * Ventes telles que le résolveur de contacts les lit (annonce, blocs de contact, registre interne), sans les
 * pièces ni la présence par source. LECTURE SEULE : même source que la classe de contact et que la mesure à
 * blanc (`dry-run.ts`). Réservée à un administrateur : les ventes rendues portent des adresses. Une vente
 * introuvable est absente ; une erreur de lecture des ventes est propagée.
 * `registryReadable` est faux quand le registre interne n'a pas pu être lu.
 */
export async function loadInformationAgentContactSales({
  auth,
  saleIds,
}: {
  auth: AdminInformationAgentSaleAuth;
  saleIds: readonly string[];
}): Promise<InformationAgentContactSales> {
  assertAdmin(auth);
  return readInformationAgentContactSales(saleIds);
}

type InformationAgentContactSales = {
  sales: Map<string, AdminInformationAgentSale>;
  registryReadable: boolean;
};

/** Lecture sans contrôle d'accès, pour le classement interne (`classifyInformationAgentSaleContacts`). */
async function readInformationAgentContactSales(
  saleIds: readonly string[],
): Promise<InformationAgentContactSales> {
  const sales = new Map<string, AdminInformationAgentSale>();
  const ids = [...new Set(saleIds)];
  if (!ids.length) return { sales, registryReadable: true };
  const [salesResponse, registry] = await Promise.all([
    supabaseAdmin.from("auction_sales").select(EMAIL_AVAILABILITY_SELECT).in("id", ids),
    loadRegistryContactsBySale(ids),
  ]);
  if (salesResponse.error) throw salesResponse.error;
  for (const value of salesResponse.data ?? []) {
    const row = asSaleRow(value);
    const id = nullableString(row?.id);
    if (!row || !id) continue;
    sales.set(id, {
      ...toInformationAgentSale(
        {
          ...row,
          raw_payload: {
            source_blocks: row.source_blocks ?? null,
            source_description: row.source_description ?? null,
            source_property_features: row.source_property_features ?? null,
            sale_procedure: row.payload_sale_procedure ?? null,
          },
        },
        [],
        null,
      ),
      registry_contacts: registry.contacts.get(id) ?? [],
    });
  }
  return { sales, registryReadable: registry.readable };
}

/**
 * Pour chaque vente, vrai si l'agent peut préparer un message : une adresse d'avocat ou de cabinet (classe A
 * ou B) ou le greffe du tribunal (classe C). Une vente introuvable vaut faux.
 */
export async function loadAdminInformationAgentEmailAvailability(
  saleIds: readonly string[],
): Promise<Map<string, boolean>> {
  const classes = await classifyInformationAgentSaleContacts(saleIds);
  const result = new Map<string, boolean>();
  for (const id of new Set(saleIds)) result.set(id, (classes.get(id) ?? "D") !== "D");
  return result;
}

/**
 * Même lecture du registre interne que `loadAdminInformationAgentRegistryContacts`, pour plusieurs
 * ventes. `readable` est faux quand la lecture a échoué : l'absence de contact est alors inconnue.
 */
async function loadRegistryContactsBySale(
  saleIds: readonly string[],
): Promise<{ contacts: Map<string, InformationAgentRegistryContact[]>; readable: boolean }> {
  const bySale = new Map<string, InformationAgentRegistryContact[]>();
  const { data, error } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("scope_sale_id,email,display_name,role,source_name,source_url,observed_at")
    .in("scope_sale_id", [...saleIds])
    .eq("source_kind", "sale_listing")
    .eq("metadata->>observation_channel", INFORMATION_AGENT_PIPELINE_CHANNEL)
    .neq("opposition_status", "opposed")
    .neq("bounce_status", "permanent")
    .order("observed_at", { ascending: false })
    .limit(1000);
  if (error) {
    console.warn("Registre des contacts de l'agent illisible", { code: error.code ?? null });
    return { contacts: bySale, readable: false };
  }
  for (const row of data ?? []) {
    if (!row.scope_sale_id) continue;
    const list = bySale.get(row.scope_sale_id) ?? [];
    list.push({
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      observedAt: row.observed_at,
    });
    bySale.set(row.scope_sale_id, list);
  }
  return { contacts: bySale, readable: true };
}

export function isAvailableInformationAgentStatus(
  status: string | null,
): status is AdminInformationAgentAvailableStatus {
  return (ADMIN_INFORMATION_AGENT_AVAILABLE_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Toutes les URL sources de la fiche : l'annonce principale, `source_urls` et chaque observation
 * d'une autre source. Les pièces d'un doublon fusionné comptent aussi pour l'inventaire.
 */
function saleSourceUrls(row: AdminInformationAgentSaleRow): string[] {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) urls.add(value.trim());
  };
  add(row.source_url);
  for (const value of asArray(row.source_urls)) add(value);
  for (const observation of asArray(row.observations)) add(asRecord(observation).source_url);
  return [...urls].slice(0, MAX_DOCUMENT_SOURCE_URLS);
}

async function loadAdminInformationAgentDocuments(
  sourceUrls: readonly string[],
): Promise<SaleDocumentRich[]> {
  if (!sourceUrls.length) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_documents")
    .select(
      "document_url,label,document_type,extraction_status,download_status,docling_status,text_chars",
    )
    .in("source_url", [...sourceUrls])
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;

  const seen = new Set<string>();
  return (data ?? [])
    .map((value) => toDocument(value))
    .filter((document): document is SaleDocumentRich => {
      if (!document || seen.has(document.url)) return false;
      seen.add(document.url);
      return true;
    });
}

async function loadAdminInformationAgentSourcePresence(
  saleId: string,
): Promise<AuctionSale["source_presence"]> {
  const { data, error } = await supabaseAdmin
    .from("auction_sale_source_presence")
    .select("source_name,availability,state,attempted_at,checked_at,run_id,extras")
    .eq("sale_id", saleId);
  if (error) throw error;
  return sourcePresenceRows(data);
}

function toInformationAgentSale(
  row: AdminInformationAgentSaleRow,
  documents: SaleDocumentRich[],
  sourcePresence: AuctionSale["source_presence"],
): Omit<AdminInformationAgentSale, "registry_contacts"> {
  const rawPayload = asRecord(row.raw_payload);
  const observations = asArray(row.observations);
  const sourceBlocks = asRecordOrNull(rawPayload.source_blocks);

  return {
    id: stringValueOr(row.id, ""),
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
    starting_price_eur: parsedNumberValue(row.starting_price_eur),
    sale_date: nullableString(row.sale_date),
    visit_dates: row.visit_dates ?? null,
    lawyer_name: nullableString(row.lawyer_name),
    lawyer_contact: nullableString(row.lawyer_contact),
    adjudication_price_eur: parsedNumberValue(row.adjudication_price_eur),
    latitude: parsedNumberValue(row.latitude),
    longitude: parsedNumberValue(row.longitude),
    occupancy_status: nullableString(row.occupancy_status),
    habitable_surface_m2: parsedNumberValue(row.habitable_surface_m2),
    carrez_surface_m2: parsedNumberValue(row.carrez_surface_m2),
    land_surface_m2: parsedNumberValue(row.land_surface_m2),
    app_surface_m2: parsedNumberValue(row.app_surface_m2),
    app_surface_kind: nullableString(row.app_surface_kind),
    surface_scope: nullableString(row.surface_scope),
    surface_source: nullableString(row.surface_source),
    surface_confidence: parsedNumberValue(row.surface_confidence),
    surface_evidence: nullableString(row.surface_evidence),
    rooms_count: parsedNumberValue(row.rooms_count),
    bedrooms_count: parsedNumberValue(row.bedrooms_count),
    bathrooms_count: parsedNumberValue(row.bathrooms_count),
    parking_count: parsedNumberValue(row.parking_count),
    has_garden: booleanValue(row.has_garden),
    has_terrace: booleanValue(row.has_terrace),
    has_garage: booleanValue(row.has_garage),
    has_pool: booleanValue(row.has_pool),
    has_air_conditioning: booleanValue(row.has_air_conditioning),
    has_double_glazing: booleanValue(row.has_double_glazing),
    investment_score: parsedNumberValue(row.investment_score),
    investment_summary: nullableString(row.investment_summary),
    score_version: nullableString(row.score_version),
    score_confidence: parsedNumberValue(row.score_confidence),
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
    source_block_urls: collectSourceBlockUrls(row, sourceBlocks, observations),
    information_agent_signals: inventorySignals(rawPayload),
    listing_contact_blocks: collectListingContactBlocks(row, rawPayload, observations),
    // La colonne `sale_procedure` fait foi ; la copie de `raw_payload` sert quand la colonne n'est pas remplie.
    information_agent_organizer_type: readInformationAgentOrganizerType(
      row.sale_procedure,
      rawPayload.sale_procedure,
    ),
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

/**
 * Blocs de contact publiés par l'annonce (`source_property_features` : notaire, service de l'État, avocat)
 * pour la vente puis pour chaque observation d'une autre source, avec la source et l'URL de l'annonce lue.
 * Seuls les champs de contact sont recopiés, jamais le reste de `raw_payload`.
 */
function collectListingContactBlocks(
  row: AdminInformationAgentSaleRow,
  rawPayload: Record<string, unknown>,
  observations: unknown[],
): InformationAgentListingContactBlock[] {
  const blocks: InformationAgentListingContactBlock[] = [];
  const add = (features: unknown, sourceName: unknown, sourceUrl: unknown) => {
    const block = readInformationAgentListingContactBlock(
      features,
      nullableString(sourceName),
      nullableString(sourceUrl),
    );
    if (block) blocks.push(block);
  };
  add(rawPayload.source_property_features, row.source_name, row.source_url);
  for (const value of observations) {
    const observation = asRecord(value);
    add(
      asRecord(observation.raw_payload).source_property_features,
      observation.source_name,
      observation.source_url,
    );
  }
  return blocks;
}

/** URL source de chaque entrée de `source_blocks_by_source` (mêmes clés). */
function collectSourceBlockUrls(
  row: AdminInformationAgentSaleRow,
  primaryBlocks: Record<string, unknown> | null,
  observations: unknown[],
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const sourceName = nullableString(row.source_name) || "source";
  if (primaryBlocks) result[`${sourceName}:primary`] = nullableString(row.source_url);
  observations.forEach((value, index) => {
    const observation = asRecord(value);
    if (!asRecordOrNull(asRecord(observation.raw_payload).source_blocks)) return;
    const observationSource = nullableString(observation.source_name) || "source";
    result[`${observationSource}:${index + 1}`] = nullableString(observation.source_url);
  });
  return result;
}

const PDF_FACT_KEYS = {
  occupancy: "pdf_occupancy_candidates",
  rooms: "pdf_rooms_candidates",
  surface: "pdf_surface_candidates",
  land_surface: "pdf_land_surface_candidates",
  energy: "pdf_energy_diagnostics_candidates",
} as const;

/**
 * Signaux de l'inventaire tirés de `raw_payload` : seulement l'existence d'un fait extrait d'une
 * pièce, avec le libellé de la pièce et la page. Les extraits (qui peuvent contenir des données
 * personnelles) ne sont jamais recopiés.
 */
function inventorySignals(rawPayload: Record<string, unknown>): InformationAgentInventorySignals {
  const pdfFacts: NonNullable<InformationAgentInventorySignals["pdfFacts"]> = {};
  for (const [key, payloadKey] of Object.entries(PDF_FACT_KEYS) as Array<
    [keyof typeof PDF_FACT_KEYS, string]
  >) {
    const first = asArray(rawPayload[payloadKey])
      .map(asRecord)
      .find((candidate) => candidate.value !== null && candidate.value !== undefined);
    if (!first) continue;
    pdfFacts[key] = {
      documentLabel: nullableString(first.document_label)?.slice(0, 120) ?? null,
      documentType: nullableString(first.document_type),
      page: parsedNumberValue(first.page_number),
    };
  }
  const energy = asRecordOrNull(rawPayload.source_energy_diagnostics);
  const cadastre = rawPayload.cadastre_location;
  return {
    pdfFacts,
    energyClasses: energy
      ? { dpe: nullableString(energy.dpe_class), ges: nullableString(energy.ges_class) }
      : null,
    cadastre:
      typeof cadastre === "string"
        ? nullableString(cadastre)
        : asRecordOrNull(cadastre)
          ? "cadastre_location"
          : null,
    visitContact: Boolean(nullableString(rawPayload.visit_contact)),
  };
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
  // « default » seulement dans le nom du fichier : /sites/default/files/ est le dossier des sites Drupal.
  return !/(^|[/_.-])(avatar|brand|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$/i.test(
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
    text_chars: parsedNumberValue(row.text_chars),
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

function asSaleRow(value: unknown): AdminInformationAgentSaleRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AdminInformationAgentSaleRow;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  const result = asRecord(value);
  return Object.keys(result).length ? result : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

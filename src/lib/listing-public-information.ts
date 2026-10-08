import { safeExternalHttpUrl } from "@/lib/external-url";
import { formatDateTime, formatPrice } from "@/lib/format";
import { occupancyLabel, propertyTypeLabel } from "@/lib/format/property-labels";
import { listingDate, listingVisits } from "@/lib/sale-listing";
import { saleSession, saleWindow } from "@/lib/sale-window";
import { getDisplaySurface } from "@/lib/surface";
import { collectSaleDocuments } from "@/lib/sale-documents";
import {
  getListingCompleteness,
  type CompletenessEvidence,
  type CompletenessFieldResult,
  type CompletenessState,
  type ListingCompletenessResult,
} from "@/lib/listing-completeness";
import type { FactReliabilityMap, KeyFact } from "@/lib/fact-reliability";
import type { AuctionSale } from "@/lib/types";

export type PublicListingSource = {
  label: string;
  url: string | null;
  excerpt: string | null;
  page: number | null;
  capturedAt: string | null;
  kind: "listing" | "document" | "other";
};

export type PublicListingFact = {
  id: string;
  label: string;
  value: string | null;
  status: "sourced" | "reported" | "estimated" | "missing" | "conflict";
  explanation: string;
  sources: PublicListingSource[];
};

export type PublicListingSection = {
  id: string;
  title: string;
  items: PublicListingFact[];
};

export type PublicListingInformation = {
  sections: PublicListingSection[];
  items: PublicListingFact[];
  total: number;
  sourcedCount: number;
  missingCount: number;
  toConfirmCount: number;
  priorityItems: PublicListingFact[];
};

export type PublicListingInformationOptions = {
  blockedFieldIds?: ReadonlySet<string>;
};

type PublicFactStatus = PublicListingFact["status"];

type PublicField = {
  id: string;
  section: "property" | "amenities" | "energy" | "occupancy" | "sale";
  label: string;
  fieldIds: string[];
  importance?: "critical" | "high" | "medium" | "optional";
  priority?: number;
  directField?: string;
  keyFact?: KeyFact;
  readValue?: (sale: AuctionSale, completeness: ListingCompletenessResult) => unknown;
  formatValue?: (value: unknown, sale: AuctionSale) => string | null;
  estimated?: (sale: AuctionSale) => boolean;
  customStatus?: (value: unknown, state: CompletenessState | null) => PublicFactStatus | null;
  documentMatcher?: (document: ReturnType<typeof collectSaleDocuments>[number]) => boolean;
};

type FieldSourceContext = {
  sale: AuctionSale;
  field: CompletenessFieldResult | null;
  fields: CompletenessFieldResult[];
  fieldIds: string[];
  documents: ReturnType<typeof collectSaleDocuments>;
  includeDocumentSources?: boolean;
};

const SECTION_DEFINITIONS: ReadonlyArray<Pick<PublicListingSection, "id" | "title">> = [
  { id: "property", title: "Le bien" },
  { id: "amenities", title: "Équipements" },
  { id: "energy", title: "Énergie" },
  { id: "occupancy", title: "Occupation et charges" },
  { id: "sale", title: "Vente et visites" },
];

const PRIORITY_IDS = new Map<string, number>([
  ["occupancy_status", 1],
  ["sale_date", 2],
  ["surface", 3],
  ["starting_price_eur", 4],
  ["documents", 5],
  ["location", 6],
  ["property_type", 7],
  ["visits", 8],
]);

const MISSING_TEXT = new Set([
  "",
  "-",
  "—",
  "a_confirmer",
  "a_confirmer_dans_les_documents",
  "inconnu",
  "n/a",
  "non_communique",
  "non_renseigne",
  "non_precise",
  "unknown",
]);

const PUBLIC_FIELD_DEFINITIONS: readonly PublicField[] = [
  {
    id: "property_type",
    section: "property",
    label: "Type de bien",
    fieldIds: ["property_type"],
    importance: "critical",
    priority: 7,
    directField: "property_type",
    formatValue: (value) =>
      typeof value === "string" && cleanText(value) ? propertyTypeLabel(value) : null,
  },
  {
    id: "location",
    section: "property",
    label: "Adresse",
    fieldIds: ["address", "postal_code", "city", "department"],
    importance: "critical",
    priority: 6,
    readValue: (sale) => formatLocation(sale),
  },
  {
    id: "surface",
    section: "property",
    label: "Surface",
    fieldIds: ["land_surface_m2", "surface_habitable_m2", "surface_carrez_m2", "surface_built_m2"],
    importance: "critical",
    priority: 3,
    keyFact: "surface",
    readValue: (sale) => {
      const display = getDisplaySurface(sale);
      return display.value;
    },
    formatValue: (value, sale) => {
      if (!isFiniteNumber(value) || value <= 0) return null;
      const display = getDisplaySurface(sale);
      return `${formatDecimal(value)} m²${display.kind === "land" ? " de terrain" : ""}`;
    },
    estimated: (sale) => getDisplaySurface(sale).kind === "estimated",
    customStatus: (value, state) => {
      if (isFiniteNumber(value) && state === "inferred") return "estimated";
      return null;
    },
  },
  {
    id: "rooms_count",
    section: "property",
    label: "Pièces",
    fieldIds: ["rooms_count"],
    importance: "critical",
    directField: "rooms_count",
    formatValue: (value) => countValue(value, "pièce", "pièces"),
  },
  {
    id: "bedrooms_count",
    section: "property",
    label: "Chambres",
    fieldIds: ["bedrooms_count"],
    importance: "high",
    directField: "bedrooms_count",
    formatValue: (value) => countValue(value, "chambre", "chambres"),
  },
  {
    id: "bathrooms_count",
    section: "property",
    label: "Salles de bains et d’eau",
    fieldIds: ["bathrooms_count", "shower_rooms_count"],
    importance: "medium",
    readValue: (sale, completeness) => readBathrooms(sale, completeness),
    formatValue: formatBathrooms,
  },
  {
    id: "floor_number",
    section: "property",
    label: "Étage",
    fieldIds: ["floor_number"],
    importance: "high",
    formatValue: (value) => formatFloor(value),
  },
  {
    id: "condition",
    section: "property",
    label: "État du bien",
    fieldIds: ["condition", "works_needed"],
    importance: "high",
  },
  {
    id: "heating_mode",
    section: "amenities",
    label: "Chauffage",
    fieldIds: ["heating_mode", "heating_energy", "heating_distribution"],
    importance: "high",
    formatValue: (value) => humanEnum(value),
  },
  {
    id: "elevator",
    section: "amenities",
    label: "Ascenseur",
    fieldIds: ["elevator"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "garden",
    section: "amenities",
    label: "Jardin",
    fieldIds: ["garden"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "terrace",
    section: "amenities",
    label: "Terrasse",
    fieldIds: ["terrace"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "balcony",
    section: "amenities",
    label: "Balcon",
    fieldIds: ["balcony"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "garage",
    section: "amenities",
    label: "Garage ou box",
    fieldIds: ["garage"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "parking",
    section: "amenities",
    label: "Stationnement",
    fieldIds: ["parking"],
    importance: "medium",
    directField: "parking_count",
    formatValue: (value) => countValue(value, "place", "places"),
  },
  {
    id: "cellar",
    section: "amenities",
    label: "Cave",
    fieldIds: ["cellar"],
    importance: "medium",
    formatValue: formatBoolean,
  },
  {
    id: "pool",
    section: "amenities",
    label: "Piscine",
    fieldIds: ["pool"],
    importance: "optional",
    formatValue: formatBoolean,
  },
  {
    id: "dpe_class",
    section: "energy",
    label: "Classe DPE",
    fieldIds: ["dpe_class"],
    importance: "high",
    formatValue: (value) => upperCode(value),
  },
  {
    id: "ges_class",
    section: "energy",
    label: "Classe GES",
    fieldIds: ["ges_class"],
    importance: "high",
    formatValue: (value) => upperCode(value),
  },
  {
    id: "energy_consumption_kwh_m2_year",
    section: "energy",
    label: "Consommation énergétique",
    fieldIds: ["energy_consumption_kwh_m2_year"],
    importance: "medium",
    formatValue: (value) =>
      isFiniteNumber(value) ? `${formatDecimal(value)} kWh/m²/an` : formatScalar(value),
  },
  {
    id: "emissions_kg_co2_m2_year",
    section: "energy",
    label: "Émissions GES",
    fieldIds: ["emissions_kg_co2_m2_year"],
    importance: "medium",
    formatValue: (value) =>
      isFiniteNumber(value) ? `${formatDecimal(value)} kg CO₂/m²/an` : formatScalar(value),
  },
  {
    id: "dpe_established_at",
    section: "energy",
    label: "Date du DPE",
    fieldIds: ["dpe_established_at"],
    importance: "high",
    formatValue: formatHumanDate,
  },
  {
    id: "occupancy_status",
    section: "occupancy",
    label: "Occupation",
    fieldIds: ["occupancy_status"],
    importance: "critical",
    priority: 1,
    directField: "occupancy_status",
    keyFact: "occupancy_status",
    formatValue: (value) =>
      typeof value === "string" && cleanText(value) ? occupancyLabel(value) : null,
  },
  {
    id: "lease_status",
    section: "occupancy",
    label: "Statut du bail",
    fieldIds: ["lease_status"],
    importance: "high",
    formatValue: humanEnum,
  },
  {
    id: "rent_eur",
    section: "occupancy",
    label: "Loyer",
    fieldIds: ["rent_eur"],
    importance: "medium",
    formatValue: moneyValue,
  },
  {
    id: "lease_end_date",
    section: "occupancy",
    label: "Échéance du bail",
    fieldIds: ["lease_end_date"],
    importance: "medium",
    formatValue: formatHumanDate,
  },
  {
    id: "coownership",
    section: "occupancy",
    label: "Copropriété",
    fieldIds: ["coownership"],
    importance: "high",
    formatValue: formatBooleanOrText,
  },
  {
    id: "coownership_charges_eur",
    section: "occupancy",
    label: "Charges de copropriété",
    fieldIds: ["coownership_charges_eur"],
    importance: "medium",
    formatValue: moneyValue,
  },
  {
    id: "coownership_works",
    section: "occupancy",
    label: "Travaux de copropriété",
    fieldIds: ["coownership_works"],
    importance: "medium",
  },
  {
    id: "property_tax_eur",
    section: "occupancy",
    label: "Taxe foncière",
    fieldIds: ["property_tax_eur"],
    importance: "medium",
    formatValue: moneyValue,
  },
  {
    id: "starting_price_eur",
    section: "sale",
    label: "Mise à prix",
    fieldIds: ["starting_price_eur"],
    importance: "critical",
    priority: 4,
    directField: "starting_price_eur",
    keyFact: "starting_price_eur",
    formatValue: moneyValue,
  },
  {
    id: "sale_date",
    section: "sale",
    label: "Date de vente",
    fieldIds: ["sale_date", "sale_schedule"],
    importance: "critical",
    priority: 2,
    keyFact: "sale_date",
    readValue: readSaleDate,
    formatValue: formatSaleDate,
  },
  {
    id: "visits",
    section: "sale",
    label: "Visites",
    fieldIds: ["visit_dates"],
    importance: "high",
    priority: 8,
    readValue: (sale) => listingVisits(sale),
    formatValue: formatVisits,
  },
  {
    id: "participation_mode",
    section: "sale",
    label: "Mode de participation",
    fieldIds: ["participation_mode"],
    importance: "critical",
    formatValue: humanEnum,
  },
  {
    id: "lawyer_required",
    section: "sale",
    label: "Avocat requis",
    fieldIds: ["lawyer_required"],
    importance: "high",
    formatValue: formatBoolean,
  },
  {
    id: "lawyer_name",
    section: "sale",
    label: "Organisateur ou avocat",
    fieldIds: ["lawyer_name"],
    importance: "high",
  },
  {
    id: "sale_fees",
    section: "sale",
    label: "Frais publiés",
    fieldIds: ["sale_fees"],
    importance: "high",
    formatValue: formatMoneyOrText,
  },
  {
    id: "payment_terms",
    section: "sale",
    label: "Conditions de paiement",
    fieldIds: ["payment_terms"],
    importance: "high",
    formatValue: formatPaymentTerms,
  },
  {
    id: "documents",
    section: "sale",
    label: "Pièces disponibles",
    fieldIds: ["documents_inventory"],
    importance: "critical",
    priority: 5,
    readValue: (sale) => collectSaleDocuments(sale),
    formatValue: formatDocuments,
    documentMatcher: () => true,
  },
  {
    id: "conditions_sale",
    section: "sale",
    label: "Cahier des conditions",
    fieldIds: ["conditions_sale"],
    importance: "critical",
    priority: 5,
    readValue: (sale) => documentsForKind(sale, "conditions"),
    formatValue: formatDocuments,
    documentMatcher: (document) => documentMatchesKind(document, "conditions"),
  },
  {
    id: "pv_description",
    section: "sale",
    label: "PV descriptif",
    fieldIds: ["pv_description"],
    importance: "high",
    readValue: (sale) => documentsForKind(sale, "pv"),
    formatValue: formatDocuments,
    documentMatcher: (document) => documentMatchesKind(document, "pv"),
  },
  {
    id: "diagnostics_documents",
    section: "sale",
    label: "Pièces de diagnostics",
    fieldIds: ["diagnostics_documents"],
    importance: "high",
    readValue: (sale) => documentsForKind(sale, "diagnostics"),
    formatValue: formatDocuments,
    documentMatcher: (document) => documentMatchesKind(document, "diagnostics"),
  },
];

const DIRECT_PUBLIC_FIELDS = new Set([
  "property_type",
  "address",
  "postal_code",
  "city",
  "department",
  "rooms_count",
  "bedrooms_count",
  "bathrooms_count",
  "occupancy_status",
  "starting_price_eur",
  "sale_date",
  "parking_count",
]);

const DIRECT_PUBLIC_FIELD_VALUES: Record<string, (sale: AuctionSale) => unknown> = {
  property_type: (sale) => sale.property_type,
  address: (sale) => sale.address,
  postal_code: (sale) => sale.postal_code,
  city: (sale) => sale.city,
  department: (sale) => sale.department,
  rooms_count: (sale) => sale.rooms_count,
  bedrooms_count: (sale) => sale.bedrooms_count,
  bathrooms_count: (sale) => sale.bathrooms_count,
  occupancy_status: (sale) => sale.occupancy_status,
  starting_price_eur: (sale) => sale.starting_price_eur,
  sale_date: (sale) => sale.sale_date,
  parking_count: (sale) => sale.parking_count,
};

export function getListingPublicInformation(
  sale: AuctionSale,
  facts?: FactReliabilityMap | null,
  options?: PublicListingInformationOptions,
): PublicListingInformation {
  const completeness = getListingCompleteness(sale);
  const fieldMap = new Map(completeness.fields.map((field) => [field.id, field]));
  const documents = collectSaleDocuments(sale);
  const built = PUBLIC_FIELD_DEFINITIONS.flatMap((definition) => {
    const selectedFieldIds = selectFieldIds(definition, sale, completeness, fieldMap);
    const fields = selectedFieldIds
      .map((id) => fieldMap.get(id) ?? null)
      .filter((field): field is CompletenessFieldResult => Boolean(field));
    if (!fields.length || !fields.some((field) => field.applicable)) return [];

    const field = fields.find((candidate) => candidate.applicable) ?? null;
    const value = readDefinitionValue(definition, sale, completeness, field, fields);
    const rawState = fields.reduce<CompletenessState | null>(
      (state, candidate) => mergeState(state, candidate.state),
      null,
    );
    const displayValue = definition.formatValue
      ? definition.formatValue(value, sale)
      : formatScalar(value);
    const fact = facts && definition.keyFact ? facts[definition.keyFact] : null;
    const evidenceFields = fieldsForDisplayedValue(definition, fields, value, sale);
    const sourceDocuments = definition.documentMatcher
      ? documents.filter(definition.documentMatcher)
      : documents;
    const sources = sourcesForFields({
      sale,
      field,
      fields: evidenceFields,
      fieldIds: selectedFieldIds,
      documents: sourceDocuments,
      includeDocumentSources: Boolean(definition.documentMatcher),
    });
    const completeSources = hasCompleteSourceProof(
      definition,
      sale,
      evidenceFields,
      sourceDocuments,
      sources,
    );
    const blocked = isBlockedDefinition(definition, options?.blockedFieldIds);
    const status = blocked
      ? ("reported" as const)
      : resolveStatus({
          definition,
          estimatedValue: definition.estimated?.(sale) ?? false,
          value,
          displayValue,
          state: rawState,
          fact,
          hasSources: sources.length > 0,
          completeSources,
        });
    const publicSources = blocked || status === "missing" ? [] : sources;
    const normalizedValue = blocked || status === "missing" ? null : displayValue;
    return [
      {
        id: definition.id,
        label: publicLabel(definition, sale),
        value: normalizedValue,
        status,
        explanation: blocked
          ? "Cette information reste à confirmer avant de pouvoir être affichée."
          : explanationFor(
              status,
              publicSources.length > 0,
              fields.find((candidate) => candidate.extractionExcluded || candidate.reason) ?? field,
            ),
        sources: publicSources,
      } satisfies PublicListingFact,
    ];
  });

  const items = dedupeFacts(built);
  const sections = SECTION_DEFINITIONS.map((section) => ({
    ...section,
    items: items.filter((item) =>
      PUBLIC_FIELD_DEFINITIONS.some(
        (definition) => definition.id === item.id && definition.section === section.id,
      ),
    ),
  }));
  const priorityItems = items
    .filter((item) => item.status !== "sourced")
    .sort((left, right) => publicPriority(left) - publicPriority(right));

  const sourcedCount = items.filter((item) => item.status === "sourced").length;
  const missingCount = items.filter((item) => item.status === "missing").length;
  const toConfirmCount = items.length - sourcedCount - missingCount;

  return {
    sections,
    items,
    total: items.length,
    sourcedCount,
    missingCount,
    toConfirmCount,
    priorityItems,
  };
}

function selectFieldIds(
  definition: PublicField,
  sale: AuctionSale,
  completeness: ListingCompletenessResult,
  fieldMap: Map<string, CompletenessFieldResult>,
): string[] {
  if (definition.id === "surface") return [surfaceFieldId(sale, fieldMap)];
  if (definition.documentMatcher) return definition.fieldIds;
  if (definition.id === "location") {
    return definition.fieldIds.filter(
      (id) => (fieldMap.get(id)?.applicable ?? false) && isPublicFieldApplicable(id, sale),
    );
  }
  if (definition.id === "bathrooms_count") {
    return definition.fieldIds.filter(
      (id) => (fieldMap.get(id)?.applicable ?? false) && isPublicFieldApplicable(id, sale),
    );
  }
  if (definition.id === "condition") {
    return definition.fieldIds.filter(
      (id) => (fieldMap.get(id)?.applicable ?? false) && isPublicFieldApplicable(id, sale),
    );
  }
  if (definition.id === "heating_mode") {
    return definition.fieldIds.filter(
      (id) => (fieldMap.get(id)?.applicable ?? false) && isPublicFieldApplicable(id, sale),
    );
  }
  // Keep the argument visible here: applicability comes from the internal
  // catalogue, while the public list itself remains deliberately allowlisted.
  void completeness;
  return definition.fieldIds.filter(
    (id) => (fieldMap.get(id)?.applicable ?? false) && isPublicFieldApplicable(id, sale),
  );
}

function isPublicFieldApplicable(fieldId: string, sale: AuctionSale): boolean {
  const propertyType = normalize(sale.property_type);
  const isLand = /^(?:land|terrain|parcelle|agricole|bois)(?:_|$)/.test(propertyType);
  if (!isLand) return true;
  return !new Set([
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "shower_rooms_count",
    "floor_number",
    "heating_mode",
    "heating_energy",
    "heating_distribution",
    "elevator",
    "terrace",
    "balcony",
    "cellar",
    "dpe_class",
    "ges_class",
    "energy_consumption_kwh_m2_year",
    "emissions_kg_co2_m2_year",
    "dpe_established_at",
    "occupancy_status",
    "lease_status",
    "rent_eur",
    "lease_end_date",
    "coownership",
    "coownership_charges_eur",
    "coownership_works",
  ]).has(fieldId);
}

function surfaceFieldId(sale: AuctionSale, fieldMap: Map<string, CompletenessFieldResult>): string {
  const display = getDisplaySurface(sale);
  if (display.kind === "land") return "land_surface_m2";
  const appKind = normalize(sale.app_surface_kind);
  if (appKind.includes("carrez")) return "surface_carrez_m2";
  if (appKind.includes("habitable")) return "surface_habitable_m2";
  if (sale.app_surface_m2 != null && fieldMap.get("surface_built_m2")?.applicable) {
    return "surface_built_m2";
  }
  if (sale.habitable_surface_m2 != null && fieldMap.get("surface_habitable_m2")?.applicable) {
    return "surface_habitable_m2";
  }
  if (sale.carrez_surface_m2 != null && fieldMap.get("surface_carrez_m2")?.applicable) {
    return "surface_carrez_m2";
  }
  return "surface_built_m2";
}

function readDefinitionValue(
  definition: PublicField,
  sale: AuctionSale,
  completeness: ListingCompletenessResult,
  field: CompletenessFieldResult | null,
  fields: CompletenessFieldResult[],
): unknown {
  if (definition.readValue) return definition.readValue(sale, completeness);
  if (definition.directField) {
    const read = DIRECT_PUBLIC_FIELD_VALUES[definition.directField];
    if (read) return read(sale);
  }
  if (definition.id === "surface") return getDisplaySurface(sale).value;
  if (!field) return null;
  // Canonical fields are authoritative for the visible object. This guard is
  // intentional: completeness also reads private/raw observations, which can
  // retain a value after an authenticated display projection has masked it.
  if (DIRECT_PUBLIC_FIELDS.has(field.id)) {
    const read = DIRECT_PUBLIC_FIELD_VALUES[field.id];
    return read ? read(sale) : null;
  }
  for (const candidate of [field, ...fields]) {
    const candidateValue = candidate.canonicalValue ?? candidate.value;
    if (hasDisplayableValue(candidateValue)) return candidateValue;
  }
  return null;
}

function readBathrooms(
  sale: AuctionSale,
  completeness: ListingCompletenessResult,
): { bathrooms: unknown; showers: unknown } {
  const bathroomField = completeness.fields.find((candidate) => candidate.id === "bathrooms_count");
  const showerField = completeness.fields.find(
    (candidate) => candidate.id === "shower_rooms_count",
  );
  return {
    bathrooms:
      sale.bathrooms_count ?? bathroomField?.canonicalValue ?? bathroomField?.value ?? null,
    showers: showerField?.canonicalValue ?? showerField?.value ?? null,
  };
}

function readSaleDate(sale: AuctionSale, completeness: ListingCompletenessResult): unknown {
  if (cleanText(sale.sale_date)) return sale.sale_date;
  const schedule = completeness.fields.find((candidate) => candidate.id === "sale_schedule");
  return (
    schedule?.canonicalValue ?? schedule?.value ?? saleWindow(sale) ?? saleSession(sale) ?? null
  );
}

function hasCompleteSourceProof(
  definition: PublicField,
  sale: AuctionSale,
  fields: CompletenessFieldResult[],
  documents: ReturnType<typeof collectSaleDocuments>,
  sources: PublicListingSource[],
): boolean {
  if (!sources.length) return false;
  if (definition.documentMatcher) {
    const safeDocuments = documents.filter((document) => safeExternalHttpUrl(document.url));
    if (safeDocuments.length > 0) {
      const documentUrls = new Set(
        safeDocuments.map((document) => safeExternalHttpUrl(document.url)),
      );
      const sourcedUrls = new Set(
        sources
          .filter((source) => source.kind === "document" && source.url)
          .map((source) => source.url),
      );
      return [...documentUrls].every((url) => url && sourcedUrls.has(url));
    }
  }
  const displayedFields =
    definition.id === "sale_date"
      ? fields
      : fields.filter((field) => hasDisplayableValue(field.canonicalValue ?? field.value));
  if (!displayedFields.length) return false;
  return displayedFields.every((field) =>
    field.evidence.some((evidence) => projectEvidence(evidence, sale, documents).length > 0),
  );
}

function publicLabel(definition: PublicField, sale: AuctionSale): string {
  if (definition.id !== "surface") return definition.label;
  const display = getDisplaySurface(sale);
  if (display.kind === "land") return "Surface du terrain";
  const surfaceKind = normalize(sale.app_surface_kind);
  if (surfaceKind.includes("carrez")) return "Surface Carrez";
  if (surfaceKind.includes("habitable")) return "Surface habitable";
  return definition.label;
}

function isBlockedDefinition(
  definition: PublicField,
  blockedFieldIds: ReadonlySet<string> | undefined,
): boolean {
  if (!blockedFieldIds) return false;
  if (blockedFieldIds.has(definition.id)) return true;
  return definition.fieldIds.some(
    (fieldId) =>
      blockedFieldIds.has(fieldId) ||
      blockedFieldIds.has(`property.${fieldId}`) ||
      blockedFieldIds.has(`sale.${fieldId}`),
  );
}

function publicPriority(item: PublicListingFact): number {
  const definition = PUBLIC_FIELD_DEFINITIONS.find((candidate) => candidate.id === item.id);
  const importance =
    definition?.importance === "critical"
      ? 0
      : definition?.importance === "high"
        ? 1
        : definition?.importance === "medium"
          ? 2
          : 3;
  const status =
    item.status === "conflict"
      ? 0
      : item.status === "missing"
        ? 1
        : item.status === "estimated"
          ? 2
          : 3;
  return (
    status * 1000 + importance * 100 + (definition?.priority ?? PRIORITY_IDS.get(item.id) ?? 999)
  );
}

function resolveStatus({
  definition,
  estimatedValue,
  value,
  displayValue,
  state,
  fact,
  hasSources,
  completeSources,
}: {
  definition: PublicField;
  estimatedValue: boolean;
  value: unknown;
  displayValue: string | null;
  state: CompletenessState | null;
  fact: FactReliabilityMap[KeyFact] | null;
  hasSources: boolean;
  completeSources: boolean;
}): PublicFactStatus {
  if (fact?.status === "conflict" || state === "conflict") return "conflict";
  if (estimatedValue && displayValue != null) return "estimated";
  if (fact?.status === "inferred" || state === "inferred") {
    return displayValue == null ? "missing" : "estimated";
  }
  if (definition.customStatus) {
    const custom = definition.customStatus(value, state);
    if (custom) return custom;
  }
  if (displayValue == null) return "missing";
  if (state === "explicitly_absent") return completeSources ? "sourced" : "missing";
  if (hasSources && completeSources && state !== "unknown") return "sourced";
  // A canonical value can be useful to an internaute even when the exact
  // source reference is not attached yet. It must remain visibly reported.
  return "reported";
}

function explanationFor(
  status: PublicFactStatus,
  hasSources: boolean,
  field: CompletenessFieldResult | null,
): string {
  if (status === "sourced") {
    return hasSources
      ? "Information rattachée à la source indiquée."
      : "Information indiquée dans le dossier.";
  }
  if (status === "reported") return "Information disponible, source à préciser.";
  if (status === "estimated") {
    return "Valeur estimée à partir des informations disponibles ; elle reste à confirmer.";
  }
  if (status === "conflict") {
    return "Des sources indiquent des valeurs différentes ; cette information est à confirmer.";
  }
  const availability = availabilityExplanation(field);
  return availability ?? "Cette information n’est pas disponible dans notre dossier à ce jour.";
}

function availabilityExplanation(field: CompletenessFieldResult | null): string | null {
  if (!field) return null;
  const reason = normalize(field.reason?.availability_reason ?? field.reason?.code);
  if (
    field.extractionExcluded ||
    [
      "document_locked",
      "page_inaccessible",
      "paywall",
      "source_not_disclosed",
      "inaccessible",
      "access_denied",
    ].includes(reason)
  ) {
    return "La source ou le document n'est pas accessible pour le moment.";
  }
  if (
    ["not_extracted", "extraction_pending", "document_available_not_extracted"].includes(reason)
  ) {
    return "Le document est disponible, mais cette information n'a pas encore été extraite.";
  }
  return null;
}

function sourcesForFields(context: FieldSourceContext): PublicListingSource[] {
  const projected = context.fields.flatMap((field) =>
    field.evidence.flatMap((evidence) =>
      projectEvidence(evidence, context.sale, context.documents),
    ),
  );

  if (context.includeDocumentSources) {
    projected.push(
      ...context.documents
        .map<PublicListingSource | null>((document) => {
          const url = safeExternalHttpUrl(document.url);
          if (!url) return null;
          return {
            label: cleanText(document.label) ?? cleanText(document.type) ?? "Pièce du dossier",
            url,
            excerpt: null,
            page: null,
            capturedAt: null,
            kind: "document" as const,
          };
        })
        .filter((source): source is PublicListingSource => source !== null),
    );
  }
  return dedupeSources(projected);
}

function fieldsForDisplayedValue(
  definition: PublicField,
  fields: CompletenessFieldResult[],
  value: unknown,
  sale: AuctionSale,
): CompletenessFieldResult[] {
  if (definition.id === "sale_date") {
    const selectedId = cleanText(sale.sale_date) ? "sale_date" : "sale_schedule";
    return fields.filter((field) => field.id === selectedId);
  }
  if (definition.id === "bathrooms_count") {
    return fields.filter((field) => hasDisplayableValue(field.canonicalValue ?? field.value));
  }
  if (definition.readValue || definition.id === "location" || definition.id === "surface") {
    return fields;
  }
  if (definition.directField) {
    const direct = fields.filter((field) => field.id === definition.directField);
    return direct.length ? direct : fields;
  }
  const matching = fields.find(
    (field) =>
      hasDisplayableValue(field.canonicalValue ?? field.value) &&
      formatScalar(field.canonicalValue ?? field.value) === formatScalar(value),
  );
  if (matching) return [matching];
  const firstWithValue = fields.find((field) =>
    hasDisplayableValue(field.canonicalValue ?? field.value),
  );
  return firstWithValue ? [firstWithValue] : fields;
}

function projectEvidence(
  evidence: CompletenessEvidence,
  sale: AuctionSale,
  documents: FieldSourceContext["documents"],
): PublicListingSource[] {
  const rawUrl = evidence.url ?? evidence.source_url;
  const url = safeExternalHttpUrl(rawUrl);
  const excerpt = cleanExcerpt(
    evidence.excerpt ?? evidence.quote ?? evidence.text ?? evidence.snippet,
  );
  const page = positivePage(evidence.page ?? evidence.page_number);
  // A source_url on the sale itself is deliberately not used here. A public
  // link counts only when this field's evidence carries its own URL and a
  // locator/excerpt proving that the reference is attached to this fact.
  if (!url || (!excerpt && page == null)) return [];
  const documentMatch = documents.find((document) => safeExternalHttpUrl(document.url) === url);
  const kind = documentMatch ? "document" : evidenceKind(evidence, sale, url);
  return [
    {
      label:
        cleanText(evidence.document_label) ??
        cleanText(evidence.source_name) ??
        cleanText(evidence.source) ??
        (kind === "document" ? "Pièce du dossier" : "Source de l'annonce"),
      url,
      excerpt,
      page,
      capturedAt: cleanDate(evidence.captured_at),
      kind,
    },
  ];
}

function evidenceKind(
  evidence: CompletenessEvidence,
  sale: AuctionSale,
  url: string,
): PublicListingSource["kind"] {
  const rawKind = normalize(evidence.kind);
  if (rawKind === "document" || rawKind === "piece" || rawKind === "pdf") return "document";
  if (rawKind === "listing" || rawKind === "annonce" || rawKind === "source") return "listing";
  const sourceUrls = [sale.source_url, ...(Array.isArray(sale.source_urls) ? sale.source_urls : [])]
    .map(safeExternalHttpUrl)
    .filter((candidate): candidate is string => Boolean(candidate));
  if (sourceUrls.includes(url)) return "listing";
  if (/annonce|source/i.test(`${evidence.source_name ?? ""} ${evidence.source ?? ""}`)) {
    return "listing";
  }
  return "other";
}

function formatLocation(sale: AuctionSale): string | null {
  const values = [
    sale.address,
    [sale.postal_code, sale.city].filter(Boolean).join(" "),
    sale.department,
  ]
    .map(cleanText)
    .filter((value): value is string => Boolean(value));
  return values.length ? [...new Set(values)].join(", ") : null;
}

function formatVisits(value: unknown): string | null {
  if (!Array.isArray(value)) return formatScalar(value);
  const values = value.map(cleanText).filter((item): item is string => Boolean(item));
  return values.length ? values.join(" · ") : null;
}

function formatDocuments(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const count = value.filter((item) => item && typeof item === "object").length;
  if (!count) return null;
  return `${count} document${count > 1 ? "s" : ""} disponible${count > 1 ? "s" : ""}`;
}

function formatBathrooms(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parts = [
    countValue(record.bathrooms, "salle de bains", "salles de bains"),
    countValue(record.showers, "salle d’eau", "salles d’eau"),
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function formatSaleDate(value: unknown): string | null {
  if (typeof value === "string") return formatHumanDate(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return formatScalar(value);
  const record = value as Record<string, unknown>;
  const opens = formatHumanDate(record.opens_at);
  const closes = formatHumanDate(record.closes_at);
  if (opens && closes) return `Du ${opens} au ${closes}`;
  return opens ?? closes ?? formatScalar(value);
}

function documentsForKind(
  sale: AuctionSale,
  kind: "conditions" | "pv" | "diagnostics",
): ReturnType<typeof collectSaleDocuments> {
  return collectSaleDocuments(sale).filter((document) => documentMatchesKind(document, kind));
}

function documentMatchesKind(
  document: ReturnType<typeof collectSaleDocuments>[number],
  kind: "conditions" | "pv" | "diagnostics",
): boolean {
  const haystack = normalize(
    `${document.label ?? ""} ${document.name ?? ""} ${document.type ?? ""}`,
  );
  if (kind === "conditions") return /cahier|condition|ccv/.test(haystack);
  if (kind === "pv") return /\bpv\b|descriptif/.test(haystack);
  return /diagnostic|dpe|ges|energie|énergie/.test(haystack);
}

function formatBoolean(value: unknown): string | null {
  return typeof value === "boolean" ? (value ? "Oui" : "Non") : null;
}

function formatBooleanOrText(value: unknown): string | null {
  return typeof value === "boolean" ? formatBoolean(value) : formatScalar(value);
}

function formatMoneyOrText(value: unknown): string | null {
  return isFiniteNumber(value) ? formatPrice(value) : formatScalar(value);
}

function formatPaymentTerms(value: unknown): string | null {
  if (isFiniteNumber(value) && value > 0) return `${formatDecimal(value)} jours`;
  if (typeof value === "string" && /^\d+(?:[,.]\d+)?$/.test(value.trim())) {
    return `${value.trim().replace(",", ".")} jours`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const days = record.payment_deadline_days ?? record.days ?? record.delay_days;
    if (isFiniteNumber(days) && days > 0) return `${formatDecimal(days)} jours`;
  }
  return formatScalar(value);
}

function moneyValue(value: unknown): string | null {
  return isFiniteNumber(value) ? formatPrice(value) : null;
}

function formatHumanDate(value: unknown): string | null {
  if (typeof value !== "string" || !cleanText(value)) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    const withTime = /T\d{2}:\d{2}/.test(value);
    return withTime ? formatDateTime(value) : listingDate(value);
  }
  return listingDate(value);
}

function formatFloor(value: unknown): string | null {
  if (!isFiniteNumber(value)) return formatScalar(value);
  if (value === 0) return "Rez-de-chaussée";
  if (value < 0) return `${Math.abs(value)}e sous-sol`;
  return `${value === 1 ? "1er" : `${value}e`} étage`;
}

function countValue(value: unknown, singular: string, plural: string): string | null {
  if (!isFiniteNumber(value) || value < 0) return null;
  const formatted = formatDecimal(value);
  return `${formatted} ${value === 1 ? singular : plural}`;
}

function upperCode(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.toLocaleUpperCase("fr-FR") : null;
}

function humanEnum(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const normalized = normalize(text);
  const labels: Record<string, string> = {
    collective: "Collectif",
    individual: "Individuel",
    electric: "Électrique",
    gas: "Gaz",
    oil: "Fioul",
    wood: "Bois",
    in_person: "En présentiel",
    online: "En ligne",
    hybrid: "En ligne et en présentiel",
    lawyer_mandate: "Par mandat d'avocat",
  };
  return labels[normalized] ?? text.replaceAll("_", " ");
}

function formatScalar(value: unknown): string | null {
  if (typeof value === "boolean") return formatBoolean(value);
  if (isFiniteNumber(value)) return formatDecimal(value);
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    const values = value.map(formatScalar).filter((item): item is string => Boolean(item));
    return values.length ? values.join(", ") : null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["label", "name", "text", "value", "title"]) {
      const candidate = formatScalar(record[key]);
      if (candidate) return candidate;
    }
    return null;
  }
  return null;
}

function hasDisplayableValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return cleanText(value) !== null;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return formatScalar(value) !== null;
}

function dedupeFacts(items: PublicListingFact[]): PublicListingFact[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeSources(sources: PublicListingSource[]): PublicListingSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = [source.url, source.page, source.excerpt, source.label].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeState(current: CompletenessState | null, next: CompletenessState): CompletenessState {
  if (current === "conflict" || next === "conflict") return "conflict";
  if (current === "inferred" || next === "inferred") return "inferred";
  if (current === "observed" || next === "observed") return "observed";
  if (current === "explicitly_absent" || next === "explicitly_absent") return "explicitly_absent";
  if (current === "unknown" || next === "unknown") return "unknown";
  return next;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || MISSING_TEXT.has(normalize(text))) return null;
  return text;
}

function cleanExcerpt(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.slice(0, 600) : null;
}

function cleanDate(value: unknown): string | null {
  const text = cleanText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function positivePage(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value);
}

function normalize(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLocaleLowerCase("fr-FR")
        .replace(/[\s-]+/g, "_")
    : "";
}

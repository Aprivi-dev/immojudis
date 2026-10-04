import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import { ListingQualityNotice } from "@/components/ListingQualityNotice";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { getDisplaySurface } from "@/lib/surface";
import { listingOccupation } from "@/lib/listing-evidence";
import {
  getFactPresentation,
  getFactReliabilityForDisplay,
  type FactPresentation,
  type FactPresentationKind,
  type FactReliabilityMap,
  type KeyFact,
} from "@/lib/fact-reliability";
import { listingVisits } from "@/lib/sale-listing";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleSourceLinks } from "@/lib/sale-source-links";
import { saleSession, saleWindow } from "@/lib/sale-window";
import {
  getListingCompleteness,
  type CompletenessState,
  type ListingCompletenessResult,
} from "@/lib/listing-completeness";
import type { AuctionSale } from "@/lib/types";

const MISSING_TEXT_MARKERS = new Set([
  "-",
  "—",
  "a confirmer",
  "inconnu",
  "n/a",
  "non renseigne",
  "non renseignee",
  "unknown",
]);

const CHECKLIST = [
  { key: "propertyType", label: "Type de bien" },
  { key: "description", label: "Description de l’annonce" },
  { key: "location", label: "Localisation" },
  { key: "surface", label: "Surface publiée" },
  { key: "occupation", label: "Occupation du bien" },
  { key: "price", label: "Prix de départ / mise à prix" },
  { key: "schedule", label: "Date ou échéance" },
  { key: "visits", label: "Dates de visite" },
  { key: "organizer", label: "Organisateur / contact" },
  { key: "participation", label: "Modalités de participation" },
  { key: "documents", label: "Pièces du dossier" },
  { key: "source", label: "Source de l’annonce" },
] as const;

export type ListingDataCoverageKey = (typeof CHECKLIST)[number]["key"];

const KEY_FACT_FIELDS: ReadonlyArray<{ key: ListingDataCoverageKey; field: KeyFact }> = [
  { key: "surface", field: "surface" },
  { key: "occupation", field: "occupancy_status" },
  { key: "price", field: "starting_price_eur" },
  { key: "schedule", field: "sale_date" },
];

export type ListingDataCoverageItem = {
  key: ListingDataCoverageKey;
  label: string;
  present: boolean;
};

export type ListingDataCoverageKeyFact = {
  key: ListingDataCoverageKey;
  label: string;
  presentation: FactPresentation;
};

export type ListingDataCoverageResult = {
  percentage: number;
  presentCount: number;
  missingCount: number;
  total: number;
  items: ListingDataCoverageItem[];
  present: ListingDataCoverageItem[];
  missing: ListingDataCoverageItem[];
  toConfirm: Array<ListingDataCoverageItem & { detail: string }>;
  keyFacts: ListingDataCoverageKeyFact[];
  completeness: ListingCompletenessResult;
};

export type ListingDataCoverageProps = {
  sale: AuctionSale;
  className?: string;
  factReliabilities?: FactReliabilityMap | null;
  coverage?: ListingDataCoverageResult;
};

/**
 * Returns true only for a non-empty value that is not one of the sentinel
 * values used by source feeds when a field is unavailable.
 */
function hasMeaningfulText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const normalized = trimmed
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR");
  return !MISSING_TEXT_MARKERS.has(normalized);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasPropertyType(sale: AuctionSale): boolean {
  if (!hasMeaningfulText(sale.property_type)) return false;
  const normalized = sale.property_type
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR");
  return !["bien", "bien a qualifier", "other"].includes(normalized);
}

function hasDescription(sale: AuctionSale): boolean {
  return [
    sale.llm_display_description,
    sale.about_description,
    sale.source_description,
    sale.description,
  ].some(hasMeaningfulText);
}

function hasLocation(sale: AuctionSale): boolean {
  return [sale.address, sale.postal_code, sale.city, sale.department].some(hasMeaningfulText);
}

function hasPublishedSurface(sale: AuctionSale): boolean {
  const surface = getDisplaySurface(sale);

  // getDisplaySurface can estimate an area from a property type or room count.
  // Estimates are deliberately excluded from this coverage score.
  return surface.value != null && (surface.kind === "recorded" || surface.kind === "land");
}

function hasPublishedPrice(sale: AuctionSale): boolean {
  return (
    typeof sale.starting_price_eur === "number" &&
    Number.isFinite(sale.starting_price_eur) &&
    sale.starting_price_eur > 0
  );
}

function hasSchedule(sale: AuctionSale): boolean {
  return (
    hasMeaningfulText(sale.sale_date) || saleWindow(sale) !== null || saleSession(sale) !== null
  );
}

function hasOrganizer(sale: AuctionSale): boolean {
  const procedure = getSaleProcedure(sale);
  return [
    procedure.organizerName,
    procedure.organizerContact,
    procedure.venueName,
    procedure.venueAddress,
  ].some(hasMeaningfulText);
}

function hasParticipationDetails(sale: AuctionSale): boolean {
  const embedded = asRecord(sale.sale_procedure) ?? asRecord(sale.source_blocks?.sale_procedure);
  const rules = asRecord(embedded?.rules);
  const participationMode = embedded?.participation_mode;
  const stateSaleMethod = embedded?.state_sale_method;

  return (
    (hasMeaningfulText(participationMode) && participationMode !== "unknown") ||
    (hasMeaningfulText(stateSaleMethod) && stateSaleMethod !== "unknown") ||
    typeof rules?.lawyer_required === "boolean" ||
    hasMeaningfulText(rules?.bid_method) ||
    hasMeaningfulText(embedded?.eligible_bar) ||
    sale.sale_venue_type === "online"
  );
}

function hasSource(sale: AuctionSale): boolean {
  return (
    saleSourceLinks(sale).length > 0 ||
    hasMeaningfulText(sale.source_name) ||
    hasMeaningfulText(sale.primary_source)
  );
}

/**
 * Computes coverage from a fixed, visible checklist of material listing
 * fields. This measures presence only; it does not infer quality or verify a
 * value against a source.
 */
export function getListingDataCoverage(
  sale: AuctionSale,
  facts?: FactReliabilityMap | null,
): ListingDataCoverageResult {
  const occupation = listingOccupation(sale);
  const presence: Record<ListingDataCoverageKey, boolean> = {
    propertyType: hasPropertyType(sale),
    description: hasDescription(sale),
    location: hasLocation(sale),
    surface: hasPublishedSurface(sale),
    occupation:
      hasMeaningfulText(occupation) && !["Non renseignée", "À confirmer"].includes(occupation),
    price: hasPublishedPrice(sale),
    schedule: hasSchedule(sale),
    visits: listingVisits(sale).length > 0,
    organizer: hasOrganizer(sale),
    participation: hasParticipationDetails(sale),
    documents: collectSaleDocuments(sale).length > 0,
    source: hasSource(sale),
  };

  const items = CHECKLIST.map(({ key, label }) => ({
    key,
    label,
    present: presence[key],
  }));
  const present = items.filter((item) => item.present);
  const missing = items.filter((item) => !item.present);
  const total = items.length;
  const procedure = getSaleProcedure(sale);
  const schedule = saleWindow(sale) ?? saleSession(sale);
  const displayedDate =
    (procedure.venueType === "state" ? schedule?.closes_at : schedule?.opens_at) ?? sale.sale_date;
  const keyFacts = KEY_FACT_FIELDS.map(({ key, field }) => {
    const item = items.find((candidate) => candidate.key === key)!;
    return {
      key,
      label: item.label,
      presentation: getFactPresentation(
        sale,
        field,
        field === "sale_date" ? displayedDate : undefined,
        facts,
      ),
    };
  });
  const toConfirm = present.flatMap((item) => {
    const field = KEY_FACT_FIELDS.find((candidate) => candidate.key === item.key)?.field;
    if (!field) return [];
    const fact = getFactReliabilityForDisplay(
      sale,
      field,
      field === "sale_date" ? displayedDate : undefined,
      facts,
    );
    return fact.status === "observed" ? [] : [{ ...item, detail: fact.detail }];
  });

  return {
    percentage: Math.round((present.length / total) * 100),
    presentCount: present.length,
    missingCount: missing.length,
    total,
    items,
    present,
    missing,
    toConfirm,
    keyFacts,
    completeness: getListingCompleteness(sale),
  };
}

function completenessStateLabel(state: CompletenessState): string {
  return {
    observed: "renseigné",
    inferred: "estimé / déduit",
    unknown: "non renseigné",
    explicitly_absent: "absent selon la source",
    not_applicable: "hors périmètre",
    conflict: "sources divergentes",
  }[state];
}

const COMPLETENESS_STATE_CLASSES: Record<CompletenessState, string> = {
  observed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  inferred: "border-amber-200 bg-amber-50 text-amber-800",
  unknown: "border-slate-200 bg-slate-50 text-slate-600",
  explicitly_absent: "border-sky-200 bg-sky-50 text-sky-800",
  not_applicable: "border-slate-200 bg-slate-100 text-slate-500",
  conflict: "border-rose-200 bg-rose-50 text-rose-800",
};

const PRACTICAL_PRIORITY_FIELD_IDS = [
  "sale_date",
  "starting_price_eur",
  "address",
  "surface_habitable_m2",
  "surface_carrez_m2",
  "surface_built_m2",
  "rooms_count",
  "bedrooms_count",
  "floor_number",
  "dpe_class",
  "heating_mode",
  "heating_energy",
  "occupancy_status",
  "occupancy_details",
  "conditions_sale",
  "documents_inventory",
  "visit_dates",
  "participation_mode",
  "payment_terms",
  "coownership_charges_eur",
] as const;

const PRACTICAL_PRIORITY_RANK = new Map<string, number>(
  PRACTICAL_PRIORITY_FIELD_IDS.map((fieldId, index) => [fieldId, index]),
);

function displayMissingFields(
  fields: ListingCompletenessResult["missing"],
): ListingCompletenessResult["missing"] {
  return [...fields]
    .sort((left, right) => {
      const leftRank = PRACTICAL_PRIORITY_RANK.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = PRACTICAL_PRIORITY_RANK.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const importance = { critical: 0, high: 1, medium: 2, optional: 3 } as const;
      return importance[left.importance] - importance[right.importance];
    })
    .slice(0, 10);
}

function displayFieldValue(field: ListingCompletenessResult["fields"][number]): string | null {
  if (["unknown", "not_applicable", "conflict"].includes(field.state)) return null;
  if (field.value === null || field.value === undefined || field.value === "") return null;
  if (typeof field.value === "boolean") return field.value ? "Oui" : "Non";
  if (typeof field.value === "number" && Number.isFinite(field.value)) {
    return `${field.value}${field.unit ? ` ${field.unit}` : ""}`;
  }
  if (Array.isArray(field.value)) {
    const values = field.value
      .filter((value) => value != null)
      .map(String)
      .join(", ");
    return values ? (values.length > 100 ? `${values.slice(0, 97)}…` : values) : null;
  }
  if (field.id === "lawyer_contact" && typeof field.value === "object") {
    const contact = field.value as Record<string, unknown>;
    const phone = typeof contact.phone === "string" ? contact.phone.trim() : "";
    const email = typeof contact.email === "string" ? contact.email.trim() : "";
    const legacy = typeof contact.value === "string" ? contact.value.trim() : "";
    const channels = [
      phone ? `Téléphone : ${phone}` : null,
      email ? `Email : ${email}` : null,
      legacy && legacy !== phone && legacy !== email ? legacy : null,
    ].filter((value): value is string => Boolean(value));
    return channels.length ? channels.join(" · ") : null;
  }
  if (typeof field.value === "object") return "Donnée structurée";
  const value = String(field.value).replace(/\s+/g, " ").trim();
  return value ? (value.length > 100 ? `${value.slice(0, 97)}…` : value) : null;
}

function displaySourceName(source: string): string {
  return source === "Projection canonique" ? "Données collectées · source non rattachée" : source;
}

function displayPriorityFields(
  completeness: ListingCompletenessResult,
): Array<ListingCompletenessResult["missing"][number]> {
  const seen = new Set<string>();
  return displayMissingFields([...completeness.missing, ...completeness.toConfirm]).filter(
    (field) => {
      if (seen.has(field.id)) return false;
      seen.add(field.id);
      return true;
    },
  );
}

function completenessFieldDetail(
  field: ListingCompletenessResult["fields"][number],
  completeness: ListingCompletenessResult,
): string {
  const issue = [...completeness.missing, ...completeness.toConfirm].find(
    (candidate) => candidate.id === field.id,
  );
  if (issue) return `${issue.reason} ${issue.nextAction}`;
  if (field.state === "explicitly_absent") return "La source indique explicitement l’absence.";
  if (field.state === "not_applicable") {
    return field.reason?.explanation ?? "Ce critère ne concerne pas cette vente.";
  }
  if (field.state === "observed") return "Valeur renseignée dans les données disponibles.";
  return "";
}

const FACT_PRESENTATION_CLASSES: Record<FactPresentationKind, string> = {
  documented: "border-emerald-200 bg-emerald-50 text-emerald-800",
  reported: "border-sky-200 bg-sky-50 text-sky-800",
  estimated: "border-amber-200 bg-amber-50 text-amber-800",
  review: "border-amber-200 bg-amber-50 text-amber-900",
  missing: "border-slate-200 bg-slate-50 text-slate-600",
  conflict: "border-rose-200 bg-rose-50 text-rose-800",
};

export function ListingDataCoverage({
  sale,
  className,
  factReliabilities,
  coverage: providedCoverage,
}: ListingDataCoverageProps) {
  const coverage = providedCoverage ?? getListingDataCoverage(sale, factReliabilities);
  const completeness = coverage.completeness;
  const practicalMissing = displayPriorityFields(completeness);
  const fieldsByCategory = completeness.categories.map((category) => ({
    ...category,
    fields: completeness.fields.filter((field) => field.category === category.id),
  }));
  const classNames = ["mt-5", className].filter(Boolean).join(" ");

  return (
    <section className={classNames} aria-label="Détail des informations du dossier">
      <details className="group rounded-xl border border-slate-200 bg-slate-50/55">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-3.5 py-3 text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 sm:px-4">
          <span>Voir le détail des informations et de leur origine</span>
          <span className="font-normal text-slate-500">
            {coverage.presentCount}/{coverage.total} champs clés
          </span>
          <ChevronDown
            className="ml-auto h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>

        <div className="space-y-4 border-t border-slate-200 p-3.5 sm:p-4">
          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">Synthèse de la collecte</h3>
            <p className="mt-1 text-xs font-medium text-slate-600">
              {completeness.contextLabel} · {completeness.profile.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              {completeness.applicableFieldCount} critères applicables ·{" "}
              {completeness.notApplicableFieldCount} hors périmètre · indice pondéré de
              renseignement {completeness.completenessScore}%.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-600">
              {completeness.observedFieldCount} renseignés · {completeness.inferredFieldCount}{" "}
              estimés / déduits · {completeness.unknownFieldCount} non renseignés ·{" "}
              {completeness.conflictFieldCount} sources divergentes.
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Cet indice décrit les données conservées et leur état de collecte. Il ne constitue ni
              une validation du dossier ni une recommandation de décision.
            </p>
            {completeness.gateFailures.length > 0 ? (
              <div className="mt-3 text-xs leading-relaxed text-amber-800">
                <p className="font-semibold">
                  {completeness.gateFailures.length} contrôle
                  {completeness.gateFailures.length > 1 ? "s" : ""} critique
                  {completeness.gateFailures.length > 1 ? "s" : ""} à revoir
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {completeness.gateFailures.map((gate) => (
                    <li key={gate.id}>
                      {gate.label} · {gate.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-xs font-medium text-emerald-800">
                Aucun contrôle critique en échec dans les données reçues.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">Champs clés</h3>
              <span className="text-xs font-medium text-slate-500">
                {coverage.presentCount}/{coverage.total} présents
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              La présence d’une valeur ne préjuge pas de sa vérification dans la source.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {coverage.keyFacts.map((fact) => (
                <li key={fact.key} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-slate-800">{fact.label}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${FACT_PRESENTATION_CLASSES[fact.presentation.kind]}`}
                    >
                      {fact.presentation.label}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                    {fact.presentation.detail}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Champs clés non renseignés ({coverage.missingCount})
            </h3>
            {coverage.missing.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {coverage.missing.map((item) => (
                  <li key={item.key} className="flex items-start gap-2 text-xs text-slate-700">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                Aucun champ clé n’est absent des données reçues.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">Priorités à examiner</h3>
            {practicalMissing.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {practicalMissing.map((item) => (
                  <li key={item.id} className="text-xs leading-relaxed text-slate-700">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-slate-500">
                      {" "}
                      · {completenessStateLabel(item.state)} · {item.reason} {item.nextAction}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">Aucun critère applicable à examiner.</p>
            )}
            {completeness.missing.length + completeness.toConfirm.length >
            practicalMissing.length ? (
              <p className="mt-2 text-xs text-slate-500">
                D’autres critères sont détaillés dans la liste exhaustive ci-dessous.
              </p>
            ) : null}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">Origine des informations</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Profil retenu : {completeness.profile.label}. Les valeurs estimées ou déduites sont
              signalées dans la liste exhaustive.
            </p>
            {Object.keys(completeness.knownBySource).length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {Object.entries(completeness.knownBySource).map(([source, fieldIds]) => (
                  <li key={source} className="text-xs leading-relaxed text-slate-700">
                    <span className="font-medium">{displaySourceName(source)}</span>
                    <span className="text-slate-500"> · {fieldIds.length} critères associés</span>
                    <span className="mt-0.5 block text-slate-500">
                      {fieldIds
                        .slice(0, 4)
                        .map(
                          (fieldId) =>
                            completeness.fields.find((field) => field.id === fieldId)?.label ??
                            "Critère non libellé",
                        )
                        .join(" · ")}
                      {fieldIds.length > 4 ? " · …" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                Aucune origine n’est encore enregistrée pour les informations disponibles.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              {completeness.fields.length} critères du dossier
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Chaque critère garde un état lisible : renseigné, estimé / déduit, non renseigné,
              absent selon la source, hors périmètre ou sources divergentes.
            </p>
            <div className="mt-3 space-y-3">
              {fieldsByCategory.map(({ fields, ...category }) => (
                <section
                  key={category.id}
                  className="overflow-hidden rounded-lg border border-slate-200"
                >
                  <div className="flex flex-col gap-1 bg-slate-50 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between">
                    <h4 className="text-xs font-semibold text-slate-800">{category.label}</h4>
                    <p className="text-[11px] text-slate-500">
                      {fields.length} critères · {category.knownCount} renseignés ou estimés ·{" "}
                      {category.missingCount} à revoir · {category.notApplicableCount} hors
                      périmètre
                    </p>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {fields.map((field) => {
                      const value = displayFieldValue(field);
                      const detail = completenessFieldDetail(field, completeness);
                      const source = field.sourceNames.length
                        ? field.sourceNames.map(displaySourceName).join(" · ")
                        : null;
                      return (
                        <li key={field.id} className="px-3 py-2.5">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-800">{field.label}</p>
                              {source ? (
                                <p className="mt-0.5 text-[10px] text-slate-500">
                                  Origine : {source}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${COMPLETENESS_STATE_CLASSES[field.state]}`}
                              >
                                {completenessStateLabel(field.state)}
                              </span>
                              {value ? (
                                <span className="max-w-[13rem] break-words whitespace-normal text-[10px] leading-relaxed text-slate-500">
                                  {value}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {detail ? (
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                              {detail}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-3.5 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">Répartition par catégorie</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {completeness.categories.map((category) => (
                <div key={category.id} className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-xs font-medium text-slate-800">{category.label}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {category.ratio == null ? "Hors périmètre" : `Indice ${category.ratio}%`} ·{" "}
                    {category.knownCount} renseignés ou estimés · {category.missingCount} à revoir
                  </p>
                </div>
              ))}
            </div>
          </section>

          <ListingQualityNotice sale={sale} />
        </div>
      </details>
    </section>
  );
}

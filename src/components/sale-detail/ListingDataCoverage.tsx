import { useId } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { getDisplaySurface } from "@/lib/surface";
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
  "unknown",
]);

const CHECKLIST = [
  { key: "propertyType", label: "Type de bien" },
  { key: "description", label: "Description de l’annonce" },
  { key: "location", label: "Localisation" },
  { key: "surface", label: "Surface publiée" },
  { key: "price", label: "Prix de départ / mise à prix" },
  { key: "schedule", label: "Date ou échéance" },
  { key: "visits", label: "Dates de visite" },
  { key: "organizer", label: "Organisateur / contact" },
  { key: "participation", label: "Modalités de participation" },
  { key: "documents", label: "Pièces du dossier" },
  { key: "source", label: "Source de l’annonce" },
] as const;

export type ListingDataCoverageKey = (typeof CHECKLIST)[number]["key"];

export type ListingDataCoverageItem = {
  key: ListingDataCoverageKey;
  label: string;
  present: boolean;
};

export type ListingDataCoverageResult = {
  percentage: number;
  presentCount: number;
  missingCount: number;
  total: number;
  items: ListingDataCoverageItem[];
  present: ListingDataCoverageItem[];
  missing: ListingDataCoverageItem[];
  completeness: ListingCompletenessResult;
};

export type ListingDataCoverageProps = {
  sale: AuctionSale;
  className?: string;
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
export function getListingDataCoverage(sale: AuctionSale): ListingDataCoverageResult {
  const presence: Record<ListingDataCoverageKey, boolean> = {
    propertyType: hasPropertyType(sale),
    description: hasDescription(sale),
    location: hasLocation(sale),
    surface: hasPublishedSurface(sale),
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

  return {
    percentage: Math.round((present.length / total) * 100),
    presentCount: present.length,
    missingCount: missing.length,
    total,
    items,
    present,
    missing,
    completeness: getListingCompleteness(sale),
  };
}

function completenessStateLabel(state: CompletenessState): string {
  return {
    observed: "observé",
    inferred: "inféré",
    unknown: "inconnu",
    explicitly_absent: "absent explicitement",
    not_applicable: "non applicable",
    conflict: "en conflit",
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
  if (typeof field.value === "object") return "Donnée structurée";
  const value = String(field.value).replace(/\s+/g, " ").trim();
  return value ? (value.length > 100 ? `${value.slice(0, 97)}…` : value) : null;
}

function displaySourceName(source: string): string {
  return source === "Projection canonique" ? "Données de l’annonce" : source;
}

function completenessClassLabel(
  classification: ListingCompletenessResult["classification"],
): string {
  return {
    incomplet: "À compléter",
    a_enrichir: "À enrichir",
    decision_prete: "Prête pour décision",
    riche: "Fiche riche",
  }[classification];
}

export function ListingDataCoverage({ sale, className }: ListingDataCoverageProps) {
  const coverage = getListingDataCoverage(sale);
  const completeness = coverage.completeness;
  const practicalMissing = displayMissingFields(completeness.missing);
  const fieldsByCategory = completeness.categories.map((category) => ({
    ...category,
    fields: completeness.fields.filter((field) => field.category === category.id),
  }));
  const headingId = useId();
  const presentHeadingId = `${headingId}-present`;
  const missingHeadingId = `${headingId}-missing`;
  const classNames = [
    "mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classNames} aria-labelledby={headingId}>
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Complétude de l’annonce · 130 critères
          </p>
          <h2 id={headingId} className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
            Richesse des informations
          </h2>
          <p className="mt-1 text-xs font-medium text-slate-600">
            {completeness.contextLabel} · {completeness.profile.label}
          </p>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <p className="text-3xl font-semibold tracking-tight text-slate-950">
            {completeness.completenessScore}%
          </p>
          <p className="text-xs font-medium text-slate-600">
            {completenessClassLabel(completeness.classification)}
          </p>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-800">Couverture des informations</h3>
          <p className="text-sm font-semibold text-slate-800">
            {coverage.presentCount}/{coverage.total} champs clés
          </p>
        </div>
        <div
          className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label={`Couverture des ${coverage.total} champs clés`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={coverage.percentage}
          aria-valuetext={`${coverage.percentage}% des informations clés présentes`}
        >
          <span
            className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${coverage.percentage}%` }}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          {coverage.missingCount > 0
            ? `${coverage.missingCount} champ${coverage.missingCount > 1 ? "s" : ""} à compléter ou à vérifier.`
            : "Tous les champs clés sont présents dans les données reçues."}
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Mesure détaillée · 130 critères
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-900">
              {completeness.contextLabel} · {completeness.profile.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              {completeness.applicableFieldCount} critères applicables ·{" "}
              {completeness.notApplicableFieldCount} non applicables
            </p>
          </div>
          <div className="shrink-0 text-left sm:text-right">
            <p className="text-2xl font-semibold tracking-tight text-slate-950">
              {completeness.completenessScore}%
            </p>
            <p className="text-xs font-medium text-slate-600">
              {completenessClassLabel(completeness.classification)}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-600">
          {completeness.observedFieldCount} observés · {completeness.inferredFieldCount} inférés ·{" "}
          {completeness.unknownFieldCount} inconnus · {completeness.conflictFieldCount} en conflit.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Le score mesure les informations reçues et leurs preuves ; il ne remplace pas la lecture
          des pièces de la vente.
        </p>
        {completeness.gateFailures.length > 0 ? (
          <p className="mt-2 text-xs font-medium leading-relaxed text-amber-800">
            {completeness.gateFailures.length} contrôle
            {completeness.gateFailures.length > 1 ? "s" : ""} critique
            {completeness.gateFailures.length > 1 ? "s" : ""} à résoudre avant de considérer la
            fiche comme complète.
          </p>
        ) : (
          <p className="mt-2 text-xs font-medium text-emerald-800">
            Les contrôles critiques sont levés pour cette procédure.
          </p>
        )}
      </div>

      <details className="group mt-4 rounded-xl border border-slate-200 bg-slate-50/55">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-3.5 py-3 text-sm font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-500 sm:px-4">
          <span>Voir les détails</span>
          <span className="font-normal text-slate-500">
            {coverage.presentCount} présents · {coverage.missingCount} manquants
          </span>
          <ChevronDown
            className="ml-auto h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>

        <div className="grid gap-3 border-t border-slate-200 p-3.5 sm:p-4 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/45 p-3.5">
            <h3 id={presentHeadingId} className="text-sm font-semibold text-emerald-950">
              Informations présentes ({coverage.presentCount})
            </h3>
            {coverage.present.length > 0 ? (
              <ul aria-labelledby={presentHeadingId} className="mt-3 space-y-2">
                {coverage.present.map((item) => (
                  <li key={item.key} className="flex items-start gap-2 text-sm text-slate-700">
                    <CheckCircle2
                      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700"
                      aria-hidden
                    />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-600">Aucune information clé reçue.</p>
            )}
          </div>

          <div className="rounded-xl border border-amber-200/80 bg-amber-50/55 p-3.5">
            <h3 id={missingHeadingId} className="text-sm font-semibold text-amber-950">
              Informations manquantes ({coverage.missingCount})
            </h3>
            {coverage.missing.length > 0 ? (
              <ul aria-labelledby={missingHeadingId} className="mt-3 space-y-2">
                {coverage.missing.map((item) => (
                  <li key={item.key} className="flex items-start gap-2 text-sm text-slate-700">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                    <span>{item.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-600">Aucune information clé manquante.</p>
            )}
          </div>

          <p className="text-xs leading-relaxed text-slate-500 md:col-span-2">
            Le taux mesure la présence des champs reçus, pas leur niveau de vérification.
          </p>

          <div className="rounded-xl border border-slate-200 bg-white p-3.5 md:col-span-2 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Ce qu’il reste à compléter en priorité
            </h3>
            {practicalMissing.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {practicalMissing.map((item) => (
                  <li key={item.id} className="text-xs leading-relaxed text-slate-700">
                    <span className="font-medium">{item.label}</span>
                    <span className="text-slate-500">
                      {" "}
                      · {completenessStateLabel(item.state)} · {item.reason}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                Aucun critère applicable ne reste inconnu.
              </p>
            )}
            {completeness.missing.length > practicalMissing.length ? (
              <p className="mt-2 text-xs text-slate-500">
                {completeness.missing.length - practicalMissing.length} autre
                {completeness.missing.length - practicalMissing.length > 1 ? "s" : ""} critère
                {completeness.missing.length - practicalMissing.length > 1 ? "s" : ""} reste
                {completeness.missing.length - practicalMissing.length > 1 ? "nt" : ""} à revoir
                dans la liste exhaustive ci-dessous.
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3.5 md:col-span-2 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Informations connues par source
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Profil retenu : {completeness.profile.label}. Les valeurs inférées sont affichées
              comme telles et demandent une confirmation.
            </p>
            {Object.keys(completeness.knownBySource).length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {Object.entries(completeness.knownBySource).map(([source, fieldIds]) => (
                  <li key={source} className="text-xs leading-relaxed text-slate-700">
                    <span className="font-medium">{displaySourceName(source)}</span>
                    <span className="text-slate-500"> · {fieldIds.length} critères connus</span>
                    <span className="mt-0.5 block text-slate-500">
                      {fieldIds
                        .slice(0, 4)
                        .map(
                          (fieldId) =>
                            completeness.fields.find((field) => field.id === fieldId)?.label ??
                            fieldId,
                        )
                        .join(" · ")}
                      {fieldIds.length > 4 ? " · …" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                Aucune preuve de champ n’est encore rattachée à une source.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3.5 md:col-span-2 sm:p-4">
            <details className="group/criteria">
              <summary className="flex cursor-pointer list-none items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900">
                    Voir les 130 critères
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                    {completeness.known.length} connus · {completeness.missing.length} à revoir ·{" "}
                    {completeness.notApplicableFieldCount} non applicables
                  </span>
                </span>
                <ChevronDown
                  className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-slate-500 transition-transform group-open/criteria:rotate-180"
                  aria-hidden
                />
              </summary>

              <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                <p className="text-xs leading-relaxed text-slate-500">
                  Chaque critère conserve son état de preuve. « Inconnu » indique qu’aucune donnée
                  exploitable n’a été conservée ; « non applicable » dépend du bien ou de la
                  procédure.
                </p>
                {fieldsByCategory.map(({ fields, ...category }) => (
                  <section
                    key={category.id}
                    className="overflow-hidden rounded-lg border border-slate-200"
                  >
                    <div className="flex flex-col gap-1 bg-slate-50 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between">
                      <h4 className="text-xs font-semibold text-slate-800">{category.label}</h4>
                      <p className="text-[11px] text-slate-500">
                        {fields.length} critères · {category.knownCount} connus ·{" "}
                        {category.missingCount} à revoir · {category.notApplicableCount} N/A
                      </p>
                    </div>
                    <ul className="divide-y divide-slate-100">
                      {fields.map((field) => {
                        const value = displayFieldValue(field);
                        return (
                          <li
                            key={field.id}
                            className="flex items-start justify-between gap-3 px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-slate-800">{field.label}</p>
                              <p className="mt-0.5 truncate text-[10px] text-slate-400">
                                {field.id}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${COMPLETENESS_STATE_CLASSES[field.state]}`}
                              >
                                {completenessStateLabel(field.state)}
                              </span>
                              {value ? (
                                <span className="max-w-[13rem] text-[10px] leading-relaxed text-slate-500">
                                  {value}
                                </span>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </details>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3.5 md:col-span-2 sm:p-4">
            <h3 className="text-sm font-semibold text-slate-900">Répartition par catégorie</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {completeness.categories.map((category) => (
                <div key={category.id} className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-xs font-medium text-slate-800">{category.label}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {category.ratio == null ? "Non applicable" : `${category.ratio}%`} ·{" "}
                    {category.knownCount} connus · {category.missingCount} à revoir
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}

import { useId } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { getDisplaySurface } from "@/lib/surface";
import { listingVisits } from "@/lib/sale-listing";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleSourceLinks } from "@/lib/sale-source-links";
import { saleSession, saleWindow } from "@/lib/sale-window";
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
  };
}

export function ListingDataCoverage({ sale, className }: ListingDataCoverageProps) {
  const coverage = getListingDataCoverage(sale);
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
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Données disponibles
          </p>
          <h2 id={headingId} className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
            Couverture des informations
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
            Présence des principaux champs reçus pour cette annonce.
          </p>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <p className="text-3xl font-semibold tracking-tight text-slate-950">
            {coverage.percentage}%
          </p>
          <p className="text-xs font-medium text-slate-500">
            {coverage.presentCount} sur {coverage.total} informations clés
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div
          className="h-2.5 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-label="Couverture des informations"
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
          Le taux mesure la présence des champs reçus, pas leur niveau de vérification.
        </p>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/45 p-3.5">
          <h3 id={presentHeadingId} className="text-sm font-semibold text-emerald-950">
            Informations présentes ({coverage.presentCount})
          </h3>
          {coverage.present.length > 0 ? (
            <ul aria-labelledby={presentHeadingId} className="mt-3 space-y-2">
              {coverage.present.map((item) => (
                <li key={item.key} className="flex items-start gap-2 text-sm text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
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
      </div>
    </section>
  );
}

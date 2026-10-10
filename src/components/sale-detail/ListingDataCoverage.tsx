"use client";

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { getDisplaySurface } from "@/lib/surface";
import { listingOccupation } from "@/lib/listing-evidence";
import {
  getFactPresentation,
  getFactReliabilityForDisplay,
  type FactPresentation,
  type FactReliabilityMap,
  type KeyFact,
} from "@/lib/fact-reliability";
import { listingVisits } from "@/lib/sale-listing";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleSourceLinks } from "@/lib/sale-source-links";
import { saleSession, saleWindow } from "@/lib/sale-window";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { getListingCompleteness, type ListingCompletenessResult } from "@/lib/listing-completeness";
import {
  getListingPublicInformation,
  type PublicListingFact,
  type PublicListingInformation,
  type PublicListingSource,
} from "@/lib/listing-public-information";
import styles from "./ListingDataCoverage.module.css";
import type { AuctionSale } from "@/lib/types";
import { asRecordOrNull } from "@/lib/guards";

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
  publicInformation?: PublicListingInformation;
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
  const embedded =
    asRecordOrNull(sale.sale_procedure) ?? asRecordOrNull(sale.source_blocks?.sale_procedure);
  const rules = asRecordOrNull(embedded?.rules);
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

const STATUS_LABELS: Record<PublicListingFact["status"], string> = {
  sourced: "Source à préciser",
  reported: "Source à préciser",
  estimated: "Estimation",
  missing: "Information manquante",
  conflict: "Sources à départager",
};

const STATUS_CLASSES = {
  estimated: styles.statusEstimated,
  conflict: styles.statusConflict,
} as const;

const SOURCE_KIND_LABELS: Record<PublicListingSource["kind"], string> = {
  listing: "Annonce d’origine",
  document: "Document joint",
  other: "Source consultée",
};

function sourceName(source: PublicListingSource): string {
  const label = source.label.trim();
  return label || "Source";
}

function sourcePage(source: PublicListingSource): string {
  return source.page != null && Number.isFinite(source.page) ? " · p." + source.page : "";
}

function sourceButtonLabel(fact: PublicListingFact): string {
  const firstSource = fact.sources[0];
  if (!firstSource) return STATUS_LABELS[fact.status];
  const additionalSources = fact.sources.length > 1 ? " · +" + (fact.sources.length - 1) : "";
  return sourceName(firstSource) + sourcePage(firstSource) + additionalSources;
}

function factValue(fact: PublicListingFact): string {
  if (fact.status === "missing") return "Information manquante";
  if (fact.value?.trim()) return fact.value.trim();
  if (fact.status === "reported") return "À confirmer";
  if (fact.status === "conflict") return "Valeur non tranchée";
  if (fact.status === "estimated") return "Estimation indisponible";
  return "Information manquante";
}

function statusBadgeLabel(fact: PublicListingFact): string | null {
  if (fact.status === "estimated") return "Estimation";
  if (fact.status === "conflict") return "Sources à départager";
  return null;
}

function factActionLabel(fact: PublicListingFact): string | null {
  if (fact.sources.length > 0) {
    if (fact.status === "estimated") return "Voir l’origine";
    if (fact.status === "conflict") return "Comparer les sources";
    return sourceButtonLabel(fact);
  }
  if (fact.status === "reported") return "Source à préciser";
  if (fact.status === "missing") return fact.explanation.trim() ? "En savoir plus" : null;
  if (fact.status === "estimated" || fact.status === "conflict") {
    return fact.explanation.trim() ? "Voir l’origine" : null;
  }
  return fact.explanation.trim() ? "En savoir plus" : null;
}

function factActionAriaLabel(fact: PublicListingFact, label: string): string {
  if (fact.status === "reported" && fact.sources.length === 0) {
    return label + " pour " + fact.label;
  }
  if (fact.status === "conflict" && fact.sources.length > 1) {
    return label + " pour " + fact.label;
  }
  if (fact.status === "estimated") return label + " de " + fact.label;
  if (fact.sources.length > 1) return "Voir les sources de " + fact.label;
  return fact.sources.length > 0
    ? "Voir la source de " + fact.label
    : "En savoir plus sur " + fact.label;
}

function capturedAtLabel(capturedAt: string | null): string | null {
  const value = capturedAt?.trim();
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
  }).format(new Date(timestamp));
}

type SourceDialogProps = {
  fact: PublicListingFact | null;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: { current: HTMLButtonElement | null };
};

function SourceDialog({ fact, onOpenChange, returnFocusRef }: SourceDialogProps) {
  return (
    <Dialog open={fact !== null} onOpenChange={onOpenChange}>
      {fact ? (
        <DialogContent
          className={styles.sourceDialog}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocusRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{fact.label}</DialogTitle>
            <DialogDescription>{factValue(fact)}</DialogDescription>
          </DialogHeader>

          {fact.explanation?.trim() ? (
            <p className={styles.explanation}>{fact.explanation.trim()}</p>
          ) : null}

          {fact.sources.length > 0 ? (
            <div className={styles.sourceList}>
              {fact.sources.map((source, index) => {
                const href = safeExternalHttpUrl(source.url);
                const capturedAt = capturedAtLabel(source.capturedAt);

                return (
                  <article
                    className={styles.sourceCard}
                    key={source.label + "-" + (source.page ?? "no-page") + "-" + index}
                  >
                    <div className={styles.sourceCardHeader}>
                      <div>
                        <p className={styles.sourceKind}>{SOURCE_KIND_LABELS[source.kind]}</p>
                        <h3 className={styles.sourceTitle}>{sourceName(source)}</h3>
                      </div>
                      {source.page != null && Number.isFinite(source.page) ? (
                        <span className={styles.sourcePage}>p. {source.page}</span>
                      ) : null}
                    </div>

                    {source.excerpt?.trim() ? (
                      <blockquote className={styles.excerpt}>{source.excerpt.trim()}</blockquote>
                    ) : null}

                    <div className={styles.sourceDetails}>
                      {capturedAt ? <span>Consultée le {capturedAt}</span> : null}
                      {href ? (
                        <a
                          className={styles.sourceLink}
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Ouvrir la source
                          <span aria-hidden="true"> ↗</span>
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className={styles.noSource}>
              Aucune source détaillée n’est rattachée à cette information pour le moment.
            </p>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export type PublicListingFactSourceProps = {
  fact: PublicListingFact;
};

export function PublicListingFactSource({ fact }: PublicListingFactSourceProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const badgeLabel = statusBadgeLabel(fact);
  const actionLabel = factActionLabel(fact);

  if (!badgeLabel && !actionLabel) return null;

  return (
    <div className={styles.factSource}>
      {badgeLabel ? (
        <span
          className={[
            styles.status,
            fact.status === "estimated" ? STATUS_CLASSES.estimated : STATUS_CLASSES.conflict,
          ].join(" ")}
        >
          {badgeLabel}
        </span>
      ) : null}
      {actionLabel ? (
        <button
          ref={triggerRef}
          type="button"
          className={styles.sourceButton}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={factActionAriaLabel(fact, actionLabel)}
        >
          {actionLabel}
        </button>
      ) : null}
      <SourceDialog
        fact={open ? fact : null}
        returnFocusRef={triggerRef}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setOpen(false);
        }}
      />
    </div>
  );
}

type PublicInformationSectionProps = {
  section: PublicListingInformation["sections"][number];
  defaultOpen: boolean;
};

function PublicInformationSection({ section, defaultOpen }: PublicInformationSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className={styles.accordion}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.summary}>
        <span>{section.title}</span>
        <span className={styles.sectionCount}>
          {section.items.length} information{section.items.length > 1 ? "s" : ""}
        </span>
      </summary>
      <ul className={styles.factList}>
        {section.items.map((fact) => (
          <li className={styles.factCard} key={fact.id}>
            <p className={styles.factLabel}>{fact.label}</p>
            <p className={styles.factValue}>{factValue(fact)}</p>
            <div className={styles.factMeta}>
              <PublicListingFactSource fact={fact} />
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ListingDataCoverage({
  sale,
  className,
  factReliabilities,
  publicInformation: providedPublicInformation,
}: ListingDataCoverageProps) {
  const information =
    providedPublicInformation ?? getListingPublicInformation(sale, factReliabilities);
  const sections = information.sections.filter((section) => section.items.length > 0);
  const classNames = [styles.root, className].filter(Boolean).join(" ");

  return (
    <section className={classNames} aria-label="Informations disponibles sur le bien">
      {sections.length > 0 ? (
        <div className={styles.accordionList}>
          {sections.map((section, index) => (
            <PublicInformationSection
              key={section.id}
              section={section}
              defaultOpen={index === 0}
            />
          ))}
        </div>
      ) : (
        <p className={styles.emptyState}>Aucune information n’est encore disponible.</p>
      )}
    </section>
  );
}

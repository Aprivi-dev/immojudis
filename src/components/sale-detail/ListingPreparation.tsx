"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ListingDataCoverage } from "@/components/sale-detail/ListingDataCoverage";
import {
  getListingPublicInformation,
  type PublicListingFact,
} from "@/lib/listing-public-information";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";
import type { FactReliabilityMap } from "@/lib/fact-reliability";
import {
  getAiReviewFieldResult,
  type AiReviewFieldKey,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import styles from "./ListingPreparation.module.css";

type ListingPreparationProps = {
  sale: AuctionSale;
  publicDemo?: boolean;
  ownerId?: string;
  canSimulate?: boolean;
  factReliabilities?: FactReliabilityMap | null;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
  onNavigate?: (href: string) => void;
};

const PERSONAL_NOTE_PREFIX = "immojudis:listing-personal-note:";
const PUBLIC_REVIEW_FIELDS: ReadonlyArray<[AiReviewFieldKey, readonly string[]]> = [
  ["property.property_type", ["property_type"]],
  ["property.city", ["location"]],
  ["sale.sale_date", ["sale_date", "visits"]],
  ["sale.starting_price_eur", ["starting_price_eur"]],
  ["property.rooms_count", ["rooms_count", "bedrooms_count"]],
  ["property.occupancy_status", ["occupancy_status", "lease_status", "rent_eur", "lease_end_date"]],
  ["property.parking_count", ["parking"]],
  ["property.habitable_surface_m2", ["surface"]],
  ["property.carrez_surface_m2", ["surface"]],
  ["property.land_surface_m2", ["surface"]],
  [
    "property.source_energy_dpe_class",
    ["dpe_class", "energy_consumption_kwh_m2_year", "dpe_established_at"],
  ],
  ["property.source_energy_ges_class", ["ges_class", "emissions_kg_co2_m2_year"]],
];

function localStorageKey(saleId: string, ownerId = "guest-demo"): string {
  return `${PERSONAL_NOTE_PREFIX}${encodeURIComponent(ownerId)}:${saleId}`;
}

function statusLabel(item: PublicListingFact): string {
  switch (item.status) {
    case "missing":
      return "information manquante";
    case "conflict":
      return "sources contradictoires";
    case "estimated":
      return "estimation à confirmer";
    case "reported":
      return item.value == null ? "à confirmer" : "source à préciser";
    default:
      return "information sourcée";
  }
}

export function ListingPreparation({
  sale,
  publicDemo = false,
  ownerId = "guest-demo",
  canSimulate = true,
  factReliabilities = null,
  aiReviewProjections = null,
  aiReviewStatus = "disabled",
  onNavigate,
}: ListingPreparationProps) {
  const information = useMemo(() => {
    const blockedFieldIds = new Set(
      PUBLIC_REVIEW_FIELDS.flatMap(([field, ids]) =>
        getAiReviewFieldResult(aiReviewProjections, field, aiReviewStatus).blocked ? ids : [],
      ),
    );
    return getListingPublicInformation(sale, factReliabilities, { blockedFieldIds });
  }, [sale, factReliabilities, aiReviewProjections, aiReviewStatus]);
  const procedure = useMemo(() => getSaleProcedure(sale), [sale]);
  const unresolved = information.items.filter((item) => item.status !== "sourced");
  const priorities = information.priorityItems.slice(0, 3);
  const missingEssentials = information.priorityItems
    .filter((item) => item.status === "missing" || item.status === "conflict")
    .slice(0, 3);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [personalNote, setPersonalNote] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saved" | "error">("idle");
  const checklistTriggerRef = useRef<HTMLButtonElement>(null);
  const storageOwner = ownerId.trim() || "guest-demo";

  const isTribunalSale = procedure.venueType === "tribunal";
  const preparationHref = isTribunalSale && canSimulate ? "#calculation" : "#rendez-vous";
  const preparationLabel = isTribunalSale ? "Préparer mon enchère" : "Préparer ma démarche";

  useEffect(() => {
    setPersonalNote("");
    setNoteStatus("idle");
    if (typeof window === "undefined") return;
    try {
      setPersonalNote(window.localStorage.getItem(localStorageKey(sale.id, storageOwner)) ?? "");
    } catch {
      setPersonalNote("");
      setNoteStatus("error");
    }
  }, [sale.id, storageOwner]);

  const navigateTo = (href: string) => {
    if (onNavigate) {
      onNavigate(href);
      return;
    }
    if (typeof window !== "undefined") window.location.hash = href.slice(1);
  };

  const savePersonalNote = () => {
    if (typeof window === "undefined") return;
    try {
      const key = localStorageKey(sale.id, storageOwner);
      if (personalNote.trim()) window.localStorage.setItem(key, personalNote.trim());
      else window.localStorage.removeItem(key);
      setNoteStatus("saved");
    } catch {
      setNoteStatus("error");
    }
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="listing-preparation-title"
      data-public-demo={publicDemo ? "true" : "false"}
    >
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Le dossier du bien</p>
          <h2 id="listing-preparation-title">Ce que nous savons de ce bien</h2>
          <p className={styles.summaryIntro}>
            Les informations de l’annonce et des documents disponibles, avec leur origine.
          </p>
        </div>
        <a
          className={styles.documentLink}
          href="#documents"
          onClick={(event) => {
            event.preventDefault();
            navigateTo("#documents");
          }}
        >
          <FileText aria-hidden="true" /> Documents et sources
        </a>
      </div>

      <div className={styles.coverageSummary} aria-label="Bilan des informations du bien">
        <p>{information.total} informations pertinentes pour ce bien</p>
        <ul>
          <li>
            <strong>{information.sourcedCount}</strong> avec une source
          </li>
          <li>
            <strong>{information.missingCount}</strong> manquante
            {information.missingCount > 1 ? "s" : ""}
          </li>
          <li>
            <strong>{information.toConfirmCount}</strong> à confirmer
          </li>
        </ul>
      </div>
      {missingEssentials.length > 0 ? (
        <p className={styles.essentialNotice}>
          <strong>À préciser en priorité :</strong>{" "}
          {missingEssentials.map((item) => item.label).join(" · ")}
        </p>
      ) : null}

      <ListingDataCoverage
        sale={sale}
        factReliabilities={factReliabilities}
        publicInformation={information}
      />

      <section className={styles.remaining} aria-labelledby="listing-remaining-title">
        <div className={styles.remainingHeader}>
          <div>
            <h3 id="listing-remaining-title">Ce qu’il reste à connaître</h3>
            <p>
              {unresolved.length
                ? "Les points à compléter ou à confirmer pour mieux comprendre le bien."
                : "Chaque information de cette grille est rattachée à une source consultable."}
            </p>
          </div>
          <button
            ref={checklistTriggerRef}
            type="button"
            className={styles.textButton}
            onClick={() => setChecklistOpen(true)}
          >
            {unresolved.length ? `Voir les ${unresolved.length} points` : "Mes notes"}
          </button>
        </div>
        {priorities.length > 0 ? (
          <ul className={styles.priorityList}>
            {priorities.map((item) => (
              <li key={item.id}>
                <strong>{item.label}</strong>
                <span>{item.explanation || statusLabel(item)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.remainingActions}>
          <a
            className={styles.textLink}
            href={preparationHref}
            onClick={(event) => {
              event.preventDefault();
              navigateTo(preparationHref);
            }}
          >
            {preparationLabel}
          </a>
        </div>
      </section>

      <Dialog open={checklistOpen} onOpenChange={setChecklistOpen}>
        <DialogContent
          className={styles.dialogContent}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            checklistTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Les informations à compléter ou confirmer</DialogTitle>
            <DialogDescription>
              Retrouvez les informations manquantes, les estimations et les sources à préciser. Vous
              pouvez garder une note personnelle pour préparer vos démarches.
            </DialogDescription>
          </DialogHeader>
          <ul className={styles.checklist} aria-label="Informations à compléter ou confirmer">
            {information.priorityItems.length ? (
              information.priorityItems.map((item) => (
                <li key={item.id}>
                  <span className={styles.checkMark} aria-hidden="true" />
                  <span>
                    <strong>{item.label}</strong> — {statusLabel(item)}
                  </span>
                </li>
              ))
            ) : (
              <li>Chaque information de la grille dispose d’une source.</li>
            )}
          </ul>
          <label className={styles.noteLabel} htmlFor={`listing-note-${sale.id}`}>
            Votre note personnelle <span>(optionnelle, conservée sur cet appareil)</span>
          </label>
          <textarea
            id={`listing-note-${sale.id}`}
            className={styles.noteInput}
            value={personalNote}
            onChange={(event) => {
              setPersonalNote(event.target.value);
              setNoteStatus("idle");
            }}
            placeholder="Ex. demander le DPE et confirmer le calendrier de visite…"
            rows={3}
          />
          <div className={styles.dialogFooter}>
            <span className={styles.status} role="status" aria-live="polite">
              {noteStatus === "saved"
                ? "Note enregistrée sur cet appareil."
                : noteStatus === "error"
                  ? "Impossible d’enregistrer la note ici."
                  : ""}
            </span>
            <button type="button" className={styles.secondaryButton} onClick={savePersonalNote}>
              Enregistrer ma note
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

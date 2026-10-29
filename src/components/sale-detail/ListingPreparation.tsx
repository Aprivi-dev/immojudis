"use client";

import Link from "next/link";
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
import { contactReportPath } from "@/lib/contact-message";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { riskEvidence } from "@/lib/risk-evidence";
import {
  POINTS_TO_VERIFY_ANCHOR,
  POINTS_TO_VERIFY_NOTE,
  type PointToVerify,
} from "@/lib/search/points-to-verify";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { Badge, type BadgeTone } from "@/components/ui/primitives";
import type { AuctionSale } from "@/lib/types";
import type { FactReliabilityMap } from "@/lib/fact-reliability";
import {
  getAiReviewFieldResult,
  type AiReviewFieldKey,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import styles from "./ListingPreparation.module.css";

type ListingInformationProps = {
  sale: AuctionSale;
  factReliabilities?: FactReliabilityMap | null;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
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

function statusTone(item: PublicListingFact): { label: string; tone: BadgeTone } {
  switch (item.status) {
    case "missing":
      return { label: "Manquante", tone: "neutral" };
    case "conflict":
      return { label: "Contradictoire", tone: "danger" };
    case "estimated":
      return { label: "Estimation", tone: "warning" };
    default:
      return { label: "À confirmer", tone: "warning" };
  }
}

/** Les informations publiques du bien, sans celles qu'une vérification en cours retient. */
function useListingInformation({
  sale,
  factReliabilities = null,
  aiReviewProjections = null,
  aiReviewStatus = "disabled",
}: ListingInformationProps) {
  return useMemo(() => {
    const blockedFieldIds = new Set(
      PUBLIC_REVIEW_FIELDS.flatMap(([field, ids]) =>
        getAiReviewFieldResult(aiReviewProjections, field, aiReviewStatus).blocked ? ids : [],
      ),
    );
    return getListingPublicInformation(sale, factReliabilities, { blockedFieldIds });
  }, [sale, factReliabilities, aiReviewProjections, aiReviewStatus]);
}

/** Point de la pastille de la liste → informations du dossier qui disent la même chose. */
const POINT_INFORMATION_IDS: Record<string, readonly string[]> = {
  surface: ["surface"],
  occupancy: ["occupancy_status"],
  date: ["sale_date"],
};

/**
 * « Ce que nous savons de ce bien » : le bilan des informations du dossier et leur grille, chacune
 * avec son origine. Ce qui reste ouvert est repris par `ListingChecks`.
 */
export function ListingPreparation({
  publicDemo = false,
  onNavigate,
  compactSources = false,
  ...props
}: ListingInformationProps & {
  publicDemo?: boolean;
  onNavigate?: (href: string) => void;
  /** Sources en icône à côté de chaque valeur, au lieu du nom de la pièce sous la valeur. */
  compactSources?: boolean;
}) {
  const information = useListingInformation(props);

  const navigateTo = (href: string) => {
    if (onNavigate) {
      onNavigate(href);
      return;
    }
    if (typeof window !== "undefined") window.location.hash = href.slice(1);
  };

  return (
    <section
      className={styles.section}
      aria-labelledby="listing-preparation-title"
      data-public-demo={publicDemo ? "true" : "false"}
    >
      <div className={styles.header}>
        <div>
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

      <div
        className={styles.coverageSummary}
        role="group"
        aria-label="Bilan des informations du bien"
      >
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

      <ListingDataCoverage
        sale={props.sale}
        factReliabilities={props.factReliabilities ?? null}
        publicInformation={information}
        compactSources={compactSources}
      />
    </section>
  );
}

/** Le rappel neutre sur le prix de départ, en tête de « L'essentiel à savoir » (vente aux enchères). */
export type StartingPriceSignal = { title: string; text: string; todo: string };

/**
 * « L'essentiel à savoir » : un seul bloc pour ce qui reste ouvert, cible de l'ancre
 * `#points-a-verifier` de la pastille de la liste. Il réunit le rappel sur le prix de départ, les
 * points relevés dans le dossier (offre Analyse), les points de la pastille et les informations
 * prioritaires à confirmer, sans doublon. Celles qui manquent tiennent en une ligne. La liste
 * complète et une note personnelle sont dans une fenêtre.
 */
export function ListingChecks({
  points,
  showRisks = false,
  saleId,
  ownerId = "guest-demo",
  preparation = null,
  startingPriceSignal = null,
  ...props
}: ListingInformationProps & {
  /** Rappel sur le prix de départ (vente aux enchères avec une mise à prix lisible). */
  startingPriceSignal?: StartingPriceSignal | null;
  points: readonly PointToVerify[];
  /** Points relevés dans les pièces (`sale.risks`) : réservés à l'offre Analyse. */
  showRisks?: boolean;
  /** Avec un identifiant, un compte connecté peut dire si la liste lui est utile. */
  saleId?: string;
  ownerId?: string;
  preparation?: { href: string; label: string } | null;
}) {
  const { sale } = props;
  const information = useListingInformation(props);
  const procedure = useMemo(() => getSaleProcedure(sale), [sale]);
  const risks = showRisks ? (sale.risks ?? []) : [];
  const documentCount = collectSaleDocuments(sale).length;
  const unresolved = information.items.filter((item) => item.status !== "sourced");
  // Un point relevé dans les pièces sur l'occupation dit déjà ce que la pastille et la grille disent.
  const risksCoverOccupancy = risks.some((risk) => /occup/i.test(risk.risk_type));
  const shownPoints = risksCoverOccupancy
    ? points.filter((point) => point.key !== "occupancy")
    : points;
  const coveredIds = new Set([
    ...points.flatMap((point) => POINT_INFORMATION_IDS[point.key] ?? []),
    ...(risksCoverOccupancy ? ["occupancy_status"] : []),
  ]);
  const priorities = information.priorityItems
    .slice(0, 3)
    .filter((item) => !coveredIds.has(item.id));
  // Les informations absentes tiennent en une ligne ; seules celles à départager ou à confirmer
  // gardent la leur.
  const missingPriorities = priorities.filter((item) => item.status === "missing");
  const openPriorities = priorities.filter((item) => item.status !== "missing");
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [personalNote, setPersonalNote] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saved" | "error">("idle");
  const checklistTriggerRef = useRef<HTMLButtonElement>(null);
  const storageOwner = ownerId.trim() || "guest-demo";
  const titleId = `${POINTS_TO_VERIFY_ANCHOR}-title`;
  const empty =
    risks.length === 0 &&
    shownPoints.length === 0 &&
    priorities.length === 0 &&
    !startingPriceSignal;

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
    <section id={POINTS_TO_VERIFY_ANCHOR} className={styles.section} aria-labelledby={titleId}>
      <div className={styles.header}>
        <div>
          <h2 id={titleId} tabIndex={-1}>
            L’essentiel à savoir
          </h2>
          <p className={styles.summaryIntro}>
            {procedure.venueType === "state"
              ? "Ce qu’il faut vérifier avant de vous positionner."
              : "Ce qu’il faut vérifier avant d’enchérir."}
          </p>
        </div>
        <button
          ref={checklistTriggerRef}
          type="button"
          className={styles.textButton}
          onClick={() => setChecklistOpen(true)}
        >
          {unresolved.length
            ? `Voir les ${unresolved.length} informations à compléter`
            : "Mes notes"}
        </button>
      </div>

      {empty ? (
        <p className={styles.checksEmpty}>
          Aucun point particulier n’est relevé dans les éléments disponibles. Vérifiez le dossier
          officiel avant de décider.
        </p>
      ) : (
        <ul id="risks" className={styles.checkList}>
          {startingPriceSignal ? (
            <li key="starting-price" className={styles.infoRow}>
              <div>
                <strong>{startingPriceSignal.title}</strong>
                <span>{startingPriceSignal.text}</span>
                <span className={styles.todo}>
                  <span>Que faire : </span>
                  {startingPriceSignal.todo}
                </span>
              </div>
              <Badge tone="info">Repère</Badge>
            </li>
          ) : null}
          {risks.map((risk) => (
            <li key={`risk-${risk.risk_type}-${risk.risk_label}`}>
              <div>
                <strong>{risk.risk_label}</strong>
                <span>{riskEvidence(risk).action}</span>
              </div>
              <Badge tone="warning">
                {risk.severity != null && risk.severity >= 4 ? "Prioritaire" : "À vérifier"}
              </Badge>
            </li>
          ))}
          {shownPoints.map((point) => (
            <li key={`point-${point.key}`}>
              <div>
                <strong>{point.label}</strong>
              </div>
              <Badge tone="warning">À vérifier</Badge>
            </li>
          ))}
          {openPriorities.map((item) => {
            const status = statusTone(item);
            return (
              <li key={`info-${item.id}`}>
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.explanation || statusLabel(item)}</span>
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}

      {missingPriorities.length ? (
        <p className={styles.missingLine}>
          <Badge tone="neutral">
            {missingPriorities.length === 1
              ? "1 information absente du dossier"
              : `${missingPriorities.length} informations absentes du dossier`}
          </Badge>{" "}
          {missingPriorities.map((item) => item.label).join(" · ")}. À demander à l’interlocuteur du
          dossier.
        </p>
      ) : null}

      <p className={styles.checksNote}>{POINTS_TO_VERIFY_NOTE}</p>

      <p className={styles.checksDocuments}>
        {documentCount > 0 ? `${documentCount} pièce(s) consultable(s)` : "Aucune pièce attachée"}
        {" · "}
        <a href="#documents">Consulter les pièces du dossier</a>
        {saleId ? (
          <>
            {" · "}
            <Link href={contactReportPath(saleId)}>Signaler une erreur sur cette fiche</Link>
            {" · "}
            <Link href={contactReportPath(saleId, "plafond")}>
              Signaler une erreur sur le plafond
            </Link>
          </>
        ) : null}
      </p>

      {risks.length ? (
        <details className={styles.checksEvidence}>
          <summary>Voir les sources et actions à confirmer</summary>
          <div>
            {risks.map((risk) => {
              const evidence = riskEvidence(risk);
              return (
                <article key={`${risk.risk_type}-${risk.risk_label}`}>
                  <h3>{risk.risk_label}</h3>
                  <p>{evidence.action}</p>
                  {evidence.proofs.map((proof, index) => (
                    <div key={`${index}-${proof.label}`}>
                      {proof.url ? (
                        <a href={proof.url} target="_blank" rel="noopener noreferrer">
                          {proof.label} (nouvel onglet)
                        </a>
                      ) : (
                        <span>{proof.label}</span>
                      )}
                      {proof.page != null ? <span> · page {proof.page}</span> : null}
                      {proof.excerpt ? <blockquote>{proof.excerpt}</blockquote> : null}
                    </div>
                  ))}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}

      {preparation ? (
        <div className={styles.remainingActions}>
          <a className={styles.textLink} href={preparation.href}>
            {preparation.label}
          </a>
        </div>
      ) : null}
      {saleId ? <SaleSignalFeedback saleId={saleId} signal="points_to_verify" /> : null}

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

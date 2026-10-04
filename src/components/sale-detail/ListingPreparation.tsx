"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Clipboard from "lucide-react/dist/esm/icons/clipboard.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import ListChecks from "lucide-react/dist/esm/icons/list-checks.js";
import MessageCircle from "lucide-react/dist/esm/icons/message-circle.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getListingDataCoverage,
  ListingDataCoverage,
  type ListingDataCoverageItem,
} from "@/components/sale-detail/ListingDataCoverage";
import { formatPrice } from "@/lib/format";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { saleDisplayTitle } from "@/lib/sale-title";
import type { AuctionSale } from "@/lib/types";
import type { FactReliabilityMap } from "@/lib/fact-reliability";
import styles from "./ListingPreparation.module.css";

type ListingPreparationProps = {
  sale: AuctionSale;
  publicDemo?: boolean;
  ownerId?: string;
  canSimulate?: boolean;
  factReliabilities?: FactReliabilityMap | null;
  onNavigate?: (href: string) => void;
};

type CopyState = "idle" | "copied" | "error";

const PERSONAL_NOTE_PREFIX = "immojudis:listing-personal-note:";

function localStorageKey(saleId: string, ownerId = "guest-demo"): string {
  return `${PERSONAL_NOTE_PREFIX}${encodeURIComponent(ownerId)}:${saleId}`;
}

function safeLocation(sale: AuctionSale): string {
  const city = sale.city?.trim();
  const postalCode = sale.postal_code?.trim();
  return [postalCode, city].filter(Boolean).join(" ") || "localisation non renseignée";
}

function missingLabels(items: ListingDataCoverageItem[]): string {
  if (!items.length) return "Aucun champ clé ne manque dans les informations reçues.";
  return items.map((item) => `- ${item.label}`).join("\n");
}

function buildRequestMessage(sale: AuctionSale, missing: ListingDataCoverageItem[]): string {
  const title = saleDisplayTitle(sale);
  const location = safeLocation(sale);
  const price = sale.starting_price_eur != null ? formatPrice(sale.starting_price_eur) : null;
  const references = [
    `Bien : ${title}`,
    `Localisation publiée : ${location}`,
    price ? `Mise à prix publiée : ${price}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  const questions = missing.length
    ? `Pourriez-vous me transmettre ou confirmer les éléments suivants ?\n${missingLabels(missing)}`
    : "Pourriez-vous me confirmer la version actuelle du dossier et les prochaines étapes de la vente ?";

  return `Bonjour,\n\nJe souhaite obtenir des informations complémentaires concernant cette annonce.\n\n${references}\n\n${questions}\n\nMerci par avance,\nCordialement`;
}

export function ListingPreparation({
  sale,
  publicDemo = false,
  ownerId = "guest-demo",
  canSimulate = true,
  factReliabilities = null,
  onNavigate,
}: ListingPreparationProps) {
  const coverage = useMemo(
    () => getListingDataCoverage(sale, factReliabilities),
    [sale, factReliabilities],
  );
  const procedure = useMemo(() => getSaleProcedure(sale), [sale]);
  const score = Math.round(coverage.completeness.completenessScore);
  const factGroups = [
    { kind: "conflict", label: "Sources divergentes", warning: true },
    { kind: "review", label: "À vérifier dans les pièces", warning: true },
    { kind: "estimated", label: "Estimations", warning: false },
    { kind: "reported", label: "Données non vérifiées", warning: false },
  ] as const;
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [personalNote, setPersonalNote] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saved" | "error">("idle");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [requestDraft, setRequestDraft] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const storageOwner = ownerId.trim() || "guest-demo";

  const requestMessage = useMemo(
    () => buildRequestMessage(sale, [...coverage.missing, ...coverage.toConfirm]),
    [coverage.missing, coverage.toConfirm, sale],
  );
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

  useEffect(() => {
    if (!requestOpen) return;
    setRequestDraft(requestMessage);
    setCopyState("idle");
  }, [requestMessage, requestOpen]);

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

  const copyRequest = async () => {
    setCopyState("idle");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(requestDraft);
      setCopyState("copied");
    } catch {
      setCopyState("error");
      messageRef.current?.focus();
      messageRef.current?.select();
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
          <p className={styles.eyebrow}>Les informations disponibles</p>
          <h2 id="listing-preparation-title">Dossier de vente</h2>
          <p className={styles.summaryIntro}>
            {coverage.presentCount} des {coverage.total} informations essentielles sont présentes.
          </p>
        </div>
        <div className={styles.coverage} aria-label={`Niveau de détail du dossier : ${score} %`}>
          <span className={styles.coverageValue}>{score}%</span>
          <span className={styles.coverageLabel}>Niveau de détail</span>
          <span className={styles.coverageHint}>Selon les critères applicables au dossier</span>
        </div>
      </div>

      <div className={styles.progressTrack} aria-hidden="true">
        <span style={{ width: `${score}%` }} />
      </div>
      <p className={styles.scoreExplanation}>
        Le score mesure le niveau de détail du dossier, pas l’exactitude des informations.
      </p>

      <div className={styles.informationSummary}>
        <div className={styles.summaryItem}>
          <strong>
            {coverage.missingCount ? "Informations à obtenir" : "L’essentiel est renseigné"}
          </strong>
          <p>
            {coverage.missingCount
              ? coverage.missing.map((item) => item.label).join(" · ")
              : "Les 12 informations essentielles sont présentes. Le dossier détaillé peut encore être complété."}
          </p>
        </div>
        {factGroups.map((group) => {
          const facts = coverage.keyFacts.filter(
            ({ presentation }) => presentation.kind === group.kind,
          );
          if (!facts.length) return null;
          return (
            <div
              key={group.kind}
              className={`${styles.summaryItem} ${group.warning ? styles.summaryWarning : ""}`}
            >
              <strong>{group.label}</strong>
              <p>{facts.map((fact) => fact.label).join(" · ")}</p>
              {group.kind === "reported" ? (
                <p className={styles.summaryHint}>
                  Valeurs collectées automatiquement, à comparer aux pièces officielles.
                </p>
              ) : null}
              {group.warning
                ? facts.map((fact) => (
                    <p className={styles.summaryHint} key={fact.key}>
                      {fact.presentation.detail}
                    </p>
                  ))
                : null}
            </div>
          );
        })}
      </div>

      <p className={styles.provenanceExplanation}>
        Les annonces et leurs documents alimentent ce dossier. Les mentions distinguent les données
        documentées, non vérifiées et estimées.
      </p>

      <div className={styles.actionGrid}>
        <button
          type="button"
          className={`${styles.action} ${styles.actionPrimary}`}
          onClick={() => setChecklistOpen(true)}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            <ListChecks />
          </span>
          <span className={styles.actionBody}>
            <strong>Compléter mon dossier</strong>
            <span>
              {coverage.missingCount + coverage.toConfirm.length
                ? `${coverage.missingCount + coverage.toConfirm.length} point${coverage.missingCount + coverage.toConfirm.length > 1 ? "s" : ""} à examiner`
                : "Revoir les champs clés"}
            </span>
          </span>
          <ArrowRight className={styles.actionArrow} aria-hidden="true" />
        </button>

        <button
          type="button"
          className={styles.action}
          onClick={() => {
            setCopyState("idle");
            setRequestOpen(true);
          }}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            <MessageCircle />
          </span>
          <span className={styles.actionBody}>
            <strong>Préparer une demande</strong>
            <span>Demander les éléments utiles à l’organisateur</span>
          </span>
          <ArrowRight className={styles.actionArrow} aria-hidden="true" />
        </button>

        <a
          className={styles.action}
          href="#documents"
          onClick={(event) => {
            event.preventDefault();
            navigateTo("#documents");
          }}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            <FileText />
          </span>
          <span className={styles.actionBody}>
            <strong>Consulter les pièces</strong>
            <span>
              {coverage.items.find((item) => item.key === "documents")?.present
                ? "Pièces disponibles dans le dossier"
                : "Pièces à retrouver ou demander"}
            </span>
          </span>
          <ArrowRight className={styles.actionArrow} aria-hidden="true" />
        </a>

        <a
          className={styles.action}
          href={preparationHref}
          onClick={(event) => {
            event.preventDefault();
            navigateTo(preparationHref);
          }}
        >
          <span className={styles.actionIcon} aria-hidden="true">
            <FileCheck2 />
          </span>
          <span className={styles.actionBody}>
            <strong>{preparationLabel}</strong>
            <span>
              {isTribunalSale && canSimulate
                ? "Tester votre scénario de prix"
                : "Retrouver la procédure et le contact"}
            </span>
          </span>
          <ArrowRight className={styles.actionArrow} aria-hidden="true" />
        </a>
      </div>

      <ListingDataCoverage sale={sale} factReliabilities={factReliabilities} coverage={coverage} />

      <Dialog open={checklistOpen} onOpenChange={setChecklistOpen}>
        <DialogContent className={styles.dialogContent}>
          <DialogHeader>
            <DialogTitle>Compléter les informations du dossier</DialogTitle>
            <DialogDescription>
              Cette checklist distingue les informations manquantes, non vérifiées et les réserves
              signalées. Elle ne vaut pas validation de leur contenu et ne modifie pas l’annonce.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.dialogSummary}>
            <span className={styles.dialogSummaryIcon} aria-hidden="true">
              <Sparkles />
            </span>
            <div>
              <strong>
                {coverage.presentCount}/{coverage.total} champs clés présents
              </strong>
              <p>
                {coverage.missingCount + coverage.toConfirm.length
                  ? "Les éléments ci-dessous méritent une confirmation auprès de l’organisateur."
                  : "Aucun champ clé ne manque dans les informations reçues."}
              </p>
            </div>
          </div>
          <ul className={styles.checklist} aria-label="Champs à compléter ou confirmer">
            {coverage.missing.length || coverage.toConfirm.length ? (
              [...coverage.missing, ...coverage.toConfirm].map((item) => (
                <li key={item.key}>
                  <span className={styles.checkMark} aria-hidden="true" />
                  {item.label}
                  {item.present
                    ? ` — ${coverage.keyFacts.find((fact) => fact.key === item.key)?.presentation.label.toLocaleLowerCase("fr-FR") ?? "à vérifier"}`
                    : " — non renseigné"}
                </li>
              ))
            ) : (
              <li className={styles.checklistComplete}>
                <span className={styles.checkMark} aria-hidden="true">
                  ✓
                </span>
                Les champs clés sont présents.
              </li>
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

      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className={styles.dialogContent}>
          <DialogHeader>
            <DialogTitle>Préparer une demande</DialogTitle>
            <DialogDescription>
              Modifiez ce brouillon avant de le copier dans votre messagerie ou dans le formulaire
              de contact de la source. Rien ne sera envoyé depuis cette page.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.requestContext}>
            <span className={styles.requestContextIcon} aria-hidden="true">
              <Clipboard />
            </span>
            <span>
              Destinataire : interlocuteur du dossier, à confirmer depuis les pièces officielles
            </span>
          </div>
          <textarea
            ref={messageRef}
            className={styles.messageInput}
            value={requestDraft}
            onChange={(event) => {
              setRequestDraft(event.target.value);
              setCopyState("idle");
            }}
            aria-label="Message prêt à copier"
            rows={12}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className={styles.dialogFooter}>
            <span className={styles.status} role="status" aria-live="polite">
              {copyState === "copied"
                ? "Message copié dans le presse-papiers."
                : copyState === "error"
                  ? "Copie automatique indisponible : le texte est sélectionné, copiez-le manuellement."
                  : ""}
            </span>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void copyRequest()}
            >
              <Clipboard aria-hidden="true" /> Copier le message
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

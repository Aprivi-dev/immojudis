"use client";

import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import { Terme } from "@/components/ceiling/Terme";
import type { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { MONTHLY_SALE_UNLOCKS, unlockedItemsText } from "@/lib/sale-unlocks";
import type { SaleProcedurePresentation } from "@/lib/sale-procedure";
import styles from "./SalePublicPreview.module.css";

/**
 * Frise « La vente » : avant, le jour même, après. Des étapes de procédure, propres au type de vente,
 * jamais une donnée de la vente qui n'est pas publiée.
 */
function timelineSteps(procedure: SaleProcedurePresentation): { before: string; after: string } {
  switch (procedure.venueType) {
    case "tribunal":
      return {
        before:
          procedure.lawyerRequired === true
            ? "Consulter le dossier et choisir un avocat pour porter votre enchère"
            : "Consulter le dossier et les conditions pour enchérir",
        after: "Délai de surenchère de dix jours, puis paiement du prix et des frais",
      };
    case "notary":
      return {
        before: "Consulter le dossier et les modalités de participation",
        after: "Signature de l’acte, paiement du prix et des frais selon le dossier",
      };
    case "state":
      return {
        before: "Consulter l’annonce officielle et ses conditions",
        after: "Suite de la cession selon les conditions du service vendeur",
      };
    default:
      return {
        before: "Consulter le dossier officiel et ses conditions",
        after: "Suite de la vente selon le dossier officiel",
      };
  }
}

/** « adjudication » prend sa définition (`Terme`) ; le texte de `VENUE_COPY` reste une chaîne brute. */
function withAdjudicationTerm(text: string) {
  const word = "adjudication";
  const index = text.indexOf(word);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <Terme terme="adjudication">{word}</Terme>
      {text.slice(index + word.length)}
    </>
  );
}

/**
 * Section « La vente » de la fiche publique : la frise en trois étapes (avant, jour de la vente mis
 * en avant, après), puis le dépliant « Cette vente en clair » (déroulement et ce que chaque accès
 * ouvre). Chargée à part (`SalePublicPreview`), rendue par le serveur.
 */
export function SalePublicSaleSteps({
  procedure,
  hearingLabel,
  venueSentence,
  explanation,
  ceilingTerms,
  adjudicationStatisticsEnabled,
}: {
  procedure: SaleProcedurePresentation;
  /** Date et heure de la vente, ou « Date à confirmer ». */
  hearingLabel: string;
  /** « Vente au tribunal », « Vente chez le notaire »… */
  venueSentence: string;
  /** Le déroulement propre au type de vente (`publicSaleVenueCopy`). */
  explanation: string;
  ceilingTerms: ReturnType<typeof ceilingTermsFor>;
  adjudicationStatisticsEnabled: boolean;
}) {
  const steps = timelineSteps(procedure);
  return (
    <>
      <ol className={styles.steps} aria-label="Déroulement de la vente">
        <li>
          <div className={styles.rail}>
            <span className={styles.knot} />
            <i />
          </div>
          <small>Avant la vente</small>
          <p>{steps.before}</p>
        </li>
        <li className={styles.stepNow}>
          <div className={styles.rail}>
            <span className={styles.knot} />
            <i />
          </div>
          <small className={styles.num}>{hearingLabel}</small>
          <p>{venueSentence}</p>
        </li>
        <li className={styles.stepNext}>
          <div className={styles.rail}>
            <span className={styles.knot} />
          </div>
          <small>Après la vente</small>
          <p>{steps.after}</p>
        </li>
      </ol>

      {/* Repliée : le détail est redondant avec la fiche de vente et l'analyse. Les mises en
        garde « indicatif » (écart au marché, simulations) sont ailleurs, jamais repliées. */}
      <details className={styles.fold}>
        <summary className={styles.foldSummary}>
          {/* Dans un <summary> : des <span> (contenu de phrase), ni <div> ni titre <h2>. */}
          <span>
            <span className={styles.foldTitle}>Cette vente en clair</span>
            <span className={styles.foldHint}>
              Le déroulement de la vente et ce que chaque accès ouvre
            </span>
          </span>
          <ChevronDown className={styles.foldIcon} aria-hidden />
        </summary>
        <div className={styles.foldBody}>
          <p className={styles.procedureText}>{withAdjudicationTerm(explanation)}</p>
          <ol className={styles.tiers} aria-label="Ce que vous voyez, selon votre accès">
            <li className={styles.tier}>
              <h3 className={styles.tierTitle}>
                <Eye aria-hidden />
                Visible maintenant
              </h3>
              <p>
                {procedure.venueType === "state"
                  ? "Le bien et ses équipements, la commune, la date de la vente, le prix s'il est publié et le niveau de vérification."
                  : "Le bien et ses équipements, la commune, la date de la vente, la mise à prix et le niveau de vérification."}
              </p>
            </li>
            <li className={`${styles.tier} ${styles.tierFree}`}>
              <h3 className={styles.tierTitle}>
                <LockKeyholeOpen aria-hidden />
                Découverte · gratuit
              </h3>
              <p>
                Adresse, photos, description, occupation, dates de visite et contact du dossier,
                fourchette de valeur estimée, Street View, météo et risques de la commune. Et{" "}
                {MONTHLY_SALE_UNLOCKS} déblocages par mois, chacun ouvrant, pour une vente :{" "}
                {unlockedItemsText({
                  ceiling: ceilingTerms?.ceilingTermWithArticle ?? null,
                  statistics: procedure.venueType === "tribunal" && adjudicationStatisticsEnabled,
                })}
                .
              </p>
            </li>
            <li className={`${styles.tier} ${styles.tierAnalysis}`}>
              <h3 className={styles.tierTitle}>
                <ChartNoAxesCombined aria-hidden />
                Offre Analyse
              </h3>
              <p>
                {ceilingTerms
                  ? procedure.venueType === "tribunal"
                    ? `Pièces du dossier, ventes comparables, travaux, statistiques du tribunal et calcul de votre ${ceilingTerms.ceilingTerm}.`
                    : `Pièces du dossier, ventes comparables, travaux et calcul de votre ${ceilingTerms.ceilingTerm}.`
                  : "Pièces du dossier, ventes comparables et risques repérés lorsque les données le permettent."}
              </p>
            </li>
          </ol>
          <p className={styles.catalogueNote}>
            <strong>Un seul catalogue, plusieurs procédures</strong>
            Immojudis référence les ventes immobilières au tribunal, chez le notaire et les ventes
            domaniales. Les règles affichées s’adaptent au type de chaque vente.
          </p>
        </div>
      </details>
    </>
  );
}

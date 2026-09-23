"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { SaleProcedureBadge } from "@/components/SaleProcedurePanel";
import { formatPrice } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
import { Link } from "@/lib/router-compat";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  saleVerificationLabel,
  saleVenueLabel,
} from "@/lib/sale-procedure";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

const VENUE_COPY: Record<SaleVenueType, { title: string; explanation: string }> = {
  tribunal: {
    title: "Bien immobilier vendu au tribunal",
    explanation:
      "La vente se tient lors d’une audience d’adjudication. Pour enchérir, un avocat du barreau compétent vous représente et porte votre mise.",
  },
  notary: {
    title: "Bien immobilier vendu chez le notaire",
    explanation:
      "La vente est organisée par un notaire, à l’étude ou en ligne selon le dossier. Les modalités d’inscription, de garantie et de dépôt des offres sont propres à chaque vente.",
  },
  state: {
    title: "Bien immobilier vendu par l’État",
    explanation:
      "La cession est organisée par l’État ou un organisme public. Elle peut suivre plusieurs procédures : les modalités figurent dans l’annonce officielle du service vendeur.",
  },
  online: {
    title: "Bien immobilier vendu aux enchères",
    explanation:
      "La vente est annoncée en ligne, mais son organisateur et ses règles doivent encore être confirmés dans le dossier officiel.",
  },
  unknown: {
    title: "Bien immobilier vendu aux enchères",
    explanation:
      "Le type de vente doit encore être confirmé. Le dossier officiel précisera l’organisateur, le mode de participation et les conditions pour enchérir.",
  },
};

export function publicSaleVenueCopy(venueType: SaleVenueType) {
  return VENUE_COPY[venueType];
}

export function SalePublicPreview({
  saleId,
  preview,
  returnTo,
  requestedHash = "",
}: {
  saleId: string;
  preview: AuctionSale;
  returnTo: string;
  requestedHash?: string;
}) {
  const procedure = getSaleProcedure(preview);
  const venueCopy = publicSaleVenueCopy(procedure.venueType);
  const state = procedure.venueType === "state";
  const notary = procedure.venueType === "notary";
  const price = preview.starting_price_eur != null && preview.starting_price_eur > 0;
  const priceBlock =
    price || !state ? (
      <div className={styles.priceBlock}>
        <p className={styles.priceLabel}>{state ? "Prix publié" : "Mise à prix"}</p>
        <p className={styles.price}>
          {price ? formatPrice(preview.starting_price_eur) : "À confirmer"}
        </p>
        <p className={styles.priceNote}>
          {state
            ? "Vérifiez les conditions et frais dans l'annonce officielle"
            : "Prix de départ, hors frais"}
        </p>
      </div>
    ) : (
      <p className={styles.priceUnavailable}>
        Prix non publié · conditions à consulter dans l'annonce officielle
      </p>
    );
  const factsBlock = (
    <dl className={styles.facts}>
      <div className={styles.fact}>
        <dt>{state ? "Mode de cession" : "Type de vente"}</dt>
        <dd>{state ? "À consulter dans le dossier" : saleVenueLabel(procedure.venueType)}</dd>
      </div>
      <div className={styles.fact}>
        <dt>{state ? "Démarches" : notary ? "Participation" : "Pour enchérir"}</dt>
        <dd>
          {state
            ? "Conditions précisées par le service vendeur"
            : notary
              ? "Modalités à consulter dans le dossier"
              : lawyerRequirementLabel(procedure)}
        </dd>
      </div>
    </dl>
  );

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <Link to={returnTo} className={styles.back}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Retour aux ventes
        </Link>

        <div
          className={`${styles.hero} ${state ? styles.heroState : notary ? styles.heroNotary : ""}`}
        >
          <section className={styles.summary} aria-labelledby="public-sale-title">
            <SaleProcedureBadge sale={preview} />
            <h1 id="public-sale-title" className={styles.title}>
              {venueCopy.title}
            </h1>
            <p className={styles.intro}>
              Cet aperçu protège les informations détaillées du bien tout en vous indiquant
              clairement comment la vente est organisée.
            </p>

            {state || notary ? factsBlock : priceBlock}
            {state || notary ? priceBlock : factsBlock}
          </section>

          <aside className={styles.procedure} aria-labelledby="public-procedure-title">
            <h2 id="public-procedure-title" className={styles.sectionTitle}>
              Cette vente en clair
            </h2>
            <p className={styles.procedureText}>{venueCopy.explanation}</p>
            <div className={styles.verification}>
              <ShieldCheck aria-hidden />
              <p>
                <strong>{saleVerificationLabel(procedure.verificationStatus)}</strong>
                <br />
                La qualification affichée est rapprochée des sources disponibles par Immojudis.
              </p>
            </div>
            <p className={styles.catalogueNote}>
              <strong>Un seul catalogue, plusieurs procédures</strong>
              Immojudis référence les ventes immobilières au tribunal, chez le notaire et les ventes
              domaniales. Les règles affichées s’adaptent au type de chaque vente.
            </p>
          </aside>
        </div>

        <section className={styles.access} aria-labelledby="public-access-title">
          <div className={styles.accessHeader}>
            <div>
              <h2 id="public-access-title" className={styles.sectionTitle}>
                Consulter le dossier
              </h2>
              <p className={styles.accessIntro}>
                Le compte Découverte est gratuit. Il donne accès aux informations pratiques et au
                guide de participation de cette vente.
              </p>
            </div>
            <div className={styles.actions}>
              <Link
                to="/login"
                search={{
                  mode: "investor",
                  redirect: `${saleDetailPath(saleId, returnTo)}${requestedHash.startsWith("#") ? requestedHash : ""}`,
                }}
                className={styles.primary}
              >
                Voir gratuitement le dossier
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link to={returnTo} className={styles.secondary}>
                Continuer ma recherche
              </Link>
            </div>
          </div>

          <div className={styles.tiers}>
            <div className={styles.tier}>
              <h3 className={styles.tierTitle}>
                <Eye aria-hidden />
                Visible maintenant
              </h3>
              <p>
                {state
                  ? "Type de vente, prix s'il est publié et niveau de vérification."
                  : "Mise à prix, type de vente et niveau de vérification."}
              </p>
            </div>
            <div className={`${styles.tier} ${styles.tierFree}`}>
              <h3 className={styles.tierTitle}>
                <LockKeyholeOpen aria-hidden />
                Découverte · gratuit
              </h3>
              <p>Date, visites, contact, pièces disponibles et étapes pour participer.</p>
            </div>
            <div className={`${styles.tier} ${styles.tierAnalysis}`}>
              <h3 className={styles.tierTitle}>
                <ChartNoAxesCombined aria-hidden />
                Offre Analyse
              </h3>
              <p>
                {procedure.venueType === "tribunal"
                  ? "Marché local, risques du dossier et estimation de votre mise plafond."
                  : "Marché local et risques du dossier lorsque les données le permettent."}
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

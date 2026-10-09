"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { ListingPhoto } from "@/components/ListingPhoto";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { formatPrice } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
import { Link } from "@/lib/router-compat";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  saleVerificationExplanation,
  saleVerificationLabel,
  saleVenueLabel,
} from "@/lib/sale-procedure";
import {
  saleHeadline,
  saleHearingTime,
  saleReference,
  seoLongDate,
  seoPropertyLabel,
  seoSurface,
  tribunalDisplayName,
} from "@/lib/seo";
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
  const headline = saleHeadline(preview);
  const photo = preview.media?.find((item) => item?.url && (item.type ?? "image") === "image");
  const surface = seoSurface(preview.app_surface_m2);
  const hearingDate = seoLongDate(preview.sale_date);
  const hearingTime = saleHearingTime(preview.sale_date);
  const tribunal = procedure.venueType === "tribunal" ? tribunalDisplayName(preview) : null;
  const location = [preview.city, preview.department].filter(Boolean).join(" · ");
  const propertyFacts = (
    <dl className={styles.facts}>
      <div className={styles.fact}>
        <dt>Type de bien</dt>
        <dd>{seoPropertyLabel(preview.property_type)}</dd>
      </div>
      {surface ? (
        <div className={styles.fact}>
          <dt>Surface</dt>
          <dd>{surface}</dd>
        </div>
      ) : null}
      {preview.rooms_count != null && preview.rooms_count > 0 ? (
        <div className={styles.fact}>
          <dt>Pièces</dt>
          <dd>{preview.rooms_count}</dd>
        </div>
      ) : null}
      {location ? (
        <div className={styles.fact}>
          <dt>Localisation</dt>
          <dd>{location}</dd>
        </div>
      ) : null}
      {hearingDate ? (
        <div className={styles.fact}>
          <dt>{procedure.venueType === "tribunal" ? "Date de l’audience" : "Date de la vente"}</dt>
          <dd>
            {hearingDate}
            {hearingTime ? ` à ${hearingTime}` : ""}
          </dd>
        </div>
      ) : null}
      {tribunal ? (
        <div className={styles.fact}>
          <dt>Tribunal</dt>
          <dd>{tribunal}</dd>
        </div>
      ) : null}
    </dl>
  );
  const dossierAdds = [
    procedure.venueType === "tribunal"
      ? "Une enchère plafond simulée, avec une enveloppe travaux ajustable"
      : null,
    "Les ventes comparables du secteur et l’estimation du bien",
    "Les documents du dossier et les risques repérés, lorsqu’ils sont disponibles",
  ].filter((item): item is string => item !== null);
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
    <main id="contenu" className={styles.page}>
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
            <p className={styles.kicker}>{venueCopy.title}</p>
            <h1 id="public-sale-title" className={styles.title}>
              {headline}
              <span className={styles.reference}>Réf. {saleReference(saleId)}</span>
            </h1>
            {photo?.url ? (
              <figure className={styles.photo}>
                <ListingPhoto
                  src={photo.url}
                  alt={`Photo du bien : ${headline}`}
                  className="h-full w-full object-cover"
                  fetchPriority="high"
                />
              </figure>
            ) : null}
            {propertyFacts}
            <div className={styles.adds}>
              <h2 className={styles.addsTitle}>Le dossier complet ajoute</h2>
              <ul>
                {dossierAdds.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>

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
                {saleVerificationExplanation(procedure.verificationStatus)}
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
                  ? "Le bien, la commune, la date de la vente, le prix s'il est publié et le niveau de vérification."
                  : "Le bien, la commune, la date de la vente, la mise à prix et le niveau de vérification."}
              </p>
            </div>
            <div className={`${styles.tier} ${styles.tierFree}`}>
              <h3 className={styles.tierTitle}>
                <LockKeyholeOpen aria-hidden />
                Découverte · gratuit
              </h3>
              <p>
                Informations pratiques, sources publiques de la procédure, Street View et ClimaScore
                communal selon disponibilité.
              </p>
            </div>
            <div className={`${styles.tier} ${styles.tierAnalysis}`}>
              <h3 className={styles.tierTitle}>
                <ChartNoAxesCombined aria-hidden />
                Offre Analyse
              </h3>
              <p>
                {procedure.venueType === "tribunal"
                  ? "Marché local, risques du dossier, historique météo et estimation de votre enchère plafond."
                  : "Marché local, risques du dossier et historique météo lorsque les données le permettent."}
              </p>
            </div>
          </div>
        </section>
        <p className="mt-6 text-sm leading-relaxed text-slate-600">
          Les sources officielles restent consultables librement :{" "}
          <a
            href="https://www.georisques.gouv.fr/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            consulter Géorisques
          </a>
          .
        </p>
      </div>
    </main>
  );
}

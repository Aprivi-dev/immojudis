"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  listingOccupation,
  listingValuationConflict,
  listingSaleStatus,
  saleTimeConflict,
  visitHasPassed,
} from "@/lib/listing-evidence";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Globe from "lucide-react/dist/esm/icons/globe.js";
import KeyRound from "lucide-react/dist/esm/icons/key-round.js";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Phone from "lucide-react/dist/esm/icons/phone.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import { toast } from "@/lib/toast";
import { FavoriteButton } from "@/components/FavoriteButton";
import { MapThumbnail } from "@/components/MapThumbnail";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { StreetViewDialog } from "@/components/StreetViewDialog";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { Terme } from "@/components/ceiling/Terme";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { saleSourceLinks } from "@/lib/sale-source-links";
import { formatPrice } from "@/lib/format";
import type { EstimatedFee } from "@/lib/bid-ceiling-engine";
import type { CeilingStartGapTerms } from "@/lib/ceiling-start-gap";
import { buildStructuredDescription } from "@/lib/sale-description";
import {
  listingContactLinks,
  listingAddress,
  listingCoordinates,
  listingDate,
  listingVisits,
  positiveListingNumber,
} from "@/lib/sale-listing";
import {
  getSaleProcedure,
  participationModeLabel,
  saleIsTribunalVenue,
  stateSaleMethodLabel,
} from "@/lib/sale-procedure";
import { saleDisplayTitle } from "@/lib/sale-title";
import { saleKeyFacts } from "@/lib/sale-key-facts";
import { saleHeadingSubtitle, saleShortHeading } from "@/lib/seo";
import { stateListingStatus } from "@/lib/property-characteristics";
import { saleSession, saleWindow } from "@/lib/sale-window";
import type { AuctionSale } from "@/lib/types";
import { PepiteHeroBadge } from "@/components/PepiteBadge";
import styles from "./SaleListing.module.css";
import { PublicListingFactSource } from "./ListingDataCoverage";
import {
  getFactPresentation,
  getFactReliabilityForDisplay,
  type FactReliabilityMap,
} from "@/lib/fact-reliability";
import { AiReviewField } from "./AiReviewField";
import { getListingPublicInformation } from "@/lib/listing-public-information";
import {
  AI_REVIEW_ENERGY_FIELD_KEYS,
  AI_REVIEW_SURFACE_FIELD_KEYS,
  firstBlockedAiReviewField,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";

/** Une vente enregistrée (identifiant UUID) : les ventes d'exemple n'ont pas de favori. */
export function isPersistedSaleId(saleId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saleId);
}

export function ListingActions({
  sale,
  publicDemo = false,
  showFavorite = true,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
  /** Faux quand le bouton favori est placé ailleurs (seconde action du haut de page). */
  showFavorite?: boolean;
}) {
  const [sharing, setSharing] = useState(false);
  const persistedSale = showFavorite && isPersistedSaleId(sale.id);
  async function share() {
    setSharing(true);
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      url.searchParams.delete("from");
      if (navigator.share) {
        await navigator.share({ title: saleDisplayTitle(sale), url: url.href });
      } else {
        await navigator.clipboard.writeText(url.href);
        toast.success("Lien de l’annonce copié");
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        toast.error("Partage indisponible. Vous pouvez copier l’adresse de cette page.");
      }
    } finally {
      setSharing(false);
    }
  }
  return (
    <div className={styles.actions}>
      {!publicDemo && persistedSale ? (
        <FavoriteButton saleId={sale.id} className="min-h-11 px-4 text-sm" />
      ) : null}
      <button
        type="button"
        className={styles.share}
        aria-label="Partager cette annonce"
        title="Partager cette annonce"
        onClick={() => void share()}
        disabled={sharing}
      >
        <Share2 className="h-5 w-5" aria-hidden />
        <span>Partager</span>
      </button>
    </div>
  );
}

/**
 * Le vocabulaire du plafond de la vente (régime de frais) : absent, celui du tribunal. Le haut de
 * page n'en lit que `byOffers` (le prix de départ d'une vente par offres) ; le reste sert aux
 * panneaux de prix.
 */
export type CeilingWording = {
  /** « Enchère plafond (simulation) » ou « Offre plafond (simulation) ». */
  label: string;
  /** Mots des phrases qui comparent le plafond au prix de départ ; absents : ceux du tribunal. */
  terms?: CeilingStartGapTerms;
  /** Une vente par offres : le prix de départ est la « première offre possible ». */
  byOffers?: boolean;
  /** Mention d'une vente par offres : le vendeur n'est pas tenu de retenir la meilleure offre. */
  reserveNotice?: string | null;
  /** Postes importants dont le montant vient d'une valeur par défaut. */
  estimatedFees?: readonly EstimatedFee[];
};

/** L'action principale du haut de page : un lien interne (onglet, ancre) ou une page du site. */
export type OverviewAction = { href: string; label: string };

/**
 * Le haut de page de la fiche : le prix de départ, un repère marché, quatre faits (date, visite,
 * garantie pour enchérir ou lieu, occupation) et deux actions. L'enchère plafond et ses hypothèses
 * sont dans l'Aperçu et l'onglet Prix : le visiteur qui découvre la fiche n'a pas à les lire ici.
 */
export function ListingOverview({
  sale,
  factReliabilities = null,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
  ceilingWording = null,
  preparation = null,
  marketReference = null,
  followAction = null,
  showSecondaryAction = true,
}: {
  sale: AuctionSale;
  /** Vocabulaire du plafond de la vente ; absent : celui du tribunal. */
  ceilingWording?: CeilingWording | null;
  /** Action principale (« Préparer mon enchère », « Débloquer le plafond »…). */
  preparation?: OverviewAction | null;
  /** Repère marché sous le prix (`MarketReference`), selon les droits du compte. */
  marketReference?: ReactNode;
  /** Seconde action : suivre la vente (favori). Absente : les rendez-vous et contacts. */
  followAction?: ReactNode;
  /** Faux quand la page ajoute sa propre action sous la synthèse (annonce exemple). */
  showSecondaryAction?: boolean;
  factReliabilities?: FactReliabilityMap | null;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const publicInformation = useMemo(
    () => getListingPublicInformation(sale, factReliabilities),
    [sale, factReliabilities],
  );
  const publicFactsById = new Map(publicInformation.items.map((fact) => [fact.id, fact]));
  const price = positiveListingNumber(sale.starting_price_eur);
  const procedure = getSaleProcedure(sale);
  const schedule = saleWindow(sale) ?? saleSession(sale);
  const saleStatus = listingSaleStatus(sale);
  const sourceLink = saleSourceLinks(sale)[0];
  const notary = procedure.venueType === "notary";
  const state = procedure.venueType === "state";
  const tribunal = procedure.venueType === "tribunal";
  const stateListing = state ? stateListingStatus(sale) : null;
  const eventDate = state
    ? (schedule?.closes_at ?? sale.sale_date)
    : (schedule?.opens_at ?? sale.sale_date);
  const eventLabel = state
    ? "Échéance annoncée"
    : notary
      ? "Séance annoncée"
      : tribunal
        ? "Audience annoncée"
        : "Date annoncée";
  const priceReview = getAiReviewFieldResult(
    aiReviewProjections,
    "sale.starting_price_eur",
    aiReviewStatus,
  );
  const dateReview = getAiReviewFieldResult(aiReviewProjections, "sale.sale_date", aiReviewStatus);
  const occupancyReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.occupancy_status",
    aiReviewStatus,
  );
  const hasVisibleEvent = Boolean(
    !saleStatus && !dateReview.blocked && eventDate && !saleTimeConflict(sale),
  );
  const dateReliability = getFactReliabilityForDisplay(
    sale,
    "sale_date",
    eventDate,
    factReliabilities,
  );
  const showDateFact = Boolean(eventDate || saleStatus || dateReliability.status !== "observed");
  const keyFacts = saleKeyFacts(sale);
  // La garantie pour enchérir (tribunal) : ce qu'il faut avoir en main avant l'audience. Elle se
  // calcule sur la mise à prix : pas de montant tant que celle-ci est en cours de vérification.
  const guarantee =
    tribunal && !priceReview.blocked && !saleStatus ? procedure.guaranteeAmountEur : null;
  const publicOccupancyFact = occupancyReview.blocked
    ? null
    : publicFactsById.get("occupancy_status");
  const publicPriceFact = priceReview.blocked ? null : publicFactsById.get("starting_price_eur");
  const publicDateFact = dateReview.blocked ? null : publicFactsById.get("sale_date");
  const occupancyMissing =
    getFactPresentation(sale, "occupancy_status", undefined, factReliabilities).kind === "missing";
  return (
    <section className={styles.overview} aria-label="Synthèse de la vente">
      {notary || state ? (
        <div className={styles.procedureLead}>
          <p className={styles.procedureLeadEyebrow}>
            {notary ? "Vente notariale" : "Cession domaniale"}
          </p>
          <strong>
            {notary
              ? (procedure.organizerName ?? "Étude non renseignée")
              : stateSaleMethodLabel(procedure)}
          </strong>
          <span>
            {notary
              ? participationModeLabel(procedure.participationMode)
              : hasVisibleEvent
                ? "Conditions à vérifier dans l’annonce officielle"
                : (stateListing?.label ?? "Échéance à confirmer dans l’annonce officielle")}
          </span>
        </div>
      ) : null}
      {price != null || !state ? (
        <div className={styles.heroPrice}>
          <div className={styles.priceLabel}>
            {state ? (
              "Prix publié"
            ) : ceilingWording?.byOffers ? (
              <Terme terme="premiere-offre">Première offre possible</Terme>
            ) : (
              <Terme terme="mise-a-prix">Mise à prix</Terme>
            )}
            {publicPriceFact ? <PublicListingFactSource fact={publicPriceFact} compact /> : null}
          </div>
          <p className={styles.price}>
            <AiReviewField
              fieldKey="sale.starting_price_eur"
              projections={aiReviewProjections}
              reviewStatus={aiReviewStatus}
              fallback="À confirmer"
              sourceName={sale.source_name}
              sourceUrl={sale.source_url}
            >
              {price == null ? "Non renseigné" : formatPrice(price)}
            </AiReviewField>
          </p>
          <p className={styles.muted}>
            {state
              ? "Conditions et frais à vérifier dans l'annonce officielle"
              : ceilingWording?.byOffers
                ? "Plus bas montant que l’on peut proposer, hors frais"
                : "Prix de départ des enchères, hors frais"}
          </p>
        </div>
      ) : (
        <div className={`${styles.muted} mt-5`}>
          Prix non publié : consultez les conditions de cession.
          {publicPriceFact ? <PublicListingFactSource fact={publicPriceFact} compact /> : null}
        </div>
      )}
      {marketReference ? <div className={styles.heroMarket}>{marketReference}</div> : null}
      <dl className={styles.heroFacts}>
        {showDateFact ? (
          <div className={styles.heroFact}>
            <dt>{eventLabel}</dt>
            <dd>
              <span className={styles.heroFactValue}>
                <AiReviewField
                  fieldKey="sale.sale_date"
                  projections={aiReviewProjections}
                  reviewStatus={aiReviewStatus}
                  fallback="Date à confirmer"
                  sourceName={sale.source_name}
                  sourceUrl={sale.source_url}
                >
                  {listingDate(eventDate)}
                </AiReviewField>
                {publicDateFact ? <PublicListingFactSource fact={publicDateFact} compact /> : null}
              </span>
              {saleStatus ? (
                <span role="status" className={styles.summaryNote}>
                  {saleStatus}
                </span>
              ) : null}
              {keyFacts.timeConflict && !saleStatus && !dateReview.blocked ? (
                <span className={styles.summaryNote}>Horaire à faire confirmer</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {keyFacts.nextVisit && !dateReview.blocked ? (
          <div className={styles.heroFact}>
            <dt>Prochaine visite</dt>
            <dd>
              <span className={styles.heroFactValue}>{keyFacts.nextVisit}</span>
            </dd>
          </div>
        ) : null}
        {guarantee != null ? (
          <div className={styles.heroFact}>
            <dt>
              <Terme terme="garantie-encherir">Garantie pour enchérir</Terme>
            </dt>
            <dd>
              <span className={styles.heroFactValue}>{formatPrice(guarantee)}</span>
              <span className={styles.heroFactNote}>chèque de banque remis à votre avocat</span>
            </dd>
          </div>
        ) : keyFacts.venueName ? (
          <div className={styles.heroFact}>
            <dt>{keyFacts.venueLabel}</dt>
            <dd>
              <span className={styles.heroFactValue}>{keyFacts.venueName}</span>
            </dd>
          </div>
        ) : null}
        <div className={styles.heroFact}>
          <dt>Occupation</dt>
          <dd className={occupancyMissing ? styles.factMissing : undefined}>
            <span className={styles.heroFactValue}>
              <AiReviewField
                fieldKey="property.occupancy_status"
                projections={aiReviewProjections}
                reviewStatus={aiReviewStatus}
                sourceName={sale.source_name}
                sourceUrl={sale.source_url}
              >
                {listingOccupation(sale)}
              </AiReviewField>
              {publicOccupancyFact ? (
                <PublicListingFactSource fact={publicOccupancyFact} compact />
              ) : null}
            </span>
          </dd>
        </div>
      </dl>
      <div className={styles.summaryActions} data-hero-actions="">
        {preparation ? (
          preparation.href.startsWith("#") ? (
            <a href={preparation.href} className={styles.primaryAction}>
              {preparation.label}
            </a>
          ) : (
            <Link href={preparation.href} className={styles.primaryAction}>
              {preparation.label}
            </Link>
          )
        ) : null}
        {!showSecondaryAction
          ? null
          : (followAction ?? (
              <a
                href={state ? "#participation" : "#rendez-vous"}
                className={styles.secondaryAction}
              >
                {state ? "Voir la procédure de cession" : "Rendez-vous et contacts"}
              </a>
            ))}
        {sourceLink ? (
          <a
            href={sourceLink.href}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.sourceLink}
          >
            Source originale · {sourceLink.label} <span className="sr-only">(nouvel onglet)</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}

/**
 * En-tête de la fiche complète, le même que celui de la fiche publique (même adresse, même titre) :
 * type de vente, titre court (type, surface, ville) et une ligne (lieu de vente, département, date).
 * Un champ en cours de vérification sort du titre ou de la ligne au lieu d'y être affiché.
 */
export function SaleDetailHeading({
  sale,
  publicDemo = false,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
  pepite = false,
  pepiteFloodExposed = false,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
  /** La vente est une pépite publiable : pastille « Pépite » et lien « Pourquoi ? » vers le bloc `#pepite`. */
  pepite?: boolean;
  /** Pépite dont le bien est dans le périmètre d'un PPRi : mention courte à côté de la pastille. */
  pepiteFloodExposed?: boolean;
}) {
  const review = (field: Parameters<typeof getAiReviewFieldResult>[1]) =>
    getAiReviewFieldResult(aiReviewProjections, field, aiReviewStatus).blocked;
  const typeBlocked = review("property.property_type") || Boolean(listingValuationConflict(sale));
  const cityBlocked = review("property.city");
  const surfaceBlocked = firstBlockedAiReviewField(
    aiReviewProjections,
    AI_REVIEW_SURFACE_FIELD_KEYS,
    aiReviewStatus,
  );
  const shown = {
    ...sale,
    city: cityBlocked ? null : sale.city,
    // Une ville en cours de vérification ne laisse pas non plus son département dans la ligne.
    department: cityBlocked ? null : sale.department,
    app_surface_m2: surfaceBlocked ? null : sale.app_surface_m2,
  };
  const title = typeBlocked
    ? cityBlocked || !sale.city
      ? "Type de bien à confirmer"
      : `Type de bien à confirmer à ${sale.city}`
    : saleShortHeading(shown);
  const subtitle = saleHeadingSubtitle(shown, { withDate: !review("sale.sale_date") });
  return (
    <header className={styles.pageHeading}>
      <div className={styles.headingBadges}>
        <SaleProcedureBadge sale={sale} />
        {pepite ? <PepiteHeroBadge floodExposed={pepiteFloodExposed} /> : null}
        {publicDemo ? (
          <span className={styles.demoNote}>Annonce exemple · données fictives</span>
        ) : null}
      </div>
      <h1 className={styles.title}>
        {title}
        {/* Une page d'exemple ne doit jamais se lire (ni se citer) comme une vente réelle. */}
        {publicDemo ? " (exemple fictif)" : null}
      </h1>
      <p className={styles.subtitle}>
        {subtitle}
        {cityBlocked ? " · localisation à confirmer" : null}
      </p>
    </header>
  );
}

export function ListingPracticalDetails({
  sale,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
}: {
  sale: AuctionSale;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const status = listingSaleStatus(sale);
  const interrupted = ["cancelled", "canceled", "postponed"].includes(sale.status ?? "");
  const window = saleWindow(sale);
  const session = saleSession(sale);
  const schedule = window ?? session;
  const timeConflict = saleTimeConflict(sale);
  const procedure = getSaleProcedure(sale);
  const tribunal = saleIsTribunalVenue(sale);
  const notary = procedure.venueType === "notary";
  const state = procedure.venueType === "state";
  // « Ajouter à mon agenda » only for a plain announced hearing: the server re-checks the date.
  const calendarExportable =
    tribunal &&
    Boolean(sale.sale_date) &&
    !status &&
    !schedule &&
    !timeConflict &&
    !getAiReviewFieldResult(aiReviewProjections, "sale.sale_date", aiReviewStatus).blocked;
  const visits = listingVisits(sale);
  const contacts = listingContactLinks(procedure.organizerContact);
  const role = procedure.procedure?.organizer_type;
  const roleLabel =
    role === "pursuing_lawyer" ? "Avocat poursuivant" : role === "notary" ? "Notaire" : null;
  return (
    <section id="rendez-vous" className={styles.section} aria-labelledby="listing-practical-title">
      <h2 id="listing-practical-title" className={styles.heading}>
        {tribunal
          ? "L’audience et les visites"
          : notary
            ? "La séance notariale et les visites"
            : state
              ? "Échéance, visites et service vendeur"
              : "La vente et les visites"}
      </h2>
      {status && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">{status}</p>
          {interrupted && (
            <p className="mt-2">
              Les dates conservées dans le dossier ne confirment pas un nouveau rendez-vous.
              Contactez l’organisateur avant tout déplacement.
            </p>
          )}
        </div>
      )}
      <div className={styles.card}>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>
              <CalendarDays aria-hidden />
              {window
                ? "Ouverture"
                : session && procedure.participationMode !== "unknown"
                  ? "Début de séance"
                  : state
                    ? "Date ou échéance"
                    : "Date annoncée"}
            </dt>
            <dd>
              <AiReviewField
                fieldKey="sale.sale_date"
                projections={aiReviewProjections}
                reviewStatus={aiReviewStatus}
                sourceName={sale.source_name}
                sourceUrl={sale.source_url}
              >
                {listingDate(schedule?.opens_at ?? sale.sale_date)}
              </AiReviewField>
              {calendarExportable ? <SaleCalendarButton saleId={sale.id} /> : null}
              {timeConflict ? (
                <p role="status" className="mt-2 text-sm font-medium text-amber-900">
                  {timeConflict}
                </p>
              ) : null}
            </dd>
          </div>
          {schedule ? (
            <div className={styles.row}>
              <dt>
                <CalendarDays aria-hidden />
                {window
                  ? "Clôture"
                  : session && procedure.participationMode !== "unknown"
                    ? "Fin de séance annoncée"
                    : "Fin annoncée"}
              </dt>
              <dd>
                <AiReviewField
                  fieldKey="sale.sale_date"
                  projections={aiReviewProjections}
                  reviewStatus={aiReviewStatus}
                  sourceName={sale.source_name}
                  sourceUrl={sale.source_url}
                >
                  {listingDate(schedule.closes_at)}
                </AiReviewField>
              </dd>
            </div>
          ) : null}
          <div className={styles.row}>
            <dt>
              <Landmark aria-hidden />
              {tribunal
                ? "Tribunal"
                : notary
                  ? "Étude ou organisateur"
                  : state
                    ? "Service vendeur"
                    : "Lieu"}
            </dt>
            <dd>
              {(state ? (procedure.organizerName ?? procedure.venueName) : procedure.venueName) ||
                `${
                  tribunal
                    ? "Tribunal"
                    : notary
                      ? "Étude ou organisateur"
                      : state
                        ? "Service vendeur"
                        : "Lieu"
                } non renseigné`}
              {procedure.venueAddress ? (
                <p className={`${styles.muted} mt-1 font-normal`}>{procedure.venueAddress}</p>
              ) : null}
            </dd>
          </div>
          <div className={styles.row}>
            <dt>
              <KeyRound aria-hidden />
              Visites
            </dt>
            <dd>
              {visits.length
                ? visits.map((visit) => <ListingVisit key={visit} text={visit} />)
                : "Dates de visite non renseignées"}
            </dd>
          </div>
        </dl>
        <div className={styles.contact}>
          <p className={styles.contactTitle}>Interlocuteur du dossier</p>
          <p className={styles.contactName}>{procedure.organizerName || "Contact non renseigné"}</p>
          {roleLabel ? <p className={styles.muted}>{roleLabel}</p> : null}
          {contacts.length ? (
            <div className={styles.contactLinks}>
              {contacts.map(({ href, label, kind }) => {
                const Icon = kind === "email" ? Mail : kind === "phone" ? Phone : Globe;
                return (
                  <a
                    key={href}
                    href={href}
                    className={styles.textLink}
                    {...(kind === "website"
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden />
                    {label}
                  </a>
                );
              })}
            </div>
          ) : null}
          {procedure.organizerContact && procedure.organizerContact !== contacts[0]?.label ? (
            <p className={`${styles.muted} mt-2 break-words`}>{procedure.organizerContact}</p>
          ) : null}
          <p className={`${styles.muted} mt-3`}>
            {procedure.organizerContact
              ? "Contact mentionné dans le dossier. Confirmez les horaires et modalités avant de vous déplacer."
              : "Les coordonnées seront affichées lorsqu’elles seront renseignées dans le dossier."}
          </p>
          {role === "pursuing_lawyer" ? (
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              L’avocat poursuivant suit la vente ; il n’est pas automatiquement votre représentant
              pour enchérir.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ListingVisit({ text }: { text: string }) {
  const conditionsStart = text.search(/\bconditions\s+de\s+la\s+vente\b/i);
  const slot = conditionsStart < 0 ? text : text.slice(0, conditionsStart).trim();
  const conditions = conditionsStart < 0 ? null : text.slice(conditionsStart);
  return (
    <div>
      {slot ? (
        <p>
          {slot}
          {visitHasPassed(slot) ? (
            <span className="ml-2 text-sm font-semibold text-amber-900">Visite passée</span>
          ) : null}
        </p>
      ) : null}
      {conditions ? (
        <details className="mt-2 text-left text-sm font-normal">
          <summary className="cursor-pointer font-semibold">Conditions de la source</summary>
          <p className="mt-2 leading-relaxed">{conditions}</p>
        </details>
      ) : null}
    </div>
  );
}

export function ListingDescription({
  sale,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
}: {
  sale: AuctionSale;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const guardedFields = [
    "property.property_type",
    "property.city",
    "sale.sale_date",
    "sale.starting_price_eur",
    ...AI_REVIEW_SURFACE_FIELD_KEYS,
    "property.occupancy_status",
    "property.rooms_count",
    "property.parking_count",
    ...AI_REVIEW_ENERGY_FIELD_KEYS,
  ] as const;
  const hasBlockedField = guardedFields.some(
    (fieldKey) => getAiReviewFieldResult(aiReviewProjections, fieldKey, aiReviewStatus).blocked,
  );
  const description = hasBlockedField
    ? "La synthèse est à confirmer dans les pièces et la source officielle de l’annonce."
    : buildStructuredDescription(sale);
  const original = sale.source_description?.trim() || sale.description?.trim();
  const originalDiffers =
    !hasBlockedField &&
    !!original &&
    original.replace(/\s+/g, " ") !== description.replace(/\s+/g, " ");
  const sourceUrl = safeExternalHttpUrl(sale.source_url);
  return (
    <section className={styles.section} aria-labelledby="listing-description-title">
      <h2 id="listing-description-title" className={styles.heading}>
        Description
      </h2>
      <p className={`${styles.body} ${styles.descriptionPreview}`}>
        {description.length > 360
          ? `${description.slice(0, 360).replace(/\s+\S*$/, "")}…`
          : description}
      </p>
      <details id="description-ia" className={styles.descriptionDisclosure}>
        <summary>
          Lire la synthèse du dossier <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        </summary>
        <div className={styles.card}>
          <p className={`${styles.muted} mb-3`}>
            {hasBlockedField
              ? "Certaines valeurs sont momentanément masquées jusqu’à vérification de la relecture IA."
              : "Synthèse issue des données de la fiche. Elle ne remplace pas le texte source."}
          </p>
          <p className={styles.body}>{description}</p>
        </div>
      </details>
      {originalDiffers ? (
        <details className={styles.original}>
          <summary>
            Afficher le texte de l’annonce source{" "}
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
          </summary>
          <div className={styles.card}>
            {sale.source_name ? (
              <p className={`${styles.muted} mb-3`}>Source : {sale.source_name}</p>
            ) : null}
            <p className={styles.body}>{original}</p>
            {sourceUrl ? (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.textLink} mt-3`}
              >
                Consulter l’annonce source <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function ListingLocation({
  sale,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
}: {
  sale: AuctionSale;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  const coordinates = listingCoordinates(sale);
  const cityReview = getAiReviewFieldResult(aiReviewProjections, "property.city", aiReviewStatus);
  const address = cityReview.blocked ? null : listingAddress(sale);
  const price = positiveListingNumber(sale.starting_price_eur);
  const priceReview = getAiReviewFieldResult(
    aiReviewProjections,
    "sale.starting_price_eur",
    aiReviewStatus,
  );
  return (
    <section id="localisation" className={styles.section} aria-labelledby="listing-location-title">
      <h2 id="listing-location-title" className={styles.heading}>
        Localisation
      </h2>
      <div className={styles.card}>
        {coordinates && !cityReview.blocked ? (
          <div className={styles.map}>
            <MapThumbnail
              lat={coordinates.lat}
              lng={coordinates.lng}
              zoom={14}
              className="h-[230px] w-full sm:h-[300px]"
              alt={`Localisation indicative du bien${sale.city ? ` à ${sale.city}` : ""}`}
              markerLabel={!priceReview.blocked && price != null ? formatPrice(price) : undefined}
            />
          </div>
        ) : (
          <p className={`${styles.muted} mb-4`}>
            La carte sera disponible lorsque les coordonnées du bien seront renseignées.
          </p>
        )}
        <p className={styles.address}>
          <MapPin className="mt-1 h-4 w-4 shrink-0" aria-hidden />
          <AiReviewField
            fieldKey="property.city"
            projections={aiReviewProjections}
            reviewStatus={aiReviewStatus}
            fallback="Localisation à confirmer"
            sourceName={sale.source_name}
            sourceUrl={sale.source_url}
          >
            {address || "Adresse non renseignée"}
          </AiReviewField>
        </p>
        <p className={styles.muted}>
          Localisation indicative. À vérifier dans les pièces du dossier.
        </p>
        {coordinates && !cityReview.blocked ? (
          <div className="flex flex-wrap gap-2">
            <StreetViewDialog
              target={{ ...coordinates, address }}
              className={`${styles.button} ${styles.outline}`}
            />
            <MapboxPreviewButton
              mode="streetLevel"
              lat={coordinates.lat}
              lng={coordinates.lng}
              label="Explorer le quartier"
              title="Le quartier du bien"
              description={address || "Localisation indicative"}
              ariaLabel="Explorer le quartier sur la carte"
              icon={MapPin}
              className={`${styles.button} ${styles.outline}`}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import FolderHeart from "lucide-react/dist/esm/icons/folder-heart.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import dynamic from "next/dynamic";
import { Terme } from "@/components/ceiling/Terme";
import { PepiteHeroBadge } from "@/components/PepiteBadge";
import { PepiteBlockLazy } from "@/components/sale-detail/PepiteBlockLazy";
import { ListingPhoto } from "@/components/ListingPhoto";
import { PhotoCredit } from "@/components/PhotoCredit";
import { SalePublicMobileBar } from "@/components/SalePublicMobileBar";
import { nonBreakingUnits } from "@/lib/non-breaking-units";
import { SalePublicShareButton } from "@/components/SalePublicShareButton";
import { SalePublicToc, type SalePublicTocItem } from "@/components/SalePublicToc";
import { contactReportPath } from "@/lib/contact-message";
import { departmentFromCode } from "@/lib/department-pages";
import { photoCredit } from "@/lib/photo-credit";
import { photoMirrorForDetail } from "@/lib/photo-mirror";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { LawyerFactSourceNote } from "@/components/sale-detail/LawyerFactSourceNote";
import {
  LAWYER_DAY_LABEL,
  LAWYER_PROPERTY_TYPE_LABEL,
  LAWYER_ROOMS_LABEL,
  LAWYER_SURFACE_LABEL,
  lawyerSourceForDisplayedValue,
} from "@/lib/lawyer-fact-sources";
import { isPastParisDay } from "@/lib/paris-time";
import { formatDate, formatPrice, formatPricePerM2, formatShortDate } from "@/lib/format";
import {
  MARKET_GAP_BAND_CAUTION,
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_METHOD_LABEL,
  MARKET_GAP_BAND_METHOD_PATH,
  MARKET_GAP_BAND_STARTING_PRICE_NOTE,
  type PublicMarketGapBand,
} from "@/lib/market-gap-band";
import { publicSaleDescription } from "@/lib/public-sale-description";
import { getDisplaySurface } from "@/lib/surface";
import {
  loginPathWithRedirect,
  saleDetailPath,
  salesCompareHref,
  salesReturnHref,
  salesReturnLabel,
} from "@/lib/navigation";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_LABEL, LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { freeAccessLine, MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";
import { getSaleProcedure, lawyerRequirementLabel, saleVenueLabel } from "@/lib/sale-procedure";
import {
  saleHeadline,
  saleHearingTime,
  saleReference,
  saleShortHeading,
  saleVenueSentence,
  seoPropertyLabel,
  seoSurface,
  tribunalDisplayName,
} from "@/lib/seo";
import { tribunalCodePagePath } from "@/lib/tribunal-code-path";
import type { HousingTension } from "@/lib/housing-tension";
import type { RentReference } from "@/lib/rent-reference";
import type { PublicRentalYield } from "@/lib/public-rental-yield";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

/**
 * « Marché local » chargé à part, rendu par le serveur comme le reste de la fiche ; le rendement y
 * arrive déjà calculé (`rentalYield`) : le calcul des frais d'acquisition reste hors du navigateur
 * (budget de JavaScript client, voir `check-build-budgets.mjs`).
 */
const SalePublicRentalMarketLazy = dynamic(() =>
  import("@/components/SalePublicRentalMarket").then((module) => module.SalePublicRentalMarket),
);

/**
 * Frise et dépliant « Cette vente en clair » de la section « La vente », chargés à part : du texte
 * sous la ligne de flottaison, rendu par le serveur comme le reste (budget de JavaScript client).
 */
const SalePublicSaleStepsLazy = dynamic(() =>
  import("@/components/SalePublicSaleSteps").then((module) => module.SalePublicSaleSteps),
);

/** Section « Pièces et vérifications » : niveau de vérification, points à vérifier, pièces. */
const SalePublicChecksLazy = dynamic(() =>
  import("@/components/SalePublicChecks").then((module) => module.SalePublicChecks),
);
/** Son ancre : cible aussi du lien « Où consulter le cahier » des mentions de l'avocat poursuivant. */
const PIECES_SECTION_ID = "pieces-et-verifications";
const PIECES_SECTION_HREF = `#${PIECES_SECTION_ID}`;

/** « Pour aller plus loin » et la suite de la recherche, en bas de fiche. */
const SalePublicFurtherLazy = dynamic(() =>
  import("@/components/SalePublicFurther").then((module) => module.SalePublicFurther),
);

/** Alerte du secteur, en bas de fiche (le formulaire des comptes reste lui-même chargé à la demande). */
const SectorAlertCtaLazy = dynamic(() =>
  import("@/components/SectorAlertCta").then((module) => module.SectorAlertCta),
);

/** Illustration du type de bien (sans photo), chargée à part. */
const SalePublicIllustrationLazy = dynamic(() =>
  import("@/components/SalePublicIllustration").then((module) => module.SalePublicIllustration),
);

/** L'échéance ne se calcule que dans le navigateur (heure locale) : rien à rendre côté serveur. */
const SalePublicDeadlineLazy = dynamic(
  () => import("@/components/SalePublicDeadline").then((module) => module.SalePublicDeadline),
  { ssr: false },
);

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

type TeaserItem = {
  label: string;
  width: "short" | "medium" | "wide";
  tier: string;
  visibleWith: string;
  offerAware?: boolean;
};

/** Rien à écouter : la valeur n'est lue qu'une fois le navigateur monté (voir `pastDate`). */
const subscribeNever = () => () => undefined;

export function publicSaleVenueCopy(venueType: SaleVenueType) {
  return VENUE_COPY[venueType];
}

/** Position de la mise à prix sur la réglette de la fourchette (décor, sans chiffre). */
const BAND_POSITION: Partial<Record<PublicMarketGapBand, string>> = {
  under: "12%",
  near: "50%",
  above: "88%",
};

/**
 * Écart de la mise à prix au marché local, en trois bandes et sans chiffre (le pourcentage et la
 * fourchette restent au compte). Affichée seulement quand la base a jugé l'estimation fiable (ou
 * dit qu'elle ne l'est pas) ; neutre, indicative, jamais une recommandation.
 */
function MarketGapBandNote({ band, saleId }: { band: PublicMarketGapBand; saleId: string }) {
  // Une vraie bande (sous, dans, au-dessus) porte la phrase sur la mise à prix basse et la mise en
  // garde ; « bien occupé » et les raisons d'insuffisance disent seulement pourquoi il n'y en a pas.
  const isBand = band === "under" || band === "near" || band === "above";
  return (
    <div className={styles.marketBand} data-testid="market-gap-band" data-band={band}>
      <p className={styles.marketBandLabel}>
        <span data-nosnippet="">{MARKET_GAP_BAND_LABELS[band]}</span>
      </p>
      {isBand ? (
        // Réglette : la fourchette au milieu, la mise à prix avant, dedans ou après. Le libellé
        // ci-dessus dit déjà la même chose : décor, ignoré des lecteurs d'écran.
        <div className={styles.bandRuler} aria-hidden>
          <div className={styles.bandTrack}>
            <i />
            <b style={{ left: BAND_POSITION[band] }} />
          </div>
          <div className={styles.bandLabels}>
            <span>Bas de fourchette</span>
            <span>Haut de fourchette</span>
          </div>
        </div>
      ) : null}
      {isBand ? (
        <p className={styles.marketBandNote}>{MARKET_GAP_BAND_STARTING_PRICE_NOTE}</p>
      ) : null}
      <p className={styles.marketBandNote}>
        {isBand ? <>{MARKET_GAP_BAND_CAUTION} </> : null}
        <Link href={MARKET_GAP_BAND_METHOD_PATH} className={styles.marketBandLink}>
          {MARKET_GAP_BAND_METHOD_LABEL}
        </Link>
      </p>
      {/* Comptes connectés seulement : sans session, le composant ne rend rien. */}
      {isBand ? <SaleSignalFeedback saleId={saleId} signal="market_gap_band" /> : null}
    </div>
  );
}

/**
 * Essai à l'inscription ouvert : la ligne courte sous le bouton d'inscription de la fiche. Les
 * règles de l'essai en entier (début, durée, une fois par personne, retour à Découverte) sont celles
 * de `launchOfferText("visitor")`, lisibles sur /offres, à la connexion et à l'inscription : la
 * fiche en donne l'essentiel et y renvoie. Aucun texte juridique nouveau.
 */
const LAUNCH_OFFER_SIGNUP_LINE = LAUNCH_OFFER_SHORT_TEXT;

/**
 * Ligne d'accès sous le bouton d'inscription. Offre de lancement active : la mention du visiteur
 * (`launchOfferText("visitor")`) ; sinon la ligne habituelle. Tant que l'état n'est pas lu (rendu
 * serveur compris), une ligne neutre qui ne promet aucun quota, avec une hauteur réservée pour que
 * la mention, plus longue, ne décale pas la page en arrivant. Jamais rendue par le serveur dans sa
 * version « offre » : la coupure de l'offre doit se voir en moins de 60 s.
 */
function SignupAccessLine() {
  const { active, pending } = useLaunchOffer();
  return (
    <p
      className={`${styles.signupLine} ${pending ? styles.signupLinePending : ""}`}
      data-testid="public-signup-line"
    >
      {pending ? (
        "Gratuit, sans carte bancaire"
      ) : active ? (
        <>
          {LAUNCH_OFFER_SIGNUP_LINE}{" "}
          <Link href="/offres" className="underline">
            Voir les conditions
          </Link>
        </>
      ) : (
        freeAccessLine({ launchOffer: false })
      )}
    </p>
  );
}

/**
 * Étiquette d'une ligne de l'aperçu. Pendant l'essai à l'inscription, ce que l'offre Analyse ouvre
 * (enchère plafond, comparables) l'est aussi pendant les 7 jours d'essai ; tant que l'état n'est pas
 * lu, une étiquette qui ne promet rien.
 */
function TeaserTier({ tier, offerAware }: { tier: string; offerAware?: boolean }) {
  const { active, pending } = useLaunchOffer();
  const text = !offerAware
    ? tier
    : pending
      ? "Selon votre compte"
      : active
        ? LAUNCH_OFFER_LABEL
        : tier;
  // Décor : le texte masqué de la ligne dit déjà ce qui débloque la valeur.
  return (
    <span className={styles.teaserTier} aria-hidden>
      {text}
    </span>
  );
}

/**
 * Une section numérotée de la fiche (maquette « dossier » du 06/11/2026) : le grand numéro en or
 * texte dans la marge, le titre et le contenu à côté. `labelled` : la section porte son propre titre
 * `h2` ; sinon le contenu apporte le sien (bloc d'alerte du secteur).
 */
function NumberedSection({
  id,
  number,
  title,
  titleId,
  children,
}: {
  id: string;
  number: string;
  title?: string;
  titleId?: string;
  children: ReactNode;
}) {
  const body = (
    <>
      <div className={styles.secNumber} aria-hidden>
        {number}
      </div>
      <div className={styles.secBody}>
        {title && titleId ? (
          <h2 id={titleId} className={styles.secTitle}>
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </>
  );
  return titleId ? (
    <section id={id} className={styles.sec} aria-labelledby={titleId}>
      {body}
    </section>
  ) : (
    <div id={id} className={styles.sec}>
      {body}
    </div>
  );
}

export function SalePublicPreview({
  saleId,
  preview,
  returnTo,
  requestedHash = "",
  adjudicationStatisticsEnabled = false,
  openFeeRegimes,
  rentReference = null,
  housingTension = null,
  rentalYield = null,
  verifyingAccount = false,
}: {
  saleId: string;
  preview: AuctionSale;
  returnTo: string;
  requestedHash?: string;
  /** The statistics of the tribunal are only announced while their flag is open. */
  adjudicationStatisticsEnabled?: boolean;
  /** Fee regimes whose bid ceiling is open (see `parseOpenFeeRegimes`); absent: every regime whose rules are defined. */
  openFeeRegimes?: readonly FeeRegimeKey[];
  /** Loyer de la commune (carte ANIL) et zonage tendu, lus par le serveur : section « Marché local ». */
  rentReference?: RentReference | null;
  housingTension?: HousingTension | null;
  /** Rendement brut à la mise à prix (ou loyer estimé s'il n'est pas significatif), calculé par le serveur (`publicRentalYield`) ; absent : aucun. */
  rentalYield?: PublicRentalYield | null;
  /**
   * Une session est détectée et ses droits sont en cours de lecture : l'inscription n'a pas de sens
   * pour ce visiteur, la page dit qu'elle vérifie son compte au lieu de proposer d'en créer un.
   */
  verifyingAccount?: boolean;
}) {
  // Le bloc « Pourquoi cette pépite » existe-t-il ? La pastille du haut ne propose « Pourquoi ? » (ancre
  // `#pepite`) qu'à ce moment, sinon elle renvoie à la méthode.
  const [pepiteBlockLoaded, setPepiteBlockLoaded] = useState(false);
  const procedure = getSaleProcedure(preview);
  // The ceiling is promised only when the fee regime of the sale is open (the tribunal for now). Only
  // its terms are needed here: the light vocabulary module keeps the fee rules out of this bundle.
  const ceilingTerms = ceilingTermsFor(feeRegimeKeysForVenue(procedure.venueType, openFeeRegimes));
  const venueCopy = publicSaleVenueCopy(procedure.venueType);
  const state = procedure.venueType === "state";
  const notary = procedure.venueType === "notary";
  const price = preview.starting_price_eur != null && preview.starting_price_eur > 0;
  // Titre long : nom des données structurées et texte alternatif de la photo ; titre court : h1 et
  // fil d'Ariane (avis SEO du 24/10/2026, docs/design/fondations.md).
  const headline = saleHeadline(preview);
  // « 114 m² » ne se coupe pas en fin de ligne (repasse n° 24), comme le titre de la fiche abonné.
  const shortHeading = nonBreakingUnits(saleShortHeading(preview));
  const photo = preview.media?.find((item) => item?.url && (item.type ?? "image") === "image");
  // Photos de l'annonce complète (`get_public_sale_details`) : le compte les ouvre ; la fiche
  // publique n'en montre qu'une.
  const photoCount = Math.max(0, preview.photo_count ?? 0);
  const morePhotos = photoCount > (photo?.url ? 1 : 0);
  const surface = seoSurface(preview.app_surface_m2);
  const hearingDate = formatDate(preview.sale_date, null);
  // Vente dont le jour est passé : signal explicite, ni bouton d'agenda ni bande d'écart (le marché
  // qu'elle comparait à la mise à prix est celui d'un jour qui n'existe plus pour cette vente). Calculé
  // après l'hydratation : le serveur et le premier rendu du navigateur n'ont pas la même heure (à
  // minuit, ou avec une page gardée en cache), et un « jour passé » différent d'un côté à l'autre
  // ferait échouer l'hydratation. Le premier rendu dit « pas passé » des deux côtés, puis le navigateur
  // lit sa propre date.
  const pastDate = useSyncExternalStore(
    subscribeNever,
    () => isPastParisDay(preview.sale_date),
    () => false,
  );
  const hearingTime = saleHearingTime(preview.sale_date);
  const tribunal = procedure.venueType === "tribunal" ? tribunalDisplayName(preview) : null;
  const department = departmentFromCode(preview.department);
  const place = [preview.city, preview.department ? `(${preview.department})` : null]
    .filter(Boolean)
    .join(" ");
  // Prix au m² de la mise à prix : seulement avec une surface publiée (ni estimée, ni de terrain),
  // comme sur les cartes de /sales.
  const displaySurface = getDisplaySurface(preview);
  const startingPricePerM2 =
    price && displaySurface.kind === "recorded" && displaySurface.value
      ? (preview.starting_price_eur as number) / displaySurface.value
      : null;
  const rooms = preview.rooms_count != null && preview.rooms_count > 0 ? preview.rooms_count : null;
  const bedrooms =
    preview.bedrooms_count != null && preview.bedrooms_count > 0 ? preview.bedrooms_count : null;
  // Valeurs transmises par l'avocat poursuivant (même règle que la fiche des comptes) : une mention par
  // bloc, qui nomme les valeurs, plutôt que la même phrase sous chaque demi-colonne.
  const lawyerPropertyItems = [
    {
      label: LAWYER_PROPERTY_TYPE_LABEL,
      source: lawyerSourceForDisplayedValue(preview, "property_type"),
    },
    {
      label: LAWYER_SURFACE_LABEL,
      source: lawyerSourceForDisplayedValue(preview, "surface", {
        surface: preview.app_surface_m2,
      }),
    },
    {
      label: LAWYER_ROOMS_LABEL,
      source: lawyerSourceForDisplayedValue(preview, "rooms_count", { blocked: rooms == null }),
    },
  ];
  const propertyFacts = (
    <>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Type de bien</dt>
          <dd>{seoPropertyLabel(preview.property_type)}</dd>
        </div>
        {surface ? (
          <div className={styles.fact}>
            <dt>Surface</dt>
            <dd className={styles.num}>{surface}</dd>
          </div>
        ) : null}
        {rooms ? (
          <div className={styles.fact}>
            <dt>Pièces</dt>
            <dd className={styles.num}>
              {rooms}
              {bedrooms ? ` · ${bedrooms} chambre${bedrooms > 1 ? "s" : ""}` : ""}
            </dd>
          </div>
        ) : null}
        {place ? (
          <div className={styles.fact}>
            <dt>Lieu</dt>
            <dd>{place}</dd>
          </div>
        ) : null}
      </dl>
      <LawyerFactSourceNote items={lawyerPropertyItems} cahierHref={PIECES_SECTION_HREF} />
    </>
  );
  // Date de la vente, sous la mise à prix ; l'inscription la suit (P12 : le bouton reste en vue dans
  // le panneau collant, à partir de 1024 px). La mise en garde de l'agenda reste sous la date.
  const saleDateRow = hearingDate ? (
    <div className={styles.saleFact}>
      <dt>{procedure.venueType === "tribunal" ? "Date de l’audience" : "Date de la vente"}</dt>
      <dd>
        <span className={styles.num}>
          {hearingDate}
          {hearingTime ? (
            <>
              {" "}
              <span className={styles.nowrap}>à {hearingTime}</span>
            </>
          ) : null}
        </span>
        <LawyerFactSourceNote
          items={[
            {
              label: LAWYER_DAY_LABEL,
              source: lawyerSourceForDisplayedValue(preview, "sale_date"),
            },
          ]}
          cahierHref={PIECES_SECTION_HREF}
        />
        {pastDate ? (
          <span className={styles.pastDate} data-testid="past-sale-date">
            Date de vente passée
          </span>
        ) : null}
        {procedure.venueType === "tribunal" && !pastDate ? (
          <SaleCalendarButton saleId={saleId} />
        ) : null}
      </dd>
    </div>
  ) : procedure.venueType === "notary" ? (
    // Comme la carte de /sales (« Date à confirmer ») : une vente notariale sans date n'a pas
    // à laisser un vide dans la fiche.
    <div className={styles.saleFact}>
      <dt>Date de la vente</dt>
      <dd data-testid="sale-date-to-confirm">À confirmer</dd>
    </div>
  ) : null;
  // Lieu et conditions de la vente, sous l'inscription : « Trouver un avocat » et « Estimer les
  // frais » y restent, sous « Pour enchérir ».
  const saleFactRows = (
    <>
      {tribunal ? (
        <div className={styles.saleFact}>
          <dt>Lieu</dt>
          <dd>
            {preview.tribunal_code ? (
              <Link href={tribunalCodePagePath(preview.tribunal_code)} className={styles.factLink}>
                {tribunal}
              </Link>
            ) : (
              tribunal
            )}
          </dd>
        </div>
      ) : null}
      <div className={styles.saleFact}>
        <dt>{state ? "Mode de cession" : "Type de vente"}</dt>
        <dd>{state ? "À consulter dans le dossier" : saleVenueLabel(procedure.venueType)}</dd>
      </div>
      <div className={styles.saleFact}>
        <dt>{state ? "Démarches" : notary ? "Participation" : "Pour enchérir"}</dt>
        <dd>
          {state ? (
            "Conditions précisées par le service vendeur"
          ) : notary ? (
            "Modalités à consulter dans le dossier"
          ) : (
            <>
              {lawyerRequirementLabel(procedure)}
              {procedure.lawyerRequired === true ? (
                <span className={styles.factLinks} data-testid="public-lawyer-links">
                  <Link href={`/avocats?saleId=${encodeURIComponent(saleId)}`}>
                    Trouver un avocat
                  </Link>
                  <Link href="/simulateur-frais-encheres">Estimer les frais (avocat compris)</Link>
                </span>
              ) : null}
            </>
          )}
        </dd>
      </div>
    </>
  );
  const description = publicSaleDescription(preview);
  // Skeletons only: the real figures are never sent to a signed-out visitor, and no made-up figure
  // either (« 000 000 € » was read as a value by crawlers and assistants). `width` sizes the bar.
  // `offerAware` : l'étiquette change pendant l'offre de lancement (voir `TeaserTier`).
  const analysisTeaserRows: Array<TeaserItem | null> = [
    {
      label: "Valeur estimée",
      width: "wide",
      tier: "Compte gratuit",
      visibleWith: "un compte gratuit",
    },
    price
      ? {
          label: "Écart chiffré avec la mise à prix",
          width: "short",
          tier: "Compte gratuit",
          visibleWith: "un compte gratuit",
        }
      : null,
    ceilingTerms
      ? {
          label: ceilingTerms.ceilingSimulationLabel,
          width: "medium",
          tier: `Offre Analyse, ou ${MONTHLY_SALE_UNLOCKS} déblocages par mois`,
          visibleWith: "l’offre Analyse, ou avec un déblocage",
          offerAware: true,
        }
      : null,
    {
      label: "Ventes comparables du secteur",
      width: "medium",
      tier: "Offre Analyse",
      visibleWith: "l’offre Analyse",
      offerAware: true,
    },
  ];
  const analysisTeaser = analysisTeaserRows.filter((item): item is TeaserItem => item !== null);
  const priceBlock =
    price || !state ? (
      <div className={styles.priceBlock}>
        <p className={styles.priceLabel}>
          {state ? "Prix publié" : <Terme terme="mise-a-prix">Mise à prix</Terme>}
        </p>
        <p className={styles.price}>
          {price ? formatPrice(preview.starting_price_eur) : "À confirmer"}
        </p>
        <p className={styles.priceNote}>
          {state
            ? "Vérifiez les conditions et frais dans l'annonce officielle"
            : "Prix de départ, hors frais"}
          {startingPricePerM2 ? (
            <span className={styles.num}> · {formatPricePerM2(startingPricePerM2)}</span>
          ) : null}
        </p>
        {/* Après « Prix de départ, hors frais » : la nature du prix d'abord, sa source ensuite (P4). */}
        <LawyerFactSourceNote
          items={[
            { label: "", source: lawyerSourceForDisplayedValue(preview, "starting_price_eur") },
          ]}
          cahierHref={PIECES_SECTION_HREF}
        />
        {price && preview.market_gap_band && !pastDate ? (
          <MarketGapBandNote band={preview.market_gap_band} saleId={saleId} />
        ) : null}
      </div>
    ) : (
      <p className={styles.priceUnavailable}>
        Prix non publié · conditions à consulter dans l'annonce officielle
      </p>
    );
  const accountLink = loginPathWithRedirect(
    `${saleDetailPath(saleId, returnTo)}${requestedHash.startsWith("#") ? requestedHash : ""}`,
    { reason: "fiche" },
  );
  const followLink = loginPathWithRedirect(saleDetailPath(saleId, returnTo), { reason: "favori" });
  const salesReturn = salesReturnHref(returnTo, preview.id ?? saleId);
  // Sous la date de la vente : l'inscription, les actions secondaires et la ligne d'accès commune.
  // Avec une session détectée, la page dit qu'elle vérifie le compte.
  const signupBlock = (
    <div className={styles.signup} data-testid="public-signup">
      {verifyingAccount ? (
        <p role="status" className={styles.signupStatus}>
          Vérification de votre compte…
        </p>
      ) : (
        <>
          <Link href={accountLink} className={`${styles.primary} ${styles.block}`}>
            Créer mon compte gratuit
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <div className={styles.actionRow}>
            <Link href={followLink} className={styles.ghost} aria-label="Suivre cette vente">
              <Heart className="h-4 w-4" aria-hidden />
              Suivre
            </Link>
            {/* Le catalogue s'ouvre avec cette vente déjà dans la comparaison (`?comparer=`). */}
            <Link
              href={salesCompareHref(returnTo, preview.id ?? saleId)}
              className={styles.ghost}
              aria-label="Comparer avec d’autres ventes de la liste"
            >
              Comparer
            </Link>
            <SalePublicShareButton title={headline} className={styles.ghost} />
          </div>
          <p className={styles.signupText}>
            {/* Une photo est déjà visible : le compte ouvre « les autres », pas « les photos ». */}
            Créez votre compte gratuit pour voir l’adresse, l’occupation,{" "}
            {photo?.url ? "les autres photos" : "les photos"} et la fourchette de valeur de cette
            vente.
          </p>
          <SignupAccessLine />
        </>
      )}
    </div>
  );
  const venueSentence = saleVenueSentence(preview);
  // Ligne sous le titre : lieu · type de vente · date et heure (la référence est dans le titre).
  const headingLine = [
    department
      ? `${department.name} (${department.code})`
      : preview.department
        ? `Département ${preview.department}`
        : null,
    hearingDate
      ? `${venueSentence}${procedure.venueType === "tribunal" ? ", audience" : ""} le ${hearingDate}${hearingTime ? ` à ${hearingTime}` : ""}`
      : venueSentence,
  ]
    .filter(Boolean)
    .join(" · ");
  const showMarket = Boolean(rentReference?.source.startsWith("anil_") || housingTension);
  const showAlert = Boolean(preview.department && !verifyingAccount);

  // Sections dans l'ordre de la maquette ; une section sans contenu disparaît et la suite est renumérotée.
  const sectionDefs = [
    { id: "le-bien", label: "Le bien", show: true },
    { id: "la-vente", label: "La vente", show: true },
    { id: "marche-local", label: "Marché local", show: showMarket },
    { id: "analyse", label: "Analyse", show: true },
    { id: PIECES_SECTION_ID, label: "Pièces et vérifications", show: true },
    { id: "etre-prevenu", label: "Être prévenu", show: showAlert },
  ].filter((section) => section.show);
  const tocItems: SalePublicTocItem[] = sectionDefs.map((section, index) => ({
    id: section.id,
    number: String(index + 1).padStart(2, "0"),
    label: section.label,
  }));
  const numberOf = (id: string) => tocItems.find((item) => item.id === id)?.number ?? "";

  const mainVisual = photo?.url ? (
    <figure className={styles.galleryMain}>
      <ListingPhoto
        src={photo.url}
        mirror={photoMirrorForDetail(photo.mirror)}
        alt={`Photo du bien : ${headline}`}
        className="h-full w-full object-cover"
        fetchPriority="high"
      />
      <span className={styles.mediaTag} aria-hidden>
        Photo de l’annonce
      </span>
      {photoCount > 1 ? (
        <span className={styles.photoCounter}>
          <span aria-hidden>1 / {photoCount}</span>
          <span className="sr-only">
            Photo 1 sur {photoCount}, les autres avec un compte gratuit
          </span>
        </span>
      ) : null}
    </figure>
  ) : (
    // Sans photo : l'illustration du type de bien, toujours signalée (docs/design/fondations.md).
    <div className={`${styles.galleryMain} ${styles.illustration}`}>
      <span className={styles.illustrationTag} aria-hidden>
        Illustration
      </span>
      <SalePublicIllustrationLazy propertyType={preview.property_type ?? null} />
      {preview.city ? <span className={styles.illustrationPlace}>{preview.city}</span> : null}
    </div>
  );

  return (
    <main id="contenu" className={styles.page}>
      <div className={styles.container}>
        <div className={styles.grid}>
          <div className={styles.crumbs}>
            <Link href={salesReturn} className={styles.back}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {salesReturnLabel(returnTo)}
            </Link>
            {/* Même chemin que le BreadcrumbList JSON-LD de la fiche (Accueil, Ventes, la vente). */}
            <nav className={styles.breadcrumb} aria-label="Fil d’Ariane">
              <ol>
                <li>
                  <Link href="/">Accueil</Link>
                </li>
                <li>
                  <Link href="/sales">Ventes</Link>
                </li>
                <li>
                  <span aria-current="page" title={shortHeading}>
                    {shortHeading}
                  </span>
                </li>
              </ol>
            </nav>
          </div>

          <header className={styles.head}>
            <div className={styles.tags}>
              <SaleProcedureBadge sale={preview} />
              <SalePublicDeadlineLazy sale={preview} />
              {preview.pepite ? <PepiteHeroBadge blockLoaded={pepiteBlockLoaded} /> : null}
            </div>
            <h1 id="public-sale-title" className={styles.title}>
              {shortHeading}
              <span className={styles.reference}>Réf. {saleReference(saleId)}</span>
            </h1>
            <p className={styles.subtitle}>{headingLine}</p>
          </header>

          <div className={styles.gallery}>
            <div className={`${styles.galleryGrid} ${morePhotos ? styles.galleryWithSide : ""}`}>
              {mainVisual}
              {morePhotos ? (
                // Les autres photos sont réservées au compte : visuel réservé (fond beige, cadenas).
                <div className={styles.gallerySide}>
                  <LockKeyhole className={styles.galleryLock} aria-hidden />
                  <Link href={accountLink} className={styles.white}>
                    <Camera className="h-4 w-4" aria-hidden />
                    Voir les {photoCount} photos
                  </Link>
                  <span className={styles.gallerySideNote}>avec un compte gratuit</span>
                </div>
              ) : null}
            </div>
            {photo?.url ? (
              <PhotoCredit
                credit={photoCredit(photo.url, preview)}
                className={styles.galleryCaption}
                linkClassName="hover:text-foreground"
              />
            ) : null}
          </div>

          {/* Fiche de vente : sous le titre sur mobile, à droite et suivant le défilement sur ordinateur. */}
          <aside className={styles.side} aria-label="Synthèse de la vente" data-sale-synthesis>
            <div className={styles.panel}>
              <p className={styles.eyebrow}>Fiche de vente</p>
              {priceBlock}
              {saleDateRow ? <dl className={styles.saleFacts}>{saleDateRow}</dl> : null}
              {signupBlock}
              <dl className={styles.saleFacts}>{saleFactRows}</dl>
            </div>
            <Link href="/simulateur-frais-encheres" className={styles.sideLink}>
              <span>
                <b>Calculer les frais d’enchères</b>
                <span>Ce qui s’ajoute au prix d’adjudication</span>
              </span>
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </aside>

          <div className={styles.body}>
            <SalePublicToc items={tocItems} />

            <NumberedSection
              id="le-bien"
              number={numberOf("le-bien")}
              title="Le bien"
              titleId="public-property-title"
            >
              {propertyFacts}
              {description.amenities.length > 0 ? (
                <ul className={styles.amenities} aria-label="Équipements mentionnés">
                  {description.amenities.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <p className={styles.description}>{description.sentence}</p>
              <p className={styles.sourceNote} data-testid="public-source-note">
                {preview.source_label ? <>Source de l’annonce : {preview.source_label}. </> : null}
                <Link href={contactReportPath(saleId)}>Signaler une erreur sur cette fiche</Link>
              </p>
            </NumberedSection>

            <NumberedSection
              id="la-vente"
              number={numberOf("la-vente")}
              title="La vente"
              titleId="public-sale-steps-title"
            >
              <SalePublicSaleStepsLazy
                procedure={procedure}
                hearingLabel={
                  hearingDate
                    ? `${hearingDate}${hearingTime ? ` à ${hearingTime}` : ""}`
                    : "Date à confirmer"
                }
                venueSentence={venueSentence}
                explanation={venueCopy.explanation}
                ceilingTerms={ceilingTerms}
                adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
              />
            </NumberedSection>

            {/* Marché locatif de la commune : seulement s'il a quelque chose à dire. */}
            {showMarket ? (
              <NumberedSection
                id="marche-local"
                number={numberOf("marche-local")}
                title="Marché local"
                titleId="public-market-title"
              >
                <SalePublicRentalMarketLazy
                  reference={rentReference}
                  tension={housingTension}
                  yieldValue={rentalYield}
                />
              </NumberedSection>
            ) : null}

            <div id="analyse" className={styles.sec}>
              <div className={styles.secNumber} aria-hidden>
                {numberOf("analyse")}
              </div>
              <div className={styles.secBody}>
                {/* « Pourquoi cette pépite » : les noms des critères, jamais un montant ni un flou ; le
                    détail demande un compte. Le repère vient de `get_public_sale_pepite` (mode « on »). */}
                {preview.pepite ? (
                  <PepiteBlockLazy
                    saleId={saleId}
                    known
                    onLoadedChange={setPepiteBlockLoaded}
                    lockedAction={
                      <Link
                        href={accountLink}
                        className="font-semibold text-gold-text underline underline-offset-4"
                      >
                        Créez un compte gratuit pour voir le détail du calcul
                      </Link>
                    }
                  />
                ) : null}
                <section className={styles.lock} aria-labelledby="public-teaser-title">
                  <p className={styles.lockEyebrow}>Réservé aux comptes</p>
                  <h2 id="public-teaser-title" className={styles.lockTitle}>
                    L’analyse de cette vente
                  </h2>
                  <dl className={styles.teaser}>
                    {analysisTeaser.map((item) => (
                      <div key={item.label} className={styles.teaserRow}>
                        <dt>
                          <LockKeyhole aria-hidden />
                          {item.label}
                        </dt>
                        <dd>
                          {/* La barre est un décor (aria-hidden) et ne porte aucun chiffre : un
                              lecteur d'écran entend que la valeur est masquée et ce qui la débloque. */}
                          <span className="sr-only">
                            Valeur masquée, visible avec {item.visibleWith}
                          </span>
                          <span
                            className={`${styles.skeleton} ${styles[`skeleton_${item.width}`]}`}
                            aria-hidden
                            data-nosnippet
                          />
                          <TeaserTier tier={item.tier} offerAware={item.offerAware} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {verifyingAccount ? null : (
                    <div className={styles.lockAction}>
                      <Link href={accountLink} className={styles.white}>
                        Créer mon compte gratuit
                        <ArrowRight className="h-4 w-4" aria-hidden />
                      </Link>
                      <p>Sans carte bancaire.</p>
                    </div>
                  )}
                </section>
                {/* « Mon dossier » (statut, enchère plafond) : ce que le compte gratuit ajoute, sans le
                    montrer. Hors du bloc « L’analyse » : le plafond noté est le sien, pas un calcul
                    promis. */}
                <p className={styles.dossierNote} data-testid="public-dossier-teaser">
                  <FolderHeart aria-hidden />
                  <span>
                    {/* Sans régime de frais ouvert, aucun plafond n'est promis sur la page : le statut seul. */}
                    {ceilingTerms
                      ? `Compte gratuit : notez votre statut et votre ${ceilingTerms.ceilingTerm} sur chaque vente suivie.`
                      : "Compte gratuit : notez votre statut sur chaque vente suivie."}
                  </span>
                </p>
              </div>
            </div>

            <NumberedSection
              id={PIECES_SECTION_ID}
              number={numberOf(PIECES_SECTION_ID)}
              title="Pièces et vérifications"
              titleId="public-checks-title"
            >
              <SalePublicChecksLazy
                preview={preview}
                saleId={saleId}
                unlockOffered={Boolean(ceilingTerms)}
              />
            </NumberedSection>

            {showAlert ? (
              <NumberedSection id="etre-prevenu" number={numberOf("etre-prevenu")}>
                <div className={styles.alert} data-testid="public-sector-alert">
                  <SectorAlertCtaLazy
                    criteria={{ department: preview.department as string }}
                    intro="Cette vente vous intéresse ? Recevez les nouvelles ventes du même département."
                  />
                </div>
              </NumberedSection>
            ) : null}

            <SalePublicFurtherLazy returnTo={returnTo} />
          </div>
        </div>
      </div>

      {/* Mobile : la mise à prix et l'inscription restent à portée de pouce, une fois la synthèse
          passée. */}
      {verifyingAccount ? null : (
        <SalePublicMobileBar className={styles.mobileBar}>
          <div>
            <p className={styles.mobileBarPrice}>
              {price
                ? formatPrice(preview.starting_price_eur)
                : state
                  ? "Conditions au dossier"
                  : "À confirmer"}
            </p>
            <p className={styles.mobileBarNote}>
              {[state ? "prix publié" : "mise à prix", formatShortDate(preview.sale_date, "")]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Link href={accountLink} className={styles.primary}>
            Créer mon compte
          </Link>
        </SalePublicMobileBar>
      )}
    </main>
  );
}

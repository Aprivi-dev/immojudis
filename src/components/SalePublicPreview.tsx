"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import FolderHeart from "lucide-react/dist/esm/icons/folder-heart.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import dynamic from "next/dynamic";
import { Terme } from "@/components/ceiling/Terme";
import { PepiteHeroBadge } from "@/components/PepiteBadge";
import { PepiteBlockLazy } from "@/components/sale-detail/PepiteBlockLazy";
import { ListingPhoto } from "@/components/ListingPhoto";
import { PhotoCredit } from "@/components/PhotoCredit";
import { PropertyIllustration, illustrationKind } from "@/components/PropertyIllustration";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { SalePublicDeadline } from "@/components/SalePublicDeadline";
import { SalePublicShareButton } from "@/components/SalePublicShareButton";
import { SalePublicToc, type SalePublicTocItem } from "@/components/SalePublicToc";
import { Badge } from "@/components/ui/primitives";
import { contactReportPath } from "@/lib/contact-message";
import { departmentFromCode } from "@/lib/department-pages";
import { photoCredit } from "@/lib/photo-credit";
import { photoMirrorForDetail } from "@/lib/photo-mirror";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { SalePointsToVerify } from "@/components/sale-detail/SalePointsToVerify";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import { isPastSaleDay } from "@/lib/sale-countdown";
import { formatPrice, formatPricePerM2 } from "@/lib/format";
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
  salesReturnHref,
  salesReturnLabel,
} from "@/lib/navigation";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_LABEL, LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { freeAccessLine, MONTHLY_SALE_UNLOCKS, unlockedItemsText } from "@/lib/sale-unlocks";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  saleVerificationExplanation,
  saleVerificationLabel,
  saleVenueLabel,
  type SaleProcedurePresentation,
} from "@/lib/sale-procedure";
import {
  saleHeadline,
  saleHearingTime,
  saleReference,
  saleShortHeading,
  saleVenueSentence,
  seoLongDate,
  seoPropertyLabel,
  seoSurface,
  tribunalDisplayName,
} from "@/lib/seo";
import { tribunalCodePagePath } from "@/lib/tribunal-code-path";
import type { HousingTension } from "@/lib/housing-tension";
import type { RentReference } from "@/lib/rent-reference";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

/**
 * « Marché local » chargé à la demande : le calcul du rendement (frais d'acquisition, régimes) n'est
 * pas nécessaire au premier affichage (budget de JavaScript client, voir `check-build-budgets.mjs`).
 * Rendu par le serveur comme le reste de la fiche.
 */
const SalePublicRentalMarketLazy = dynamic(() =>
  import("@/components/SalePublicRentalMarket").then((module) => module.SalePublicRentalMarket),
);

/**
 * Internal links of the public page: they carry the visitor from one sale to the pages that
 * explain how a sale works, and give crawlers a path from every sale to the guides.
 */
const FURTHER_READING_LINKS = [
  {
    href: "/ventes-immobilieres-judiciaires",
    label: "Le guide des ventes immobilières judiciaires",
    hint: "Comprendre le déroulement d’une vente",
  },
  {
    href: "/ressources/frais-vente-encheres-judiciaire",
    label: "Les frais d’une vente aux enchères",
    hint: "Ce qui s’ajoute au prix d’adjudication",
  },
  {
    href: "/tribunaux",
    label: "Les tribunaux",
    hint: "L’activité des tribunaux qui organisent des ventes",
  },
  {
    href: "/simulateur-frais-encheres",
    label: "Le simulateur de frais",
    hint: "Estimer les frais d’une enchère",
  },
] as const;

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

const shortDateFormat = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Paris",
});

function shortSaleDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? shortDateFormat.format(date) : null;
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
  const shortHeading = saleShortHeading(preview);
  const photo = preview.media?.find((item) => item?.url && (item.type ?? "image") === "image");
  // Photos de l'annonce complète (`get_public_sale_details`) : le compte les ouvre ; la fiche
  // publique n'en montre qu'une.
  const photoCount = Math.max(0, preview.photo_count ?? 0);
  const morePhotos = photoCount > (photo?.url ? 1 : 0);
  const surface = seoSurface(preview.app_surface_m2);
  const hearingDate = seoLongDate(preview.sale_date);
  // Vente dont le jour est passé : signal explicite, ni bouton d'agenda ni bande d'écart (le marché
  // qu'elle comparait à la mise à prix est celui d'un jour qui n'existe plus pour cette vente). Calculé
  // après l'hydratation : le serveur et le premier rendu du navigateur n'ont pas la même heure (à
  // minuit, ou avec une page gardée en cache), et un « jour passé » différent d'un côté à l'autre
  // ferait échouer l'hydratation. Le premier rendu dit « pas passé » des deux côtés, puis le navigateur
  // lit sa propre date.
  const pastDate = useSyncExternalStore(
    subscribeNever,
    () => isPastSaleDay(preview.sale_date),
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
  const propertyFacts = (
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
  );
  // Date, lieu et conditions de la vente : la liste de la fiche de vente, sous la mise à prix.
  const saleFactRows = (
    <>
      {hearingDate ? (
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
      ) : null}
      {tribunal ? (
        <div className={styles.saleFact}>
          <dt>Lieu</dt>
          <dd>
            {preview.tribunal_code ? (
              <Link href={tribunalCodePagePath(preview.tribunal_code)} className="underline">
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
  // Sous la liste des faits : l'inscription, les actions secondaires et la ligne d'accès commune.
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
            {/* La comparaison se fait depuis la liste des ventes, où la carte de cette vente attend. */}
            <Link
              href={salesReturn}
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
  const steps = timelineSteps(procedure);
  const points = pointsToVerify(preview, { occupancyVisible: false });
  const verified = ["verified", "cross_checked"].includes(procedure.verificationStatus);
  const documentCount = Math.max(0, preview.document_count ?? 0);
  const showMarket = Boolean(rentReference?.source.startsWith("anil_") || housingTension);
  const showAlert = Boolean(preview.department && !verifyingAccount);

  // Sections dans l'ordre de la maquette ; une section sans contenu disparaît et la suite est renumérotée.
  const sectionDefs = [
    { id: "le-bien", label: "Le bien", show: true },
    { id: "la-vente", label: "La vente", show: true },
    { id: "marche-local", label: "Marché local", show: showMarket },
    { id: "analyse", label: "Analyse", show: true },
    { id: "pieces-et-verifications", label: "Pièces et vérifications", show: true },
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
      <PropertyIllustration kind={illustrationKind(preview.property_type)} />
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
              <SalePublicDeadline sale={preview} />
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
          <aside className={styles.side} aria-label="Synthèse de la vente">
            <div className={styles.panel}>
              <p className={styles.eyebrow}>Fiche de vente</p>
              {priceBlock}
              <dl className={styles.saleFacts}>{saleFactRows}</dl>
              {signupBlock}
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
                  <small className={styles.num}>
                    {hearingDate
                      ? `${hearingDate}${hearingTime ? ` à ${hearingTime}` : ""}`
                      : "Date à confirmer"}
                  </small>
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
                  <p className={styles.procedureText}>
                    {withAdjudicationTerm(venueCopy.explanation)}
                  </p>
                  <ol className={styles.tiers} aria-label="Ce que vous voyez, selon votre accès">
                    <li className={styles.tier}>
                      <h3 className={styles.tierTitle}>
                        <Eye aria-hidden />
                        Visible maintenant
                      </h3>
                      <p>
                        {state
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
                        Adresse, photos, description, occupation, dates de visite et contact du
                        dossier, fourchette de valeur estimée, Street View, météo et risques de la
                        commune. Et {MONTHLY_SALE_UNLOCKS} déblocages par mois, chacun ouvrant, pour
                        une vente :{" "}
                        {unlockedItemsText({
                          ceiling: ceilingTerms?.ceilingTermWithArticle ?? null,
                          statistics:
                            procedure.venueType === "tribunal" && adjudicationStatisticsEnabled,
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
                    Immojudis référence les ventes immobilières au tribunal, chez le notaire et les
                    ventes domaniales. Les règles affichées s’adaptent au type de chaque vente.
                  </p>
                </div>
              </details>
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
                  sale={preview}
                  startingPriceEur={price ? preview.starting_price_eur : null}
                  surfaceM2={preview.app_surface_m2 ?? null}
                  reference={rentReference}
                  tension={housingTension}
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
              id="pieces-et-verifications"
              number={numberOf("pieces-et-verifications")}
              title="Pièces et vérifications"
              titleId="public-checks-title"
            >
              <div className={styles.checks}>
                <div className={styles.box}>
                  <Badge
                    tone={
                      verified
                        ? "success"
                        : procedure.verificationStatus === "conflict"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {verified ? (
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <CircleAlert className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {saleVerificationLabel(procedure.verificationStatus)}
                  </Badge>
                  <p>{saleVerificationExplanation(procedure.verificationStatus)}</p>
                </div>
                {/* Cible de `#points-a-verifier` ; l'occupation n'est pas lue sur l'aperçu public. */}
                <SalePointsToVerify points={points} saleId={saleId} className={styles.points} />
              </div>
              <ul className={styles.docs} aria-label="Pièces et sources">
                {documentCount > 0 ? (
                  <li>
                    <FileText aria-hidden />
                    <b>Pièces du dossier</b>
                    <span>
                      {documentCount} pièce{documentCount > 1 ? "s" : ""}, avec l’offre Analyse
                      {ceilingTerms ? " ou un déblocage" : ""}
                    </span>
                  </li>
                ) : null}
                <li>
                  <FileText aria-hidden />
                  <b>Risques naturels et technologiques</b>
                  <a
                    href="https://www.georisques.gouv.fr/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Consulter Géorisques
                  </a>
                </li>
              </ul>
              <p className={styles.officialSources}>
                Les sources officielles restent consultables librement.
              </p>
            </NumberedSection>

            {showAlert ? (
              <NumberedSection id="etre-prevenu" number={numberOf("etre-prevenu")}>
                <div className={styles.alert} data-testid="public-sector-alert">
                  <SectorAlertCta
                    criteria={{ department: preview.department as string }}
                    intro="Cette vente vous intéresse ? Recevez les nouvelles ventes du même département."
                  />
                </div>
              </NumberedSection>
            ) : null}

            <section className={styles.further} aria-labelledby="public-further-title">
              <h2 id="public-further-title" className={styles.furtherTitle}>
                Pour aller plus loin
              </h2>
              <ul className={styles.furtherList}>
                {FURTHER_READING_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                    <span>{link.hint}</span>
                  </li>
                ))}
              </ul>
            </section>
            <Link href={returnTo} className={`${styles.secondary} ${styles.continue}`}>
              Continuer ma recherche
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile : la mise à prix et l'inscription restent à portée de pouce. */}
      {verifyingAccount ? null : (
        <div className={styles.mobileBar}>
          <div>
            <p className={styles.mobileBarPrice}>
              {price
                ? formatPrice(preview.starting_price_eur)
                : state
                  ? "Conditions au dossier"
                  : "À confirmer"}
            </p>
            <p className={styles.mobileBarNote}>
              {[state ? "prix publié" : "mise à prix", shortSaleDate(preview.sale_date)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Link href={accountLink} className={styles.primary}>
            Créer mon compte
          </Link>
        </div>
      )}
    </main>
  );
}

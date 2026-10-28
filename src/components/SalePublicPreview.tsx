"use client";

import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import FolderHeart from "lucide-react/dist/esm/icons/folder-heart.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { Terme } from "@/components/ceiling/Terme";
import { PepiteHeroBadge } from "@/components/PepiteBadge";
import { PepiteBlockLazy } from "@/components/sale-detail/PepiteBlockLazy";
import { ListingPhoto } from "@/components/ListingPhoto";
import { PhotoCredit } from "@/components/PhotoCredit";
import { SectorAlertCta } from "@/components/SectorAlertCta";
import { contactReportPath } from "@/lib/contact-message";
import { photoCredit } from "@/lib/photo-credit";
import { photoMirrorForDetail } from "@/lib/photo-mirror";
import { SaleCalendarButton } from "@/components/SaleCalendarButton";
import { SalePointsToVerify } from "@/components/sale-detail/SalePointsToVerify";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import { isPastSaleDay } from "@/lib/sale-countdown";
import { formatPrice } from "@/lib/format";
import {
  MARKET_GAP_BAND_CAUTION,
  MARKET_GAP_BAND_LABELS,
  MARKET_GAP_BAND_METHOD_LABEL,
  MARKET_GAP_BAND_METHOD_PATH,
  MARKET_GAP_BAND_STARTING_PRICE_NOTE,
  type PublicMarketGapBand,
} from "@/lib/market-gap-band";
import { publicSaleDescription } from "@/lib/public-sale-description";
import {
  loginPathWithRedirect,
  saleDetailPath,
  salesReturnHref,
  salesReturnLabel,
} from "@/lib/navigation";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import { ceilingTermsFor } from "@/lib/fee-regime-labels";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { freeAccessLine, MONTHLY_SALE_UNLOCKS, unlockedItemsText } from "@/lib/sale-unlocks";
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
  saleHeadingSubtitle,
  saleShortHeading,
  seoLongDate,
  seoPropertyLabel,
  seoSurface,
  tribunalDisplayName,
} from "@/lib/seo";
import { tribunalPagePath } from "@/lib/tribunal-pages";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import styles from "./SalePublicPreview.module.css";

/**
 * Internal links of the public page: they carry the visitor from one sale to the pages that
 * explain how a sale works, and give crawlers a path from every sale to the guides.
 */
const FURTHER_READING_LINKS = [
  {
    href: "/ventes-immobilieres-judiciaires",
    label: "Le guide des ventes immobilières judiciaires",
    hint: "comprendre le déroulement d’une vente",
  },
  {
    href: "/ressources/frais-vente-encheres-judiciaire",
    label: "Les frais d’une vente aux enchères",
    hint: "ce qui s’ajoute au prix d’adjudication",
  },
  {
    href: "/tribunaux",
    label: "Les tribunaux",
    hint: "l’activité des tribunaux qui organisent des ventes",
  },
  {
    href: "/simulateur-frais-encheres",
    label: "Le simulateur de frais",
    hint: "estimer les frais d’une enchère",
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
        ? "Essai gratuit de 7 jours"
        : tier;
  // Décor : le texte masqué de la ligne dit déjà ce qui débloque la valeur.
  return (
    <span className={styles.teaserTier} aria-hidden>
      {text}
    </span>
  );
}

export function SalePublicPreview({
  saleId,
  preview,
  returnTo,
  requestedHash = "",
  adjudicationStatisticsEnabled = false,
  openFeeRegimes,
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
    </dl>
  );
  // Date, lieu et conditions de la vente : la colonne de synthèse, sous la mise à prix.
  const hearingFacts = (
    <>
      {hearingDate ? (
        <div className={styles.saleFact}>
          <dt>{procedure.venueType === "tribunal" ? "Date de l’audience" : "Date de la vente"}</dt>
          <dd>
            {hearingDate}
            {hearingTime ? ` à ${hearingTime}` : ""}
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
      ) : null}
      {tribunal ? (
        <div className={styles.saleFact}>
          <dt>Tribunal</dt>
          <dd>
            {preview.tribunal_code ? (
              <Link href={tribunalPagePath(preview.tribunal_code)} className="underline">
                {tribunal}
              </Link>
            ) : (
              tribunal
            )}
          </dd>
        </div>
      ) : null}
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
  // Sous le prix, là où le visiteur se demande ce que cache le reste : l'inscription, avec la ligne
  // d'accès commune. Avec une session détectée, la page dit qu'elle vérifie le compte.
  const signupBlock = (
    <div className={styles.signup} data-testid="public-signup">
      {verifyingAccount ? (
        <p role="status" className={styles.signupStatus}>
          Vérification de votre compte…
        </p>
      ) : (
        <>
          <p className={styles.signupText}>
            {/* Une photo est déjà visible : le compte ouvre « les autres », pas « les photos ». */}
            Créez votre compte gratuit pour voir l’adresse,{" "}
            {photo?.url ? "les autres photos" : "les photos"} et la fourchette de valeur de cette
            vente.
          </p>
          <Link href={accountLink} className={styles.primary}>
            Créer mon compte gratuit
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <SignupAccessLine />
        </>
      )}
    </div>
  );
  const saleFacts = (
    <dl className={styles.saleFacts}>
      {hearingFacts}
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
    </dl>
  );
  const subtitle = saleHeadingSubtitle(preview);

  return (
    <main id="contenu" className={styles.page}>
      <div className={styles.container}>
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
        <Link href={salesReturnHref(returnTo, preview.id ?? saleId)} className={styles.back}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {salesReturnLabel(returnTo)}
        </Link>

        <header className={styles.head}>
          <SaleProcedureBadge sale={preview} />
          {preview.pepite ? <PepiteHeroBadge blockLoaded={pepiteBlockLoaded} /> : null}
          <h1 id="public-sale-title" className={styles.title}>
            {shortHeading}
            <span className={styles.reference}>Réf. {saleReference(saleId)}</span>
          </h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </header>

        <div className={styles.layout}>
          {photo?.url ? (
            <div className={styles.photoArea}>
              <figure className={styles.photo}>
                <ListingPhoto
                  src={photo.url}
                  mirror={photoMirrorForDetail(photo.mirror)}
                  alt={`Photo du bien : ${headline}`}
                  className="h-full w-full object-cover"
                  fetchPriority="high"
                />
              </figure>
              <PhotoCredit
                credit={photoCredit(photo.url, preview)}
                className="mt-1.5 block text-xs text-muted-foreground"
                linkClassName="hover:text-foreground"
              />
            </div>
          ) : null}

          {/* Synthèse : sous la photo sur mobile, à droite et suivant le défilement sur ordinateur. */}
          <aside className={styles.summary} aria-label="Synthèse de la vente">
            <div className={styles.summaryCard}>
              {priceBlock}
              {saleFacts}
              {signupBlock}
            </div>
            <div className={styles.verification}>
              <ShieldCheck aria-hidden />
              <p>
                <strong>{saleVerificationLabel(procedure.verificationStatus)}</strong>
                <br />
                {saleVerificationExplanation(procedure.verificationStatus)}
              </p>
            </div>
          </aside>

          <div className={styles.body}>
            <section className={styles.card} aria-labelledby="public-property-title">
              <h2 id="public-property-title" className={styles.cardTitle}>
                Le bien
              </h2>
              {propertyFacts}
              <p className={styles.sourceNote} data-testid="public-source-note">
                {preview.source_label ? <>Source de l’annonce : {preview.source_label}. </> : null}
                <Link href={contactReportPath(saleId)} className="underline">
                  Signaler une erreur sur cette fiche
                </Link>
              </p>
              <p className={styles.description}>{description.sentence}</p>
              {description.amenities.length > 0 ? (
                <ul className={styles.amenities} aria-label="Équipements mentionnés">
                  {description.amenities.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </section>

            {/* Cible de `#points-a-verifier` ; l'occupation n'est pas lue sur l'aperçu public. */}
            <SalePointsToVerify
              points={pointsToVerify(preview, { occupancyVisible: false })}
              saleId={saleId}
            />

            {/* « Pourquoi cette pépite » : les noms des critères, jamais un montant ni un flou ; le détail
                demande un compte. Le repère vient de `get_public_sale_pepite` (mode « on » seulement). */}
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

            <section className={styles.card} aria-labelledby="public-teaser-title">
              <h2 id="public-teaser-title" className={styles.cardTitle}>
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
                      {/* La barre est un décor (aria-hidden) et ne porte aucun chiffre : un lecteur
                          d'écran entend que la valeur est masquée et ce qui la débloque. */}
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
            </section>

            {/* « Mon dossier » (statut, enchère plafond) : ce que le compte gratuit ajoute, sans le
                montrer. Hors du bloc « L’analyse » : le plafond noté est le sien, pas un calcul promis. */}
            <p className={styles.dossierNote} data-testid="public-dossier-teaser">
              <FolderHeart aria-hidden />
              <span>
                {/* Sans régime de frais ouvert, aucun plafond n'est promis sur la page : le statut seul. */}
                {ceilingTerms
                  ? `Compte gratuit : notez votre statut et votre ${ceilingTerms.ceilingTerm} sur chaque vente suivie.`
                  : "Compte gratuit : notez votre statut sur chaque vente suivie."}
              </span>
            </p>

            <section className={styles.card} aria-labelledby="public-procedure-title">
              <h2 id="public-procedure-title" className={styles.cardTitle}>
                Cette vente en clair
              </h2>
              <p className={styles.procedureText}>{withAdjudicationTerm(venueCopy.explanation)}</p>
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
                    Adresse, photos, description, occupation, dates de visite et contact du dossier,
                    fourchette de valeur estimée, Street View, météo et risques de la commune. Et{" "}
                    {MONTHLY_SALE_UNLOCKS} déblocages par mois, chacun ouvrant, pour une vente :{" "}
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
              <Link href={returnTo} className={styles.secondary}>
                Continuer ma recherche
              </Link>
            </section>

            {preview.department && !verifyingAccount ? (
              <div data-testid="public-sector-alert">
                <SectorAlertCta
                  criteria={{ department: preview.department }}
                  intro="Cette vente vous intéresse ? Recevez les nouvelles ventes du même département."
                />
              </div>
            ) : null}

            <section aria-labelledby="public-further-title">
              <h2 id="public-further-title" className={styles.cardTitle}>
                Pour aller plus loin
              </h2>
              <ul className={styles.further}>
                {FURTHER_READING_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                    <span> : {link.hint}</span>
                  </li>
                ))}
              </ul>
            </section>
            <p className={styles.officialSources}>
              Les sources officielles restent consultables librement :{" "}
              <a href="https://www.georisques.gouv.fr/" target="_blank" rel="noopener noreferrer">
                consulter Géorisques
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

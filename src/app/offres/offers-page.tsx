"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import Gift from "lucide-react/dist/esm/icons/gift.js";
import LockKeyholeOpen from "lucide-react/dist/esm/icons/lock-keyhole-open.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";
import { Terme, type TermeKey } from "@/components/ceiling/Terme";
import { Badge, Card, Eyebrow, buttonClasses } from "@/components/ui/primitives";
import {
  ANALYSIS_TRIAL_DAYS,
  analysisSubscriptionTerms,
  resolveAnalysisOfferLabel,
} from "@/lib/analysis-offer";
import { useAuth } from "@/hooks/use-auth";
import { useBillingOffer, type BillingOfferState } from "@/hooks/use-billing-offer";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import {
  LAUNCH_OFFER_DATA_TEXT,
  LAUNCH_OFFER_DURATION_TEXT,
  LAUNCH_OFFER_LABEL,
  launchOfferText,
} from "@/lib/launch-offer";
import {
  analysisOfferDescription,
  offerComparisonRows,
  splitOfferComparisonRows,
  type OfferCell,
  type OfferRow,
} from "@/lib/offer-comparison";
import { PLAN_LIMITS } from "@/lib/plans";
import {
  ceilingTermIndefiniteText,
  ceilingTermWithArticleText,
  ceilingTermWithScopeText,
} from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { MONTHLY_SALE_UNLOCKS, unlockedItemsText } from "@/lib/sale-unlocks";
import Link from "next/link";
import { pathWithSearch } from "@/lib/navigation";
import { trackProductEvent } from "@/lib/product-events";

// Le montant plafond s'appelle « enchère plafond » (tribunal, vente notariale à la bougie) ou
// « offre plafond » (vente notariale interactive) : les textes de la page reflètent les régimes
// ouverts (`openFeeRegimes`, lus côté serveur dans `CEILING_FEE_REGIMES_OPEN`).
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

type Benefit = {
  icon: ReactNode;
  title: string;
  text: string;
  /** Terme du titre à définir : la bulle « ? » suit le titre. */
  term?: TermeKey;
};

const benefits = (open?: readonly FeeRegimeKey[]): readonly Benefit[] => [
  {
    icon: <BadgeEuro className="size-6" aria-hidden />,
    title: `${capitalized(ceilingTermIndefiniteText(open))} chiffrée`,
    term: "enchere-plafond",
    text: "Valeur estimée, frais, travaux et marge de sécurité : vous voyez d’où vient votre limite et vous l’ajustez selon votre projet.",
  },
  {
    icon: <Bell className="size-6" aria-hidden />,
    title: "Des alertes sur les nouvelles ventes",
    text: "Fixez vos critères une fois : un email récapitulatif quotidien vous signale les ventes qui correspondent (hebdomadaire avec le compte gratuit).",
  },
  {
    icon: <Building2 className="size-6" aria-hidden />,
    title: "Des comparables de ventes réelles",
    text: "L’estimation du bien s’appuie sur des ventes comparables réellement conclues autour du bien, avec leur source.",
  },
];

/**
 * Pendant les 7 jours d'essai qui suivent l'inscription, le compte gratuit a l'offre Analyse : la
 * carte Découverte et le comparatif décrivent le plan gratuit, qui s'applique après l'essai. Cette
 * mention le dit (elle ne parle ni de prix ni de paiement).
 */
const LAUNCH_OFFER_FREE_PLAN_NOTE = `Pendant les ${ANALYSIS_TRIAL_DAYS} jours d’essai qui suivent la confirmation de son adresse email, un compte gratuit bénéficie de l’offre Analyse (un essai par personne). Les limites de Découverte indiquées ici s’appliquent ensuite.`;

/** Inscription depuis /offres : motif `offre` (bandeau de la connexion, entrée de `signup_submitted`). */
const OFFER_SIGNUP_PATH = pathWithSearch("/login", {
  mode: "investor",
  redirect: "/sales",
  reason: "offre",
});

/**
 * Sous les deux cartes, pour qui étudie beaucoup de ventes (marchands de biens). « Toutes les ventes
 * ouvertes » : Analyse n'a pas de quota de déblocages (`PLAN_LIMITS.analyse.monthlyUnlocks`).
 */
const HEAVY_USE_NOTE = `Vous étudiez plus de ${MONTHLY_SALE_UNLOCKS} ventes par mois, ou vous suivez plusieurs secteurs ? C’est l’usage pour lequel l’offre Analyse est faite : toutes les ventes ouvertes, jusqu’à ${PLAN_LIMITS.analyse.watchedZones} alertes, export CSV.`;

const unlockedItems = (open?: readonly FeeRegimeKey[]) =>
  unlockedItemsText({ ceiling: ceilingTermWithArticleText(open), statistics: true });

const discoveryFeatures = (open?: readonly FeeRegimeKey[]) => [
  `${MONTHLY_SALE_UNLOCKS} déblocages par mois : ${unlockedItems(open)}, pour la vente choisie`,
  "Fiches complètes : adresse, photos, description, occupation, visites et contact",
  "Fourchette de valeur estimée et écart avec la mise à prix",
  `Une alerte avec un email récapitulatif par semaine, ${PLAN_LIMITS.decouverte.favoriteSales} favoris`,
  "Simulateur de financement, risques de la commune et annuaire des avocats",
];

const analysisFeatures = (open?: readonly FeeRegimeKey[]) =>
  [
    `${capitalized(ceilingTermWithScopeText(open))} chiffrée : travaux, libération, portage et tous les frais`,
    "Pièces du dossier et leur lecture, pour les ventes qui en comportent : points clés cités avec la page",
    "Historique de la vente, quand il existe : passages précédents, baisses de mise à prix, reports",
    "Estimation détaillée et ventes comparables",
    "Jusqu’à 25 alertes avec email quotidien, favoris illimités",
    "Suivi des changements de vos favoris (date, mise à prix, statut, documents), consultable dans Mes favoris",
    "Statistiques des tribunaux : prix d’adjudication, quand l’historique du tribunal est suffisant ; rapport PDF et export des résultats",
  ] as const;

/**
 * `subscriptionOpen` : la souscription est ouverte pour de bon (état lu). Faux dans tous les autres
 * cas, y compris tant que l'état n'est pas lu : une réponse sur la résiliation ou le remboursement ne
 * doit pas laisser croire qu'un abonnement existe déjà. `launchActive` : l'essai à l'inscription est
 * ouvert.
 */
type FaqContext = {
  offer: BillingOfferState;
  launchActive: boolean;
  /** L'état de l'essai n'est pas encore lu : les réponses disent ce qui est vrai dans les deux états. */
  launchPending: boolean;
  subscriptionOpen: boolean;
  /** « l’enchère plafond », « l’offre plafond » ou les deux, selon les régimes ouverts. */
  ceilingWithArticle: string;
};

/** Aucun abonnement n'existe tant que la souscription est fermée : la réponse décrit l'à-venir. */
const NOT_OPEN_PREFIX = "Quand l’abonnement sera ouvert, les règles prévues sont les suivantes. ";

/** Décision du propriétaire du 10/11/2026 : dire que l'abonnement est sans engagement. */
const NO_COMMITMENT_TEXT =
  "Sans engagement : résiliez quand vous voulez, même dès le premier jour ; vous gardez l’accès jusqu’à la fin du mois payé.";

const FAQ: { question: string; answer: (context: FaqContext) => ReactNode }[] = [
  {
    question: "Comment résilier ?",
    answer: ({ subscriptionOpen }) => (
      <>
        {subscriptionOpen ? null : NOT_OPEN_PREFIX}L’abonnement Analyse est prélevé automatiquement
        chaque mois, à la même date, tant que vous ne l’avez pas résilié. Il est sans engagement :
        vous pouvez résilier dès le premier jour et garder l’accès jusqu’à la fin du mois payé.
        Depuis la page « Mon compte », le bouton « Résilier mon abonnement » ouvre directement le
        formulaire de résiliation du portail de paiement : vous résiliez à tout moment, la date de
        fin d’accès est affichée avant confirmation. La résiliation prend effet à la fin de la
        période payée. Le bouton « Gérer mon abonnement » donne accès à vos factures et à votre
        moyen de paiement.
      </>
    ),
  },
  {
    question: "Y a-t-il un essai gratuit ?",
    answer: ({ launchActive, launchPending, subscriptionOpen }) =>
      launchPending ? (
        // État non lu (lecture en erreur côté serveur) : jamais « Pas pour le moment » à tort.
        <>
          Un essai gratuit de {ANALYSIS_TRIAL_DAYS} jours, sans carte bancaire, est proposé à
          l’inscription tant que l’essai est ouvert ; l’état en cours s’affiche une fois la page
          chargée. {LAUNCH_OFFER_DURATION_TEXT}
        </>
      ) : launchActive ? (
        <>
          Oui. Une fois votre adresse email confirmée, votre compte bénéficie gratuitement de
          l’offre Analyse pendant {ANALYSIS_TRIAL_DAYS} jours, sans carte bancaire.{" "}
          {LAUNCH_OFFER_DURATION_TEXT} {LAUNCH_OFFER_DATA_TEXT}{" "}
          {subscriptionOpen
            ? `Pour garder l’offre Analyse après l’essai, il faut y souscrire (${analysisSubscriptionTerms(resolveAnalysisOfferLabel())}).`
            : `Pour garder l’offre Analyse après l’essai, il faudra y souscrire ; l’abonnement n’est pas encore ouvert (tarif prévu : ${resolveAnalysisOfferLabel()}). Vous pouvez demander à être prévenu de son ouverture.`}
        </>
      ) : (
        <>Pas pour le moment. Le catalogue reste accessible gratuitement avec l’offre Découverte.</>
      ),
  },
  {
    question: `Comment fonctionnent les ${MONTHLY_SALE_UNLOCKS} déblocages par mois ?`,
    answer: ({ launchActive, ceilingWithArticle }) => (
      <>
        Chaque mois, vous pouvez débloquer {MONTHLY_SALE_UNLOCKS} ventes avec votre compte
        Découverte. Pour chacune, vous voyez, lorsque la vente les comporte, {ceilingWithArticle},
        la lecture des pièces, l’historique de la vente, les statistiques du tribunal de cette vente
        et les pièces du dossier. Le compteur repart à {MONTHLY_SALE_UNLOCKS} le 1er du mois à 00 h
        00, heure de Paris ; les déblocages non utilisés ne sont pas reportés. Une vente débloquée
        reste accessible tant qu’elle est en ligne sur Immojudis, dans la limite de 24 mois après le
        déblocage. Aucune carte bancaire n’est demandée et rien ne devient payant automatiquement.{" "}
        {launchActive
          ? `Pendant les ${ANALYSIS_TRIAL_DAYS} jours d’essai qui suivent la confirmation de l’adresse email, l’export PDF ou CSV, les rapports enregistrés, les alertes avancées, l’estimation détaillée et les ventes comparables sont aussi ouverts au compte gratuit ; ils redeviennent réservés à Analyse ensuite.`
          : "L’export PDF ou CSV, les rapports enregistrés, les alertes avancées, l’estimation détaillée et les ventes comparables restent réservés à Analyse."}
      </>
    ),
  },
  {
    question: "Puis-je être remboursé ?",
    answer: ({ subscriptionOpen }) => (
      <>
        {subscriptionOpen ? null : NOT_OPEN_PREFIX}Vous disposez d’un délai de rétractation de 14
        jours. Si vous demandez l’exécution immédiate du service, un montant proportionnel au
        service déjà fourni peut rester dû. Les règles complètes figurent dans les{" "}
        <Link href="/conditions-generales" className="font-semibold text-gold-text underline">
          conditions générales
        </Link>
        .
      </>
    ),
  },
  {
    question: "Quelle est la couverture géographique ?",
    answer: () => (
      <>
        Le catalogue couvre la France entière. La couverture varie selon les sources : certaines
        régions comptent plus d’annonces que d’autres, et une donnée absente ne signifie pas
        l’absence de risque. La page{" "}
        <Link href="/comment-ca-marche" className="font-semibold text-gold-text underline">
          Comment ça marche
        </Link>{" "}
        détaille les limites.
      </>
    ),
  },
  {
    question: "En quoi est-ce différent d’un avocat ?",
    answer: () => (
      <>
        Immojudis est un outil d’information et d’aide à la décision : il ne donne pas de conseil
        juridique et ne vous représente pas. Pour enchérir à une vente au tribunal, un avocat du
        barreau compétent est nécessaire ; l’{" "}
        <Link href="/avocats" className="font-semibold text-gold-text underline">
          annuaire des avocats
        </Link>{" "}
        est gratuit.
      </>
    ),
  },
];

export function OffersPage({
  openFeeRegimes,
  initialSubscriptionOpen,
}: {
  /** Régimes de frais ouverts (`openFeeRegimesFromEnv`) ; absent : tous ceux dont les règles sont définies. */
  openFeeRegimes?: readonly FeeRegimeKey[];
  /**
   * La souscription est-elle ouverte, telle que le serveur le sait (`analysisCheckoutReadiness`) ?
   * Sert au rendu serveur et au premier rendu, avant la lecture de l'offre par le navigateur.
   */
  initialSubscriptionOpen?: boolean;
} = {}) {
  useEffect(() => {
    trackProductEvent("offers_viewed");
  }, []);
  const { user } = useAuth();
  const launch = useLaunchOffer();
  const source = useBillingOffer();
  const { offer } = source;
  const price = resolveAnalysisOfferLabel();
  // Essai gratuit de 7 jours à l'inscription : indépendant de la souscription, qui s'ouvre avec le
  // paiement (Stripe et identité légale).
  const launchActive = launch.active;
  // L'état lu par le navigateur prime ; avant lui, celui que le serveur a donné à la page. Tant qu'aucun
  // des deux n'est connu, la page ne dit pas « Analyse coûte ».
  const subscriptionKnownOpen = offer.status === "ready" ? offer.open : initialSubscriptionOpen;
  const subscriptionOpen = subscriptionKnownOpen === true;
  const offerKnown = subscriptionKnownOpen !== undefined;
  // Sous le prix : le 59 € n'est qu'un tarif prévu tant que rien ne se souscrit.
  const priceNote =
    subscriptionKnownOpen === false ? "Tarif prévu, pas encore souscriptible" : undefined;
  const trialLine =
    subscriptionKnownOpen === undefined
      ? null
      : !subscriptionKnownOpen
        ? `Tarif prévu : ${price}. Pas encore souscriptible.`
        : `Abonnement mensuel prélevé automatiquement chaque mois jusqu’à sa résiliation. ${NO_COMMITMENT_TEXT}`;
  // Une ligne de prix dès l'en-tête ; le 59 € n'est qu'un tarif prévu tant que rien ne se souscrit.
  const priceLine =
    subscriptionKnownOpen === false
      ? `Découverte gratuite · Analyse ${price}, pas encore souscriptible`
      : subscriptionKnownOpen
        ? `Découverte gratuite · Analyse : abonnement à ${price}, sans engagement`
        : `Découverte gratuite · Analyse : ${price}`;
  // L'invitation à l'essai s'adresse au visiteur : un compte voit son offre dans Mon compte.
  const visitorTrial = launchActive && !user;

  return (
    <main id="contenu" className="min-h-screen bg-white text-brand-navy">
      <section className="border-b border-brand-navy/10 bg-background">
        <div className="mx-auto grid max-w-[1460px] gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(500px,0.85fr)] lg:items-center lg:px-8 lg:py-12">
          <div>
            <Eyebrow className="mb-4">Offres</Eyebrow>
            <h1 className="max-w-3xl font-display text-[clamp(2.6rem,4.5vw,4.5rem)] font-medium leading-[0.98] text-brand-navy">
              La mise à prix est un départ. Préparez votre limite avant l’enchère.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg">
              Immojudis réunit les comparables disponibles, les frais et les travaux pour vous aider
              à fixer une limite selon votre projet et vos hypothèses.
            </p>
            <p data-testid="offers-price-line" className="mt-4 text-sm font-semibold">
              {priceLine}
            </p>
            {/* Après le titre : l'essai tient en deux lignes, ses conditions complètes à un tap. */}
            {launch.pending && !user ? <LaunchOfferBannerPlaceholder /> : null}
            {visitorTrial ? <LaunchOfferBanner /> : null}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              {/* L'essai proposé au visiteur passe en tête ; sinon, l'analyse exemple. */}
              {visitorTrial ? (
                <>
                  <Link
                    href={OFFER_SIGNUP_PATH}
                    className={buttonClasses({ variant: "primary", size: "lg" })}
                  >
                    Commencer l’essai gratuit de {ANALYSIS_TRIAL_DAYS} jours
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                  <Link href="/annonce-exemple" className={buttonClasses({ size: "lg" })}>
                    Voir une analyse exemple
                  </Link>
                </>
              ) : (
                <Link
                  href="/annonce-exemple"
                  className={buttonClasses({ variant: "primary", size: "lg" })}
                >
                  Voir une analyse exemple
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
              {/* Pendant l'essai, deux boutons suffisent : l'exploration passe en simple lien. */}
              {visitorTrial ? (
                <Link
                  href="/sales"
                  className="self-center font-semibold text-gold-text underline sm:self-auto sm:py-3"
                >
                  Explorer gratuitement
                </Link>
              ) : (
                <Link href="/sales" className={buttonClasses({ size: "lg" })}>
                  Explorer gratuitement
                </Link>
              )}
            </div>
          </div>
          <DecisionEquation />
        </div>
      </section>

      <section
        aria-labelledby="benefices"
        className="mx-auto max-w-[1220px] px-4 pt-12 sm:px-6 lg:px-8"
      >
        <h2 id="benefices" className="sr-only">
          Ce que l’offre Analyse apporte
        </h2>
        <ul className="grid gap-4 md:grid-cols-3">
          {benefits(openFeeRegimes).map((benefit) => (
            <li key={benefit.title}>
              <Card className="h-full">
                <span className="text-gold-text">{benefit.icon}</span>
                <div className="mt-3 flex items-start gap-2">
                  <h3 className="font-display text-2xl font-semibold leading-tight">
                    {benefit.title}
                  </h3>
                  {benefit.term ? (
                    <span className="mt-1">
                      <Terme terme={benefit.term} bare />
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{benefit.text}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="tarifs"
        className="mx-auto max-w-[1220px] px-4 py-12 sm:px-6 lg:px-8"
      >
        <h2 id="tarifs" className="font-display text-3xl font-medium sm:text-4xl">
          {MONTHLY_SALE_UNLOCKS} ventes chiffrées par mois, ou sans limite.
        </h2>
        <p className="mt-2 max-w-3xl text-ink-soft">
          Découverte est gratuite, sans limite de durée ; elle comprend {MONTHLY_SALE_UNLOCKS}{" "}
          déblocages par mois, chacun ouvrant, pour une vente, {unlockedItems(openFeeRegimes)}.{" "}
          {subscriptionKnownOpen === false
            ? `Analyse : tarif prévu ${price}, pas encore souscriptible.`
            : offerKnown
              ? `Analyse est un ${analysisSubscriptionTerms(price)}.`
              : `Analyse : ${price}. Les conditions de souscription s’affichent une fois l’offre chargée.`}
          {launchActive
            ? ` Elle est offerte pendant ${ANALYSIS_TRIAL_DAYS} jours à l’inscription, sans carte bancaire.`
            : null}
        </p>
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <PlanPanel
            name="Découverte"
            price="0 €"
            description={`Pour repérer les ventes et chiffrer, chaque mois, les ${MONTHLY_SALE_UNLOCKS} qui vous intéressent le plus.`}
            features={discoveryFeatures(openFeeRegimes)}
          >
            {launchActive ? (
              <p data-testid="launch-offer-free-note" className="mb-4 text-sm text-ink-soft">
                {LAUNCH_OFFER_FREE_PLAN_NOTE}
              </p>
            ) : null}
            {user ? null : (
              <Link
                href={OFFER_SIGNUP_PATH}
                className={buttonClasses({ size: "lg", className: "w-full" })}
              >
                Créer mon compte gratuit
              </Link>
            )}
          </PlanPanel>

          <PlanPanel
            name="Analyse"
            price={price}
            description={analysisOfferDescription(openFeeRegimes)}
            features={analysisFeatures(openFeeRegimes)}
            priceNote={priceNote}
            highlighted
            recommended={subscriptionOpen}
          >
            {launch.pending && !user ? (
              <div
                role="status"
                aria-busy="true"
                aria-label="Chargement de l’offre"
                className="h-11 w-full animate-pulse rounded-md bg-muted"
              />
            ) : visitorTrial ? (
              <LaunchOfferPanel trialLine={trialLine} />
            ) : (
              <>
                {trialLine ? (
                  <p className="mb-4 text-center text-sm font-medium">{trialLine}</p>
                ) : null}
                <BillingActions
                  hideHelper
                  offerSource={source}
                  handleCheckoutReturn
                  className="[&>button]:w-full"
                />
              </>
            )}
          </PlanPanel>
        </div>
        <p data-testid="offers-heavy-use-note" className="mt-5 max-w-3xl text-sm text-ink-soft">
          {HEAVY_USE_NOTE}
        </p>
      </section>

      <section
        aria-labelledby="comparatif"
        className="border-t border-brand-navy/10 bg-surface-muted"
      >
        <div className="mx-auto max-w-[1220px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
          <h2 id="comparatif" className="font-display text-3xl font-medium sm:text-4xl">
            Comparer les deux offres
          </h2>
          {launchActive ? (
            <p data-testid="launch-offer-comparison-note" className="mt-3 text-sm text-ink-soft">
              {LAUNCH_OFFER_FREE_PLAN_NOTE}
            </p>
          ) : null}
          <ComparisonTable open={openFeeRegimes} analysisOpen={subscriptionOpen} />
          <p className="mt-4 text-sm text-ink-soft">
            Les scénarios d’enchères s’appuient sur les adjudications des trois dernières années
            publiées par Licitor (source tierce, non officielle) et sur les prix DVF ; les
            statistiques de prix d’adjudication portent sur la période publiée indiquée sur la
            fiche. Ils ne sont affichés que pour les tribunaux disposant d’assez de ventes
            comparables ; la fiche indique quand ce n’est pas le cas. Ils décrivent le passé et ne
            prédisent pas le prix final. Les analyses dépendent aussi des informations et des pièces
            disponibles pour chaque vente. Vérifiez le contenu de la fiche avant de décider.
          </p>
        </div>
      </section>

      <section aria-labelledby="faq" className="mx-auto max-w-[900px] px-4 py-12 sm:px-6 lg:py-16">
        <h2 id="faq" className="font-display text-3xl font-medium sm:text-4xl">
          Questions fréquentes
        </h2>
        <div className="mt-6 divide-y divide-line border-y border-line">
          {FAQ.map((item) => (
            <details key={item.question} className="group py-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft">
                {item.question}
                <ChevronDown
                  className="size-5 shrink-0 transition-transform group-open:rotate-180"
                  aria-hidden
                />
              </summary>
              <div className="mt-2 text-sm leading-relaxed text-ink-soft">
                {item.answer({
                  offer,
                  launchActive,
                  launchPending: launch.pending,
                  subscriptionOpen,
                  ceilingWithArticle: ceilingTermWithArticleText(openFeeRegimes),
                })}
              </div>
            </details>
          ))}
        </div>
        <p className="mt-8 flex items-start gap-3 text-sm text-ink-soft">
          <Scale className="mt-0.5 size-4 shrink-0 text-gold-text" aria-hidden />
          Les estimations et simulations sont des aides à la décision : elles ne constituent ni une
          expertise, ni un conseil juridique ou financier.
        </p>
      </section>
    </main>
  );
}

function ComparisonTable({
  open,
  analysisOpen,
}: {
  open?: readonly FeeRegimeKey[];
  analysisOpen: boolean;
}) {
  // Ce qui distingue les offres d'abord ; ce qu'elles ont en commun, replié, sans rien retirer.
  const { differences, shared } = splitOfferComparisonRows(
    offerComparisonRows(open, { analysisOpen }),
  );
  return (
    <>
      <ComparisonList rows={differences} />
      <ComparisonGrid rows={differences} />
      {shared.length > 0 ? <SharedComparisonRows rows={shared} /> : null}
    </>
  );
}

/** Les lignes incluses à l'identique dans les deux offres, repliées par défaut. */
function SharedComparisonRows({ rows }: { rows: readonly OfferRow[] }) {
  return (
    <details
      data-testid="offer-comparison-shared"
      className="group mt-4 rounded-xl border border-line bg-white"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-3 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft sm:px-4">
        Inclus dans les deux offres
        <ChevronDown
          className="size-5 shrink-0 transition-transform group-open:rotate-180"
          aria-hidden
        />
      </summary>
      <ul className="divide-y divide-line-soft border-t border-line-soft">
        {rows.map((row) => (
          <li
            key={row.id}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 px-3 py-3 text-sm sm:px-4"
          >
            <Check className="mt-0.5 size-4 text-success" aria-hidden />
            <span>
              <span className="font-medium">{row.label}</span>
              {row.analyse.text === "Inclus" ? null : ` : ${row.analyse.text}`}
              {row.hint ? (
                <span className="mt-0.5 block text-xs text-ink-soft">{row.hint}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Sous 640 px : une ligne par fonctionnalité, « Découverte : … » puis « Analyse : … ». */
function ComparisonList({ rows }: { rows: ReturnType<typeof offerComparisonRows> }) {
  return (
    <ul
      aria-label="Comparaison des offres Découverte et Analyse, en liste"
      className="mt-6 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-white sm:hidden"
    >
      {rows.map((row) => (
        <li key={row.id} className="px-3 py-3 text-sm">
          <p className="font-medium">{row.label}</p>
          {row.hint ? <p className="mt-0.5 text-xs text-ink-soft">{row.hint}</p> : null}
          <p
            className={`mt-2 ${row.decouverte.included || row.decouverte.limited ? "" : "text-ink-soft"}`}
          >
            <span className="font-semibold">Découverte :</span> {row.decouverte.text}
          </p>
          <p className={row.analyse.included || row.analyse.limited ? "" : "text-ink-soft"}>
            <span className="font-semibold">Analyse :</span> {row.analyse.text}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ComparisonGrid({ rows }: { rows: ReturnType<typeof offerComparisonRows> }) {
  return (
    <div className="mt-6 hidden overflow-hidden rounded-xl border border-line bg-white sm:block">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <caption className="sr-only">Comparaison des offres Découverte et Analyse</caption>
        <thead className="bg-surface-tint">
          <tr>
            <th scope="col" className="w-[40%] px-3 py-3 font-semibold sm:px-4">
              Fonctionnalité
            </th>
            <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
              Découverte
            </th>
            <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
              Analyse
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="px-3 py-3 align-top font-medium sm:px-4">
                {row.id === "ceiling" ? (
                  <Terme terme="enchere-plafond">{row.label}</Terme>
                ) : (
                  row.label
                )}
                {row.hint ? (
                  <span className="mt-0.5 block text-xs font-normal text-ink-soft">{row.hint}</span>
                ) : null}
              </th>
              <ComparisonCell cell={row.decouverte} />
              <ComparisonCell cell={row.analyse} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonCell({ cell }: { cell: OfferCell }) {
  const open = cell.included || cell.limited;
  return (
    <td className="px-3 py-3 align-top sm:px-4">
      <span className="flex items-start gap-2">
        {cell.included ? (
          <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        ) : cell.limited ? (
          <LockKeyholeOpen className="mt-0.5 size-4 shrink-0 text-gold-text" aria-hidden />
        ) : (
          <Minus className="mt-0.5 size-4 shrink-0 text-ink-soft" aria-hidden />
        )}
        <span className={open ? "" : "text-ink-soft"}>{cell.text}</span>
      </span>
    </td>
  );
}

/**
 * Hauteur commune au bandeau et à son emplacement réservé : le bandeau tient dans cette hauteur
 * (texte sur deux lignes au plus, puis le lien des conditions), donc rien ne bouge quand l'état de
 * l'essai est lu. Les conditions complètes, une fois ouvertes, agrandissent le bandeau sur demande.
 */
const TRIAL_BOX_CLASSES =
  "mt-5 min-h-[7.25rem] rounded-lg border border-gold/40 bg-gold/10 px-3 py-3 sm:min-h-[4.5rem]";

/**
 * Sous le titre pour un visiteur, tant que l'essai à l'inscription est ouvert : deux lignes au plus,
 * et le texte complet des conditions à un tap (« Voir les conditions »), jamais retiré de la page.
 */
function LaunchOfferBanner() {
  const [open, setOpen] = useState(false);
  const conditionsId = useId();
  return (
    <section
      aria-label="Essai gratuit"
      data-testid="launch-offer-banner"
      className={TRIAL_BOX_CLASSES}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-brand-navy">
          <Gift className="mt-0.5 size-5 shrink-0 text-gold-text" aria-hidden />
          <span>{LAUNCH_OFFER_LABEL}, sans carte bancaire.</span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={conditionsId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex min-h-11 shrink-0 items-center self-start text-sm font-semibold text-gold-text underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft sm:self-auto"
        >
          {open ? "Masquer les conditions" : "Voir les conditions"}
        </button>
      </div>
      <p
        id={conditionsId}
        hidden={!open}
        data-testid="launch-offer-conditions"
        className="mt-1 text-sm leading-relaxed text-ink-soft"
      >
        {launchOfferText("visitor")}
      </p>
    </section>
  );
}

/**
 * Tant que l'état de l'offre n'est pas lu : la même hauteur que le bandeau (`TRIAL_BOX_CLASSES`),
 * pour que les boutons ne descendent pas quand il apparaît. Le bandeau n'est jamais rendu côté
 * serveur sans état lu : la coupure de l'offre doit se voir en moins de 60 s.
 */
function LaunchOfferBannerPlaceholder() {
  return (
    <div aria-hidden data-testid="launch-offer-banner-placeholder" className={TRIAL_BOX_CLASSES} />
  );
}

/**
 * Dans la carte Analyse, pour un visiteur, tant que l'essai à l'inscription est ouvert : l'essai
 * d'abord, puis l'état de la souscription. Aucun bouton de paiement : il faut un compte.
 */
function LaunchOfferPanel({ trialLine }: { trialLine: string | null }) {
  return (
    <div className="text-center text-sm leading-relaxed" data-testid="launch-offer-panel">
      <p className="font-semibold">
        Offerte pendant {ANALYSIS_TRIAL_DAYS} jours à l’inscription, sans carte bancaire.
      </p>
      {trialLine ? <p className="mt-1 text-ink-soft">{trialLine}</p> : null}
      <Link
        href={OFFER_SIGNUP_PATH}
        className={buttonClasses({ variant: "primary", size: "lg", className: "mt-4 w-full" })}
      >
        Commencer l’essai gratuit
      </Link>
    </div>
  );
}

function DecisionEquation() {
  const items = [
    { icon: <Building2 className="size-7" />, label: "Valeur estimée", sign: "−" },
    { icon: <ShieldCheck className="size-7" />, label: "Marge de sécurité", sign: "−" },
    { icon: <FileText className="size-7" />, label: "Frais", sign: "−" },
    {
      icon: <Wrench className="size-7" />,
      label: "Travaux inclus par défaut",
      sign: "=",
      accent: true,
    },
    { icon: <BadgeEuro className="size-8" />, label: "Enchère plafond (simulation)", result: true },
  ];

  return (
    <div>
      <p className="sr-only">
        Enchère plafond = valeur estimée moins marge de sécurité moins frais et travaux.
      </p>
      <div className="grid grid-cols-5 items-start gap-2" aria-hidden>
        {items.map((item) => (
          <div key={item.label} className="relative text-center">
            <span
              className={`mx-auto grid size-12 place-items-center rounded-full border min-[400px]:size-14 sm:size-16 ${
                item.result
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-white bg-white text-brand-navy shadow-sm"
              }`}
            >
              {item.icon}
            </span>
            <p
              className={`mt-3 hyphens-auto break-words text-xs font-semibold leading-tight sm:text-sm ${
                item.accent ? "text-gold-text" : "text-brand-navy"
              }`}
            >
              {item.label}
            </p>
            {item.sign ? (
              <span className="absolute -right-2 top-4 text-2xl font-semibold text-gold-text">
                {item.sign}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-7 border-t border-gold pt-6 text-center">
        <p className="text-sm font-medium leading-relaxed sm:text-base">
          Schéma indicatif : ajustez les frais et les travaux selon les pièces disponibles et la
          visite du bien.
        </p>
      </div>
    </div>
  );
}

function PlanPanel({
  name,
  price,
  description,
  features,
  priceNote,
  children,
  highlighted = false,
  recommended = false,
}: {
  name: string;
  price: string;
  description: string;
  features: readonly string[];
  /** Précision sous le prix (« Tarif prévu, pas encore souscriptible »). */
  priceNote?: string;
  children: ReactNode;
  highlighted?: boolean;
  /** The « Recommandée » badge only appears once the plan can really be bought. */
  recommended?: boolean;
}) {
  return (
    <Card
      as="article"
      padded={false}
      aria-labelledby={`offre-${name}`}
      className={`flex flex-col overflow-hidden ${highlighted ? "border-brand-navy" : ""}`}
    >
      <div
        className={
          highlighted
            ? "flex items-center justify-between bg-brand-navy px-6 py-4 text-white"
            : "px-6 pt-5"
        }
      >
        <h3 id={`offre-${name}`} className="font-display text-3xl font-semibold">
          {name}
        </h3>
        {highlighted && recommended ? (
          <Badge tone="gold" className="!border-gold-light !bg-transparent !text-gold-light">
            Recommandée
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-6 sm:p-8">
        <div>
          <strong className="font-display text-5xl font-medium leading-none sm:text-6xl">
            {price}
          </strong>
          {priceNote ? (
            <p data-testid="price-note" className="mt-2 text-sm font-medium text-ink-soft">
              {priceNote}
            </p>
          ) : null}
          <p className="mt-3 text-sm text-ink-soft">{description}</p>
        </div>
        <ul className="my-6 grid gap-3">
          {features.map((feature) => (
            <li key={feature} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-3 text-sm">
              <Check className="mt-0.5 size-4 text-success" aria-hidden />
              <span className="leading-relaxed">{feature}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto">{children}</div>
      </div>
    </Card>
  );
}

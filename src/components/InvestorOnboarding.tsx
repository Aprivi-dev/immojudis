"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, Eyebrow, PageTitle } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { useAccessPlan } from "@/hooks/use-access-plan";
import { useCreateAlert } from "@/hooks/use-create-alert";
import { useHasAnalysisAccess } from "@/hooks/use-has-analysis-access";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import {
  LAUNCH_OFFER_ACCOUNT_TEXT,
  SIGNUP_TRIAL_DENIED_TEXT,
  signupTrialDateLabel,
} from "@/lib/launch-offer";
import { pathWithSearch } from "@/lib/navigation";
import { firstSearchToUrl, SALE_CEILING_ANCHOR, type FirstSearch } from "@/lib/onboarding";
import { HOME_TYPE_OPTIONS, countActiveSearchFilters } from "@/lib/search/search-filters";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { formatPrice } from "@/lib/format";
import type { PlanEntitlements } from "@/lib/property-reports";
import { MONTHLY_UNLOCKS_TEXT, UNLOCK_HIGHLIGHTS_INLINE_TEXT } from "@/lib/sale-unlocks";

const steps = ["Votre secteur", "Vos critères", "Votre première recherche"];
const inputClass =
  "w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";

/** L'essai de ce compte est en cours (`trialEndsAt` dans le futur), et non l'interrupteur de l'offre. */
function trialRunning(plan: PlanEntitlements | undefined, now: number): boolean {
  return Boolean(plan?.launchOffer && plan.trialEndsAt && Date.parse(plan.trialEndsAt) > now);
}

/**
 * Ce que le compte ouvre, d'après ses propres droits et non d'après l'interrupteur de l'essai :
 * « votre compte ouvre les outils Analyse » n'est dit que si l'essai de ce compte est en cours
 * (`trialEndsAt` dans le futur). Droits non lus (chargement, erreur) : rien n'est annoncé.
 */
function accessSentence(
  plan: PlanEntitlements | undefined,
  unlockHighlights: string,
  now: number,
): string | null {
  if (!plan) return null;
  if (trialRunning(plan, now) && plan.trialEndsAt) {
    return `Votre essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours court jusqu’au ${signupTrialDateLabel(plan.trialEndsAt)} : votre compte ouvre les outils de l’offre Analyse sur toutes les ventes (contenu selon la vente). Ensuite, vous aurez ${MONTHLY_UNLOCKS_TEXT}.`;
  }
  if (plan.hasAnalysisAccess) {
    return "Votre compte a l’offre Analyse : elle ouvre toutes les ventes (contenu selon la vente).";
  }
  const unlocks = `Avec ${MONTHLY_UNLOCKS_TEXT}, vous ouvrez le détail d’une vente (${unlockHighlights}). L’offre Analyse les ouvre toutes.`;
  if (plan.trialEndedAt) {
    return `Votre essai gratuit s’est terminé le ${signupTrialDateLabel(plan.trialEndedAt)} : votre compte est revenu à l’offre Découverte. ${unlocks}`;
  }
  if (plan.trialDenied) return `${SIGNUP_TRIAL_DENIED_TEXT} ${unlocks}`;
  return unlocks;
}

export function InvestorOnboarding({
  returnTo,
  initialArea = "",
  unlockHighlights = UNLOCK_HIGHLIGHTS_INLINE_TEXT,
}: {
  /** La fiche d'où part l'inscription : le dernier bouton y ramène, sur son plafond. */
  returnTo?: string;
  /** Secteur prérempli : le département de la vente d'origine (`onboardingAreaForSale`). */
  initialArea?: string;
  /**
   * Ce qu'un déblocage ouvre, composé par la page serveur avec les régimes de frais ouverts
   * (`unlockHighlightsInlineText`) ; absent : le texte des régimes ouverts par défaut.
   */
  unlockHighlights?: string;
} = {}) {
  const router = useRouter();
  const launchOffer = useLaunchOffer().active;
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState<FirstSearch>({
    area: initialArea,
    maxPrice: "",
    homeType: "",
  });
  // Jamais pré-cochée : la première alerte et son email récapitulatif sont un choix explicite.
  const [wantsAlert, setWantsAlert] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { user } = useAuth();
  const hasAnalysisAccess = useHasAnalysisAccess(user?.id);
  const plan = useAccessPlan(user?.id);
  // L'heure de l'ouverture de la page suffit pour juger si l'essai est en cours.
  const [now] = useState(() => Date.now());
  const { createAlertFromSearch, saving } = useCreateAlert({ returnTo: "/bienvenue" });

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const criteria = firstSearchToUrl(search);
  const alertSearch = validateSalesSearch(criteria);
  // L'alerte gratuite accepte des critères publics : un secteur saisi en texte libre (ni numéro de
  // département ni code postal) n'en est pas un, et sans aucun critère elle préviendrait de tout.
  const alertUnavailable: string | null =
    countActiveSearchFilters(alertSearch) === 0
      ? "Indiquez un secteur, un type de bien ou une mise à prix maximale pour créer une alerte."
      : hasAnalysisAccess === false && alertSearch.query
        ? "L’alerte gratuite suit un département : indiquez son numéro (ex. 33) ou un code postal pour la créer."
        : null;
  const alertWanted = wantsAlert && alertUnavailable === null;
  // Pendant l'essai, la première alerte est quotidienne ; après l'essai, elle repasse en hebdomadaire
  // (`alert-matches.ts`).
  const dailyDuringTrial = trialRunning(plan, now);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    if (alertWanted) {
      // Un seul geste : l'alerte (un récapitulatif par jour pendant l'essai, sinon par semaine) puis le
      // catalogue filtré. En cas d'échec le message est affiché et la personne reste ici pour réessayer ou décocher.
      const result = await createAlertFromSearch(alertSearch, {
        frequency: dailyDuringTrial ? "daily" : "weekly",
        emailRecap: true,
        // Sans département, le secteur saisi sert de nom à l'alerte.
        nameSearch: alertSearch.query ? { ...alertSearch, city: alertSearch.query } : alertSearch,
      });
      if (result.status !== "created") return;
    }
    // Inscription lancée depuis une fiche : retour à la vente, sur son plafond.
    router.push(
      returnTo ? `${returnTo}#${SALE_CEILING_ANCHOR}` : pathWithSearch("/sales", criteria),
    );
  }

  return (
    <main
      id="contenu"
      className="mx-auto min-h-[calc(100svh-4rem)] w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-16"
    >
      <Card as="section" className="sm:p-10">
        <Eyebrow>
          {trialRunning(plan, now)
            ? "Votre essai de l’offre Analyse a commencé"
            : "Bienvenue dans votre compte Découverte"}
        </Eyebrow>
        {launchOffer ? (
          <p
            data-testid="onboarding-launch-offer"
            className="mt-4 rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm font-medium leading-relaxed text-foreground"
          >
            {LAUNCH_OFFER_ACCOUNT_TEXT}
          </p>
        ) : null}
        <ol aria-label="Étapes de démarrage" className="mt-6 flex gap-2">
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? "step" : undefined}
              className={`h-1.5 flex-1 rounded-full ${index <= step ? "bg-gold" : "bg-muted"}`}
            >
              <span className="sr-only">
                {index + 1}. {label}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-muted-foreground">
          Étape {step + 1} sur {steps.length}
        </p>
        <PageTitle ref={heading} tabIndex={-1} className="mt-2 outline-none">
          {steps[step]}
        </PageTitle>

        <form onSubmit={submit} className="mt-6 space-y-6">
          {step === 0 && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Choisissez où chercher. Tous les champs sont facultatifs et vos filtres resteront
                modifiables dans le catalogue.
              </p>
              <label className="grid gap-2 text-sm font-medium">
                Ville, département ou région
                <input
                  className={inputClass}
                  value={search.area}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, area: event.target.value }))
                  }
                  placeholder="Ex. Bordeaux, 33 ou Nouvelle-Aquitaine"
                  maxLength={120}
                  autoComplete="off"
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Les annonces disponibles dépendent des sources suivies. L’absence de résultat ne
                signifie pas qu’aucune vente n’existe dans votre secteur.
              </p>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-5">
              <label className="grid gap-2 text-sm font-medium">
                Type de bien
                <select
                  className={inputClass}
                  value={search.homeType}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, homeType: event.target.value }))
                  }
                >
                  <option value="">Tous les types</option>
                  {HOME_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Mise à prix maximale (€)
                <input
                  type="number"
                  min={1}
                  max={1_000_000_000}
                  step="any"
                  inputMode="decimal"
                  className={inputClass}
                  value={search.maxPrice}
                  onChange={(event) =>
                    setSearch((current) => ({ ...current, maxPrice: event.target.value }))
                  }
                  placeholder="Sans plafond"
                  aria-describedby="starting-price-help"
                />
              </label>
              <p id="starting-price-help" className="text-xs leading-relaxed text-muted-foreground">
                C’est le point de départ des enchères, hors frais et travaux. Le prix final peut le
                dépasser : ce filtre n’est pas votre budget total d’acquisition.
              </p>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-5">
              <dl className="space-y-3 rounded-lg border border-border bg-background/70 p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Secteur</dt>
                  <dd>
                    {criteria.query ??
                      (criteria.department
                        ? `Département ${criteria.department}`
                        : "Tous les secteurs couverts")}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Type de bien</dt>
                  <dd>
                    {HOME_TYPE_OPTIONS.find((option) => option.value === search.homeType)?.label ??
                      "Tous les types"}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-muted-foreground">Mise à prix maximale</dt>
                  <dd>
                    {typeof criteria.maxPrice === "number"
                      ? formatPrice(criteria.maxPrice)
                      : "Sans plafond"}
                  </dd>
                </div>
              </dl>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Ouvrez une fiche pour vérifier la date, la localisation et les caractéristiques du
                bien. {accessSentence(plan, unlockHighlights, now)}
              </p>
              <Link
                href="/annonce-exemple"
                className="inline-block text-sm font-medium text-gold-text underline underline-offset-4"
              >
                Comprendre une analyse sur l’annonce exemple gratuite
              </Link>
              <div className="rounded-lg border border-border bg-background/70 p-4">
                <label
                  className={`flex min-h-11 items-start gap-3 text-sm font-medium ${
                    alertUnavailable ? "text-muted-foreground" : "cursor-pointer text-foreground"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={alertWanted}
                    disabled={alertUnavailable !== null || saving}
                    onChange={(event) => setWantsAlert(event.target.checked)}
                    aria-describedby="first-alert-help"
                    className="mt-0.5 size-5 shrink-0 accent-[var(--gold)]"
                  />
                  <span>
                    {dailyDuringTrial
                      ? "Créer ma première alerte avec ces critères (un email par jour pendant votre essai, puis chaque semaine)"
                      : "Créer ma première alerte avec ces critères (un email récapitulatif par semaine)"}
                  </span>
                </label>
                <p
                  id="first-alert-help"
                  className="mt-1 pl-8 text-xs leading-relaxed text-muted-foreground"
                >
                  {alertUnavailable ??
                    (dailyDuringTrial
                      ? "Facultatif. En cochant cette case, vous acceptez de recevoir par email un récapitulatif des nouvelles ventes correspondant à ces critères, seulement s’il y en a : au plus un par jour pendant votre essai, puis au plus un par semaine, le lundi, quand votre compte repasse en Découverte. Vous pourrez le désactiver à tout moment depuis votre compte ou par le lien de désinscription de chaque email."
                      : "Facultatif. En cochant cette case, vous acceptez de recevoir par email un récapitulatif hebdomadaire des nouvelles ventes correspondant à ces critères. Vous pourrez le désactiver à tout moment depuis votre compte ou le lien de désinscription de chaque email.")}
                </p>
                {alertWanted ? (
                  // Le récapitulatif part le lendemain ou le lundi suivant : le premier plafond ne doit pas attendre.
                  <p
                    data-testid="first-alert-timing"
                    className="mt-2 pl-8 text-sm leading-relaxed text-foreground"
                  >
                    {dailyDuringTrial
                      ? "Pendant votre essai, le récapitulatif part chaque jour, puis chaque lundi après l’essai, s’il y a de nouvelles ventes qui correspondent à vos critères. En attendant, ouvrez une fiche pour voir son plafond."
                      : "Le récapitulatif part le lundi, s’il y a de nouvelles ventes qui correspondent à vos critères. En attendant, ouvrez une fiche pour voir son plafond."}
                  </p>
                ) : null}
              </div>
              <p
                data-testid="onboarding-next-action"
                className="rounded-lg border border-gold/25 bg-gold/10 px-4 py-3 text-sm font-medium leading-relaxed text-foreground"
              >
                Pour finir : ouvrez une vente{" "}
                {criteria.department ? "de votre département" : "du catalogue"} et voyez le plafond
                (contenu selon la vente).
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep((current) => current - 1)}
                className="rounded-lg px-3 py-3 text-sm text-muted-foreground hover:text-foreground"
              >
                Retour
              </button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" disabled={saving}>
              {saving
                ? "Création de l’alerte…"
                : step === steps.length - 1
                  ? returnTo
                    ? "Revenir à cette vente"
                    : "Voir les biens"
                  : "Continuer"}
            </Button>
          </div>
        </form>
        <Link
          href={returnTo ?? "/sales"}
          className="mt-6 inline-block text-sm text-muted-foreground underline underline-offset-4"
        >
          {returnTo ? "Passer et revenir à la fiche" : "Passer et explorer le catalogue"}
        </Link>
      </Card>
    </main>
  );
}

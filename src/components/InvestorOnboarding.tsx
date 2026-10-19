"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { buildAlertName } from "@/components/search/search-page-state";
import { useAuth } from "@/hooks/use-auth";
import { useCreateAlert } from "@/hooks/use-create-alert";
import { useHasAnalysisAccess } from "@/hooks/use-has-analysis-access";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_ACCOUNT_TEXT } from "@/lib/launch-offer";
import { pathWithSearch } from "@/lib/navigation";
import { firstSearchToUrl, type FirstSearch } from "@/lib/onboarding";
import { HOME_TYPE_OPTIONS, countActiveSearchFilters } from "@/lib/search/search-filters";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { formatPrice } from "@/lib/format";
import { MONTHLY_SALE_UNLOCKS, UNLOCK_HIGHLIGHTS_INLINE_TEXT } from "@/lib/sale-unlocks";

const steps = ["Votre secteur", "Vos critères", "Votre première recherche"];
const inputClass =
  "w-full rounded-lg border border-border bg-background px-4 py-3 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

export function InvestorOnboarding() {
  const router = useRouter();
  const launchOffer = useLaunchOffer().active;
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState<FirstSearch>({ area: "", maxPrice: "", homeType: "" });
  // Jamais pré-cochée : la première alerte et son email récapitulatif sont un choix explicite.
  const [wantsAlert, setWantsAlert] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { user } = useAuth();
  const hasAnalysisAccess = useHasAnalysisAccess(user?.id);
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    if (alertWanted) {
      // Un seul geste : l'alerte (un récapitulatif par semaine) puis le catalogue filtré. En cas
      // d'échec le message est affiché et la personne reste ici pour réessayer ou décocher.
      const result = await createAlertFromSearch(alertSearch, {
        frequency: "weekly",
        emailRecap: true,
        name: buildAlertName(
          alertSearch.query ? { ...alertSearch, city: alertSearch.query } : alertSearch,
        ),
      });
      if (result.status !== "created") return;
    }
    router.push(pathWithSearch("/sales", criteria));
  }

  return (
    <main
      id="contenu"
      className="liquid-page min-h-[calc(100svh-4rem)] px-4 py-10 sm:px-6 sm:py-16"
    >
      <section className="glass-shell mx-auto max-w-2xl rounded-lg p-6 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
          Bienvenue dans votre compte Découverte
        </p>
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
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-2 font-display text-3xl text-foreground outline-none"
        >
          {steps[step]}
        </h1>

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
                bien.{" "}
                {launchOffer ? (
                  <>
                    Pendant l’offre de lancement, votre compte gratuit ouvre toutes les ventes avec
                    les outils de l’offre Analyse.
                  </>
                ) : (
                  <>
                    Chaque mois, vous pouvez débloquer {MONTHLY_SALE_UNLOCKS} ventes en détail (
                    {UNLOCK_HIGHLIGHTS_INLINE_TEXT}). L’offre Analyse les ouvre toutes.
                  </>
                )}
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
                    Créer ma première alerte avec ces critères (un email récapitulatif par semaine)
                  </span>
                </label>
                <p
                  id="first-alert-help"
                  className="mt-1 pl-8 text-xs leading-relaxed text-muted-foreground"
                >
                  {alertUnavailable ??
                    "Facultatif. En cochant cette case, vous acceptez de recevoir par email un récapitulatif hebdomadaire des nouvelles ventes correspondant à ces critères. Vous pourrez le désactiver à tout moment depuis votre compte ou le lien de désinscription de chaque email."}
                </p>
              </div>
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
            <button
              type="submit"
              disabled={saving}
              className="liquid-button rounded-lg px-6 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? "Création de l’alerte…"
                : step === steps.length - 1
                  ? "Voir les biens"
                  : "Continuer"}
            </button>
          </div>
        </form>
        <Link
          href="/sales"
          className="mt-6 inline-block text-sm text-muted-foreground underline underline-offset-4"
        >
          Passer et explorer le catalogue
        </Link>
      </section>
    </main>
  );
}

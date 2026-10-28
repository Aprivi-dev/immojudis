"use client";

import { RentSourceNotice } from "@/components/RentSourceNotice";
import { estimateSaleGrossYieldRange, type GrossYieldRange } from "@/lib/geo";
import { feeRegimeKeyForSale } from "@/lib/fee-regime-key";
import {
  HOUSING_TENSION_NOTE,
  tensionAttribution,
  housingTensionLine,
  type HousingTension,
} from "@/lib/housing-tension";
import { formatRentSourceDate, isAnilRentReference } from "@/lib/rent-source-notice";
import type { RentReference, RentSegment } from "@/lib/rent-reference";
import type { AuctionSale } from "@/lib/types";

/** Titre du bloc, et libellé exact du rendement affiché (n° 44). */
export const RENTAL_MARKET_TITLE = "Marché locatif (estimation)";
export const YIELD_AT_STARTING_PRICE_LABEL = "Rendement brut à la mise à prix (charges comprises)";

const SEGMENT_LABELS: Record<RentSegment, string> = {
  apt_all: "appartements",
  apt_1_2: "petits appartements (T1-T2)",
  apt_3p: "appartements de trois pièces et plus",
  house: "maisons",
};

const rentFormat = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const percentFormat = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const countFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

const perM2 = (value: number) => `${rentFormat.format(value)} €/m²`;
const percent = (value: number) => `${percentFormat.format(value)} %`;

/**
 * Ce que le bloc dit de la nature de l'estimation : commune, « loyer de maille », intercommunalité, ou
 * médiane calculée par Immojudis sur la carte de l'ANIL (arrondissements, département).
 */
function rentNature(reference: RentReference): string {
  if (reference.source === "anil_arrondissements_median") {
    return "Loyer calculé par Immojudis : médiane des estimations ANIL des arrondissements, faute d’estimation propre à celui du bien. Indicatif.";
  }
  if (reference.source === "anil_department_median") {
    return "Loyer calculé par Immojudis : médiane des estimations ANIL des communes du département, faute d’estimation pour la commune du bien. Indicatif.";
  }
  if (reference.source === "anil_maille") {
    return "Loyer de maille : estimation commune à un groupe de communes voisines, la commune comptant trop peu d’annonces pour une estimation propre. Indicatif.";
  }
  if (reference.source === "anil_epci") {
    return "Loyer de l’intercommunalité : estimation indicative, la commune comptant trop peu d’annonces.";
  }
  return reference.reliability === "reliable"
    ? "Estimation calculée sur les annonces de la commune."
    : "Estimation indicative : la commune compte peu d’annonces ou le modèle est peu précis.";
}

/**
 * Le rendement à afficher : une référence fiable donne la valeur centrale et sa fourchette ; une référence
 * indicative (maille, intercommunalité, peu d’annonces) ne donne QUE la fourchette, jamais un chiffre ponctuel.
 * Sans borne de loyer, une référence indicative ne donne aucun rendement.
 */
export function yieldText(range: GrossYieldRange, reliability: RentReference["reliability"]) {
  const hasBounds = range.lowPct != null && range.highPct != null;
  const bounds = hasBounds
    ? [Math.min(range.lowPct!, range.highPct!), Math.max(range.lowPct!, range.highPct!)]
    : null;
  if (reliability === "reliable") {
    return bounds
      ? `${percent(range.centralPct)} (de ${percent(bounds[0])} à ${percent(bounds[1])} selon la fourchette de loyer)`
      : percent(range.centralPct);
  }
  return bounds ? `entre ${percent(bounds[0])} et ${percent(bounds[1])}` : null;
}

type MarketSale = Parameters<typeof estimateSaleGrossYieldRange>[0];

/**
 * Bloc « Marché locatif (estimation) » de la fiche : loyer d’annonce de la carte de l’ANIL (charges comprises) avec
 * sa fourchette et le nombre d’annonces, « loyer de maille » quand la source l’est, rendement brut à la mise à prix en
 * fourchette quand la référence est indicative, zonage tendu (TLV) en ligne neutre, et les mentions de source
 * obligatoires. Rien d’autre : aucun conseil, aucune promesse de gain. Chargé à la demande
 * (`RentalMarketBlockLazy`).
 *
 * Sans loyer de la carte de l’ANIL (repli départemental, bien qui n’est pas un logement), seul le zonage s’affiche ;
 * sans l’un ni l’autre, le bloc n’affiche rien.
 */
export function RentalMarketBlock({
  sale,
  startingPriceEur,
  surfaceM2,
  reference,
  tension,
  className = "mx-auto w-full max-w-[1380px] px-4 sm:px-6 lg:px-8",
}: {
  /** La vente (type, département, conditions) : détermine les frais d’acquisition du rendement. */
  sale: MarketSale;
  /** Mise à prix lisible par ce compte ; `null` : non lisible, aucun rendement. */
  startingPriceEur: number | null;
  surfaceM2: number | null;
  reference: RentReference | null;
  tension: HousingTension | null;
  className?: string;
}) {
  const anil = isAnilRentReference(reference) ? reference : null;
  if (!anil && !tension) return null;

  // Le régime de la vente doit être connu : vente notariale aux conditions illisibles ou vente domaniale, les frais
  // seraient ceux d’un autre type de vente.
  const regimeKnown = feeRegimeKeyForSale(sale as AuctionSale) != null;
  const range =
    anil && regimeKnown && startingPriceEur != null && startingPriceEur > 0
      ? estimateSaleGrossYieldRange(
          { ...sale, starting_price_eur: startingPriceEur },
          surfaceM2,
          anil,
        )
      : null;
  const yieldValue = range && anil ? yieldText(range, anil.reliability) : null;
  const low = anil?.lowPerM2;
  const high = anil?.highPerM2;
  const observations = anil?.observations;

  return (
    <section
      aria-labelledby="rental-market-title"
      data-testid="rental-market-block"
      className={className}
    >
      <div className="rounded-lg border border-line-soft bg-white p-4 text-sm text-foreground">
        <h2 id="rental-market-title" className="font-display text-lg font-semibold text-brand-navy">
          {RENTAL_MARKET_TITLE}
        </h2>
        {anil ? (
          <div className="mt-2 space-y-1.5">
            <p>
              Loyer d’annonce estimé, {SEGMENT_LABELS[anil.segment ?? "apt_all"]} :{" "}
              <strong>{perM2(anil.rentPerM2)} par mois</strong>, charges comprises
              {low != null && high != null
                ? ` (fourchette de ${perM2(Math.min(low, high))} à ${perM2(Math.max(low, high))})`
                : ""}
              .
            </p>
            {observations != null ? (
              <p>
                {countFormat.format(observations)}{" "}
                {observations > 1 ? "annonces observées" : "annonce observée"} dans la commune.
              </p>
            ) : null}
            <p className="text-ink-soft">{rentNature(anil)}</p>
            {yieldValue ? (
              <p>
                {YIELD_AT_STARTING_PRICE_LABEL} : <strong>{yieldValue}</strong>
                <span className="mt-1 block text-xs text-ink-soft">
                  Calculé sur la mise à prix, avec les frais d’acquisition estimés du type de vente.
                  Si la vente se conclut au-dessus de la mise à prix, le rendement est plus faible.
                  Estimation, pas une promesse de gain.
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
        {tension ? (
          <p className="mt-2" data-testid="housing-tension-line">
            {housingTensionLine(tension.zoning)}{" "}
            <span className="text-ink-soft">{HOUSING_TENSION_NOTE}</span>
          </p>
        ) : null}
        <div className="mt-3 space-y-1">
          {anil ? <RentSourceNotice reference={anil} /> : null}
          {tension ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {tensionAttribution(formatRentSourceDate(tension.sourceUpdatedOn))}
              {tension.sourceUrl ? (
                <>
                  {" "}
                  <a
                    href={tension.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Source : data.gouv.fr
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

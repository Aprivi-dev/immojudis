"use client";

import { RentSourceNotice } from "@/components/RentSourceNotice";
import { Badge } from "@/components/ui/primitives";
import {
  HOUSING_TENSION_NOTE,
  housingTensionLine,
  tensionAttribution,
  type HousingTension,
} from "@/lib/housing-tension";
import type { RentReference, RentReferenceSource, RentSegment } from "@/lib/rent-reference";
import { formatRentSourceDate, isAnilRentReference } from "@/lib/rent-source-notice";
import { PUBLIC_YIELD_LABEL } from "@/lib/public-rental-yield";
import styles from "./SalePublicPreview.module.css";

/** Le segment dans la phrase : « le loyer d'annonce des appartements ». */
const SEGMENT_PHRASES: Record<RentSegment, string> = {
  apt_all: "des appartements",
  apt_1_2: "des petits appartements (T1-T2)",
  apt_3p: "des appartements de trois pièces et plus",
  house: "des maisons",
};

/** Où l'estimation a été calculée : la phrase ne dit « dans la commune » que pour une estimation communale. */
const PLACE_PHRASES: Record<Exclude<RentReferenceSource, "department_estimate">, string> = {
  anil_commune: "Dans la commune",
  anil_maille: "Pour la commune et ses voisines (loyer de maille)",
  anil_epci: "Dans l’intercommunalité",
  anil_arrondissements_median: "Dans la ville, tous arrondissements",
  anil_department_median: "Dans le département",
};

const rentFormat = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const countFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const perM2 = (value: number) => `${rentFormat.format(value)} €/m²`;

/**
 * Nature de l'estimation, mot pour mot celle du bloc « Marché locatif » de la fiche des comptes
 * (`RentalMarketBlock`) : la fiche publique dit la même chose de la même donnée.
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
 * Section « Marché local » de la fiche publique : les chiffres du bloc « Marché locatif » (loyer
 * d'annonce de la carte de l'ANIL, fourchette, annonces observées, rendement brut à la mise à prix,
 * zonage tendu, mentions de source), mis en phrase, nombres surlignés et fourchette en réglette.
 * Aucune donnée de plus que le bloc des comptes. Sans loyer ANIL ni zonage, rien n'est rendu.
 */
export function SalePublicRentalMarket({
  reference,
  tension,
  yieldValue,
}: {
  reference: RentReference | null;
  tension: HousingTension | null;
  /** Rendement brut à la mise à prix, calculé par le serveur (`publicRentalYield`) ; `null` : aucun. */
  yieldValue: string | null;
}) {
  const anil = isAnilRentReference(reference) ? reference : null;
  if (!anil && !tension) return null;

  const bounds =
    anil?.lowPerM2 != null && anil.highPerM2 != null && anil.lowPerM2 !== anil.highPerM2
      ? ([
          Math.min(anil.lowPerM2, anil.highPerM2),
          Math.max(anil.lowPerM2, anil.highPerM2),
        ] as const)
      : null;
  const tick =
    anil && bounds
      ? Math.min(100, Math.max(0, ((anil.rentPerM2 - bounds[0]) / (bounds[1] - bounds[0])) * 100))
      : null;
  const observations = anil?.observations;

  return (
    <div data-testid="rental-market-block">
      {anil ? (
        <>
          <p className={styles.say}>
            {PLACE_PHRASES[anil.source as keyof typeof PLACE_PHRASES] ?? "Dans le secteur"}, le
            loyer d’annonce {SEGMENT_PHRASES[anil.segment ?? "apt_all"]} est estimé à{" "}
            <span className={styles.mark}>{perM2(anil.rentPerM2)}</span> par mois, charges comprises
            {observations != null ? (
              <>
                , d’après <span className={styles.mark}>{countFormat.format(observations)}</span>{" "}
                {observations > 1 ? "annonces observées" : "annonce observée"} dans la commune
              </>
            ) : null}
            .
          </p>
          {bounds && tick != null ? (
            <div className={styles.range}>
              <p className="sr-only">
                Fourchette de {perM2(bounds[0])} à {perM2(bounds[1])}.
              </p>
              <div className={styles.rangeTrack} aria-hidden>
                <span className={styles.rangeTick} style={{ left: `${tick}%` }} />
              </div>
              <div className={styles.rangeLabels} aria-hidden>
                <span>{perM2(bounds[0])}</span>
                <b>{perM2(anil.rentPerM2)} estimé</b>
                <span>{perM2(bounds[1])}</span>
              </div>
            </div>
          ) : null}
          <p className={styles.fine}>{rentNature(anil)}</p>
          {anil && yieldValue ? (
            <p className={styles.yield}>
              {PUBLIC_YIELD_LABEL} : <strong>{yieldValue}</strong>
              <span className={styles.fine}>
                Calculé sur la mise à prix, avec les frais d’acquisition estimés du type de vente.
                Si la vente se conclut au-dessus de la mise à prix, le rendement est plus faible.
                Estimation, pas une promesse de gain.
              </span>
            </p>
          ) : null}
        </>
      ) : null}
      {tension ? (
        <p className={styles.zone} data-testid="housing-tension-line">
          <Badge tone="info">{housingTensionLine(tension.zoning).replace(/\.$/, "")}</Badge>
          <span>{HOUSING_TENSION_NOTE}</span>
        </p>
      ) : null}
      <div className={styles.sources}>
        {anil ? <RentSourceNotice reference={anil} className={styles.fine} /> : null}
        {tension ? (
          <p className={styles.fine}>
            {tensionAttribution(formatRentSourceDate(tension.sourceUpdatedOn))}
            {tension.sourceUrl ? (
              <>
                {" "}
                <a href={tension.sourceUrl} target="_blank" rel="noopener noreferrer">
                  Source : data.gouv.fr
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/primitives";
import { fetchAuctionScenarios } from "@/lib/client-api";
import { queryKeys, type SaleAccessMode } from "@/lib/query-keys";
import {
  AUCTION_SCENARIO_LABELS,
  STARTING_PRICE_BAND_LABELS,
  dvfReferenceForType,
  formatEuro,
  formatPercent,
  formatRatio,
  probabilityAtLeast,
  type AuctionScenario,
  type AuctionScenariosResponse,
} from "@/lib/auction-scenarios";
import styles from "./AuctionScenariosSection.module.css";

const number = new Intl.NumberFormat("fr-FR");

function scenarioAmount(scenario: AuctionScenario, startingPrice: number): string {
  if (scenario.highRatio == null)
    return `au-delà de ${formatEuro(scenario.lowRatio * startingPrice)}`;
  if (scenario.lowRatio === 0) return `jusqu’à ${formatEuro(scenario.highRatio * startingPrice)}`;
  return `${formatEuro(scenario.lowRatio * startingPrice)} à ${formatEuro(scenario.highRatio * startingPrice)}`;
}

function yearLabel(date: string | null): string {
  return date ? date.slice(0, 4) : "";
}

/**
 * « Scénarios d'enchères » (offre Analyse) : la répartition observée des issues et la
 * fourchette centrale des prix finaux, d'après les trois dernières années d'adjudications
 * du tribunal (Licitor pour les rapports à la mise à prix, DVF pour les prix
 * officiels). Rendered for Analyse members and for a sale the account unlocked.
 */
export function AuctionScenariosSection({
  saleId,
  enabled,
  access = "analysis",
  userKey = null,
}: {
  saleId: string;
  enabled: boolean;
  /** The view the account reads (Analyse, or a sale unlocked with « 3 déblocages par mois »). */
  access?: SaleAccessMode;
  /** The signed-in account, so that a cached reading never crosses accounts. */
  userKey?: string | null;
}) {
  const query = useQuery<AuctionScenariosResponse>({
    queryKey: queryKeys.auctionScenarios(saleId, access, userKey),
    queryFn: () => fetchAuctionScenarios(saleId),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
  if (!enabled) return null;
  if (query.isLoading) {
    return (
      <section className={styles.card} aria-busy="true">
        <h2>Scénarios d’enchères</h2>
        <p className={styles.lead} role="status">
          Lecture des adjudications du tribunal…
        </p>
      </section>
    );
  }
  // Une erreur n'est pas une absence de données : on le dit et on propose de réessayer.
  if (query.isError) {
    return (
      <section className={styles.card} aria-labelledby="auction-scenarios-title">
        <h2 id="auction-scenarios-title">Scénarios d’enchères</h2>
        <div role="alert">
          <p className={styles.lead}>Les statistiques du tribunal n’ont pas pu être chargées.</p>
          <Button className="mt-3" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        </div>
      </section>
    );
  }
  const data = query.data;
  if (!data) return null;

  const { scenarios, history, startingPrice } = data;
  const licitor = history.licitor;
  const dvfType = dvfReferenceForType(history.dvf, data.propertyType);
  const court = data.courtName ?? "ce tribunal";

  return (
    <section id="scenarios" className={styles.card} aria-labelledby="auction-scenarios-title">
      <h2 id="auction-scenarios-title">Scénarios d’enchères</h2>

      {scenarios && startingPrice ? (
        <>
          <p className={styles.lead}>
            D’après {number.format(scenarios.courtSample)} adjudication
            {scenarios.courtSample > 1 ? "s" : ""} du {court} et{" "}
            {number.format(scenarios.nationalSample)} en France sur les trois dernières années, pour
            des mises à prix de {STARTING_PRICE_BAND_LABELS[scenarios.band ?? 0] ?? "même niveau"}.
          </p>
          {scenarios.ratioQuartiles.q25 != null && scenarios.ratioQuartiles.q75 != null ? (
            <div className={styles.headline}>
              <span>Fourchette centrale des prix finaux</span>
              <strong>
                {formatEuro(scenarios.ratioQuartiles.q25 * startingPrice)} à{" "}
                {formatEuro(scenarios.ratioQuartiles.q75 * startingPrice)}
              </strong>
              <small>
                La moitié des ventes comparables{" "}
                {scenarios.priceScope === "court" ? `du ${court}` : "en France"} a été adjugée entre{" "}
                {formatEuro(scenarios.ratioQuartiles.q25 * startingPrice)} et{" "}
                {formatEuro(scenarios.ratioQuartiles.q75 * startingPrice)} ; prix du milieu{" "}
                {formatEuro((scenarios.ratioQuartiles.q50 ?? 1) * startingPrice)} (
                {formatRatio(scenarios.ratioQuartiles.q50)} la mise à prix).
              </small>
            </div>
          ) : null}
          <ul className={styles.scenarios} aria-label="Répartition observée des issues">
            {scenarios.scenarios.map((scenario) => (
              <li key={scenario.key}>
                <div className={styles.scenarioTop}>
                  <span>{AUCTION_SCENARIO_LABELS[scenario.key]}</span>
                  <strong>{formatPercent(scenario.probability)}</strong>
                </div>
                <div className={styles.bar} aria-hidden="true">
                  <span style={{ width: `${Math.round(scenario.probability * 100)}%` }} />
                </div>
                <small>{scenarioAmount(scenario, startingPrice)}</small>
              </li>
            ))}
          </ul>
          <p className={styles.chance}>
            Part des ventes comparables adjugées à au moins 2 fois la mise à prix :{" "}
            <strong>{formatPercent(probabilityAtLeast(scenarios.scenarios, 2))}</strong>
          </p>
        </>
      ) : (
        <p className={styles.lead}>
          Pas assez d’adjudications comparables pour chiffrer des scénarios sur cette vente.
        </p>
      )}

      {licitor ? (
        <div className={styles.court}>
          <h3>Le {court} sur trois ans</h3>
          <dl>
            <div>
              <dt>Ventes adjugées</dt>
              <dd>{number.format(licitor.sample)}</dd>
            </div>
            <div>
              <dt>Mise à prix moyenne</dt>
              <dd>{formatEuro(licitor.meanStartingPrice)}</dd>
            </div>
            <div>
              <dt>Prix final moyen</dt>
              <dd>{formatEuro(licitor.meanHammerPrice)}</dd>
            </div>
            <div>
              <dt>Adjugées à au moins 2 fois la mise à prix</dt>
              <dd>{formatPercent(licitor.atLeastDoubleRate)}</dd>
            </div>
          </dl>
          {licitor.byYear.length > 1 ? (
            <p className={styles.note}>
              Par année : {licitor.byYear.map((item) => `${item.year} : ${item.sales}`).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {history.dvf ? (
        <p className={styles.note}>
          Prix officiels (DVF) : {number.format(history.dvf.sample)} adjudications enregistrées dans
          le ressort du tribunal entre {yearLabel(history.dvf.firstDate)} et{" "}
          {yearLabel(history.dvf.lastDate)}, prix médian {formatEuro(history.dvf.medianPrice)}.
          {dvfType && data.surfaceM2 && dvfType.medianPricePerM2
            ? ` Pour ce type de bien : ${number.format(dvfType.medianPricePerM2)} €/m², soit environ ${formatEuro(
                dvfType.medianPricePerM2 * data.surfaceM2,
              )} pour ${number.format(Math.round(data.surfaceM2))} m².`
            : ""}
        </p>
      ) : null}

      <p className={styles.caveat}>
        Statistiques sur les ventes adjugées : elles ne comptent ni les reports ni les ventes sans
        enchérisseur, et ne remplacent pas la visite ni la lecture du cahier des conditions de
        vente. Fréquences observées dans le passé sur un échantillon limité, issues de données
        tierces non vérifiées auprès du greffe ; elles ne constituent pas une probabilité pour cette
        vente. Sources : historique des adjudications publié par Licitor, DVF (DGFiP).
      </p>
    </section>
  );
}

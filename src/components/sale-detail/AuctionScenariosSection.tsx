"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/primitives";
import { fetchAuctionScenarios } from "@/lib/client-api";
import { queryKeys, type SaleAccessMode } from "@/lib/query-keys";
import {
  AUCTION_SCENARIO_LABELS,
  MIN_COURT_SAMPLE,
  MIN_NATIONAL_SAMPLE,
  MIN_SCENARIO_STARTING_PRICE,
  PROPERTY_GROUP_LABELS,
  RELIABILITY_EXPLANATIONS,
  RELIABILITY_LABELS,
  STARTING_PRICE_BAND_LABELS,
  formatDataAsOf,
  formatEuro,
  formatPercent,
  formatRatio,
  largestRemainderPercentages,
  scenarioPropertyGroup,
  type AuctionScenario,
  type AuctionScenariosResponse,
  type AuctionScenarioSet,
  type ScenariosUnavailableReason,
} from "@/lib/auction-scenarios";
import styles from "./AuctionScenariosSection.module.css";

const number = new Intl.NumberFormat("fr-FR");

const SEGMENT_CLASSES = [
  styles.segment0,
  styles.segment1,
  styles.segment2,
  styles.segment3,
  styles.segment4,
];

function scenarioAmount(scenario: AuctionScenario, startingPrice: number): string {
  if (scenario.highRatio == null)
    return `au-delà de ${formatEuro(scenario.lowRatio * startingPrice)}`;
  if (scenario.lowRatio === 0) return `jusqu’à ${formatEuro(scenario.highRatio * startingPrice)}`;
  return `${formatEuro(scenario.lowRatio * startingPrice)} à ${formatEuro(scenario.highRatio * startingPrice)}`;
}

function yearLabel(date: string | null): string {
  return date ? date.slice(0, 4) : "";
}

/** One message per cause: the sale has no starting price, no known court, too small a price, or too few sales. */
function unavailableMessage(
  reason: ScenariosUnavailableReason | null,
  scenarios: AuctionScenarioSet | null,
  court: string,
): string {
  switch (reason) {
    case "no_starting_price":
      return "Cette vente n’a pas de mise à prix connue : les scénarios se calculent à partir de la mise à prix.";
    case "starting_price_too_low":
      return `La mise à prix de cette vente est inférieure à ${number.format(MIN_SCENARIO_STARTING_PRICE)} € : aucun scénario n’est chiffré à ce niveau.`;
    case "no_court_code":
      return "Le tribunal de cette vente n’est pas encore identifié dans notre référentiel : nous ne pouvons pas la rapprocher des adjudications passées.";
    default:
      return scenarios
        ? `Données insuffisantes : ${number.format(scenarios.nationalSample)} vente${scenarios.nationalSample > 1 ? "s" : ""} comparable${scenarios.nationalSample > 1 ? "s" : ""} seulement sur les tribunaux couverts (dont ${number.format(scenarios.courtSample)} au ${court}), pour au moins ${MIN_NATIONAL_SAMPLE} nécessaires à chiffrer des scénarios.`
        : "Données insuffisantes : pas assez d’adjudications comparables pour chiffrer des scénarios sur cette vente.";
  }
}

/**
 * « Scénarios d'enchères » (offre Analyse) : la répartition observée des issues et la
 * fourchette centrale des prix d'adjudication, d'après les trois dernières années d'adjudications
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
  const price = startingPrice ?? 0;
  const court = data.courtName ?? "ce tribunal";
  const asOf = formatDataAsOf(data.dataAsOf);
  const propertyGroup = scenarioPropertyGroup(data.propertyType);
  const figures = scenarios && scenarios.status === "ok" && startingPrice ? scenarios : null;
  const percentages = figures
    ? largestRemainderPercentages(figures.scenarios.map((scenario) => scenario.probability))
    : [];
  const atLeastDouble = figures
    ? figures.scenarios.reduce(
        (sum, scenario, index) => (scenario.lowRatio >= 2 ? sum + percentages[index] : sum),
        0,
      )
    : 0;
  const currentYear = new Date().getFullYear();

  return (
    <section id="scenarios" className={styles.card} aria-labelledby="auction-scenarios-title">
      <h2 id="auction-scenarios-title">Scénarios d’enchères</h2>
      {asOf ? <p className={styles.asOf}>Données au {asOf}</p> : null}

      <p className={styles.warning} id="scenarios-caveat">
        <strong>À lire avant les chiffres.</strong> Ces statistiques ne portent que sur les ventes
        adjugées : elles ne comptent ni les reports ni les ventes restées sans enchérisseur, où le
        bien revient au créancier poursuivant. Ces ventes absentes des chiffres tirent les rapports
        observés vers le haut : les prix ci-dessous sont plus élevés que ceux de l’ensemble des
        mises en vente. Ils ne remplacent ni la visite ni la lecture du cahier des conditions de
        vente.
      </p>

      {figures ? (
        <>
          <p className={styles.lead}>
            {figures.basis === "court" ? (
              <>
                D’après {number.format(figures.courtSample)} adjudication
                {figures.courtSample > 1 ? "s" : ""} du {court} et{" "}
                {number.format(figures.nationalSample)} sur les tribunaux couverts
              </>
            ) : (
              <>
                Moins de {MIN_COURT_SAMPLE} ventes comparables au {court} (
                {number.format(figures.courtSample)}) : repli sur les{" "}
                {number.format(figures.nationalSample)} ventes comparables des tribunaux couverts
              </>
            )}{" "}
            sur les trois dernières années, pour des mises à prix de{" "}
            {STARTING_PRICE_BAND_LABELS[figures.band ?? 0] ?? "même niveau"}
            {propertyGroup ? `, en ne comparant que ${PROPERTY_GROUP_LABELS[propertyGroup]}` : ""}.
          </p>
          {figures.reliability ? (
            <p className={styles.reliability} data-reliability={figures.reliability}>
              Niveau de fiabilité : <strong>{RELIABILITY_LABELS[figures.reliability]}</strong> (
              {RELIABILITY_EXPLANATIONS[figures.reliability]}).
            </p>
          ) : null}
          {figures.ratioQuartiles.q25 != null && figures.ratioQuartiles.q75 != null ? (
            <div className={styles.headline}>
              <span>
                Fourchette centrale des prix d’adjudication (estimation à partir des ventes passées)
              </span>
              <strong>
                {formatEuro(figures.ratioQuartiles.q25 * price)} à{" "}
                {formatEuro(figures.ratioQuartiles.q75 * price)}
              </strong>
              <small>
                Dans la moitié centrale des ventes comparables{" "}
                {figures.priceScope === "court" ? `du ${court}` : "des tribunaux couverts"}, le prix
                d’adjudication, avant éventuelle surenchère, a été compris entre{" "}
                {formatRatio(figures.ratioQuartiles.q25)} et{" "}
                {formatRatio(figures.ratioQuartiles.q75)} la mise à prix. Appliqué à cette vente,
                cela donne environ {formatEuro(figures.ratioQuartiles.q25 * price)} à{" "}
                {formatEuro(figures.ratioQuartiles.q75 * price)}, hors frais
                {figures.ratioQuartiles.q50 != null
                  ? `, avec un prix médian d’environ ${formatEuro(
                      figures.ratioQuartiles.q50 * price,
                    )} (${formatRatio(figures.ratioQuartiles.q50)})`
                  : ""}
                . Ce n’est pas une prévision.
              </small>
            </div>
          ) : null}
          <div className={styles.stack} aria-hidden="true">
            {figures.scenarios.map((scenario, index) => (
              <span
                key={scenario.key}
                className={SEGMENT_CLASSES[index]}
                style={{ width: `${percentages[index]}%` }}
              />
            ))}
          </div>
          <ul className={styles.scenarios} aria-label="Répartition observée des issues">
            {figures.scenarios.map((scenario, index) => (
              <li key={scenario.key}>
                <div className={styles.scenarioTop}>
                  <span>
                    <i
                      className={`${styles.swatch} ${SEGMENT_CLASSES[index]}`}
                      aria-hidden="true"
                    />
                    {AUCTION_SCENARIO_LABELS[scenario.key]}
                  </span>
                  <strong>{formatPercent(percentages[index] / 100)}</strong>
                </div>
                <small>{scenarioAmount(scenario, price)}</small>
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            Montants calculés sur la mise à prix de cette vente, hors frais. Parts estimées,
            arrondies pour totaliser 100 %.
          </p>
          <p className={styles.chance}>
            Part estimée des ventes comparables adjugées à au moins 2 fois la mise à prix :{" "}
            <strong>{formatPercent(atLeastDouble / 100)}</strong>
          </p>
        </>
      ) : (
        <p className={styles.lead}>
          {unavailableMessage(data.unavailable ?? "insufficient_data", scenarios, court)}
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
              <dt>Mise à prix médiane</dt>
              <dd>{formatEuro(licitor.medianStartingPrice)}</dd>
            </div>
            <div>
              <dt>Prix d’adjudication médian (avant éventuelle surenchère, hors frais)</dt>
              <dd>{formatEuro(licitor.medianHammerPrice)}</dd>
            </div>
            <div>
              <dt>Adjugées à au moins 2 fois la mise à prix</dt>
              <dd>{formatPercent(licitor.atLeastDoubleRate)}</dd>
            </div>
          </dl>
          {licitor.byYear.length > 1 ? (
            <p className={styles.note}>
              Par année :{" "}
              {licitor.byYear
                .map(
                  (item) =>
                    `${item.year}${item.year === currentYear ? " (partielle)" : ""} : ${item.sales}`,
                )
                .join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {history.dvf ? (
        <p className={styles.note}>
          Prix officiels (DVF) : {number.format(history.dvf.sample)} adjudications enregistrées dans
          le ressort du tribunal entre {yearLabel(history.dvf.firstDate)} et{" "}
          {yearLabel(history.dvf.lastDate)}, prix médian {formatEuro(history.dvf.medianPrice)}.
        </p>
      ) : null}

      <p className={styles.caveat}>
        Fréquences observées dans le passé sur un échantillon limité, issues de données tierces non
        vérifiées auprès du greffe ; elles ne constituent pas une probabilité pour cette vente.
        Sources : historique des adjudications publié par Licitor, DVF (DGFiP).
      </p>
    </section>
  );
}

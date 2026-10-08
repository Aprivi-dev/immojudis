"use client";

import { useId, useMemo, useRef, useState } from "react";
import Download from "lucide-react/dist/esm/icons/download.js";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right.js";
import type {
  AdjudicationPriceStatisticsDirectoryResponse,
  AdjudicationPriceStatisticsScope,
} from "@/lib/adjudication-price-statistics";
import {
  bidBandLabels,
  bidBands,
  detailedBidBandLabels,
  detailedBidBands,
  type AdjudicationDistribution,
} from "@/lib/adjudication-distributions";
import {
  distributionRates,
  filterAdjudicationTribunals,
  propertyTypeLabels,
  tribunalComparisonCsv,
  type TribunalSort,
} from "@/lib/adjudication-barometer";
import styles from "./AdjudicationBarometer.module.css";

const euro = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("fr-FR");
const percent = new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 });
const ratio = new Intl.NumberFormat("fr-FR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const multiple = (value: number) => `${ratio.format(value)}×`;
const date = (value: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));

export function AdjudicationBarometer({
  data,
  initialCourtCode,
}: {
  data: AdjudicationPriceStatisticsDirectoryResponse;
  initialCourtCode: string | null;
}) {
  const id = useId();
  const [courtCode, setCourtCode] = useState(initialCourtCode ?? "");
  const [propertyType, setPropertyType] = useState("");
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [minimumSample, setMinimumSample] = useState(10);
  const [sort, setSort] = useState<TribunalSort>("sample");
  const profileHeading = useRef<HTMLHeadingElement>(null);
  const scope = courtCode
    ? (data.tribunals.find((item) => item.courtCode === courtCode) ?? null)
    : data.national;
  const types = scope?.propertyTypes ?? [];
  const selectedType = types.find((item) => item.propertyType === propertyType);
  const distribution = selectedType?.distribution ?? scope?.distribution;
  const filtered = useMemo(
    () => filterAdjudicationTribunals(data.tribunals, { search, region, minimumSample, sort }),
    [data.tribunals, search, region, minimumSample, sort],
  );
  const regions = [
    ...new Set(
      data.tribunals.flatMap((item) => (item.judicialRegion ? [item.judicialRegion] : [])),
    ),
  ].sort((a, b) => a.localeCompare(b, "fr"));
  const coveredSales = data.tribunals.reduce((sum, item) => sum + item.sampleSize, 0);
  function chooseCourt(code: string, focus = false) {
    setCourtCode(code);
    setPropertyType("");
    if (focus) {
      profileHeading.current?.focus({ preventScroll: true });
      profileHeading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  function downloadComparison() {
    const url = URL.createObjectURL(
      new Blob([tribunalComparisonCsv(filtered)], { type: "text/csv;charset=utf-8;" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `statistiques-tribunaux-${data.national.periodEnd}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className={styles.barometer}>
      <div className={styles.period}>
        <span>
          <strong>Période des ventes</strong> · {date(data.national.periodStart)} au{" "}
          {date(data.national.periodEnd)}
        </span>
        <span>Validation · {date(data.meta.reviewedAt)}</span>
      </div>
      <nav aria-label="Sections des statistiques" className={styles.nav}>
        {[
          ["resultats", "L’essentiel"],
          ["repartition", "Répartition"],
          ["types", "Types de biens"],
          ["comparaison", "Comparer les tribunaux"],
          ["methode", "Méthode & FAQ"],
        ].map(([key, label]) => (
          <a key={key} href={`#${id}-${key}`}>
            {label}
          </a>
        ))}
      </nav>

      <section id={`${id}-resultats`} className={styles.section} aria-labelledby={`${id}-scope`}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>01 · Comprendre les résultats</p>
            <h3 id={`${id}-scope`} ref={profileHeading} tabIndex={-1}>
              {scope?.label ?? "Tribunal sans résultats publiables"}
            </h3>
            <p>
              Prix adjugés hors frais ·{" "}
              {selectedType ? propertyTypeLabels[propertyType] : "Tous types de biens"}
            </p>
          </div>
          <label className={styles.control}>
            Tribunal
            <select value={courtCode} onChange={(event) => chooseCourt(event.target.value)}>
              <option value="">France · ensemble des résultats</option>
              {courtCode && !scope ? (
                <option value={courtCode}>Tribunal sélectionné · données insuffisantes</option>
              ) : null}
              {data.tribunals.map((item) => (
                <option key={item.courtCode} value={item.courtCode ?? ""}>
                  {item.label} · {integer.format(item.sampleSize)} prix
                </option>
              ))}
            </select>
          </label>
        </div>
        {scope ? (
          <>
            <div className={styles.scopeTools}>
              <label className={styles.control}>
                Type de bien
                <select
                  value={selectedType?.propertyType ?? ""}
                  onChange={(event) => setPropertyType(event.target.value)}
                >
                  <option value="">Tous types confondus</option>
                  {types.map((item) => (
                    <option key={item.propertyType} value={item.propertyType}>
                      {propertyTypeLabels[item.propertyType]} ·{" "}
                      {integer.format(item.distribution.sampleSize)} prix
                    </option>
                  ))}
                </select>
              </label>
              <span className={styles.sample}>
                {integer.format(selectedType?.distribution.sampleSize ?? scope.sampleSize)} prix
                publiés ·{" "}
                {(selectedType?.distribution.sampleSize ?? scope.sampleSize) < 30
                  ? "échantillon limité"
                  : "échantillon descriptif"}
              </span>
            </div>
            <ScopeMetrics scope={scope} selectedDistribution={selectedType?.distribution} />
            {distribution ? (
              <div className={styles.interpretation}>
                <strong>La moitié centrale des résultats</strong>
                <p>
                  50 % des prix adjugés se situent entre{" "}
                  <b>{euro.format(distribution.hammerPriceMiddle50Eur.p25)}</b> et{" "}
                  <b>{euro.format(distribution.hammerPriceMiddle50Eur.p75)}</b>, et 50 % des
                  multiples entre <b>{multiple(distribution.ratioMiddle50.p25)}</b> et{" "}
                  <b>{multiple(distribution.ratioMiddle50.p75)}</b> la mise à prix.
                </p>
                <p>
                  Ces intervalles décrivent des biens différents. Ils ne constituent pas une
                  estimation du bien que vous préparez.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <p className={styles.notice} role="status">
            Ce tribunal ne dispose pas d’au moins 10 résultats contrôlés publiables. Sélectionnez la
            vue France ou un autre tribunal pour consulter un échantillon disponible.
          </p>
        )}
      </section>

      <section
        id={`${id}-repartition`}
        className={styles.section}
        aria-labelledby={`${id}-distribution-title`}
      >
        <p className={styles.eyebrow}>02 · Situer le prix final</p>
        <h3 id={`${id}-distribution-title`}>Où se situent les adjudications ?</h3>
        <p className={styles.description}>
          Chaque vente est comptée une seule fois, selon le rapport prix adjugé / mise à prix.{" "}
          {scope?.label}
          {selectedType ? ` · ${propertyTypeLabels[propertyType]}` : ""}.
        </p>
        {distribution ? (
          <DistributionChart distribution={distribution} />
        ) : (
          <p className={styles.notice}>
            La répartition n’est pas disponible pour cet échantillon. Les médianes seules ne
            permettent pas de la reconstituer.
          </p>
        )}
      </section>

      <section id={`${id}-types`} className={styles.section} aria-labelledby={`${id}-types-title`}>
        <p className={styles.eyebrow}>03 · Comparer des biens similaires</p>
        <h3 id={`${id}-types-title`}>Résultats par type de bien</h3>
        <p className={styles.description}>
          {scope?.label ?? "Tribunal sélectionné"} · Chaque ligne porte sur son propre échantillon,
          à partir de 10 résultats. Le filtre de type ci-dessus ne masque pas les autres lignes.
        </p>
        {types.length ? (
          <>
            <div
              className={styles.tableScroll}
              role="region"
              aria-label="Comparaison des types de biens"
              tabIndex={0}
            >
              <table>
                <caption className={styles.srOnly}>
                  Prix et multiples par type de bien pour {scope?.label}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Type de bien</th>
                    <th scope="col">Résultats</th>
                    <th scope="col">Multiple médian</th>
                    <th scope="col">Prix adjugé médian</th>
                    <th scope="col">50 % des prix adjugés</th>
                    <th scope="col">Au-dessus de la mise</th>
                  </tr>
                </thead>
                <tbody>
                  {[...types]
                    .sort((a, b) => b.distribution.sampleSize - a.distribution.sampleSize)
                    .map((item) => (
                      <tr
                        key={item.propertyType}
                        aria-selected={propertyType === item.propertyType}
                      >
                        <th scope="row">
                          <button
                            type="button"
                            onClick={() => {
                              setPropertyType(item.propertyType);
                              profileHeading.current?.focus();
                            }}
                            aria-label={`Analyser le type ${propertyTypeLabels[item.propertyType]}`}
                          >
                            {propertyTypeLabels[item.propertyType]}{" "}
                            <ArrowUpRight size={14} aria-hidden />
                          </button>
                        </th>
                        <td>{integer.format(item.distribution.sampleSize)}</td>
                        <td>
                          {item.distribution.summary ? (
                            multiple(item.distribution.summary.medianHammerToStartingRatio)
                          ) : (
                            <MissingMetric />
                          )}
                        </td>
                        <td>
                          {item.distribution.summary ? (
                            euro.format(item.distribution.summary.medianHammerPriceEur)
                          ) : (
                            <MissingMetric />
                          )}
                        </td>
                        <td>
                          {euro.format(item.distribution.hammerPriceMiddle50Eur.p25)} –{" "}
                          {euro.format(item.distribution.hammerPriceMiddle50Eur.p75)}
                        </td>
                        <td>
                          {percent.format(distributionRates(item.distribution).aboveStartingRate)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className={styles.footnote}>
              {integer.format(types.reduce((sum, item) => sum + item.distribution.sampleSize, 0))}{" "}
              résultats répartis dans les types publiables sur {integer.format(scope!.sampleSize)}.
              Les types inconnus ou les groupes de moins de 10 résultats restent hors de ce tableau.{" "}
              {types.some((item) => !item.distribution.summary)
                ? "— : médiane non calculée dans la publication disponible ; les quartiles ne permettent pas de la déduire."
                : ""}
            </p>
          </>
        ) : (
          <p className={styles.notice}>
            Aucun type de bien ne dispose d’un sous-échantillon publiable dans cette sélection.
          </p>
        )}
      </section>

      <section
        id={`${id}-comparaison`}
        className={styles.section}
        aria-labelledby={`${id}-comparison-title`}
      >
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>04 · Explorer les tribunaux</p>
            <h3 id={`${id}-comparison-title`}>Comparer les tribunaux</h3>
          </div>
          <button
            className={styles.export}
            type="button"
            onClick={downloadComparison}
            disabled={!filtered.length}
          >
            <Download size={16} aria-hidden /> Exporter la sélection CSV
          </button>
        </div>
        <p className={styles.description}>
          {data.tribunals.length} tribunaux avec au moins 10 résultats contrôlés. Leurs{" "}
          {integer.format(coveredSales)} prix représentent{" "}
          {percent.format(coveredSales / data.national.sampleSize)} de l’échantillon national. Tous
          types confondus, sur la même période.
        </p>
        <div className={styles.filters}>
          <label className={styles.control}>
            Rechercher dans les résultats
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Nom du tribunal ou ressort…"
            />
          </label>
          <label className={styles.control}>
            Ressort judiciaire
            <select value={region} onChange={(event) => setRegion(event.target.value)}>
              <option value="">Tous les ressorts</option>
              {regions.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label className={styles.control}>
            Effectif minimum
            <select
              value={minimumSample}
              onChange={(event) => setMinimumSample(Number(event.target.value))}
            >
              <option value={10}>10 résultats</option>
              <option value={30}>30 résultats</option>
              <option value={100}>100 résultats</option>
            </select>
          </label>
          <label className={styles.control}>
            Trier par
            <select value={sort} onChange={(event) => setSort(event.target.value as TribunalSort)}>
              <option value="sample">Nombre de résultats</option>
              <option value="ratio">Multiple médian décroissant</option>
              <option value="hammer">Prix adjugé décroissant</option>
              <option value="name">Nom du tribunal</option>
            </select>
          </label>
        </div>
        <p className={styles.footnote} role="status">
          {filtered.length} {filtered.length > 1 ? "tribunaux" : "tribunal"} affiché
          {filtered.length > 1 ? "s" : ""}
          {propertyType ? " · comparaison tous types confondus" : ""}
        </p>
        {filtered.length ? (
          <div
            className={styles.tableScroll}
            role="region"
            aria-label="Comparaison des tribunaux"
            tabIndex={0}
          >
            <table>
              <caption className={styles.srOnly}>
                Comparaison des résultats publiés par tribunal
              </caption>
              <thead>
                <tr>
                  <th scope="col" aria-sort={sort === "name" ? "ascending" : undefined}>
                    Tribunal
                  </th>
                  <th scope="col" aria-sort={sort === "sample" ? "descending" : undefined}>
                    Résultats
                  </th>
                  <th scope="col" aria-sort={sort === "ratio" ? "descending" : undefined}>
                    Multiple médian
                  </th>
                  <th scope="col">Mise à prix médiane</th>
                  <th scope="col" aria-sort={sort === "hammer" ? "descending" : undefined}>
                    Prix adjugé médian
                  </th>
                  <th scope="col">Au-dessus de la mise</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.courtCode} aria-selected={item.courtCode === courtCode}>
                    <th scope="row">
                      <button
                        type="button"
                        aria-label={`Analyser ${item.label}`}
                        onClick={() => chooseCourt(item.courtCode!, true)}
                      >
                        {item.label}
                        <ArrowUpRight size={14} aria-hidden />
                      </button>
                      <span className={styles.rowDetail}>
                        {item.judicialRegion ?? "Ressort non renseigné"}
                      </span>
                    </th>
                    <td>
                      {integer.format(item.sampleSize)}
                      {item.sampleSize < 30 ? (
                        <span className={styles.rowDetail}>Effectif limité</span>
                      ) : null}
                    </td>
                    <td>{multiple(item.metrics.medianHammerToStartingRatio)}</td>
                    <td>{euro.format(item.metrics.medianStartingPriceEur)}</td>
                    <td>{euro.format(item.metrics.medianHammerPriceEur)}</td>
                    <td>{percent.format(item.metrics.aboveStartingRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.notice}>
            Aucun tribunal ne correspond à ces filtres.{" "}
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setRegion("");
                setMinimumSample(10);
              }}
            >
              Réinitialiser les filtres
            </button>
          </p>
        )}
        <p className={styles.footnote}>
          Le multiple varie aussi avec les types de biens et les mises à prix pratiquées. Ce tableau
          ne mesure ni la performance des tribunaux ni une probabilité de gagner une enchère.
        </p>
      </section>

      <section
        id={`${id}-methode`}
        className={styles.section}
        aria-labelledby={`${id}-method-title`}
      >
        <p className={styles.eyebrow}>05 · Lire les chiffres avec leur contexte</p>
        <h3 id={`${id}-method-title`}>Méthode et questions fréquentes</h3>
        <div className={styles.methodGrid}>
          <div>
            <h4>Un périmètre documenté</h4>
            <p>
              {data.meta.sourceLabel}. Résultats contrôlés, dédoublonnés et rattachés à un tribunal
              identifié pour les vues locales. La couverture dépend des résultats publiés par la
              source et ne représente pas toutes les ventes françaises.
            </p>
          </div>
          <div>
            <h4>Des calculs vente par vente</h4>
            <p>
              Multiple = prix adjugé ÷ mise à prix de la même vente. Le multiple médian est la
              médiane de ces rapports, et non le rapport des deux prix médians. Les parts utilisent
              l’effectif indiqué comme dénominateur.
            </p>
          </div>
          <div>
            <h4>Une publication à partir de 10 résultats</h4>
            <p>
              Le seuil s’applique aussi aux types de biens. De 10 à 29 résultats, les variations
              peuvent être fortes. Un grand échantillon reste descriptif : les résultats manquants
              peuvent créer un biais.
            </p>
          </div>
          <div>
            <h4>Une période explicite</h4>
            <p>
              Ventes du {date(data.national.periodStart)} au {date(data.national.periodEnd)}. Calcul
              du {date(data.meta.builtAt)}, validé le {date(data.meta.reviewedAt)}. Les filtres de
              tribunal et de type conservent cette période.
            </p>
          </div>
        </div>
        <div className={styles.marketNote}>
          <h4>Écart avec le marché DVF · non disponible</h4>
          <p>
            La publication actuelle ne contient pas de rapprochement contrôlé entre chaque
            adjudication et une estimation DVF du même bien. Aucune décote n’est calculée à partir
            d’échantillons différents. Une donnée absente ne signifie pas une décote de 0 %.
          </p>
        </div>
        <details className={styles.faq}>
          <summary>Comment lire un multiple de 2× ?</summary>
          <p>
            Le prix adjugé vaut deux fois la mise à prix. Les frais d’acquisition, travaux et coûts
            liés à l’occupation s’ajoutent au prix adjugé. Un multiple faible ne suffit donc pas à
            identifier une bonne affaire.
          </p>
        </details>
        <details className={styles.faq}>
          <summary>Pourquoi certains tribunaux ou types de biens manquent-ils ?</summary>
          <p>
            Un résultat peut être absent, insuffisamment documenté ou rattaché à un tribunal ambigu.
            Les groupes de moins de 10 observations restent masqués. Leur absence ne signifie pas
            qu’aucune vente n’a eu lieu.
          </p>
        </details>
        <details className={styles.faq}>
          <summary>Les prix et les taux sont-ils définitifs ?</summary>
          <p>
            {data.meta.warning} La part au-dessus de la mise à prix porte sur les prix connus ; ce
            n’est pas le taux de réussite de toutes les ventes annoncées.
          </p>
        </details>
        <p className={styles.footnote}>{data.meta.warning}</p>
      </section>
    </div>
  );
}

function ScopeMetrics({
  scope,
  selectedDistribution,
}: {
  scope: AdjudicationPriceStatisticsScope;
  selectedDistribution?: AdjudicationDistribution;
}) {
  const summary = selectedDistribution ? selectedDistribution.summary : scope.metrics;
  const rates = selectedDistribution ? distributionRates(selectedDistribution) : scope.metrics;
  const count = selectedDistribution?.sampleSize ?? scope.sampleSize;
  const mean = (selectedDistribution ?? scope.distribution)?.summary?.meanHammerToStartingRatio;
  return (
    <dl className={styles.metrics}>
      <Metric
        label="Multiple médian de la mise"
        value={summary ? multiple(summary.medianHammerToStartingRatio) : "—"}
        detail={
          mean
            ? `Moyenne des multiples : ${multiple(mean)}`
            : summary
              ? "Médiane des rapports vente par vente"
              : "Médiane non disponible pour ce type"
        }
      />
      <Metric
        label="Au-dessus de la mise à prix"
        value={percent.format(rates.aboveStartingRate)}
        detail={`Sur ${integer.format(count)} prix connus`}
      />
      <Metric
        label="Résultats analysés"
        value={integer.format(count)}
        detail={
          count < 30 ? "Effectif limité · prudence de lecture" : "Résultats publiés et contrôlés"
        }
      />
      <Metric
        label="Prix adjugé médian"
        value={summary ? euro.format(summary.medianHammerPriceEur) : "—"}
        detail={summary ? "Prix au marteau, hors frais" : "Médiane non disponible pour ce type"}
      />
      <Metric
        label="Mise à prix médiane"
        value={summary ? euro.format(summary.medianStartingPriceEur) : "—"}
        detail={summary ? "Même échantillon de ventes" : "Médiane non disponible pour ce type"}
      />
      <Metric
        label="Au moins le double de la mise"
        value={percent.format(rates.atLeastDoubleRate)}
        detail="Prix adjugé supérieur ou égal à 2×"
      />
    </dl>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <dd className={styles.metricDetail}>{detail}</dd>
    </div>
  );
}
function MissingMetric() {
  return <span title="Médiane non disponible dans la publication contrôlée">—</span>;
}

function DistributionChart({ distribution }: { distribution: AdjudicationDistribution }) {
  const detailed = distribution.detailedBidDistribution;
  const orderedBands = detailed ? detailedBidBands : bidBands;
  const bins = detailed ?? distribution.bidDistribution;
  const labels = { ...bidBandLabels, ...detailedBidBandLabels };
  return (
    <>
      <div
        className={styles.distribution}
        role="list"
        aria-label={`Répartition de ${distribution.sampleSize} adjudications`}
      >
        {orderedBands.map((band) => {
          const bin = bins.find((item) => item.band === band)!;
          return (
            <div key={band} role="listitem" className={styles.distributionRow}>
              <span>{labels[band]}</span>
              <div className={styles.track} aria-hidden>
                <div style={{ width: `${bin.share * 100}%` }} />
              </div>
              <strong>{percent.format(bin.share)}</strong>
              <span className={styles.binCount}>{integer.format(bin.count)} ventes</span>
            </div>
          );
        })}
      </div>
      <p className={styles.footnote}>
        Base : {integer.format(distribution.sampleSize)} résultats. Les pourcentages arrondis
        peuvent ne pas totaliser exactement 100 %.{" "}
        {!detailed
          ? "Les résultats à partir de 2× sont regroupés dans la publication disponible."
          : ""}
      </p>
    </>
  );
}

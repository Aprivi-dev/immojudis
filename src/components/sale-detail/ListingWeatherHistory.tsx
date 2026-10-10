"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { authHeaders, readJson } from "@/lib/client-api-core";
import type { ClimateHistory, ClimateResult, ClimateStationRef } from "@/lib/environment-reference";
import styles from "./ListingEnvironment.module.css";
import { queryKeys } from "@/lib/query-keys";

export function ListingWeatherHistory({
  saleId,
  enabled,
  locked = false,
}: {
  saleId: string;
  enabled: boolean;
  locked?: boolean;
}) {
  const query = useQuery({
    queryKey: queryKeys.saleWeather(saleId),
    queryFn: async ({ signal }) =>
      readJson<{ weather: ClimateResult }>(
        await fetch(`/api/sales/${encodeURIComponent(saleId)}/weather`, {
          headers: await authHeaders(),
          signal,
        }),
      ),
    enabled: enabled && !locked,
    staleTime: 24 * 60 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  if (locked) {
    return (
      <section className={styles.section} aria-labelledby="weather-history-title">
        <h2 id="weather-history-title" className={styles.heading}>
          Historique météo
        </h2>
        <p className={styles.note}>
          Températures, précipitations et ensoleillement mesurés mois par mois par la station
          Météo-France la plus proche, comparés à la moyenne des dernières années. Inclus dans
          l’offre Analyse.
        </p>
        <Link href="/offres">Découvrir l’historique météo avec l’offre Analyse</Link>
      </section>
    );
  }
  if (!enabled) return null;
  const weather = query.data?.weather;
  return (
    <section className={styles.section} aria-labelledby="weather-history-title">
      <h2 id="weather-history-title" className={styles.heading}>
        Historique météo
      </h2>
      {query.isPending ? <p role="status">Chargement des relevés Météo-France…</p> : null}
      {weather?.status === "ready" ? <ClimateHistoryView weather={weather} /> : null}
      {query.isError ? (
        <p role="status">L’historique météo n’a pas pu être chargé. Réessayez dans un instant.</p>
      ) : null}
      {weather?.status === "unavailable" ? (
        <p role="status" className={styles.note}>
          {weather.reason === "no_station_nearby"
            ? "Aucune station Météo-France ne publie de relevés complets à proximité de ce bien."
            : "La localisation de ce bien ne permet pas encore de choisir une station Météo-France."}
        </p>
      ) : null}
    </section>
  );
}

export function ClimateHistoryView({ weather }: { weather: ClimateHistory }) {
  const hasSunshine = weather.months.some((month) => month.sunshineHours != null);
  const normalLabel = weather.normalPeriod
    ? `moyenne ${weather.normalPeriod.startYear}-${weather.normalPeriod.endYear}`
    : null;
  return (
    <div className={styles.content}>
      <p className={styles.note}>
        Relevés de l’année {weather.year}
        {normalLabel ? `, comparés à la ${normalLabel}` : ""}.
        {weather.locationSource === "commune"
          ? " Station choisie à partir du centre de la commune."
          : ""}
      </p>
      <dl className={styles.facts}>
        <SummaryFact
          label="Température moyenne"
          value={weather.summary.meanTemperatureC}
          normal={weather.normal.meanTemperatureC}
          unit="°C"
        />
        <SummaryFact
          label="Cumul de pluie"
          value={weather.summary.precipitationMm}
          normal={weather.normal.precipitationMm}
          unit="mm"
        />
        {hasSunshine ? (
          <SummaryFact
            label="Ensoleillement"
            value={weather.summary.sunshineHours}
            normal={weather.normal.sunshineHours}
            unit="h"
          />
        ) : null}
        <SummaryFact
          label="Jours de gel"
          value={weather.summary.frostDays}
          normal={weather.normal.frostDays}
          unit="j"
        />
        <SummaryFact
          label="Jours à 30 °C ou plus"
          value={weather.summary.hotDays}
          normal={weather.normal.hotDays}
          unit="j"
        />
      </dl>
      <div
        className={styles.tableWrap}
        role="region"
        aria-label={`Relevés météo mensuels de ${weather.year}`}
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption className="sr-only">Relevés mensuels Météo-France, année {weather.year}</caption>
          <thead>
            <tr>
              <th scope="col">Mois</th>
              <th scope="col">Temp. moy.</th>
              <th scope="col">Min / max</th>
              <th scope="col">Pluie</th>
              {hasSunshine ? <th scope="col">Soleil</th> : null}
            </tr>
          </thead>
          <tbody>
            {weather.months.map((month) => (
              <tr key={month.month}>
                <th scope="row">
                  {new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(
                    new Date(Date.UTC(weather.year, month.month - 1, 15)),
                  )}
                </th>
                <td>
                  {formatMetric(month.meanTemperatureC, "°C")}
                  <Normal value={month.normalTemperatureC} unit="°C" />
                </td>
                <td>
                  {formatMetric(month.meanMinTemperatureC, "°")} /{" "}
                  {formatMetric(month.meanMaxTemperatureC, "°")}
                </td>
                <td>
                  {formatMetric(month.precipitationMm, "mm")}
                  <Normal value={month.normalPrecipitationMm} unit="mm" />
                </td>
                {hasSunshine ? (
                  <td>
                    {formatMetric(month.sunshineHours, "h")}
                    <Normal value={month.normalSunshineHours} unit="h" />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        — : mesure non publiée ou incomplète ce mois-là.
        {normalLabel ? ` Entre parenthèses : ${normalLabel}.` : ""} Les températures min / max sont
        les moyennes des minimales et des maximales quotidiennes.
      </p>
      <StationsNote stations={weather.stations} />
      <p className={styles.note}>
        Source :{" "}
        <a href={weather.sourceUrl} target="_blank" rel="noopener noreferrer">
          Météo-France, données climatologiques de base mensuelles
        </a>{" "}
        (Licence Ouverte Etalab 2.0).
      </p>
    </div>
  );
}

function SummaryFact({
  label,
  value,
  normal,
  unit,
}: {
  label: string;
  value: number | null;
  normal: number | null;
  unit: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {formatMetric(value, unit)}
        {normal != null ? <span> · moyenne {formatMetric(normal, unit)}</span> : null}
      </dd>
    </div>
  );
}

function Normal({ value, unit }: { value: number | null; unit: string }) {
  return value == null ? null : (
    <span className={styles.normal}> ({formatMetric(value, unit)})</span>
  );
}

function StationsNote({ stations }: { stations: ClimateHistory["stations"] }) {
  const entries: { label: string; station: ClimateStationRef }[] = [];
  const seen = new Map<string, string[]>();
  for (const [label, station] of [
    ["températures", stations.temperature],
    ["pluie", stations.precipitation],
    ["ensoleillement", stations.sunshine],
  ] as const) {
    if (!station) continue;
    const labels = seen.get(station.id);
    if (labels) labels.push(label);
    else {
      seen.set(station.id, [label]);
      entries.push({ label, station });
    }
  }
  return (
    <ul className={styles.list}>
      {entries.map(({ station }) => (
        <li key={station.id}>
          Station {station.name}, à {station.distanceKm} km
          {station.altitudeM != null ? `, altitude ${station.altitudeM} m` : ""} :{" "}
          {seen.get(station.id)!.join(", ")}.
        </li>
      ))}
    </ul>
  );
}

export function formatMetric(value: number | null, unit: string) {
  return value == null
    ? "—"
    : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

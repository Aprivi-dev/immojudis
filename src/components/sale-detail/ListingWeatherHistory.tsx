"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { authHeaders, readJson } from "@/lib/client-api-core";
import type { MeteostatResult, MeteostatWeather } from "@/lib/meteostat";
import styles from "./ListingEnvironment.module.css";

export function ListingWeatherHistory({
  saleId,
  enabled,
  locked = false,
}: {
  saleId: string;
  enabled: boolean;
  locked?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    queryKey: ["sale-weather", saleId],
    queryFn: async ({ signal }) =>
      readJson<{ weather: MeteostatResult }>(
        await fetch(`/api/sales/${encodeURIComponent(saleId)}/weather`, {
          headers: await authHeaders(),
          signal,
        }),
      ),
    enabled: enabled && !locked && opened,
    staleTime: 24 * 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (locked) {
    return (
      <section className={styles.section} aria-labelledby="weather-history-title">
        <h2 id="weather-history-title" className={styles.heading}>
          Historique météo
        </h2>
        <p className={styles.note}>
          Températures, précipitations et soleil observé mois par mois dans ce secteur. Inclus dans
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
      <p className={styles.note}>Les observations mensuelles du secteur, fournies par Meteostat.</p>
      <details
        className={styles.disclosure}
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>Consulter l’historique mensuel</summary>
        {opened ? (
          <div className={styles.content}>
            {query.isFetching && !weather ? (
              <p role="status">Chargement des observations météo…</p>
            ) : null}
            {weather?.status === "ready" ? <MeteostatMonthlyTable weather={weather} /> : null}
            {!query.isFetching && (query.isError || weather?.status === "unavailable") ? (
              <p role="status">L’historique météo de ce secteur est momentanément indisponible.</p>
            ) : null}
          </div>
        ) : null}
      </details>
    </section>
  );
}

export function MeteostatMonthlyTable({ weather }: { weather: MeteostatWeather }) {
  const hasSunshine = weather.months.some((month) => month.sunshineMinutes != null);
  return (
    <>
      <p className={styles.note}>
        Année {weather.year} · {weather.coverage.observedMonths} mois disponibles sur 12. Données du
        secteur géographique, pouvant inclure des estimations du fournisseur.
      </p>
      <div
        className={styles.tableWrap}
        role="region"
        aria-label={`Observations météo de ${weather.year}`}
        tabIndex={0}
      >
        <table className={styles.table}>
          <caption className="sr-only">Historique mensuel Meteostat, année {weather.year}</caption>
          <thead>
            <tr>
              <th scope="col">Mois</th>
              <th scope="col">Temp. moyenne</th>
              <th scope="col">Précipitations</th>
              {hasSunshine ? <th scope="col">Soleil observé</th> : null}
            </tr>
          </thead>
          <tbody>
            {weather.months.map((month) => (
              <tr key={month.month}>
                <th scope="row">
                  {new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(
                    new Date(`${month.month}-01T12:00:00Z`),
                  )}
                </th>
                <td>{formatMetric(month.averageTemperatureC, "°C")}</td>
                <td>{formatMetric(month.precipitationMm, "mm")}</td>
                {hasSunshine ? (
                  <td>
                    {formatMetric(
                      month.sunshineMinutes == null ? null : month.sunshineMinutes / 60,
                      "h",
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        — : donnée non disponible.
        {hasSunshine
          ? " Le soleil observé décrit la météo du secteur, pas l’exposition du logement."
          : ""}
        {weather.stale
          ? " Dernières observations conservées ; actualisation temporairement indisponible."
          : ""}
      </p>
      <p className={styles.note}>
        Source :{" "}
        <a href="https://meteostat.net/" target="_blank" rel="noopener noreferrer">
          Meteostat
        </a>
        {" et ses "}
        <a href="https://dev.meteostat.net/providers" target="_blank" rel="noopener noreferrer">
          fournisseurs de données
        </a>
        .
      </p>
      <a href="https://dev.meteostat.net/license" target="_blank" rel="noopener noreferrer">
        Données sous licence CC BY 4.0
      </a>
    </>
  );
}

function formatMetric(value: number | null, unit: string) {
  return value == null
    ? "—"
    : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

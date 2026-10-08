"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { climaScoreWidgetDocument, type ClimaScoreCommune } from "@/lib/climascore";
import styles from "./ListingEnvironment.module.css";

export function ClimaScoreWidget({
  city,
  postalCode,
}: {
  city: string | null;
  postalCode: string | null;
}) {
  const [opened, setOpened] = useState(false);
  const query = useQuery({
    queryKey: ["climascore-commune", city, postalCode],
    queryFn: async ({ signal }): Promise<ClimaScoreCommune | null> => {
      const params = new URLSearchParams({ city: city!, postalCode: postalCode! });
      const response = await fetch(`/api/climascore/commune?${params}`, { signal });
      if (!response.ok) throw new Error("Commune unavailable");
      return ((await response.json()) as { commune: ClimaScoreCommune | null }).commune;
    },
    enabled: opened && Boolean(city?.trim() && /^\d{5}$/.test(postalCode ?? "")),
    staleTime: 7 * 86400_000,
    retry: false,
  });
  if (!city?.trim() || !/^\d{5}$/.test(postalCode ?? "")) return null;
  const document = query.data ? climaScoreWidgetDocument(query.data.code) : null;
  return (
    <details
      className={styles.disclosure}
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>
        Risques climatiques de la commune <span>ClimaScore</span>
      </summary>
      {opened ? (
        <div className={styles.content}>
          <p className={styles.note}>
            Évaluation de la commune de {query.data?.name ?? city}. Elle ne mesure pas le risque
            propre à ce bâtiment et ne remplace pas l’état des risques du dossier.
          </p>
          {query.isFetching ? <p role="status">Chargement de l’évaluation communale…</p> : null}
          {document ? (
            <iframe
              title={`ClimaScore — commune de ${query.data!.name}`}
              srcDoc={document}
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              className={styles.widget}
            />
          ) : null}
          {!query.isFetching && !document ? (
            <p role="status">L’évaluation de cette commune n’est pas disponible pour le moment.</p>
          ) : null}
          <a
            href={
              query.data
                ? `https://climascore.fr/risques/${query.data.code}`
                : "https://climascore.fr/"
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            Source : ClimaScore · consulter l’analyse
          </a>
        </div>
      ) : null}
    </details>
  );
}

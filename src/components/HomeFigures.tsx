import Link from "next/link";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { formatNumber } from "@/lib/format";
import type { HomeCatalogueSummary } from "@/lib/home-catalogue-summary.server";
import { notaryAndStatePilotsEnabled } from "@/lib/sale-types";
import styles from "./HomeFigures.module.css";

const VERIFIED_DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Paris",
});

type Figure = { value: string; label: string };

/**
 * Les chiffres de la bande, tous calculés sur nos données (voir `loadHomeCatalogueSummary` et
 * `loadHomeTribunalCount`). Un chiffre inconnu est retiré, jamais remplacé par une valeur de repli.
 */
export function homeFigures(
  summary: HomeCatalogueSummary | null,
  tribunalCount: number | null,
): Figure[] {
  const figures: Figure[] = [];
  if (summary) {
    figures.push({
      value: formatNumber(summary.count),
      label: summary.count > 1 ? "ventes à venir" : "vente à venir",
    });
  }
  if (tribunalCount) {
    figures.push({
      value: formatNumber(tribunalCount),
      label:
        tribunalCount > 1
          ? "tribunaux avec des ventes à venir"
          : "tribunal avec des ventes à venir",
    });
  }
  const date = summary?.verifiedAt ? new Date(summary.verifiedAt) : null;
  if (date && Number.isFinite(date.getTime())) {
    figures.push({
      value: VERIFIED_DATE_FORMAT.format(date),
      label: "dernière vérification des données",
    });
  }
  return figures;
}

export function HomeFigures({
  summary = null,
  tribunalCount = null,
}: {
  summary?: HomeCatalogueSummary | null;
  tribunalCount?: number | null;
}) {
  const figures = homeFigures(summary, tribunalCount);
  return (
    <section className={styles.band} aria-labelledby="home-figures-title">
      <div className={styles.container}>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>Nos données</p>
          <h2 id="home-figures-title">
            Nous lisons les annonces <em>pour vous.</em>
          </h2>
          <div className={styles.headingAside}>
            <p className={styles.intro}>
              {notaryAndStatePilotsEnabled()
                ? "Annonces des tribunaux, des notaires et de l’État, pièces de la vente et prix du marché : rassemblés au même endroit, avec leur origine."
                : "Annonces des tribunaux, pièces de la vente et prix du marché : rassemblés au même endroit, avec leur origine."}
            </p>
            <Link className={styles.link} href="/tribunaux">
              Voir les ventes par tribunal <ArrowRight aria-hidden="true" size={17} />
            </Link>
          </div>
        </div>
        {figures.length > 0 ? (
          <dl className={styles.figures}>
            {figures.map((figure) => (
              <div key={figure.label}>
                <dt>{figure.label}</dt>
                <dd>{figure.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

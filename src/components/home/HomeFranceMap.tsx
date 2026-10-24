import Link from "next/link";
import type { CSSProperties } from "react";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { formatNumber, formatPrice } from "@/lib/format";
import {
  FRANCE_MAP_HEIGHT,
  FRANCE_MAP_WIDTH,
  FRANCE_OUTLINE_PATH,
  projectOnFranceMap,
} from "@/lib/home-france-map";
import type { HomeSalesMapCell } from "@/lib/home-sales-map.server";
import styles from "./HomePage.module.css";

const EXAMPLE_FIGURES = exampleHeadlineFigures();
/** La fiche d'exemple se pose sur Bordeaux, ville de l'annonce exemple. */
const BORDEAUX = projectOnFranceMap(44.84, -0.58);
/** Les cases les plus fournies portent un halo qui pulse. */
const PULSING_CELLS = 6;
/** Les points apparaissent l'un après l'autre, en 1,6 s au plus. */
const POP_STEP_MS = 9;
const POP_MAX_MS = 1_600;

function dotRadius(count: number): number {
  return Math.round(Math.min(9, 2.4 + Math.sqrt(count) * 1.25) * 10) / 10;
}

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(2)}%`;
}

/**
 * Carte de France du premier écran : le contour se dessine, puis les ventes à venir apparaissent par
 * secteur (les plus fournis d'abord) et la fiche de l'annonce exemple se pose sur Bordeaux. Tout est
 * en CSS ; avec « réduire les animations », la carte s'affiche d'emblée.
 */
export function HomeFranceMap({
  cells,
  total,
}: {
  cells: HomeSalesMapCell[];
  total: number | null;
}) {
  const label = cells.length
    ? `Carte de France métropolitaine : ${
        total ? `les ${formatNumber(total)} ventes à venir` : "les ventes à venir"
      }, regroupées par secteur.`
    : "Carte de France métropolitaine.";
  return (
    <figure className={styles.map}>
      <svg
        className={styles.mapSvg}
        viewBox={`0 0 ${FRANCE_MAP_WIDTH} ${FRANCE_MAP_HEIGHT}`}
        role="img"
        aria-label={label}
      >
        <path className={styles.land} d={FRANCE_OUTLINE_PATH} pathLength={1} />
        {cells.map((cell, index) => {
          const radius = dotRadius(cell.count);
          const delay = {
            "--d": `${Math.min(POP_MAX_MS, index * POP_STEP_MS)}ms`,
          } as CSSProperties;
          return (
            <g key={`${cell.x}:${cell.y}`} style={delay}>
              {index < PULSING_CELLS ? (
                <circle className={styles.ring} cx={cell.x} cy={cell.y} r={radius} />
              ) : null}
              <circle className={styles.pin} cx={cell.x} cy={cell.y} r={radius} />
            </g>
          );
        })}
      </svg>
      <Link
        href="/annonce-exemple"
        prefetch={false}
        className={styles.peek}
        style={
          {
            "--x": percent(BORDEAUX.x, FRANCE_MAP_WIDTH),
            "--y": percent(BORDEAUX.y, FRANCE_MAP_HEIGHT),
          } as CSSProperties
        }
      >
        <span className={styles.peekTag}>Exemple fictif</span>
        <span className={styles.peekMeta}>Vente au tribunal · Gironde (33)</span>
        <span className={styles.peekTitle}>
          Appartement de {EXAMPLE_FIGURES.surfaceM2} m² à {EXAMPLE_FIGURES.city}
        </span>
        <span className={styles.peekPrice}>
          <span>Mise à prix</span>
          <strong>{formatPrice(EXAMPLE_FIGURES.startingPrice)}</strong>
        </span>
      </Link>
      <figcaption className={styles.mapCaption}>
        {cells.length ? "Ventes à venir, regroupées par secteur. " : ""}Contour : IGN, Admin
        Express.
      </figcaption>
    </figure>
  );
}

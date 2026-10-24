import Link from "next/link";
import type { CSSProperties } from "react";
import { exampleHeadlineFigures } from "@/lib/example-sale";
import { formatPrice } from "@/lib/format";
import {
  FRANCE_MAP_DOTS,
  FRANCE_MAP_HEIGHT,
  FRANCE_MAP_WIDTH,
  FRANCE_OUTLINE_PATH,
  projectOnFranceMap,
} from "@/lib/home-france-map";
import styles from "./HomePage.module.css";

const EXAMPLE_FIGURES = exampleHeadlineFigures();
/** La fiche d'exemple se pose sur Bordeaux, ville de l'annonce exemple. */
const BORDEAUX = projectOnFranceMap(44.84, -0.58);
const DOT_RADIUS = { 1: 2.6, 2: 3.8, 3: 5.2 } as const;
/** Un petit point sur neuf s'allume en or de temps en temps, comme une nouvelle vente. */
const FRESH_EVERY = 9;

/**
 * Chaque point, avec son rôle : les grandes villes portent un halo qui pulse (`order` décale les
 * halos entre eux), quelques petits points s'allument (`order` décale aussi leurs cycles).
 */
const DOTS = (() => {
  let small = 0;
  let large = 0;
  return FRANCE_MAP_DOTS.map(([x, y, size, delay]) => {
    if (size === 3) return { x, y, size, delay, halo: true, fresh: false, order: large++ };
    const index = size === 1 ? small++ : -1;
    const fresh = index >= 0 && index % FRESH_EVERY === 4;
    return { x, y, size, delay, halo: false, fresh, order: fresh ? index / FRESH_EVERY : 0 };
  });
})();

function percent(value: number, total: number): string {
  return `${((value / total) * 100).toFixed(2)}%`;
}

/**
 * Carte de France du premier écran, en illustration : le contour se trace, des points apparaissent
 * en vague depuis Paris, puis la carte vit (halos sur les grandes villes, points qui s'allument) et
 * la fiche de l'annonce exemple se pose sur Bordeaux. Les points sont fictifs et le disent. Tout est
 * en CSS ; avec « réduire les animations », la carte s'affiche d'emblée, immobile.
 */
export function HomeFranceMap() {
  return (
    <figure className={styles.map}>
      <svg
        className={styles.mapSvg}
        viewBox={`0 0 ${FRANCE_MAP_WIDTH} ${FRANCE_MAP_HEIGHT}`}
        role="img"
        aria-label="Illustration : carte de France parsemée de ventes aux enchères (points fictifs)."
      >
        <path className={styles.land} d={FRANCE_OUTLINE_PATH} pathLength={1} />
        {DOTS.map((dot) => (
          <g
            key={`${dot.x}:${dot.y}`}
            style={{ "--d": `${dot.delay}ms`, "--k": dot.order } as CSSProperties}
          >
            {dot.halo ? (
              <circle className={styles.ring} cx={dot.x} cy={dot.y} r={DOT_RADIUS[dot.size]} />
            ) : null}
            <circle
              className={dot.fresh ? `${styles.pin} ${styles.fresh}` : styles.pin}
              cx={dot.x}
              cy={dot.y}
              r={DOT_RADIUS[dot.size]}
            />
          </g>
        ))}
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
        Illustration, points fictifs. Contour : IGN, Admin Express.
      </figcaption>
    </figure>
  );
}

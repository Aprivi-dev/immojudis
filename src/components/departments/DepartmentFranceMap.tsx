import type { CSSProperties } from "react";
import {
  DEPARTMENT_CENTROIDS,
  FRANCE_MAP_EMPTY_RADIUS,
  FRANCE_MAP_HEIGHT,
  FRANCE_MAP_INSET,
  FRANCE_MAP_INSET_DEPARTMENTS,
  FRANCE_MAP_WIDTH,
  franceMapLegendValues,
  franceMapRadius,
  projectInFranceMapInset,
  projectOnFranceMap,
} from "@/lib/department-geography";
import { cn } from "@/lib/utils";

export type DepartmentMapEntry = { code: string; name: string; path: string; count: number };

const count = new Intl.NumberFormat("fr-FR");

function salesPhrase(total: number): string {
  if (total === 0) return "aucune vente à venir";
  return `${count.format(total)} ${total > 1 ? "ventes" : "vente"} à venir`;
}

/** Position en pourcentage du cadre de la carte. */
function at(x: number, y: number): CSSProperties {
  return { left: `${(x / FRANCE_MAP_WIDTH) * 100}%`, top: `${(y / FRANCE_MAP_HEIGHT) * 100}%` };
}

/** Longueur en unités de carte, à l'échelle du cadre (un conteneur de requêtes : `cqw`). */
function mapUnits(value: number): string {
  return `calc(${value.toFixed(2)} * 100cqw / ${FRANCE_MAP_WIDTH})`;
}

/**
 * Carte de France des ventes à venir : un rond par département de métropole, posé sur le centre
 * officiel du département (`DEPARTMENT_CENTROIDS`), d'aire proportionnelle au nombre de ventes ; un
 * rond vide pour un département sans vente. Paris et la petite couronne sont agrandis dans un
 * médaillon. Chaque rond est un lien vers la page du département, avec une info-bulle au survol et
 * au focus. Tout est rendu par le serveur, en HTML et CSS (aucun JavaScript) : les ronds sont posés
 * en pourcentage du cadre et dimensionnés en unités de conteneur. La carte complète la liste, qui
 * reste la référence (l'outre-mer n'est que dans la liste).
 */
export function DepartmentFranceMap({
  departments,
}: {
  departments: readonly DepartmentMapEntry[];
}) {
  const placed = departments.filter((department) => DEPARTMENT_CENTROIDS[department.code]);
  const maxCount = Math.max(0, ...placed.map((department) => department.count));
  const dots = placed
    .map((department) => {
      const [lat, lon] = DEPARTMENT_CENTROIDS[department.code];
      const inset = FRANCE_MAP_INSET_DEPARTMENTS.has(department.code);
      const point = inset ? projectInFranceMapInset(lat, lon) : projectOnFranceMap(lat, lon);
      const radius = franceMapRadius(department.count, maxCount);
      return { ...department, ...point, inset, radius };
    })
    // Les plus grands ronds d'abord : les petits restent visibles par-dessus.
    .sort(
      (a, b) =>
        (b.radius ?? FRANCE_MAP_EMPTY_RADIUS) - (a.radius ?? FRANCE_MAP_EMPTY_RADIUS) ||
        a.code.localeCompare(b.code),
    );
  const paris = DEPARTMENT_CENTROIDS["75"];
  const parisMark = projectOnFranceMap(paris[0], paris[1]);
  const legend = franceMapLegendValues(maxCount);
  const inset = FRANCE_MAP_INSET;
  const emptySize = `max(8px, ${mapUnits(2 * FRANCE_MAP_EMPTY_RADIUS)})`;

  return (
    <div className="@container mt-3">
      <div
        role="group"
        aria-label="Carte de France du nombre de ventes à venir par département. La liste détaillée des départements suit la carte."
        className="relative aspect-[1060/1000] w-full"
      >
        <div
          aria-hidden
          className="absolute rounded-lg border border-line bg-surface-muted"
          style={{
            ...at(inset.x, inset.y),
            width: `${(inset.width / FRANCE_MAP_WIDTH) * 100}%`,
            height: `${(inset.height / FRANCE_MAP_HEIGHT) * 100}%`,
          }}
        >
          <span className="absolute top-2 right-3 left-3 text-xs leading-tight font-bold text-ink-strong @max-lg:hidden">
            Paris et petite couronne
          </span>
        </div>
        <span
          aria-hidden
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-dashed border-line"
          style={{ ...at(parisMark.x, parisMark.y), width: mapUnits(28), height: mapUnits(24) }}
        />
        {dots.map((dot) => {
          const phrase = salesPhrase(dot.count);
          const size = dot.radius ? mapUnits(2 * dot.radius) : emptySize;
          return (
            <a
              key={dot.code}
              href={dot.path}
              data-code={dot.code}
              aria-label={`${dot.name} (${dot.code}) : ${phrase}`}
              className="group absolute -translate-x-1/2 -translate-y-1/2 rounded-full outline-none hover:z-20 focus-visible:z-20"
              style={{ ...at(dot.x, dot.y), width: size, height: size }}
            >
              <span
                aria-hidden
                className={cn(
                  "block size-full rounded-full transition-colors motion-reduce:transition-none",
                  dot.radius
                    ? "border border-white bg-brand-navy/85 group-hover:bg-gold group-focus-visible:bg-gold group-focus-visible:ring-2 group-focus-visible:ring-brand-navy"
                    : "border-2 border-line bg-white group-hover:border-gold group-focus-visible:border-gold group-focus-visible:ring-2 group-focus-visible:ring-brand-navy",
                )}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 rounded-md bg-brand-navy px-2.5 py-1.5 text-caption font-semibold whitespace-nowrap text-white shadow-lg group-hover:block group-focus-visible:block"
              >
                {dot.name} ({dot.code}) · {phrase}
              </span>
              {dot.inset && dot.radius ? (
                <span
                  aria-hidden
                  className="absolute top-full left-1/2 -translate-x-1/2 text-xs font-semibold text-ink-strong tabular-nums @max-lg:hidden"
                >
                  {dot.code}
                </span>
              ) : null}
            </a>
          );
        })}
      </div>
      <div
        aria-hidden
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-ink-soft"
      >
        {legend.map((value) => {
          const size = mapUnits(2 * (franceMapRadius(value, maxCount) ?? 0));
          return (
            <span key={value} className="inline-flex items-center gap-2">
              <i
                className="inline-block rounded-full bg-brand-navy/85"
                style={{ width: size, height: size }}
              />
              {value === 1 ? "1 vente" : `${count.format(value)} ventes`}
            </span>
          );
        })}
        <span className="inline-flex items-center gap-2">
          <i
            className="inline-block rounded-full border-2 border-line bg-white"
            style={{ width: emptySize, height: emptySize }}
          />
          Aucune vente à venir
        </span>
        {/* Carte étroite : le titre du médaillon ne tient pas dans le cadre, il passe en légende. */}
        <span className="@lg:hidden">Encadré : Paris et petite couronne, agrandis</span>
      </div>
    </div>
  );
}

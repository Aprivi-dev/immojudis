import {
  BRAND_BODY_PATH,
  BRAND_ROOF_DOT_RADIUS,
  BRAND_ROOF_DOTS,
  BRAND_TILE_PATH,
} from "@/lib/brand-mark";
import { cn } from "@/lib/utils";

/**
 * Le pictogramme de la marque : le temple du favicon (`public/brand/immojudis-justice-temple.svg`,
 * même tuile, même corps ; couleurs par les jetons du site : tuile bordeaux `brand-navy-soft`,
 * temple ivoire `surface`, qui valent celles du fichier), avec le fronton en points
 * (`@/lib/brand-mark`). Le même dessin sert à l'en-tête, au pied de page, aux icônes d'application
 * et à l'image de partage ; seul le favicon garde le fronton plein. Il ne prend pas la teinte du
 * texte voisin (`currentColor`).
 *
 * `decorative` : le pictogramme n'ajoute rien au texte voisin (écran d'attente, page d'erreur) ; il
 * est alors masqué aux lecteurs d'écran au lieu d'être annoncé comme une image « Immojudis ».
 */
export function BrandMark({
  className,
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "Immojudis" })}
      className={cn("shrink-0", className)}
    >
      <path d={BRAND_TILE_PATH} className="fill-brand-navy-soft" />
      <g className="fill-surface">
        {BRAND_ROOF_DOTS.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={BRAND_ROOF_DOT_RADIUS} />
        ))}
        <path d={BRAND_BODY_PATH} />
      </g>
    </svg>
  );
}

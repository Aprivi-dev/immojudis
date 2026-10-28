import { cn } from "@/lib/utils";

/**
 * Le pictogramme de la marque : le temple du favicon, des icônes d'application et du manifeste
 * (`public/brand/immojudis-justice-temple.svg`, mêmes tracés ; couleurs par les jetons du site :
 * marine `brand-navy`, or `gold`, fond crème `surface`, qui valent celles du fichier). Un seul
 * pictogramme pour l'en-tête, le pied de page, le favicon et les données structurées. Il ne prend
 * pas la teinte du texte voisin (`currentColor`).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      role="img"
      aria-label="Immojudis"
      className={cn("shrink-0", className)}
    >
      <rect width="256" height="256" rx="52" className="fill-surface" />
      <path
        d="M38 101h180L128 42 38 101Z"
        fill="none"
        className="stroke-brand-navy"
        strokeWidth="18"
        strokeLinejoin="round"
      />
      <path
        d="M58 202h140M74 101v82M112 101v82M150 101v82M188 101v82"
        fill="none"
        className="stroke-brand-navy"
        strokeWidth="18"
        strokeLinecap="round"
      />
      <path
        d="M38 216h180"
        fill="none"
        className="stroke-gold"
        strokeWidth="18"
        strokeLinecap="round"
      />
    </svg>
  );
}

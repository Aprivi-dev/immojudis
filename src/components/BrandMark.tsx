import { cn } from "@/lib/utils";

/**
 * Le pictogramme de la marque : le temple du favicon, des icônes d'application et du manifeste
 * (`public/brand/immojudis-justice-temple.svg`, mêmes tracés et mêmes couleurs : marine, or, fond
 * crème). Un seul pictogramme pour l'en-tête, le pied de page, le favicon et les données
 * structurées. Les couleurs sont celles de la marque, pas `currentColor` : il ne change pas de
 * teinte selon le texte voisin.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 256"
      role="img"
      aria-label="Immojudis"
      className={cn("shrink-0", className)}
    >
      <rect width="256" height="256" rx="52" fill="#fffaf2" />
      <path
        d="M38 101h180L128 42 38 101Z"
        fill="none"
        stroke="#132238"
        strokeWidth="18"
        strokeLinejoin="round"
      />
      <path
        d="M58 202h140M74 101v82M112 101v82M150 101v82M188 101v82"
        fill="none"
        stroke="#132238"
        strokeWidth="18"
        strokeLinecap="round"
      />
      <path d="M38 216h180" fill="none" stroke="#c98d45" strokeWidth="18" strokeLinecap="round" />
    </svg>
  );
}

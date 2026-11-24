import { cn } from "@/lib/utils";

/**
 * Le pictogramme de la marque : le fronton du favicon, des icônes d'application et du manifeste
 * (`public/brand/immojudis-justice-temple.svg`, mêmes tracés ; couleurs par les jetons du site :
 * tuile bordeaux `brand-navy-soft`, fronton ivoire `surface`, qui valent celles du fichier). Un seul
 * pictogramme pour l'en-tête, le pied de page, le favicon et les données structurées. Il ne prend
 * pas la teinte du texte voisin (`currentColor`).
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
      <path
        d="M14 0h36a14 14 0 0 1 14 14v36a14 14 0 0 1-14 14H14A14 14 0 0 1 0 50V14A14 14 0 0 1 14 0Z"
        className="fill-brand-navy-soft"
      />
      <path
        d="M32 15.47 51.41 27.69H12.59ZM14.75 29.84h34.5v2.16h-34.5ZM17.62 34.16h5.75v10.78h-5.75ZM29.12 34.16h5.75v10.78h-5.75ZM40.62 34.16h5.75v10.78h-5.75ZM12.59 47.09h38.81v3.59h-38.81Z"
        className="fill-surface"
      />
    </svg>
  );
}

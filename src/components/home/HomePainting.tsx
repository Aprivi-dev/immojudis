import Image from "next/image";
import scenes from "./HomeScenes.module.css";

const MEDIA = "/media/landing/accueil";

export type HomePaintingName =
  | "01-hero"
  | "02-pieces"
  | "03-quartier"
  | "04-plafond"
  | "05-alertes"
  | "06-bougies"
  | "07-audience"
  | "08-cle"
  | "09-frise";

/** Adresse de l'image fixe d'une peinture (recadrages en fond d'élément). */
export function homePaintingUrl(name: HomePaintingName): string {
  return `${MEDIA}/${name}.webp`;
}

/**
 * Une peinture de l'accueil : l'image fixe, et par-dessus sa boucle vidéo muette (même cadrage, même
 * première et dernière image). La boucle n'est chargée et lue que par `HomeScrollScenes`, quand la
 * peinture approche de l'écran et que le visiteur n'a pas demandé de réduire les animations ; sans
 * script, l'image fixe suffit. Le parent fixe la taille (l'image remplit le bloc).
 */
export function HomePainting({
  name,
  alt,
  sizes,
  eager = false,
  className,
}: {
  name: HomePaintingName;
  /** Vide quand la peinture est un décor que le texte voisin décrit déjà. */
  alt: string;
  sizes: string;
  /** Peinture du premier écran : chargée tout de suite, en priorité. */
  eager?: boolean;
  className?: string;
}) {
  return (
    <div className={className ? `${scenes.painting} ${className}` : scenes.painting}>
      <Image
        src={homePaintingUrl(name)}
        alt={alt}
        fill
        sizes={sizes}
        quality={85}
        {...(eager ? { loading: "eager", fetchPriority: "high" } : {})}
      />
      <video
        data-home-loop=""
        data-src={`${MEDIA}/${name}.mp4`}
        muted
        loop
        playsInline
        preload="none"
        aria-hidden
        tabIndex={-1}
      />
    </div>
  );
}

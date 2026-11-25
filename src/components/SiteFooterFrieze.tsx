/**
 * Fond du pied de page de l'accueil : la frise peinte, sa boucle vidéo et un voile bordeaux pour
 * la lecture des liens posés dessus. Composant serveur, que le layout passe à `SiteFooter`
 * (composant client monté sur toutes les pages) : il n'ajoute rien au JavaScript initial.
 *
 * L'image est une balise simple chargée à l'approche (`next/image` n'apporterait rien à un décor
 * de bas de page). La vidéo n'a pas d'adresse : `HomeScrollScenes` la pose et la lance comme les
 * autres boucles de l'accueil, sauf si le visiteur réduit les animations.
 */
export function SiteFooterFrieze() {
  return (
    <div aria-hidden className="site-footer-frieze-ground">
      <img src="/media/landing/accueil/09-frise.webp" alt="" loading="lazy" decoding="async" />
      <video
        data-home-loop=""
        data-src="/media/landing/accueil/09-frise.mp4"
        muted
        loop
        playsInline
        preload="none"
        tabIndex={-1}
      />
    </div>
  );
}

/**
 * Squelette générique d'une page. Il sert de `loading.tsx` aux seuls segments qui en ont besoin
 * (catalogue `/sales`, connexion). Il n'y a volontairement pas de `app/loading.tsx` à la
 * racine : sur une page rendue à la demande, une frontière Suspense au-dessus d'un appel à
 * `notFound()` fige le statut HTTP à 200 dès le premier morceau diffusé (c'était le cas de
 * `/comparaisons/<jeton inconnu>`). Ne l'ajouter qu'à des segments sans `notFound()` dynamique ;
 * `/login` en a besoin parce que `useSearchParams()` y exige une frontière Suspense.
 *
 * `cloudBackground={false}` retire l'image des nuages (`cloud-background.webp`, 51 Ko) du fond :
 * `/sales` l'emploie pour ne pas télécharger, sur mobile, une image décorative que le
 * catalogue lui-même n'affiche pas.
 */
export function PageLoadingSkeleton({ cloudBackground = true }: { cloudBackground?: boolean }) {
  return (
    <main
      id="contenu"
      className={`liquid-page${cloudBackground ? "" : " liquid-page-plain"} min-h-screen px-4 py-10 sm:px-6`}
    >
      <div className="mx-auto max-w-6xl">
        <div className="h-8 w-48 animate-pulse rounded-md bg-white/70" />
        <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <div className="h-72 animate-pulse rounded-lg bg-white/70" />
            <div className="h-40 animate-pulse rounded-lg bg-white/70" />
          </div>
          <div className="hidden h-80 animate-pulse rounded-lg bg-white/70 lg:block" />
        </div>
      </div>
    </main>
  );
}

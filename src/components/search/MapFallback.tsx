import MapPin from "lucide-react/dist/esm/icons/map-pin.js";

/**
 * Repli de la carte (jeton absent, Mapbox qui ne démarre pas, module de la carte qui ne se charge
 * pas) : la liste des annonces reste le chemin de secours. « Réessayer » n'est proposé que quand un
 * nouvel essai peut aboutir (réseau coupé, téléchargement interrompu). Fichier à part : il doit
 * s'afficher même quand le module de la carte n'a pas pu être téléchargé (voir `LazyMapPanel`).
 */
export function MapFallback({
  message,
  onShowList,
  onRetry,
}: {
  message: string;
  onShowList?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-surface-tint/80 px-6 text-center">
      <div className="pointer-events-auto max-w-sm rounded-md border border-line bg-white p-5 shadow-lg">
        <MapPin className="mx-auto h-8 w-8 text-brand-navy" />
        <h2 className="mt-3 text-base font-bold text-brand-navy">Carte indisponible</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">{message}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md bg-brand-navy px-4 text-sm font-semibold text-white hover:bg-brand-navy-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            >
              Réessayer
            </button>
          ) : null}
          <a
            href="#sales-results"
            onClick={onShowList}
            className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft ${
              onRetry
                ? "border border-line bg-white text-brand-navy hover:border-brand-navy"
                : "bg-brand-navy text-white hover:bg-brand-navy-soft"
            }`}
          >
            Voir la liste
          </a>
        </div>
      </div>
    </div>
  );
}

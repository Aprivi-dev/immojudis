import Map from "lucide-react/dist/esm/icons/map.js";

/**
 * Aperçu léger de la zone de carte du bureau, affiché tant que Mapbox GL (513 Ko) n'est ni
 * téléchargé ni initialisé. Il occupe exactement le cadre de `MapPanelSkeleton` (même hauteur
 * minimale, même fond) : rien ne bouge quand la carte prend sa place. Aucune requête réseau : un
 * quadrillage en CSS suffit.
 *
 * La carte démarre (`onStart`, appelé autant de fois que l'événement se produit : l'appelant
 * retire l'aperçu au premier appel) au survol ou au focus de cette zone, et au clic sur le
 * bouton « Afficher la carte », qui reste le moyen explicite et accessible de la demander. Les
 * autres gestes (clic, touche, molette, toucher n'importe où) sont écoutés par
 * `useFirstGestureStart`.
 */
export function MapPreview({ onStart }: { onStart: () => void }) {
  return (
    <div
      data-testid="map-preview"
      onPointerEnter={onStart}
      onFocus={onStart}
      className="relative grid h-full min-h-[28rem] place-items-center overflow-hidden bg-surface-tint"
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "linear-gradient(rgb(19 34 56 / 6%) 1px, transparent 1px), linear-gradient(90deg, rgb(19 34 56 / 6%) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div className="relative flex flex-col items-center gap-3 px-6 text-center">
        <button
          type="button"
          onClick={onStart}
          className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-bold text-brand-navy shadow-lg transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          <Map className="h-4 w-4" aria-hidden="true" />
          Afficher la carte
        </button>
        <p className="max-w-56 text-xs font-semibold text-ink-soft">
          Elle s’affiche aussi dès que vous utilisez la page.
        </p>
      </div>
    </div>
  );
}

import Map from "lucide-react/dist/esm/icons/map.js";

/**
 * Aperçu léger de la zone de carte du bureau, affiché tant que Mapbox GL (513 Ko) n'est ni
 * téléchargé ni initialisé. Il occupe exactement le cadre de `MapPanelSkeleton` (même hauteur
 * minimale, même fond) : rien ne bouge quand la carte prend sa place. Aucune requête réseau : un
 * quadrillage en CSS suffit.
 *
 * Chaque chargement de carte Mapbox est facturé : la carte ne démarre que sur un geste fait dans
 * ce cadre, jamais sur un simple survol ni sur un geste ailleurs dans la page.
 * - au clic, à Entrée ou à Espace sur le bouton « Afficher la carte », sans délai
 *   (`onExplicitStart`, ou `onStart` s'il est absent) : c'est le moyen explicite et accessible de
 *   la demander, le seul au clavier. Le focus d'une touche (Tab) ne la démarre pas ;
 * - à l'appui ou à la molette sur le cadre, écoutés par `useFirstGestureStart`.
 */
export function MapPreview({
  onStart,
  onExplicitStart,
}: {
  onStart: () => void;
  onExplicitStart?: () => void;
}) {
  return (
    <div
      data-testid="map-preview"
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
          data-map-explicit-start=""
          onClick={onExplicitStart ?? onStart}
          className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-bold text-brand-navy shadow-lg transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          <Map className="h-4 w-4" aria-hidden="true" />
          Afficher la carte
        </button>
        <p className="max-w-56 text-xs font-semibold text-ink-soft">
          Elle s’affiche aussi quand vous cliquez ou faites défiler la molette sur ce cadre.
        </p>
      </div>
    </div>
  );
}

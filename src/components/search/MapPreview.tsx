import Map from "lucide-react/dist/esm/icons/map.js";
import { useEffect, useRef, type PointerEvent } from "react";
import { runAfterNextPaint } from "./use-first-gesture-start";

/**
 * Survol continu qui vaut demande de carte. Traverser la zone pour aller ailleurs (la souris reste
 * en général quelques dizaines de millisecondes sur le cadre) ne télécharge donc rien ; s'y arrêter
 * 300 ms, si. Un délai plutôt que la suppression du survol : c'est le seul geste de souris
 * volontaire qui ne passe ni par un appui ni par la molette.
 */
export const MAP_HOVER_DELAY_MS = 300;

/**
 * Aperçu léger de la zone de carte du bureau, affiché tant que Mapbox GL (513 Ko) n'est ni
 * téléchargé ni initialisé. Il occupe exactement le cadre de `MapPanelSkeleton` (même hauteur
 * minimale, même fond) : rien ne bouge quand la carte prend sa place. Aucune requête réseau : un
 * quadrillage en CSS suffit.
 *
 * La carte démarre :
 * - au survol continu de cette zone pendant `MAP_HOVER_DELAY_MS` (`onStart`, différé après la
 *   peinture comme tout geste) ;
 * - au clic, à Entrée ou à Espace sur le bouton « Afficher la carte », sans délai
 *   (`onExplicitStart`, ou `onStart` s'il est absent) : c'est le moyen explicite et accessible de
 *   la demander, le seul au clavier. Le focus d'une touche (Tab) ne la démarre pas.
 *
 * Les autres gestes (appui, molette, toucher n'importe où) sont écoutés par `useFirstGestureStart`.
 */
export function MapPreview({
  onStart,
  onExplicitStart,
}: {
  onStart: () => void;
  onExplicitStart?: () => void;
}) {
  const hover = useRef<{ cancel: () => void } | null>(null);

  function stopHover() {
    hover.current?.cancel();
    hover.current = null;
  }
  useEffect(() => {
    const pending = hover;
    return () => pending.current?.cancel();
  }, []);

  function startHover(event: PointerEvent) {
    // Un doigt posé sur l'écran est un geste (`touchstart`), pas un survol.
    if (event.pointerType === "touch" || hover.current) return;
    const state = { cancel: () => {} };
    const timer = setTimeout(() => {
      state.cancel = runAfterNextPaint(onStart);
    }, MAP_HOVER_DELAY_MS);
    state.cancel = () => clearTimeout(timer);
    hover.current = state;
  }

  return (
    <div
      data-testid="map-preview"
      onPointerEnter={startHover}
      onPointerLeave={stopHover}
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
          Elle s’affiche aussi quand vous cliquez ou faites défiler la page, ou arrêtez la souris
          sur ce cadre.
        </p>
      </div>
    </div>
  );
}

"use client";

import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from "react";
import { MapFallback } from "./MapFallback";
import type { MapPanelProps } from "./MapPanel";
import { loadMapPanelModule } from "./preload-map";
import { MapPanelSkeleton } from "./SearchFilters";

/**
 * Nombre de téléchargements du module de la carte : le premier, puis deux « Réessayer ». Un
 * `React.lazy` garde l'échec de son premier essai pour toujours ; chaque essai a donc le sien, créé
 * avec la carte (avec `next/dynamic`, qui n'en crée qu'un, l'échec du chargement du module de la
 * carte remontait jusqu'à la page d'erreur du site : plus de liste, plus de filtres). Tous passent
 * par le même `import()` (`loadMapPanelModule`) : le module n'est pas copié.
 */
const ATTEMPTS = 3;

function createLazyPanels(): ComponentType<MapPanelProps>[] {
  return Array.from({ length: ATTEMPTS }, () =>
    lazy(() => loadMapPanelModule().then((module) => ({ default: module.MapPanel }))),
  );
}

class MapLoadBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * La carte de /sales, chargée à la demande (Mapbox GL pèse 513 Ko). Si son module ne se télécharge
 * pas (réseau coupé), la page reste utilisable : un message, « Réessayer » (trois essais) et
 * « Voir la liste » prennent la place de la carte.
 */
export function LazyMapPanel(props: MapPanelProps) {
  const [attempt, setAttempt] = useState(0);
  const [panels] = useState(createLazyPanels);
  const Panel = panels[attempt];
  return (
    <MapLoadBoundary
      // Un nouvel essai repart d'une frontière saine.
      key={attempt}
      fallback={
        <div className="relative h-full min-h-[28rem] overflow-hidden bg-surface-tint">
          <MapFallback
            message="La carte n’a pas pu s’afficher. Les annonces restent accessibles dans la liste."
            onShowList={props.onShowList}
            onRetry={attempt < ATTEMPTS - 1 ? () => setAttempt((value) => value + 1) : undefined}
          />
        </div>
      }
    >
      <Suspense fallback={<MapPanelSkeleton />}>
        <Panel {...props} />
      </Suspense>
    </MapLoadBoundary>
  );
}

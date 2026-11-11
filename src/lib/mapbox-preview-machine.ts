import { defineMachine } from "@/lib/state-machine";

/**
 * Chargement de l'aperçu Mapbox ouvert depuis une annonce (`MapboxPreviewButton`).
 *
 * - `idle` : fenêtre fermée ;
 * - `unconfigured` : pas de jeton Mapbox ;
 * - `missing` : l'annonce n'a pas de coordonnées ;
 * - `loading` : Mapbox se télécharge puis dessine la carte ;
 * - `ready` : la carte est affichée ;
 * - `error` : le chargement a échoué.
 *
 * Règle que la table porte : une fois la carte affichée (`ready`), une erreur n'y change plus rien.
 * Mapbox émet « error » pour une tuile ou une source en échec alors que la carte fonctionne ; la
 * traiter comme une panne recouvrait une carte utilisable d'un message d'erreur, sans retour possible.
 */
export type MapboxPreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "missing"
  | "error"
  | "unconfigured";

export type MapboxPreviewState = { status: MapboxPreviewStatus };

export type MapboxPreviewEvent =
  | { type: "UNCONFIGURED" }
  | { type: "COORDINATES_MISSING" }
  | { type: "LOAD_STARTED" }
  | { type: "LOADED" }
  | { type: "LOAD_FAILED" }
  | { type: "CLOSED" };

const to = (status: MapboxPreviewStatus) => (): MapboxPreviewState => ({ status });

/** Ce qu'une ouverture (ou un changement d'annonce) peut décider, depuis n'importe quel état. */
const opening = {
  UNCONFIGURED: to("unconfigured"),
  COORDINATES_MISSING: to("missing"),
  LOAD_STARTED: to("loading"),
  CLOSED: to("idle"),
};

export const mapboxPreviewMachine = defineMachine<MapboxPreviewState, MapboxPreviewEvent>(
  { status: "idle" },
  {
    idle: opening,
    unconfigured: opening,
    missing: opening,
    loading: { ...opening, LOADED: to("ready"), LOAD_FAILED: to("error") },
    // Pas de LOAD_FAILED : une erreur après l'affichage laisse la carte à l'écran.
    ready: opening,
    error: opening,
  },
);

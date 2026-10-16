import type { SalesSearchUrlRecord } from "./search-url-state";

/**
 * Affichage des résultats de `/sales` : cartes (par défaut) ou tableau (écran large seulement).
 * Le choix vit dans l'adresse (`?view=table`), à côté des filtres, mais n'entre ni dans
 * `SalesSearchParams` ni dans la clé des requêtes : changer d'affichage ne relance aucune
 * recherche et ne change ni l'export ni les alertes.
 */
export const RESULTS_VIEW_PARAM = "view";

export type ResultsView = "cards" | "table";

/** Toute valeur inconnue ou absente donne les cartes. */
export function parseResultsView(value: string | null | undefined): ResultsView {
  return value === "table" ? "table" : "cards";
}

/** Ajoute le choix d'affichage à une adresse de recherche ; les cartes n'écrivent rien. */
export function withResultsView(
  record: SalesSearchUrlRecord,
  view: ResultsView,
): SalesSearchUrlRecord {
  return { ...record, [RESULTS_VIEW_PARAM]: view === "table" ? "table" : undefined };
}

/** Le tableau n'existe que sur écran large : en dessous, c'est toujours la liste de cartes. */
export function effectiveResultsView(view: ResultsView, isDesktop: boolean): ResultsView {
  return isDesktop ? view : "cards";
}

/**
 * Conserve l'affichage de l'adresse courante dans une nouvelle adresse de recherche : modifier un
 * filtre ou le tri ne doit pas ramener les cartes. À appeler dans le navigateur seulement.
 */
export function keepCurrentResultsView(record: SalesSearchUrlRecord): SalesSearchUrlRecord {
  const current = parseResultsView(
    new URLSearchParams(window.location.search).get(RESULTS_VIEW_PARAM),
  );
  return withResultsView(record, current);
}

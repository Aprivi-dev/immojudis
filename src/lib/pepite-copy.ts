/**
 * Textes et adresse du repère « Pépite » partagés par les cartes, le tableau, la carte, la fiche et les
 * alertes. Module sans dépendance (le navigateur ne charge pas la règle `pepite-policy.ts` pour afficher une
 * pastille). Textes validés par le fondateur et relus par le juridique le 26/10/2026 : ne rien y ajouter qui
 * parle d'un conseil, d'une recommandation d'acheter ou d'une garantie.
 */
export const PEPITE_METHOD_PATH = "/methode-pepites";

export const PEPITE_LABEL = "Pépite";
export const PEPITE_EXPLANATION =
  "Repère calculé automatiquement par Immojudis sur des critères publics. Ce n'est ni un conseil, ni une recommandation d'acheter, ni une garantie de prix.";
export const PEPITE_METHOD_LINK_LABEL = "Comment repérons-nous les pépites ?";
/** Ancre du bloc « Pourquoi cette pépite » de la fiche. */
export const PEPITE_ANCHOR = "pepite";
export const PEPITE_FILTER_LABEL = "Pépites seulement";
/** Même libellé que le filtre de recherche : une alerte « Pépites seulement » enregistre ce filtre. */
/** Motif interne enregistré par les alertes « Pépites seulement » (jamais affiché tel quel : voir `PEPITE_LABEL`). */
export const PEPITE_ALERT_REASON = "pépite";
export const PEPITE_ALERT_LABEL = PEPITE_FILTER_LABEL;

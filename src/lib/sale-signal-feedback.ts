/**
 * Retour en un clic sur un signal affiché sur une vente (point 67) : « Utile » ou « Pas pertinent »,
 * puis un motif en liste fermée. Le signal « pepite » (motifs : « Montant trop haut », « Un critère est
 * faux », « Peu intéressant ») est prêt pour le repère Pépite ; son bouton ne s'affiche pas encore
 * (lot d'affichage suivant). Comptes connectés seulement : la route (`POST
 * /api/sales/[id]/signal-feedback`) répond 401 sans compte, et le composant ne s'affiche pas sans
 * session. Aucun texte libre : chaque valeur vient d'une liste fermée, que la base répète
 * (migration 20261030110100, contraintes de `sale_signal_feedback`).
 *
 * Module sans dépendance serveur : partagé par le composant, la route et la page admin. Le schéma
 * du corps de la route est dans `sale-signal-feedback-schema.ts`, pour que le navigateur
 * n'embarque pas zod.
 */
export const SALE_SIGNALS = ["market_gap_band", "points_to_verify", "pepite"] as const;
export type SaleSignal = (typeof SALE_SIGNALS)[number];

export const SALE_SIGNAL_VALUES = ["useful", "not_relevant"] as const;
export type SaleSignalValue = (typeof SALE_SIGNAL_VALUES)[number];

export const SALE_SIGNAL_REASONS = {
  market_gap_band: ["estimate_too_high", "estimate_too_low"],
  points_to_verify: ["point_wrong", "point_missing"],
  pepite: ["amount_too_high", "criterion_wrong", "not_interesting"],
} as const satisfies Record<SaleSignal, readonly string[]>;
export type SaleSignalReason = (typeof SALE_SIGNAL_REASONS)[SaleSignal][number];

/** Libellés des boutons et des motifs, mots de la liste fermée. */
export const SALE_SIGNAL_VALUE_LABELS: Record<SaleSignalValue, string> = {
  useful: "Utile",
  not_relevant: "Pas pertinent",
};

export const SALE_SIGNAL_REASON_LABELS: Record<SaleSignalReason, string> = {
  estimate_too_high: "Estimation trop haute",
  estimate_too_low: "Estimation trop basse",
  point_wrong: "Un point est faux",
  point_missing: "Un point manque",
  amount_too_high: "Montant trop haut",
  criterion_wrong: "Un critère est faux",
  not_interesting: "Peu intéressant",
};

/** La question posée sous chaque signal. */
export const SALE_SIGNAL_QUESTIONS: Record<SaleSignal, string> = {
  market_gap_band: "Ce repère vous est-il utile ?",
  points_to_verify: "Cette liste vous est-elle utile ?",
  pepite: "Ce repère vous est-il utile ?",
};

export function isReasonOfSignal(signal: SaleSignal, reason: string): boolean {
  return (SALE_SIGNAL_REASONS[signal] as readonly string[]).includes(reason);
}

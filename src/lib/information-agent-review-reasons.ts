/**
 * Motifs de relecture d'une information extraite d'une réponse de l'agent d'information. Un candidat qui en
 * porte un (`metadata.review_reasons`) arrive en relecture avec son motif et n'est jamais un fait net.
 *
 * Liste unique : mêmes codes et mêmes libellés que `REVIEW_REASON_LABELS` du worker Python
 * (`services/data-pipeline/src/information_agent_review_signals.py`) ; un test compare les deux.
 */
export const REVIEW_REASON_LABELS = {
  short_citation: "phrase de moins de 25 caractères",
  hedged_statement: "valeur au conditionnel ou approximative",
  reported_or_comparison: "valeur rapportée d’une autre source ou d’un autre bien",
  pending_verification:
    "réserve : « à vérifier », « à confirmer », « sous réserve », « non contrôlé »",
  value_range: "fourchette de valeurs",
  corrected_or_stale_value: "valeur corrigée, périmée ou signalée comme erronée",
  postponement: "renvoi ou report mentionné dans la phrase",
  question: "la phrase est une question",
  lot_unidentified: "vente à plusieurs lots : la phrase ne nomme aucun lot",
  lot_unverified: "la phrase nomme un lot que l’on ne peut pas rapprocher de la vente",
  rules_only_attachment: "pièce lue par les règles seules, sans confirmation par l’IA",
} as const satisfies Record<string, string>;

export type ReviewReason = keyof typeof REVIEW_REASON_LABELS;

export const REVIEW_REASON_CODES = Object.keys(REVIEW_REASON_LABELS) as ReviewReason[];

/** Au plus ce nombre de motifs est affiché ; le reste est résumé. */
export const MAX_DISPLAYED_REVIEW_REASONS = 4;

/** Libellés des motifs d'un candidat (`metadata.review_reasons`), bornés ; un code inconnu reste signalé. */
export function reviewReasonLabels(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const reasons = (metadata as Record<string, unknown>).review_reasons;
  if (!Array.isArray(reasons)) return [];
  const labels = [
    ...new Set(
      reasons
        .filter((reason): reason is string => typeof reason === "string")
        .map((reason) =>
          Object.hasOwn(REVIEW_REASON_LABELS, reason)
            ? REVIEW_REASON_LABELS[reason as ReviewReason]
            : "motif non reconnu",
        ),
    ),
  ];
  if (labels.length <= MAX_DISPLAYED_REVIEW_REASONS) return labels;
  const hidden = labels.length - MAX_DISPLAYED_REVIEW_REASONS;
  return [
    ...labels.slice(0, MAX_DISPLAYED_REVIEW_REASONS),
    `et ${hidden} autre${hidden > 1 ? "s" : ""} motif${hidden > 1 ? "s" : ""}`,
  ];
}

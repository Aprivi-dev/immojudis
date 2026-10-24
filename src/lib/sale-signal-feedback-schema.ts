import { z } from "zod";
import { SALE_SIGNALS, SALE_SIGNAL_VALUES, isReasonOfSignal } from "@/lib/sale-signal-feedback";

/**
 * Corps accepté par `POST /api/sales/[id]/signal-feedback` (point 67) : exactement un signal, une
 * valeur et, pour « Pas pertinent » seulement, un motif propre au signal. Tout champ en plus est
 * refusé (aucun texte libre).
 *
 * Séparé de `sale-signal-feedback.ts`, que le composant et la page admin importent pour les listes
 * fermées et les libellés : seule la route valide le corps, le navigateur n'a pas à embarquer zod.
 */
export const saleSignalFeedbackSchema = z
  .object({
    signal: z.enum(SALE_SIGNALS),
    value: z.enum(SALE_SIGNAL_VALUES),
    reason: z.string().max(40).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.reason === undefined) return;
    if (input.value !== "not_relevant" || !isReasonOfSignal(input.signal, input.reason)) {
      context.addIssue({ code: "custom", path: ["reason"], message: "Motif invalide." });
    }
  });

export type SaleSignalFeedbackInput = z.output<typeof saleSignalFeedbackSchema>;

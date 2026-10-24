import { z } from "zod";
import { FAVORITE_DOSSIER_STATUSES } from "@/lib/favorite-dossier-shared";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";

/**
 * Schémas du corps et de la requête de `/api/favorites/dossier` (point 68). Séparés de
 * `favorite-dossier-shared.ts`, que les composants importent pour les libellés et la saisie :
 * le navigateur n'a pas à télécharger zod pour valider ce que seule la route lit.
 */
export const favoriteDossierInputSchema = z
  .object({
    saleId: z.string().guid(),
    /** `null` efface le statut ; absent : le statut n'est pas modifié. */
    personalStatus: z.enum(FAVORITE_DOSSIER_STATUSES).nullable().optional(),
    /**
     * `null` efface le plafond ; absent : le plafond n'est pas modifié. En euros entiers, au moins
     * 1 € : un plafond de 0 € n'est pas une enchère (on efface le plafond avec `null`).
     */
    bidCeilingEur: z
      .number()
      .finite()
      .min(1, { message: "L’enchère plafond doit être supérieure à 0 €." })
      .max(MAX_SIMULATOR_AMOUNT_EUR)
      .transform((value) => Math.round(value))
      .nullable()
      .optional(),
  })
  .refine((value) => value.personalStatus !== undefined || value.bidCeilingEur !== undefined, {
    message: "Aucune modification demandée.",
  });

export type FavoriteDossierInput = z.input<typeof favoriteDossierInputSchema>;
export type FavoriteDossierPayload = z.output<typeof favoriteDossierInputSchema>;

export const favoriteDossierQuerySchema = z.object({ saleId: z.string().guid() });

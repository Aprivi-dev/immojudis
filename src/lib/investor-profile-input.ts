import { z } from "zod";
import {
  INVESTOR_DOWN_PAYMENT_MAX_EUR,
  INVESTOR_MARGIN_MAX_PCT,
  INVESTOR_STRATEGIES,
  INVESTOR_WORKS_PER_M2_MAX_EUR,
} from "@/lib/investor-profile";

/**
 * Corps de `PUT /api/investor-profile` (n° 93). Le profil est remplacé en entier : un champ absent ou
 * `null` est une valeur absente. Au moins une hypothèse est requise ; pour tout effacer, la personne
 * supprime son profil (`DELETE`). Mêmes bornes que les contraintes de la base.
 */
export const investorProfileInputSchema = z
  .object({
    downPaymentEur: z
      .number()
      .finite()
      .min(0)
      .max(INVESTOR_DOWN_PAYMENT_MAX_EUR)
      .transform((value) => Math.round(value))
      .nullable()
      .optional(),
    targetMarginPct: z
      .number()
      .finite()
      .min(0)
      .max(INVESTOR_MARGIN_MAX_PCT)
      .transform((value) => Math.round(value * 100) / 100)
      .nullable()
      .optional(),
    worksPerM2Eur: z
      .number()
      .finite()
      .min(0)
      .max(INVESTOR_WORKS_PER_M2_MAX_EUR)
      .transform((value) => Math.round(value))
      .nullable()
      .optional(),
    strategy: z.enum(INVESTOR_STRATEGIES).nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.downPaymentEur != null ||
      value.targetMarginPct != null ||
      value.worksPerM2Eur != null ||
      value.strategy != null,
    { message: "Renseignez au moins une hypothèse, ou effacez votre profil." },
  );

export type InvestorProfileInput = z.input<typeof investorProfileInputSchema>;
export type InvestorProfilePayload = z.output<typeof investorProfileInputSchema>;

import { z } from "zod";

/**
 * Body of `POST /api/billing/portal`.  `manage` opens the generic Stripe portal;
 * `cancel` opens its cancellation flow directly.  The subscription to cancel is never
 * part of the request: the server reads it from the signed-in user's own row.
 */
export const billingPortalRequestSchema = z.object({
  intent: z.enum(["manage", "cancel"]).default("manage"),
});

export type BillingPortalIntent = z.infer<typeof billingPortalRequestSchema>["intent"];

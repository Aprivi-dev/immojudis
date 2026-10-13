import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { OFFER_OPENING_CONSENT_VERSION } from "@/lib/offer-opening-consent";

type OpeningRow = Database["public"]["Tables"]["offer_opening_notifications"]["Row"];
type OpeningInsert = Database["public"]["Tables"]["offer_opening_notifications"]["Insert"];

export {
  OFFER_OPENING_CONSENT_TEXT,
  OFFER_OPENING_CONSENT_VERSION,
  OFFER_OPENING_REQUESTED_TEXT,
} from "@/lib/offer-opening-consent";

export const offerOpeningNotificationSchema = z.discriminatedUnion("enabled", [
  z.object({
    enabled: z.literal(true),
    consentTextVersion: z.literal(OFFER_OPENING_CONSENT_VERSION, {
      message: "Le texte du consentement a changé : rechargez la page.",
    }),
  }),
  z.object({ enabled: z.literal(false) }),
]);

export type OfferOpeningNotificationInput = z.infer<typeof offerOpeningNotificationSchema>;

export type OfferOpeningNotificationState = {
  requested: boolean;
  consentedAt: string | null;
};

export type OfferOpeningNotificationResponse = { notification: OfferOpeningNotificationState };

export async function getOfferOpeningNotification({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<OfferOpeningNotificationResponse> {
  const { data, error } = await auth.supabase
    .from("offer_opening_notifications")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("offer_code", "analyse")
    .maybeSingle();
  if (error) throw error;
  return { notification: rowToState(data) };
}

/**
 * Writes go through the service client, after the route has authenticated the user:
 * the `authenticated` role has no write grant on the table, so nobody can forge
 * `consented_at`, `consent_text_version` or `notified_at` from the browser.
 */
export async function setOfferOpeningNotification({
  auth,
  admin,
  input,
  now = new Date(),
}: {
  auth: Pick<SupabaseAuthContext, "userId">;
  admin: SupabaseClient<Database>;
  input: OfferOpeningNotificationInput;
  now?: Date;
}): Promise<OfferOpeningNotificationResponse> {
  const { data: current, error: readError } = await admin
    .from("offer_opening_notifications")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (readError) throw readError;

  const patch = buildOfferOpeningPatch({
    current,
    enabled: input.enabled,
    timestamp: now.toISOString(),
  });
  if (!patch) return { notification: rowToState(current) };

  const { data, error } = await admin
    .from("offer_opening_notifications")
    .upsert({ user_id: auth.userId, ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return { notification: rowToState(data) };
}

/**
 * Returns what to write, or null when the stored state already matches. Asking
 * twice keeps the first consent date; asking again after a withdrawal is a new
 * consent with a new date.
 */
export function buildOfferOpeningPatch({
  current,
  enabled,
  timestamp,
}: {
  current: Pick<OpeningRow, "notify_enabled" | "consent_text_version"> | null;
  enabled: boolean;
  timestamp: string;
}): Omit<OpeningInsert, "user_id"> | null {
  if (enabled) {
    if (current?.notify_enabled) return null;
    return {
      notify_enabled: true,
      consented_at: timestamp,
      revoked_at: null,
      consent_text_version: OFFER_OPENING_CONSENT_VERSION,
      consent_source: "offers_page",
    };
  }
  if (!current?.notify_enabled) return null;
  // The stored wording version stays: it is the proof of what was agreed, not of the withdrawal.
  return {
    notify_enabled: false,
    revoked_at: timestamp,
    consent_text_version: current.consent_text_version,
  };
}

function rowToState(row: OpeningRow | null): OfferOpeningNotificationState {
  const requested = Boolean(row?.notify_enabled);
  return { requested, consentedAt: requested ? (row?.consented_at ?? null) : null };
}

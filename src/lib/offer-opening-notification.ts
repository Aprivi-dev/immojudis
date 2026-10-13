import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type OpeningRow = Database["public"]["Tables"]["offer_opening_notifications"]["Row"];
type OpeningInsert = Database["public"]["Tables"]["offer_opening_notifications"]["Insert"];

/**
 * Wording shown next to the "Me prévenir de l'ouverture" button. Change the text
 * and the version together: the version is stored with the timestamp as proof of
 * what the user agreed to, and the server refuses a request that echoes another one.
 */
export const OFFER_OPENING_CONSENT_VERSION = "2026-10-20";
export const OFFER_OPENING_CONSENT_TEXT =
  "Un seul email vous prévient le jour de l’ouverture des souscriptions. Aucune autre utilisation de votre adresse, et vous pouvez retirer votre demande à tout moment.";

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

export async function setOfferOpeningNotification({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: OfferOpeningNotificationInput;
  now?: Date;
}): Promise<OfferOpeningNotificationResponse> {
  const { data: current, error: readError } = await auth.supabase
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

  const { data, error } = await auth.supabase
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

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { PublicApiError } from "@/lib/api-errors";
import {
  OFFER_OPENING_CONSENT_VERSION,
  OFFER_OPENING_SURVEY_PROFILES,
  OFFER_OPENING_SURVEY_VERSION,
  type OfferOpeningSurveyProfile,
} from "@/lib/offer-opening-consent";

type OpeningRow = Database["public"]["Tables"]["offer_opening_notifications"]["Row"];
type OpeningInsert = Database["public"]["Tables"]["offer_opening_notifications"]["Insert"];

export {
  OFFER_OPENING_CONSENT_TEXT,
  OFFER_OPENING_CONSENT_VERSION,
  OFFER_OPENING_REQUESTED_TEXT,
  OFFER_OPENING_SURVEY_VERSION,
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

const SURVEY_PROFILE_VALUES = OFFER_OPENING_SURVEY_PROFILES.map((profile) => profile.value) as [
  OfferOpeningSurveyProfile,
  ...OfferOpeningSurveyProfile[],
];

/** Un montant ou un nombre facultatif : absent ou nul = pas de réponse. */
const optionalCount = (max: number) =>
  z
    .number()
    .int("Indiquez un nombre entier.")
    .min(0, "Indiquez un nombre positif.")
    .max(max, `Indiquez un nombre inférieur à ${max}.`)
    .nullish()
    .transform((value) => value ?? null);

/**
 * Questions facultatives de la liste d'attente : profil, ventes étudiées par mois, deux repères de
 * prix (euros par mois), et l'accord à un entretien de 20 minutes (faux tant que la personne n'a pas
 * coché la case). Les bornes sont celles des contraintes de la base (migration
 * `offer_opening_survey`). Rien de ceci ne conditionne l'inscription à la liste.
 */
export const offerOpeningSurveySchema = z
  .object({
    surveyTextVersion: z.literal(OFFER_OPENING_SURVEY_VERSION, {
      message: "Le texte des questions a changé : rechargez la page.",
    }),
    profile: z
      .enum(SURVEY_PROFILE_VALUES)
      .nullish()
      .transform((value) => value ?? null),
    salesPerMonth: optionalCount(500),
    priceTooExpensiveEur: optionalCount(1000),
    priceCheapEur: optionalCount(1000),
    interviewAccepted: z.boolean().default(false),
  })
  .strict();

export type OfferOpeningSurveyInput = z.infer<typeof offerOpeningSurveySchema>;

export type OfferOpeningSurveyState = {
  profile: OfferOpeningSurveyProfile | null;
  salesPerMonth: number | null;
  priceTooExpensiveEur: number | null;
  priceCheapEur: number | null;
  interviewAccepted: boolean;
  answeredAt: string | null;
};

export type OfferOpeningNotificationState = {
  requested: boolean;
  consentedAt: string | null;
  /** Réponses déjà enregistrées ; absent quand la demande n'est pas active. */
  survey?: OfferOpeningSurveyState | null;
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
  // The optional answers belonged to the request: they leave with it.
  return {
    notify_enabled: false,
    revoked_at: timestamp,
    consent_text_version: current.consent_text_version,
    ...EMPTY_SURVEY_COLUMNS,
  };
}

const EMPTY_SURVEY_COLUMNS = {
  survey_profile: null,
  survey_sales_per_month: null,
  survey_price_too_expensive_eur: null,
  survey_price_cheap_eur: null,
  survey_interview_accepted: false,
  survey_interview_consented_at: null,
  survey_text_version: null,
  survey_answered_at: null,
} as const;

/**
 * Records the optional answers of someone whose request is active. Same rule as the request
 * itself: written by the service client after the route authenticated the user, so the interview
 * consent date cannot be forged from the browser. An interview agreed earlier keeps its first
 * date; unticking the box clears it. Sending nothing is allowed (every answer is optional).
 */
export async function setOfferOpeningSurvey({
  auth,
  admin,
  input,
  now = new Date(),
}: {
  auth: Pick<SupabaseAuthContext, "userId">;
  admin: SupabaseClient<Database>;
  input: OfferOpeningSurveyInput;
  now?: Date;
}): Promise<OfferOpeningNotificationResponse> {
  const { data: current, error: readError } = await admin
    .from("offer_opening_notifications")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (readError) throw readError;
  if (!current?.notify_enabled) {
    throw new PublicApiError("Enregistrez d’abord votre demande d’information.", 409);
  }

  const { data, error } = await admin
    .from("offer_opening_notifications")
    .update(buildOfferOpeningSurveyPatch({ current, input, timestamp: now.toISOString() }))
    .eq("user_id", auth.userId)
    .select("*")
    .single();
  if (error) throw error;
  return { notification: rowToState(data) };
}

export function buildOfferOpeningSurveyPatch({
  current,
  input,
  timestamp,
}: {
  current: Pick<OpeningRow, "survey_interview_accepted" | "survey_interview_consented_at">;
  input: OfferOpeningSurveyInput;
  timestamp: string;
}): Partial<OpeningInsert> {
  return {
    survey_profile: input.profile,
    survey_sales_per_month: input.salesPerMonth,
    survey_price_too_expensive_eur: input.priceTooExpensiveEur,
    survey_price_cheap_eur: input.priceCheapEur,
    survey_interview_accepted: input.interviewAccepted,
    survey_interview_consented_at: input.interviewAccepted
      ? current.survey_interview_accepted && current.survey_interview_consented_at
        ? current.survey_interview_consented_at
        : timestamp
      : null,
    survey_text_version: input.surveyTextVersion,
    survey_answered_at: timestamp,
  };
}

function rowToState(row: OpeningRow | null): OfferOpeningNotificationState {
  const requested = Boolean(row?.notify_enabled);
  return {
    requested,
    consentedAt: requested ? (row?.consented_at ?? null) : null,
    survey: requested && row ? rowToSurvey(row) : null,
  };
}

function rowToSurvey(row: OpeningRow): OfferOpeningSurveyState | null {
  if (!row.survey_answered_at) return null;
  const profile = OFFER_OPENING_SURVEY_PROFILES.find((item) => item.value === row.survey_profile);
  return {
    profile: profile?.value ?? null,
    salesPerMonth: row.survey_sales_per_month,
    priceTooExpensiveEur: row.survey_price_too_expensive_eur,
    priceCheapEur: row.survey_price_cheap_eur,
    interviewAccepted: row.survey_interview_accepted,
    answeredAt: row.survey_answered_at,
  };
}

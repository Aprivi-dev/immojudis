import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { saleRemindersOfferedTo } from "@/lib/sale-reminders-mode";

type NotificationPreferenceRow =
  Database["public"]["Tables"]["user_notification_preferences"]["Row"];
type NotificationPreferenceInsert =
  Database["public"]["Tables"]["user_notification_preferences"]["Insert"];

export const notificationPreferenceUpdateSchema = z
  .object({
    alertEmailEnabled: z.boolean().optional(),
    /** Consentement distinct aux rappels d'audience et avertissements graves. */
    saleRemindersEnabled: z.boolean().optional(),
    consentSource: z.enum(["settings", "alert_creation", "import", "admin"]).default("settings"),
  })
  .refine(
    (value) => value.alertEmailEnabled !== undefined || value.saleRemindersEnabled !== undefined,
    { message: "Au moins une préférence est requise." },
  );

export type NotificationPreferenceUpdateInput = z.input<typeof notificationPreferenceUpdateSchema>;
export type NotificationPreferenceUpdatePayload = z.output<
  typeof notificationPreferenceUpdateSchema
>;

export type NotificationPreferences = {
  userId: string;
  alertEmailEnabled: boolean;
  alertEmailConsentedAt: string | null;
  alertEmailRevokedAt: string | null;
  consentSource: NotificationPreferenceRow["consent_source"];
  saleRemindersEnabled: boolean;
  saleRemindersConsentedAt: string | null;
  saleRemindersRevokedAt: string | null;
  updatedAt: string | null;
};

export type NotificationPreferencesResponse = {
  preferences: NotificationPreferences;
  /**
   * Les rappels d'audience sont-ils proposés à cette personne ? Faux tant que `SALE_REMINDERS_MODE`
   * vaut `off` (ou `internal` pour un compte qui n'est pas administrateur) : on ne recueille pas
   * de consentement pour un envoi qui n'a pas lieu.
   */
  saleRemindersAvailable: boolean;
};

export async function getNotificationPreferences({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<NotificationPreferencesResponse> {
  const { data, error } = await auth.supabase
    .from("user_notification_preferences")
    .select("*")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) throw error;
  return {
    preferences: rowToPreferences(data, auth.userId),
    saleRemindersAvailable: saleRemindersOfferedTo({ isAdmin: auth.isAdmin }),
  };
}

export async function updateNotificationPreferences({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: NotificationPreferenceUpdatePayload;
  now?: Date;
}): Promise<NotificationPreferencesResponse> {
  const existing = await getNotificationPreferences({ auth });
  const timestamp = now.toISOString();
  // Seules les préférences envoyées sont écrites: cocher les rappels ne touche pas au consentement
  // aux alertes email, et inversement.
  const patch: NotificationPreferenceInsert = {
    user_id: auth.userId,
    ...(input.alertEmailEnabled !== undefined
      ? buildNotificationPreferencePatch({
          current: existing.preferences,
          enabled: input.alertEmailEnabled,
          consentSource: input.consentSource,
          timestamp,
        })
      : {}),
    ...(input.saleRemindersEnabled !== undefined
      ? buildSaleReminderPreferencePatch({
          current: existing.preferences,
          enabled: input.saleRemindersEnabled,
          timestamp,
        })
      : {}),
  };

  const { data, error } = await auth.supabase
    .from("user_notification_preferences")
    .upsert(patch, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) throw error;
  return {
    preferences: rowToPreferences(data, auth.userId),
    saleRemindersAvailable: saleRemindersOfferedTo({ isAdmin: auth.isAdmin }),
  };
}

export async function emailAlertConsentEnabled(auth: SupabaseAuthContext): Promise<boolean> {
  const { preferences } = await getNotificationPreferences({ auth });
  return canCreateEmailAlertNotification(preferences);
}

export function canCreateEmailAlertNotification(
  preferences: Pick<NotificationPreferences, "alertEmailEnabled" | "alertEmailConsentedAt">,
): boolean {
  return Boolean(preferences.alertEmailEnabled && preferences.alertEmailConsentedAt);
}

export function buildNotificationPreferencePatch({
  current,
  enabled,
  consentSource,
  timestamp,
}: {
  current: Pick<
    NotificationPreferences,
    "alertEmailEnabled" | "alertEmailConsentedAt" | "alertEmailRevokedAt"
  >;
  enabled: boolean;
  consentSource: NotificationPreferenceRow["consent_source"];
  timestamp: string;
}): Omit<NotificationPreferenceInsert, "user_id"> {
  return {
    alert_email_enabled: enabled,
    consent_source: consentSource,
    alert_email_consented_at: enabled
      ? (current.alertEmailConsentedAt ?? timestamp)
      : current.alertEmailConsentedAt,
    alert_email_revoked_at: enabled
      ? null
      : current.alertEmailEnabled
        ? timestamp
        : current.alertEmailRevokedAt,
  };
}

/** Rappels d'audience: l'email part seulement avec un consentement actif et daté. */
export function canSendSaleReminder(
  preferences: Pick<NotificationPreferences, "saleRemindersEnabled" | "saleRemindersConsentedAt">,
): boolean {
  return Boolean(preferences.saleRemindersEnabled && preferences.saleRemindersConsentedAt);
}

/** Même règle de datation que le consentement aux alertes: la première date est conservée. */
export function buildSaleReminderPreferencePatch({
  current,
  enabled,
  timestamp,
}: {
  current: Pick<
    NotificationPreferences,
    "saleRemindersEnabled" | "saleRemindersConsentedAt" | "saleRemindersRevokedAt"
  >;
  enabled: boolean;
  timestamp: string;
}): Pick<
  NotificationPreferenceInsert,
  "sale_reminders_enabled" | "sale_reminders_consented_at" | "sale_reminders_revoked_at"
> {
  return {
    sale_reminders_enabled: enabled,
    sale_reminders_consented_at: enabled
      ? (current.saleRemindersConsentedAt ?? timestamp)
      : current.saleRemindersConsentedAt,
    sale_reminders_revoked_at: enabled
      ? null
      : current.saleRemindersEnabled
        ? timestamp
        : current.saleRemindersRevokedAt,
  };
}

function rowToPreferences(
  row: NotificationPreferenceRow | null,
  userId: string,
): NotificationPreferences {
  return {
    userId,
    alertEmailEnabled: row?.alert_email_enabled ?? false,
    alertEmailConsentedAt: row?.alert_email_consented_at ?? null,
    alertEmailRevokedAt: row?.alert_email_revoked_at ?? null,
    consentSource: row?.consent_source ?? "settings",
    saleRemindersEnabled: row?.sale_reminders_enabled ?? false,
    saleRemindersConsentedAt: row?.sale_reminders_consented_at ?? null,
    saleRemindersRevokedAt: row?.sale_reminders_revoked_at ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

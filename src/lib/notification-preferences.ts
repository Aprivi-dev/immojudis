import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type NotificationPreferenceRow =
  Database["public"]["Tables"]["user_notification_preferences"]["Row"];
type NotificationPreferenceInsert =
  Database["public"]["Tables"]["user_notification_preferences"]["Insert"];

export const notificationPreferenceUpdateSchema = z.object({
  alertEmailEnabled: z.boolean(),
  consentSource: z.enum(["settings", "alert_creation", "import", "admin"]).default("settings"),
});

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
  updatedAt: string | null;
};

export type NotificationPreferencesResponse = {
  preferences: NotificationPreferences;
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
  const patch: NotificationPreferenceInsert = {
    user_id: auth.userId,
    ...buildNotificationPreferencePatch({
      current: existing.preferences,
      enabled: input.alertEmailEnabled,
      consentSource: input.consentSource,
      timestamp,
    }),
  };

  const { data, error } = await auth.supabase
    .from("user_notification_preferences")
    .upsert(patch, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) throw error;
  return {
    preferences: rowToPreferences(data, auth.userId),
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
    updatedAt: row?.updated_at ?? null,
  };
}

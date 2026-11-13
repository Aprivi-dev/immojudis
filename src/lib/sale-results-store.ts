import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  createSupabaseSaleReminderStore,
  dispatchJournalMarks,
  listConsentingPreferences,
} from "@/lib/sale-reminders-store";
import type { FollowedSnapshot, SaleResultStore } from "@/lib/sale-results";

/** Instantanés lus au plus par compte et par passage. */
const MAX_SNAPSHOTS_PER_USER = 200;

/**
 * Lecture et écriture réelles du cron `sale-results` (service_role). Les lectures qui échouent lèvent
 * une erreur : un passage qui ne peut pas lire ne conclut jamais qu'il n'y a rien à annoncer. Les
 * lectures déjà écrites pour les rappels d'audience (administrateurs, ventes suivies, visibilité, titre
 * public, événements de changement, adresse confirmée) sont reprises telles quelles.
 */
export function createSupabaseSaleResultStore(): SaleResultStore {
  const reminders = createSupabaseSaleReminderStore();
  return {
    filterAdminUserIds: (userIds) => reminders.filterAdminUserIds(userIds),
    followedSales: (userId) => reminders.followedSales(userId),
    visibleSaleIds: (saleIds) => reminders.visibleSaleIds(saleIds),
    calendarEvent: (saleId) => reminders.calendarEvent(saleId),
    recentChangeEvents: (userId, saleIds, since) =>
      reminders.recentChangeEvents(userId, saleIds, since),
    userEmail: (userId) => reminders.userEmail(userId),

    async listConsentingUserIds() {
      return (await listConsentingPreferences("sale_results")).map((row) => row.user_id);
    },

    async recentSnapshots(userId, since) {
      // Aucune colonne de prix (mise à prix, adjudication, plafond) : l'email n'en porte jamais.
      const { data, error } = await supabaseAdmin
        .from("user_followed_sale_snapshots")
        .select(
          "sale_id,captured_at,result_status,sale_date,sale_venue_type,city,property_type,tribunal_name",
        )
        .eq("user_id", userId)
        .gte("captured_at", since.toISOString())
        .order("captured_at", { ascending: false })
        .limit(MAX_SNAPSHOTS_PER_USER);
      if (error) throw error;
      return (data ?? []).map(
        (row): FollowedSnapshot => ({
          saleId: row.sale_id,
          capturedAt: row.captured_at,
          resultStatus: row.result_status === "adjudicated" ? "adjudicated" : "unknown",
          saleDate: row.sale_date,
          venueType: row.sale_venue_type,
          city: row.city,
          propertyType: row.property_type,
          tribunalName: row.tribunal_name,
        }),
      );
    },

    async reminderWarningExists(userId, saleId, status) {
      const { data, error } = await supabaseAdmin
        .from("sale_reminder_dispatches")
        .select("id")
        .eq("user_id", userId)
        .eq("sale_id", saleId)
        .eq("reminder_kind", "status_changed")
        .eq("payload->>currentValue", status)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async claim({ userId, saleId, kind, mode, payload }) {
      const { data, error } = await supabaseAdmin.rpc("claim_sale_result", {
        p_user_id: userId,
        p_sale_id: saleId,
        p_kind: kind,
        p_mode: mode,
        p_payload: payload as Json,
      });
      if (error) throw error;
      return typeof data === "string" && data ? data : null;
    },

    ...dispatchJournalMarks("sale_result_dispatches"),
  };
}

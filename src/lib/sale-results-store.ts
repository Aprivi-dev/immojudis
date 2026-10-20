import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { createSupabaseSaleReminderStore } from "@/lib/sale-reminders-store";
import type { FollowedSnapshot, SaleResultStore } from "@/lib/sale-results";

const PAGE_SIZE = 1_000;
/** Garde-fou : au-delà, le passage s'arrête là (les comptes suivants attendent le suivant). */
const MAX_CONSENTING_USERS = 10_000;
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
      const ids: string[] = [];
      for (let from = 0; from < MAX_CONSENTING_USERS; from += PAGE_SIZE) {
        // Consentement actif, daté par la base ET texte présenté connu (posé par la route serveur) :
        // une écriture directe sans version ne vaut pas consentement.
        const { data, error } = await supabaseAdmin
          .from("user_notification_preferences")
          .select("user_id")
          .eq("sale_results_enabled", true)
          .not("sale_results_consented_at", "is", null)
          .not("sale_results_consent_text_version", "is", null)
          .order("user_id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        ids.push(...(data ?? []).map((row) => row.user_id));
        if ((data ?? []).length < PAGE_SIZE) break;
      }
      return ids;
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

    async markSent(ids, { messageId, at }) {
      if (!ids.length) return;
      const { error } = await supabaseAdmin
        .from("sale_result_dispatches")
        .update({
          status: "sent",
          message_id: messageId,
          sent_at: at.toISOString(),
          updated_at: at.toISOString(),
          error: null,
        })
        .in("id", ids);
      if (error) throw error;
    },

    async markFailed(ids, { error: code }) {
      if (!ids.length) return;
      const { error } = await supabaseAdmin
        .from("sale_result_dispatches")
        .update({ status: "failed", error: code, updated_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },
  };
}

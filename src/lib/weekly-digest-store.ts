import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { saleChangeEventRowToSummary } from "@/lib/sale-change-monitor";
import { getPublicationVisibleSaleIds } from "@/lib/sale-publication-guard";
import { createSupabaseSaleReminderStore } from "@/lib/sale-reminders-store";
import type { NewSaleSummary, WeeklyDigestStore } from "@/lib/weekly-digest";

const PAGE_SIZE = 1_000;
/** Garde-fou : au-delà, le passage s'arrête là (les comptes suivants attendent le suivant). */
const MAX_CONSENTING_USERS = 10_000;
const IN_CHUNK = 100;
/** Ventes récentes lues par passage et par compte pour compter les nouvelles ventes. */
const NEW_SALES_SCAN_LIMIT = 100;

function chunks<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

/**
 * Lecture et écriture réelles du cron `weekly-digest` (service_role). Les lectures qui échouent
 * lèvent une erreur : un passage qui ne peut pas lire ne conclut jamais qu'il n'y a rien à annoncer.
 * Les lectures déjà écrites pour les rappels d'audience (ventes suivies, date publique, vérification
 * à la source, visibilité, adresse confirmée) sont reprises telles quelles.
 */
export function createSupabaseWeeklyDigestStore(): WeeklyDigestStore {
  const reminders = createSupabaseSaleReminderStore();
  return {
    filterAdminUserIds: (userIds) => reminders.filterAdminUserIds(userIds),
    followedSales: (userId) => reminders.followedSales(userId),
    lastVerifiedAt: (saleIds) => reminders.lastVerifiedAt(saleIds),
    visibleSaleIds: (saleIds) => reminders.visibleSaleIds(saleIds),
    calendarEvent: (saleId) => reminders.calendarEvent(saleId),
    userEmail: (userId) => reminders.userEmail(userId),

    async listConsentingUsers() {
      const users: Array<{ userId: string; weekday: number }> = [];
      for (let from = 0; from < MAX_CONSENTING_USERS; from += PAGE_SIZE) {
        // Consentement actif, daté par la base ET texte présenté connu (posé par la route serveur) :
        // une écriture directe sans version ne vaut pas consentement.
        const { data, error } = await supabaseAdmin
          .from("user_notification_preferences")
          .select("user_id,weekly_digest_weekday")
          .eq("weekly_digest_enabled", true)
          .not("weekly_digest_consented_at", "is", null)
          .not("weekly_digest_consent_text_version", "is", null)
          .order("user_id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        users.push(
          ...(data ?? []).map((row) => ({
            userId: row.user_id,
            weekday: row.weekly_digest_weekday,
          })),
        );
        if ((data ?? []).length < PAGE_SIZE) break;
      }
      return users;
    },

    async usersEmailedSince(userIds, since) {
      const emailed = new Set<string>();
      const sinceIso = since.toISOString();
      for (const chunk of chunks(userIds)) {
        const [alerts, reminderRows, results] = await Promise.all([
          supabaseAdmin
            .from("user_alert_notifications")
            .select("user_id")
            .in("user_id", chunk)
            .eq("delivery_channel", "email")
            .eq("delivery_status", "sent")
            .gte("sent_at", sinceIso),
          supabaseAdmin
            .from("sale_reminder_dispatches")
            .select("user_id")
            .in("user_id", chunk)
            .eq("status", "sent")
            .gte("sent_at", sinceIso),
          supabaseAdmin
            .from("sale_result_dispatches")
            .select("user_id")
            .in("user_id", chunk)
            .eq("status", "sent")
            .gte("sent_at", sinceIso),
        ]);
        for (const response of [alerts, reminderRows, results]) {
          if (response.error) throw response.error;
          for (const row of response.data ?? []) emailed.add(row.user_id);
        }
      }
      return emailed;
    },

    async settledDigests(entries) {
      const settled = new Set<string>();
      const wanted = new Set(entries.map(({ userId, weekKey }) => `${userId}|${weekKey}`));
      const weekKeys = [...new Set(entries.map(({ weekKey }) => weekKey))];
      for (const chunk of chunks([...new Set(entries.map(({ userId }) => userId))])) {
        const { data, error } = await supabaseAdmin
          .from("weekly_digest_dispatches")
          .select("user_id,week_key")
          .in("user_id", chunk)
          .in("week_key", weekKeys)
          // Envoyé, ou trois essais épuisés : plus rien à tenter pour cette semaine.
          .or("status.eq.sent,attempts.gte.3");
        if (error) throw error;
        for (const row of data ?? []) {
          const key = `${row.user_id}|${row.week_key}`;
          if (wanted.has(key)) settled.add(key);
        }
      }
      return settled;
    },

    async recentChangeEvents(userId, saleIds, since) {
      const events = [];
      for (const chunk of chunks(saleIds)) {
        const { data, error } = await supabaseAdmin
          .from("user_sale_change_events")
          .select("*")
          .eq("user_id", userId)
          .in("sale_id", chunk)
          .gte("detected_at", since.toISOString())
          .is("dismissed_at", null)
          .order("detected_at", { ascending: false });
        if (error) throw error;
        events.push(...(data ?? []).map(saleChangeEventRowToSummary));
      }
      return events;
    },

    async alertScope(userId) {
      const { data, error } = await supabaseAdmin
        .from("user_alerts")
        .select("department")
        .eq("user_id", userId)
        .eq("is_active", true)
        .limit(200);
      if (error) throw error;
      const departments = (data ?? [])
        .map((row) => row.department?.trim())
        .filter((department): department is string => Boolean(department));
      return { hasActiveAlert: (data ?? []).length > 0, departments: [...new Set(departments)] };
    },

    async newSalesIn(departments, since, limit) {
      if (!departments.length) return { total: 0, sales: [] };
      const { data, error } = await supabaseAdmin
        .from("v_auction_sales_app")
        .select("id,property_type,city,department,created_at")
        .in("department", departments)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(NEW_SALES_SCAN_LIMIT);
      if (error) throw error;
      const rows = (data ?? []).filter((row): row is typeof row & { id: string } =>
        Boolean(row.id),
      );
      // La vue est lue avec le rôle de service : la garde de quarantaine s'applique ici.
      const visible = await getPublicationVisibleSaleIds(rows.map((row) => row.id));
      const sales: NewSaleSummary[] = rows
        .filter((row) => visible.has(row.id))
        .map((row) => ({
          id: row.id,
          propertyType: row.property_type,
          city: row.city,
          department: row.department,
        }));
      // Le total est celui des ventes lues (NEW_SALES_SCAN_LIMIT au plus).
      return { total: sales.length, sales: sales.slice(0, limit) };
    },

    async claim({ userId, weekKey, mode, payload }) {
      const { data, error } = await supabaseAdmin.rpc("claim_weekly_digest", {
        p_user_id: userId,
        p_week_key: weekKey,
        p_mode: mode,
        p_payload: payload as Json,
      });
      if (error) throw error;
      return typeof data === "string" && data ? data : null;
    },

    async markSent(id, { messageId, at }) {
      const { error } = await supabaseAdmin
        .from("weekly_digest_dispatches")
        .update({
          status: "sent",
          message_id: messageId,
          sent_at: at.toISOString(),
          updated_at: at.toISOString(),
          error: null,
        })
        .eq("id", id);
      if (error) throw error;
    },

    async markFailed(id, { error: code }) {
      const { error } = await supabaseAdmin
        .from("weekly_digest_dispatches")
        .update({ status: "failed", error: code, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
  };
}

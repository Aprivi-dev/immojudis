import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { readUserEmail } from "@/lib/email-alerts";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import { saleChangeEventRowToSummary } from "@/lib/sale-change-monitor";
import { getPublicationVisibleSaleIds } from "@/lib/sale-publication-guard";
import type { SaleReminderStore } from "@/lib/sale-reminders";

const PAGE_SIZE = 1_000;
/** Pages lues au plus pour les favoris puis pour les ventes débloquées d'une personne. */
const MAX_FOLLOWED_PAGES = 5;
/** Garde-fou : au-delà, le passage s'arrête là (les personnes suivantes attendent le suivant). */
const MAX_CONSENTING_USERS = 10_000;
const IN_CHUNK = 100;

function chunks<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

/**
 * Dernière vérification d'une vente à la source : la plus récente entre `last_seen_at` (vente revue
 * dans l'inventaire de la source) et les `checked_at` de `raw_payload.source_checks` (contrôles de
 * source enregistrés par le pipeline). `null` quand aucune date exploitable n'existe.
 */
export function latestSourceVerification(row: {
  last_seen_at?: string | null;
  source_checks?: unknown;
}): string | null {
  const candidates: number[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const time = Date.parse(value);
    if (Number.isFinite(time)) candidates.push(time);
  };
  add(row.last_seen_at);
  const checks = row.source_checks;
  if (checks && typeof checks === "object" && !Array.isArray(checks)) {
    for (const check of Object.values(checks)) {
      if (check && typeof check === "object") add((check as { checked_at?: unknown }).checked_at);
    }
  }
  return candidates.length ? new Date(Math.max(...candidates)).toISOString() : null;
}

/**
 * Lecture et écriture réelles du cron `sale-reminders` (service_role). Les lectures qui échouent
 * lèvent une erreur : un passage qui ne peut pas lire ne conclut jamais qu'il n'y a rien à
 * rappeler.
 */
export function createSupabaseSaleReminderStore(): SaleReminderStore {
  return {
    async listConsentingUserIds() {
      const ids: string[] = [];
      for (let from = 0; from < MAX_CONSENTING_USERS; from += PAGE_SIZE) {
        const { data, error } = await supabaseAdmin
          .from("user_notification_preferences")
          .select("user_id")
          .eq("sale_reminders_enabled", true)
          .not("sale_reminders_consented_at", "is", null)
          .order("user_id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        ids.push(...(data ?? []).map((row) => row.user_id));
        if ((data ?? []).length < PAGE_SIZE) break;
      }
      return ids;
    },

    async filterAdminUserIds(userIds) {
      const admins = new Set<string>();
      for (const chunk of chunks(userIds)) {
        const { data, error } = await supabaseAdmin
          .from("user_profiles")
          .select("user_id")
          .eq("user_role", "admin")
          .in("user_id", chunk);
        if (error) throw error;
        for (const row of data ?? []) admins.add(row.user_id);
      }
      return admins;
    },

    async followedSales(userId) {
      // Toutes les ventes suivies, page par page : le tri sur la fenêtre utile (dates proches) se
      // fait ensuite, un plafond arbitraire de lecture écarterait des ventes au hasard.
      const readIds = async (
        page: (
          from: number,
          to: number,
        ) => PromiseLike<{
          data: Array<{ sale_id: string | null }> | null;
          error: { message: string } | null;
        }>,
      ) => {
        const found: string[] = [];
        for (let index = 0; index < MAX_FOLLOWED_PAGES; index += 1) {
          const from = index * PAGE_SIZE;
          const { data, error } = await page(from, from + PAGE_SIZE - 1);
          if (error) throw error;
          found.push(
            ...(data ?? []).map((row) => row.sale_id).filter((id) => typeof id === "string"),
          );
          if ((data ?? []).length < PAGE_SIZE) break;
        }
        return found;
      };
      const [favoriteIds, unlockIds] = await Promise.all([
        readIds((from, to) =>
          supabaseAdmin
            .from("user_favorites")
            .select("sale_id")
            .eq("user_id", userId)
            .order("created_at", { ascending: true })
            .range(from, to),
        ),
        readIds((from, to) =>
          supabaseAdmin
            .from("user_sale_unlocks")
            .select("sale_id")
            .eq("user_id", userId)
            .not("sale_id", "is", null)
            .order("created_at", { ascending: true })
            .range(from, to),
        ),
      ]);
      const ids = [...new Set([...favoriteIds, ...unlockIds])];
      const sales: Array<{ id: string; saleDate: string | null }> = [];
      for (const chunk of chunks(ids)) {
        const { data, error } = await supabaseAdmin
          .from("auction_sales")
          .select("id,sale_date")
          .in("id", chunk);
        if (error) throw error;
        for (const row of data ?? []) sales.push({ id: row.id, saleDate: row.sale_date });
      }
      return sales;
    },

    async lastVerifiedAt(saleIds) {
      const verified = new Map<string, string | null>();
      for (const chunk of chunks(saleIds)) {
        const { data, error } = await supabaseAdmin
          .from("auction_sales")
          .select("id,last_seen_at,source_checks:raw_payload->source_checks")
          .in("id", chunk);
        if (error) throw error;
        for (const row of data ?? []) verified.set(row.id, latestSourceVerification(row));
      }
      return verified;
    },

    visibleSaleIds: (saleIds) => getPublicationVisibleSaleIds(saleIds),

    async calendarEvent(saleId) {
      const { data, error } = await supabaseAdmin.rpc("get_public_sale_calendar_event", {
        p_sale_id: saleId,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as unknown as SaleCalendarRow | undefined;
      return row ?? null;
    },

    async recentChangeEvents(userId, saleIds, since) {
      const events = [];
      for (const chunk of chunks(saleIds)) {
        const { data, error } = await supabaseAdmin
          .from("user_sale_change_events")
          .select("*")
          .eq("user_id", userId)
          .in("event_kind", ["audience_changed", "status_changed"])
          .in("sale_id", chunk)
          .gte("detected_at", since.toISOString())
          .is("dismissed_at", null)
          .order("detected_at", { ascending: false });
        if (error) throw error;
        events.push(...(data ?? []).map(saleChangeEventRowToSummary));
      }
      return events;
    },

    async claim({ userId, saleId, kind, dedupeKey, mode, payload }) {
      const { data, error } = await supabaseAdmin.rpc("claim_sale_reminder", {
        p_user_id: userId,
        p_sale_id: saleId,
        p_kind: kind,
        p_key: dedupeKey,
        p_mode: mode,
        p_payload: payload as Json,
      });
      if (error) throw error;
      return typeof data === "string" && data ? data : null;
    },

    async markSent(ids, { messageId, at }) {
      if (!ids.length) return;
      const { error } = await supabaseAdmin
        .from("sale_reminder_dispatches")
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

    async markFailed(ids, { error: detail }) {
      if (!ids.length) return;
      const { error } = await supabaseAdmin
        .from("sale_reminder_dispatches")
        .update({ status: "failed", error: detail, updated_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },

    userEmail: (userId) => readUserEmail(userId),

    async purgeJournal() {
      const { data, error } = await supabaseAdmin.rpc("purge_sale_reminder_dispatches");
      if (error) throw error;
      return typeof data === "number" ? data : 0;
    },
  };
}

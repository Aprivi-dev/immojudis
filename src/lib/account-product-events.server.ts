import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";

/**
 * Mesure du parcours par compte, côté serveur (point 65). Complète `product-events.ts` (navigateur,
 * Vercel Analytics, sans identifiant) : ici l'événement est rattaché au compte, enregistré dans
 * `account_product_events` et lu seulement en agrégats par la page admin « Pilotage ».
 *
 * Règles :
 * - liste fermée d'événements, chacun avec ses seules propriétés : identifiant de vente quand il sert,
 *   détail fermé (quel quota, quel email). Aucune donnée libre, aucune adresse IP ;
 * - sans compte (identifiant absent ou invalide), rien n'est enregistré ;
 * - un événement identique d'un même compte n'est gardé qu'une fois par jour (la base arbitre) ;
 * - la mesure ne gêne jamais le parcours : une erreur est journalisée sans contenu et avalée ;
 * - ordre de déploiement : tant que la migration 20261029120100 n'est pas appliquée, la base refuse les
 *   détails `daily_account` et `daily_shared` (contrainte, SQLSTATE 23514) : l'événement est alors
 *   réessayé avec l'ancien détail `daily`, que la base accepte toujours.
 *
 * Conservation : 90 jours, purgés par `run_data_retention` (voir la migration 20261028180100).
 */

export type AccountProductEvent =
  | { type: "sale_unlocked"; saleId: string }
  | {
      type: "quota_reached";
      /**
       * `daily_account` : plafond journalier du compte ; `daily_shared` : plafond de son adresse ou du
       * site entier. `daily` n'existe que dans les lignes d'avant cette distinction.
       */
      quota: "unlocks" | "favorites" | "daily" | "daily_account" | "daily_shared";
    }
  | { type: "bid_ceiling_calculated"; saleId: string }
  | { type: "pepite_detail_served"; saleId: string }
  | { type: "calendar_exported"; saleId: string }
  | { type: "email_clicked"; email: "alert" | "reminder" | "weekly" | "result"; saleId: string };

const uuidSchema = z.string().guid();

/** Colonnes `event_type`, `detail` et `sale_id` de la table, déduites de l'événement. */
export function accountProductEventRow(event: AccountProductEvent): {
  eventType: string;
  detail: string | null;
  saleId: string | null;
} | null {
  switch (event.type) {
    case "quota_reached":
      return { eventType: event.type, detail: event.quota, saleId: null };
    case "email_clicked": {
      const saleId = uuidSchema.safeParse(event.saleId);
      return saleId.success
        ? { eventType: event.type, detail: event.email, saleId: saleId.data.toLowerCase() }
        : null;
    }
    case "sale_unlocked":
    case "bid_ceiling_calculated":
    case "pepite_detail_served":
    case "calendar_exported": {
      const saleId = uuidSchema.safeParse(event.saleId);
      return saleId.success
        ? { eventType: event.type, detail: null, saleId: saleId.data.toLowerCase() }
        : null;
    }
    default:
      return null;
  }
}

/** Les détails ajoutés par la migration 20261029120100 : une base plus ancienne les refuse (contrainte). */
function isRefusedDailyDetail(
  row: { eventType: string; detail: string | null },
  error: unknown,
): boolean {
  return (
    row.eventType === "quota_reached" &&
    (row.detail === "daily_account" || row.detail === "daily_shared") &&
    (error as { code?: unknown } | null)?.code === "23514"
  );
}

/**
 * Enregistre un événement pour un compte. Rend vrai quand une ligne est écrite, faux sinon (pas de
 * compte, événement du jour déjà présent, erreur). Ne lève jamais.
 */
export async function recordAccountProductEvent(
  userId: string | null | undefined,
  event: AccountProductEvent,
): Promise<boolean> {
  const user = uuidSchema.safeParse(userId);
  if (!user.success) return false;
  const row = accountProductEventRow(event);
  if (!row) return false;

  const write = (detail: string | null) =>
    supabaseAdmin.rpc("record_account_product_event", {
      p_user_id: user.data,
      p_event_type: row.eventType,
      ...(detail ? { p_detail: detail } : {}),
      ...(row.saleId ? { p_sale_id: row.saleId } : {}),
    });

  try {
    let { data, error } = await write(row.detail);
    if (error && isRefusedDailyDetail(row, error)) {
      // Base sans la migration 20261029120100 : le plafond quotidien reste compté, sous l'ancien détail.
      ({ data, error } = await write("daily"));
    }
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "account-product-events",
        event: event.type,
        error: errorDetailForLog(error),
      }),
    );
    return false;
  }
}

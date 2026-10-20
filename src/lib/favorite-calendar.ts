import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  buildSalesCalendarFile,
  type SaleCalendarFile,
  type SaleCalendarRow,
} from "@/lib/sale-calendar";
import { PLANNING_CALENDAR_MAX_SALES } from "@/lib/favorite-planning";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Export `.ics` de toutes les audiences suivies, en un fichier (« Mon planning », `/favoris`).
 *
 * Au plus 50 ventes par fichier : c'est aussi le plafond quotidien des événements `calendar_exported`
 * d'un compte (migration 20261029100300), donc un export complet ne dépasse jamais la mesure. Les
 * garde-fous sont ceux de l'export d'une seule audience : chaque vente suivie est relue avec la clé
 * anonyme par `get_public_sale_calendar_event` (vente publiquement visible, audience au tribunal à
 * date sourcée) ; une date passée, reportée, contradictoire ou sans source n'entre pas dans le
 * fichier, jamais écrite « à confirmer ».
 */
const FAVORITE_CALENDAR_MAX_SALES = PLANNING_CALENDAR_MAX_SALES;

/** Lectures simultanées de la fonction publique : assez pour 50 ventes sans saturer la base. */
const RPC_BATCH_SIZE = 10;

export const favoriteCalendarInputSchema = z.object({
  saleIds: z.array(z.string().uuid()).min(1).max(FAVORITE_CALENDAR_MAX_SALES),
});

type FavoriteCalendarResult = {
  /** Le fichier, ou `null` quand aucune des ventes suivies n'est exportable. */
  file: (SaleCalendarFile & { exportedIds: string[] }) | null;
  /** Ventes demandées qui sont bien dans les favoris du compte. */
  followed: number;
  /** Ventes suivies laissées de côté : date non exportable ou vente non publique. */
  skipped: number;
};

type RpcError = { code?: string; message?: string } | null;

function isMissingFunction(error: RpcError): boolean {
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    /get_public_sale_calendar_event/.test(error?.message ?? "")
  );
}

/**
 * Les ventes demandées que le compte suit vraiment : la RLS de `user_favorites` ne rend que les
 * lignes du propriétaire, et le filtre `user_id` en est la même règle côté application.
 */
async function followedSaleIds(
  auth: SupabaseAuthContext,
  saleIds: readonly string[],
): Promise<string[]> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select("sale_id")
    .eq("user_id", auth.userId)
    .in("sale_id", [...saleIds]);
  if (error) throw error;
  return data.map((row) => row.sale_id.toLowerCase());
}

async function readCalendarRows(saleIds: readonly string[]): Promise<SaleCalendarRow[]> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Base de données non configurée.");
  const rows: SaleCalendarRow[] = [];
  for (let start = 0; start < saleIds.length; start += RPC_BATCH_SIZE) {
    const batch = saleIds.slice(start, start + RPC_BATCH_SIZE);
    const answers = await Promise.all(
      batch.map((saleId) => client.rpc("get_public_sale_calendar_event", { p_sale_id: saleId })),
    );
    for (const { data, error } of answers) {
      if (error) {
        // La migration n'est pas déployée : pas d'export plutôt qu'une date devinée.
        if (isMissingFunction(error)) throw new Error("Calendrier non configuré.");
        throw error;
      }
      const row = (Array.isArray(data) ? data[0] : data) as SaleCalendarRow | null | undefined;
      if (row) rows.push(row);
    }
  }
  return rows;
}

export async function exportFollowedCalendar({
  auth,
  saleIds,
  origin,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  saleIds: readonly string[];
  origin: string;
  now?: Date;
}): Promise<FavoriteCalendarResult> {
  const requested = [...new Set(saleIds.map((id) => id.toLowerCase()))].slice(
    0,
    FAVORITE_CALENDAR_MAX_SALES,
  );
  const followed = await followedSaleIds(auth, requested);
  const rows = followed.length > 0 ? await readCalendarRows(followed) : [];
  const file = buildSalesCalendarFile(rows, { origin, now });
  return {
    file,
    followed: followed.length,
    skipped: followed.length - (file?.exportedIds.length ?? 0),
  };
}

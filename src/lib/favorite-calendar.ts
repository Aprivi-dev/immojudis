import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  buildSaleDeadlinesCalendarFile,
  buildSalesCalendarFile,
  type SaleCalendarFile,
  type SaleCalendarRow,
} from "@/lib/sale-calendar";
import { PLANNING_CALENDAR_MAX_SALES } from "@/lib/favorite-planning";
import { assertSaleFavoritesAvailable } from "@/lib/favorites";
import { PublicApiError } from "@/lib/api-errors";
import { saleDeadlines } from "@/lib/sale-deadlines";
import { DETAIL_VIEW } from "@/lib/sale-views";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";
import { visitSlots, type VisitSlot } from "@/lib/visit-slots";
import { isMissingCalendarFunction as isMissingFunction } from "@/lib/sale-calendar-rpc";

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

export const favoriteCalendarInputSchema = z.union([
  z.object({ saleIds: z.array(z.string().guid()).min(1).max(FAVORITE_CALENDAR_MAX_SALES) }),
  /** L'échéancier indicatif d'une vente passée remportée (un instantané du compte). */
  z.object({ deadlinesSnapshotId: z.string().guid() }),
]);

type FavoriteCalendarResult = {
  /** Le fichier, ou `null` quand aucune des ventes suivies n'est exportable. */
  file: (SaleCalendarFile & { exportedIds: string[] }) | null;
  /** Ventes demandées qui sont bien dans les favoris du compte. */
  followed: number;
  /** Ventes suivies laissées de côté : date non exportable ou vente non publique. */
  skipped: number;
};

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

/**
 * Les créneaux de visite des ventes exportées, lus avec la vue du compte (la plus restreinte, celle
 * d'un compte Découverte : les créneaux y sont déjà publiés, aucune pièce ni adresse n'est lue ici).
 * Une panne de lecture n'empêche pas l'export des audiences : le fichier sort alors sans visites.
 */
async function readVisitSlots(
  auth: SupabaseAuthContext,
  saleIds: readonly string[],
): Promise<Map<string, VisitSlot[]>> {
  const slots = new Map<string, VisitSlot[]>();
  if (saleIds.length === 0) return slots;
  const { data, error } = await auth.supabase
    .from("v_auction_sales_discovery" as typeof DETAIL_VIEW)
    .select("id, visit_dates")
    .in("id", [...saleIds]);
  if (error || !Array.isArray(data)) return slots;
  for (const row of data as unknown as Array<{ id: string; visit_dates: unknown }>) {
    if (typeof row?.id !== "string") continue;
    const parsed = visitSlots(row.visit_dates);
    if (parsed.length > 0) slots.set(row.id.toLowerCase(), parsed);
  }
  return slots;
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
  // Les visites ne concernent que les ventes dont l'audience est exportable.
  const visits = await readVisitSlots(
    auth,
    rows.filter((row) => row.exportable).map((row) => row.id.toLowerCase()),
  );
  const file = buildSalesCalendarFile(rows, { origin, now, visitSlots: visits });
  return {
    file,
    followed: followed.length,
    skipped: followed.length - (file?.exportedIds.length ?? 0),
  };
}

type SnapshotDeadlinesRow = {
  sale_id: string;
  sale_date: string | null;
  sale_venue_type: string | null;
  sale_legal_framework: string | null;
  property_type: string | null;
  city: string | null;
  personal_status: string | null;
};

/**
 * L'échéancier indicatif (fin du délai de surenchère, paiement du prix) d'une vente passée que le
 * compte a marquée « Remporté » : un fichier `.ics` de deux dates à confirmer avec son avocat.
 *
 * Lu dans l'instantané du compte (la RLS ne rend que ses lignes, le filtre `user_id` en est la même
 * règle côté application), pas dans le catalogue : la vente en est partie à l'heure de l'audience. Le
 * fichier ne porte ni prix ni adresse. Refus (409) pour une vente non remportée ou d'une procédure
 * autre que la saisie immobilière, dont les délais ne sont pas ceux des articles cités.
 */
export async function exportSnapshotDeadlines({
  auth,
  snapshotId,
  origin,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  snapshotId: string;
  origin: string;
  now?: Date;
}): Promise<SaleCalendarFile> {
  await assertSaleFavoritesAvailable(auth);
  const { data, error } = await auth.supabase
    .from("user_followed_sale_snapshots")
    .select(
      "sale_id,sale_date,sale_venue_type,sale_legal_framework,property_type,city,personal_status",
    )
    .eq("user_id", auth.userId)
    .eq("id", snapshotId)
    .gt("expires_at", now.toISOString())
    .maybeSingle();
  if (error) throw error;
  const row = data as SnapshotDeadlinesRow | null;
  if (!row) throw new PublicApiError("Vente passée introuvable.", 404);
  if (row.personal_status !== "won") {
    throw new PublicApiError(
      "L’échéancier concerne une vente que vous avez marquée « Remporté ».",
      409,
    );
  }
  const deadlines = saleDeadlines({
    saleDate: row.sale_date,
    venueType: row.sale_venue_type,
    legalFramework: row.sale_legal_framework,
    now,
  });
  const file = buildSaleDeadlinesCalendarFile(
    { saleId: row.sale_id, deadlines, propertyType: row.property_type, city: row.city },
    { origin, now },
  );
  if (!file) {
    throw new PublicApiError(
      "Nous ne calculons pas d’échéancier pour cette vente : il ne vise que les saisies immobilières au tribunal, et d’autres délais peuvent s’appliquer. Demandez-les à votre avocat.",
      409,
    );
  }
  return file;
}

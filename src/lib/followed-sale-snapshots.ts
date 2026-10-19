import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { assertSaleFavoritesAvailable } from "@/lib/favorites";
import {
  toFollowedSaleSnapshot,
  type FollowedSaleSnapshotDeleteResponse,
  type FollowedSaleSnapshotsResponse,
} from "@/lib/followed-sale-snapshots-shared";

const SNAPSHOT_COLUMNS =
  "id,sale_id,captured_at,expires_at,title,city,department,postal_code,property_type,tribunal_name,sale_venue_type,starting_price_eur,sale_date,lawyer_name,source_name,result_status,adjudication_price_eur,adjudication_price_source,adjudication_price_withheld,personal_status,bid_ceiling_eur";

/** Même plafond que la liste des favoris Analyse : l'instantané est de toute façon borné à 6 mois. */
const SNAPSHOT_LIST_LIMIT = 200;

/**
 * Ventes suivies dont l'audience est passée (point 70), lues dans l'espace du compte. La RLS limite
 * la lecture aux lignes du propriétaire ; le filtre `user_id` est la même règle côté application.
 * Une ligne dont la conservation est échue (purge hebdomadaire en attente) n'est pas rendue.
 */
export async function listFollowedSaleSnapshots({
  auth,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  now?: Date;
}): Promise<FollowedSaleSnapshotsResponse> {
  await assertSaleFavoritesAvailable(auth);
  const { data, error } = await auth.supabase
    .from("user_followed_sale_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("user_id", auth.userId)
    .gt("expires_at", now.toISOString())
    .order("sale_date", { ascending: false, nullsFirst: false })
    .limit(SNAPSHOT_LIST_LIMIT);
  if (error) throw error;
  return { snapshots: (data ?? []).map((row) => toFollowedSaleSnapshot(row, now)) };
}

/** La personne retire un instantané de son espace, à tout moment. */
export async function deleteFollowedSaleSnapshot({
  auth,
  id,
}: {
  auth: SupabaseAuthContext;
  id: string;
}): Promise<FollowedSaleSnapshotDeleteResponse> {
  await assertSaleFavoritesAvailable(auth);
  const { data, error } = await auth.supabase
    .from("user_followed_sale_snapshots")
    .delete()
    .eq("user_id", auth.userId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return { ok: true, removed: Boolean(data) };
}

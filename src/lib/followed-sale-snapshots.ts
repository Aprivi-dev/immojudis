import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { assertSaleFavoritesAvailable } from "@/lib/favorites";
import {
  toFollowedSaleSnapshot,
  type FollowedSaleSnapshotDeleteResponse,
  type FollowedSaleSnapshotResponse,
  type FollowedSaleSnapshotsResponse,
  type FollowedSaleSnapshotUpdatePayload,
} from "@/lib/followed-sale-snapshots-shared";
import { statusAllowsFinalPrice } from "@/lib/snapshot-balance";

const SNAPSHOT_COLUMNS =
  "id,sale_id,captured_at,expires_at,title,city,department,property_type,tribunal_name,sale_venue_type,sale_legal_framework,starting_price_eur,sale_date,lawyer_name,source_name,result_status,adjudication_price_eur,adjudication_price_source,adjudication_price_withheld,personal_status,bid_ceiling_eur,final_price_eur";

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

/**
 * Bilan après adjudication (n° 94) : la personne note son statut et le prix final de l'adjudication
 * sur l'instantané de la vente. Seules ces deux colonnes sont modifiables (droits de colonne et RLS
 * « propriétaire seul », migration 20261110160000) ; le filtre `user_id` est la même règle côté
 * application. Un prix final n'est accepté que pour « Remporté » ou « Non remporté » : le statut de
 * la demande, à défaut celui déjà enregistré. Le prix n'est ni envoyé par email ni recoupé avec un
 * autre compte.
 */
export async function updateFollowedSaleSnapshot({
  auth,
  input,
  now = new Date(),
}: {
  auth: SupabaseAuthContext;
  input: FollowedSaleSnapshotUpdatePayload;
  now?: Date;
}): Promise<FollowedSaleSnapshotResponse> {
  await assertSaleFavoritesAvailable(auth);

  const changes: { personal_status?: string | null; final_price_eur?: number | null } = {};
  if (input.personalStatus !== undefined) changes.personal_status = input.personalStatus;
  if (input.finalPriceEur !== undefined) changes.final_price_eur = input.finalPriceEur;

  if (input.finalPriceEur != null) {
    let status: string | null | undefined = input.personalStatus;
    if (status === undefined) {
      const { data, error } = await auth.supabase
        .from("user_followed_sale_snapshots")
        .select("personal_status")
        .eq("user_id", auth.userId)
        .eq("id", input.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new PublicApiError("Vente passée introuvable.", 404);
      status = data.personal_status;
    }
    if (!statusAllowsFinalPrice(status)) {
      throw new PublicApiError(
        "Le prix final se note pour une vente marquée « Remporté » ou « Non remporté ».",
        400,
      );
    }
  }

  const { data, error } = await auth.supabase
    .from("user_followed_sale_snapshots")
    .update(changes)
    .eq("user_id", auth.userId)
    .eq("id", input.id)
    .gt("expires_at", now.toISOString())
    .select(SNAPSHOT_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PublicApiError("Vente passée introuvable.", 404);
  return { snapshot: toFollowedSaleSnapshot(data, now) };
}

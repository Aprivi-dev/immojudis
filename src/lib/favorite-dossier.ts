import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { assertSaleFavoritesAvailable } from "@/lib/favorites";
import {
  emptyFavoriteDossier,
  toFavoriteDossier,
  type FavoriteDossierPayload,
  type FavoriteDossierResponse,
  type FavoriteDossierRow,
} from "@/lib/favorite-dossier-shared";
import { validEnteredSurface } from "@/lib/surface";

const DOSSIER_COLUMNS =
  "sale_id,personal_status,personal_status_updated_at,bid_ceiling_eur,bid_ceiling_saved_at,user_surface_m2";

/**
 * « Mon dossier » gratuit (point 68) : lit le statut, le plafond et la surface saisie du compte sur une
 * vente suivie. Ouvert à tout compte qui a les favoris (Découverte comprise). Une vente non suivie rend
 * un dossier vide (`followed: false`).
 */
export async function getFavoriteDossier({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<FavoriteDossierResponse> {
  await assertSaleFavoritesAvailable(auth);
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select(DOSSIER_COLUMNS)
    .eq("user_id", auth.userId)
    .eq("sale_id", saleId)
    .maybeSingle<FavoriteDossierRow>();
  if (error) throw error;
  return { dossier: data ? toFavoriteDossier(data) : emptyFavoriteDossier(saleId) };
}

/**
 * Surface que le compte a lue dans les pièces et saisie dans « Mon dossier » pour cette vente, ou
 * `null` (vente non suivie, aucune saisie). La RLS de `user_favorites`
 * (propriétaire seul) tient la frontière ; le filtre `user_id` est la même règle côté application.
 */
export async function getFavoriteEnteredSurface({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<number | null> {
  const { data, error } = await auth.supabase
    .from("user_favorites")
    .select("user_surface_m2")
    .eq("user_id", auth.userId)
    .eq("sale_id", saleId)
    .maybeSingle<{ user_surface_m2: number | string | null }>();
  if (error) throw error;
  const value = data?.user_surface_m2 == null ? null : Number(data.user_surface_m2);
  return validEnteredSurface(value);
}

/**
 * Enregistre le statut, le plafond et/ou la surface saisie sur la ligne de favori du compte. Rien n'est
 * écrit pour une vente non suivie : la personne la suit d'abord. Les champs absents de la demande ne
 * sont pas touchés ; `null` efface. La RLS (propriétaire seul, trois colonnes modifiables) tient la
 * frontière en base ; le filtre `user_id` ci-dessous est la même règle, côté application. La surface
 * n'est écrite que sur cette ligne : jamais dans le catalogue.
 */
export async function saveFavoriteDossier({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: FavoriteDossierPayload;
}): Promise<FavoriteDossierResponse> {
  await assertSaleFavoritesAvailable(auth);

  const changes: {
    personal_status?: string | null;
    bid_ceiling_eur?: number | null;
    user_surface_m2?: number | null;
  } = {};
  if (input.personalStatus !== undefined) changes.personal_status = input.personalStatus;
  if (input.bidCeilingEur !== undefined) changes.bid_ceiling_eur = input.bidCeilingEur;
  if (input.userSurfaceM2 !== undefined) changes.user_surface_m2 = input.userSurfaceM2;

  const { data, error } = await auth.supabase
    .from("user_favorites")
    .update(changes)
    .eq("user_id", auth.userId)
    .eq("sale_id", input.saleId)
    .select(DOSSIER_COLUMNS)
    .maybeSingle<FavoriteDossierRow>();
  if (error) throw error;
  if (!data) {
    throw new PublicApiError(
      "Suivez d’abord cette vente (le cœur) pour enregistrer votre dossier.",
      404,
    );
  }
  return { dossier: toFavoriteDossier(data) };
}

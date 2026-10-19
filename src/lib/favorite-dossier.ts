import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { assertSaleFavoritesAvailable } from "@/lib/favorites";
import {
  emptyFavoriteDossier,
  toFavoriteDossier,
  type FavoriteDossierPayload,
  type FavoriteDossierResponse,
} from "@/lib/favorite-dossier-shared";

const DOSSIER_COLUMNS =
  "sale_id,personal_status,personal_status_updated_at,bid_ceiling_eur,bid_ceiling_saved_at";

/**
 * « Mon dossier » gratuit (point 68) : lit le statut et le plafond du compte sur une vente suivie.
 * Ouvert à tout compte qui a les favoris (Découverte comprise). Une vente non suivie rend un dossier
 * vide (`followed: false`).
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
    .maybeSingle();
  if (error) throw error;
  return { dossier: data ? toFavoriteDossier(data) : emptyFavoriteDossier(saleId) };
}

/**
 * Enregistre le statut et/ou le plafond sur la ligne de favori du compte. Rien n'est écrit pour une
 * vente non suivie : la personne la suit d'abord. Les champs absents de la demande ne sont pas
 * touchés ; `null` efface. La RLS (propriétaire seul, deux colonnes modifiables) tient la frontière
 * en base ; le filtre `user_id` ci-dessous est la même règle, côté application.
 */
export async function saveFavoriteDossier({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: FavoriteDossierPayload;
}): Promise<FavoriteDossierResponse> {
  await assertSaleFavoritesAvailable(auth);

  const changes: { personal_status?: string | null; bid_ceiling_eur?: number | null } = {};
  if (input.personalStatus !== undefined) changes.personal_status = input.personalStatus;
  if (input.bidCeilingEur !== undefined) changes.bid_ceiling_eur = input.bidCeilingEur;

  const { data, error } = await auth.supabase
    .from("user_favorites")
    .update(changes)
    .eq("user_id", auth.userId)
    .eq("sale_id", input.saleId)
    .select(DOSSIER_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new PublicApiError(
      "Suivez d’abord cette vente (le cœur) pour enregistrer votre dossier.",
      404,
    );
  }
  return { dossier: toFavoriteDossier(data) };
}

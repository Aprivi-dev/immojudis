import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRecord } from "@/lib/guards";
import { isMissingPepiteFunction } from "@/lib/pepite-sale-ids";
import type { PublicSupabaseClient } from "@/lib/supabase-public.server";

/**
 * Lecture du repère « Pépite » d'UNE vente pour la route `GET /api/sales/[id]/pepite`.
 *
 *  - `isPublishedPepite` : la fonction publique `get_public_sale_pepite` (vrai seulement en mode « on » et si la
 *    vente est publiable à l'instant de l'appel). C'est LE contrôle : sans elle, rien n'est lu ni rendu.
 *  - `readStoredPepite` : la ligne privée (`auction_sale_pepites`, service_role seul) : codes de motif et détail.
 *    Appelée seulement après le contrôle ci-dessus ; le niveau « criteria » n'en prend que les codes de motif.
 */
export async function isPublishedPepite(
  client: PublicSupabaseClient,
  saleId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("get_public_sale_pepite", { p_sale_id: saleId });
  if (error) {
    // Fonction absente (migration pas encore appliquée) : « pas de pépite ».
    if (isMissingPepiteFunction(error)) return false;
    throw error;
  }
  return data === true;
}

export type StoredPepite = {
  reasonCodes: string[];
  details: Record<string, unknown>;
  evaluatedAt: string | null;
};

export async function readStoredPepite(saleId: string): Promise<StoredPepite | null> {
  const { data, error } = await supabaseAdmin
    .from("auction_sale_pepites")
    .select("reason_codes, details, evaluated_at")
    .eq("sale_id", saleId)
    .eq("is_pepite", true)
    .maybeSingle();
  if (error) {
    if (isMissingPepiteFunction(error) || error.code === "42P01") return null;
    throw error;
  }
  if (!data) return null;
  return {
    reasonCodes: Array.isArray(data.reason_codes)
      ? data.reason_codes.filter((code): code is string => typeof code === "string")
      : [],
    details: asRecord(data.details),
    evaluatedAt: typeof data.evaluated_at === "string" ? data.evaluated_at : null,
  };
}

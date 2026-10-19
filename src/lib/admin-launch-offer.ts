import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resetLaunchOfferCache } from "@/lib/launch-offer.server";

/**
 * Interrupteur de l'offre de lancement pour l'administrateur (page /admin/clients).
 *
 * Même protection que les autres actions admin : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`), puis le RPC `set_launch_offer`, exécuté avec le compte de
 * l'administrateur et refusé par la base à tout autre (`public.is_admin()`). Aucune écriture dans les
 * comptes : couper l'offre ramène chacun à son offre réelle.
 */
export const adminLaunchOfferActionSchema = z.object({ active: z.boolean() }).strict();
export type AdminLaunchOfferAction = z.infer<typeof adminLaunchOfferActionSchema>;

export type AdminLaunchOfferState = { active: boolean };

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

/** Lecture directe dans la base (sans le cache de 30 s des pages) : l'administrateur voit l'état réel. */
export async function getAdminLaunchOffer(authToken: string): Promise<AdminLaunchOfferState> {
  await requireAdmin(authToken);
  const { data, error } = await supabaseAdmin.rpc("get_launch_offer_status");
  if (error) throw error;
  return { active: data === true };
}

export async function setAdminLaunchOffer({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminLaunchOfferAction;
}): Promise<AdminLaunchOfferState> {
  const auth = await requireAdmin(authToken);
  const { data, error } = await auth.supabase.rpc("set_launch_offer", { p_active: input.active });
  if (error) throw error;
  // Le cache de ce processus est oublié tout de suite ; les autres instances et le CDN
  // rattrapent en 30 s au plus (voir `launch-offer.server.ts`).
  resetLaunchOfferCache();
  console.info(
    JSON.stringify({ scope: "admin.launch-offer", userId: auth.userId, active: data === true }),
  );
  return { active: data === true };
}

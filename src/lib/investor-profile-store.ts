import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { InvestorProfilePayload } from "@/lib/investor-profile-input";
import {
  toInvestorProfile,
  type InvestorProfileDeleteResponse,
  type InvestorProfileResponse,
} from "@/lib/investor-profile";

const PROFILE_COLUMNS = "down_payment_eur,target_margin_pct,works_per_m2_eur,strategy";

/**
 * Profil d'investisseur du compte (n° 93). La table `user_investor_profiles` n'a aucun droit pour
 * anon ni authenticated (invariant des tables récentes, voir la migration 20261110160100) : elle se lit
 * et s'écrit avec le rôle de service, et CHAQUE requête ci-dessous est filtrée sur `auth.userId`, le
 * compte authentifié de la requête. Ne jamais ajouter ici une requête sans ce filtre.
 */
export async function getInvestorProfile({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<InvestorProfileResponse> {
  const { data, error } = await supabaseAdmin
    .from("user_investor_profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) throw error;
  return { profile: data ? toInvestorProfile(data) : null };
}

/**
 * Remplace le profil du compte (une ligne par compte). Mise à jour d'abord, création si la ligne
 * n'existe pas : pas d'`upsert`, dont la clause « on conflict do update » réécrirait aussi `user_id`,
 * colonne que le compte n'a pas le droit de modifier.
 */
export async function saveInvestorProfile({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: InvestorProfilePayload;
}): Promise<InvestorProfileResponse> {
  const values = {
    down_payment_eur: input.downPaymentEur ?? null,
    target_margin_pct: input.targetMarginPct ?? null,
    works_per_m2_eur: input.worksPerM2Eur ?? null,
    strategy: input.strategy ?? null,
  };
  const update = () =>
    supabaseAdmin
      .from("user_investor_profiles")
      .update(values)
      .eq("user_id", auth.userId)
      .select(PROFILE_COLUMNS)
      .maybeSingle();

  const updated = await update();
  if (updated.error) throw updated.error;
  if (updated.data) return { profile: toInvestorProfile(updated.data) };

  const inserted = await supabaseAdmin
    .from("user_investor_profiles")
    .insert({ user_id: auth.userId, ...values })
    .select(PROFILE_COLUMNS)
    .single();
  if (!inserted.error) return { profile: toInvestorProfile(inserted.data) };
  // Deux enregistrements simultanés : l'autre a créé la ligne entre-temps, on la met à jour.
  if (inserted.error.code !== "23505") throw inserted.error;
  const retried = await update();
  if (retried.error) throw retried.error;
  if (!retried.data) throw inserted.error;
  return { profile: toInvestorProfile(retried.data) };
}

/** La personne efface son profil, à tout moment. */
export async function deleteInvestorProfile({
  auth,
}: {
  auth: SupabaseAuthContext;
}): Promise<InvestorProfileDeleteResponse> {
  const { data, error } = await supabaseAdmin
    .from("user_investor_profiles")
    .delete()
    .eq("user_id", auth.userId)
    .select("user_id")
    .maybeSingle();
  if (error) throw error;
  return { ok: true, removed: Boolean(data) };
}

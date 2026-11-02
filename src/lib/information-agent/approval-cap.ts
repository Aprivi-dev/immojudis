import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startOfParisDay } from "@/lib/information-agent/paris-time";

/**
 * Plafond de validations par administrateur et par jour (jour calendaire de Paris). Un administrateur qui
 * valide à la chaîne sans relire est un risque pour la réputation d'expéditeur : au-delà du plafond, l'envoi
 * est refusé jusqu'au lendemain. Réglable par `INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP` (entier positif).
 */
export const DEFAULT_ADMIN_DAILY_APPROVAL_CAP = 30;

export function adminDailyApprovalCap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(env.INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_ADMIN_DAILY_APPROVAL_CAP;
}

export function adminDailyApprovalCapMessage(cap: number): string {
  return `Plafond de ${cap} validations par jour atteint : les envois reprennent demain.`;
}

export async function assertAdminDailyApprovalCap(
  adminId: string,
  {
    env = process.env,
    now = new Date(),
  }: { env?: Readonly<Record<string, string | undefined>>; now?: Date } = {},
): Promise<void> {
  const cap = adminDailyApprovalCap(env);
  const { count, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", adminId)
    .gte("approved_at", startOfParisDay(now).toISOString());
  if (error) throw error;
  if ((count ?? 0) >= cap) throw new Error(adminDailyApprovalCapMessage(cap));
}

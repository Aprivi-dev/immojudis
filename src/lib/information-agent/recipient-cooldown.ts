import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS } from "@/lib/information-agent-compliance";
import { normalizedEmail } from "@/lib/information-agent/contacts";

const COOLDOWN_BLOCKING_MISSION_STATUSES = [
  "approved",
  "sending",
  "sent",
  "replied",
  "completed",
] as const;

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * One email per recipient and per 30 days, all sales combined (plan P4-12). Counts every other
 * mission to the same address that was approved in the window and not failed. With `approvedAt`
 * (post-approval check) only strictly older approvals count, which makes concurrent approvals
 * deterministic: the earliest one proceeds, the others stand down.
 */
export async function assertInformationAgentRecipientCooldown({
  email,
  missionId,
  approvedAt,
  now = new Date(),
}: {
  email: string;
  missionId: string;
  approvedAt?: string | null;
  now?: Date;
}): Promise<void> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  const since = new Date(
    now.getTime() - INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("id,approved_at")
    .ilike("recipient_email", escapeIlike(normalized))
    .in("status", [...COOLDOWN_BLOCKING_MISSION_STATUSES])
    .neq("id", missionId)
    .gte("approved_at", since);
  if (approvedAt) query = query.lte("approved_at", approvedAt);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  if (data?.length) {
    throw new Error(
      `Ce destinataire a déjà été sollicité au cours des ${INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS} derniers jours : un seul email est autorisé par période.`,
    );
  }
}

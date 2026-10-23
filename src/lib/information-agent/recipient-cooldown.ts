import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  formatInformationAgentOriginDate,
  INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS,
} from "@/lib/information-agent-compliance";
import { normalizedEmail } from "@/lib/information-agent/contacts";

const COOLDOWN_BLOCKING_MISSION_STATUSES = [
  "approved",
  "sending",
  "sent",
  "replied",
  "completed",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * One email per recipient and per 30 days, all sales combined (plan P4-12). Counts every other
 * mission approved in the window and not failed, sent to the same address or to the same
 * professional under another address (`identityKeys`: `contact@cabinet` then `jean.dupont@cabinet`).
 * With `approvedAt` (post-approval check) only strictly older approvals count, which makes
 * concurrent approvals deterministic: the earliest one proceeds, the others stand down. Without
 * `missionId` (draft not created yet) every mission counts. A mission whose send « needs checking »
 * (Resend timed out, the email may have gone out: `metadata.send_outcome = "unverified"`, status
 * failed) counts too, so another mission cannot send a second email to the same recipient.
 */
export async function assertInformationAgentRecipientCooldown({
  email,
  missionId,
  identityKeys = [],
  approvedAt,
  now = new Date(),
}: {
  email: string;
  missionId?: string | null;
  identityKeys?: readonly string[];
  approvedAt?: string | null;
  now?: Date;
}): Promise<void> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  const since = new Date(
    now.getTime() - INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS * DAY_MS,
  ).toISOString();
  const recent = (match: "email" | "identity", unverifiedSend = false) => {
    const base = supabaseAdmin
      .from("information_agent_missions")
      .select("id,approved_at")
      .gte("approved_at", since);
    let query = unverifiedSend
      ? base.eq("status", "failed").eq("metadata->>send_outcome", "unverified")
      : base.in("status", [...COOLDOWN_BLOCKING_MISSION_STATUSES]);
    query =
      match === "email"
        ? query.ilike("recipient_email", escapeIlike(normalized))
        : query.overlaps("recipient_identity_keys", [...identityKeys]);
    if (missionId) query = query.neq("id", missionId);
    if (approvedAt) query = query.lte("approved_at", approvedAt);
    return query.limit(50);
  };
  const results = await Promise.all([
    recent("email"),
    ...(identityKeys.length ? [recent("identity")] : []),
    recent("email", true),
    ...(identityKeys.length ? [recent("identity", true)] : []),
  ]);
  const approvals: number[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of data ?? []) {
      const time = row.approved_at ? Date.parse(row.approved_at) : Number.NaN;
      approvals.push(Number.isNaN(time) ? now.getTime() : time);
    }
  }
  if (approvals.length) {
    const last = new Date(Math.max(...approvals));
    const reopens = new Date(last.getTime() + INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS * DAY_MS);
    throw new Error(
      `Ce destinataire a déjà été sollicité le ${formatInformationAgentOriginDate(last)}, toutes ventes confondues : un seul email est autorisé par période de ${INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS} jours. Prochain envoi possible à partir du ${formatInformationAgentOriginDate(reopens)}.`,
    );
  }
}

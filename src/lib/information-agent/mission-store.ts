import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { InformationAgentInventoryItem } from "@/lib/information-agent-inventory";
import {
  INFORMATION_AGENT_QUESTIONS,
  type InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";
import type { InformationAgentRecipientKind } from "@/lib/information-agent/contact-resolution";
import { courtRegistryRecipientOrigin } from "@/lib/information-agent/court-registry-mission";
import { informationAgentRecipientProfile } from "@/lib/information-agent/recipient-profile";
import {
  UNVERIFIED_SEND_OUTCOME,
  type InformationAgentFact,
  type InformationAgentMission,
} from "@/lib/information-agent/schemas";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";

// Accès aux missions et aux dossiers de l'agent, partagés par le brouillon, l'envoi et l'aperçu.
// Extraits de `information-agent.ts` sans changement de comportement.

export type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];

export async function cancelMission({
  adminId,
  missionId,
}: {
  adminId: string;
  missionId: string;
}) {
  const mission = await loadOwnedMission(adminId, missionId);
  if (!(["draft", "failed"] as MissionRow["status"][]).includes(mission.status)) {
    throw new PublicApiError(
      "Requête invalide : un message déjà envoyé ne peut pas être annulé.",
      409,
    );
  }
  await updateMissionOrThrow(mission.id, mission.user_id, {
    status: "cancelled",
    completed_at: new Date().toISOString(),
  });
}

export async function loadOwnedMission(userId: string, missionId: string): Promise<MissionRow> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("id", missionId)
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new NotFoundError("Enquête introuvable.");
  return data;
}

export async function updateMissionOrThrow(
  missionId: string,
  userId: string,
  values: Database["public"]["Tables"]["information_agent_missions"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_missions")
    .update(values)
    .eq("id", missionId)
    .eq("user_id", userId);
  if (error) throw error;
}

export function missionFromRow(row: MissionRow): InformationAgentMission {
  return {
    id: row.id,
    caseId: row.case_id,
    saleId: row.sale_id,
    status: row.status,
    // Colonne text protégée par une contrainte CHECK : le type généré est string.
    recipientKind: row.recipient_kind as InformationAgentRecipientKind,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    subject: row.subject,
    bodyText: row.body_text,
    questionKeys: row.question_keys.filter(isQuestionKey),
    missingInformation: row.missing_information,
    inventory: inventoryFromMetadata(row.metadata),
    failureReason: row.failure_reason,
    sendOutcome:
      asObject(row.metadata).send_outcome === UNVERIFIED_SEND_OUTCOME
        ? UNVERIFIED_SEND_OUTCOME
        : null,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recipientOrigin: courtRegistryRecipientOrigin(row.metadata),
    recipientProfile: informationAgentRecipientProfile(row.metadata, row.recipient_email),
  };
}

const INVENTORY_STATUSES = new Set(["present", "to_confirm", "missing", "not_applicable"]);

function inventoryFromMetadata(metadata: Json): InformationAgentInventoryItem[] {
  const value = asObject(metadata).inventory;
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry = asObject(raw ?? null);
    const { key, label, status, detail, origin } = entry;
    if (
      typeof key !== "string" ||
      typeof label !== "string" ||
      typeof status !== "string" ||
      !INVENTORY_STATUSES.has(status) ||
      typeof detail !== "string"
    ) {
      return [];
    }
    return [
      {
        key: key as InformationAgentInventoryItem["key"],
        label,
        status: status as InformationAgentInventoryItem["status"],
        detail,
        origin: typeof origin === "string" ? origin : null,
      },
    ];
  });
}

export async function updateCaseOrThrow(
  caseId: string,
  values: Database["public"]["Tables"]["information_agent_cases"]["Update"],
) {
  const { error } = await supabaseAdmin
    .from("information_agent_cases")
    .update(values)
    .eq("id", caseId);
  if (error) throw error;
}

export async function listFactsForCases(caseIds: string[]): Promise<InformationAgentFact[]> {
  const uniqueCaseIds = [...new Set(caseIds)];
  if (!uniqueCaseIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("*")
    .in("case_id", uniqueCaseIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((fact) => ({
    id: fact.id,
    caseId: fact.case_id,
    factKey: fact.fact_key,
    displayValue: fact.display_value,
    confidence: fact.confidence,
    status: fact.status,
    evidenceExcerpt: fact.evidence_excerpt,
    createdAt: fact.created_at,
    reviewedAt: fact.reviewed_at,
  }));
}

function isQuestionKey(value: string): value is InformationAgentQuestionKey {
  return value in INFORMATION_AGENT_QUESTIONS;
}

export function asObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { InformationAgentAdminActionPayload } from "@/lib/information-agent";
import {
  detectInformationAgentContactOptOut,
  extractInformationAgentFacts,
  persistFactCandidates,
  replyTextForExtraction,
} from "@/lib/information-agent-inbound";
import { recordInformationAgentContactOpposition } from "@/lib/information-agent/contacts";

// Réponse reçue hors circuit (téléphone, courrier, autre boîte) consignée par
// un administrateur : rattachée au dossier partagé, puis extraite comme les
// réponses e-mail. Aucune action de cette chaîne n'envoie de message.

type MissionRow = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type CaseRow = Database["public"]["Tables"]["information_agent_cases"]["Row"];

export async function recordManualMissionReply({
  mission,
  input,
}: {
  mission: MissionRow;
  input: Extract<InformationAgentAdminActionPayload, { action: "record_reply" }>;
}) {
  if (!(["sent", "replied"] as MissionRow["status"][]).includes(mission.status)) {
    throw new Error("Requête invalide : aucune réponse ne peut être rattachée à cette enquête.");
  }
  const sharedCase = await loadManualReplyCase(mission);
  const bodyText = input.bodyText.trim();
  const subject = (input.subject ?? `Re: ${mission.subject}`).slice(0, 200);
  const replyHash = createHash("sha256")
    .update(
      JSON.stringify({
        missionId: mission.id,
        caseId: sharedCase.id,
        subject,
        bodyText,
      }),
    )
    .digest("hex");
  const providerMessageId = `manual:${mission.id}:${replyHash}`;
  const receivedAt = new Date().toISOString();
  const message = await insertOrLoadManualReplyMessage({
    mission,
    sharedCase,
    providerMessageId,
    subject,
    bodyText,
    receivedAt,
  });
  const replyReceivedAt = message.received_at ?? receivedAt;

  // Une réponse consignée à la main qui demande de ne plus être contacté vaut opposition, comme
  // une réponse reçue par e-mail : l'adresse n'est plus jamais sollicitée.
  if (detectInformationAgentContactOptOut(bodyText)) {
    await recordInformationAgentContactOpposition({
      email: mission.recipient_email,
      opposedAt: replyReceivedAt,
    });
  }

  const extractedFacts = extractInformationAgentFacts(replyTextForExtraction(bodyText));
  await persistFactCandidates({
    sharedCase,
    messageId: message.id,
    facts: extractedFacts,
    assets: [],
  });

  const caseUpdated = await updateManualReplyCase({
    sharedCase,
    hasReviewableEvidence: extractedFacts.length > 0,
    repliedAt: replyReceivedAt,
  });
  if (!caseUpdated) {
    throw new Error("Requête invalide : le dossier de cette enquête est déjà fermé.");
  }

  const updatedAt = new Date().toISOString();
  const { error: missionUpdateError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({ status: "replied", replied_at: replyReceivedAt, updated_at: updatedAt })
    .eq("case_id", sharedCase.id)
    .in("status", ["sent", "subscribed", "replied"]);
  if (missionUpdateError) throw missionUpdateError;
}

const OPEN_INFORMATION_AGENT_CASE_STATUSES = ["sending", "sent", "replied", "review"] as const;

async function loadManualReplyCase(mission: MissionRow): Promise<CaseRow> {
  if (!mission.case_id || !mission.sale_id) {
    throw new Error("Requête invalide : l'enquête n'est pas rattachée à une vente.");
  }
  const { data: sharedCase, error } = await supabaseAdmin
    .from("information_agent_cases")
    .select("*")
    .eq("id", mission.case_id)
    .eq("sale_id", mission.sale_id)
    .maybeSingle();
  if (error) throw error;
  if (!sharedCase) {
    throw new Error("Requête invalide : dossier de vente introuvable ou incohérent.");
  }
  const { data: subscriber, error: subscriberError } = await supabaseAdmin
    .from("information_agent_case_subscribers")
    .select("case_id")
    .eq("case_id", sharedCase.id)
    .eq("user_id", mission.user_id)
    .maybeSingle();
  if (subscriberError) throw subscriberError;
  if (!subscriber) {
    throw new Error("Requête invalide : la mission n'est pas rattachée à ce dossier.");
  }
  if (!OPEN_INFORMATION_AGENT_CASE_STATUSES.some((status) => status === sharedCase.status)) {
    throw new Error("Requête invalide : le dossier de cette enquête est déjà fermé.");
  }
  return sharedCase;
}

async function updateManualReplyCase({
  sharedCase,
  hasReviewableEvidence,
  repliedAt,
}: {
  sharedCase: CaseRow;
  hasReviewableEvidence: boolean;
  repliedAt: string;
}): Promise<boolean> {
  const values = { replied_at: repliedAt, failure_reason: null } as const;
  const keepReview = hasReviewableEvidence || sharedCase.status === "review";
  if (keepReview) {
    const { data, error } = await supabaseAdmin
      .from("information_agent_cases")
      .update({ ...values, status: "review" })
      .eq("id", sharedCase.id)
      .eq("sale_id", sharedCase.sale_id)
      .in("status", ["sending", "sent", "replied", "review"])
      .select("id")
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  const { data: repliedCase, error: repliedError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ ...values, status: "replied" })
    .eq("id", sharedCase.id)
    .eq("sale_id", sharedCase.sale_id)
    .in("status", ["sending", "sent", "replied"])
    .select("id")
    .maybeSingle();
  if (repliedError) throw repliedError;
  if (repliedCase) return true;

  // Another reply may have moved the case to review after the snapshot above.
  // Preserve that stronger state instead of downgrading it to replied.
  const { data: currentCase, error: currentError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", sharedCase.id)
    .maybeSingle();
  if (currentError) throw currentError;
  if (currentCase?.status !== "review") return false;

  const { data: preservedCase, error: preserveError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ replied_at: repliedAt })
    .eq("id", sharedCase.id)
    .eq("sale_id", sharedCase.sale_id)
    .eq("status", "review")
    .select("id")
    .maybeSingle();
  if (preserveError) throw preserveError;
  return Boolean(preservedCase);
}

async function insertOrLoadManualReplyMessage({
  mission,
  sharedCase,
  providerMessageId,
  subject,
  bodyText,
  receivedAt,
}: {
  mission: MissionRow;
  sharedCase: CaseRow;
  providerMessageId: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
}): Promise<Database["public"]["Tables"]["information_agent_messages"]["Row"]> {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("*")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    assertSameManualReply(existing, mission, sharedCase, subject, bodyText);
    return existing;
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("information_agent_messages")
    .insert({
      mission_id: mission.id,
      case_id: sharedCase.id,
      user_id: mission.user_id,
      direction: "inbound",
      message_kind: "reply",
      delivery_status: "received",
      from_email: mission.recipient_email,
      to_email: mission.reply_to_email,
      subject,
      body_text: bodyText,
      provider_message_id: providerMessageId,
      received_at: receivedAt,
      metadata: {
        imported_manually: true,
        content_trust: "untrusted",
        channel: "admin_manual_reply",
        manual_reply_provider_id: providerMessageId,
      },
    })
    .select("*")
    .single();
  if (!insertError && inserted) return inserted;
  if (!insertError) throw new Error("Réponse manuelle impossible à enregistrer.");

  // A double click or concurrent admin request can win the unique provider
  // id between the lookup and insert. Reuse it only after rechecking every
  // dossier identity field; never merge two replies silently.
  if (insertError.code !== "23505") throw insertError;
  const { data: concurrent, error: concurrentError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("*")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (concurrentError || !concurrent) throw insertError;
  assertSameManualReply(concurrent, mission, sharedCase, subject, bodyText);
  return concurrent;
}

function assertSameManualReply(
  message: Database["public"]["Tables"]["information_agent_messages"]["Row"],
  mission: MissionRow,
  sharedCase: CaseRow,
  subject: string,
  bodyText: string,
): void {
  if (
    message.mission_id !== mission.id ||
    message.case_id !== sharedCase.id ||
    message.user_id !== mission.user_id ||
    message.direction !== "inbound" ||
    message.message_kind !== "reply" ||
    message.delivery_status !== "received" ||
    message.subject !== subject ||
    message.body_text !== bodyText
  ) {
    throw new Error(
      "Requête invalide : cette réponse manuelle est déjà rattachée à un autre dossier.",
    );
  }
}

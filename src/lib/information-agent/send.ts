import "server-only";
import { ConfigurationError, PublicApiError } from "@/lib/api-errors";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
  renderInformationRequestEmail,
} from "../../../emails/information-request";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { ResendRejectedError } from "@/lib/email-alerts";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import { assertNoInformationAgentCommercialMention } from "@/lib/information-agent-commercial-guard";
import { informationAgentContributionUrl } from "@/lib/information-agent-contribution";
import {
  assertAgentFoundOriginIntact,
  assertInformationAgentSearchedAddressAllowed,
  isAgentFoundRecipient,
} from "@/lib/information-agent/address-search";
import {
  assertInformationAgentSourceAllowed,
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  resolveInformationAgentAddressOrigin,
} from "@/lib/information-agent/address-origin";
import {
  AdminDailyApprovalCapError,
  adminDailyApprovalCap,
  assertAdminDailyApprovalCap,
} from "@/lib/information-agent/approval-cap";
import { assertInformationAgentAddressDeliverable } from "@/lib/information-agent/address-deliverability";
import {
  assertAutopilotSendAllowed,
  AutopilotSendRefusedError,
} from "@/lib/information-agent/autopilot-send-guard";
import {
  assertInformationAgentCanaryRecipient,
  assertInformationAgentNotarySendAllowed,
  assertInformationAgentOutboundEnabled,
  resolveInformationAgentEmailConfig,
} from "@/lib/information-agent/config";
import { informationAgentCaseReference } from "@/lib/information-agent/case-reference";
import {
  assertInformationAgentContactAllowed,
  recordInformationAgentAdminAddressEntry,
} from "@/lib/information-agent/contacts";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { assertCourtRegistryFallbackLimits } from "@/lib/information-agent/court-registry";
import {
  assertCourtRegistryFallbackOriginIntact,
  courtRegistryMessageMetadata,
  courtRegistryMissionChecks,
  withoutCourtRegistryTrace,
} from "@/lib/information-agent/court-registry-mission";
import {
  assertInformationAgentHasQuestion,
  assertInformationAgentSaleCurrent,
  saleSourceTexts,
} from "@/lib/information-agent/draft-checks";
import {
  assertInformationAgentControllerIdentity,
  assertInformationAgentPreviewFingerprint,
  buildInformationAgentLegalFooter,
} from "@/lib/information-agent/message-guards";
import { missionRecipient, missionSaleReference } from "@/lib/information-agent/mission-identity";
import { assertInformationAgentQuestionsAllowed } from "@/lib/information-agent/recipient-questions";
import { informationAgentAudienceInvitesDocuments } from "@/lib/information-agent/recipient-templates";
import {
  asObject,
  loadOwnedMission,
  updateCaseOrThrow,
  updateMissionOrThrow,
  type MissionRow,
} from "@/lib/information-agent/mission-store";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
import {
  assertIssuedAutopilotTrigger,
  UNVERIFIED_SEND_OUTCOME,
  type InformationAgentAdminActionPayload,
  type InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";

// Envoi validé d'une mission : l'unique chemin d'envoi de l'agent (`approveAndSendMission`).
// Extrait de `information-agent.ts` sans changement de comportement ; le verrou
// `information-agent-no-automatic-send.test.ts` lit ce fichier.

export async function approveAndSendMission({
  adminId,
  input,
  fetchImpl,
  trigger,
}: {
  adminId: string;
  input: Extract<InformationAgentAdminActionPayload, { action: "approve_and_send" }>;
  fetchImpl: typeof fetch;
  trigger?: InformationAgentSendTrigger;
}) {
  assertIssuedAutopilotTrigger(trigger);
  const mission = await loadOwnedMission(adminId, input.missionId);
  if (mission.status !== "draft" && mission.status !== "failed") {
    throw new PublicApiError(MISSION_NOT_APPROVABLE_MESSAGE, 409);
  }
  assertUnverifiedSendWithinIdempotencyWindow(mission);
  // Envoi strictement manuel : l'administrateur a affiché l'aperçu de ce contenu exact.
  assertInformationAgentPreviewFingerprint({ adminId, input });
  // Aucune mention commerciale : le message reste purement informatif.
  assertNoInformationAgentCommercialMention(`${input.subject}\n${input.bodyText}`, {
    ignore: saleSourceTexts(mission),
  });
  assertInformationAgentHasQuestion(input.bodyText);
  await assertInformationAgentSaleCurrent(mission);
  // Opposition par adresse et par identité (le nom corrigé à l'aperçu compte), avant l'envoi.
  // Greffe de secours : l'adresse du référentiel est la seule adresse de juridiction admise ; adresse, vente
  // relue et limites du tribunal sont contrôlées avant tout (court-registry-mission.ts).
  const { fallback: courtFallback, checks: courtChecks } = courtRegistryMissionChecks({
    mission,
    recipientEmail: input.recipientEmail,
  });
  for (const check of courtChecks) await check();
  const recipient = missionRecipient(mission, input.recipientName, input.recipientEmail);
  // Questions admises pour le destinataire du brouillon, relues à l'envoi ; envois aux notaires fermés par
  // défaut (config.ts).
  assertInformationAgentQuestionsAllowed(recipient.questionAudience, mission.question_keys);
  assertInformationAgentNotarySendAllowed({ ...recipient, email: input.recipientEmail });
  // Un greffe n'a pas de nom de personne ni de structure opposable : aucune clé, même si un nom est saisi.
  // Sinon : clés de la personne, et de la structure pour une adresse générique (opposition-keys.ts).
  const oppositionKeys = courtFallback ? { identityKeys: [], checkKeys: [] } : recipient.keys;
  const identityKeys = oppositionKeys.identityKeys;
  await assertInformationAgentContactAllowed({
    saleId: mission.sale_id,
    email: input.recipientEmail,
    identityKeys,
    checkKeys: oppositionKeys.checkKeys,
    courtRegistryAddress: Boolean(courtFallback),
  });
  // Adresse retrouvée par l'agent : sa seule origine est la ligne de registre de l'agent.
  const agentFound = isAgentFoundRecipient(mission, input.recipientEmail);
  const addressOrigin = await resolveInformationAgentAddressOrigin({
    email: input.recipientEmail,
    saleId: mission.sale_id,
    manualOriginUrl: agentFound || courtFallback ? null : (input.recipientOriginUrl ?? null),
    fallbackObservedAt: mission.created_at,
    structureAddress: courtFallback ? null : recipient.structureAddress,
  });
  if (!addressOrigin.known) {
    throw new PublicApiError(INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE, 400);
  }
  assertAgentFoundOriginIntact(agentFound, addressOrigin);
  assertCourtRegistryFallbackOriginIntact(Boolean(courtFallback), addressOrigin);
  assertInformationAgentSourceAllowed(addressOrigin);
  assertInformationAgentSearchedAddressAllowed(addressOrigin.origin);
  assertInformationAgentOutboundEnabled();
  assertInformationAgentCanaryRecipient(input.recipientEmail);
  // Envoi du pilote : les règles du pilote sont revérifiées ici (l'état a pu changer depuis la sélection).
  const autopilotGuard = () =>
    assertAutopilotSendAllowed({
      saleId: mission.sale_id ?? "",
      email: input.recipientEmail,
      identityKeys,
      recipientKind: mission.recipient_kind,
      addressOriginKind: addressOrigin.kind,
      courtFallback: Boolean(courtFallback),
    });
  if (trigger) await autopilotGuard();
  // Hygiène, domaine qui reçoit du courrier, rebonds passagers récents (address-deliverability.ts).
  await assertInformationAgentAddressDeliverable(input.recipientEmail);
  // Validate delivery prerequisites before approval reserves the case for sending.
  // Otherwise a configuration error can leave an approved case with no delivery attempt.
  const config = resolveInformationAgentEmailConfig();

  // GDPR art. 14 prerequisites: a named controller, and at most one email per recipient per 30 days.
  assertInformationAgentControllerIdentity();
  // Plafond de validations par administrateur et par jour (pas d'envoi à la chaîne sans relecture). Le pilote a ses
  // propres plafonds (phase, jour, heure, cabinet, tribunal) : il n'est pas soumis à celui des administrateurs.
  if (!trigger) await assertAdminDailyApprovalCap(adminId);
  await assertInformationAgentRecipientCooldown({
    email: input.recipientEmail,
    missionId: mission.id,
    identityKeys,
    courtRegistryFallback: Boolean(courtFallback),
  });

  // An admin may replace a source-derived address while approving the draft.
  // Preserve the provenance only when the normalized address is unchanged;
  // otherwise the canonical case must record an explicit manual recipient.
  const recipientKind =
    normalizedEmail(input.recipientEmail) === normalizedEmail(mission.recipient_email)
      ? mission.recipient_kind
      : "manual_professional";

  // Adresse saisie par un administrateur : source typée, date de relevé et auteur au registre.
  if (addressOrigin.kind === "admin_entry" && mission.sale_id) {
    await recordInformationAgentAdminAddressEntry({
      saleId: mission.sale_id,
      email: input.recipientEmail,
      name: input.recipientName || mission.recipient_name,
      url: addressOrigin.origin.url,
      observedAt: mission.created_at,
      adminId,
      identityKeys,
    });
  }

  const { data: edited, error: editError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({
      recipient_email: input.recipientEmail,
      recipient_identity_keys: identityKeys,
      recipient_kind: recipientKind,
      // Jamais de nom de greffier dans un champ structuré.
      recipient_name: courtFallback ? null : input.recipientName || null,
      reply_to_email: null,
      share_requester_email: false,
      subject: input.subject,
      body_text: input.bodyText,
      failure_reason: null,
      metadata: {
        // Destinataire changé par l'administrateur : la mission n'est plus une demande au greffe.
        ...markTrigger(
          asObject(courtFallback ? mission.metadata : withoutCourtRegistryTrace(mission.metadata)),
          trigger,
        ),
        recipient_origin_url: input.recipientOriginUrl ?? null,
        preview_fingerprint: input.previewFingerprint,
      },
    })
    .eq("id", mission.id)
    .eq("user_id", mission.user_id)
    .in("status", ["draft", "failed"])
    .select("*")
    .single();
  if (editError) throw editError;

  const { error: subscribeError } = await supabaseAdmin.rpc("subscribe_information_agent_mission", {
    p_user_id: mission.user_id,
    p_mission_id: mission.id,
  });
  if (subscribeError) throw subscribeError;
  const subscribedMission = await loadOwnedMission(adminId, mission.id);
  // Aucune invitation à joindre des documents dans un message à un notaire : pas de lien de dépôt.
  const contributionUrl = informationAgentAudienceInvitesDocuments(recipient.questionAudience)
    ? informationAgentContributionUrl(subscribedMission)
    : undefined;
  const messageHash = approvalFingerprint(subscribedMission);
  const approval = await approveInformationAgentMissionForAdmin(
    subscribedMission,
    messageHash,
    trigger ? undefined : adminDailyApprovalCap(),
  );
  if (!approval) throw new Error("Mission approval returned no row");
  if (!approval.should_send) {
    // The shared case already left the draft stage (another mission sent it): saying « updated »
    // would let the admin believe this email went out.
    throw new PublicApiError(
      "Aucun email n’est parti : cette demande est rattachée à un dossier déjà envoyé à cette adresse pour cette vente.",
      409,
    );
  }

  const replyTo = `enquete+${approval.inbound_token}@${config.inboundDomain}`;
  const sendingAt = new Date().toISOString();
  // Set once Resend has accepted the message: from then on the mission is never downgraded.
  let delivered: { id: string | null; sentAt: string } | null = null;

  try {
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
      identityKeys: edited.recipient_identity_keys,
      checkKeys: oppositionKeys.checkKeys,
      courtRegistryAddress: Boolean(courtFallback),
    });
    // Approval is already recorded: if a concurrent approval for the same recipient is older,
    // this one stands down, so only the earliest request is ever sent within the 30 days.
    const approvedMission = await loadOwnedMission(adminId, mission.id);
    await assertInformationAgentRecipientCooldown({
      email: edited.recipient_email,
      missionId: mission.id,
      identityKeys: edited.recipient_identity_keys,
      approvedAt: approvedMission.approved_at,
      courtRegistryFallback: Boolean(courtFallback),
    });
    if (courtFallback) {
      // Même départage des approbations concurrentes pour les limites du tribunal (par vente et par jour).
      await assertCourtRegistryFallbackLimits({
        courtCode: courtFallback.courtCode,
        saleId: subscribedMission.sale_id,
        missionId: mission.id,
        approvedAt: approvedMission.approved_at,
      });
    }
    const legalFooter = buildInformationAgentLegalFooter({
      appUrl: config.appUrl,
      email: edited.recipient_email,
      addressOrigin: addressOrigin.origin,
      saleReference: missionSaleReference(subscribedMission),
      structureOpposition: courtFallback ? null : recipient.structureOpposition,
    });
    const renderedEmail = await renderInformationRequestEmail({
      subject: edited.subject,
      bodyText: edited.body_text,
      replyTo,
      caseReference: informationAgentCaseReference(approval.case_id),
      appUrl: config.appUrl,
      contributionUrl,
      legalFooter,
    });
    assertNoInformationAgentCommercialMention(`${renderedEmail.html}\n${renderedEmail.text}`, {
      appOrigin: config.appUrl,
      allowedUrls: [legalFooter.addressOriginUrl],
      // La référence de la vente vient de l'annonce : elle ne peut pas faire échouer l'envoi.
      ignore: [legalFooter.saleReference, ...saleSourceTexts(mission)],
    });
    await assertInformationAgentContactAllowed({
      saleId: subscribedMission.sale_id,
      email: edited.recipient_email,
      identityKeys: edited.recipient_identity_keys,
      checkKeys: oppositionKeys.checkKeys,
      courtRegistryAddress: Boolean(courtFallback),
    });
    // Juste avant l'appel au fournisseur : règles du pilote revérifiées une dernière fois.
    if (trigger) await autopilotGuard();
    assertInformationAgentCanaryRecipient(edited.recipient_email);
    const delivery = await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: informationAgentIdempotencyKey(approval.case_id),
      fetchImpl,
      category: "agent",
      templateKey: courtFallback ? "agent_court_registry" : "agent_request",
      mode: trigger ? "autopilot" : "manual",
      message: {
        from: config.from,
        to: edited.recipient_email,
        replyTo,
        subject: edited.subject,
        text: renderedEmail.text,
        html: renderedEmail.html,
        // RFC 8058 : l'opposition en un clic est proposée par la messagerie du destinataire.
        unsubscribeUrl: legalFooter.optOutUrl,
        oneClickUnsubscribe: true,
      },
    });
    const sentAt = new Date().toISOString();
    delivered = { id: delivery.id, sentAt };
    const missionMetadata = asObject(edited.metadata);
    const { error: messageError } = await supabaseAdmin.from("information_agent_messages").insert({
      mission_id: mission.id,
      case_id: approval.case_id,
      user_id: mission.user_id,
      direction: "outbound",
      message_kind: "initial",
      delivery_status: "sent",
      from_email: config.from,
      to_email: edited.recipient_email,
      subject: edited.subject,
      body_text: edited.body_text,
      provider_message_id: delivery.id,
      sent_at: sentAt,
      metadata: {
        approval_sha256: messageHash,
        preview_fingerprint: input.previewFingerprint,
        approved_by_admin: adminId,
        // Traçabilité d'un envoi automatique : mode, passage, empreinte du texte rendu (pied compris), contrôles.
        ...(trigger
          ? {
              send_mode: "autopilot",
              autopilot_run_id: trigger.runId,
              rendered_text_sha256: createHash("sha256").update(renderedEmail.text).digest("hex"),
              address_origin_kind: addressOrigin.kind,
              autopilot_checks: trigger.checks ?? {},
            }
          : { send_mode: "manual" }),
        address_origin_url: legalFooter.addressOriginUrl ?? null,
        address_origin_text: legalFooter.addressOrigin,
        // Journal : un message au greffe se distingue d'un message à un avocat.
        ...courtRegistryMessageMetadata(courtFallback),
        email_template_version: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
        email_content_template_id: missionMetadata.email_content_template_id ?? null,
        email_content_template_revision: missionMetadata.email_content_template_revision ?? null,
      },
    });
    if (messageError) throw messageError;
    await updateMissionOrThrow(mission.id, mission.user_id, {
      status: "sent",
      reply_to_email: replyTo,
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
      // L'envoi est confirmé : plus rien à vérifier.
      metadata: omitUnverifiedSendOutcome(asObject(edited.metadata)),
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "sent",
      sent_at: sentAt,
      provider_message_id: delivery.id,
      failure_reason: null,
    });
  } catch (error) {
    const detail = failureDetail(error);
    if (delivered) {
      // The email is out. Marking the mission failed would free the 30-day cooldown and invite a
      // manual retry that sends a second email: keep it sent and say what is incomplete.
      const note = `Message accepté par Resend (${delivered.id ?? "identifiant non communiqué"}), enregistrement incomplet : ${detail}`;
      await Promise.allSettled([
        updateMissionOrThrow(mission.id, mission.user_id, {
          status: "sent",
          reply_to_email: replyTo,
          sent_at: delivered.sentAt,
          provider_message_id: delivered.id,
          failure_reason: note,
        }),
        updateCaseOrThrow(approval.case_id, {
          status: "sent",
          sent_at: delivered.sentAt,
          provider_message_id: delivered.id,
          failure_reason: note,
        }),
      ]);
      throw new InformationAgentSentButUnrecordedError(error);
    }
    // Resend n'a pas répondu à temps (ou la connexion est tombée) : l'email a peut-être été
    // accepté. Ce n'est pas un échec établi. La demande est marquée « à vérifier » : le délai de
    // 30 jours reste tenu (assertInformationAgentRecipientCooldown), la vérification est
    // demandée, et un renvoi dans les 24 heures réutilise la clé d'idempotence (pas de doublon).
    const unverified = isIndeterminateSendError(error);
    const reason = unverified
      ? `Envoi à vérifier : Resend n’a pas répondu à temps, l’email est peut-être parti. Vérifiez dans Resend (clé d’idempotence ${informationAgentIdempotencyKey(approval.case_id)}, valable 24 h) avant tout renvoi.`
      : detail;
    await updateMissionOrThrow(mission.id, mission.user_id, {
      status: "failed",
      failure_reason: reason,
      metadata: {
        ...asObject(edited.metadata),
        last_send_attempt_at: sendingAt,
        ...(unverified ? { send_outcome: UNVERIFIED_SEND_OUTCOME } : {}),
      },
    });
    await updateCaseOrThrow(approval.case_id, {
      status: "failed",
      failure_reason: reason,
    });
    throw unverified ? new InformationAgentUnverifiedSendError(error) : error;
  }
}

/** Clé d'idempotence de l'envoi d'un dossier : un renvoi sous 24 h retrouve le premier envoi chez Resend. */
function informationAgentIdempotencyKey(caseId: string): string {
  return `immojudis-information-agent-case-${caseId}`;
}

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function omitUnverifiedSendOutcome(metadata: Record<string, Json | undefined>): Json {
  const { send_outcome: _outcome, ...rest } = metadata;
  return rest as Json;
}

/**
 * Un renvoi après un envoi « à vérifier » n'est sûr que pendant la fenêtre d'idempotence de Resend
 * (24 h) : au-delà, si l'email était parti, il partirait une seconde fois. L'administrateur
 * vérifie d'abord dans Resend, puis lève le drapeau (voir le runbook de l'agent).
 */
export function assertUnverifiedSendWithinIdempotencyWindow(
  mission: Pick<MissionRow, "metadata">,
  now = Date.now(),
): void {
  const metadata = asObject(mission.metadata);
  if (metadata.send_outcome !== UNVERIFIED_SEND_OUTCOME) return;
  const attemptedAt = Date.parse(String(metadata.last_send_attempt_at ?? ""));
  if (Number.isFinite(attemptedAt) && now - attemptedAt <= IDEMPOTENCY_WINDOW_MS) return;
  throw new PublicApiError(
    "Le résultat du dernier envoi n’a jamais été confirmé et la fenêtre de 24 h de la clé d’idempotence est dépassée : un renvoi pourrait créer un doublon. Vérifiez dans Resend (docs/runbooks/information-agent.md, « Envoi à vérifier »).",
    409,
  );
}

/**
 * Erreur dont on ne peut pas dire si l'email est parti : délai dépassé (`AbortSignal.timeout`) ou
 * connexion coupée après l'envoi de la requête. Une réponse d'erreur de Resend, elle, est un refus.
 */
function isIndeterminateSendError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const code = String((error as { code?: unknown }).code ?? "");
  const causeCode = String((error.cause as { code?: unknown } | undefined)?.code ?? "");
  return (
    /^(?:ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_(?:SOCKET|BODY_TIMEOUT|HEADERS_TIMEOUT|CONNECT_TIMEOUT))$/.test(
      code,
    ) ||
    /^(?:ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_(?:SOCKET|BODY_TIMEOUT|HEADERS_TIMEOUT|CONNECT_TIMEOUT))$/.test(
      causeCode,
    ) ||
    /\b(?:timed? out|timeout|aborted|socket hang up|other side closed|terminated)\b/i.test(
      error.message,
    )
  );
}

const MISSION_NOT_APPROVABLE_MESSAGE =
  "Requête invalide : cette enquête ne peut plus être modifiée.";

/** Refus de `approve_information_agent_mission_admin` (migration 20261110220100). */
const APPROVAL_CAP_REACHED = "53400";
const MISSION_NOT_APPROVABLE = "55000";
/**
 * Filet SQL du pilote (garde des missions, migration 20261110230000) : une mission `trigger = autopilot` ne passe
 * pas en « sending » hors du mode réel. Même code que le refus d'un contact opposé (23514) : le texte départage.
 */
const MISSION_GUARD_REFUSED = "23514";
const AUTOPILOT_NOT_LIVE_SQL_MESSAGE = "Autopilot send refused";

/**
 * L'email est parti (accepté par Resend) mais son enregistrement est incomplet : la mission reste
 * « envoyée » (motif dans `failure_reason`) et le message ne doit jamais être renvoyé.
 */
export class InformationAgentSentButUnrecordedError extends Error {
  constructor(cause: unknown) {
    super("Information-agent email accepted by the provider, recording incomplete", { cause });
    this.name = "InformationAgentSentButUnrecordedError";
  }
}

/**
 * Resend n'a pas répondu à temps : l'email est peut-être parti. La mission est « à vérifier » (motif dans
 * `failure_reason`) ; aucun envoi automatique ne doit suivre avant vérification.
 */
export class InformationAgentUnverifiedSendError extends Error {
  constructor(cause: unknown) {
    super("Information-agent send outcome unknown (provider timeout)", { cause });
    this.name = "InformationAgentUnverifiedSendError";
  }
}

/**
 * Motif d'échec enregistré pour l'administrateur : le message d'un refus écrit pour lui, ou du
 * fournisseur ; jamais le texte d'une erreur de la base ou du code.
 */
function failureDetail(error: unknown): string {
  if (
    error instanceof PublicApiError ||
    error instanceof ConfigurationError ||
    error instanceof ResendRejectedError
  ) {
    return error.message.slice(0, 1000);
  }
  console.error(
    JSON.stringify({ scope: "information_agent.send", error: errorDetailForLog(error) }),
  );
  return "Erreur interne pendant l’envoi.";
}

type InformationAgentApproval = {
  case_id: string;
  should_send: boolean;
  inbound_token: string;
};

/**
 * Approves an admin mission without calling the user quota RPC. The existing
 * case/subscriber model is retained so inbound Resend replies continue to be
 * routed and reviewed exactly as before.
 */
async function approveInformationAgentMissionForAdmin(
  mission: MissionRow,
  messageHash: string,
  dailyCap: number | undefined,
): Promise<InformationAgentApproval> {
  const { data, error } = await supabaseAdmin.rpc("approve_information_agent_mission_admin", {
    p_admin_id: mission.user_id,
    p_mission_id: mission.id,
    p_message_sha256: messageHash,
    // Plafond de validations par administrateur et par jour, appliqué dans la fonction (atomique).
    p_daily_cap: dailyCap,
  });
  if (error?.code === APPROVAL_CAP_REACHED) {
    throw new AdminDailyApprovalCapError(dailyCap ?? adminDailyApprovalCap());
  }
  if (error?.code === MISSION_NOT_APPROVABLE) {
    throw new PublicApiError(MISSION_NOT_APPROVABLE_MESSAGE, 409, { cause: error });
  }
  // Pilote coupé entre sa dernière relecture et l'approbation : un arrêt, pas une erreur d'API.
  if (
    error?.code === MISSION_GUARD_REFUSED &&
    error.message?.startsWith(AUTOPILOT_NOT_LIVE_SQL_MESSAGE)
  ) {
    throw new AutopilotSendRefusedError("not_live", { cause: error });
  }
  if (error) throw new Error("Admin mission approval failed", { cause: error });
  const approval = data?.[0];
  if (!approval) throw new Error("Admin mission approval returned no row");
  return approval;
}

function approvalFingerprint(mission: MissionRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recipientEmail: mission.recipient_email,
        replyToEmail: mission.reply_to_email,
        subject: mission.subject,
        bodyText: mission.body_text,
        emailTemplateVersion: INFORMATION_REQUEST_EMAIL_TEMPLATE_VERSION,
      }),
    )
    .digest("hex");
}

/**
 * Marque d'un envoi dans les métadonnées de la mission. Le filet SQL lit `trigger` : un brouillon préparé par le
 * pilote puis validé À LA MAIN par un administrateur est réécrit `trigger = "manual"` (et perd `autopilot_run_id`
 * et `autopilot_simulated`) : il n'est ni refusé hors du mode réel, ni compté comme un envoi du pilote (mauvais
 * destinataire). Seul un envoi du pilote porte `trigger = "autopilot"`.
 */
export function markTrigger(
  metadata: Record<string, Json | undefined>,
  trigger: InformationAgentSendTrigger | undefined,
): Record<string, Json | undefined> {
  const { autopilot_run_id: _run, autopilot_simulated: _simulated, ...unmarked } = metadata;
  return trigger
    ? { ...metadata, trigger: trigger.kind, autopilot_run_id: trigger.runId }
    : { ...unmarked, trigger: "manual" };
}

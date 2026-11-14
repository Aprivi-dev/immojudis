import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nullableRpcArg } from "@/lib/rpc-args";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adminPageQueryShape } from "@/lib/admin-page-query";
import { ADMIN_PAGE_SIZE, adminPageMeta } from "@/lib/admin-pagination";
import { optimizeInformationAgentPhoto } from "@/lib/information-agent-image";
import { flattenPdfForPublication } from "@/lib/information-agent-pdf";
import { recordInformationAgentContactOpposition } from "@/lib/information-agent/contacts";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { applyWrongRecipient } from "@/lib/information-agent-inbound/wrong-recipient";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { loadAutoPublicationReviewAnnotations } from "@/lib/admin-information-agent-auto-publication";
import { listInformationAgentWithdrawalTasks } from "@/lib/admin-information-agent-withdrawals";
import { asRecord as recordOrEmpty } from "@/lib/guards";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { decideAdminFactClaim } from "@/lib/admin-fact-claim-decisions";
import { translateFactClaimDatabaseError } from "@/lib/fact-claim-database-errors";
import {
  FACT_CLAIM_LOT_ATTACHMENTS,
  type FactClaimLotAttachment,
} from "@/lib/fact-claim-decisions";
import {
  INFORMATION_AGENT_OCCUPANCY_REFUSED_MESSAGE,
  informationAgentFactRegistryField,
  informationAgentOccupancyRefused,
  type InformationAgentRegistryAcceptance,
} from "@/lib/information-agent-registry-acceptance";

export const adminInformationAgentReviewSchema = z.object({
  factId: z.string().guid(),
  decision: z.enum(["accepted", "rejected"]),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** "Caviardage vérifié": required to accept a document or a photo for publication. */
  redactionConfirmed: z.boolean().optional(),
  redactionVerifiedBy: z.string().trim().min(3).max(120).optional(),
  /**
   * Rattachement au lot de la décision du registre des pièces : exigé pour accepter un fait qui devient une
   * observation du registre (`informationAgentFactRegistryField`).
   */
  lotAttachment: z
    .enum(
      Object.keys(FACT_CLAIM_LOT_ATTACHMENTS) as [
        FactClaimLotAttachment,
        ...FactClaimLotAttachment[],
      ],
    )
    .optional(),
});

export type AdminInformationAgentReviewInput = z.output<typeof adminInformationAgentReviewSchema>;

export const adminInformationAgentReviewQuerySchema = z.object(adminPageQueryShape);

type AdminInformationAgentReviewListOptions = {
  offset?: number;
  limit?: number;
};

/**
 * Réponses reçues et faits à contrôler, 50 par page (`offset` / `limit`, validés par zod à la
 * route). Les deux listes avancent ensemble : la page N montre les lignes N·limit … de chacune,
 * `factsTotal` et `messagesTotal` donnent leur taille, `total` la plus grande des deux.
 */
export async function listAdminInformationAgentReview(
  authToken: string,
  options: AdminInformationAgentReviewListOptions = {},
) {
  await assertAdminAuth(authToken);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? ADMIN_PAGE_SIZE;
  const to = offset + limit - 1;

  const [factsResult, messagesResult] = await Promise.all([
    supabaseAdmin
      .from("information_agent_fact_candidates")
      .select("*", { count: "exact" })
      .in("status", ["pending", "conflict"])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, to),
    // created_at est non nul pour chaque message ; l'id départage les réponses simultanées.
    supabaseAdmin
      .from("information_agent_messages")
      .select("id,case_id,from_email,subject,body_text,created_at,received_at,metadata", {
        count: "exact",
      })
      .eq("direction", "inbound")
      // A reply the admin marked as handled (or answered with an opposition) leaves the queue.
      .is("metadata->>admin_handled_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, to),
  ]);
  if (factsResult.error) throw factsResult.error;
  if (messagesResult.error) throw messagesResult.error;
  const facts = factsResult.data ?? [];
  const messages = messagesResult.data ?? [];
  const factsTotal = factsResult.count ?? offset + facts.length;
  const messagesTotal = messagesResult.count ?? offset + messages.length;

  const caseIds = [
    ...new Set([
      ...facts.map((fact) => fact.case_id),
      ...messages.flatMap((message) => (message.case_id ? [message.case_id] : [])),
    ]),
  ];
  const { data: cases, error: casesError } = caseIds.length
    ? await supabaseAdmin
        .from("information_agent_cases")
        .select(
          "id,sale_id,status,recipient_name,recipient_email,subject,sent_at,replied_at,updated_at",
        )
        .in("id", caseIds)
        .order("updated_at", { ascending: false })
    : { data: [], error: null };
  if (casesError) throw casesError;

  // Un dossier peut accumuler plus de pièces que la limite de réponse de PostgREST : la page
  // de revue n'a besoin que des pièces liées à ses faits.
  const evidenceAssetIds = [
    ...new Set(facts.flatMap((fact) => (fact.evidence_asset_id ? [fact.evidence_asset_id] : []))),
  ];
  const { data: assets, error: assetsError } = evidenceAssetIds.length
    ? await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("*")
        .in("id", evidenceAssetIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (assetsError) throw assetsError;

  // Provenance de chaque fait : le message dont il est extrait (réponse e-mail, dépôt du portail
  // ou import manuel), même s'il n'apparaît pas sur la page de messages affichée.
  const factMessageIds = [...new Set(facts.map((fact) => fact.message_id).filter(Boolean))];
  const { data: factMessages, error: factMessagesError } = factMessageIds.length
    ? await supabaseAdmin
        .from("information_agent_messages")
        .select("id,from_email,received_at,metadata")
        .in("id", factMessageIds)
    : { data: [], error: null };
  if (factMessagesError) throw factMessagesError;
  const factSources = (factMessages ?? []).map((message) =>
    informationAgentFactSource(message as FactSourceMessage),
  );

  const assetIds = (assets ?? []).map((asset) => asset.id);
  const { data: extractions, error: extractionsError } = assetIds.length
    ? await supabaseAdmin
        .from("information_agent_evidence_extractions")
        .select(
          "id,asset_id,status,detected_mime_type,document_kind,page_count,is_encrypted,summary,error_code,error_message,attempts,completed_at,created_at,updated_at",
        )
        .in("asset_id", assetIds)
        .order("created_at", { ascending: true })
    : { data: [], error: null };
  if (extractionsError) throw extractionsError;

  // Simulation du moteur « publier ou relire » : rien en mode arrêt.
  const autoPublication = await loadAutoPublicationReviewAnnotations(facts);
  // Valeurs publiées d'un avocat qui s'est opposé : à retirer au registre dans le mois (lot C).
  const withdrawalTasks = await listInformationAgentWithdrawalTasks();

  return {
    withdrawalTasks,
    cases: cases ?? [],
    facts,
    assets: assets ?? [],
    extractions: extractions ?? [],
    messages,
    factSources,
    autoPublication,
    factsTotal,
    messagesTotal,
    ...adminPageMeta({ offset, limit, total: Math.max(factsTotal, messagesTotal) }),
  };
}

type FactSourceMessage = {
  id: string;
  from_email: string | null;
  received_at: string | null;
  metadata: unknown;
};

export type InformationAgentFactSource = {
  messageId: string;
  channel: "email" | "portal" | "admin_manual_reply";
  fromEmail: string | null;
  receivedAt: string | null;
  /** L'expéditeur correspond au contact sollicité (e-mail) ou l'a déclaré (portail). */
  senderMatchesRecipient: boolean | null;
};

function informationAgentFactSource(message: FactSourceMessage): InformationAgentFactSource {
  const metadata = recordOrEmpty(message.metadata);
  const channel =
    metadata.channel === "portal"
      ? "portal"
      : metadata.channel === "admin_manual_reply" || metadata.imported_manually === true
        ? "admin_manual_reply"
        : "email";
  return {
    messageId: message.id,
    channel,
    fromEmail: message.from_email,
    receivedAt: message.received_at,
    senderMatchesRecipient:
      typeof metadata.sender_matches_recipient === "boolean"
        ? metadata.sender_matches_recipient
        : null,
  };
}

export const adminInformationAgentMessageActionSchema = z
  .object({
    action: z.enum(["record_opposition", "mark_handled", "wrong_recipient"]),
    messageId: z.string().guid(),
    /** Motif, obligatoire pour « Mauvais destinataire » (journalisé avec l'auteur). */
    reason: z.string().trim().min(8).max(500).optional(),
  })
  .refine((value) => value.action !== "wrong_recipient" || Boolean(value.reason), {
    message: "Motif obligatoire (8 caractères au moins).",
    path: ["reason"],
  });

export type AdminInformationAgentMessageAction = z.output<
  typeof adminInformationAgentMessageActionSchema
>;

/**
 * Actions de l'administrateur sur une réponse reçue, sans SQL `service_role` :
 * - `record_opposition` : opposition globale du professionnel sollicité (adresse du dossier) et de
 *   l'expéditeur s'il est différent, pour une demande d'arrêt que la lecture automatique n'a pas
 *   reconnue (téléphone, formulation inhabituelle…). Les clés d'identité sont rattachées en base.
 * - `mark_handled` : la réponse a été traitée et sort de la file de revue.
 * - `wrong_recipient` : « Mauvais destinataire ». Même effet que la détection automatique d'un « ce n'est pas
 *   moi » : l'identité est exclue du pilote (validation manuelle seulement) et, si le message venait du pilote,
 *   le pilote est arrêté (motif `wrong_recipient`).
 */
export async function runAdminInformationAgentMessageAction({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentMessageAction;
}): Promise<{ ok: true; opposedEmails: string[] }> {
  const auth = await assertAdminAuth(authToken);
  const { data: message, error } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,from_email,metadata")
    .eq("id", input.messageId)
    .eq("direction", "inbound")
    .maybeSingle();
  if (error) throw error;
  if (!message) throw new NotFoundError("Réponse introuvable.");

  const opposedEmails: string[] = [];
  if (input.action === "wrong_recipient") {
    if (!message.case_id) {
      throw new PublicApiError("Cette réponse n'est rattachée à aucun dossier.", 409);
    }
    await applyWrongRecipient({
      caseId: message.case_id,
      source: "admin",
      actorId: auth.userId,
      reason: input.reason,
    });
  }
  if (input.action === "record_opposition") {
    let recipient: string | null = null;
    if (message.case_id) {
      const { data: informationCase, error: caseError } = await supabaseAdmin
        .from("information_agent_cases")
        .select("normalized_recipient_email")
        .eq("id", message.case_id)
        .maybeSingle();
      if (caseError) throw caseError;
      recipient = informationCase?.normalized_recipient_email ?? null;
    }
    for (const email of new Set(
      [recipient, message.from_email].flatMap((value) => {
        const normalized = value ? normalizedEmail(value) : null;
        return normalized ? [normalized] : [];
      }),
    )) {
      await recordInformationAgentContactOpposition({ email });
      opposedEmails.push(email);
    }
    if (!opposedEmails.length) {
      throw new PublicApiError("Aucune adresse à opposer pour cette réponse.", 400);
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from("information_agent_messages")
    .update({
      metadata: {
        ...recordOrEmpty(message.metadata),
        admin_handled_at: new Date().toISOString(),
        admin_handled_by: auth.userId,
        admin_handled_action: input.action,
      },
    })
    .eq("id", message.id);
  if (updateError) throw updateError;
  return { ok: true, opposedEmails };
}

export const adminInformationAgentUnroutedQuerySchema = z.object(adminPageQueryShape);

export const adminInformationAgentUnroutedActionSchema = z.object({
  action: z.literal("mark_handled"),
  messageId: z.string().guid(),
});

export type AdminInformationAgentUnroutedAction = z.output<
  typeof adminInformationAgentUnroutedActionSchema
>;

/**
 * Messages reçus à l'adresse de réponse sans dossier ouvert (`information_agent_unrouted_messages`),
 * ceux qui restent à traiter, du plus récent au plus ancien. L'extrait est un contenu NON FIABLE,
 * affiché tel quel comme texte (jamais interprété). Rien n'est extrait ni répondu : l'administrateur lit,
 * puis marque le message comme traité.
 */
export async function listAdminInformationAgentUnrouted(
  authToken: string,
  options: AdminInformationAgentReviewListOptions = {},
) {
  await assertAdminAuth(authToken);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? ADMIN_PAGE_SIZE;
  const { data, count, error } = await supabaseAdmin
    .from("information_agent_unrouted_messages")
    .select(
      "id,provider_email_id,sender,sender_email,subject,received_at,excerpt,reason,sender_known,sender_authentication,attachment_count,opposition_recorded,created_at",
      { count: "exact" },
    )
    .eq("status", "pending")
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const messages = data ?? [];
  return {
    messages,
    ...adminPageMeta({ offset, limit, total: count ?? offset + messages.length }),
  };
}

export type AdminInformationAgentUnroutedResponse = Awaited<
  ReturnType<typeof listAdminInformationAgentUnrouted>
>;

/** « Marquer comme traité » : le message quitte la liste et le résumé quotidien. Idempotent. */
export async function runAdminInformationAgentUnroutedAction({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentUnroutedAction;
}): Promise<{ ok: true }> {
  const auth = await assertAdminAuth(authToken);
  const { data: message, error } = await supabaseAdmin
    .from("information_agent_unrouted_messages")
    .select("id")
    .eq("id", input.messageId)
    .maybeSingle();
  if (error) throw error;
  if (!message) throw new NotFoundError("Message introuvable.");
  const { error: updateError } = await supabaseAdmin
    .from("information_agent_unrouted_messages")
    .update({ status: "handled", handled_at: new Date().toISOString(), handled_by: auth.userId })
    .eq("id", message.id)
    .eq("status", "pending");
  if (updateError) throw updateError;
  return { ok: true };
}

export type AdminInformationAgentReviewResponse = Awaited<
  ReturnType<typeof listAdminInformationAgentReview>
>;

export type AdminInformationAgentReviewResult = {
  ok: true;
  result: unknown;
  /** Décision au registre des pièces après l'acceptation ; nul pour un rejet ou un fait hors registre. */
  registry: InformationAgentRegistryAcceptance | null;
};

/**
 * Relecture d'un fait extrait d'une réponse. Une pièce acceptée est publiée (dépôt préparé, chemin vérifié).
 * Un fait qui devient une observation du registre des pièces (surface, terrain, pièces, occupation, mise à
 * prix, date, type) est accepté en deux temps : le fait de l'agent (journal, observation créée par le pont),
 * puis la décision d'acceptation au registre, au nom de l'administrateur connecté (`registry`). Si cette
 * décision échoue, le fait reste accepté et la fiche garde la valeur de l'annonce : `registry.error` le dit, et
 * l'observation attend sa décision dans « Observations à décider ».
 */
export async function reviewAdminInformationAgentFact({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminInformationAgentReviewInput;
}): Promise<AdminInformationAgentReviewResult> {
  const auth = await assertAdminAuth(authToken);
  if (input.decision === "accepted") {
    const publication = await stageApprovedEvidencePublication(input.factId, {
      adminId: auth.userId,
      confirmed: input.redactionConfirmed === true,
      verifiedBy: input.redactionVerifiedBy ?? "",
    });
    if (publication) {
      try {
        const { data, error } = await callInformationAgentRpc(
          "review_information_agent_fact_candidate_with_path",
          {
            p_reviewer_id: auth.userId,
            p_fact_id: input.factId,
            p_decision: input.decision,
            p_notes: input.notes || null,
            p_expected_public_path: publication.publicPath,
          },
        );
        if (error) throw error;
        return { ok: true, result: data, registry: null };
      } catch (error) {
        await abortFailedEvidencePublication(publication.factId, publication.publicPath);
        throw error;
      }
    }
  }
  const registryAcceptance =
    input.decision === "accepted" ? await registryAcceptanceOf(input) : null;
  const { data, error } = await supabaseAdmin.rpc("review_information_agent_fact_candidate", {
    p_reviewer_id: auth.userId,
    p_fact_id: input.factId,
    p_decision: input.decision,
    p_notes: nullableRpcArg(input.notes || null),
  });
  if (error) throw error;
  const registry = registryAcceptance
    ? await recordRegistryAcceptance(auth, input.factId, registryAcceptance.lotAttachment)
    : null;
  return { ok: true, result: data, registry };
}

/**
 * Avant toute écriture : le fait deviendra-t-il une observation du registre ? Si oui, le rattachement au lot
 * est exigé, et une occupation que la fiche ne peut pas afficher est refusée (la base la refuse aussi).
 */
async function registryAcceptanceOf(
  input: AdminInformationAgentReviewInput,
): Promise<{ lotAttachment: FactClaimLotAttachment } | null> {
  const { data: fact, error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("fact_key,proposed_value")
    .eq("id", input.factId)
    .maybeSingle();
  if (error) throw error;
  if (!fact || !informationAgentFactRegistryField(fact.fact_key)) return null;
  if (informationAgentOccupancyRefused(fact.fact_key, recordOrEmpty(fact.proposed_value).value)) {
    throw new PublicApiError(INFORMATION_AGENT_OCCUPANCY_REFUSED_MESSAGE, 409);
  }
  if (!input.lotAttachment) {
    throw new PublicApiError(
      "Indiquez le rattachement au lot avant d’accepter : seule une vente à un seul lot ou un lot identifié affiche la valeur.",
      400,
    );
  }
  return { lotAttachment: input.lotAttachment };
}

/**
 * La décision d'acceptation au registre, écrite avec le client de la session (jeton de l'administrateur) :
 * la base lit l'auteur dans le jeton. L'observation est celle que le pont vient de créer pour ce fait.
 */
async function recordRegistryAcceptance(
  auth: SupabaseAuthContext,
  factId: string,
  lotAttachment: FactClaimLotAttachment,
): Promise<InformationAgentRegistryAcceptance> {
  const { data: claim, error } = await supabaseAdmin
    .from("auction_fact_claims")
    .select("id,auction_sale_id")
    .eq("evidence_locator->>information_agent_fact_id", factId)
    .maybeSingle();
  if (error) throw error;
  if (!claim) {
    return {
      claimId: null,
      saleId: null,
      state: null,
      error: "Aucune observation n’a été créée pour cette réponse.",
    };
  }
  try {
    const { result } = await decideAdminFactClaim({
      auth,
      input: { action: "accept", claimId: claim.id, lotAttachment },
    });
    return {
      claimId: claim.id,
      saleId: result.saleId ?? claim.auction_sale_id,
      state: result.state,
      error: null,
    };
  } catch (decisionError) {
    const translated = translateFactClaimDatabaseError(decisionError);
    console.warn(
      JSON.stringify({
        scope: "admin.information-agent.review",
        event: "registry_acceptance_failed",
        claim_id: claim.id,
        code:
          decisionError && typeof decisionError === "object" && "code" in decisionError
            ? String((decisionError as { code: unknown }).code)
            : null,
      }),
    );
    return {
      claimId: claim.id,
      saleId: claim.auction_sale_id,
      state: null,
      error:
        translated instanceof PublicApiError
          ? translated.message
          : "La décision n’a pas pu être enregistrée.",
    };
  }
}

type StagedEvidencePublication = {
  factId: string;
  publicPath: string;
};

type InformationAgentRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

const callInformationAgentRpc: InformationAgentRpc = (functionName, args) =>
  (supabaseAdmin.rpc as unknown as InformationAgentRpc).call(supabaseAdmin, functionName, args);

type RedactionCheck = { adminId: string; confirmed: boolean; verifiedBy: string };

const REDACTION_CHECK_REQUIRED_MESSAGE =
  "Caviardage vérifié : cochez la case et indiquez le nom de la personne qui a contrôlé la pièce avant de la publier.";

async function stageApprovedEvidencePublication(
  factId: string,
  redaction: RedactionCheck,
): Promise<StagedEvidencePublication | null> {
  const { data: fact, error: factError } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .select("id,fact_key,evidence_asset_id,sale_id,status,case_id")
    .eq("id", factId)
    .single();
  if (factError) throw factError;
  if (fact.fact_key !== "document" && fact.fact_key !== "photo") return null;
  if (!fact.evidence_asset_id || (fact.status !== "pending" && fact.status !== "conflict")) {
    throw new PublicApiError("Pièce jointe non publiable dans son état actuel.", 409);
  }
  const { data: informationCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("status")
    .eq("id", fact.case_id)
    .single();
  if (caseError) throw caseError;
  if (!reviewableCaseStatuses.has(informationCase.status)) {
    throw new PublicApiError("Le dossier n’est plus ouvert pour cette revue.", 409);
  }

  const { data: asset, error: assetError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .select("id,storage_bucket,storage_path,mime_type,rights_status,metadata")
    .eq("id", fact.evidence_asset_id)
    .single();
  if (assetError) throw assetError;
  if (asset.rights_status !== "authorized") {
    throw new PublicApiError(
      "Les droits de diffusion de cette pièce doivent d’abord être autorisés.",
      409,
    );
  }
  const { data: extraction, error: extractionError } = await supabaseAdmin
    .from("information_agent_evidence_extractions")
    .select("status")
    .eq("asset_id", asset.id)
    .single();
  if (extractionError || extraction?.status !== "completed") {
    throw new PublicApiError("L’analyse de la pièce doit être terminée avant sa publication.", 409);
  }

  // Mandatory human step: someone checked that personal data is redacted on the visible pages.
  if (!redaction.confirmed || redaction.verifiedBy.trim().length < 3) {
    throw new PublicApiError(REDACTION_CHECK_REQUIRED_MESSAGE, 400);
  }
  const publishable = publicRenditionKind(fact.fact_key, asset.mime_type);
  if (!publishable) {
    throw new PublicApiError(
      "Ce format de pièce ne peut pas être publié : seuls les PDF et les images le sont.",
      400,
    );
  }
  const { error: redactionError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .update({
      metadata: {
        ...recordOrEmpty(asset.metadata),
        redaction_verified_at: new Date().toISOString(),
        redaction_verified_by: redaction.verifiedBy.trim(),
        redaction_verified_by_admin_id: redaction.adminId,
      },
    })
    .eq("id", asset.id);
  if (redactionError) throw redactionError;

  const attemptId = randomUUID();
  const publicPath =
    publishable === "photo"
      ? `${fact.sale_id}/${asset.id}/photo-${attemptId}.webp`
      : publishable === "image"
        ? `${fact.sale_id}/${asset.id}/piece-jointe-${attemptId}.webp`
        : `${fact.sale_id}/${asset.id}/piece-jointe-${attemptId}.pdf`;
  // The bucket is private: this URL only identifies the object (older guards validate its shape).
  // Readers obtain a 10-minute signed URL from /api/information-agent/evidence.
  const publicUrl = supabaseAdmin.storage
    .from("information-agent-approved")
    .getPublicUrl(publicPath).data.publicUrl;

  const { error: stageError } = await supabaseAdmin.rpc(
    "stage_information_agent_evidence_publication",
    {
      p_fact_id: fact.id,
      p_public_path: publicPath,
      p_public_url: publicUrl,
    },
  );
  if (stageError) throw stageError;

  try {
    // Never copy the original: every published rendition is rebuilt (photo/image re-encoded without
    // metadata, PDF flattened to page images without author/XMP), so hidden content cannot leak.
    const { data: original, error: downloadError } = await supabaseAdmin.storage
      .from(asset.storage_bucket)
      .download(asset.storage_path);
    if (downloadError || !original)
      throw downloadError ?? new NotFoundError("Pièce source introuvable.");
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    const isPdf = publishable === "pdf";
    const rendition = isPdf
      ? await flattenPdfForPublication(originalBytes)
      : await optimizeInformationAgentPhoto(originalBytes);
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-approved")
      .upload(publicPath, rendition, {
        contentType: isPdf ? "application/pdf" : "image/webp",
        upsert: false,
      });
    if (uploadError) throw uploadError;
  } catch (error) {
    await abortFailedEvidencePublication(fact.id, publicPath);
    throw error;
  }

  return { factId: fact.id, publicPath };
}

async function abortFailedEvidencePublication(factId: string, publicPath: string): Promise<void> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await callInformationAgentRpc(
      "abort_information_agent_evidence_publication",
      { p_fact_id: factId, p_public_path: publicPath },
    ));
  } catch {
    return;
  }
  if (error || data !== true) return;

  try {
    await supabaseAdmin.storage.from("information-agent-approved").remove([publicPath]);
  } catch {
    // Keep the original publication error. A failed cleanup leaves the path for
    // the next operational cleanup pass rather than risking a broader delete.
  }
}

/** What can be published for an attachment: photos and images become WebP, PDFs are flattened. */
function publicRenditionKind(factKey: string, mimeType: string): "photo" | "image" | "pdf" | null {
  if (factKey === "photo") return mimeType.startsWith("image/") ? "photo" : null;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

const reviewableCaseStatuses = new Set(["sending", "sent", "replied", "review"]);

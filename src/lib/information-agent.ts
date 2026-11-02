import "server-only";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ADMIN_PAGE_SIZE, adminPageMeta } from "@/lib/admin-pagination";
import { recordManualMissionReply } from "@/lib/information-agent/manual-reply";
import {
  cancelMission,
  listFactsForCases,
  loadOwnedMission,
  missionFromRow,
  requireInformationAgentAdmin,
} from "@/lib/information-agent/mission-store";
import { approveAndSendMission } from "@/lib/information-agent/send";
import type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";

// Façade de l'agent d'information. La logique vit dans `information-agent/` :
//   schemas.ts (schémas et types), draft.ts (brouillon), preview.ts (aperçu), send.ts (envoi),
//   mission-store.ts (accès aux missions), config.ts (configuration d'envoi).
// Les ré-exports ci-dessous gardent les imports existants (routes, tests, panneaux) inchangés.

export {
  assertInformationAgentControllerIdentity,
  informationAgentPreviewFingerprint,
} from "@/lib/information-agent/message-guards";
// Ré-exports : ces fonctions vivaient dans ce module (et ses tests les importent d'ici).
export {
  INFORMATION_AGENT_ORIGIN_REQUIRED_MESSAGE,
  resolveInformationAgentAddressOrigin,
} from "@/lib/information-agent/address-origin";
export { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";
export {
  assertInformationAgentHasQuestion,
  assertInformationAgentSaleCurrent,
  INFORMATION_AGENT_NO_QUESTION_MESSAGE,
  withoutProfessionSuffix,
  withSignature,
} from "@/lib/information-agent/draft-checks";

export {
  discoverInformationAgentContacts,
  selectInformationAgentContact,
  isInformationAgentContactBlocked,
  loadInformationAgentContactRegistry,
  persistInformationAgentContactObservations,
  assertInformationAgentContactAllowed,
  assertInformationAgentIdentityAllowed,
  loadOpposedInformationAgentIdentityKeys,
  recordInformationAgentAdminAddressEntry,
  isCourtRegistryEmail,
  isInformationAgentExcludedAddress,
  informationAgentExcludedAddressReason,
} from "@/lib/information-agent/contacts";
export type {
  InformationAgentRecipientKind,
  InformationAgentContactRole,
  InformationAgentContactProvenance,
  InformationAgentContactCandidate,
  InformationAgentContactRegistryBlock,
} from "@/lib/information-agent/contacts";

// Ré-exports : ces éléments vivaient dans ce module (et ses tests les importent d'ici).
export {
  detectInformationGaps,
  INFORMATION_AGENT_QUESTIONS,
  informationAgentQuestionContext,
  informationAgentQuestionText,
  selectDefaultInformationAgentQuestionKeys,
} from "@/lib/information-agent-questions";
export type {
  InformationAgentGap,
  InformationAgentQuestionContext,
  InformationAgentQuestionKey,
} from "@/lib/information-agent-questions";

export {
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  informationAgentListQuerySchema,
  informationAgentPreviewSchema,
  UNVERIFIED_SEND_OUTCOME,
} from "@/lib/information-agent/schemas";
export type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentAdminResponse,
  InformationAgentCreateInput,
  InformationAgentFact,
  InformationAgentMission,
  InformationAgentPreviewInput,
  InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";
export {
  assertInformationAgentCanaryRecipient,
  assertInformationAgentOutboundEnabled,
  informationAgentAppOrigin,
  informationAgentCaseReference,
  resolveInformationAgentEmailConfig,
} from "@/lib/information-agent/config";
export {
  buildInformationRequestDraft,
  createAdminInformationAgentDraft,
} from "@/lib/information-agent/draft";
export {
  prepareAdminInformationAgentDraft,
  type InformationAgentPrepareResponse,
} from "@/lib/information-agent/prepare";
export {
  previewAdminInformationAgentMission,
  type InformationAgentPreviewResponse,
} from "@/lib/information-agent/preview";
export {
  assertUnverifiedSendWithinIdempotencyWindow,
  omitUnverifiedSendOutcome,
} from "@/lib/information-agent/send";

export async function listAdminInformationAgentMissions({
  auth,
  saleId,
  offset = 0,
  limit = ADMIN_PAGE_SIZE,
}: {
  auth: SupabaseAuthContext;
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  requireInformationAgentAdmin(auth);
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("*", { count: "exact" })
    .eq("user_id", auth.userId)
    // L'id départage les missions créées dans la même milliseconde : pages stables.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const saleTitles = await loadSaleTitles(
    rows.flatMap((mission) => (mission.sale_id ? [mission.sale_id] : [])),
  );
  return {
    ok: true,
    missions: rows.map((row) => ({
      ...missionFromRow(row),
      saleTitle: row.sale_id ? (saleTitles.get(row.sale_id) ?? null) : null,
    })),
    facts: await listFactsForCases(
      rows.flatMap((mission) => (mission.case_id ? [mission.case_id] : [])),
    ),
    ...adminPageMeta({ offset, limit, total: count ?? offset + rows.length }),
  };
}

/**
 * Titres des ventes de la page de missions, pour que l'administrateur reconnaisse la vente sans
 * ouvrir chaque ligne. Réservé à la liste admin ; une lecture en échec laisse simplement les lignes
 * sans titre (jamais un échec de la liste).
 */
async function loadSaleTitles(saleIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const uniqueIds = [...new Set(saleIds)];
  if (!uniqueIds.length) return titles;
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title")
    .in("id", uniqueIds);
  if (error) {
    console.warn("Titres des ventes de l'agent illisibles", { code: error.code ?? null });
    return titles;
  }
  for (const row of data ?? []) {
    if (typeof row.title === "string" && row.title.trim()) titles.set(row.id, row.title.trim());
  }
  return titles;
}

export async function runAdminInformationAgentAction({
  auth,
  input,
  fetchImpl = fetch,
  trigger,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentAdminActionPayload;
  fetchImpl?: typeof fetch;
  /** Interne : le pilote automatique (`information-agent-autopilot.ts`) ; absent pour un administrateur. */
  trigger?: InformationAgentSendTrigger;
}): Promise<InformationAgentAdminListResponse> {
  requireInformationAgentAdmin(auth);

  if (input.action === "approve_and_send") {
    await approveAndSendMission({ adminId: auth.userId, input, fetchImpl, trigger });
  } else if (input.action === "record_reply") {
    const replyMission = await loadOwnedMission(auth.userId, input.missionId);
    await recordManualMissionReply({ mission: replyMission, input });
  } else {
    await cancelMission({ adminId: auth.userId, missionId: input.missionId });
  }

  const mission = await loadOwnedMission(auth.userId, input.missionId);
  return {
    ok: true,
    missions: [missionFromRow(mission)],
    facts: await listFactsForCases(mission.case_id ? [mission.case_id] : []),
  };
}
